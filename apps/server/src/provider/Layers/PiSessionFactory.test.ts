// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ServerConfig } from "../../config.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  ApprovalRequestId,
  PiSettings,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import * as PiSdk from "@earendil-works/pi-coding-agent";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as PiRoveTools from "./PiRoveTools.ts";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";

import {
  createPiSession,
  createPiSessionServices,
  PiResourceLoader,
  resolvePiModelForSession,
  resolvePiSessionResume,
} from "./PiSessionFactory.ts";
import {
  makePiAdapter,
  parsePiResumeCursor,
  type PiSessionEventLike,
  type PiSessionLike,
} from "./PiAdapter.ts";

vi.mock("@earendil-works/pi-coding-agent", { spy: true });

const decodePiSettings = Schema.decodeSync(PiSettings);

describe("headless Pi extensions", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  const sessions: PiSessionLike[] = [];

  beforeEach(() => {
    root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-pi-extensions-")),
    );
    cwd = NodePath.join(root, "project");
    agentDir = NodePath.join(root, "agent");
    NodeFS.mkdirSync(NodePath.join(cwd, ".pi", "extensions"), { recursive: true });
    NodeFS.mkdirSync(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_OFFLINE", "1");
    NodeFS.copyFileSync(
      new URL("./fixtures/pi-extension.ts", import.meta.url),
      NodePath.join(cwd, ".pi", "extensions", "fixture.ts"),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const session of sessions.splice(0)) await session.dispose();
    vi.restoreAllMocks();
    McpProviderSession.clearAllMcpProviderSessions();
    vi.unstubAllEnvs();
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  const create = async (extensions = true) => {
    const session = await createPiSession(
      {
        cwd,
        model: extensions ? "rove-extension-test/fixture" : undefined,
        thinkingLevel: undefined,
        resumeSessionId: undefined,
      },
      { extensions },
    );
    sessions.push(session);
    return session;
  };
  const log = () => NodeFS.readFileSync(NodePath.join(cwd, "extension.log"), "utf8");

  it("installs thread-authorized Rove tools even with user extensions disabled", async () => {
    const threadId = ThreadId.make("pi-rove-tools");
    const config = {
      threadId,
      environmentId: EnvironmentId.make("test-env"),
      providerInstanceId: ProviderInstanceId.make("pi"),
      providerSessionId: "test-session",
      endpoint: "http://127.0.0.1:12345/mcp",
      authorizationHeader: "Bearer test-secret",
      capabilities: new Set<string>(),
    };
    McpProviderSession.setMcpProviderSession(config);
    const dispose = vi.fn(async () => {});
    const bridge = vi.spyOn(PiRoveTools, "createPiRoveTools").mockResolvedValue({
      tools: [
        {
          name: "mcp__rove__preview_status",
          label: "Preview status",
          description: "Inspect preview",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: "ready" }], details: {} }),
        },
      ],
      dispose,
    });
    const createSdkSession = vi.spyOn(PiSdk, "createAgentSessionFromServices");
    const session = await createPiSession(
      {
        threadId,
        cwd,
        model: undefined,
        thinkingLevel: undefined,
        resumeSessionId: undefined,
      },
      { extensions: false },
    );
    sessions.push(session);
    expect(bridge).toHaveBeenCalledWith(config);
    const result = createSdkSession.mock.results[0]!;
    if (result.type !== "return") throw new Error("SDK session creation failed");
    const { session: sdkSession } = await result.value;
    expect(sdkSession.getActiveToolNames()).toContain("mcp__rove__preview_status");
    expect(sdkSession.getAllTools().map((tool) => tool.name)).not.toContain("fixture_tool");
    await session.dispose();
    await session.dispose();
    expect(dispose).toHaveBeenCalledOnce();

    dispose.mockClear();
    createSdkSession.mockRejectedValueOnce(new Error("SDK startup failed"));
    await expect(
      createPiSession(
        {
          threadId,
          cwd,
          model: undefined,
          thinkingLevel: undefined,
          resumeSessionId: undefined,
        },
        { extensions: false },
      ),
    ).rejects.toThrow("SDK startup failed");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("creates tool-free in-memory metadata sessions with Rove runtime instructions", async () => {
    const createSdkSession = vi.spyOn(PiSdk, "createAgentSessionFromServices").mockClear();
    const session = await createPiSession(
      { cwd, model: undefined, thinkingLevel: undefined, resumeSessionId: undefined },
      { extensions: false, textGeneration: true },
    );
    sessions.push(session);
    const result = createSdkSession.mock.results[0]!;
    if (result.type !== "return") throw new Error("SDK session creation failed");
    const { session: sdkSession } = await result.value;
    expect(session.sessionFile).toBeUndefined();
    expect(sdkSession.getActiveToolNames()).toEqual([]);
    expect(sdkSession.agent.state.systemPrompt).toContain(
      "running in Rove Code through the Pi harness",
    );
    expect(sdkSession.agent.state.systemPrompt).toContain("link_pull_request");
    expect(NodeFS.existsSync(NodePath.join(cwd, "extension.log"))).toBe(false);
  });

  it("isolates persistent history and ID-only recovery by the instance agent directory", async () => {
    const instanceDir = NodePath.join(root, "other-agent");
    const input = {
      cwd,
      agentDir: instanceDir,
      model: "rove-extension-test/fixture",
      thinkingLevel: undefined,
      resumeSessionId: undefined,
    };
    const first = await createPiSession(input);
    sessions.push(first);
    expect(
      first.sessionFile?.startsWith(NodePath.join(instanceDir, "sessions") + NodePath.sep),
    ).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(agentDir, "sessions"))).toBe(false);
    await first.prompt("Remember the isolated conversation");
    const messages = JSON.stringify(first.messages);
    await first.dispose();

    const resumed = await createPiSession({ ...input, resumeSessionId: first.sessionId });
    sessions.push(resumed);
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(JSON.stringify(resumed.messages)).toBe(messages);
    await expect(
      createPiSession({ ...input, agentDir, resumeSessionId: first.sessionId }),
    ).rejects.toThrow("missing");
  });

  it("persists rollback branches, including an empty root, before another prompt", async () => {
    const session = await create();
    await session.prompt("first");
    const retainedLeaf = session.getLeafId!()!;
    await session.prompt("second");
    await session.fork!(retainedLeaf);
    const history = () => SessionManager.open(session.sessionFile!).buildSessionContext().messages;
    expect(history().filter((message) => message.role === "user")).toHaveLength(1);
    await session.fork!(null);
    expect(history()).toEqual([]);
    expect(session.messages).toEqual([]);
  });

  it("resolves catalog extension models in metadata sessions without loading their tools or hooks", async () => {
    const createSdkSession = vi.spyOn(PiSdk, "createAgentSessionFromServices").mockClear();
    await create();
    const modelRuntime = createSdkSession.mock.calls.at(-1)![0].services.modelRuntime;
    const before = log();
    const helper = await createPiSession(
      {
        cwd,
        model: "rove-extension-test/fixture",
        thinkingLevel: undefined,
        resumeSessionId: undefined,
      },
      { extensions: false, textGeneration: true, modelRuntime },
    );
    sessions.push(helper);
    const result = createSdkSession.mock.results.at(-1)!;
    if (result.type !== "return") throw new Error("SDK session creation failed");
    const { session: sdkSession } = await result.value;
    expect(helper.getModel?.()?.id).toBe("fixture");
    expect(sdkSession.getActiveToolNames()).toEqual([]);
    expect(helper.sessionFile).toBeUndefined();
    expect(log()).toBe(before);
  });

  it("keeps unnamed inline identities stable when earlier factories are disabled", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const loader = new PiResourceLoader(
      {
        cwd,
        agentDir,
        extensionFactories: [first, second],
      },
      ["<inline:1>"],
    );
    await loader.reload();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(loader.getExtensions().extensions.map((extension) => extension.path)).toContain(
      "<inline:2>",
    );
    const inventory = await loader.getDiscoveredExtensions();
    expect(inventory.find((extension) => extension.path === "<inline:1>")?.enabled).toBe(false);
    expect(inventory.find((extension) => extension.path === "<inline:2>")?.enabled).toBe(true);
  });

  it("rejects an unresolvable initial model instead of silently falling back", async () => {
    await expect(
      createPiSession({
        cwd,
        model: "unknown-provider/missing-model",
        thinkingLevel: undefined,
        resumeSessionId: undefined,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("preserves the provider-qualified effective model across live switches", async () => {
    const session = await create();
    expect(session.getModel?.()).toMatchObject({
      provider: "rove-extension-test",
      id: "fixture",
    });

    await session.setModel?.("rove-extension-test/custom-model");
    expect(session.getModel?.()).toMatchObject({
      provider: "rove-extension-test",
      id: "custom-model",
    });

    await expect(session.setModel?.("unknown-provider/missing-model")).rejects.toThrow(
      /not found/i,
    );
    expect(session.getModel?.()).toMatchObject({
      provider: "rove-extension-test",
      id: "custom-model",
    });
  });

  it("reports a custom model id fallback for a known provider", async () => {
    // A stale slug under a still-registered provider resolves to a fabricated
    // custom model id. The session runs it (user-configured custom slugs rely
    // on this), but the mismatch must be visible.
    const custom = await createPiSession({
      cwd,
      model: "rove-extension-test/missing-model",
      thinkingLevel: undefined,
      resumeSessionId: undefined,
    });
    sessions.push(custom);
    assert.include(
      custom.modelFallbackMessage ?? "",
      'Model "missing-model" not found for provider "rove-extension-test". Using custom model id.',
    );
  });

  it("applies the requested reasoning level and reports when the model clamps it", async () => {
    // The fixture model declares `reasoning: false`, so "high" must clamp to "off".
    const clamped = await createPiSession({
      cwd,
      model: "rove-extension-test/fixture",
      thinkingLevel: "high",
      resumeSessionId: undefined,
    });
    sessions.push(clamped);
    assert.include(
      clamped.modelFallbackMessage ?? "",
      'Reasoning level "high" is not supported by rove-extension-test/fixture; using "off".',
    );

    // A level the model supports stays silent — there is no mismatch to report.
    const supported = await createPiSession({
      cwd,
      model: "rove-extension-test/fixture",
      thinkingLevel: "off",
      resumeSessionId: undefined,
    });
    sessions.push(supported);
    assert.isUndefined(supported.modelFallbackMessage);
  });

  it("surfaces the SDK's model fallback when a saved model cannot be restored", async () => {
    // A second provider gives the SDK somewhere to fall back to when the
    // session's saved model (the fixture extension's) is no longer loadable.
    NodeFS.writeFileSync(
      NodePath.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "rootsys.cloud": {
            baseUrl: "https://example.test/v1",
            apiKey: "test-key",
            api: "openai-completions",
            models: [
              {
                id: "kimi-k3",
                name: "Kimi K3",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      }),
    );
    const first = await create();
    await first.prompt("Remember this conversation");
    assert.isAbove(first.messages.length, 0);
    await first.dispose();

    // Resuming without extensions makes the saved fixture model unresolvable.
    const resumed = await createPiSession(
      {
        cwd,
        model: undefined,
        thinkingLevel: undefined,
        resumeSessionId: first.sessionId,
        resumeSessionFile: first.sessionFile,
      },
      { extensions: false },
    );
    sessions.push(resumed);
    assert.include(
      resumed.modelFallbackMessage ?? "",
      "Could not restore model rove-extension-test/fixture",
    );
    assert.include(resumed.modelFallbackMessage ?? "", "Using rootsys.cloud/kimi-k3");
  });

  it("loads project hooks, commands, tools, and provider models without changing global trust", async () => {
    const settingsPath = NodePath.join(agentDir, "settings.json");
    NodeFS.writeFileSync(settingsPath, '{"defaultProjectTrust":"never"}');
    const session = await create();
    const events: PiSessionEventLike[] = [];
    session.subscribe((event) => events.push(event));
    assert.strictEqual(log(), "start:false:print\n");
    await session.prompt("/count");
    await session.prompt("handled");
    assert.include(log(), "command:1:false\ninput:rpc\n");
    assert.strictEqual(events.filter((event) => event.type === "agent_settled").length, 2);

    await session.prompt("Call the fixture tool");
    const result = events.find((event) => event.type === "tool_execution_end");
    assert.strictEqual(result?.toolName, "fixture_tool");
    assert.strictEqual(result?.isError, false);
    assert.include(JSON.stringify(result?.result), "extension tool worked");
    assert.strictEqual(events.filter((event) => event.type === "agent_settled").length, 3);
    assert.strictEqual(
      NodeFS.readFileSync(settingsPath, "utf8"),
      '{"defaultProjectTrust":"never"}',
    );

    await Promise.all([session.dispose(), session.dispose()]);
    assert.strictEqual(log().split("shutdown\n").length - 1, 1);
  });

  it.each(["what is this", ""])(
    "forwards prompt images with text %j into the session's user message",
    async (text) => {
      const session = await create();
      await session.prompt(text, {
        images: [{ type: "image", data: "AQ==", mimeType: "image/png" }],
      });
      // SAFETY: The PiSessionLike surface types messages loosely; the last user
      // message is the one this test just prompted with, and its final content
      // block is the image the SDK appended after the text block.
      const userMessage = [...session.messages]
        .toReversed()
        .find((message) => (message as { role?: string }).role === "user") as
        | { content?: Array<{ type: string; data?: string; mimeType?: string }> }
        | undefined;
      assert.isDefined(userMessage);
      assert.deepEqual(userMessage?.content?.at(-1), {
        type: "image",
        data: "AQ==",
        mimeType: "image/png",
      });
    },
  );

  const createInteractive = async () => {
    const session = await createPiSession({
      cwd,
      interactive: true,
      model: "rove-extension-test/fixture",
      thinkingLevel: undefined,
      resumeSessionId: undefined,
    });
    sessions.push(session);
    return session;
  };

  it("supports startup questions once the session can route responses", async () => {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "startup-ui.ts"),
      `
      export default function(pi) {
        pi.on("session_start", async (_event, ctx) => {
          if (!ctx.hasUI || ctx.mode !== "rpc") throw new Error("Missing remote UI");
          const name = await ctx.ui.input("Your name", "Name");
          pi.appendEntry("startup-answer", { name });
          ctx.ui.notify("Welcome " + name, "info");
        });
      }
    `,
    );
    const session = await createInteractive();
    const requested = Promise.withResolvers<PiSessionEventLike>();
    const events: PiSessionEventLike[] = [];
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "rove_ui_request") requested.resolve(event);
    });
    const accepted: boolean[] = [];
    const prompting = session.prompt("handled", {
      preflightResult: (success) => accepted.push(success),
    });
    const question = await requested.promise;
    expect(accepted).toEqual([true]);
    expect(session.hasPendingUserInput).toBe(true);
    expect(session.isPreparingPrompt).toBe(true);
    expect(session.respondToUserInput!(String(question.requestId), { answer: "Ada" })).toBe(true);
    await prompting;
    expect(events).toContainEqual({
      type: "rove_ui_notify",
      level: "info",
      message: "Welcome Ada",
    });
    expect(events.filter((event) => event.type === "rove_ui_resolved")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(1);
    expect(session.hasPendingUserInput).toBe(false);
    expect(session.isPreparingPrompt).toBe(false);
    expect(JSON.stringify(SessionManager.open(session.sessionFile!).getEntries())).toContain(
      '"name":"Ada"',
    );
  });

  it("preserves selector values, rejects forged choices, and keeps dialogs session-local", async () => {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "select-ui.ts"),
      `
      export default function(pi) {
        pi.registerCommand("pick", { handler: async (_args, ctx) => {
          const choice = await ctx.ui.select("Pick", ["same", "\\u001b[31msame\\u001b[0m"]);
          pi.appendEntry("choice", { choice });
        }});
      }
    `,
    );
    const first = await createInteractive();
    const second = await createInteractive();
    const requested = Promise.withResolvers<PiSessionEventLike>();
    first.subscribe((event) => {
      if (event.type === "rove_ui_request") requested.resolve(event);
    });
    const prompt = first.prompt("/pick");
    const event = await requested.promise;
    expect(event.questions).toMatchObject([
      {
        options: [
          { label: "same", value: "0" },
          { label: "same", value: "1" },
        ],
        allowCustomAnswer: false,
      },
    ]);
    const requestId = String(event.requestId);
    expect(second.respondToUserInput!(requestId, { answer: "1" })).toBe(false);
    expect(() => first.respondToUserInput!(requestId, { answer: "injected" })).toThrow(
      "offered options",
    );
    expect(first.hasPendingUserInput).toBe(true);
    expect(first.respondToUserInput!(requestId, { answer: "1" })).toBe(true);
    await prompt;
    const saved = SessionManager.open(first.sessionFile!)
      .getEntries()
      .find((entry) => entry.type === "custom" && entry.customType === "choice");
    expect(saved).toMatchObject({ data: { choice: "\u001b[31msame\u001b[0m" } });
    expect(first.respondToUserInput!(requestId, { answer: "0" })).toBe(false);
  });

  it("honors extension permission gates before a tool executes", async () => {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "permission-ui.ts"),
      `
      export default function(pi) {
        pi.on("tool_call", async (_event, ctx) => {
          if (!await ctx.ui.confirm("Run tool?", "Extension permission gate")) {
            return { block: true, reason: "Denied by user" };
          }
        });
      }
    `,
    );
    const session = await createInteractive();
    const requested = Promise.withResolvers<PiSessionEventLike>();
    const events: PiSessionEventLike[] = [];
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "rove_ui_request") requested.resolve(event);
    });
    const prompting = session.prompt("Call the fixture tool");
    const question = await requested.promise;
    expect(events.some((event) => event.type === "tool_execution_end")).toBe(false);
    session.respondToUserInput!(String(question.requestId), { answer: "1" });
    await prompting;
    expect(events.find((event) => event.type === "tool_execution_end")).toMatchObject({
      isError: true,
    });
    expect(JSON.stringify(events.find((event) => event.type === "tool_execution_end"))).toContain(
      "Denied by user",
    );
    expect(JSON.stringify(events)).not.toContain("extension tool worked");
  });

  it("times out extension dialogs and removes their pending request", async () => {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "timeout-ui.ts"),
      `
      export default function(pi) {
        pi.registerCommand("timed", { handler: async (_args, ctx) => {
          const confirmed = await ctx.ui.confirm("Continue?", "Timed question", { timeout: 25 });
          pi.appendEntry("timed-answer", { confirmed });
        }});
      }
    `,
    );
    const session = await createInteractive();
    const requested = Promise.withResolvers<void>();
    const events: PiSessionEventLike[] = [];
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "rove_ui_request") requested.resolve();
    });
    vi.useFakeTimers();
    const prompt = session.prompt("/timed");
    await requested.promise;
    await vi.advanceTimersByTimeAsync(25);
    await prompt;
    expect(session.hasPendingUserInput).toBe(false);
    expect(events.filter((event) => event.type === "rove_ui_resolved")).toMatchObject([
      { answers: {} },
    ]);
    expect(SessionManager.open(session.sessionFile!).getEntries()).toContainEqual(
      expect.objectContaining({ data: { confirmed: false } }),
    );
  });

  it("coalesces text widgets and status bursts without running terminal components", async () => {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "status-ui.ts"),
      `
      export default function(pi) {
        pi.registerCommand("statuses", { handler: async (_args, ctx) => {
          for (let i = 0; i < 1000; i++) ctx.ui.setStatus("progress", ctx.ui.theme.fg("accent", "Step " + i));
          ctx.ui.setStatus("second", "Remaining");
          ctx.ui.setStatus("progress", "Step 1000");
          ctx.ui.setWorkingMessage("Thinking");
          ctx.ui.setWidget("todo", ["One", "Two"]);
          ctx.ui.setStatus("cleared", "must disappear");
          ctx.ui.setStatus("cleared", undefined);
          await ctx.ui.custom(() => { throw new Error("Must not execute terminal code"); });
          await ctx.ui.custom(() => { throw new Error("Must not execute terminal code"); });
        }});
        pi.registerCommand("clear-statuses", { handler: async (_args, ctx) => {
          ctx.ui.setStatus("progress", undefined);
          ctx.ui.setStatus("second", "");
        }});
      }
    `,
    );
    const session = await createInteractive();
    const events: PiSessionEventLike[] = [];
    session.subscribe((event) => events.push(event));
    vi.useFakeTimers();
    await session.prompt("/statuses");
    expect(events.some((event) => event.type === "extension_error")).toBe(false);
    expect(
      events.filter((event) => event.type === "rove_ui_notify" && event.level === "warning"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "rove_ui_notify" && event.level === "info"),
    ).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(249);
    expect(events.filter((event) => event.type === "rove_ui_status")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events.filter((event) => event.type === "rove_ui_status")).toEqual([
      {
        type: "rove_ui_status",
        statuses: [
          { key: "progress", text: "Step 1000" },
          { key: "second", text: "Remaining" },
        ],
      },
    ]);
    await vi.advanceTimersByTimeAsync(250);
    expect(events.filter((event) => event.type === "rove_ui_text")).toEqual([
      { type: "rove_ui_text", message: "Pi: Thinking\ntodo: One\nTwo" },
    ]);
    await session.prompt("/clear-statuses");
    await vi.advanceTimersByTimeAsync(500);
    expect(events.filter((event) => event.type === "rove_ui_status").at(-1)).toEqual({
      type: "rove_ui_status",
      statuses: [],
    });
    await session.prompt("/statuses");
    await session.dispose();
    const count = events.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(events).toHaveLength(count);
  });

  it("supports multi-line editor answers and extension AbortSignal cancellation", async () => {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "editor-ui.ts"),
      `
      export default function(pi) {
        pi.registerCommand("edit-text", { handler: async (_args, ctx) => {
          const text = await ctx.ui.editor("Edit", "Original text");
          pi.appendEntry("edited-text", { text });
          const controller = new AbortController();
          const dismissed = ctx.ui.input("Dismiss me", undefined, { signal: controller.signal });
          controller.abort();
          if (await dismissed !== undefined) throw new Error("Expected cancellation");
          if (await ctx.ui.confirm("Already aborted", "Must not open", { signal: controller.signal })) throw new Error("Expected false");
        }});
      }
    `,
    );
    const session = await createInteractive();
    const requested = Promise.withResolvers<PiSessionEventLike>();
    const events: PiSessionEventLike[] = [];
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "rove_ui_request") requested.resolve(event);
    });
    const prompting = session.prompt("/edit-text");
    const question = await requested.promise;
    expect(question.questions).toMatchObject([
      { question: "Edit\n\nOriginal text", options: [], allowCustomAnswer: true },
    ]);
    session.respondToUserInput!(String(question.requestId), { answer: "First line\nSecond line" });
    await prompting;
    expect(events.filter((event) => event.type === "rove_ui_request")).toHaveLength(2);
    expect(events.filter((event) => event.type === "rove_ui_resolved")).toHaveLength(2);
    expect(session.hasPendingUserInput).toBe(false);
    expect(SessionManager.open(session.sessionFile!).getEntries()).toContainEqual(
      expect.objectContaining({ data: { text: "First line\nSecond line" } }),
    );
  });

  it("discards queued continuations on Stop and refuses further prompts", async () => {
    const session = await create();
    const sdkSession = (
      await vi.mocked(PiSdk.createAgentSessionFromServices).mock.results.at(-1)!.value
    ).session;
    await session.followUp("must not run after Stop");
    expect(sdkSession.getFollowUpMessages()).toEqual(["must not run after Stop"]);
    await session.abort();
    expect(sdkSession.getFollowUpMessages()).toEqual([]);
    await expect(session.prompt("must not restart")).rejects.toThrow("stopped");
    expect(session.messages).toEqual([]);
  });

  it("aborts a preflight question without allowing its original prompt into the agent loop", async () => {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "gate-ui.ts"),
      `
      export default function(pi) {
        pi.on("before_agent_start", async (_event, ctx) => {
          await ctx.ui.input("Before starting");
        });
      }
    `,
    );
    const session = await createInteractive();
    const requested = Promise.withResolvers<void>();
    const events: PiSessionEventLike[] = [];
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "rove_ui_request") requested.resolve();
    });
    const prompting = session.prompt("must not execute tools");
    const rejected = expect(prompting).rejects.toThrow("stopped during prompt preparation");
    await requested.promise;
    await session.abort();
    await rejected;
    expect(events.some((event) => event.type === "agent_start")).toBe(false);
    expect(events.filter((event) => event.type === "rove_ui_resolved")).toMatchObject([
      { answers: {} },
    ]);
    expect(session.hasPendingUserInput).toBe(false);
  });

  it("still disposes the SDK and Rove tools when an extension shutdown hook never resolves", async () => {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "stuck-shutdown.ts"),
      `
      export default function(pi) {
        pi.on("session_shutdown", async (_event, ctx) => {
          ctx.ui.notify("shutdown entered");
          await new Promise(() => {});
        });
      }
    `,
    );
    const session = await create();
    const sdkSession = (
      await vi.mocked(PiSdk.createAgentSessionFromServices).mock.results.at(-1)!.value
    ).session;
    const entered = Promise.withResolvers<void>();
    sdkSession.extensionRunner.setUIContext({
      ...sdkSession.extensionRunner.getUIContext(),
      notify: () => entered.resolve(),
    });
    const context = sdkSession.extensionRunner.createContext();
    vi.useFakeTimers();
    const disposal = session.dispose();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    await disposal;
    expect(() => context.cwd).toThrow("stale");
    await expect(session.prompt("no restart")).rejects.toThrow("stopped");
  });

  it("reports a rejected accepted prompt before the SDK's finally-block settlement", async () => {
    const session = await create();
    const sdkSession = (
      await vi.mocked(PiSdk.createAgentSessionFromServices).mock.results.at(-1)!.value
    ).session;
    sdkSession.agent.prompt = async () => {
      throw new Error("Agent loop crashed before producing a message");
    };
    const events: PiSessionEventLike[] = [];
    const preflight: boolean[] = [];
    session.subscribe((event) => events.push(event));
    await expect(
      session.prompt("hello", { preflightResult: (success) => preflight.push(success) }),
    ).rejects.toThrow("Agent loop crashed");
    expect(preflight).toEqual([true]);
    expect(
      events.filter((event) => event.type === "prompt_error" || event.type === "agent_settled"),
    ).toEqual([
      { type: "prompt_error", error: "Agent loop crashed before producing a message" },
      { type: "agent_settled" },
    ]);
  });

  it("keeps rejected SDK prompts on the request error channel", async () => {
    const session = await create(false);
    const events: PiSessionEventLike[] = [];
    const preflight: boolean[] = [];
    session.subscribe((event) => events.push(event));
    await expect(
      session.prompt("hello", {
        preflightResult: (accepted) => preflight.push(accepted),
      }),
    ).rejects.toThrow();
    assert.deepStrictEqual(preflight, [false]);
    assert.isFalse(events.some((event) => event.type === "prompt_error"));
  });

  it("preserves notification message identity through SDK transcript replay", async () => {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "notify.ts"),
      `export default function (pi) {
        pi.on("before_agent_start", () => ({
          message: {
            customType: "subagent-notify",
            content: "Background task completed: **researcher**",
            display: false,
          },
        }));
      }`,
    );
    const session = await create();
    const notifications: unknown[] = [];
    const transcripts: unknown[][] = [];
    const isNotification = Schema.is(
      Schema.Struct({
        customType: Schema.Literal("subagent-notify"),
      }),
    );
    session.subscribe((event) => {
      if (event.type === "message_end" && isNotification(event.message)) {
        notifications.push(event.message);
      }
      if (event.type === "agent_end" && Array.isArray(event.messages)) {
        transcripts.push(event.messages);
      }
    });

    await session.prompt("First research task");
    await session.prompt("Second research task");

    assert.strictEqual(notifications.length, 2);
    assert.notStrictEqual(notifications[0], notifications[1]);
    assert.strictEqual(transcripts.length, 2);
    assert.isTrue(transcripts[0]?.includes(notifications[0]));
    assert.isTrue(transcripts[1]?.includes(notifications[1]));
  });

  it.effect("completes a real extension command through the Rove adapter", () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        createSession: createPiSession,
      });
      yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.orDie));
      const completion = yield* Deferred.make<ProviderRuntimeEvent>();
      const question =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved = yield* Deferred.make<void>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.completed"
            ? Deferred.succeed(completion, event)
            : event.type === "user-input.requested"
              ? Deferred.succeed(question, event)
              : event.type === "user-input.resolved"
                ? Deferred.succeed(resolved, undefined)
                : Effect.void,
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      const threadId = ThreadId.make("pi-extension-integration");
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "/count" });
      const requested = yield* Deferred.await(question);
      assert.strictEqual(requested.turnId, turn.turnId);
      assert.strictEqual(requested.payload.questions[0]?.allowCustomAnswer, false);
      assert.isFalse(yield* Deferred.isDone(completion));
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(requested.requestId!), {
        answer: "0",
      });
      yield* Deferred.await(resolved);
      const completed = yield* Deferred.await(completion);
      assert.strictEqual(completed.turnId, turn.turnId);
      assert.strictEqual(completed.type, "turn.completed");
      if (completed.type === "turn.completed")
        assert.strictEqual(completed.payload.state, "completed");
      assert.include(log(), "start:true:rpc\n");
      assert.include(log(), "command:1:true\n");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "rove-pi-session-factory-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("Stop dismisses a real extension question and continuation uses a new runtime", () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        createSession: createPiSession,
      });
      yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.orDie));
      const question =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const exited = yield* Deferred.make<void>();
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => {
          events.push(event);
          return event.type === "user-input.requested"
            ? Deferred.succeed(question, event)
            : event.type === "session.exited"
              ? Deferred.succeed(exited, undefined)
              : Effect.void;
        }),
        Effect.forkChild({ startImmediately: true }),
      );
      const threadId = ThreadId.make("pi-stop-question");
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "/count" });
      const requested = yield* Deferred.await(question);
      const blocked = yield* adapter
        .sendTurn({ threadId, input: "overlapping prompt" })
        .pipe(Effect.flip);
      assert.include(blocked.detail, "pending Pi extension question");
      yield* adapter.interruptTurn(threadId, turn.turnId);
      yield* Deferred.await(exited);
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "user-input.resolved" && event.requestId === requested.requestId,
        ),
      );
      assert.strictEqual(events.filter((event) => event.type === "turn.aborted").length, 1);
      yield* adapter.startSession({
        threadId,
        cwd,
        runtimeMode: "full-access",
        resumeCursor: turn.resumeCursor,
      });
      const stale = yield* adapter
        .respondToUserInput(threadId, ApprovalRequestId.make(requested.requestId!), { answer: "0" })
        .pipe(Effect.flip);
      assert.include(stale.detail, "Unknown pending user-input request");
      const next = yield* adapter.sendTurn({ threadId, input: "handled" });
      assert.notStrictEqual(next.turnId, turn.turnId);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "rove-pi-session-ui-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("recovers the same conversation after a missing-file failure and restoration", () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter(
        decodePiSettings({ model: "rove-extension-test/fixture" }),
        { createSession: createPiSession },
      );
      yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.orDie));
      const completion = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.completed" ? Deferred.succeed(completion, event) : Effect.void,
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      const threadId = ThreadId.make("pi-recovery-integration");
      const session = yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "Remember this conversation" });
      const completed = yield* Deferred.await(completion);
      assert.strictEqual(completed.type, "turn.completed");
      if (completed.type === "turn.completed")
        assert.strictEqual(completed.payload.state, "completed");
      const before = yield* adapter.readThread(threadId);
      yield* adapter.stopSession(threadId);
      const cursor = parsePiResumeCursor(session.resumeCursor)!;
      const path = cursor.sessionFile!;
      const history = NodeFS.readFileSync(path, "utf8");
      NodeFS.unlinkSync(path);
      const error = yield* adapter
        .startSession({ threadId, cwd, runtimeMode: "full-access", resumeCursor: cursor })
        .pipe(Effect.flip);
      assert.include(error.message, "missing");
      assert.include(error.message, "create a new thread");
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.isFalse(NodeFS.existsSync(path));
      NodeFS.writeFileSync(path, history);
      const recovered = yield* adapter.startSession({
        threadId,
        cwd,
        runtimeMode: "full-access",
        resumeCursor: cursor,
      });
      assert.deepStrictEqual(recovered.resumeCursor, cursor);
      const after = yield* adapter.readThread(threadId);
      const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
      assert.strictEqual(yield* encodeJson(after.turns), yield* encodeJson(before.turns));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "rove-pi-session-factory-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it("loads a local Pi package configured in project settings", async () => {
    const packageDir = NodePath.join(root, "package");
    NodeFS.mkdirSync(packageDir);
    NodeFS.renameSync(
      NodePath.join(cwd, ".pi", "extensions", "fixture.ts"),
      NodePath.join(packageDir, "fixture.ts"),
    );
    NodeFS.writeFileSync(
      NodePath.join(packageDir, "package.json"),
      JSON.stringify({ name: "fixture-package", pi: { extensions: ["fixture.ts"] } }),
    );
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "settings.json"),
      JSON.stringify({ packages: [packageDir] }),
    );
    const session = await create();
    await session.prompt("/count");
    assert.include(log(), "command:1:false\n");
  });

  it("skips extensions listed in disabledExtensions and tells the model about it", async () => {
    const fixturePath = NodePath.join(cwd, ".pi", "extensions", "fixture.ts");
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "spy.ts"),
      `import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
export default function (pi) {
  pi.on("before_agent_start", (event, ctx) => {
    NodeFS.appendFileSync(
      NodePath.join(ctx.cwd, "disabled-note-probe.log"),
      event.systemPrompt.includes("Rove Code disables") ? "note:present" : "note:absent",
    );
  });
}`,
    );
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "dummy.ts"),
      "export default () => {};",
    );

    // A session that blocks the fixture never runs it.
    const disabledSession = await createPiSession({
      cwd,
      model: undefined,
      thinkingLevel: undefined,
      resumeSessionId: undefined,
      disabledExtensions: [fixturePath],
    });
    sessions.push(disabledSession);
    assert.isFalse(NodeFS.existsSync(NodePath.join(cwd, "extension.log")));

    // A session keeping the fixture but blocking another extension still
    // tells the model, in its system prompt, which extension Rove removed.
    const noteSession = await createPiSession({
      cwd,
      model: "rove-extension-test/fixture",
      thinkingLevel: undefined,
      resumeSessionId: undefined,
      disabledExtensions: [NodePath.join(cwd, ".pi", "extensions", "dummy.ts")],
    });
    sessions.push(noteSession);
    await noteSession.prompt("anything at all");
    assert.include(log(), "start:false:print\n");
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(cwd, "disabled-note-probe.log"), "utf8"),
      "note:present",
    );

    // An untouched discovery set keeps loading the same extension.
    const enabledSession = await create();
    await enabledSession.prompt("handled");
    assert.include(log(), "start:false:print\ninput:rpc\n");
  });

  it("filters disabled extensions before factory execution, preventing top-level crashes", async () => {
    const brokenPath = NodePath.join(cwd, ".pi", "extensions", "crash.ts");
    NodeFS.writeFileSync(brokenPath, 'throw new Error("TOP_LEVEL_CRASH_SHOULD_NOT_RUN");');

    // With brokenPath disabled, it should NEVER execute or crash session creation:
    const session = await createPiSession({
      cwd,
      model: "rove-extension-test/fixture",
      thinkingLevel: undefined,
      resumeSessionId: undefined,
      disabledExtensions: [brokenPath],
    });
    sessions.push(session);

    // Prompt works normally:
    await session.prompt("/count");
    assert.include(log(), "command:1:false\n");
  });

  it("supports explicit recovery via retryWithoutFailedExtensions when an extension fails to load", async () => {
    const brokenPath = NodePath.join(cwd, ".pi", "extensions", "broken-load.ts");
    NodeFS.writeFileSync(
      brokenPath,
      'export default () => { throw new Error("broken extension init"); };',
    );

    // Without recovery option, it throws PiExtensionLoadError:
    await expect(
      createPiSession({
        cwd,
        model: "rove-extension-test/fixture",
        thinkingLevel: undefined,
        resumeSessionId: undefined,
      }),
    ).rejects.toThrow("broken extension init");

    // With explicit recovery, it recovers by retrying without the broken extension:
    const recovered = await createPiSession(
      {
        cwd,
        model: "rove-extension-test/fixture",
        thinkingLevel: undefined,
        resumeSessionId: undefined,
      },
      { retryWithoutFailedExtensions: true },
    );
    sessions.push(recovered);

    // It recorded the startup extension error:
    const events: PiSessionEventLike[] = [];
    recovered.subscribe((e) => events.push(e));
    const extensionError = events.find((e) => e.type === "extension_error");
    assert.isDefined(extensionError);
    const // SAFETY: The extension_error event structure carries the error payload from the SDK onError callback.
      errorPayload = (extensionError as { error?: string })?.error;
    assert.include(String(errorPayload), "broken extension init");

    // And the working extension is still functional:
    await recovered.prompt("/count");
    assert.include(log(), "command:1:false\n");
  });

  it("loads global extensions and keeps each session's extension state separate", async () => {
    NodeFS.mkdirSync(NodePath.join(agentDir, "extensions"));
    NodeFS.renameSync(
      NodePath.join(cwd, ".pi", "extensions", "fixture.ts"),
      NodePath.join(agentDir, "extensions", "fixture.ts"),
    );
    const first = await create();
    const second = await create();
    await first.prompt("/count");
    await first.prompt("/count");
    await second.prompt("/count");
    assert.strictEqual(
      log(),
      "start:false:print\nstart:false:print\ncommand:1:false\ncommand:2:false\ncommand:1:false\n",
    );
  });

  it("reports extension errors and settles failed commands without an agent run", async () => {
    const session = await create();
    const events: PiSessionEventLike[] = [];
    session.subscribe((event) => events.push(event));
    await session.prompt("/broken");
    assert.isTrue(
      events.some(
        (event) => event.type === "extension_error" && event.error === "fixture command failed",
      ),
    );
    assert.strictEqual(events.at(-1)?.type, "agent_settled");
  });

  it("retains startup errors until the adapter subscribes", async () => {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "startup-error.ts"),
      'export default pi => { pi.on("session_start", () => { throw new Error("startup hook failed"); }); };',
    );
    const session = await create();
    const events: PiSessionEventLike[] = [];
    session.subscribe((event) => events.push(event));
    assert.isTrue(
      events.some(
        (event) => event.type === "extension_error" && event.error === "startup hook failed",
      ),
    );
  });

  it("rejects extension session replacement without changing Rove's session identity", async () => {
    const session = await create();
    const sessionId = session.sessionId;
    const events: PiSessionEventLike[] = [];
    session.subscribe((event) => events.push(event));
    await session.prompt("/replace-session");
    assert.strictEqual(session.sessionId, sessionId);
    assert.isTrue(
      events.some(
        (event) =>
          event.type === "extension_error" && String(event.error).includes("not supported in Rove"),
      ),
    );
    assert.strictEqual(events.at(-1)?.type, "agent_settled");
  });

  it("rejects broken extension loads instead of silently omitting them", async () => {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "broken.ts"),
      'export default () => { throw new Error("fixture load failed"); };',
    );
    await expect(create()).rejects.toThrow("fixture load failed");
  });

  it("persists a fresh session before its first prompt so startup cursors survive restart", async () => {
    const fresh = await create();
    assert.isDefined(fresh.sessionFile);
    assert.isTrue(NodeFS.existsSync(fresh.sessionFile!));
    await fresh.dispose();
    const resumed = await createPiSession({
      cwd,
      model: "rove-extension-test/fixture",
      thinkingLevel: undefined,
      resumeSessionId: fresh.sessionId,
    });
    sessions.push(resumed);
    assert.strictEqual(resumed.sessionId, fresh.sessionId);
    assert.strictEqual(resumed.resumeOutcome?.resumed, true);
    await resumed.prompt("First prompt after restart");
    assert.isAbove(resumed.messages.length, 0);
  });

  it("recovers history by its durable locator after cwd and session storage settings change", async () => {
    const fresh = await create();
    await fresh.prompt("Remember this conversation");
    const messages = [...fresh.messages];
    await fresh.dispose();
    const movedCwd = NodePath.join(root, "moved-project");
    NodeFS.renameSync(cwd, movedCwd);
    const movedAgentDir = NodePath.join(root, "other-agent");
    NodeFS.mkdirSync(movedAgentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", movedAgentDir);
    const resumed = await createPiSession({
      cwd: movedCwd,
      model: "rove-extension-test/fixture",
      thinkingLevel: undefined,
      resumeSessionId: fresh.sessionId,
      resumeSessionFile: fresh.sessionFile,
    });
    sessions.push(resumed);
    assert.strictEqual(resumed.sessionId, fresh.sessionId);
    assert.strictEqual(JSON.stringify(resumed.messages), JSON.stringify(messages));
    assert.strictEqual(resumed.sessionFile, fresh.sessionFile);
    await resumed.prompt("Continue after moving");
    assert.isAbove(resumed.messages.length, messages.length);
    await resumed.prompt("handled");
    assert.include(
      NodeFS.readFileSync(NodePath.join(movedCwd, "extension.log"), "utf8"),
      "input:rpc",
    );
  });

  it("rejects empty, malformed, mismatched, and missing session files without replacing them", async () => {
    const fresh = await create();
    const path = fresh.sessionFile!;
    await fresh.dispose();
    const header = NodeFS.readFileSync(path, "utf8");
    for (const content of ["", "not JSON\n", header.replace(fresh.sessionId, "another-session")]) {
      NodeFS.writeFileSync(path, content);
      await expect(
        createPiSession({
          cwd,
          model: undefined,
          thinkingLevel: undefined,
          resumeSessionId: fresh.sessionId,
          resumeSessionFile: path,
        }),
      ).rejects.toThrow();
      assert.strictEqual(NodeFS.readFileSync(path, "utf8"), content);
    }
    NodeFS.unlinkSync(path);
    await expect(
      createPiSession({
        cwd,
        model: undefined,
        thinkingLevel: undefined,
        resumeSessionId: fresh.sessionId,
        resumeSessionFile: path,
      }),
    ).rejects.toThrow("missing");
    assert.isFalse(NodeFS.existsSync(path));
  });

  it.skipIf(process.getuid?.() === 0)(
    "distinguishes unreadable session storage from missing history",
    async () => {
      const fresh = await create();
      await fresh.dispose();
      NodeFS.chmodSync(fresh.sessionFile!, 0);
      try {
        await expect(
          createPiSession({
            cwd,
            model: undefined,
            thinkingLevel: undefined,
            resumeSessionId: fresh.sessionId,
            resumeSessionFile: fresh.sessionFile,
          }),
        ).rejects.toThrow("unreadable");
      } finally {
        NodeFS.chmodSync(fresh.sessionFile!, 0o600);
      }
    },
  );

  it("keeps extensions disabled for auxiliary text generation", async () => {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "broken.ts"),
      'export default () => { throw new Error("must not load"); };',
    );
    await create(false);
    assert.isFalse(NodeFS.existsSync(NodePath.join(cwd, "extension.log")));
  });

  it("resolves extension-registered models for text generation through a shared runtime", async () => {
    // Without extensions and without a shared runtime, the fixture's provider
    // is unknown and the session fails — the pre-fix text-generation behavior.
    await expect(
      createPiSession(
        {
          cwd,
          model: "rove-extension-test/fixture",
          thinkingLevel: undefined,
          resumeSessionId: undefined,
        },
        { extensions: false },
      ),
    ).rejects.toThrow(/not found/i);

    // Sharing a runtime where the extension registered its provider (as the
    // Pi driver now does via the catalog host) resolves the model.
    const hostSettings = SettingsManager.create(cwd, agentDir);
    hostSettings.setProjectTrusted(true);
    const hostServices = await createPiSessionServices({
      cwd,
      agentDir,
      settingsManager: hostSettings,
    });
    const session = await createPiSession(
      {
        cwd,
        model: "rove-extension-test/fixture",
        thinkingLevel: undefined,
        resumeSessionId: undefined,
      },
      { extensions: false, modelRuntime: hostServices.modelRuntime },
    );
    sessions.push(session);
    expect(session.getModel?.()).toMatchObject({
      provider: "rove-extension-test",
      id: "fixture",
    });
  });
});

