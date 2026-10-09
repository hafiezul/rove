// @effect-diagnostics nodeBuiltinImport:off - Runs inside the Pi runtime worker, outside the Effect runtime.
/**
 * Worker half of subagent observation (ADR 0002).
 *
 * Installs the agent hook in the Pi runtime worker, listens for reports from
 * the processes it marks, and watches agents that run inside the worker:
 *
 * - Rove's thread agents: every tool call runs inside an async context naming
 *   the thread and call, so processes it starts are attributed to that call.
 * - In-process agents: an agent run that starts inside a tool call belongs to
 *   that call. Extensions share the worker's Pi SDK modules, so one prototype
 *   patch sees them all.
 * - Direct model calls made by tool code, observed at pi-ai's event stream.
 *
 * Entries from all sources go through `PiAgentRoster`, which emits the rows.
 *
 * @module provider/Layers/PiAgentObserver
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

import {
  PI_AGENT_ENV,
  PI_AGENT_HOOK_GLOBAL,
  PI_AGENT_HOOK_SOURCE,
  type PiAgentEntry,
  type PiAgentHookApi,
  type PiAgentStore,
} from "./PiAgentHook.ts";
import { PiAgentRoster, type PiAgentTaskDescriptor } from "./PiAgentRoster.ts";

export interface PiAgentObserver {
  /** Start attributing work done by a thread's Pi agent to that thread. */
  registerThreadAgent(threadId: string, agent: object): void;
  dispose(): void;
}

export interface PiAgentObserverOptions {
  /** Root for per-thread transcripts; unset keeps rows live-only. */
  readonly transcriptsRoot: string | undefined;
  readonly emit: (threadId: string, task: PiAgentTaskDescriptor) => void;
  /** Directory for the hook file; defaults beside the transcripts or in tmp. */
  readonly hookDir?: string;
}

/** Writes the hook where child processes can require it; content-addressed. */
function writePiAgentHook(directory: string): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(PI_AGENT_HOOK_SOURCE)
    .digest("hex")
    .slice(0, 16);
  const file = NodePath.join(directory, `rove-agent-hook-${digest}.cjs`);
  if (NodeFS.existsSync(file)) return file;
  NodeFS.mkdirSync(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, PI_AGENT_HOOK_SOURCE);
  NodeFS.renameSync(temporary, file);
  return file;
}

/** Loads the hook into this process and returns its API. */
function loadPiAgentHook(hookPath: string): PiAgentHookApi {
  NodeModule.createRequire(hookPath)(hookPath);
  const api = (globalThis as Record<symbol, unknown>)[Symbol.for(PI_AGENT_HOOK_GLOBAL)];
  // SAFETY: The hook stores this exact API shape under its global symbol.
  return api as PiAgentHookApi;
}

function channelPath(): string {
  const name = `rove-agents-${process.pid}-${NodeCrypto.randomBytes(4).toString("hex")}`;
  // oxlint-disable-next-line rove/no-global-process-runtime -- Runs in the Pi worker, outside any Effect runtime.
  return NodeOS.platform() === "win32"
    ? `\\\\.\\pipe\\${name}`
    : NodePath.join(NodeOS.tmpdir(), `${name}.sock`);
}

function transcriptFile(root: string, threadId: string, agentId: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  return NodePath.join(root, safe(threadId), `${safe(agentId)}.jsonl`);
}

/** Entries an agent's writers persisted, for replay after a lost channel. */
function readPiAgentTranscript(root: string, threadId: string, agentId: string): PiAgentEntry[] {
  try {
    return NodeFS.readFileSync(transcriptFile(root, threadId, agentId), "utf8")
      .split("\n")
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const entry = JSON.parse(line) as PiAgentEntry;
          return entry?.v === 1 && entry.a === agentId ? [entry] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function isEntry(value: unknown): value is PiAgentEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.v === 1 &&
    typeof entry.a === "string" &&
    entry.a.length > 0 &&
    typeof entry.th === "string" &&
    entry.th.length > 0 &&
    typeof entry.k === "string" &&
    typeof entry.w === "number" &&
    typeof entry.q === "number"
  );
}

