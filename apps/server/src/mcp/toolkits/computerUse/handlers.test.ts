import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as CuaDriver from "../../../computerUse/CuaDriver.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ComputerUseToolsRegistrationLive } from "./handlers.ts";

const threadId = ThreadId.make("thread-computer-use");
const invocation = {
  environmentId: EnvironmentId.make("environment-computer-use"),
  threadId,
  providerSessionId: "provider-session-computer-use",
  providerInstanceId: ProviderInstanceId.make("pi"),
  capabilities: new Set<McpInvocationContext.McpCapability>(),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "computer-use-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "computer-use-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const catalog: CuaDriver.CuaCatalog = {
  instructions: "Snapshot a window before acting on it.",
  tools: [
    {
      name: "click",
      description: "Click against a target pid. Prefer element tokens.\nMore detail.",
      inputSchema: { type: "object", properties: { pid: { type: "number" }, session: {} } },
      readOnly: false,
    },
    {
      name: "list_apps",
      description: "List running apps.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    },
    {
      name: "list_windows",
      description: "List windows.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    },
    {
      name: "hotkey",
      description: "Press keys.",
      inputSchema: { type: "object", properties: {} },
      readOnly: false,
    },
  ],
};

const structuredResults: Readonly<Record<string, McpSchema.CallToolResult>> = {
  list_windows: new McpSchema.CallToolResult({
    content: [{ type: "text", text: "Found 1 window(s)." }],
    structuredContent: { windows: [{ window_id: 42, title: "Untitled" }] },
  }),
  hotkey: new McpSchema.CallToolResult({
    content: [{ type: "text", text: "Pressed." }],
    structuredContent: {},
  }),
  list_apps: new McpSchema.CallToolResult({
    content: [{ type: "text", text: "Found 2000 app(s)." }],
    structuredContent: {
      apps: Array.from({ length: 2000 }, (_, pid) => ({ pid, name: `App ${pid}` })),
    },
  }),
};

const makeLayer = (options: {
  readonly enabled: boolean;
  readonly extraTools?: ReadonlyArray<CuaDriver.CuaTool>;
  readonly calls: Array<{ name: string; args: Readonly<Record<string, unknown>> }>;
  readonly unavailable?: boolean;
  readonly results?: Readonly<Record<string, McpSchema.CallToolResult>>;
}) => {
  const unavailable = new CuaDriver.CuaDriverUnavailableError({
    detail: "Cua Driver is not installed.",
  });
  const driver = Layer.succeed(
    CuaDriver.CuaDriver,
    CuaDriver.CuaDriver.of({
      status: Effect.die("unused"),
      control: () => Effect.die("unused"),
      catalog: options.unavailable
        ? Effect.fail(unavailable)
        : Effect.succeed({ ...catalog, tools: [...catalog.tools, ...(options.extraTools ?? [])] }),
      call: (name, args) =>
        Effect.sync(() => {
          options.calls.push({ name, args });
          const canned = options.results?.[name];
          if (canned) return canned;
          return new McpSchema.CallToolResult({
            isError: false,
            content: [{ type: "image", data: new Uint8Array([7]), mimeType: "image/png" }],
          });
        }),
    }),
  );
  return ComputerUseToolsRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(ServerSettings.layerTest({ enableAgentComputerUse: options.enabled })),
    Layer.provide(driver),
  );
};

const callTool = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const text = (result: McpSchema.CallToolResult) =>
  result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

it.effect("refuses every call while computer use is off and stops agents already running", () => {
  const calls: Array<{ name: string; args: Readonly<Record<string, unknown>> }> = [];
  return Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ enableAgentComputerUse: true });
    expect((yield* callTool("computer_call", { tool: "list_apps" })).isError).toBe(false);

    yield* settings.updateSettings({ enableAgentComputerUse: false });
    const refused = yield* callTool("computer_call", { tool: "list_apps" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("Settings → Integrations");
    const described = yield* callTool("computer_describe", {});
    expect(described.isError).toBe(true);
    expect(calls).toHaveLength(1);
  }).pipe(Effect.provide(makeLayer({ enabled: false, calls })));
});

it.effect("lists operations by summary and describes one operation in full", () =>
  Effect.gen(function* () {
    const listing = yield* callTool("computer_describe", { tool: null });
    expect(text(listing)).toBe(
      "Snapshot a window before acting on it.\n\nOperations (run with computer_call):\n- click: Click against a target pid.\n- list_apps: List running apps.\n- list_windows: List windows.\n- hotkey: Press keys.",
    );

    const click = yield* callTool("computer_describe", { tool: "click" });
    expect(decodeJsonText(text(click))).toEqual({
      name: "click",
      description: catalog.tools[0]?.description,
      inputSchema: catalog.tools[0]?.inputSchema,
    });

    const unknown = yield* callTool("computer_describe", { tool: "teleport" });
    expect(unknown.isError).toBe(true);
  }).pipe(Effect.provide(makeLayer({ enabled: true, calls: [] }))),
);

