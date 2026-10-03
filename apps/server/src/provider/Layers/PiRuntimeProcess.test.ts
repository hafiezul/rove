// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeStreamConsumers from "node:stream/consumers";
import * as Schema from "effect/Schema";
import * as RuntimePredicate from "effect/Predicate";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { setMcpProviderSession, clearMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PiRuntimeProcess } from "./PiRuntimeProcess.ts";
import { PiExtensionLoadError, type PiSessionEventLike, type PiSessionLike } from "./PiAdapter.ts";

describe("isolated Pi instance runtime", () => {
  let root: string;
  const runtimes: PiRuntimeProcess[] = [];
  beforeEach(() => {
    root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-pi-instance-")),
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", NodePath.join(root, "server-default"));
    vi.stubEnv("PI_OFFLINE", "1");
  });
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
    vi.unstubAllEnvs();
    NodeFS.rmSync(root, { recursive: true, force: true });
  });
  function directory(name: string) {
    const agentDir = NodePath.join(root, name);
    NodeFS.mkdirSync(agentDir);
    const extension = NodePath.join(agentDir, "instance.ts");
    NodeFS.copyFileSync(new URL("./fixtures/pi-instance-extension.ts", import.meta.url), extension);
    NodeFS.writeFileSync(
      NodePath.join(agentDir, "settings.json"),
      JSON.stringify({
        extensions: [extension],
        defaultProvider: "local",
        defaultModel: name,
      }),
    );
    NodeFS.writeFileSync(
      NodePath.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: "https://example.invalid",
            api: "openai-completions",
            models: [{ id: name, reasoning: false }],
          },
        },
      }),
    );
    NodeFS.writeFileSync(
      NodePath.join(agentDir, "auth.json"),
      JSON.stringify({ local: { type: "api_key", key: `key-${name}` } }),
    );
    return agentDir;
  }
  async function create(agentDir: string) {
    const runtime = await PiRuntimeProcess.create({ agentDir });
    runtimes.push(runtime);
    return runtime;
  }
  function session(runtime: PiRuntimeProcess, agentDir: string, textGeneration = false) {
    return runtime.createSession(
      {
        cwd: root,
        agentDir,
        interactive: true,
        model: "instance-fixture/fixture",
        thinkingLevel: "off",
        resumeSessionId: undefined,
      },
      textGeneration,
    );
  }
  function nextEvent(session: PiSessionLike, predicate: (event: PiSessionEventLike) => boolean) {
    return new Promise<PiSessionEventLike>((resolve) => {
      let done = false;
      let unsubscribe: (() => void) | undefined;
      unsubscribe = session.subscribe((event) => {
        if (done || !predicate(event)) return;
        done = true;
        unsubscribe?.();
        resolve(event);
      });
      if (done) unsubscribe();
    });
  }

  it("carries quota reads across the isolated runtime without prompting", async () => {
    const agentDir = directory("quota-read");
    const runtime = await create(agentDir);
    const current = await session(runtime, agentDir);
    const before = [...current.messages];
    expect(
      await runtime.getUsageLimit("instance-fixture/fixture", "2026-10-03T00:00:00.000Z"),
    ).toEqual({ type: "unavailable" });
    expect(
      await current.getTurnUsageLimit?.("Request failed", "2026-10-03T00:00:00.000Z"),
    ).toBeNull();
    expect(current.messages).toEqual(before);
  });

  it("keeps concurrent catalogs, SDK children, and spawned children in their own agent directories", async () => {
    const a = directory("instance-a");
    const b = directory("instance-b");
    const originalEnv = process.env.PI_CODING_AGENT_DIR;
    const [first, second] = await Promise.all([create(a), create(b)]);
    const [firstModels, secondModels] = await Promise.all([
      first.getCatalogModels(),
      second.getCatalogModels(),
    ]);
    expect(firstModels.some((model) => model.slug === "local/instance-a")).toBe(true);
    expect(firstModels.some((model) => model.slug === "local/instance-b")).toBe(false);
    expect(secondModels.some((model) => model.slug === "local/instance-b")).toBe(true);
    const sessions = await Promise.all([session(first, a), session(second, b)]);
    const probes = sessions.map((current) =>
      nextEvent(current, (event) => event.type === "rove_ui_notify"),
    );
    await Promise.all(sessions.map((current) => current.prompt("/probe-instance")));
    for (const [index, probe] of (await Promise.all(probes)).entries()) {
      const agentDir = [a, b][index]!;
      expect(JSON.parse(String(probe.message))).toEqual({
        directoryAtLoad: agentDir,
        directoryNow: agentDir,
        subprocessDirectory: agentDir,
        childDirectory: agentDir,
        childModel: NodePath.basename(agentDir),
        childExtensions: ["instance.ts"],
        auth: { local: { type: "api_key", key: `key-${NodePath.basename(agentDir)}` } },
      });
      expect(sessions[index]?.sessionFile?.startsWith(NodePath.join(agentDir, "sessions"))).toBe(
        true,
      );
    }
    expect(process.env.PI_CODING_AGENT_DIR).toBe(originalEnv);
    expect(NodeFS.existsSync(originalEnv!)).toBe(false);
  });

  it("carries UI replies and preflight while a prompt is awaiting input, then mirrors history and resumes", async () => {
    const agentDir = directory("interactive");
    const runtime = await create(agentDir);
    const current = await session(runtime, agentDir);
    const question = nextEvent(current, (event) => event.type === "rove_ui_request");
    const preflight = vi.fn();
    const pending = current.prompt("/ask-instance", { preflightResult: preflight });
    const request = await question;
    expect(preflight).toHaveBeenCalledWith(true);
    expect(current.hasPendingUserInput).toBe(true);
    const confirmed = nextEvent(current, (event) => event.type === "rove_ui_notify");
    expect(await current.respondToUserInput?.(String(request.requestId), { answer: "0" })).toBe(
      true,
    );
    await pending;
    expect((await confirmed).message).toBe("confirmed");
    expect(current.hasPendingUserInput).toBe(false);
    await current.setThinkingLevel?.("high");
    expect(current.getThinkingLevel?.()).toBe("off");
    await current.prompt("hello");
    expect(current.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "interactive" }],
    });
    expect(current.getLeafId?.()).toBeDefined();
    const cursor = { sessionId: current.sessionId, sessionFile: current.sessionFile };
    await current.dispose();
    const resumed = await runtime.createSession({
      cwd: root,
      agentDir,
      model: undefined,
      thinkingLevel: undefined,
      resumeSessionId: cursor.sessionId,
      resumeSessionFile: cursor.sessionFile,
    });
    expect(resumed.sessionId).toBe(cursor.sessionId);
    expect(resumed.messages.at(-1)).toMatchObject({ role: "assistant" });
    await resumed.fork?.(null);
    expect(resumed.messages).toEqual([]);
  });

  it("discovers, runs, resumes, and removes virtual models across the process boundary", async () => {
    const agentDir = directory("routers");
    const extensions = NodePath.join(agentDir, "extensions");
    NodeFS.mkdirSync(extensions);
    NodeFS.copyFileSync(
      new URL("./fixtures/pi-extension.ts", import.meta.url),
      NodePath.join(extensions, "fixture.ts"),
    );
    const routerPath = NodePath.join(extensions, "routers.ts");
    NodeFS.copyFileSync(new URL("./fixtures/pi-virtual-models.ts", import.meta.url), routerPath);
    const runtime = await create(agentDir);
    expect(await runtime.getCatalogModels()).toContainEqual(
      expect.objectContaining({ slug: "rove-router-test/auto" }),
    );
    const current = await runtime.createSession({
      cwd: root,
      agentDir,
      interactive: true,
      model: "rove-router-test/auto",
      thinkingLevel: "off",
      resumeSessionId: undefined,
    });
    await current.prompt("hello");
    expect(current.messages.at(-1)).toMatchObject({
      role: "assistant",
      provider: "rove-extension-test",
      model: "fixture",
      content: [{ type: "text", text: "done" }],
    });
    const cursor = { sessionId: current.sessionId, sessionFile: current.sessionFile };
    await current.dispose();
    const resumed = await runtime.createSession({
      cwd: root,
      agentDir,
      model: undefined,
      thinkingLevel: undefined,
      resumeSessionId: cursor.sessionId,
      resumeSessionFile: cursor.sessionFile,
    });
    expect(resumed.getModel?.()).toMatchObject({ provider: "rove-router-test", id: "auto" });
    await resumed.dispose();
    NodeFS.unlinkSync(routerPath);
    await runtime.refreshCatalog();
    const models = await runtime.getCatalogModels();
    expect(models.some((model) => model.slug === "rove-router-test/auto")).toBe(false);
    expect(models.some((model) => model.slug === "rove-extension-test/fixture")).toBe(true);
  });

  it("shares extension model implementations with tool-free helper sessions", async () => {
    const agentDir = directory("helpers");
    const runtime = await create(agentDir);
    const helper = await session(runtime, agentDir, true);
    await helper.prompt("title");
    expect(helper.sessionFile).toBeUndefined();
    expect(helper.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "helpers" }] });
  });

  it("keeps thread-authorized Rove tools working across the process boundary", async () => {
    const requests: string[] = [];
    const headers: Array<string | undefined> = [];
    const decode = Schema.decodeUnknownSync(
      Schema.Struct({
        method: Schema.String,
        id: Schema.optional(Schema.Unknown),
      }),
    );
    const server = NodeHttp.createServer((request, response) => {
      headers.push(request.headers.authorization);
      if (request.method === "GET") {
        response.writeHead(405).end();
        return;
      }
      if (request.method === "DELETE") {
        requests.push("DELETE");
        response.writeHead(204).end();
        return;
      }
      void NodeStreamConsumers.json(request)
        .then((body) => {
          const rpc = decode(body);
          requests.push(rpc.method);
          if (rpc.id === undefined) {
            response.writeHead(202).end();
            return;
          }
          const result =
            rpc.method === "initialize"
              ? {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "fixture", version: "1" },
                }
              : rpc.method === "tools/list"
                ? {
                    tools: [
                      { name: "preview_status", inputSchema: { type: "object", properties: {} } },
                    ],
                  }
                : { content: [{ type: "text", text: "authorized tool result" }] };
          response.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": "fixture",
          });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
        })
        .catch(() => response.writeHead(500).end());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || RuntimePredicate.isString(address)) throw new Error("Missing fixture address");
    const threadId = ThreadId.make("isolated-pi-tools");
    setMcpProviderSession({
      threadId,
      environmentId: EnvironmentId.make("test"),
      providerInstanceId: ProviderInstanceId.make("pi"),
      providerSessionId: "fixture",
      endpoint: `http://127.0.0.1:${address.port}/mcp`,
      authorizationHeader: "Bearer scoped-fixture",
      capabilities: new Set(["preview"]),
    });
    try {
      const agentDir = directory("tools");
      const runtime = await create(agentDir);
      const current = await runtime.createSession({
        threadId,
        cwd: root,
        agentDir,
        model: "instance-fixture/fixture",
        thinkingLevel: "off",
        resumeSessionId: undefined,
      });
      await current.prompt("use the Rove tool");
      expect(current.messages).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          content: [{ type: "text", text: "authorized tool result" }],
        }),
      );
      await current.dispose();
      expect(requests).toContain("tools/call");
      expect(requests.filter((method) => method === "DELETE")).toHaveLength(1);
      expect(headers.every((header) => header === "Bearer scoped-fixture")).toBe(true);
    } finally {
      clearMcpProviderSession(threadId);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("allows Stop to cancel a dialog without waiting for its prompt", async () => {
    const agentDir = directory("stop-dialog");
    const current = await session(await create(agentDir), agentDir);
    const question = nextEvent(current, (event) => event.type === "rove_ui_request");
    const pending = current.prompt("/ask-instance").catch((error: unknown) => error);
    await question;
    const resolved = nextEvent(current, (event) => event.type === "rove_ui_resolved");
    await current.abort();
    await pending;
    await resolved;
    expect(current.hasPendingUserInput).toBe(false);
  });

  it("preserves extension-load errors for the adapter's recovery path", async () => {
    const agentDir = directory("broken");
    const runtime = await create(agentDir);
    const broken = NodePath.join(agentDir, "instance.ts");
    NodeFS.writeFileSync(broken, "export default () => { throw new Error('broken extension'); }");
    await expect(session(runtime, agentDir)).rejects.toBeInstanceOf(PiExtensionLoadError);
  });

  it("rejects in-flight work after an extension exits without killing another instance", async () => {
    const a = directory("exiting");
    const b = directory("surviving");
    const [first, second] = await Promise.all([create(a), create(b)]);
    const [exiting, surviving] = await Promise.all([session(first, a), session(second, b)]);
    const failed = nextEvent(exiting, (event) => event.type === "prompt_error");
    const waiting = await session(first, a);
    const question = nextEvent(waiting, (event) => event.type === "rove_ui_request");
    const pendingDialog = waiting.prompt("/ask-instance").catch((error: unknown) => error);
    await question;
    const dismissed = nextEvent(waiting, (event) => event.type === "rove_ui_resolved");
    await expect(exiting.prompt("/exit-instance")).rejects.toThrow(/exited|disconnected/);
    expect((await failed).error).toMatch(/exited|disconnected/);
    expect(await pendingDialog).toBeInstanceOf(Error);
    expect((await dismissed).answers).toEqual({});
    expect(waiting.hasPendingUserInput).toBe(false);
    await surviving.prompt("hello");
    expect(surviving.messages.at(-1)).toMatchObject({
      content: [{ type: "text", text: "surviving" }],
    });
  });

  it("terminates only its spawned process when an extension blocks shutdown", async () => {
    const agentDir = directory("blocked");
    const runtime = await create(agentDir);
    const current = await session(runtime, agentDir);
    const blocking = nextEvent(
      current,
      (event) => event.type === "rove_ui_notify" && event.message === "blocking",
    );
    const pending = current.prompt("/hang-instance").catch((error: unknown) => error);
    await blocking;
    vi.useFakeTimers();
    const disposal = runtime.dispose();
    await vi.advanceTimersByTimeAsync(4_000);
    await disposal;
    expect(await pending).toBeInstanceOf(Error);
  });

  function withCompaction(
    agentDir: string,
    compaction: { reserveTokens: number; keepRecentTokens: number },
  ) {
    const settingsPath = NodePath.join(agentDir, "settings.json");
    const settings = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"));
    NodeFS.writeFileSync(settingsPath, JSON.stringify({ ...settings, compaction }));
    return agentDir;
  }
  async function expectInstanceAlive(runtime: PiRuntimeProcess, agentDir: string) {
    const other = await session(runtime, agentDir);
    await other.prompt("hello");
    expect(other.messages.at(-1)).toMatchObject({
      content: [{ type: "text", text: NodePath.basename(agentDir) }],
    });
  }

  it("times out a stuck Stop without killing the instance's other sessions", async () => {
    const agentDir = directory("stuck-stop");
    const runtime = await create(agentDir);
    const stuck = await session(runtime, agentDir);
    const toolStarted = nextEvent(stuck, (event) => event.type === "tool_execution_start");
    void stuck.prompt("hang-tool").catch(() => {});
    await toolStarted;
    vi.useFakeTimers();
    const abort = stuck.abort().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);
    vi.useRealTimers();
    expect(await abort).toMatchObject({ message: expect.stringMatching(/abort timed out/) });
    await stuck.dispose();
    await expectInstanceAlive(runtime, agentDir);
  });

  it("lets a manual compaction outlive request deadlines", async () => {
    const agentDir = withCompaction(directory("slow-compaction"), {
      reserveTokens: 1,
      keepRecentTokens: 1,
    });
    const runtime = await create(agentDir);
    const compacting = await session(runtime, agentDir);
    await compacting.prompt("stall-compaction");
    await compacting.prompt("second");
    const started = nextEvent(compacting, (event) => event.type === "compaction_start");
    let settled = false;
    vi.useFakeTimers();
    void compacting
      .compact?.()
      .catch(() => {})
      .finally(() => {
        settled = true;
      });
    await started;
    await vi.advanceTimersByTimeAsync(61_000);
    vi.useRealTimers();
    expect(settled).toBe(false);
    await expectInstanceAlive(runtime, agentDir);
  });

  it("accepts a resumed prompt once pre-prompt compaction starts", async () => {
    const agentDir = withCompaction(directory("prompt-compaction"), {
      reserveTokens: 9_999,
      keepRecentTokens: 1,
    });
    const runtime = await create(agentDir);
    const stopped = await session(runtime, agentDir);
    await stopped.prompt("hello");
    const streaming = nextEvent(stopped, (event) => event.type === "message_start");
    const aborted = stopped.prompt("stall-stream").catch(() => {});
    await streaming;
    await stopped.abort();
    await aborted;
    const cursor = { sessionId: stopped.sessionId, sessionFile: stopped.sessionFile };
    await stopped.dispose();
    const resumed = await runtime.createSession({
      cwd: root,
      agentDir,
      interactive: true,
      model: "instance-fixture/fixture",
      thinkingLevel: "off",
      resumeSessionId: cursor.sessionId,
      resumeSessionFile: cursor.sessionFile,
    });
    const order: string[] = [];
    resumed.subscribe((e) => order.push(e.type));
    const started = nextEvent(resumed, (event) => event.type === "compaction_start");
    const preflight = vi.fn();
    vi.useFakeTimers();
    void resumed
      .prompt("next", {
        preflightResult: (success) => {
          order.push(`pre:${success}`);
          preflight(success);
        },
      })
      .catch(() => {});
    await started;
    await vi.waitFor(() => expect(preflight).toHaveBeenCalledWith(true));
    await vi.advanceTimersByTimeAsync(61_000);
    vi.useRealTimers();
    expect(order.slice(0, 2)).toEqual(["compaction_start", "pre:true"]);
    await expectInstanceAlive(runtime, agentDir);
  });

  it("accepts a long-running extension command before it finishes", async () => {
    const agentDir = directory("slow-command");
    const runtime = await create(agentDir);
    const current = await session(runtime, agentDir);
    const stalled = nextEvent(current, (event) => event.type === "rove_ui_notify");
    const preflight = vi.fn();
    vi.useFakeTimers();
    void current.prompt("/stall-instance", { preflightResult: preflight }).catch(() => {});
    await stalled;
    await vi.waitFor(() => expect(preflight).toHaveBeenCalledWith(true));
    await vi.advanceTimersByTimeAsync(61_000);
    vi.useRealTimers();
    await expectInstanceAlive(runtime, agentDir);
  });
});
