import * as NodeModule from "node:module";

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type ServerSettings as ServerSettingsValue,
} from "@rove-code/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@rove-code/shared/hostProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CuaDriver from "./CuaDriver.ts";

const require = NodeModule.createRequire(import.meta.url);
const threadId = ThreadId.make("cua-driver-test");
const decodeCapture = Schema.decodeUnknownSync(Schema.Struct({ capture_id: Schema.String }));
const decodeTransport = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      args: Schema.Array(Schema.String),
      display: Schema.String,
      wayland: Schema.String,
      bus: Schema.String,
    }),
  ),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** A stand-in `cua-driver` whose daemon, grants, and telemetry are files in `stateDir`. */
const fakeDriverScript = (stateDir: string) => `#!${process.execPath}
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
if (command === "doctor") {
  console.log(fs.existsSync(file("doctor")) ? fs.readFileSync(file("doctor"), "utf8") : JSON.stringify({ ok: true, probes: [
    { label: "display server", status: "ok", message: "X11 desktop" },
    { label: "AT-SPI", status: "ok", message: "Accessibility bus reachable" },
  ] }));
  process.exit(fs.existsSync(file("doctor-failed")) ? 1 : 0);
}
if (command !== "mcp") process.exit(2);
const direct = process.argv.includes("--direct");
if (!direct) fs.writeFileSync(file("running"), "");
fs.appendFileSync(file("transports"), JSON.stringify({ args: process.argv.slice(2), display: process.env.DISPLAY, wayland: process.env.WAYLAND_DISPLAY, bus: process.env.DBUS_SESSION_BUS_ADDRESS }) + "\\n");
const { Server } = require(${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/index.js"))});
const { StdioServerTransport } = require(${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/stdio.js"))});
const types = require(${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/types.js"))});
const server = new Server(
  { name: "fake-cua", version: "9.8.7" },
  { capabilities: { tools: {} }, instructions: "Snapshot, then act." },
);
const object = (properties = {}) => ({ type: "object", properties });
const captures = new Map();
let captureSequence = 0;
server.setRequestHandler(types.ListToolsRequestSchema, async () => ({
  tools: [
    { name: "check_permissions", description: "Report grants.", inputSchema: object() },
    { name: "invoke_menu", description: "Invoke a menu.", inputSchema: object() },
    { name: "click", description: "Click a window element.", inputSchema: object({ pid: { type: "number" }, session: { type: "string" } }) },
    { name: "screenshot", description: "Capture the screen.", inputSchema: object(), annotations: { readOnlyHint: true } },
    { name: "get_window_state", description: "Capture a window.", inputSchema: object({ session: { type: "string" } }) },
    { name: "parse_visual_regions", description: "Parse a capture.", inputSchema: object({ capture_id: { type: "string" } }) },
  ],
}));
server.setRequestHandler(types.CallToolRequestSchema, async ({ params }) => {
  const ok = fs.existsSync(file("granted"));
  if (params.name === "disconnect") process.exit(0);
  if (params.name === "health_report") {
    return { content: [], structuredContent: JSON.parse(fs.existsSync(file("doctor")) ? fs.readFileSync(file("doctor"), "utf8") : '{"checks":[{"name":"AT-SPI","status":"pass","message":"Private guest bus"}]}') };
  }
  if (params.name === "check_permissions") {
    return { content: [{ type: "text", text: "grants" }], structuredContent: { accessibility: ok, screen_recording: ok } };
  }
  if (params.name === "get_window_state") {
    const capture_id = "capture-" + process.pid + "-" + captureSequence++;
    captures.set(capture_id, params.arguments?.session ?? "implicit");
    return { content: [{ type: "text", text: "Captured." }], structuredContent: { capture_id } };
  }
  if (params.name === "parse_visual_regions") {
    const valid = captures.get(params.arguments?.capture_id) === "implicit";
    return { isError: !valid, content: [{ type: "text", text: valid ? "Parsed." : "Capture ownership mismatch." }], structuredContent: { code: valid ? "parsed" : "capture_generation_mismatch" } };
  }
  if (params.name === "click") {
    return { content: [{ type: "text", text: JSON.stringify(params.arguments) }], structuredContent: params.arguments };
  }
  return { content: [{ type: "image", data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png" }] };
});
if (!direct) setInterval(() => { if (!fs.existsSync(file("running"))) process.exit(0); }, 50);
process.stdin.on("end", () => process.exit(0));
server.connect(new StdioServerTransport());
`;