it.effect("gives each thread its own Cua session unless the agent names one", () => {
  const calls: Array<{ name: string; args: Readonly<Record<string, unknown>> }> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("computer_call", { tool: "click", arguments: { pid: 4 } });
    expect(result.content).toEqual([
      { type: "image", data: new Uint8Array([7]), mimeType: "image/png" },
    ]);
    yield* callTool("computer_call", {
      tool: "click",
      arguments: { pid: 4, session: "mine" },
    });
    yield* callTool("computer_call", { tool: "list_apps", arguments: null });
    expect(calls).toEqual([
      { name: "click", args: { pid: 4, session: `rove-${threadId}` } },
      { name: "click", args: { pid: 4, session: "mine" } },
      { name: "list_apps", args: {} },
    ]);

    const unknown = yield* callTool("computer_call", { tool: "teleport" });
    expect(unknown.isError).toBe(true);
    expect(calls).toHaveLength(3);
  }).pipe(Effect.provide(makeLayer({ enabled: true, calls })));
});

it.effect("shows the model data Cua returns only as structured content", () =>
  Effect.gen(function* () {
    const windows = yield* callTool("computer_call", { tool: "list_windows" });
    expect(text(windows)).toBe(
      'Found 1 window(s).\nStructured result:\n{"windows":[{"window_id":42,"title":"Untitled"}]}',
    );
    expect(windows.structuredContent).toEqual({ windows: [{ window_id: 42, title: "Untitled" }] });

    const noStructuredData = yield* callTool("computer_call", { tool: "hotkey" });
    expect(text(noStructuredData)).toBe("Pressed.");

    const large = yield* callTool("computer_call", { tool: "list_apps" });
    const [, structured = ""] = text(large).split("Structured result:\n");
    expect(structured.length).toBeLessThan(25_000);
    expect(structured).toContain("Structured result cut at 24000 characters.");
  }).pipe(Effect.provide(makeLayer({ enabled: true, calls: [], results: structuredResults }))),
);

it.effect("reports a missing driver as a tool error the agent can relay", () =>
  Effect.gen(function* () {
    const result = yield* callTool("computer_call", { tool: "click" });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Cua Driver is not installed.");
  }).pipe(Effect.provide(makeLayer({ enabled: true, calls: [], unavailable: true }))),
);

it.effect(
  "refuses intrusive actions without dispatch and accepts the next background action",
  () => {
    const calls: Array<{ name: string; args: Readonly<Record<string, unknown>> }> = [];
    const extraTools = ["bring_to_front", "set_config", "clipboard_write", "start_session"].map(
      (name) => ({ name, description: name, inputSchema: {}, readOnly: false }),
    );
    return Effect.gen(function* () {
      for (const input of [
        { tool: "click", arguments: { scope: "desktop", x: 2171, y: 14 } },
        {
          tool: "click",
          arguments: { target: { kind: "desktop", display_id: "primary" }, x: 20, y: 20 },
        },
        { tool: "click", arguments: { pid: 4, delivery_mode: "foreground" } },
        { tool: "hotkey", arguments: { key: "return" } },
        { tool: "click", arguments: { pid: 4, delivery_mode: "auto" } },
        { tool: "click", arguments: { pid: 4, session: "another-session" } },
        ...extraTools.map(({ name }) => ({ tool: name })),
      ]) {
        const refused = yield* callTool("computer_call", input);
        expect(refused.isError).toBe(true);
        expect(refused.structuredContent).toMatchObject({
          code: "background_only",
          effect: "refused",
        });
        expect(text(refused)).toContain("No action was executed");
      }
      expect(calls).toEqual([]);
      const result = yield* callTool("computer_call", { tool: "click", arguments: { pid: 4 } });
      expect(result.isError).not.toBe(true);
      expect(calls).toHaveLength(1);
    }).pipe(Effect.provide(makeLayer({ enabled: true, calls, extraTools })));
  },
);

it.effect("rejects calls without an operation name", () =>
  Effect.gen(function* () {
    const error = yield* callTool("computer_call", {}).pipe(Effect.flip);
    expect(error._tag).toBe("InvalidParams");
  }).pipe(Effect.provide(makeLayer({ enabled: true, calls: [] }))),
);
