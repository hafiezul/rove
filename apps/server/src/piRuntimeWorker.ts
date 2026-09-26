// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off - Orphan cleanup bounds extension shutdown outside the server runtime.
import { PiCatalogHost } from "./provider/Layers/PiCatalogHost.ts";
import { createPiSession } from "./provider/Layers/PiSessionFactory.ts";
import { PiExtensionLoadError, type PiSessionLike } from "./provider/Layers/PiAdapter.ts";
import { registerPiBundledOAuthFlows } from "./provider/Drivers/PiOAuth.ts";
import {
  compactPiMessageUpdate,
  compactPiToolProgress,
} from "./provider/Layers/PiRuntimeEvents.ts";
import { piRecord } from "./provider/Layers/PiSubagentDialects.ts";
import type {
  PiArrayPatch,
  PiRuntimeCalls,
  PiRuntimeMessage,
  PiRuntimeRequest,
  PiSessionUpdate,
} from "./provider/Layers/PiRuntimeProtocol.ts";

function arrayPatch<T>(
  previous: ReadonlyArray<T>,
  current: ReadonlyArray<T>,
): PiArrayPatch<T> | undefined {
  let from = 0;
  while (from < previous.length && from < current.length && previous[from] === current[from])
    from++;
  return from === previous.length && from === current.length
    ? undefined
    : { from, items: current.slice(from) };
}

/** Snapshot only at lifecycle boundaries, and send only changed suffixes of history. */
function sessionUpdates(session: PiSessionLike) {
  let messages: PiSessionLike["messages"] = [];
  let entries: ReturnType<NonNullable<PiSessionLike["getEntries"]>> = [];
  let branch: ReturnType<NonNullable<PiSessionLike["getBranch"]>> = [];
  return (full: boolean): PiSessionUpdate => {
    const state = {
      isStreaming: session.isStreaming,
      hasPendingUserInput: session.hasPendingUserInput ?? false,
      isPreparingPrompt: session.isPreparingPrompt ?? false,
      leafId: session.getLeafId?.(),
    };
    if (!full) return { state };
    const nextMessages = session.messages;
    const nextEntries = session.getEntries?.() ?? [];
    const nextBranch = session.getBranch?.() ?? [];
    const update: PiSessionUpdate = {
      state: {
        ...state,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        resumeOutcome: session.resumeOutcome,
        modelFallbackMessage: session.modelFallbackMessage,
        autoCompactionEnabled: session.autoCompactionEnabled,
        thinkingLevel: session.getThinkingLevel?.(),
        model: session.getModel?.(),
        stats: session.getSessionStats?.(),
      },
      messages: arrayPatch(messages, nextMessages),
      entries: arrayPatch(entries, nextEntries),
      branch: arrayPatch(branch, nextBranch),
    };
    // SDK arrays can be appended in place. Retain identities, not the mutable containers.
    messages = [...nextMessages];
    entries = [...nextEntries];
    branch = [...nextBranch];
    return update;
  };
}

