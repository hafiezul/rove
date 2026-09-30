import * as NodeModule from "node:module";

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as CuaDriver from "./CuaDriver.ts";

const require = NodeModule.createRequire(import.meta.url);

/** A stand-in `cua-driver` whose daemon and grants are files in `stateDir`. */
const fakeDriverScript = (stateDir: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const running = path.join(${JSON.stringify(stateDir)}, "running");
const granted = path.join(${JSON.stringify(stateDir)}, "granted");
const [command, sub] = process.argv.slice(2);
if (command === "--version") { console.log("cua-driver 9.8.7"); process.exit(0); }
if (command === "status") process.exit(fs.existsSync(running) ? 0 : 1);
if (command === "stop") { fs.rmSync(running, { force: true }); process.exit(0); }
if (command === "permissions" && sub === "grant") { fs.writeFileSync(granted, ""); process.exit(0); }
if (command !== "mcp") process.exit(2);
fs.writeFileSync(running, "");
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
  const ok = fs.existsSync(granted);
  if (params.name === "check_permissions") {
    return { content: [{ type: "text", text: "grants" }], structuredContent: { accessibility: ok, screen_recording: ok } };
  }
  if (params.name === "click") {
    return { content: [{ type: "text", text: JSON.stringify(params.arguments) }], structuredContent: params.arguments };
  }
  return { content: [{ type: "image", data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png" }] };
});
setInterval(() => { if (!fs.existsSync(running)) process.exit(0); }, 50);
process.stdin.on("end", () => process.exit(0));
server.connect(new StdioServerTransport());
`;

const withFakeDriver = <A, E>(
  body: (driver: CuaDriver.CuaDriver["Service"], stateDir: string) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cua-driver-" });
    const executablePath = path.join(stateDir, "cua-driver");
    yield* fs.writeFileString(executablePath, fakeDriverScript(stateDir));
    yield* fs.chmod(executablePath, 0o755);
    const driver = yield* CuaDriver.make({ executablePath });
    return yield* body(driver, stateDir);
  }).pipe(
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.provide(ProcessRunner.layer),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

it.effect("reports each lifecycle state and applies start, grant, and stop", () =>
  withFakeDriver((driver) =>
    Effect.gen(function* () {
      expect(yield* driver.status).toEqual({ status: "stopped", version: "9.8.7" });
      expect(yield* driver.control("start")).toEqual({
        status: "running",
        version: "9.8.7",
        permissions: { accessibility: false, screenRecording: false },
      });
      expect(yield* driver.control("grant-permissions")).toEqual({
        status: "running",
        version: "9.8.7",
        permissions: { accessibility: true, screenRecording: true },
      });
      expect(yield* driver.control("stop")).toEqual({ status: "stopped", version: "9.8.7" });
    }),
  ),
);

it.effect("forwards calls, keeps image content, and reconnects after the daemon stops", () =>
  withFakeDriver((driver) =>
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

      yield* driver.control("stop");
      const screenshot = yield* driver.call("screenshot", {});
      expect(screenshot.content).toEqual([
        { type: "image", data: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
      ]);
    }),
  ),
);

it.effect("reports a missing install and refuses to control it", () =>
  Effect.gen(function* () {
    const driver = yield* CuaDriver.make({ executablePath: "/nonexistent/cua-driver" });
    expect((yield* driver.status).status).toBe("not-installed");
    const error = yield* driver.control("start").pipe(Effect.flip);
    expect(error.detail).toBe("Cua Driver is not installed.");
    const callError = yield* driver.call("click", {}).pipe(Effect.flip);
    expect(callError.detail).toContain("Settings → Integrations");
  }).pipe(
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.provide(ProcessRunner.layer),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("is unsupported off macOS", () =>
  Effect.gen(function* () {
    const driver = yield* CuaDriver.make();
    expect(yield* driver.status).toEqual({ status: "unsupported", platform: "linux" });
  }).pipe(
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provide(ProcessRunner.layer),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);
