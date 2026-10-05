import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as CuaDriver from "../../../computerUse/CuaDriver.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ComputerUseToolsRegistrationLive } from "./handlers.ts";

const decodeCapture = Schema.decodeUnknownSync(Schema.Struct({ capture_id: Schema.String }));
const decodeError = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }));

it.live.skipIf(
  process.env.ROVE_TEST_NATIVE_CUA !== "1" || HostProcessPlatform.defaultValue() !== "darwin",
)(
  "refuses intrusive input and preserves capture ownership through the installed Cua driver",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const client = McpSchema.McpServerClient.of({
        clientId: 1,
        clientCapabilities: {},
        clientInfo: { name: "rove-native-verification", version: "1" },
        protocolVersion: "2025-06-18",
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "rove-native-verification", version: "1" },
        },
        getClient: Effect.die("unused"),
      });
      const first = ThreadId.make("native-cua-first");
      const second = ThreadId.make("native-cua-second");
      const call = (threadId: ThreadId, tool: string, args: CuaDriver.CuaArguments = {}) =>
        server.callTool({ name: "computer_call", arguments: { tool, arguments: args } }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            threadId,
            environmentId: EnvironmentId.make("native-cua-verification"),
            providerSessionId: "native-verification",
            providerInstanceId: ProviderInstanceId.make("pi"),
            capabilities: new Set<McpInvocationContext.McpCapability>(),
            issuedAt: 1,
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      for (const [tool, args] of [
        ["click", { scope: "desktop", x: 2171, y: 14 }],
        ["click", { target: { kind: "desktop", display_id: "primary" }, x: 20, y: 20 }],
        ["click", { pid: process.pid, delivery_mode: "foreground" }],
        ["press_key", { key: "return", scope: "desktop" }],
        ["bring_to_front", { pid: process.pid }],
        ["set_config", { capture_scope: "desktop" }],
        ["clipboard_write", { text: "must not reach clipboard" }],
      ] satisfies Array<[string, CuaDriver.CuaArguments]>) {
        const result = yield* call(first, tool, args);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          code: "background_only",
          effect: "refused",
          executed: false,
        });
      }
      expect((yield* call(first, "list_windows")).isError).not.toBe(true);
      yield* Effect.log("PASS. Seven intrusive requests refused. The next native read succeeded.");

      const capture = yield* call(first, "get_desktop_state", { max_image_dimension: 64 });
      expect(capture.isError).not.toBe(true);
      const captureId = decodeCapture(capture.structuredContent).capture_id;
      const parsed = yield* call(first, "parse_visual_regions", { capture_id: captureId });
      if (parsed.isError) {
        expect(decodeError(parsed.structuredContent).code).toBe("not_installed");
        yield* Effect.log(
          "PASS. Same-thread capture ownership accepted. Optional perception extension is not installed.",
        );
      } else {
        yield* Effect.log("PASS. Same-thread capture parsed.");
      }
      const peer = yield* call(second, "parse_visual_regions", { capture_id: captureId });
      expect(peer.isError).toBe(true);
      expect(decodeError(peer.structuredContent).code).toBe("capture_generation_mismatch");
      expect((yield* call(first, "list_windows")).isError).not.toBe(true);
      yield* Effect.log("PASS. Peer-thread capture refused. The original thread remains usable.");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ComputerUseToolsRegistrationLive.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(CuaDriver.layer),
          Layer.provide(ServerSettings.layerTest({ enableAgentComputerUse: true })),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  30_000,
);
