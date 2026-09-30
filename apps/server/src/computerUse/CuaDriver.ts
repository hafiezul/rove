import {
  ComputerUseControlError,
  type ComputerUseControlInput,
  type ComputerUseStatus,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { McpSchema } from "effect/unstable/ai";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

/** Cua's canonical installer places the app here; its MCP proxy launches the daemon from it. */
export const CUA_DRIVER_APP = "/Applications/CuaDriver.app";
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

export interface CuaTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly readOnly: boolean;
}

export interface CuaCatalog {
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
}

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
      args: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<McpSchema.CallToolResult, CuaDriverUnavailableError>;
  }
>()("t3/computerUse/CuaDriver") {}

export const make = Effect.fn("CuaDriver.make")(function* (options?: {
  readonly appPath?: string;
}) {
  const appPath = options?.appPath ?? CUA_DRIVER_APP;
  const executablePath = `${appPath}/Contents/MacOS/cua-driver`;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const settings = yield* ServerSettings.ServerSettingsService;
  const scope = yield* Effect.scope;
  // Serializes connecting, releasing, and reading the daemon so an idle release never
  // races a status read or a new connection.
  const lock = yield* Semaphore.make(1);
  let connection: Connection | undefined;
  /** True only when Rove launched the running daemon; Rove never quits one it did not start. */
  let ownsDaemon = false;
  let signatureVerified = false;
  let idleTimer: Fiber.Fiber<void> | undefined;

  const run = (args: ReadonlyArray<string>, timeout: Duration.Input = Duration.seconds(10)) =>
    runner.run({ command: executablePath, args, timeout });

  const daemonRunning = run(["status"]).pipe(
    Effect.map((output) => output.code === 0),
    Effect.orElseSucceed(() => false),
  );

  const presence: Effect.Effect<"missing" | "untrusted" | "trusted"> = Effect.gen(function* () {
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

  const releaseUnlocked = Effect.gen(function* () {
    const current = connection;
    connection = undefined;
    if (current) yield* Effect.promise(() => current.client.close().catch(() => undefined));
    if (ownsDaemon) {
      ownsDaemon = false;
      yield* run(["stop"]).pipe(Effect.ignore);
    }
  });

  /** Ends Rove's Cua sessions, which removes their cursors, and quits a daemon Rove started. */
  const release = lock.withPermit(releaseUnlocked).pipe(Effect.uninterruptible);

  const touch = Effect.gen(function* () {
    if (idleTimer) yield* Fiber.interrupt(idleTimer);
    idleTimer = yield* Effect.sleep(IDLE_TIMEOUT).pipe(
      Effect.andThen(release),
      Effect.forkIn(scope),
    );
  });

  const connect = Effect.tryPromise({
    try: async (signal) => {
      const client = new Client({ name: "rove-code", version: "1.0.0" });
      signal.addEventListener("abort", () => void client.close(), { once: true });
      await client.connect(
        new StdioClientTransport({ command: executablePath, args: ["mcp"], stderr: "ignore" }),
      );
      const tools: Array<CuaTool> = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        for (const tool of page.tools) {
          tools.push({
            name: tool.name,
            description: tool.description ?? tool.name,
            inputSchema: tool.inputSchema,
            readOnly: tool.annotations?.readOnlyHint === true,
          });
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      const next: Connection = {
        client,
        catalog: { instructions: client.getInstructions(), tools },
      };
      // A daemon quit from outside Rove closes the transport; reconnect on the next call.
      client.onclose = () => {
        if (connection === next) connection = undefined;
      };
      return next;
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
          new CuaDriverUnavailableError({ detail: "Cua Driver did not start within 30 seconds." }),
        ),
    }),
  );

  const connectUnlocked = Effect.gen(function* () {
    if (connection) return connection;
    if (platform !== "darwin") {
      return yield* new CuaDriverUnavailableError({
        detail: `Computer use is only available on macOS, not ${platform}.`,
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
    const wasRunning = yield* daemonRunning;
    connection = yield* connect;
    if (!wasRunning) ownsDaemon = true;
    return connection;
  });

  const connected = lock.withPermit(connectUnlocked).pipe(Effect.tap(() => touch));

  const permissionsUnlocked = connectUnlocked.pipe(
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

  const statusUnlocked: Effect.Effect<ComputerUseStatus> = Effect.gen(function* () {
    if (platform !== "darwin") return { status: "unsupported", platform } as const;
    const found = yield* presence;
    if (found === "missing") return { status: "not-installed" } as const;
    if (found === "untrusted") return { status: "untrusted" } as const;
    const [versionOutput, telemetryOutput, running] = yield* Effect.all(
      [
        run(["--version"]).pipe(Effect.option),
        run(["telemetry", "status", "--json"]).pipe(Effect.option),
        daemonRunning,
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
    if (!running) return { status: "stopped", version, telemetry } as const;
    return {
      status: "running",
      version,
      telemetry,
      permissions: yield* permissionsUnlocked,
    } as const;
  });

  const status = lock.withPermit(statusUnlocked).pipe(
    Effect.tap(() => (connection ? touch : Effect.void)),
    Effect.withSpan("CuaDriver.status"),
  );

  const failWith =
    (action: ComputerUseControlInput["action"]) =>
    (detail: string): ComputerUseControlError =>
      new ComputerUseControlError({ action, detail });

  const install = Effect.gen(function* () {
    const fail = failWith("install");
    // Execute only a fully downloaded script, never a partial pipe.
    const output = yield* runner
      .run({
        command: "/bin/bash",
        args: ["-c", `script="$(curl -fsSL ${INSTALL_SCRIPT_URL})" && /bin/bash -c "$script"`],
        env: { CUA_DRIVER_RS_NO_MODIFY_PATH: "1", CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" },
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
          ? "The Cua installer finished without installing the app."
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
      yield* touch;
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
    if (platform !== "darwin") {
      return yield* fail(`Computer use is only available on macOS, not ${platform}.`);
    }
    const found = yield* lock.withPermit(presence);
    if (input.action === "install") {
      if (found === "trusted") return yield* status;
      yield* install;
      return yield* status;
    }
    if (found !== "trusted") {
      return yield* fail(
        found === "missing" ? "Cua Driver is not installed." : untrustedDetail(appPath),
      );
    }
    if (input.action === "start") {
      yield* connected.pipe(Effect.mapError((error) => fail(error.detail)));
    } else if (input.action === "grant-permissions") {
      yield* grantPermissions;
    } else {
      yield* setTelemetry(input.enabled);
    }
    return yield* status;
  });

  const call = (name: string, args: Readonly<Record<string, unknown>>) =>
    connected.pipe(
      Effect.flatMap(({ client }) =>
        Effect.tryPromise({
          try: (signal) =>
            client.callTool({ name, arguments: { ...args } }, undefined, {
              signal,
              timeout: CALL_TIMEOUT_MS,
            }),
          catch: (cause) =>
            new CuaDriverUnavailableError({
              detail: `Cua Driver call failed: ${describeCause(cause)}`,
            }),
        }),
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
      Effect.ensuring(touch),
      Effect.withSpan("CuaDriver.call", { attributes: { tool: name } }),
    );

  // Turning agent computer use off quits the daemon at once rather than after the idle timeout.
  yield* settings.streamChanges.pipe(
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
    catalog: Effect.map(connected, ({ catalog }) => catalog),
    call,
  });
});

export const layer = Layer.effect(CuaDriver, make()).pipe(Layer.provide(ProcessRunner.layer));