export async function runPiRuntimeWorker(): Promise<void> {
  if (!process.send) throw new Error("Pi runtime requires a parent IPC channel.");
  registerPiBundledOAuthFlows();
  let host: PiCatalogHost | undefined;
  let closing = false;
  let pendingSends = 0;
  const sessions = new Map<
    number,
    { session: PiSessionLike; update: ReturnType<typeof sessionUpdates>; unsubscribe: () => void }
  >();
  const initializing = new Set<Promise<unknown>>();
  const post = (message: PiRuntimeMessage) => {
    if (!process.connected) return;
    // A stalled parent must not let streaming progress grow an unbounded IPC queue.
    if (++pendingSends > 4096) process.exit(1);
    process.send!(message, (error: Error | null) => {
      pendingSends--;
      if (error) process.exit(1);
    });
  };
  const getHost = () => {
    if (!host) throw new Error("Pi catalog is not initialized.");
    return host;
  };
  const getSession = (key: number) => {
    const value = sessions.get(key);
    if (!value) throw new Error("Pi session is closed.");
    return value;
  };
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () =>
    (shutdownPromise ??= (async () => {
      closing = true;
      await Promise.allSettled(initializing);
      await Promise.allSettled(
        [...sessions.values()].map(async ({ session, unsubscribe }) => {
          unsubscribe();
          await session.dispose();
        }),
      );
      sessions.clear();
      await host?.dispose();
    })());

  async function execute(
    request: PiRuntimeRequest,
  ): Promise<PiRuntimeCalls[keyof PiRuntimeCalls]["result"]> {
    if (closing) throw new Error("Pi instance is closing.");
    switch (request.method) {
      case "initialize": {
        if (host) throw new Error("Pi instance is already initialized.");
        host = await PiCatalogHost.create(request.args[0]);
        host.onChange(() => post({ type: "catalogChanged" }));
        return;
      }
      case "getCatalog":
        return getHost().getCatalog();
      case "refreshCatalog":
        return getHost().refreshCatalog();
      case "getCatalogModels":
        return getHost().getCatalogModels(...request.args);
      case "getExtensionSlashCommands":
        return getHost().getExtensionSlashCommands();
      case "createSession": {
        const [key, input, textGeneration, mcp] = request.args;
        const compatibility = getHost().observeThreadUI();
        let session: PiSessionLike;
        try {
          session = await createPiSession(
            input,
            textGeneration
              ? {
                  compatibility,
                  mcpProviderSession: mcp,
                  extensions: false,
                  textGeneration: true,
                  modelRuntime: getHost().getModelRuntime(),
                }
              : { compatibility, mcpProviderSession: mcp },
          );
        } catch (error) {
          compatibility.dispose();
          throw error;
        }
        const update = sessionUpdates(session);
        let lastProgress = -Infinity;
        const customMessages = new WeakSet<object>();
        const unsubscribe = session.subscribe((event) => {
          // Object identities do not survive IPC. Suppress repeated custom transcript
          // notifications here, before the adapter's identity-based deduplication.
          const message = piRecord(event.message);
          if (event.type === "message_end" && message?.role === "custom")
            customMessages.add(message);
          if (event.type === "agent_end" && Array.isArray(event.messages)) {
            event = {
              ...event,
              messages: event.messages.filter((entry) => {
                const custom = piRecord(entry);
                if (custom?.role !== "custom") return true;
                if (customMessages.has(custom)) return false;
                customMessages.add(custom);
                return true;
              }),
            };
          }
          if (event.type === "tool_execution_update") {
            const now = performance.now();
            if (now - lastProgress < 500) return;
            lastProgress = now;
            event = compactPiToolProgress(event);
          }
          if (event.type === "message_update") event = compactPiMessageUpdate(event);
          else
            post({
              type: "state",
              key,
              update: update(
                event.type === "message_end" ||
                  event.type === "agent_settled" ||
                  event.type === "compaction_end" ||
                  event.type === "prompt_error",
              ),
            });
          post({ type: "event", key, event });
        });
        sessions.set(key, { session, update, unsubscribe });
        post({ type: "state", key, update: update(true) });
        return;
      }
      case "shutdown":
        await shutdown();
        return;
      default: {
        const key = request.args[0];
        const { session, update, unsubscribe } = getSession(key);
        try {
          switch (request.method) {
            case "prompt": {
              const prompt = session.prompt(request.args[1], {
                ...request.args[2],
                preflightResult: (success) => {
                  post({ type: "state", key, update: update(false) });
                  post({ type: "preflight", id: request.id, success });
                },
              });
              post({ type: "state", key, update: update(false) });
              return await prompt;
            }
            case "followUp":
              return await session.followUp(request.args[1]);
            case "abort":
              return await session.abort();
            case "compact":
              return await session.compact?.();
            case "setModel":
              return await session.setModel?.(request.args[1]);
            case "setThinkingLevel":
              return await session.setThinkingLevel?.(request.args[1]);
            case "respondToUserInput":
              return await session.respondToUserInput?.(request.args[1], request.args[2]);
            case "fork":
              return await session.fork?.(request.args[1]);
            case "dispose": {
              unsubscribe();
              sessions.delete(key);
              return await session.dispose();
            }
          }
        } finally {
          if (sessions.has(key)) post({ type: "state", key, update: update(true) });
        }
      }
    }
  }

  await new Promise<void>((resolve) => {
    process.on("message", (request: PiRuntimeRequest) => {
      // Do not serialize prompts: Stop, steering, and dialog responses must run while a prompt awaits.
      const operation = execute(request);
      if (request.method === "createSession" || request.method === "initialize")
        initializing.add(operation);
      void operation
        .then(
          (result) => {
            post({ type: "reply", id: request.id, result });
            if (request.method === "shutdown") {
              process.disconnect?.();
              resolve();
            }
          },
          (error: unknown) =>
            post({
              type: "reply",
              id: request.id,
              error: {
                message: error instanceof Error ? error.message : String(error),
                ...(error instanceof PiExtensionLoadError
                  ? { failedExtensionPaths: error.failedExtensionPaths }
                  : undefined),
              },
            }),
        )
        .finally(() => initializing.delete(operation));
    });
    process.once("disconnect", () => {
      // Bound orphan cleanup even if an extension never resolves its shutdown hook.
      const timer = setTimeout(() => process.exit(0), 4_000);
      timer.unref();
      void shutdown().finally(() => {
        clearTimeout(timer);
        process.exit(0);
      });
    });
  });
}
