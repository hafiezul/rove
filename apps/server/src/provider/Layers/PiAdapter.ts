/**
 * PiAdapter — `ProviderAdapterShape` implementation backed by the Pi SDK
 * (`@earendil-works/pi-coding-agent`) running in-process. See
 * docs/adr/0001-pi-provider-uses-sdk-in-process.md for why this is not a
 * subprocess adapter.
 *
 * One Pi `AgentSession` per Rove thread. Sessions run with the user's global
 * Pi config (auth, models, skills, prompt templates) but no extensions — the
 * "sterile Pi" shape from CONTEXT.md — because extension UI dialogs cannot be
 * answered headlessly yet. Rollback is fork-as-rollback: Pi sessions are
 * trees, so rolling back N turns forks the session at the entry that precedes
 * them and the fork becomes the thread's live session.
 *
 * The SDK surface is injected as `PiSdkLike` so tests can drive the adapter
 * with a fake in-process Pi instead of real LLM calls.
 *
 * @module provider/Layers/PiAdapter
 */
import {
  EventId,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ThreadId,
  type ToolLifecycleItemType,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { PI_THINKING_DESCRIPTOR_ID } from "./PiProvider.ts";

import { ProviderAdapterRequestError } from "../Errors.ts";
import type {
  ProviderAdapterContract,
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import * as RuntimePredicate from "effect/Predicate";

/**
 * Translate the composer's `$name` skill token into Pi's `/skill:name`
 * invocation form. The composer inserts `$name ` for skill picks (a shared,
 * provider-agnostic convention — Claude Code interprets `$name` itself), but
 * the Pi SDK only expands `/skill:name args` in `prompt`/`steer`/`followUp`.
 * Only a leading token is translated, matching how the composer inserts
 * picks at the start of the prompt; `$` anywhere else is literal text.
 */
const PI_SKILL_TOKEN_PATTERN = /^\$([^\s]+)(?:\s+|$)/;

export function translatePiSkillToken(text: string): string {
  const match = PI_SKILL_TOKEN_PATTERN.exec(text);
  if (match === null) {
    return text;
  }
  const rest = text.slice(match[0].length);
  return rest.length > 0 ? `/skill:${match[1]} ${rest}` : `/skill:${match[1]}`;
}

/** Map Pi tool names to Rove's canonical lifecycle item types. */
function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  // read, grep, find, ls and anything unrecognized render as a generic tool call
  return "dynamic_tool_call";
}

const PROVIDER = ProviderDriverKind.make("pi");

function isPromiseWithCatch(
  value: unknown,
): value is { catch: (onRejected: () => void) => unknown } {
  if (!RuntimePredicate.isObjectOrArray(value) || Array.isArray(value) || !("catch" in value)) {
    return false;
  }
  return RuntimePredicate.isFunction(value.catch);
}

/**
 * Narrow slice of the Pi SDK session the adapter relies on. `setModel` takes
 * the composer slug (`provider/model-id`) and resolves it against the user's
 * catalog; `setThinkingLevel` clamps to model capabilities inside the SDK.
 */
export interface PiSessionLike {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  readonly messages: ReadonlyArray<unknown>;
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  setModel?(model: string): Promise<void>;
  setThinkingLevel?(level: string): void;
  subscribe(listener: (event: PiSessionEventLike) => void): () => void;
  getEntries?(): ReadonlyArray<{
    id: string;
    parentId?: string | undefined;
    message?: { role?: string } | undefined;
  }>;
  getLeafId?(): string | undefined;
  fork?(entryId: string): void;
}
import type { Json as SchemaJson } from "effect/Schema";

/** Pi SDK `AgentSessionEvent` — typed loosely here so the fake can drive it. */
export interface PiSessionEventLike {
  readonly type: string;
  readonly [key: string]: SchemaJson;
}

export interface PiCreateSessionInput {
  readonly cwd: string;
  readonly model: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly resumeSessionFile: string | undefined;
}

export interface PiAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId | undefined;
  /**
   * Builds a Pi session (real SDK in the driver, a fake in tests). Required:
   * the adapter never talks to the SDK directly.
   */
  readonly createSession: (input: PiCreateSessionInput) => Promise<PiSessionLike>;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  readonly session: PiSessionLike;
  readonly cwd: string;
  activeTurnId: TurnId | undefined;
  /** Deferred error from a failed assistant message, held until we know whether Pi will auto-retry. */
  pendingTurnError: string | undefined;
  unsubscribe: () => void;
}

