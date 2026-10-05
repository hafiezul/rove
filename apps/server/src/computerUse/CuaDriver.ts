import * as NodeOS from "node:os";

import {
  ComputerUseControlError,
  type ComputerUseDiagnostic,
  type ComputerUseReadiness,
  type ComputerUseControlInput,
  type ComputerUseStatus,
  type ThreadId,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool as CuaMcpTool } from "@modelcontextprotocol/sdk/types.js";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { McpSchema } from "effect/unstable/ai";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LinuxDesktop from "./LinuxDesktop.ts";

/** Cua's canonical installer places the app here; its MCP proxy launches the daemon from it. */
const CUA_DRIVER_APP = "/Applications/CuaDriver.app";
/** Cua's official installer. It downloads from Cua's GitHub Releases and verifies the app signature. */
const INSTALL_SCRIPT_URL = "https://cua.ai/driver/install.sh";
/** Cua AI, Inc.'s Developer ID team. Rove runs no binary at the Cua path without it. */
const CUA_SIGNING_REQUIREMENT =
  'anchor apple generic and identifier "com.trycua.driver" and certificate leaf[subject.OU] = "YCK386LBJ7"';
/** An idle Cua daemon costs ~57 MB and ~2% CPU; one Rove started quits after this long unused. */
export const IDLE_TIMEOUT = Duration.minutes(5);
const CONNECT_TIMEOUT = Duration.seconds(30);
const CALL_TIMEOUT_MS = 120_000;
const WAIT_FOR_USER_TIMEOUT = Duration.minutes(10);

export type CuaArguments = NonNullable<Parameters<Client["callTool"]>[0]["arguments"]>;

export interface CuaTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: CuaMcpTool["inputSchema"];
  readonly readOnly: boolean;
}

export interface CuaCatalog {
  readonly policy: "background-only" | "isolated-desktop";
  readonly instructions: string | undefined;
  readonly tools: ReadonlyArray<CuaTool>;
}

export class CuaDriverUnavailableError extends Schema.TaggedError<CuaDriverUnavailableError>()(
  "CuaDriverUnavailableError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

interface Connection {
  readonly client: Client;
  readonly catalog: CuaCatalog;
  idleTimer: Fiber.Fiber<void> | undefined;
}

const CONTROL_CONNECTION = "control";

const CheckPermissionsResult = Schema.Struct({
  structuredContent: Schema.Struct({
    accessibility: Schema.Boolean,
    screen_recording: Schema.Boolean,
  }),
});
const decodePermissions = Schema.decodeUnknownOption(CheckPermissionsResult);
const decodeTelemetry = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ enabled: Schema.Boolean })),
);
const decodeHealth = Schema.decodeUnknownOption(
  Schema.Struct({
    checks: Schema.NonEmptyArray(
      Schema.Struct({
        name: Schema.String,
        status: Schema.Literals(["pass", "warn", "fail", "skip"]),
        message: Schema.String,
      }),
    ),
  }),
);
const decodeCallToolResult = Schema.decodeUnknownEffect(McpSchema.CallToolResult);

