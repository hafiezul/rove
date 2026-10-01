import * as NodeModule from "node:module";

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CuaDriver from "./CuaDriver.ts";

const require = NodeModule.createRequire(import.meta.url);

/** A stand-in `cua-driver` whose daemon, grants, and telemetry are files in `stateDir`. */
const fakeDriverScript = (stateDir: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const file = (name) => path.join(${JSON.stringify(stateDir)}, name);
const [command, sub] = process.argv.slice(2);
if (command === "--version") { console.log("cua-driver 9.8.7"); process.exit(0); }
if (command === "status") process.exit(fs.existsSync(file("running")) ? 0 : 1);
if (command === "stop") { fs.rmSync(file("running"), { force: true }); process.exit(0); }
if (command === "telemetry" && sub === "status") {
  console.log(JSON.stringify({ enabled: !fs.existsSync(file("telemetry-off")), source: "default" }));
  process.exit(0);
}
if (command === "telemetry" && sub === "disable") { fs.writeFileSync(file("telemetry-off"), ""); process.exit(0); }
if (command === "telemetry" && sub === "enable") { fs.rmSync(file("telemetry-off"), { force: true }); process.exit(0); }
if (command === "permissions" && sub === "grant") {
  fs.writeFileSync(file("granted"), "");
  fs.writeFileSync(file("running"), "");
  process.exit(0);
}
if (command !== "mcp") process.exit(2);
fs.writeFileSync(file("running"), "");
const { Server } = require(${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/index.js"))});
const { StdioServerTransport } = require(${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/stdio.js"))});
const types = require(${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/types.js"))});
const server = new Server(
  { name: "fake-cua", version: "9.8.7" },
  { capabilities: { tools: {} }, instructions: "Snapshot, then act." },
);
const object = (properties = {}) => ({ type: "object", properties });
server.setRequestHandler(types.ListToolsRequestSchema, async () => ({
  tools: [
    { name: "check_permissions", description: "Report grants.", inputSchema: object() },
    { name: "click", description: "Click a window element.", inputSchema: object({ pid: { type: "number" }, session: { type: "string" } }) },
    { name: "screenshot", description: "Capture the screen.", inputSchema: object(), annotations: { readOnlyHint: true } },
  ],
}));
server.setRequestHandler(types.CallToolRequestSchema, async ({ params }) => {
  const ok = fs.existsSync(file("granted"));
  if (params.name === "check_permissions") {
    return { content: [{ type: "text", text: "grants" }], structuredContent: { accessibility: ok, screen_recording: ok } };
  }
  if (params.name === "click") {
    return { content: [{ type: "text", text: JSON.stringify(params.arguments) }], structuredContent: params.arguments };
  }
  return { content: [{ type: "image", data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png" }] };
});
setInterval(() => { if (!fs.existsSync(file("running"))) process.exit(0); }, 50);
process.stdin.on("end", () => process.exit(0));
server.connect(new StdioServerTransport());
`;

const exited = (code: number): ProcessRunner.ProcessRunOutput => ({
  code: ChildProcessSpawner.ExitCode(code),
  stdout: "",
  stderr: "",
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

interface Harness {
  readonly driver: CuaDriver.CuaDriver["Service"];
  readonly stateDir: string;
  readonly runs: Array<ProcessRunner.ProcessRunInput>;
  readonly settingsChanges: Queue.Queue<ServerSettingsValue>;
}

/**
 * Runs the real service against the fake driver. `codesign` and the installer are
 * answered here: the first reports the given signature, the second writes the fake app.
 */
const withDriver = <A, E>(
  options: { readonly installed: boolean; readonly signed?: boolean; readonly running?: boolean },
  body: (harness: Harness) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cua-driver-" });
    const appPath = path.join(stateDir, "CuaDriver.app");
    const executableDir = path.join(appPath, "Contents", "MacOS");
    const writeApp = Effect.gen(function* () {
      yield* fs.makeDirectory(executableDir, { recursive: true });
      yield* fs.writeFileString(path.join(executableDir, "cua-driver"), fakeDriverScript(stateDir));
      yield* fs.chmod(path.join(executableDir, "cua-driver"), 0o755);
    });
    if (options.installed) yield* writeApp;
    if (options.running) yield* fs.writeFileString(path.join(stateDir, "running"), "");

    const real = yield* ProcessRunner.ProcessRunner;
    const runs: Array<ProcessRunner.ProcessRunInput> = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.suspend(() => {
          runs.push(input);
          if (input.command === "/usr/bin/codesign") {
            return Effect.succeed(exited(options.signed === false ? 3 : 0));
          }
          if (input.command === "/bin/bash") {
            return writeApp.pipe(Effect.as(exited(0)), Effect.orDie);
          }
          return real.run(input);
        }),
    });
    const settingsChanges = yield* Queue.unbounded<ServerSettingsValue>();
    const settings = Layer.mock(ServerSettings.ServerSettingsService)({
      streamChanges: Stream.fromQueue(settingsChanges),
    });
    const driver = yield* CuaDriver.make({ appPath }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provide(settings),
    );
    return yield* body({ driver, stateDir, runs, settingsChanges });
  }).pipe(
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.provide(ProcessRunner.layer),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

it.effect("installs through Cua's official installer and keeps Cua's usage data off", () =>
  withDriver({ installed: false }, ({ driver, runs }) =>
    Effect.gen(function* () {
      expect(yield* driver.status).toEqual({ status: "not-installed" });
      expect(yield* driver.control({ action: "install" })).toEqual({
        status: "stopped",
        version: "9.8.7",
        telemetry: false,
      });
      const installer = runs.find((input) => input.command === "/bin/bash");
      expect(installer?.args[1]).toContain("https://cua.ai/driver/install.sh");
      expect(installer?.env).toEqual({
        CUA_DRIVER_RS_NO_MODIFY_PATH: "1",
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
      });
      const signature = runs.find((input) => input.command === "/usr/bin/codesign");
      expect(signature?.args.join(" ")).toContain('certificate leaf[subject.OU] = "YCK386LBJ7"');

      expect(yield* driver.control({ action: "set-telemetry", enabled: true })).toMatchObject({
        telemetry: true,
      });
    }),
  ),
);

it.effect("never runs an app at the Cua path that Cua did not sign", () =>
  withDriver({ installed: true, signed: false }, ({ driver, runs }) =>
    Effect.gen(function* () {
      expect(yield* driver.status).toEqual({ status: "untrusted" });
      const error = yield* driver.call("click", {}).pipe(Effect.flip);
      expect(error.detail).toContain("not signed by Cua AI, Inc.");
      const refused = yield* driver.control({ action: "start" }).pipe(Effect.flip);
      expect(refused.detail).toContain("not signed by Cua AI, Inc.");
      expect(runs.every((input) => !input.command.endsWith("cua-driver"))).toBe(true);
    }),
  ),
);

it.effect("quits a daemon it started after five idle minutes", () =>
  withDriver({ installed: true }, ({ driver }) =>
    Effect.gen(function* () {
      expect(yield* driver.status).toEqual({
        status: "stopped",
        version: "9.8.7",
        telemetry: true,
      });
      expect(yield* driver.control({ action: "start" })).toEqual({
        status: "running",
        version: "9.8.7",
        telemetry: true,
        permissions: { accessibility: false, screenRecording: false },
      });
      expect(yield* driver.control({ action: "grant-permissions" })).toMatchObject({
        permissions: { accessibility: true, screenRecording: true },
      });

      yield* TestClock.adjust("4 minutes");
      yield* driver.call("click", { pid: 1 });
      yield* TestClock.adjust("4 minutes");
      expect((yield* driver.status).status).toBe("running");

      yield* TestClock.adjust(CuaDriver.IDLE_TIMEOUT);
      expect((yield* driver.status).status).toBe("stopped");
    }),
  ),
);

it.effect("leaves a daemon it did not start running", () =>
  withDriver({ installed: true, running: true }, ({ driver }) =>
    Effect.gen(function* () {
      yield* driver.call("click", { pid: 1 });
      yield* TestClock.adjust(CuaDriver.IDLE_TIMEOUT);
      expect((yield* driver.status).status).toBe("running");
    }),
  ),
);

it.effect("quits its daemon as soon as agent computer use is turned off", () =>
  withDriver({ installed: true }, ({ driver, settingsChanges }) =>
    Effect.gen(function* () {
      yield* driver.control({ action: "start" });
      yield* Queue.offer(settingsChanges, {
        ...DEFAULT_SERVER_SETTINGS,
        enableAgentComputerUse: false,
      });
      yield* Effect.yieldNow;
      expect((yield* driver.status).status).toBe("stopped");
    }),
  ),
);

it.effect("forwards calls, keeps image content, and reconnects after an idle release", () =>
  withDriver({ installed: true }, ({ driver }) =>
    Effect.gen(function* () {
      const catalog = yield* driver.catalog;
      expect(catalog.instructions).toBe("Snapshot, then act.");
      expect(catalog.tools.map((tool) => [tool.name, tool.readOnly])).toEqual([
        ["check_permissions", false],
        ["click", false],
        ["screenshot", true],
      ]);

      const click = yield* driver.call("click", { pid: 42, session: "thread-1" });
      expect(click.structuredContent).toEqual({ pid: 42, session: "thread-1" });

      yield* TestClock.adjust(CuaDriver.IDLE_TIMEOUT);
      const screenshot = yield* driver.call("screenshot", {});
      expect(screenshot.content).toEqual([
        { type: "image", data: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
      ]);
    }),
  ),
);

it.effect("is unsupported off macOS", () =>
  Effect.gen(function* () {
    const driver = yield* CuaDriver.make();
    expect(yield* driver.status).toEqual({ status: "unsupported", platform: "linux" });
  }).pipe(
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ServerSettings.ServerSettingsService)({ streamChanges: Stream.empty }),
        ProcessRunner.layer,
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
