import {
  type ComputerUseAction,
  ComputerUseControlError,
  type ComputerUseStatus,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { McpSchema } from "effect/unstable/ai";

import * as ProcessRunner from "../processRunner.ts";

/** Where Cua's canonical installer puts the app; its MCP proxy launches the daemon from here. */
export const CUA_DRIVER_EXECUTABLE = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const INSTALL_COMMAND = '/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"';
const DOCS_URL = "https://cua.ai/docs/cua-driver";
const CONNECT_TIMEOUT = Duration.seconds(30);
const CALL_TIMEOUT_MS = 120_000;
const GRANT_TIMEOUT = Duration.minutes(10);

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
const decodeCallToolResult = Schema.decodeUnknownEffect(McpSchema.CallToolResult);

const describeCause = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export class CuaDriver extends Context.Service<
  CuaDriver,
  {
    readonly status: Effect.Effect<ComputerUseStatus>;
    readonly control: (
      action: ComputerUseAction,
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
  readonly executablePath?: string;
}) {
  const executablePath = options?.executablePath ?? CUA_DRIVER_EXECUTABLE;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const connectLock = yield* Semaphore.make(1);
  let connection: Connection | undefined;

  const run = (args: ReadonlyArray<string>, timeout: Duration.Input = Duration.seconds(10)) =>
    runner.run({ command: executablePath, args, timeout });

  const disconnect = Effect.promise(async () => {
    const current = connection;
    connection = undefined;
    await current?.client.close().catch(() => undefined);
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
      // A stopped daemon or crashed proxy closes the transport; reconnect on the next call.
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

  const installed =
    platform === "darwin" ? fileSystem.exists(executablePath) : Effect.succeed(false);

  const connected = connectLock.withPermit(
    Effect.gen(function* () {
      if (connection) return connection;
      if (!(yield* installed.pipe(Effect.orElseSucceed(() => false)))) {
        return yield* new CuaDriverUnavailableError({
          detail:
            platform === "darwin"
              ? "Cua Driver is not installed. The user can install it from Settings → Integrations."
              : `Computer use is only available on macOS, not ${platform}.`,
        });
      }
      connection = yield* connect;
      return connection;
    }),
  );

  const readPermissions = connected.pipe(
    Effect.flatMap(({ client }) =>
      Effect.tryPromise(() => client.callTool({ name: "check_permissions", arguments: {} })),
    ),
    Effect.map((result) => {
      const decoded = decodePermissions(result);
      return decoded._tag === "Some"
        ? {
            accessibility: decoded.value.structuredContent.accessibility,
            screenRecording: decoded.value.structuredContent.screen_recording,
          }
        : null;
    }),
    Effect.orElseSucceed(() => null),
  );

  const status: Effect.Effect<ComputerUseStatus> = Effect.gen(function* () {
    if (platform !== "darwin") return { status: "unsupported", platform } as const;
    if (!(yield* installed.pipe(Effect.orElseSucceed(() => false)))) {
      return {
        status: "not-installed",
        installCommand: INSTALL_COMMAND,
        docsUrl: DOCS_URL,
      } as const;
    }
    const versionOutput = yield* run(["--version"]).pipe(Effect.option);
    const version =
      versionOutput._tag === "Some"
        ? (/\d+\.\d+\.\d+\S*/.exec(versionOutput.value.stdout)?.[0] ?? "unknown")
        : "unknown";
    const daemon = yield* run(["status"]).pipe(Effect.option);
    if (daemon._tag === "None" || daemon.value.code !== 0) {
      return { status: "stopped", version } as const;
    }
    return { status: "running", version, permissions: yield* readPermissions } as const;
  }).pipe(Effect.withSpan("CuaDriver.status"));

  const controlFailure = (action: ComputerUseAction) => (cause: unknown) =>
    new ComputerUseControlError({ action, detail: describeCause(cause) });

  const control = Effect.fn("CuaDriver.control")(function* (action: ComputerUseAction) {
    const current = yield* status;
    if (current.status === "unsupported" || current.status === "not-installed") {
      return yield* new ComputerUseControlError({
        action,
        detail:
          current.status === "unsupported"
            ? `Computer use is only available on macOS, not ${current.platform}.`
            : "Cua Driver is not installed.",
      });
    }
    if (action === "start") {
      yield* connected.pipe(Effect.mapError(controlFailure(action)));
    } else if (action === "grant-permissions") {
      // Cua launches its own app so macOS attributes the prompts to Cua Driver, then
      // waits for the user; the status read afterwards reports what they allowed.
      yield* run(["permissions", "grant"], GRANT_TIMEOUT).pipe(
        Effect.mapError(controlFailure(action)),
      );
    } else {
      yield* disconnect;
      const stopped = yield* run(["stop"]).pipe(Effect.mapError(controlFailure(action)));
      if (stopped.code !== 0 && current.status === "running") {
        return yield* new ComputerUseControlError({
          action,
          detail: stopped.stderr.trim() || `cua-driver stop exited with ${stopped.code}.`,
        });
      }
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
      Effect.withSpan("CuaDriver.call", { attributes: { tool: name } }),
    );

  yield* Effect.addFinalizer(() => disconnect);

  return CuaDriver.of({
    status,
    control,
    catalog: Effect.map(connected, ({ catalog }) => catalog),
    call,
  });
});

export const layer = Layer.effect(CuaDriver, make()).pipe(Layer.provide(ProcessRunner.layer));