interface AgentTool {
  readonly name: string;
  execute(toolCallId: string, ...rest: unknown[]): Promise<unknown>;
}

interface AgentLike {
  readonly state: { tools: AgentTool[]; model?: { provider?: string; id?: string } };
  subscribe(listener: (event: { type: string } & Record<string, unknown>) => void): () => void;
}

const ANALYZED = Symbol.for("rove.agentObserver.patched");

export function startPiAgentObserver(options: PiAgentObserverOptions): PiAgentObserver {
  const transcriptsRoot = options.transcriptsRoot;
  const roster = new PiAgentRoster({
    emit: options.emit,
    replay: (threadId, agentId) =>
      transcriptsRoot ? readPiAgentTranscript(transcriptsRoot, threadId, agentId) : [],
  });
  const hookDir =
    options.hookDir ??
    (transcriptsRoot
      ? NodePath.join(NodePath.dirname(transcriptsRoot), "agent-hook")
      : NodePath.join(NodeOS.tmpdir(), "rove-agent-hook"));
  const hookPath = writePiAgentHook(hookDir);
  const channel = channelPath();
  process.env[PI_AGENT_ENV.channel] = channel;
  process.env[PI_AGENT_ENV.hook] = hookPath;
  if (transcriptsRoot) process.env[PI_AGENT_ENV.transcripts] = transcriptsRoot;
  const hook = loadPiAgentHook(hookPath);
  hook.setSink((entry) => roster.ingest(entry));

  const server = NodeNet.createServer((connection) => {
    const agents = new Set<string>();
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isEntry(entry)) continue;
        agents.add(entry.a);
        roster.ingest(entry);
      }
      if (buffer.length > 4 * 1024 * 1024) buffer = "";
    });
    connection.on("error", () => undefined);
    connection.on("close", () => roster.channelClosed(agents));
  });
  server.on("error", () => undefined);
  server.listen(channel);
  server.unref();

  // --- in-worker agents -----------------------------------------------------------
  const modelCallAgents = new Map<string, string>();
  const threadAgents = new WeakMap<object, { readonly th: string }>();
  const childAgents = new WeakMap<object, { readonly th: string; readonly id: string }>();
  const wrappedTools = new WeakMap<object, WeakMap<AgentTool, AgentTool>>();
  const wrappedLists = new WeakMap<object, { source: AgentTool[]; wrapped: AgentTool[] }>();

  const ownerContext = (agent: object): Pick<PiAgentStore, "th" | "p"> | undefined => {
    const thread = threadAgents.get(agent);
    if (thread) return { th: thread.th };
    const child = childAgents.get(agent);
    return child ? { th: child.th, p: child.id } : undefined;
  };

  const wrapTool = (agent: object, tool: AgentTool): AgentTool => {
    let cache = wrappedTools.get(agent);
    if (!cache) {
      cache = new WeakMap();
      wrappedTools.set(agent, cache);
    }
    const existing = cache.get(tool);
    if (existing) return existing;
    // A full own-property copy, so spreads and prototype methods keep working.
    const wrapped = Object.create(
      Object.getPrototypeOf(tool) as object | null,
      Object.getOwnPropertyDescriptors(tool),
    ) as AgentTool & { execute: AgentTool["execute"] };
    Object.defineProperty(wrapped, "execute", {
      configurable: true,
      enumerable: true,
      writable: true,
      value(toolCallId: string, ...rest: unknown[]) {
        const owner = ownerContext(agent);
        if (!owner) return tool.execute.call(tool, toolCallId, ...rest);
        const store: PiAgentStore = {
          th: owner.th,
          phase: "tool",
          t: toolCallId,
          n: tool.name,
          ...(owner.p ? { p: owner.p } : undefined),
        };
        return Promise.resolve(
          hook.run(store, () => tool.execute.call(tool, toolCallId, ...rest)),
        ).finally(() => {
          modelCallAgents.delete(`${owner.th}\u0000${toolCallId}`);
          roster.toolEnded(owner.th, toolCallId);
        });
      },
    });
    cache.set(tool, wrapped);
    return wrapped;
  };

  /** Every read of `agent.state.tools` returns call-attributing wrappers. */
  const wrapStateTools = (agent: AgentLike) => {
    const state = agent.state as Record<PropertyKey, unknown>;
    if (state[ANALYZED]) return;
    let owner: object | undefined = state;
    let descriptor: PropertyDescriptor | undefined;
    while (owner && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(owner, "tools");
      owner = Object.getPrototypeOf(owner) as object | undefined;
    }
    if (!descriptor) return;
    const read = descriptor.get
      ? () => descriptor.get!.call(state) as AgentTool[]
      : () => descriptor.value as AgentTool[];
    let stored = descriptor.get ? undefined : (descriptor.value as AgentTool[]);
    Object.defineProperty(state, "tools", {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      get() {
        const source = descriptor.get ? read() : (stored ?? []);
        const cached = wrappedLists.get(agent);
        if (cached?.source === source) return cached.wrapped;
        const wrapped = source.map((tool) => wrapTool(agent, tool));
        wrappedLists.set(agent, { source, wrapped });
        return wrapped;
      },
      set(next: AgentTool[]) {
        if (descriptor.set) descriptor.set.call(state, next);
        else stored = next.slice();
      },
    });
    state[ANALYZED] = true;
  };

  const modelLabel = (model: { provider?: string; id?: string } | undefined) =>
    model?.id ? (model.provider ? `${model.provider}/${model.id}` : model.id) : undefined;

  /** An agent run started inside a tool call: report it as that call's agent. */
  const adoptChildAgent = (agent: AgentLike, outer: PiAgentStore) => {
    const existing = childAgents.get(agent);
    if (existing) return existing;
    const child = { th: outer.th, id: hook.newId() };
    childAgents.set(agent, child);
    const report = (kind: PiAgentEntry["k"], fields?: Partial<PiAgentEntry>) =>
      hook.emit(child.id, child.th, kind, fields);
    report("start", {
      src: "agent",
      parent: { th: outer.th, t: outer.t, n: outer.n, p: outer.p },
      pid: process.pid,
    });
    const model = modelLabel(agent.state.model);
    if (model) report("meta", { model });
    let sawTask = false;
    agent.subscribe((event) => {
      try {
        switch (event.type) {
          case "agent_start":
            report("busy");
            return;
          case "agent_end":
            report("idle");
            return;
          case "message_end": {
            const message = event.message as Record<string, unknown> | undefined;
            const text = hook.messageText(message).trim();
            if (message?.role === "user") {
              if (text) report(sawTask ? "user" : "task", { text: text.slice(0, 16_384) });
              sawTask = true;
            } else if (message?.role === "assistant") {
              const usage = message.usage as Record<string, number> | undefined;
              report("text", {
                ...(text ? { text: text.slice(0, 16_384) } : undefined),
                ...(typeof message.stopReason === "string"
                  ? { stop: message.stopReason }
                  : undefined),
                ...(typeof message.errorMessage === "string"
                  ? { error: message.errorMessage.slice(0, 1_000) }
                  : undefined),
                ...(typeof message.provider === "string" && typeof message.model === "string"
                  ? { model: `${message.provider}/${message.model}` }
                  : undefined),
              });
              if (usage)
                report("usage", {
                  in: usage.input ?? 0,
                  outTok: usage.output ?? 0,
                  cr: usage.cacheRead ?? 0,
                  cw: usage.cacheWrite ?? 0,
                });
            }
            return;
          }
          case "tool_execution_start": {
            const target = hook.toolTarget(event.args);
            report("tool", {
              id: String(event.toolCallId ?? hook.newId()),
              name: String(event.toolName ?? "tool"),
              ...(target ? { target } : undefined),
            });
            return;
          }
          case "tool_execution_end": {
            const out = hook.messageText(event.result).trim();
            report("toolEnd", {
              id: String(event.toolCallId ?? ""),
              ...(event.isError === true ? { isError: true } : undefined),
              ...(out ? { out: out.slice(0, 4_096) } : undefined),
            });
            return;
          }
        }
      } catch {
        // Observation must never break the observed agent.
      }
    });
    wrapStateTools(agent);
    return child;
  };

  let agentPatched = false;
  const patchAgentClass = (agent: object) => {
    if (agentPatched) return;
    let proto = Object.getPrototypeOf(agent) as Record<string, unknown> | null;
    while (proto && !Object.hasOwn(proto, "runWithLifecycle"))
      proto = Object.getPrototypeOf(proto) as Record<string, unknown> | null;
    const original = proto?.runWithLifecycle;
    if (!proto || typeof original !== "function") return;
    agentPatched = true;
    proto.runWithLifecycle = function (this: AgentLike, ...args: unknown[]) {
      const run = () => original.apply(this, args);
      const thread = threadAgents.get(this);
      if (thread) return hook.run({ th: thread.th, phase: "loop" }, run);
      const outer = hook.store();
      const child = outer?.phase === "tool" ? adoptChildAgent(this, outer) : childAgents.get(this);
      if (child) return hook.run({ th: child.th, phase: "loop", p: child.id }, run);
      return run();
    };
  };

  // --- direct model calls ---------------------------------------------------------
  const streamProto = AssistantMessageEventStream.prototype as unknown as Record<
    PropertyKey,
    unknown
  >;
  const originalPush = streamProto.push as (this: object, event: unknown) => void;
  const observedStreams = new WeakMap<object, PiAgentStore | null>();
  if (!streamProto[ANALYZED] && typeof originalPush === "function") {
    streamProto[ANALYZED] = true;
    streamProto.push = function (this: object, event: unknown) {
      try {
        let store = observedStreams.get(this);
        if (store === undefined) {
          store = hook.store() ?? null;
          observedStreams.set(this, store);
        }
        const record = event as {
          type?: string;
          message?: Record<string, unknown>;
          error?: Record<string, unknown>;
        };
        if (
          store?.phase === "tool" &&
          store.t &&
          (record?.type === "done" || record?.type === "error")
        ) {
          const key = `${store.th}\u0000${store.t}`;
          let agentId = modelCallAgents.get(key);
          if (!agentId) {
            agentId = hook.newId();
            modelCallAgents.set(key, agentId);
            hook.emit(agentId, store.th, "start", {
              src: "model",
              parent: { th: store.th, t: store.t, n: store.n, p: store.p },
              pid: process.pid,
            });
          }
          const message = record.type === "done" ? record.message : record.error;
          const text = hook.messageText(message).trim();
          const usage = message?.usage as Record<string, number> | undefined;
          hook.emit(agentId, store.th, "text", {
            ...(text ? { text: text.slice(0, 16_384) } : undefined),
            ...(typeof message?.stopReason === "string" ? { stop: message.stopReason } : undefined),
            ...(typeof message?.errorMessage === "string"
              ? { error: String(message.errorMessage).slice(0, 1_000) }
              : undefined),
            ...(typeof message?.provider === "string" && typeof message?.model === "string"
              ? { model: `${message.provider}/${message.model}` }
              : undefined),
          });
          if (usage)
            hook.emit(agentId, store.th, "usage", {
              in: usage.input ?? 0,
              outTok: usage.output ?? 0,
              cr: usage.cacheRead ?? 0,
              cw: usage.cacheWrite ?? 0,
            });
        }
      } catch {
        // Observation must never break the stream.
      }
      return originalPush.call(this, event);
    };
  }

  return {
    registerThreadAgent(threadId, agent) {
      threadAgents.set(agent, { th: threadId });
      patchAgentClass(agent);
      // SAFETY: Pi thread sessions expose pi-agent-core's Agent here.
      wrapStateTools(agent as AgentLike);
    },
    dispose() {
      server.close();
      // oxlint-disable-next-line rove/no-global-process-runtime -- Runs in the Pi worker, outside any Effect runtime.
      if (NodeOS.platform() !== "win32") NodeFS.rmSync(channel, { force: true });
    },
  };
}
