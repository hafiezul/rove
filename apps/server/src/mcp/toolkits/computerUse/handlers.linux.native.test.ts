import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ServerSettings as SettingsValue,
} from "@rove-code/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@rove-code/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as CuaDriver from "../../../computerUse/CuaDriver.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ComputerUseToolsRegistrationLive } from "./handlers.ts";

const enabled =
  HostProcessPlatform.defaultValue() === "linux" && process.env.ROVE_TEST_LINUX_CUA === "1";
const settingsLayer = Layer.effect(
  ServerSettings.ServerSettingsService,
  Effect.gen(function* () {
    const base = yield* ServerSettings.ServerSettingsService;
    const events = yield* Queue.unbounded<{
      value: SettingsValue;
      drained: Deferred.Deferred<void>;
    }>();
    const changes = Stream.fromQueue(events).pipe(
      Stream.flatMap(({ value, drained }) =>
        Stream.make(value).pipe(
          Stream.concat(Stream.fromEffect(Deferred.succeed(drained, undefined)).pipe(Stream.drain)),
        ),
      ),
    );
    return ServerSettings.ServerSettingsService.of({
      ...base,
      streamChanges: changes,
      subscribeChanges: Effect.succeed(changes),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const value = yield* base.updateSettings(patch);
          const drained = yield* Deferred.make<void>();
          yield* Queue.offer(events, { value, drained });
          yield* Deferred.await(drained);
          return value;
        }),
    });
  }),
).pipe(Layer.provide(ServerSettings.layerTest({ enableAgentComputerUse: true })));
const services = CuaDriver.layer.pipe(
  Layer.provideMerge(settingsLayer),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);
const Window = Schema.Struct({ pid: Schema.Int, window_id: Schema.Int, title: Schema.String });
const decodeWindows = Schema.decodeUnknownSync(Schema.Struct({ windows: Schema.Array(Window) }));
const decodeState = Schema.decodeUnknownSync(
  Schema.Struct({
    window_title: Schema.String,
    elements_complete: Schema.Boolean,
    elements: Schema.Array(
      Schema.Struct({
        role: Schema.String,
        value: Schema.optional(Schema.String),
        element_token: Schema.String,
        screenshot_frame: Schema.optional(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
      }),
    ),
  }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeContainers = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        Id: Schema.String,
        Labels: Schema.Record(Schema.String, Schema.String),
      }),
    ),
  ),
);
const decodeServer = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Int })),
);
const decodeInspection = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        HostConfig: Schema.Struct({
          NetworkMode: Schema.String,
          PidMode: Schema.String,
          IpcMode: Schema.String,
          ReadonlyRootfs: Schema.Boolean,
          Privileged: Schema.Boolean,
          Binds: Schema.NullOr(Schema.Array(Schema.String)),
          PortBindings: Schema.Record(Schema.String, Schema.Unknown),
          SecurityOpt: Schema.Array(Schema.String),
          Memory: Schema.Number,
          PidsLimit: Schema.Number,
        }),
        Mounts: Schema.Array(Schema.Struct({ Type: Schema.String })),
      }),
    ),
  ),
);

it.live.skipIf(!enabled)(
  "prepares the actual Rove private-desktop image",
  () =>
    Effect.gen(function* () {
      const driver = yield* CuaDriver.CuaDriver;
      const status = yield* driver.control({ action: "install" });
      expect(status.status).toBe("stopped");
      yield* Effect.log("PASS. Rove prepared the private desktop image.");
    }).pipe(Effect.scoped, Effect.provide(services)),
  600_000,
);