export interface PiAdapterContract extends ProviderAdapterContract<ProviderAdapterRequestError> {}

/**
 * The composer dispatches the thread's model selection on every turn, but it
 * is only ours when routed to this instance — a selection addressed to a
 * different provider instance must not reconfigure the Pi session.
 */
function ownModelSelection(
  input: { readonly modelSelection?: ProviderSendTurnInput["modelSelection"] },
  boundInstanceId: ProviderInstanceId | undefined,
): ProviderSendTurnInput["modelSelection"] | undefined {
  return input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
}

/** Model slug from a routed selection, when it is a non-empty string. */
function selectedModelSlug(
  modelSelection: ProviderSendTurnInput["modelSelection"] | undefined,
): string | undefined {
  const model = modelSelection?.model;
  return RuntimePredicate.isString(model) && model.trim().length > 0 ? model : undefined;
}

export function makePiAdapter(
  piSettings: PiSettings,
  options: PiAdapterLiveOptions,
): Effect.Effect<PiAdapterContract, never, Crypto.Crypto> {
  return Effect.gen(function* () {
    const boundInstanceId = options.instanceId;
    const crypto = yield* Crypto.Crypto;
    const runFork = Effect.runForkWith(yield* Effect.context<Crypto.Crypto>());
    const createSession = options.createSession;

    const sessions = new Map<ThreadId, PiSessionContext>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = crypto.randomUUIDv4.pipe(
      Effect.map((id) => EventId.make(id)),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "eventId",
            detail: "Failed to mint a Pi runtime event id.",
            cause,
          }),
      ),
    );
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const providerSessionFor = (
      ctx: PiSessionContext,
      status: ProviderSession["status"],
    ): Effect.Effect<ProviderSession> =>
      Effect.map(DateTime.now, (now) => {
        const createdAt = DateTime.formatIso(now);
        return {
          provider: PROVIDER,
          ...(boundInstanceId !== undefined ? { providerInstanceId: boundInstanceId } : undefined),
          status,
          runtimeMode: "full-access",
          cwd: ctx.cwd,
          threadId: ctx.threadId,
          resumeCursor: { sessionId: ctx.session.sessionId },
          ...(ctx.activeTurnId !== undefined ? { activeTurnId: ctx.activeTurnId } : undefined),
          createdAt,
          updatedAt: createdAt,
        } satisfies ProviderSession;
      });

    const getSession = (threadId: ThreadId, method: string) =>
      Effect.suspend(() => {
        const ctx = sessions.get(threadId);
        return ctx
          ? Effect.succeed(ctx)
          : Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method,
                detail: `No active Pi session for thread ${threadId}.`,
              }),
            );
      });

    const handleSdkEvent = (
      ctx: PiSessionContext,
      event: PiSessionEventLike,
    ): Effect.Effect<void, never, Crypto.Crypto> =>
      Effect.gen(function* () {
        const stamp = yield* makeEventStamp();
        const base = {
          ...stamp,
          provider: PROVIDER,
          ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : undefined),
          threadId: ctx.threadId,
        } as const;

        switch (event.type) {
          case "turn_start": {
            // Pi turn ids are positional; Rove mints its own turn id at
            // turn.started, so nothing to correlate here yet. A retry also
            // emits turn_start — clear any stale deferred error from the
            // previous attempt.
            ctx.pendingTurnError = undefined;
            if (ctx.activeTurnId !== undefined) {
              yield* offerRuntimeEvent({
                ...base,
                type: "turn.started",
                turnId: ctx.activeTurnId,
                payload: {},
              });
            }
            return;
          }
          case "message_update": {
            const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
              assistantEvent = event.assistantMessageEvent as
                | { type?: string; delta?: string; contentIndex?: number }
                | undefined;
            if (
              assistantEvent?.type === "text_delta" &&
              RuntimePredicate.isString(assistantEvent.delta)
            ) {
              yield* offerRuntimeEvent({
                ...base,
                type: "content.delta",
                ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : undefined),
                payload: {
                  streamKind: "assistant_text",
                  delta: assistantEvent.delta,
                  ...(RuntimePredicate.isNumber(assistantEvent.contentIndex)
                    ? { contentIndex: assistantEvent.contentIndex }
                    : undefined),
                },
              });
            } else if (
              assistantEvent?.type === "thinking_delta" &&
              RuntimePredicate.isString(assistantEvent.delta)
            ) {
              yield* offerRuntimeEvent({
                ...base,
                type: "content.delta",
                ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : undefined),
                payload: {
                  streamKind: "reasoning_text",
                  delta: assistantEvent.delta,
                  ...(RuntimePredicate.isNumber(assistantEvent.contentIndex)
                    ? { contentIndex: assistantEvent.contentIndex }
                    : undefined),
                },
              });
            }
            return;
          }
          case "message_end": {
            const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
              message = event.message as
                | { role?: string; stopReason?: string; errorMessage?: string }
                | undefined;
            if (
              message?.role === "assistant" &&
              message.stopReason === "error" &&
              ctx.activeTurnId !== undefined
            ) {
              // Don't emit turn.completed yet — Pi may auto-retry transient
              // errors (502, 503, 429, timeouts). The error is deferred until
              // agent_end tells us whether the retry loop will run.
              ctx.pendingTurnError =
                RuntimePredicate.isString(message.errorMessage) &&
                message.errorMessage.trim().length > 0
                  ? message.errorMessage
                  : "Pi assistant response failed.";
            }
            return;
          }
          case "tool_execution_start": {
            yield* offerRuntimeEvent({
              ...base,
              type: "item.started",
              ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : undefined),
              itemId: RuntimeItemId.make(String(event.toolCallId ?? "")),
              payload: {
                itemType: toToolLifecycleItemType(String(event.toolName ?? "")),
                status: "inProgress",
                title: String(event.toolName ?? "tool"),
                data: event.args,
              },
            });
            return;
          }
          case "tool_execution_end": {
            yield* offerRuntimeEvent({
              ...base,
              type: "item.completed",
              ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : undefined),
              itemId: RuntimeItemId.make(String(event.toolCallId ?? "")),
              payload: {
                itemType: toToolLifecycleItemType(String(event.toolName ?? "")),
                status: event.isError === true ? "failed" : "completed",
                title: String(event.toolName ?? "tool"),
                data: event.result,
              },
            });
            return;
          }
          case "agent_end": {
            const willRetry = event.willRetry === true;
            if (
              !willRetry &&
              ctx.pendingTurnError !== undefined &&
              ctx.activeTurnId !== undefined
            ) {
              // Terminal error — Pi is not retrying. Emit the deferred failure.
              const turnId = ctx.activeTurnId;
              const errorMessage = ctx.pendingTurnError;
              ctx.activeTurnId = undefined;
              ctx.pendingTurnError = undefined;
              yield* offerRuntimeEvent({
                ...base,
                type: "turn.completed",
                turnId,
                payload: { state: "failed", errorMessage },
              });
            }
            return;
          }
          case "auto_retry_end": {
            // A successful retry means the pending error is stale — clear it.
            if (event.success === true) {
              ctx.pendingTurnError = undefined;
            }
            return;
          }
          case "agent_settled": {
            if (ctx.activeTurnId !== undefined) {
              const turnId = ctx.activeTurnId;
              ctx.activeTurnId = undefined;
              ctx.pendingTurnError = undefined;
              yield* offerRuntimeEvent({
                ...base,
                type: "turn.completed",
                turnId,
                payload: { state: "completed" },
              });
            }
            return;
          }
          default:
            // Deferred Pi events (compaction_*, auto_retry_*, queue_update,
            // extension_error, …) are intentionally dropped for v1. See the
            // carry-forward list in the provider design notes.
            return;
        }
      }).pipe(
        // A listener that throws would tear down the SDK's event dispatch;
        // swallow translation failures — the stream must stay alive.
        Effect.orElseSucceed(() => undefined),
      );

    const startSession: PiAdapterContract["startSession"] = (input: ProviderSessionStartInput) =>
      Effect.gen(function* () {
        const existing = sessions.get(input.threadId);
        if (existing) {
          return yield* providerSessionFor(existing, "ready");
        }

        const cwd = input.cwd ?? process.cwd();
        const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
          resumeCursor = input.resumeCursor as { sessionId?: string } | undefined;
        // A thread-scoped model selection (the composer's pick at thread
        // creation) wins over the instance-level settings defaults.
        const modelSelection = ownModelSelection(input, boundInstanceId);
        const session = yield* Effect.tryPromise({
          try: () =>
            createSession({
              cwd,
              model:
                selectedModelSlug(modelSelection) ??
                (piSettings.model.trim().length > 0 ? piSettings.model : undefined),
              thinkingLevel:
                getModelSelectionStringOptionValue(modelSelection, PI_THINKING_DESCRIPTOR_ID) ??
                piSettings.thinkingLevel ??
                undefined,
              resumeSessionFile: resumeCursor?.sessionId,
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "startSession",
              detail: `Failed to create Pi session in ${cwd}.`,
              cause,
            }),
        });

        const ctx: PiSessionContext = {
          threadId: input.threadId,
          session,
          cwd,
          activeTurnId: undefined,
          pendingTurnError: undefined,
          unsubscribe: () => {},
        };
        ctx.pendingTurnError = undefined;
        ctx.unsubscribe = session.subscribe((event) => {
          runFork(handleSdkEvent(ctx, event));
        });
        sessions.set(input.threadId, ctx);

        yield* offerRuntimeEvent({
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : undefined),
          threadId: input.threadId,
          type: "session.started",
          payload: { resume: resumeCursor?.sessionId !== undefined },
        });
        yield* offerRuntimeEvent({
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : undefined),
          threadId: input.threadId,
          type: "session.state.changed",
          payload: { state: "ready", reason: "Pi session ready" },
        });

        return yield* providerSessionFor(ctx, "ready");
      });

    const sendTurn: PiAdapterContract["sendTurn"] = (input: ProviderSendTurnInput) =>
      Effect.gen(function* () {
        const ctx = yield* getSession(input.threadId, "sendTurn");
        const rawText = input.input?.trim();
        if (rawText === undefined || rawText.length === 0) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: "Pi turns require text input.",
          });
        }

        const turnId = TurnId.make(
          yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "sendTurn",
                  detail: "Failed to mint a Pi turn id.",
                  cause,
                }),
            ),
          ),
        );
        ctx.activeTurnId = turnId;
        const text = translatePiSkillToken(rawText);

        // Apply the composer's per-thread model options before prompting.
        // Pi sessions support in-session model switches, so a changed picker
        // value takes effect on the very next turn of the same thread.
        const modelSelection = ownModelSelection(input, boundInstanceId);
        if (modelSelection !== undefined) {
          const modelSlug = selectedModelSlug(modelSelection);
          const thinkingLevel = getModelSelectionStringOptionValue(
            modelSelection,
            PI_THINKING_DESCRIPTOR_ID,
          );
          yield* Effect.tryPromise({
            try: async () => {
              if (ctx.session.setModel !== undefined && modelSlug !== undefined) {
                await ctx.session.setModel(modelSlug);
              }
              if (ctx.session.setThinkingLevel !== undefined && thinkingLevel !== undefined) {
                ctx.session.setThinkingLevel(thinkingLevel);
              }
            },
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn",
                detail: `Failed to apply model selection to Pi session ${ctx.session.sessionId}.`,
                cause,
              }),
          });
        }

        if (ctx.session.isStreaming) {
          yield* Effect.tryPromise({
            try: () => ctx.session.steer(text),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn",
                detail: `Failed to steer Pi session ${ctx.session.sessionId}.`,
                cause,
              }),
          });
        } else {
          // prompt() resolves only after the full run settles; turn lifecycle
          // flows through SDK events, so only preflight rejection is an error
          // worth surfacing. Invoke synchronously and swallow the settlement.
          // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
          yield* Effect.try({
            try: () => {
              const maybePromise = ctx.session.prompt(text);
              if (isPromiseWithCatch(maybePromise)) {
                maybePromise.catch(() => {});
              }
            },
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn",
                detail: `Failed to prompt Pi session ${ctx.session.sessionId}.`,
                cause,
              }),
          });
        }

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: { sessionId: ctx.session.sessionId },
        } satisfies ProviderTurnStartResult;
      });

    const interruptTurn: PiAdapterContract["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* getSession(threadId, "interruptTurn");
        yield* Effect.tryPromise({
          try: () => ctx.session.abort(),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "interruptTurn",
              detail: `Failed to abort Pi session ${ctx.session.sessionId}.`,
              cause,
            }),
        });
        if (ctx.activeTurnId !== undefined) {
          const turnId = ctx.activeTurnId;
          ctx.activeTurnId = undefined;
          ctx.pendingTurnError = undefined;
          yield* offerRuntimeEvent({
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : undefined),
            threadId,
            type: "turn.aborted",
            turnId,
            payload: { reason: "Interrupted by user" },
          });
        }
      });

    const respondToRequest: PiAdapterContract["respondToRequest"] = (
      _threadId,
      _requestId,
      _decision,
    ) =>
      // Pi has no tool-approval concept; nothing ever opens a request, so a
      // response can never legitimately arrive. No-op by design.
      Effect.void;

    const respondToUserInput: PiAdapterContract["respondToUserInput"] = (
      _threadId,
      _requestId,
      _answers,
    ) => Effect.void;

    const stopSession: PiAdapterContract["stopSession"] = (threadId) =>
      Effect.suspend(() => {
        const ctx = sessions.get(threadId);
        if (!ctx) return Effect.void;
        sessions.delete(threadId);
        ctx.unsubscribe();
        return Effect.try({
          try: () => ctx.session.dispose(),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "stopSession",
              detail: `Failed to dispose Pi session ${ctx.session.sessionId}.`,
              cause,
            }),
        }).pipe(Effect.ignore);
      });

    const listSessions: PiAdapterContract["listSessions"] = () =>
      Effect.all([...sessions.values()].map((ctx) => providerSessionFor(ctx, "ready")));

    const hasSession: PiAdapterContract["hasSession"] = (threadId) =>
      Effect.succeed(sessions.has(threadId));

    const readThread: PiAdapterContract["readThread"] = (threadId) =>
      Effect.map(getSession(threadId, "readThread"), (ctx) => {
        const turn: ProviderThreadTurnSnapshot = {
          id: ctx.activeTurnId ?? TurnId.make("pi-history"),
          items: [...ctx.session.messages],
        };
        return { threadId, turns: [turn] } satisfies ProviderThreadSnapshot;
      });

    const rollbackThread: PiAdapterContract["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* getSession(threadId, "rollbackThread");
        const session = ctx.session;
        if (
          session.fork === undefined ||
          session.getEntries === undefined ||
          session.getLeafId === undefined
        ) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "rollbackThread",
            detail: "Pi session does not support fork-as-rollback.",
          });
        }

        // Collect the user entries on the current branch in order. Rolling
        // back N turns keeps everything before the (count - N + 1)th turn, so
        // the fork target is the parent of that turn's user entry.
        const entries = session.getEntries();
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        const userEntries: Array<{ id: string; parentId: string | undefined }> = [];
        {
          let cursor = session.getLeafId();
          while (cursor !== undefined) {
            const entry = byId.get(cursor);
            if (entry === undefined) break;
            if (entry.message?.role === "user") {
              userEntries.unshift({ id: entry.id, parentId: entry.parentId });
            }
            cursor = entry.parentId;
          }
        }

        const turnIndex = userEntries.length - numTurns;
        const target = turnIndex >= 0 ? userEntries[turnIndex] : undefined;
        const forkTarget = target?.parentId;
        if (target === undefined || forkTarget === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "rollbackThread",
            detail: `Cannot fork Pi session ${numTurns} turns back: branch has ${userEntries.length} user turns.`,
          });
        }

        session.fork(forkTarget);
        const turn: ProviderThreadTurnSnapshot = {
          id: ctx.activeTurnId ?? TurnId.make("pi-history"),
          items: [...session.messages],
        };
        return { threadId, turns: [turn] } satisfies ProviderThreadSnapshot;
      });

    const stopAll: PiAdapterContract["stopAll"] = () =>
      Effect.suspend(() => {
        const contexts = [...sessions.values()];
        sessions.clear();
        for (const ctx of contexts) {
          ctx.unsubscribe();
          try {
            ctx.session.dispose();
          } catch {
            // best effort — a wedged Pi session must not block shutdown
          }
        }
        return Effect.void;
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies PiAdapterContract;
  });
}