it("resolves a valid custom model for an in-session switch", async () => {
  const agentDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-factory-model-test-"));
  const modelsPath = NodePath.join(agentDir, "models.json");
  NodeFS.writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        "rootsys.cloud": {
          baseUrl: "https://example.test/v1",
          apiKey: "test-key",
          api: "openai-completions",
          models: [
            {
              id: "kimi-k3",
              name: "Kimi K3",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 8_192,
            },
          ],
        },
      },
    }),
  );

  try {
    const modelRuntime = await ModelRuntime.create({
      modelsPath,
      authPath: NodePath.join(agentDir, "auth.json"),
      allowModelNetwork: false,
    });

    const model = resolvePiModelForSession(modelRuntime, "rootsys.cloud/kimi-k3");

    assert.strictEqual(model.provider, "rootsys.cloud");
    assert.strictEqual(model.id, "kimi-k3");
  } finally {
    NodeFS.rmSync(agentDir, { recursive: true, force: true });
  }
});

describe("Pi session recovery", () => {
  let storageRoot: string;
  beforeEach(() => {
    storageRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-recovery-storage-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", storageRoot);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    NodeFS.rmSync(storageRoot, { recursive: true, force: true });
  });

  it("resolvePiSessionResume finds the persisted file for a session id", () => {
    const cwd = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-factory-test-")),
    );
    const sessionDir = SessionManager.create(cwd).getSessionDir();
    const sessionId = "01a00000-1111-2222-3333-444455556666";

    const fileName = `2026-08-16T00-00-00-000Z_${sessionId}.jsonl`;
    NodeFS.writeFileSync(NodePath.join(sessionDir, fileName), "{}\n");

    try {
      assert.deepStrictEqual(resolvePiSessionResume(cwd, sessionId), {
        resumed: true,
        sessionFile: NodePath.join(sessionDir, fileName),
      });
    } finally {
      NodeFS.rmSync(sessionDir, { recursive: true, force: true });
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resolvePiSessionResume reports a missing file instead of masking a fresh session", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-factory-test-"));
    const sessionDir = SessionManager.create(cwd).getSessionDir();
    try {
      assert.throws(
        () => resolvePiSessionResume(cwd, "00000000-0000-0000-0000-000000000000"),
        "missing",
      );
      assert.strictEqual(resolvePiSessionResume(cwd, undefined).resumed, false);
    } finally {
      NodeFS.rmSync(sessionDir, { recursive: true, force: true });
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous legacy IDs rather than choosing arbitrary history", () => {
    const sessionId = "01a00000-1111-2222-3333-444455556666";
    const sessionDir = SessionManager.create(storageRoot).getSessionDir();
    NodeFS.writeFileSync(NodePath.join(sessionDir, `first_${sessionId}.jsonl`), "{}\n");
    NodeFS.writeFileSync(NodePath.join(sessionDir, `second_${sessionId}.jsonl`), "{}\n");
    assert.throws(() => resolvePiSessionResume(storageRoot, sessionId), "Multiple session files");
  });

  it("does not classify directory read errors as missing history", () => {
    const sessionDir = SessionManager.create(storageRoot).getSessionDir();
    NodeFS.rmdirSync(sessionDir);
    NodeFS.writeFileSync(sessionDir, "not a directory");
    assert.throws(() => resolvePiSessionResume(storageRoot, "saved-session"), "unreadable");
  });

  it("createPiSession rejects a missed resume and resumes a live session", async () => {
    const tmp = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-pi-resume-")),
    );
    const resumeCwd = NodePath.join(tmp, "project");
    const resumeAgentDir = NodePath.join(tmp, "agent");
    NodeFS.mkdirSync(NodePath.join(resumeCwd, ".pi", "extensions"), { recursive: true });
    NodeFS.mkdirSync(resumeAgentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", resumeAgentDir);
    vi.stubEnv("PI_OFFLINE", "1");
    const owned: PiSessionLike[] = [];
    try {
      const missingId = "00000000-0000-0000-0000-000000000000";
      await expect(
        createPiSession({
          cwd: resumeCwd,
          model: undefined,
          thinkingLevel: undefined,
          resumeSessionId: missingId,
        }),
      ).rejects.toThrow("missing");

      const liveId = "11a00000-1111-2222-3333-444455556666";
      const liveDir = SessionManager.create(resumeCwd).getSessionDir();
      const liveFile = NodePath.join(liveDir, `2026-08-16T00-00-00-000Z_${liveId}.jsonl`);
      NodeFS.writeFileSync(
        liveFile,
        `${JSON.stringify({ type: "session", version: 3, id: liveId, timestamp: "2026-08-16T00:00:00.000Z", cwd: resumeCwd })}\n`,
      );

      const resumed = await createPiSession({
        cwd: resumeCwd,
        model: undefined,
        thinkingLevel: undefined,
        resumeSessionId: liveId,
      });
      owned.push(resumed);
      assert.strictEqual(resumed.resumeOutcome?.resumed, true);
      assert.strictEqual(resumed.sessionId, liveId);
    } finally {
      for (const session of owned.splice(0)) await session.dispose();
      NodeFS.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