const fakePodmanScript = (stateDir: string, executable: string) => `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const file = name => path.join(${JSON.stringify(stateDir)}, name);
const args = process.argv.slice(2);
if (args.shift() !== "--remote=false") process.exit(2);
const command = args.shift();
if (command === "info") { console.log(JSON.stringify({ host: { security: { rootless: !fs.existsSync(file("rootful")) } } })); process.exit(0); }
if (command === "image") process.exit(fs.existsSync(file("image-missing")) ? 1 : 0);
if (command === "ps") { console.log("[]"); process.exit(0); }
if (command === "build") { fs.rmSync(file("image-missing"), { force: true }); process.exit(0); }
if (command === "inspect") {
  const name = args[0];
  if (!fs.existsSync(file(name))) { console.error("no such container"); process.exit(1); }
  console.log(fs.readFileSync(file(name), "utf8")); process.exit(0);
}
if (command === "rm") { fs.rmSync(file(args[1]), { force: true }); process.exit(0); }
if (command === "run") {
  const name = args[args.indexOf("--name") + 1];
  const [label, owner] = args[args.indexOf("--label") + 1].split("=");
  fs.writeFileSync(file(name), JSON.stringify([{ Id: name, Config: { Labels: { [label]: owner } }, State: { Running: true } }]));
}
if (command !== "run" && command !== "exec") process.exit(2);
const child = spawn(process.execPath, [${JSON.stringify(executable)}, "mcp", "--direct"], {
  stdio: "inherit", env: { ...process.env, DISPLAY: ":1", WAYLAND_DISPLAY: "", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/agent/private-bus" },
});
process.on("SIGTERM", () => { child.kill(); process.exit(0); });
child.on("exit", code => process.exit(code ?? 0));
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
  options: {
    readonly installed: boolean;
    readonly signed?: boolean;
    readonly running?: boolean;
    readonly platform?: "darwin" | "linux";
    readonly environment?: NodeJS.ProcessEnv;
    readonly discovery?: "home" | "path" | "configured";
  },
  body: (harness: Harness) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "rove-cua-driver-" });
    const appPath = path.join(stateDir, "CuaDriver.app");
    const executableDir =
      options.platform === "linux"
        ? options.discovery === "home"
          ? path.join(stateDir, ".local", "bin")
          : path.join(stateDir, "bin")
        : path.join(appPath, "Contents", "MacOS");
    const writeApp = Effect.gen(function* () {
      yield* fs.makeDirectory(executableDir, { recursive: true });
      yield* fs.writeFileString(path.join(executableDir, "cua-driver"), fakeDriverScript(stateDir));
      yield* fs.chmod(path.join(executableDir, "cua-driver"), 0o755);
    });
    if (options.installed) yield* writeApp;
    if (options.running) yield* fs.writeFileString(path.join(stateDir, "running"), "");

    const podmanDir = path.join(stateDir, "runtime");
    if (options.platform === "linux") {
      yield* fs.makeDirectory(podmanDir);
      yield* fs.writeFileString(
        path.join(podmanDir, "podman"),
        fakePodmanScript(stateDir, path.join(executableDir, "cua-driver")),
      );
      yield* fs.chmod(path.join(podmanDir, "podman"), 0o755);
      if (!options.installed) yield* fs.writeFileString(path.join(stateDir, "image-missing"), "");
    }
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
    let currentSettings = { ...DEFAULT_SERVER_SETTINGS, enableAgentComputerUse: true };
    const changes = Stream.fromQueue(settingsChanges).pipe(
      Stream.tap((value) =>
        Effect.sync(() => {
          currentSettings = value;
        }),
      ),
    );
    const settings = Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.sync(() => currentSettings),
      subscribeChanges: Effect.succeed(changes),
      streamChanges: changes,
    });
    const driver = yield* CuaDriver.make(
      options.platform === "linux" && options.discovery === undefined
        ? { appPath, executablePath: path.join(executableDir, "cua-driver") }
        : { appPath },
    ).pipe(
      Effect.provideService(HostProcessEnvironment, {
        ...process.env,
        HOME: stateDir,
        CUA_DRIVER_RS_INSTALL_DIR: options.discovery === "configured" ? executableDir : undefined,
        CUA_DRIVER_BIN_DIR: undefined,
        PATH: `${podmanDir}:${options.discovery === "path" ? `${executableDir}:` : ""}${process.env.PATH ?? ""}`,
        DISPLAY: options.platform === "linux" ? ":42" : process.env.DISPLAY,
        ...options.environment,
      }),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provide(settings),
    );
    return yield* body({ driver, stateDir, runs, settingsChanges });
  }).pipe(
    Effect.provideService(HostProcessPlatform, options.platform ?? "darwin"),
    Effect.provide(ProcessRunner.layer),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

it.effect("installs through Cua's official installer and keeps Cua's usage data off", () =>
  withDriver({ installed: false }, ({ driver, runs }) =>
    Effect.gen(function* () {
      expect(yield* driver.status).toEqual({ status: "not-installed", platform: "darwin" });
      expect(yield* driver.control({ action: "install" })).toEqual({
        status: "stopped",
        version: "9.8.7",
        telemetry: false,
        readiness: { platform: "darwin", permissions: null },
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
      const error = yield* driver.call("click", {}, threadId).pipe(Effect.flip);
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
        readiness: { platform: "darwin", permissions: null },
      });
      expect(yield* driver.control({ action: "start" })).toEqual({
        status: "running",
        version: "9.8.7",
        telemetry: true,
        readiness: {
          platform: "darwin",
          permissions: { accessibility: false, screenRecording: false },
        },
      });
      expect(yield* driver.control({ action: "grant-permissions" })).toMatchObject({
        readiness: {
          platform: "darwin",
          permissions: { accessibility: true, screenRecording: true },
        },
      });

      yield* TestClock.adjust("4 minutes");
      yield* driver.call("click", { pid: 1 }, threadId);
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
      yield* driver.call("click", { pid: 1 }, threadId);
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
        ["invoke_menu", false],
        ["click", false],
        ["screenshot", true],
        ["get_window_state", false],
        ["parse_visual_regions", false],
      ]);

      const click = yield* driver.call("click", { pid: 42 }, threadId);
      expect(click.structuredContent).toEqual({ pid: 42 });

      yield* TestClock.adjust(CuaDriver.IDLE_TIMEOUT);
      const screenshot = yield* driver.call("screenshot", {}, threadId);
      expect(screenshot.content).toEqual([
        { type: "image", data: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
      ]);
    }),
  ),
);

it.effect("keeps capture ownership on one thread transport and refuses a peer's capture", () =>
  withDriver({ installed: true }, ({ driver }) =>
    Effect.gen(function* () {
      const first = ThreadId.make("first-cua-thread");
      const second = ThreadId.make("second-cua-thread");
      const capture = yield* driver.call("get_window_state", {}, first);
      const captureId = decodeCapture(capture.structuredContent).capture_id;
      const parsed = yield* driver.call("parse_visual_regions", { capture_id: captureId }, first);
      expect(parsed.structuredContent).toEqual({ code: "parsed" });
      const peer = yield* driver.call("parse_visual_regions", { capture_id: captureId }, second);
      expect(peer.isError).toBe(true);
      expect(peer.structuredContent).toEqual({ code: "capture_generation_mismatch" });
      const next = yield* driver.call("get_window_state", {}, first);
      expect(decodeCapture(next.structuredContent).capture_id).not.toBe(captureId);
    }),
  ),
);

it.effect("expires an idle thread without retiring an active thread's captures", () =>
  withDriver({ installed: true }, ({ driver }) =>
    Effect.gen(function* () {
      const idle = ThreadId.make("idle-cua-thread");
      const active = ThreadId.make("active-cua-thread");
      const idleCapture = yield* driver.call("get_window_state", {}, idle);
      yield* TestClock.adjust("3 minutes");
      const activeCapture = yield* driver.call("get_window_state", {}, active);
      yield* TestClock.adjust("2 minutes");
      expect((yield* driver.status).status).toBe("running");
      const activeParsed = yield* driver.call(
        "parse_visual_regions",
        {
          capture_id: decodeCapture(activeCapture.structuredContent).capture_id,
        },
        active,
      );
      expect(activeParsed.structuredContent).toEqual({ code: "parsed" });
      const idleParsed = yield* driver.call(
        "parse_visual_regions",
        {
          capture_id: decodeCapture(idleCapture.structuredContent).capture_id,
        },
        idle,
      );
      expect(idleParsed.isError).toBe(true);
      yield* TestClock.adjust(CuaDriver.IDLE_TIMEOUT);
      expect((yield* driver.status).status).toBe("stopped");
    }),
  ),
);

it.effect("stops its idle daemon after a thread transport disconnects unexpectedly", () =>
  withDriver({ installed: true }, ({ driver }) =>
    Effect.gen(function* () {
      const error = yield* driver.call("disconnect", {}, threadId).pipe(Effect.flip);
      expect(error._tag).toBe("CuaDriverUnavailableError");
      yield* TestClock.adjust(CuaDriver.IDLE_TIMEOUT);
      expect((yield* driver.status).status).toBe("stopped");
    }),
  ),
);

it.effect("installs Linux without codesign or macOS permission commands", () =>
  withDriver({ installed: false, platform: "linux" }, ({ driver, runs, stateDir }) =>
    Effect.gen(function* () {
      expect(yield* driver.status).toEqual({ status: "not-installed", platform: "linux" });
      const installed = yield* driver.control({ action: "install" });
      expect(installed).toMatchObject({
        status: "stopped",
        telemetry: null,
        readiness: { platform: "linux", diagnostics: null, desktops: 0, capacity: 4 },
      });
      const installer = runs.find((input) => input.command === "/bin/bash");
      expect(installer?.env).toMatchObject({
        CUA_DRIVER_RS_INSTALL_DIR: `${stateDir}/bin`,
        CUA_DRIVER_RS_NO_MODIFY_PATH: "1",
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
      });
      yield* driver.control({ action: "install" });
      expect(runs.filter((input) => input.command === "/bin/bash")).toHaveLength(1);
      const refused = yield* driver.control({ action: "grant-permissions" }).pipe(Effect.flip);
      expect(refused.detail).toContain("Linux agent desktops have no macOS permission grants");
      expect(
        runs.some(
          (input) => input.command === "/usr/bin/codesign" || input.args[0] === "permissions",
        ),
      ).toBe(false);
    }),
  ),
);

for (const discovery of ["home", "path", "configured"] as const) {
  it.effect(`discovers an existing Linux driver through ${discovery}`, () =>
    withDriver({ installed: true, platform: "linux", discovery }, ({ driver, runs, stateDir }) =>
      Effect.gen(function* () {
        expect(yield* driver.status).toMatchObject({
          status: "stopped",
          readiness: { platform: "linux", diagnostics: null, desktops: 0, capacity: 4 },
        });
        const location =
          discovery === "home" ? `${stateDir}/.local/bin/cua-driver` : `${stateDir}/bin/cua-driver`;
        expect(runs.some((input) => input.command === location)).toBe(true);
      }),
    ),
  );
}

it.effect(
  "uses private Linux transports without host display or bus forwarding and leaves external daemons alone",
  () =>
    withDriver(
      {
        installed: true,
        platform: "linux",
        running: true,
        environment: {
          DISPLAY: ":71",
          WAYLAND_DISPLAY: "wayland-7",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/test/session-bus",
        },
      },
      ({ driver, runs, stateDir }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* driver.call("click", { pid: 42 }, threadId);
          const transports = yield* fs.readFileString(`${stateDir}/transports`);
          const transport = yield* decodeTransport(transports.trim());
          expect(transport).toEqual({
            args: ["mcp", "--direct"],
            display: ":1",
            wayland: "",
            bus: "unix:path=/tmp/agent/private-bus",
          });
          expect((yield* driver.status).status).toBe("running");
          yield* TestClock.adjust(CuaDriver.IDLE_TIMEOUT);
          expect((yield* driver.status).status).toBe("stopped");
          expect(yield* fs.exists(`${stateDir}/running`)).toBe(true);
          expect(runs.some((input) => input.args[0] === "status" || input.args[0] === "stop")).toBe(
            false,
          );
        }),
    ),
);

it.effect("connects from a Wayland-only Linux session", () =>
  withDriver(
    {
      installed: true,
      platform: "linux",
      environment: {
        DISPLAY: undefined,
        WAYLAND_DISPLAY: "wayland-0",
        CUA_DRIVER_RS_ENABLE_WAYLAND: "1",
      },
    },
    ({ driver }) =>
      Effect.gen(function* () {
        expect((yield* driver.control({ action: "start" })).status).toBe("running");
        expect((yield* driver.call("click", { pid: 42 }, threadId)).structuredContent).toEqual({
          pid: 42,
        });
      }),
  ),
);

it.effect("creates a private desktop when no host graphical session exists", () =>
  withDriver(
    {
      installed: true,
      platform: "linux",
      environment: { DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
    },
    ({ driver, stateDir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const result = yield* driver.call("click", { pid: 1 }, threadId);
        expect(result.structuredContent).toEqual({ pid: 1 });
        expect(yield* fs.exists(`${stateDir}/transports`)).toBe(true);
      }),
  ),
);

it.effect("reports guest health failures and rejects unreadable or empty reports", () =>
  withDriver({ installed: true, platform: "linux" }, ({ driver, stateDir }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        `${stateDir}/doctor`,
        yield* encodeJson({
          checks: [{ name: "AT-SPI", status: "fail", message: "Accessibility bus not reachable" }],
        }),
      );
      yield* driver.call("click", { pid: 1 }, threadId);
      expect(yield* driver.status).toMatchObject({
        readiness: {
          platform: "linux",
          diagnostics: [
            { label: "AT-SPI", status: "err", message: "Accessibility bus not reachable" },
          ],
        },
      });
      for (const report of [
        "not json",
        '{"checks":[]}',
        '{"checks":[{"name":"AT-SPI","status":"unknown","message":"No report"}]}',
      ]) {
        yield* fs.writeFileString(`${stateDir}/doctor`, report);
        expect(yield* driver.status).toMatchObject({
          readiness: { platform: "linux", diagnostics: null },
        });
      }
    }),
  ),
);

it.effect("keeps Linux captures private to each thread and permits guest-only menus", () =>
  withDriver({ installed: true, platform: "linux" }, ({ driver }) =>
    Effect.gen(function* () {
      const catalog = yield* driver.catalog;
      expect(catalog.policy).toBe("isolated-desktop");
      expect(catalog.tools.map((tool) => tool.name)).toContain("invoke_menu");
      expect(catalog.tools.map((tool) => tool.name)).not.toContain("check_permissions");
      const capture = yield* driver.call("get_window_state", {}, threadId);
      const captureId = decodeCapture(capture.structuredContent).capture_id;
      expect(
        (yield* driver.call("parse_visual_regions", { capture_id: captureId }, threadId)).isError,
      ).toBe(false);
      expect(
        (yield* driver.call(
          "parse_visual_regions",
          { capture_id: captureId },
          ThreadId.make("linux-peer"),
        )).isError,
      ).toBe(true);
      yield* TestClock.adjust(CuaDriver.IDLE_TIMEOUT);
      expect(
        (yield* driver.call("parse_visual_regions", { capture_id: captureId }, threadId)).isError,
      ).toBe(true);
    }),
  ),
);

it.effect("closes Linux connections when computer use is disabled", () =>
  withDriver({ installed: true, platform: "linux" }, ({ driver, settingsChanges, runs }) =>
    Effect.gen(function* () {
      yield* driver.control({ action: "start" });
      yield* Queue.offer(settingsChanges, {
        ...DEFAULT_SERVER_SETTINGS,
        enableAgentComputerUse: false,
      });
      yield* Effect.yieldNow;
      expect((yield* driver.status).status).toBe("stopped");
      expect(runs.some((input) => input.args[0] === "stop")).toBe(false);
    }),
  ),
);

it.effect("is unsupported off macOS and Linux", () =>
  Effect.gen(function* () {
    const driver = yield* CuaDriver.make();
    expect(yield* driver.status).toEqual({ status: "unsupported", platform: "win32" });
  }).pipe(
    Effect.provideService(HostProcessPlatform, "win32"),
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ServerSettings.ServerSettingsService)({
          streamChanges: Stream.empty,
          subscribeChanges: Effect.succeed(Stream.empty),
        }),
        ProcessRunner.layer,
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