it.effect.skipIf(!enabled)(
  "uses Rove MCP for guest input, concurrent isolation, reconnection and explicit disposal",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const driver = yield* CuaDriver.CuaDriver;
      const fs = yield* FileSystem.FileSystem;
      const client = McpSchema.McpServerClient.of({
        clientId: 1,
        clientCapabilities: {},
        clientInfo: { name: "rove-linux-verification", version: "1" },
        protocolVersion: "2025-06-18",
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "rove-linux-verification", version: "1" },
        },
        getClient: Effect.die("unused"),
      });
      const first = ThreadId.make("linux-native-first");
      const second = ThreadId.make("linux-native-second");
      const artifacts = process.env.ROVE_TEST_CUA_ARTIFACT_DIR;
      if (artifacts) yield* fs.makeDirectory(artifacts, { recursive: true });
      let sequence = 0;
      const receipts: Array<unknown> = [];
      const call = Effect.fn("native.call")(function* (
        threadId: ThreadId,
        tool: string,
        args: CuaDriver.CuaArguments = {},
      ) {
        const result = yield* server
          .callTool({ name: "computer_call", arguments: { tool, arguments: args } })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, {
              threadId,
              environmentId: EnvironmentId.make("linux-native-verification"),
              providerSessionId: "native-verification",
              providerInstanceId: ProviderInstanceId.make("pi"),
              capabilities: new Set<McpInvocationContext.McpCapability>(),
              issuedAt: 1,
            }),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        receipts.push({
          threadId,
          tool,
          isError: result.isError,
          structuredContent: result.structuredContent,
        });
        if (artifacts) {
          yield* fs.writeFileString(`${artifacts}/receipts.json`, encodeJson(receipts));
          for (const block of result.content) {
            if (block.type === "image")
              yield* fs.writeFile(`${artifacts}/capture-${sequence++}.png`, block.data);
          }
        }
        return result;
      });
      const succeed = Effect.fn("native.succeed")(function* (
        threadId: ThreadId,
        tool: string,
        args: CuaDriver.CuaArguments = {},
      ) {
        const result = yield* call(threadId, tool, args);
        expect(
          result.isError,
          `${tool}: ${encodeJson(result.structuredContent ?? result.content)}`,
        ).not.toBe(true);
        return result;
      });
      for (const tool of ["set_config", "start_session", "end_session"]) {
        expect((yield* call(first, tool)).isError).toBe(true);
      }
      expect((yield* call(first, "click", { session: "peer", pid: 1 })).isError).toBe(true);

      const open = Effect.fn("native.open")(function* (
        threadId: ThreadId,
        text: string,
        pixel: boolean,
      ) {
        yield* succeed(threadId, "launch_app", {
          launch_path: "mousepad",
          additional_arguments: ["--disable-server"],
        });
        const listing = yield* succeed(threadId, "list_windows");
        const window = decodeWindows(listing.structuredContent).windows.find((entry) =>
          entry.title.includes("Mousepad"),
        );
        expect(window).toBeDefined();
        if (!window) return yield* Effect.die("No Mousepad window");
        const target = {
          pid: window.pid,
          window_id: window.window_id,
          timeout_ms: 10_000,
          max_image_dimension: 900,
        };
        const before = yield* succeed(threadId, "get_window_state", target);
        expect(before.content.some((block) => block.type === "image")).toBe(true);
        const state = decodeState(before.structuredContent);
        expect(state.elements_complete).toBe(true);
        expect(state.window_title).toBe("Untitled 1 - Mousepad");
        const editors = state.elements.filter((element) => element.role === "text");
        expect(editors).toHaveLength(1);
        const editor = editors[0];
        if (!editor) return yield* Effect.die("No editor");
        expect(editor.value ?? "").toBe("");
        const point = editor.screenshot_frame;
        if (pixel && !point) return yield* Effect.die("No editor pixel frame");
        const address =
          pixel && point
            ? { x: point.x + 10, y: point.y + 10 }
            : { element_token: editor.element_token };
        yield* succeed(threadId, "type_text", {
          pid: window.pid,
          window_id: window.window_id,
          ...address,
          delivery_mode: "foreground",
          text,
        });
        const after = yield* succeed(threadId, "get_window_state", target);
        expect(
          decodeState(after.structuredContent).elements.find((element) => element.role === "text")
            ?.value,
        ).toBe(text);
        return target;
      });
      const targets = yield* Effect.all(
        [
          open(first, "Rove private desktop one", false),
          open(second, "Rove private desktop two", true),
        ],
        { concurrency: 2 },
      );
      const runner = yield* ProcessRunner.ProcessRunner;
      const podman = Effect.fn("native.podman")(function* (args: ReadonlyArray<string>) {
        const result = yield* runner.run({ command: "podman", args: ["--remote=false", ...args] });
        expect(result.code, result.stderr).toBe(0);
        return result.stdout;
      });
      const ownedContainers = Effect.gen(function* () {
        const listing = yield* podman([
          "ps",
          "--all",
          "--filter",
          "label=io.rove.cua.server",
          "--format",
          "json",
        ]);
        return decodeContainers(listing).filter(
          (container) => decodeServer(container.Labels["io.rove.cua.server"]).pid === process.pid,
        );
      });
      const containers = yield* ownedContainers;
      expect(containers).toHaveLength(3);
      const namespaces = ["mnt", "net", "pid", "ipc"];
      const host = yield* Effect.forEach(namespaces, (ns) => fs.readLink(`/proc/self/ns/${ns}`));
      const guests: Array<ReadonlyArray<string>> = [];
      for (const container of containers) {
        const raw = yield* podman(["inspect", container.Id]);
        if (artifacts)
          yield* fs.writeFileString(`${artifacts}/container-${container.Id}.json`, raw);
        const [inspection] = decodeInspection(raw);
        expect(inspection?.HostConfig).toMatchObject({
          NetworkMode: "none",
          PidMode: "private",
          IpcMode: "private",
          ReadonlyRootfs: true,
          Privileged: false,
          Memory: 536870912,
          PidsLimit: 128,
        });
        expect(inspection?.HostConfig.Binds ?? []).toHaveLength(0);
        expect(Object.keys(inspection?.HostConfig.PortBindings ?? {})).toHaveLength(0);
        expect(inspection?.HostConfig.SecurityOpt).toContain("no-new-privileges");
        expect(inspection?.Mounts.every((mount) => mount.Type === "tmpfs")).toBe(true);
        const guest = (yield* podman([
          "exec",
          container.Id,
          "readlink",
          ...namespaces.map((ns) => `/proc/self/ns/${ns}`),
        ]))
          .trim()
          .split("\n");
        expect(guest).toHaveLength(4);
        guest.forEach((ns, index) => {
          expect(ns).not.toBe(host[index]);
        });
        expect((yield* podman(["exec", container.Id, "id", "-u"])).trim()).toBe("1001");
        yield* podman([
          "exec",
          container.Id,
          "/bin/sh",
          "-c",
          'test -z "$ROVE_CUA_VERIFY_HOST_ONLY" && test -z "$HTTP_PROXY" && test -z "$HTTPS_PROXY"',
        ]);
        guests.push(guest);
      }
      for (let index = 0; index < 4; index++)
        expect(new Set(guests.map((guest) => guest[index])).size).toBe(3);
      if (artifacts)
        yield* fs.writeFileString(`${artifacts}/namespaces.json`, encodeJson({ host, guests }));
      yield* succeed(first, "health_report");
      const runningStatus = yield* driver.status;
      if (artifacts)
        yield* fs.writeFileString(`${artifacts}/status.json`, encodeJson(runningStatus));
      expect(runningStatus).toMatchObject({
        readiness: {
          platform: "linux",
          desktops: 2,
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ label: "ax_capability", status: "ok" }),
            expect.objectContaining({ label: "screen_capture_capability", status: "ok" }),
          ]),
        },
      });
      yield* TestClock.adjust(CuaDriver.IDLE_TIMEOUT);
      expect(yield* driver.status).toMatchObject({ status: "stopped", readiness: { desktops: 2 } });
      for (const [index, thread] of [first, second].entries()) {
        const fresh = yield* succeed(thread, "get_window_state", targets[index]);
        expect(
          decodeState(fresh.structuredContent).elements.find((element) => element.role === "text")
            ?.value,
        ).toBe(index === 0 ? "Rove private desktop one" : "Rove private desktop two");
      }
      yield* succeed(first, "close_desktop");
      expect(yield* driver.status).toMatchObject({ readiness: { desktops: 1 } });
      expect(
        decodeWindows((yield* succeed(first, "list_windows")).structuredContent).windows,
      ).toHaveLength(0);
      const peer = yield* succeed(second, "get_window_state", targets[1]);
      expect(
        decodeState(peer.structuredContent).elements.find((element) => element.role === "text")
          ?.value,
      ).toBe("Rove private desktop two");
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ enableAgentComputerUse: false });
      expect((yield* call(second, "list_windows")).isError).toBe(true);
      yield* driver.status;
      expect(yield* ownedContainers).toHaveLength(0);
      yield* Effect.log(
        "PASS. Rove MCP verified fresh text, guest pixel input, two isolated threads, idle reconnect and explicit discard.",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ComputerUseToolsRegistrationLive.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(services),
        ),
      ),
      Effect.provideService(HostProcessEnvironment, {
        ...HostProcessEnvironment.defaultValue(),
        ROVE_CUA_VERIFY_HOST_ONLY: "must-not-enter-the-guest",
        HTTP_PROXY: "http://host-only.invalid:1234",
        HTTPS_PROXY: "http://host-only.invalid:1234",
      }),
    ),
  180_000,
);
