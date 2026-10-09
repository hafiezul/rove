// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { Models } from "pi-durable-ai/models";
import {
  watchEvents,
  type AgentEvent,
  type AgentEventStream,
  type EntryRecord,
  type Registry,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  TurnId,
  type PiDurableSettings,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@rove-code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as RuntimePredicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderAdapterContract } from "../Services/ProviderAdapter.ts";
import { durableContext, openPiDurableSession } from "./PiDurableSession.ts";

export const PI_DURABLE_DRIVER = ProviderDriverKind.make("piDurable");
const ResumeCursor = Schema.Struct({ version: Schema.Literal(1) });
const decodeCursor = Schema.decodeUnknownSync(ResumeCursor);
const now = () => DateTime.formatIso(DateTime.nowUnsafe());
const textOf = (entry: EntryRecord) =>
  (entry.model ?? [])
    .flatMap((message) =>
      RuntimePredicate.isString(message.content)
        ? [message.content]
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
    .join("");
const toolType = (name: string) =>
  name === "bash"
    ? ("command_execution" as const)
    : name === "write" || name === "edit"
      ? ("file_change" as const)
      : ("dynamic_tool_call" as const);

type Session = Awaited<ReturnType<typeof openPiDurableSession>> & {
  session: ProviderSession;
  watch?: AgentEventStream;
  submissionId?: SubmissionId | undefined;
  itemId?: RuntimeItemId | undefined;
  text: string;
  messageIndex: number;
  lastError?: string | undefined;
  interrupted: boolean;
  closing: boolean;
  admission?: Promise<void>;
};

/** Separate storage per instance/thread; cursors never supply a filesystem path. */
export const makePiDurableAdapter = Effect.fn("makePiDurableAdapter")(function* (input: {
  instanceId: ProviderInstanceId;
  directory: string;
  models: Models;
  config: PiDurableSettings;
  enabled: boolean;
  environment?: NodeJS.ProcessEnv | undefined;
  registry?: Registry | undefined;
}) {
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const gate = yield* Semaphore.make(1);
  const sessions = new Map<ThreadId, Session>();
  let shuttingDown = false;
  const emit = (event: ProviderRuntimeEvent) => {
    PubSub.publishUnsafe(events, event);
  };
  const base = (ctx: Session) => ({
    eventId: EventId.make(NodeCrypto.randomUUID()),
    provider: PI_DURABLE_DRIVER,
    providerInstanceId: input.instanceId,
    threadId: ctx.session.threadId,
    createdAt: now(),
    ...(ctx.session.activeTurnId ? { turnId: ctx.session.activeTurnId } : undefined),
  });
  const request = <A>(method: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PI_DURABLE_DRIVER,
          method,
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
  const get = (threadId: ThreadId) => {
    const ctx = sessions.get(threadId);
    if (!ctx || ctx.closing) throw new Error("Pi Durable session is not active.");
    return ctx;
  };
  const toolItemId = (ctx: Session, toolCallId: string) =>
    RuntimeItemId.make(`pi-durable:${ctx.session.activeTurnId}:tool:${toolCallId}`);
  const ensureMessage = (ctx: Session) => {
    if (!ctx.itemId) {
      ctx.itemId = RuntimeItemId.make(
        `pi-durable:${ctx.session.activeTurnId}:message:${ctx.messageIndex++}`,
      );
      ctx.text = "";
      emit({
        ...base(ctx),
        type: "item.started",
        itemId: ctx.itemId,
        payload: { itemType: "assistant_message", status: "inProgress" },
      });
    }
    return ctx.itemId;
  };
  const finish = (
    ctx: Session,
    state: "completed" | "failed" | "interrupted",
    errorMessage?: string,
  ) => {
    if (!ctx.session.activeTurnId || ctx.closing) return;
    emit({
      ...base(ctx),
      type: "turn.completed",
      payload: { state, ...(errorMessage ? { errorMessage } : undefined) },
    });
    ctx.session = { ...ctx.session, status: "ready", activeTurnId: undefined, updatedAt: now() };
    ctx.submissionId = undefined;
    ctx.itemId = undefined;
    emit({ ...base(ctx), type: "session.state.changed", payload: { state: "ready" } });
  };
  const handle = (ctx: Session, event: AgentEvent) => {
    if (ctx.closing || !ctx.session.activeTurnId) return;
    switch (event.type) {
      case "message_update":
        for (const change of event.changes) {
          if (change.type === "text_delta") {
            const itemId = ensureMessage(ctx);
            ctx.text += change.delta;
            emit({
              ...base(ctx),
              type: "content.delta",
              itemId,
              payload: { streamKind: "assistant_text", delta: change.delta },
            });
          }
        }
        break;
      case "message_end": {
        if (event.entry.kind !== "pi.assistant") break;
        const message = event.entry.model?.find((value) => value.role === "assistant");
        if (message?.role !== "assistant") break;
        const text = textOf(event.entry);
        if (text && message.stopReason !== "error") {
          const itemId = ensureMessage(ctx);
          // Streamless providers and restored generations still get their final text.
          const suffix = text.startsWith(ctx.text) ? text.slice(ctx.text.length) : text;
          if (suffix)
            emit({
              ...base(ctx),
              type: "content.delta",
              itemId,
              payload: { streamKind: "assistant_text", delta: suffix },
            });
          emit({
            ...base(ctx),
            type: "item.completed",
            itemId,
            payload: { itemType: "assistant_message", status: "completed" },
          });
        } else if (ctx.itemId) {
          emit({
            ...base(ctx),
            type: "item.completed",
            itemId: ctx.itemId,
            payload: { itemType: "assistant_message", status: "failed" },
          });
        }
        ctx.itemId = undefined;
        ctx.text = "";
        ctx.lastError = message.stopReason === "error" ? message.errorMessage : undefined;
        break;
      }
      case "tool_execution_start":
        emit({
          ...base(ctx),
          type: "item.started",
          itemId: toolItemId(ctx, event.toolCallId),
          payload: {
            itemType: toolType(event.toolName),
            title: event.toolName,
            status: "inProgress",
            data: event.args,
          },
        });
        break;
      case "tool_execution_update": {
        const delta =
          event.output && ("set" in event.output ? event.output.set : event.output.append);
        if (delta)
          emit({
            ...base(ctx),
            type: "content.delta",
            itemId: toolItemId(ctx, event.toolCallId),
            payload: { streamKind: "command_output", delta },
          });
        break;
      }
      case "tool_execution_end": {
        const failed =
          event.entry?.model?.some((message) => message.role === "toolResult" && message.isError) ??
          true;
        emit({
          ...base(ctx),
          type: "item.completed",
          itemId: toolItemId(ctx, event.toolCallId),
          payload: {
            itemType: toolType(event.toolName),
            title: event.toolName,
            status: failed ? "failed" : "completed",
            ...(event.entry?.model ? { data: event.entry.model } : undefined),
          },
        });
        break;
      }
      case "submission":
        if (
          event.record.id === ctx.submissionId &&
          (event.record.status === "done" || event.record.status === "unanswered")
        ) {
          finish(
            ctx,
            ctx.interrupted
              ? "interrupted"
              : event.record.status === "done"
                ? "completed"
                : "failed",
            event.record.status === "unanswered" && !ctx.interrupted
              ? (ctx.lastError ?? event.record.reason)
              : undefined,
          );
        }
        break;
      case "snapshot":
        // Never silently append a whole snapshot onto already delivered deltas.
        // Fail this UI turn; its durable work remains resumable on the next use.
        throw new Error("Pi Durable event consumer fell behind. Resume this thread to reconnect.");
      default:
        break;
    }
  };
  const close = async (ctx: Session, cancel: boolean) => {
    if (cancel) {
      ctx.interrupted = true;
      await ctx.conversation.abort(durableContext, { background: true });
      finish(ctx, "interrupted");
    }
    ctx.closing = true;
    await ctx.watch?.stop();
    await ctx.harness.close(durableContext);
    sessions.delete(ctx.session.threadId);
  };
  const shutdown = request("shutdown", async () => {
    shuttingDown = true;
    // Unlike Stop, retiring the instance pauses execution without erasing pending work.
    await Promise.all([...sessions.values()].map((ctx) => close(ctx, false)));
  }).pipe(gate.withPermits(1), Effect.ensuring(PubSub.shutdown(events)));
  yield* Effect.addFinalizer(() => shutdown.pipe(Effect.ignore));

  const adapter: ProviderAdapterContract<ProviderAdapterRequestError> = {
    provider: PI_DURABLE_DRIVER,
    capabilities: {
      sessionModelSwitch: "in-session",
      promptlessTurnContinuation: true,
      supportsConversationRollback: false,
    },
    startSession: (start) =>
      request("startSession", async () => {
        if (!input.enabled || shuttingDown) throw new Error("Pi Durable is disabled.");
        const existing = sessions.get(start.threadId);
        if (existing) return existing.session;
        if (start.runtimeMode !== "full-access")
          throw new Error("Pi Durable currently supports full access only.");
        if (start.resumeCursor !== undefined) decodeCursor(start.resumeCursor);
        const file = NodePath.join(
          input.directory,
          `${NodeCrypto.createHash("sha256").update(start.threadId).digest("hex")}.sqlite`,
        );
        if (start.resumeCursor !== undefined) {
          try {
            await NodeFSP.access(file);
          } catch {
            throw new Error(
              "Saved Pi Durable session is missing. Restore its database or start a new thread.",
            );
          }
        }
        const opened = await openPiDurableSession({
          file,
          cwd: start.cwd ?? process.cwd(),
          models: input.models,
          environment: input.environment,
          registry: input.registry,
        });
        const agent = await opened.conversation.agent(durableContext);
        const createdAt = now();
        const ctx: Session = {
          ...opened,
          text: "",
          messageIndex: 0,
          interrupted: false,
          closing: false,
          session: {
            provider: PI_DURABLE_DRIVER,
            providerInstanceId: input.instanceId,
            threadId: start.threadId,
            status: "ready",
            runtimeMode: start.runtimeMode,
            cwd: start.cwd ?? process.cwd(),
            model:
              start.modelSelection?.model ??
              (agent.model
                ? `${agent.model.provider}/${agent.model.modelId}`
                : input.config.model || undefined),
            resumeCursor: { version: 1 },
            createdAt,
            updatedAt: createdAt,
          },
        };
        sessions.set(start.threadId, ctx);
        emit({
          ...base(ctx),
          type: "session.started",
          payload: { resume: start.resumeCursor !== undefined },
        });
        emit({ ...base(ctx), type: "session.state.changed", payload: { state: "ready" } });
        return ctx.session;
      }).pipe(gate.withPermits(1)),
    sendTurn: (turn) =>
      request("sendTurn", async () => {
        const ctx = get(turn.threadId);
        if (ctx.session.activeTurnId) throw new Error("Pi Durable is already running a turn.");
        if (turn.attachments?.length)
          throw new Error("Pi Durable attachments are not supported yet.");
        if (turn.interactionMode === "plan")
          throw new Error("Pi Durable plan mode is not supported yet.");
        const pending = (await ctx.harness.inspect(durableContext)).submissions.filter(
          (record) => record.conversationId === ctx.conversation.id && record.type === "input",
        );
        if (!turn.input && !(turn.continuation && pending.length))
          throw new Error("Provide a message or resume pending work.");
        const fallback = (await input.models.getAvailable())[0];
        const slug =
          turn.modelSelection?.model ??
          ctx.session.model ??
          (fallback ? `${fallback.provider}/${fallback.id}` : "");
        const slash = slug.indexOf("/");
        const model = input.models.getModel(slug.slice(0, slash), slug.slice(slash + 1));
        if (slash < 1 || !model) throw new Error(`Unknown Pi Durable model: ${slug}`);
        if (!(await input.models.checkAuth(model.provider)))
          throw new Error(
            `Configure an API key for ${model.provider} in this instance's environment.`,
          );
        await ctx.conversation.configure(
          { model: { provider: model.provider, modelId: model.id } },
          durableContext,
        );
        await ctx.watch?.stop();
        const turnId = TurnId.make(NodeCrypto.randomUUID());
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          model: slug,
          updatedAt: now(),
        };
        ctx.interrupted = false;
        ctx.lastError = undefined;
        ctx.messageIndex = 0;
        let admitted!: () => void;
        ctx.admission = new Promise<void>((resolve) => {
          admitted = resolve;
        });
        ctx.watch = await watchEvents(ctx.harness, ctx.conversation.id, durableContext);
        ctx.watch.start(async (batch) => {
          await ctx.admission;
          for (const event of batch) handle(ctx, event);
        });
        void ctx.watch.closed
          .then(async (end) => {
            if (end.reason !== "listener_error" || ctx.closing) return;
            finish(ctx, "failed", end.error.message);
            await close(ctx, false);
          })
          .catch((error: unknown) => {
            emit({
              ...base(ctx),
              type: "runtime.error",
              payload: {
                message: error instanceof Error ? error.message : String(error),
                class: "provider_error",
              },
            });
          });
        emit({ ...base(ctx), type: "turn.started", payload: { model: slug } });
        emit({ ...base(ctx), type: "session.state.changed", payload: { state: "running" } });
        try {
          if (turn.input) {
            const submission = await ctx.conversation.submit(
              { type: "input", content: turn.input, requestId: String(turnId) },
              durableContext,
            );
            ctx.submissionId = submission.id;
          } else {
            ctx.submissionId = pending[pending.length - 1]?.id;
            ctx.harness.resume();
          }
        } catch (error) {
          finish(ctx, "failed", error instanceof Error ? error.message : String(error));
          throw error;
        } finally {
          admitted();
        }
        return { threadId: turn.threadId, turnId, resumeCursor: { version: 1 } };
      }).pipe(gate.withPermits(1)),
    interruptTurn: (threadId, turnId) =>
      request("interruptTurn", async () => {
        const ctx = get(threadId);
        if (turnId && ctx.session.activeTurnId && turnId !== ctx.session.activeTurnId) return;
        ctx.interrupted = true;
        await ctx.conversation.abort(durableContext, { background: true });
        finish(ctx, "interrupted");
      }).pipe(gate.withPermits(1)),
    stopSession: (threadId) =>
      request("stopSession", async () => {
        const ctx = sessions.get(threadId);
        if (ctx) {
          await close(ctx, true);
          emit({
            ...base(ctx),
            type: "session.exited",
            payload: { exitKind: "graceful", recoverable: true },
          });
        }
      }).pipe(gate.withPermits(1)),
    // ProviderService calls stopAll during server shutdown. User Stop goes
    // through interruptTurn/stopSession and must cancel rather than suspend.
    stopAll: () =>
      request("stopAll", async () => {
        await Promise.all([...sessions.values()].map((ctx) => close(ctx, false)));
      }).pipe(gate.withPermits(1)),
    listSessions: () => Effect.sync(() => [...sessions.values()].map((ctx) => ctx.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) =>
      request("readThread", async () => {
        const ctx = get(threadId);
        const { entries } = await ctx.conversation.context(durableContext);
        const turns: Array<{ id: TurnId; items: EntryRecord[] }> = [];
        for (const entry of entries) {
          if (entry.kind === "pi.user")
            turns.push({ id: TurnId.make(`pi-durable-entry:${entry.id}`), items: [] });
          turns.at(-1)?.items.push(entry);
        }
        return { threadId, turns };
      }),
    rollbackThread: () =>
      request("rollbackThread", async () => {
        throw new Error("Pi Durable conversation rollback is not supported yet.");
      }),
    respondToRequest: () =>
      request("respondToRequest", async () => {
        throw new Error("Pi Durable approval dialogs are not supported yet.");
      }),
    respondToUserInput: () =>
      request("respondToUserInput", async () => {
        throw new Error("Pi Durable question dialogs are not supported yet.");
      }),
    streamEvents: Stream.fromPubSub(events),
  };
  return adapter;
});