const describeCause = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const lastLines = (output: ProcessRunner.ProcessRunOutput) =>
  `${output.stdout}\n${output.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-3)
    .join(" ");

const untrustedDetail = (appPath: string) =>
  `The app at ${appPath} is not signed by Cua AI, Inc., so Rove will not run it. Reinstall Cua Driver from Settings → Integrations.`;

export class CuaDriver extends Context.Service<
  CuaDriver,
  {
    readonly status: Effect.Effect<ComputerUseStatus>;
    readonly control: (
      input: ComputerUseControlInput,
    ) => Effect.Effect<ComputerUseStatus, ComputerUseControlError>;
    /** Connects on first use, which launches the Cua daemon when it is not running. */
    readonly catalog: Effect.Effect<CuaCatalog, CuaDriverUnavailableError>;
    readonly call: (
      name: string,
      args: CuaArguments,
      threadId: ThreadId,
    ) => Effect.Effect<McpSchema.CallToolResult, CuaDriverUnavailableError>;
  }
>()("t3/computerUse/CuaDriver") {}

export const make = Effect.fn("CuaDriver.make")(function* (options?: {
  readonly appPath?: string;
  readonly executablePath?: string;
}) {
  const appPath = options?.appPath ?? CUA_DRIVER_APP;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const linuxInstallDir =
    environment.CUA_DRIVER_RS_INSTALL_DIR ??
    environment.CUA_DRIVER_BIN_DIR ??
    path.join(environment.HOME ?? NodeOS.homedir(), ".local", "bin");
  const linuxExecutable = options?.executablePath ?? path.join(linuxInstallDir, "cua-driver");
  const linuxCandidates = options?.executablePath
    ? [options.executablePath]
    : [
        linuxExecutable,
        ...(environment.PATH ?? "")
          .split(":")
          .filter(Boolean)
          .map((directory) => path.join(directory, "cua-driver")),
      ];
  let executablePath =
    platform === "linux" ? linuxExecutable : `${appPath}/Contents/MacOS/cua-driver`;
  const desktops = platform === "linux" ? yield* LinuxDesktop.make() : undefined;
  const settings = yield* ServerSettings.ServerSettingsService;
  const settingsChanges = yield* settings.subscribeChanges;
  const scope = yield* Effect.scope;
  // Serializes connecting, releasing, and reading the daemon so an idle release never
  // races a status read or a new connection.
  const lock = yield* Semaphore.make(1);
  // Cua's parser has no session argument, so capture ownership must be transport-local.
  const connections = new Map<string, Connection>();
  /** True only when Rove launched the running daemon; Rove never quits one it did not start. */
  let ownsDaemon = false;
  let signatureVerified = false;

  const run = (args: ReadonlyArray<string>, timeout: Duration.Input = Duration.seconds(10)) =>
    Effect.suspend(() => runner.run({ command: executablePath, args, timeout, env: environment }));

  const daemonRunning = run(["status"]).pipe(
    Effect.map((output) => output.code === 0),
    Effect.orElseSucceed(() => false),
  );

  const presence: Effect.Effect<"missing" | "untrusted" | "trusted"> = Effect.gen(function* () {
    if (platform === "linux") {
      for (const candidate of linuxCandidates) {
        if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
          executablePath = candidate;
          return "trusted";
        }
      }
      return "missing";
    }
    if (!(yield* fileSystem.exists(executablePath).pipe(Effect.orElseSucceed(() => false)))) {
      return "missing";
    }
    if (signatureVerified) return "trusted";
    const check = yield* runner
      .run({
        command: "/usr/bin/codesign",
        args: ["--verify", "--deep", "--strict", `-R=${CUA_SIGNING_REQUIREMENT}`, appPath],
        timeout: Duration.seconds(30),
      })
      .pipe(Effect.option);
    signatureVerified = Option.isSome(check) && check.value.code === 0;
    return signatureVerified ? "trusted" : "untrusted";
  });

  const stopOwnedDaemon = Effect.gen(function* () {
    if (ownsDaemon && connections.size === 0) {
      ownsDaemon = false;
      yield* run(["stop"]).pipe(Effect.ignore);
    }
  });

  const closeConnection = Effect.fn("CuaDriver.closeConnection")(function* (
    key: string,
    current: Connection,
  ) {
    if (connections.get(key) !== current) return yield* stopOwnedDaemon;
    connections.delete(key);
    if (current.idleTimer) yield* Fiber.interrupt(current.idleTimer);
    yield* Effect.promise(() => current.client.close().catch(() => undefined));
    if (desktops && key === CONTROL_CONNECTION) {
      yield* desktops.close(key).pipe(Effect.catch((cause) => Effect.logWarning(cause.detail)));
    }
    yield* stopOwnedDaemon;
  });

  /** Ends Rove's connections and quits only a daemon Rove started. */
  const release = lock
    .withPermit(
      Effect.gen(function* () {
        for (const [key, current] of connections) yield* closeConnection(key, current);
        yield* stopOwnedDaemon;
        if (desktops)
          yield* desktops.release.pipe(Effect.catch((cause) => Effect.logWarning(cause.detail)));
      }),
    )
    .pipe(Effect.uninterruptible);

  const touch = (key: string, current: Connection) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (connections.get(key) !== current) return;
        if (current.idleTimer) yield* Fiber.interrupt(current.idleTimer);
        current.idleTimer = yield* Effect.sleep(IDLE_TIMEOUT).pipe(
          Effect.andThen(
            lock.withPermit(
              Effect.gen(function* () {
                current.idleTimer = undefined;
                yield* closeConnection(key, current);
              }),
            ),
          ),
          Effect.forkIn(scope),
        );
      }),
    );

  const connect = (
    key: string,
    transport: LinuxDesktop.Transport = { command: executablePath, args: ["mcp"] },
  ) =>
    Effect.tryPromise({
      try: async (signal) => {
        const client = new Client({ name: "rove-code", version: "1.0.0" });
        signal.addEventListener("abort", () => void client.close(), { once: true });
        try {
          await client.connect(
            new StdioClientTransport({
              command: transport.command,
              args: [...transport.args],
              env: Object.fromEntries(
                Object.entries(environment).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
              stderr: "ignore",
            }),
          );
          const sharedCatalog = connections.get(CONTROL_CONNECTION)?.catalog;
          const tools: Array<CuaTool> = [];
          if (!sharedCatalog) {
            let cursor: string | undefined;
            do {
              const page = await client.listTools(cursor ? { cursor } : {});
              for (const tool of page.tools) {
                if (platform === "linux" && tool.name === "check_permissions") continue;
                tools.push({
                  name: tool.name,
                  description: tool.description ?? tool.name,
                  inputSchema: tool.inputSchema,
                  readOnly: tool.annotations?.readOnlyHint === true,
                });
              }
              cursor = page.nextCursor;
            } while (cursor !== undefined);
          }
          const next: Connection = {
            client,
            catalog: sharedCatalog ?? {
              policy: desktops ? "isolated-desktop" : "background-only",
              instructions: client.getInstructions(),
              tools: desktops
                ? [
                    ...tools,
                    {
                      name: "close_desktop",
                      description:
                        "Discard this thread's temporary desktop, including unsaved documents and guest files. The next call creates a new empty desktop.",
                      inputSchema: { type: "object", properties: {}, additionalProperties: false },
                      readOnly: false,
                    },
                  ]
                : tools,
            },
            idleTimer: undefined,
          };
          // A daemon quit from outside Rove closes the transport; reconnect on the next call.
          client.onclose = () => {
            if (connections.get(key) === next) connections.delete(key);
          };
          return next;
        } catch (cause) {
          await client.close().catch(() => undefined);
          throw cause;
        }
      },
      catch: (cause) =>
        new CuaDriverUnavailableError({
          detail: `Could not connect to Cua Driver: ${describeCause(cause)}`,
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: CONNECT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new CuaDriverUnavailableError({
              detail: "Cua Driver did not start within 30 seconds.",
            }),
          ),
      }),
    );

  const connectUnlocked = Effect.fn("CuaDriver.connectUnlocked")(function* (key: string) {
    if (
      key.startsWith("thread:") &&
      !(yield* settings.getSettings.pipe(
        Effect.map((value) => value.enableAgentComputerUse),
        Effect.orElseSucceed(() => false),
      ))
    ) {
      return yield* new CuaDriverUnavailableError({
        detail: "Computer use is off for this environment.",
      });
    }
    const current = connections.get(key);
    if (current) return current;
    if (platform !== "darwin" && platform !== "linux") {
      return yield* new CuaDriverUnavailableError({
        detail: `Computer use needs a macOS or Linux host, not ${platform}.`,
      });
    }
    const found = yield* presence;
    if (found !== "trusted") {
      return yield* new CuaDriverUnavailableError({
        detail:
          found === "missing"
            ? "Cua Driver is not installed. The user can install it from Settings → Integrations."
            : untrustedDetail(appPath),
      });
    }
    const wasRunning = platform === "darwin" ? yield* daemonRunning : false;
    const next = desktops
      ? yield* desktops
          .connect(key, executablePath, (transport) => connect(key, transport))
          .pipe(
            Effect.mapError((cause) => new CuaDriverUnavailableError({ detail: cause.message })),
          )
      : yield* connect(key);
    connections.set(key, next);
    if (platform === "darwin" && !wasRunning) ownsDaemon = true;
    return next;
  });

  const connected = (key: string) =>
    lock.withPermit(connectUnlocked(key)).pipe(Effect.tap((current) => touch(key, current)));

  const permissionsUnlocked = connectUnlocked(CONTROL_CONNECTION).pipe(
    Effect.flatMap(({ client }) =>
      Effect.tryPromise(() => client.callTool({ name: "check_permissions", arguments: {} })),
    ),
    Effect.map((result) =>
      Option.match(decodePermissions(result), {
        onNone: () => null,
        onSome: ({ structuredContent }) => ({
          accessibility: structuredContent.accessibility,
          screenRecording: structuredContent.screen_recording,
        }),
      }),
    ),
    Effect.orElseSucceed(() => null),
  );

  const linuxDiagnostics = Effect.suspend(() => {
    const current = connections.values().next().value;
    if (!current) return Effect.succeed(null);
    return Effect.tryPromise({
      try: (signal) =>
        current.client.callTool({ name: "health_report", arguments: {} }, undefined, {
          signal,
          timeout: 10_000,
        }),
      catch: describeCause,
    }).pipe(
      Effect.map((result) => {
        const report = Option.getOrNull(decodeHealth(result.structuredContent));
        const [first, ...rest] =
          report?.checks
            .filter((check) => check.status !== "skip")
            .map((check): ComputerUseDiagnostic => ({
              label: check.name,
              status: check.status === "pass" ? "ok" : check.status === "warn" ? "warn" : "err",
              message: check.message,
            })) ?? [];
        return first ? ([first, ...rest] as const) : null;
      }),
      Effect.orElseSucceed(() => null),
    );
  });

  const statusUnlocked: Effect.Effect<ComputerUseStatus> = Effect.gen(function* () {
    if (platform !== "darwin" && platform !== "linux")
      return { status: "unsupported", platform } as const;
    const found = yield* presence;
    if (found === "missing") return { status: "not-installed", platform } as const;
    if (found === "untrusted") return { status: "untrusted" } as const;
    if (desktops) {
      const readiness = yield* desktops.check(executablePath);
      if (readiness.kind === "unavailable")
        return { status: "runtime-unavailable", detail: readiness.detail } as const;
      if (readiness.kind === "missing") return { status: "needs-desktop-image" } as const;
    }
    const [versionOutput, telemetryOutput, running] = yield* Effect.all(
      [
        run(["--version"]).pipe(Effect.option),
        desktops ? Effect.succeedNone : run(["telemetry", "status", "--json"]).pipe(Effect.option),
        platform === "darwin" ? daemonRunning : Effect.succeed(connections.size > 0),
      ],
      { concurrency: "unbounded" },
    );
    const version = Option.match(versionOutput, {
      onNone: () => "unknown",
      onSome: ({ stdout }) => /\d+\.\d+\.\d+\S*/.exec(stdout)?.[0] ?? "unknown",
    });
    const telemetry = Option.match(
      Option.flatMap(telemetryOutput, ({ stdout }) => decodeTelemetry(stdout)),
      {
        onNone: () => null,
        onSome: ({ enabled }) => enabled,
      },
    );
    const readiness: ComputerUseReadiness =
      platform === "linux"
        ? {
            platform,
            diagnostics: yield* linuxDiagnostics,
            desktops: desktops?.count() ?? 0,
            capacity: LinuxDesktop.CAPACITY,
          }
        : { platform, permissions: running ? yield* permissionsUnlocked : null };
    return running
      ? ({ status: "running", version, telemetry, readiness } as const)
      : ({ status: "stopped", version, telemetry, readiness } as const);
  });

  const status = lock.withPermit(statusUnlocked).pipe(
    Effect.tap(() => {
      const current = connections.get(CONTROL_CONNECTION);
      return current ? touch(CONTROL_CONNECTION, current) : Effect.void;
    }),
    Effect.withSpan("CuaDriver.status"),
  );

  const failWith =
    (action: ComputerUseControlInput["action"]) =>
    (detail: string): ComputerUseControlError =>
      new ComputerUseControlError({ action, detail });

  const install = Effect.gen(function* () {
    const fail = failWith("install");
    const installerEnvironment: NodeJS.ProcessEnv = {
      CUA_DRIVER_RS_NO_MODIFY_PATH: "1",
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    };
    if (platform === "linux") {
      installerEnvironment.CUA_DRIVER_RS_INSTALL_DIR = path.dirname(linuxExecutable);
    }
    // Execute only a fully downloaded script, never a partial pipe.
    const output = yield* runner
      .run({
        command: "/bin/bash",
        args: ["-c", `script="$(curl -fsSL ${INSTALL_SCRIPT_URL})" && /bin/bash -c "$script"`],
        env: installerEnvironment,
        timeout: WAIT_FOR_USER_TIMEOUT,
      })
      .pipe(Effect.mapError((cause) => fail(describeCause(cause))));
    if (output.code !== 0) {
      return yield* fail(lastLines(output) || `The Cua installer exited with ${output.code}.`);
    }
    signatureVerified = false;
    const found = yield* presence;
    if (found !== "trusted") {
      return yield* fail(
        found === "missing"
          ? "The Cua installer finished without installing Cua Driver."
          : untrustedDetail(appPath),
      );
    }
    // Clicking Install is not consent to Cua's own usage data; the user can turn it on in Settings.
    yield* run(["telemetry", "disable"]).pipe(Effect.ignore);
  });

  const grantPermissions = Effect.gen(function* () {
    const wasRunning = yield* daemonRunning;
    // Cua launches its own app so macOS attributes the prompts to Cua Driver, then waits
    // for the user; the status read afterwards reports what they allowed.
    yield* run(["permissions", "grant"], WAIT_FOR_USER_TIMEOUT).pipe(
      Effect.mapError((cause) => failWith("grant-permissions")(describeCause(cause))),
    );
    if (!wasRunning && (yield* daemonRunning)) {
      yield* lock.withPermit(Effect.sync(() => (ownsDaemon = true)));
      yield* connected(CONTROL_CONNECTION).pipe(
        Effect.mapError((error) => failWith("grant-permissions")(error.detail)),
      );
    }
  });

  const setTelemetry = (enabled: boolean) =>
    run(["telemetry", enabled ? "enable" : "disable"]).pipe(
      Effect.mapError((cause) => failWith("set-telemetry")(describeCause(cause))),
      Effect.flatMap((output) =>
        output.code === 0
          ? Effect.void
          : Effect.fail(
              failWith("set-telemetry")(lastLines(output) || "Cua Driver refused the change."),
            ),
      ),
    );

  const control = Effect.fn("CuaDriver.control")(function* (input: ComputerUseControlInput) {
    const fail = failWith(input.action);
    if (platform !== "darwin" && platform !== "linux") {
      return yield* fail(`Computer use needs a macOS or Linux host, not ${platform}.`);
    }
    const found = yield* lock.withPermit(presence);
    if (input.action === "install") {
      if (desktops) {
        const readiness = found === "trusted" ? yield* desktops.check(executablePath) : undefined;
        if (readiness?.kind === "ready") return yield* status;
        yield* desktops.preflight.pipe(Effect.mapError((cause) => fail(cause.detail)));
        if (found !== "trusted") yield* install;
        yield* desktops
          .install(executablePath)
          .pipe(Effect.mapError((cause) => fail(cause.detail)));
      } else if (found !== "trusted") yield* install;
      return yield* status;
    }
    if (found !== "trusted") {
      return yield* fail(
        found === "missing" ? "Cua Driver is not installed." : untrustedDetail(appPath),
      );
    }
    if (input.action === "start") {
      yield* connected(CONTROL_CONNECTION).pipe(Effect.mapError((error) => fail(error.detail)));
    } else if (input.action === "grant-permissions") {
      if (platform === "linux") {
        return yield* fail(
          "Linux agent desktops have no macOS permission grants. Use Check desktop to test the private session.",
        );
      }
      yield* grantPermissions;
    } else {
      if (desktops) return yield* fail("Usage collection is disabled in Linux agent desktops.");
      yield* setTelemetry(input.enabled);
    }
    return yield* status;
  });

  const call = (name: string, args: CuaArguments, threadId: ThreadId) => {
    const key = `thread:${threadId}`;
    if (name === "close_desktop" && desktops) {
      return lock.withPermit(
        Effect.gen(function* () {
          if (Object.keys(args).length > 0)
            return yield* new CuaDriverUnavailableError({
              detail: "close_desktop accepts no arguments.",
            });
          const current = connections.get(key);
          if (current) yield* closeConnection(key, current);
          yield* desktops
            .close(key)
            .pipe(
              Effect.mapError((cause) => new CuaDriverUnavailableError({ detail: cause.detail })),
            );
          return new McpSchema.CallToolResult({
            content: [
              { type: "text", text: "This thread's temporary desktop has been discarded." },
            ],
          });
        }),
      );
    }
    return connected(key).pipe(
      Effect.flatMap((current) =>
        Effect.tryPromise({
          try: (signal) =>
            current.client.callTool({ name, arguments: { ...args } }, undefined, {
              signal,
              timeout: CALL_TIMEOUT_MS,
            }),
          catch: (cause) =>
            new CuaDriverUnavailableError({
              detail: `Cua Driver call failed: ${describeCause(cause)}`,
            }),
        }).pipe(Effect.ensuring(touch(key, current))),
      ),
      Effect.flatMap((result) =>
        decodeCallToolResult(result).pipe(
          Effect.mapError(
            () =>
              new CuaDriverUnavailableError({
                detail: `Cua Driver returned an unreadable result for ${name}.`,
              }),
          ),
        ),
      ),
      Effect.withSpan("CuaDriver.call", { attributes: { tool: name } }),
    );
  };

  // Turning agent computer use off quits the daemon at once rather than after the idle timeout.
  yield* settingsChanges.pipe(
    Stream.map((current) => current.enableAgentComputerUse),
    Stream.changes,
    Stream.filter((enabled) => !enabled),
    Stream.runForEach(() => release),
    Effect.forkIn(scope),
  );
  yield* Effect.addFinalizer(() => release);

  return CuaDriver.of({
    status,
    control,
    catalog: Effect.map(connected(CONTROL_CONNECTION), ({ catalog }) => catalog),
    call,
  });
});

export const layer = Layer.effect(CuaDriver, make()).pipe(Layer.provide(ProcessRunner.layer));
