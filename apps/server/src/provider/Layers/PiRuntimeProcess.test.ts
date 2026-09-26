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
      const unsubscribe = session.subscribe((event) => {
        if (predicate(event)) {
          unsubscribe();
          resolve(event);
        }
      });
    });
  }

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
});
