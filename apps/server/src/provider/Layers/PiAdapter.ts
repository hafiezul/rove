/**
 * PiAdapter — `ProviderAdapterShape` implementation backed by the Pi SDK
 * (`@earendil-works/pi-coding-agent`) running in-process. See
 * docs/adr/0001-pi-provider-uses-sdk-in-process.md for why this is not a
 * subprocess adapter.
 *
 * One Pi `AgentSession` per Rove Code thread. Sessions run with the user's global
 * Pi config and headless extensions. Extension dialogs and terminal rendering
 * are unavailable. Rollback is fork-as-rollback: Pi sessions are
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
  RuntimeTaskId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  type ToolLifecycleItemType,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { PI_THINKING_DESCRIPTOR_ID } from "./PiProvider.ts";

import { ProviderAdapterRequestError } from "../Errors.ts";
import {
  describeDialectToolTasks,
  describeNotifyReading,
  parseDialectNotify,
  piBounded,
  piNotifyTerminalStatus,
  piRecord,
  piTrimmed,
  type PiNotifyReading,
  type PiSubagentDialect,
  type PiSubagentTaskDescriptor,
} from "./PiSubagentDialects.ts";
import { piSubagentsDialect } from "./PiSubagentsDialect.ts";
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

/** Map Pi tool names to Rove Code's canonical lifecycle item types. */
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

/**
 * Registered subagent dialects. pi-subagents is the first (and currently only)
 * entry; add new extensions here — the synthesis paths below dispatch through
 * this list and never branch on extension identity.
 */
const PI_SUBAGENT_DIALECTS: ReadonlyArray<PiSubagentDialect> = [piSubagentsDialect];

/**
 * Narrow slice of the Pi SDK session the adapter relies on. `setModel` takes
 * the composer slug (`provider/model-id`) and resolves it against the user's
 * catalog; `setThinkingLevel` clamps to model capabilities inside the SDK.
 */
export interface PiUsageLike {
  readonly input?: number | undefined;
  readonly output?: number | undefined;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
}

export interface PiSessionEntryLike {
  readonly id: string;
  readonly parentId?: string | null | undefined;
  readonly type?: string | undefined;
  readonly message?:
    | {
        readonly role?: string | undefined;
        readonly usage?: PiUsageLike | undefined;
      }
    | undefined;
  readonly usage?: PiUsageLike | undefined;
}

export interface PiSessionStatsLike {
  readonly assistantMessages?: number | undefined;
  readonly contextUsage?:
    | {
        readonly tokens: number | null;
        readonly contextWindow: number;
        readonly percent: number | null;
      }
    | undefined;
}

export interface PiSessionLike {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  readonly messages: ReadonlyArray<unknown>;
  readonly sessionFile?: string | undefined;
  readonly resumeOutcome?: PiSessionResumeOutcome | undefined;
  readonly autoCompactionEnabled?: boolean | undefined;
  prompt(
    text: string,
    options?: {
      readonly streamingBehavior?: "steer" | "followUp";
      readonly preflightResult?: (success: boolean) => void;
    },
  ): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  setModel?(model: string): Promise<void>;
  setThinkingLevel?(level: string): void;
  subscribe(listener: (event: PiSessionEventLike) => void): () => void;
  getEntries?(): ReadonlyArray<PiSessionEntryLike>;
  getBranch?(): ReadonlyArray<PiSessionEntryLike>;
  getSessionStats?(): PiSessionStatsLike | undefined;
  getLeafId?(): string | undefined;
  fork?(entryId: string): Promise<void>;
}
import type { Json as SchemaJson } from "effect/Schema";

/** Pi SDK `AgentSessionEvent` — typed loosely here so the fake can drive it. */
export interface PiSessionEventLike {
  readonly type: string;
  readonly [key: string]: SchemaJson;
}

export type PiSessionResumeOutcome =
  | { readonly resumed: true; readonly sessionFile: string }
  | { readonly resumed: false; readonly reason: "no-cursor" };

export function parsePiResumeCursor(
  raw: unknown,
): { readonly sessionId: string; readonly sessionFile?: string } | undefined {
  if (raw === undefined || raw === null) return undefined;
  const record = piRecord(raw);
  const sessionId = record !== undefined ? piTrimmed(record.sessionId) : undefined;
  const sessionFile = record !== undefined ? piTrimmed(record.sessionFile) : undefined;
  if (sessionId === undefined || (record?.sessionFile !== undefined && sessionFile === undefined)) {
    throw new Error(
      "Invalid Pi resume cursor. Restore the saved session cursor or create a new thread to start fresh.",
    );
  }
  return { sessionId, ...(sessionFile !== undefined ? { sessionFile } : undefined) };
}

export interface PiCreateSessionInput {
  readonly cwd: string;
  readonly model: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly resumeSessionId: string | undefined;
  readonly resumeSessionFile?: string | undefined;
  /** Pi extension paths blocked from loading; matched against the loader's discovered paths. */
  readonly disabledExtensions?: ReadonlyArray<string> | undefined;
}

export interface PiAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId | undefined;
  /**
   * Builds a Pi session (real SDK in the driver, a fake in tests). Required:
   * the adapter never talks to the SDK directly.
   */
  readonly createSession: (input: PiCreateSessionInput) => Promise<PiSessionLike>;
}

interface PiAssistantMessageItem {
  readonly itemId: RuntimeItemId;
  readonly turnId: TurnId;
  hasTextDelta: boolean;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  readonly session: PiSessionLike;
  readonly cwd: string;
  readonly resumed: boolean;
  currentModelSlug: string | undefined;
  activeTurnId: TurnId | undefined;
  activeAssistantMessage: PiAssistantMessageItem | undefined;
  nextAssistantMessageIndex: number;
  /** Deferred error from a failed assistant message, held until we know whether Pi will auto-retry. */
  pendingTurnError: string | undefined;
  /** Resolved tool-call arguments by toolCallId (Pi SDK events omit args). */
  toolCallArgs: Map<string, Record<string, SchemaJson>>;
  /** Pi reuses message objects between message_end and agent_end. */
  seenNotifyMessages: WeakSet<object>;
  /** Open single subagent runs (no coordinator) for notify correlation. */
  openSingles: Array<{ agent: string | undefined; taskId: string }>;
  unsubscribe: () => void;
}

/**
 * Timeline enrichment for Pi tool rows (issue: bare "Bash/Read/Edit" rows).
 *
 * The Pi SDK's tool events carry no arguments — only the session's toolCall
 * message blocks do — so without a session lookup the timeline can only
 * render the tool noun. Resolved args are shaped into the payload fields the
 * existing timeline extraction already reads (`data.command` for the command
 * subtitle, `path`-ish keys for changed-file subtitles, top-level `detail`
 * for grep-style summaries, `title` for subagent identity). Additive only:
 * result content/details are never clobbered.
 */
export interface PiToolCallEnrichment {
  readonly title?: string | undefined;
  readonly detail?: string | undefined;
  readonly data?: Record<string, SchemaJson> | undefined;
}

/** Backwards scan cap: toolCall blocks always sit near the tail (the call precedes its events by moments). */
const PI_TOOL_CALL_SCAN_LIMIT = 200;

function parsePiToolCallArguments(raw: unknown): Record<string, SchemaJson> | undefined {
  if (RuntimePredicate.isString(raw)) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return piRecord(parsed);
    } catch {
      return undefined;
    }
  }
  return piRecord(raw);
}

/** Cached session lookup: Pi SDK tool events omit args, so resolve once per call. */
function resolveCachedPiToolArgs(
  ctx: PiSessionContext,
  toolCallId: string,
): Record<string, SchemaJson> | undefined {
  if (toolCallId.length === 0) return undefined;
  const cached = ctx.toolCallArgs.get(toolCallId);
  if (cached) return cached;
  const resolved = resolvePiToolCallArgs(ctx.session.messages, toolCallId);
  if (resolved) ctx.toolCallArgs.set(toolCallId, resolved);
  return resolved;
}

export function resolvePiToolCallArgs(
  messages: ReadonlyArray<unknown>,
  toolCallId: string,
): Record<string, SchemaJson> | undefined {
  let scanned = 0;
  for (
    let index = messages.length - 1;
    index >= 0 && scanned < PI_TOOL_CALL_SCAN_LIMIT;
    index -= 1
  ) {
    scanned += 1;
    const message = piRecord(messages[index]);
    const content = message?.message ?? message;
    const contentBlocks = piRecord(content)?.content;
    const blocks = Array.isArray(contentBlocks) ? contentBlocks : undefined;
    const directBlocks = message?.content;
    const candidates = blocks ?? (Array.isArray(directBlocks) ? directBlocks : []);
    for (const block of candidates) {
      const record = piRecord(block);
      if (record?.type !== "toolCall" || record.id !== toolCallId) continue;
      const args = parsePiToolCallArguments(record.arguments);
      if (args) return args;
    }
  }
  return undefined;
}

export function describePiToolCall(
  toolName: string,
  args: Record<string, SchemaJson> | undefined,
): PiToolCallEnrichment {
  if (!args) return {};
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) {
    const command = piTrimmed(args.command);
    return command ? { data: { command } } : {};
  }
  if (normalized.includes("subagent")) {
    const agent = piTrimmed(args?.agent);
    const task = piTrimmed(args.task);
    // Workflow launches carry their children in workflowScript, not a task
    // string; the Agents tab owns that detail, the row just needs identity.
    if (agent === undefined && task === undefined) return {};
    return {
      ...(agent ? { title: `Subagent ${agent}` } : undefined),
      ...(task ? { detail: piBounded(task, 120) } : undefined),
    };
  }
  if (normalized.includes("grep") || normalized.includes("find")) {
    const pattern = piTrimmed(args.pattern);
    const path = piTrimmed(args.path);
    if (pattern === undefined && path === undefined) return {};
    return {
      ...(pattern && path
        ? { detail: `"${pattern}" in ${path}` }
        : pattern
          ? { detail: pattern }
          : undefined),
      ...(path ? { data: { path } } : undefined),
    };
  }
  if (
    normalized.includes("read") ||
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("ls") ||
    normalized.includes("patch")
  ) {
    const path = piTrimmed(args.path);
    return path ? { data: { path } } : {};
  }
  if (normalized.includes("web") || normalized.includes("fetch")) {
    const target = piTrimmed(args.url) ?? piTrimmed(args.query);
    return target ? { detail: piBounded(target, 120) } : {};
  }
  return {};
}

type PiTokenUsagePublishReason = "startup" | "settled" | "model-switch" | "rollback" | "compaction";

function finiteNonNegativeInteger(value: number | undefined): number | undefined {
  return RuntimePredicate.isNumber(value) && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function finitePositiveInteger(value: number | undefined): number | undefined {
  const integer = finiteNonNegativeInteger(value);
  return integer !== undefined && integer > 0 ? integer : undefined;
}

function activeBranchUsage(entries: ReadonlyArray<PiSessionEntryLike>) {
  let hasAssistantMessage = false;
  let hasUsage = false;
  let total = 0;

  for (const entry of entries) {
    const message = entry.message;
    if (entry.type === "message" && message?.role === "assistant") {
      hasAssistantMessage = true;
    }

    const usage =
      entry.type === "compaction" || entry.type === "branch_summary"
        ? entry.usage
        : entry.type === "message" &&
            (message?.role === "assistant" || message?.role === "toolResult")
          ? message.usage
          : undefined;
    if (!usage) {
      continue;
    }

    const components = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
    for (const component of components) {
      const tokens = finiteNonNegativeInteger(component);
      if (tokens !== undefined) {
        total += tokens;
        hasUsage = true;
      }
    }
  }

  return {
    hasAssistantMessage,
    totalProcessedTokens: hasUsage && total > 0 ? total : undefined,
  };
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
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
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

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const emitThreadTokenUsage = Effect.fn("emitPiThreadTokenUsage")(function* (
      ctx: PiSessionContext,
      usage: ThreadTokenUsageSnapshot,
      turnId: TurnId | null = ctx.activeTurnId ?? null,
    ) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        ...stamp,
        provider: PROVIDER,
        ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : undefined),
        threadId: ctx.threadId,
        ...(turnId !== null ? { turnId } : undefined),
        type: "thread.token-usage.updated",
        payload: { usage },
      });
    });

    const publishPiTokenUsageImpl = Effect.fn("publishPiTokenUsage")(function* (
      ctx: PiSessionContext,
      reason: PiTokenUsagePublishReason,
    ) {
      // Revert projection removes rows belonging to discarded turns. The
      // post-fork snapshot must remain thread-scoped so it survives that pass.
      const usageTurnId = reason === "rollback" ? null : (ctx.activeTurnId ?? null);
      const stats = yield* Effect.try(() => ctx.session.getSessionStats?.()).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (!stats) {
        if (reason !== "startup" || ctx.resumed) {
          yield* emitThreadTokenUsage(ctx, { contextUsageState: "unavailable" }, usageTurnId);
        }
        return;
      }

      // Current context remains useful even if the optional branch walk is
      // unavailable; omit the branch-scoped processed total in that case.
      const branchEntries = yield* Effect.try(() => ctx.session.getBranch?.()).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const branchUsage = branchEntries ? activeBranchUsage(branchEntries) : undefined;
      const hasMeaningfulUsage =
        branchUsage?.hasAssistantMessage ?? (stats.assistantMessages ?? 0) > 0;
      const shouldClearPreviousMeter = reason !== "startup" || ctx.resumed;
      if (!hasMeaningfulUsage && reason !== "settled") {
        if (shouldClearPreviousMeter) {
          yield* emitThreadTokenUsage(ctx, { contextUsageState: "unavailable" }, usageTurnId);
        }
        return;
      }

      const contextUsage = stats.contextUsage;
      const maxTokens = finitePositiveInteger(contextUsage?.contextWindow);
      if (!contextUsage || maxTokens === undefined) {
        if (shouldClearPreviousMeter) {
          yield* emitThreadTokenUsage(ctx, { contextUsageState: "unavailable" }, usageTurnId);
        }
        return;
      }

      const totalProcessedTokens = branchUsage?.totalProcessedTokens;
      const totalProcessed =
        totalProcessedTokens !== undefined
          ? {
              totalProcessedTokens,
              totalProcessedTokensScope: "activeBranch" as const,
            }
          : undefined;
      const autoCompaction = RuntimePredicate.isBoolean(ctx.session.autoCompactionEnabled)
        ? { compactsAutomatically: ctx.session.autoCompactionEnabled }
        : undefined;

      if (contextUsage.tokens === null) {
        yield* emitThreadTokenUsage(
          ctx,
          {
            contextUsageState: "unknown",
            contextUsageUnknownReason: "compacted",
            maxTokens,
            ...totalProcessed,
            ...autoCompaction,
          },
          usageTurnId,
        );
        return;
      }

      const usedTokens = finiteNonNegativeInteger(contextUsage.tokens);
      if (usedTokens === undefined) {
        if (shouldClearPreviousMeter) {
          yield* emitThreadTokenUsage(ctx, { contextUsageState: "unavailable" }, usageTurnId);
        }
        return;
      }

      yield* emitThreadTokenUsage(
        ctx,
        {
          usedTokens,
          maxTokens,
          ...totalProcessed,
          ...autoCompaction,
        },
        usageTurnId,
      );
    });

    // Context telemetry is advisory. A failure to stamp or enqueue it must
    // never turn a successful model switch, rollback, or completed turn into
    // an adapter failure after Pi has already changed its session state.
    const publishPiTokenUsage = (ctx: PiSessionContext, reason: PiTokenUsagePublishReason) =>
      publishPiTokenUsageImpl(ctx, reason).pipe(Effect.orElseSucceed(() => undefined));

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
          resumeCursor: {
            sessionId: ctx.session.sessionId,
            ...(ctx.session.sessionFile !== undefined
              ? { sessionFile: ctx.session.sessionFile }
              : undefined),
          },
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
    ): Effect.Effect<void, ProviderAdapterRequestError, Crypto.Crypto> =>
      Effect.gen(function* () {
        const stamp = yield* makeEventStamp();
        const base = {
          ...stamp,
          provider: PROVIDER,
          ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : undefined),
          threadId: ctx.threadId,
        } as const;

        // Pi can wake the session after it settled: background subagent
        // completions re-enter the agent loop without a new prompt, so
        // turn/message/tool events arrive with no active Rove turn. Mint a
        // follow-up turn so the resumed work (and its completion) stays
        // visible instead of being dropped as orphan events. The projection
        // pipeline upserts provider-initiated turns with no pending user
        // message, and checkpoints capture on their completion like any turn.
        const ensureActiveTurn = Effect.fn("ensurePiActiveTurn")(function* () {
          if (ctx.activeTurnId !== undefined) return ctx.activeTurnId;
          const turnId = TurnId.make(
            yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "eventListener",
                    detail: "Failed to mint a Pi follow-up turn id.",
                    cause,
                  }),
              ),
            ),
          );
          ctx.activeTurnId = turnId;
          ctx.activeAssistantMessage = undefined;
          ctx.pendingTurnError = undefined;
          yield* offerRuntimeEvent({
            ...base,
            type: "turn.started",
            turnId,
            payload: {},
          });
          return turnId;
        });

        const offerTaskDescriptors = (
          turnId: TurnId,
          descriptors: ReadonlyArray<PiSubagentTaskDescriptor>,
        ): Effect.Effect<void, ProviderAdapterRequestError, Crypto.Crypto> =>
          Effect.gen(function* () {
            for (const descriptor of descriptors) {
              const taskStamp = yield* makeEventStamp();
              const taskBase = {
                ...taskStamp,
                provider: PROVIDER,
                ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : undefined),
                threadId: ctx.threadId,
                turnId,
              } as const;
              if (descriptor.type === "task.started") {
                // Track open singles for notify correlation: workflow members
                // carry parentAgentId and settle via their coordinator.
                const payload = descriptor.payload;
                if (payload.taskType === "subagent" && payload.parentAgentId === undefined) {
                  const agent = RuntimePredicate.isString(payload.role) ? payload.role : undefined;
                  const taskId = String(payload.taskId ?? "");
                  if (taskId) ctx.openSingles.push({ agent, taskId });
                }
                yield* offerRuntimeEvent({
                  ...taskBase,
                  type: "task.started",
                  payload: descriptor.payload,
                });
              } else if (descriptor.type === "task.progress") {
                yield* offerRuntimeEvent({
                  ...taskBase,
                  type: "task.progress",
                  payload: descriptor.payload,
                });
              } else if (descriptor.type === "task.updated") {
                yield* offerRuntimeEvent({
                  ...taskBase,
                  type: "task.updated",
                  payload: descriptor.payload,
                });
              } else {
                const taskId = String(descriptor.payload.taskId ?? "");
                if (taskId)
                  ctx.openSingles = ctx.openSingles.filter((open) => open.taskId !== taskId);
                yield* offerRuntimeEvent({
                  ...taskBase,
                  type: "task.completed",
                  payload: descriptor.payload,
                });
              }
            }
          });

        // Settle one open single from a parsed notify (workflows carry their
        // own identity; singles only name their agent). Most-recent match wins.
        const settleSingleFromNotify = (
          turnId: TurnId,
          parsed: PiNotifyReading,
        ): Effect.Effect<void, ProviderAdapterRequestError, Crypto.Crypto> =>
          Effect.gen(function* () {
            const terminal = piNotifyTerminalStatus(parsed.status);
            if (terminal === undefined) return;
            const wanted = parsed.agent.trim().toLowerCase();
            for (let index = ctx.openSingles.length - 1; index >= 0; index -= 1) {
              const open = ctx.openSingles[index];
              if (!open || (open.agent !== undefined && open.agent.trim().toLowerCase() !== wanted))
                continue;
              ctx.openSingles.splice(index, 1);
              yield* offerTaskDescriptors(turnId, [
                {
                  type: "task.completed",
                  payload: {
                    taskId: RuntimeTaskId.make(open.taskId),
                    status: terminal,
                    taskType: "subagent",
                    ...(open.agent
                      ? { role: open.agent, title: open.agent }
                      : { title: parsed.agent }),
                  },
                },
              ]);
              return;
            }
          });

        const offerParsedNotify = (
          turnId: TurnId,
          parsed: PiNotifyReading,
        ): Effect.Effect<void, ProviderAdapterRequestError, Crypto.Crypto> =>
          Effect.gen(function* () {
            if (parsed.workflowRunId !== undefined) {
              yield* offerTaskDescriptors(turnId, describeNotifyReading(parsed));
            } else {
              yield* settleSingleFromNotify(turnId, parsed);
            }
          });

        switch (event.type) {
          case "turn_start": {
            // Pi turn ids are positional; Rove Code mints its own turn id at
            // turn.started, so nothing to correlate here yet. A retry also
            // emits turn_start — clear any stale deferred error from the
            // previous attempt.
            ctx.pendingTurnError = undefined;
            const turnId = yield* ensureActiveTurn();
            yield* offerRuntimeEvent({
              ...base,
              type: "turn.started",
              turnId,
              payload: {},
            });
            return;
          }
          case "message_start": {
            // A Pi run can contain several assistant messages around tool work.
            // Preserve their boundaries so ingestion can keep only the terminal
            // assistant item as the final response.
            const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
              message = event.message as { role?: string } | undefined;
            if (message?.role === "assistant") {
              const turnId = yield* ensureActiveTurn();
              ctx.activeAssistantMessage = {
                itemId: RuntimeItemId.make(
                  `pi-assistant:${turnId}:${ctx.nextAssistantMessageIndex}`,
                ),
                turnId,
                hasTextDelta: false,
              };
              ctx.nextAssistantMessageIndex += 1;
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
              const turnId = yield* ensureActiveTurn();
              const assistantMessage = ctx.activeAssistantMessage;
              if (assistantMessage !== undefined) {
                assistantMessage.hasTextDelta = true;
              }
              yield* offerRuntimeEvent({
                ...base,
                type: "content.delta",
                turnId,
                ...(assistantMessage ? { itemId: assistantMessage.itemId } : undefined),
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
              const turnId = yield* ensureActiveTurn();
              yield* offerRuntimeEvent({
                ...base,
                type: "content.delta",
                turnId,
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
            const assistantMessage =
              message?.role === "assistant" ? ctx.activeAssistantMessage : undefined;
            if (message?.role === "assistant") {
              ctx.activeAssistantMessage = undefined;
              if (assistantMessage?.hasTextDelta && message.stopReason !== "error") {
                yield* offerRuntimeEvent({
                  ...base,
                  type: "item.completed",
                  turnId: assistantMessage.turnId,
                  itemId: assistantMessage.itemId,
                  payload: {
                    itemType: "assistant_message",
                    status: "completed",
                    title: "Assistant message",
                  },
                });
              }
            }
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
            const customMessage = piRecord(event.message);
            if (
              customMessage?.role === "custom" &&
              RuntimePredicate.isString(customMessage.customType)
            ) {
              const parsed = parseDialectNotify(
                PI_SUBAGENT_DIALECTS,
                customMessage.customType,
                customMessage.content,
              );
              if (parsed && !ctx.seenNotifyMessages.has(customMessage)) {
                ctx.seenNotifyMessages.add(customMessage);
                const turnId = yield* ensureActiveTurn();
                yield* offerParsedNotify(turnId, parsed);
              }
            }
            return;
          }
          case "tool_execution_start": {
            const turnId = yield* ensureActiveTurn();
            const toolName = String(event.toolName ?? "tool");
            const toolCallId = String(event.toolCallId ?? "");
            const toolArgs = piRecord(event.args) ?? resolveCachedPiToolArgs(ctx, toolCallId);
            const enrichment = describePiToolCall(toolName, toolArgs);
            yield* offerRuntimeEvent({
              ...base,
              type: "item.started",
              turnId,
              itemId: RuntimeItemId.make(toolCallId),
              payload: {
                itemType: toToolLifecycleItemType(toolName),
                status: "inProgress",
                title: enrichment.title ?? toolName,
                ...(enrichment.detail ? { detail: enrichment.detail } : undefined),
                data: enrichment.data ?? event.args,
              },
            });
            return;
          }
          case "tool_execution_end": {
            const turnId = yield* ensureActiveTurn();
            const toolName = String(event.toolName ?? "tool");
            const toolCallId = String(event.toolCallId ?? "");
            const toolArgs = piRecord(event.args) ?? resolveCachedPiToolArgs(ctx, toolCallId);
            const enrichment = describePiToolCall(toolName, toolArgs);
            const resultRecord = piRecord(event.result);
            yield* offerRuntimeEvent({
              ...base,
              type: "item.completed",
              turnId,
              itemId: RuntimeItemId.make(toolCallId),
              payload: {
                itemType: toToolLifecycleItemType(toolName),
                status: event.isError === true ? "failed" : "completed",
                title: enrichment.title ?? toolName,
                ...(enrichment.detail ? { detail: enrichment.detail } : undefined),
                data:
                  resultRecord && enrichment.data
                    ? { ...resultRecord, ...enrichment.data }
                    : (enrichment.data ?? event.result),
              },
            });
            // Feed the Agents roster: Pi subagent runs are otherwise visible
            // only as parent tool rows. Synthesis rides after the tool row so
            // a malformed payload can never break the row itself (the
            // descriptor builder is total), and each task event carries the
            // turn for timeline correlation.
            const subagentTasks = describeDialectToolTasks(PI_SUBAGENT_DIALECTS, {
              toolName: String(event.toolName ?? ""),
              args: toolArgs ?? event.args,
              result: event.result,
              toolCallId: event.toolCallId,
              isError: event.isError,
            });
            yield* offerTaskDescriptors(turnId, subagentTasks);
            return;
          }
          case "agent_end": {
            const willRetry = event.willRetry === true;
            // Auto-drain completions ride the transcript as text-only customs
            // (structured details do not survive the session round-trip), so
            // recover structure through the dialect registry. Dedupe by notify
            // message identity so separate runs with identical text still settle.
            const transcript = Array.isArray(event.messages) ? event.messages : [];
            const freshNotifies: Array<PiNotifyReading> = [];
            for (const entry of transcript) {
              const transcriptMessage = piRecord(entry);
              if (!transcriptMessage || transcriptMessage.role !== "custom") continue;
              const parsed = parseDialectNotify(
                PI_SUBAGENT_DIALECTS,
                transcriptMessage.customType,
                transcriptMessage.content,
              );
              if (!parsed) continue;
              if (ctx.seenNotifyMessages.has(transcriptMessage)) continue;
              ctx.seenNotifyMessages.add(transcriptMessage);
              freshNotifies.push(parsed);
            }
            if (freshNotifies.length > 0) {
              const turnId = yield* ensureActiveTurn();
              for (const parsed of freshNotifies) {
                yield* offerParsedNotify(turnId, parsed);
              }
            }
            if (
              !willRetry &&
              ctx.pendingTurnError !== undefined &&
              ctx.activeTurnId !== undefined
            ) {
              // Terminal error — Pi is not retrying. Emit the deferred failure.
              const turnId = ctx.activeTurnId;
              const errorMessage = ctx.pendingTurnError;
              ctx.activeTurnId = undefined;
              ctx.activeAssistantMessage = undefined;
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
          case "compaction_end": {
            if (event.aborted !== true) {
              yield* publishPiTokenUsage(ctx, "compaction");
            }
            return;
          }
          case "extension_error": {
            // Warnings stay warnings even when they arrive mid-turn (e.g. a
            // subagent auto-drain failure Pi may still recover from) — but
            // attach the active turn so the UI can correlate them instead of
            // showing a floating error on a "finished" thread.
            yield* offerRuntimeEvent({
              ...base,
              type: "runtime.warning",
              ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : undefined),
              payload: {
                message: `Pi extension ${String(event.extensionPath ?? "<runtime>")}: ${String(event.error ?? "Unknown error")}`,
                detail: event,
              },
            });
            return;
          }
          case "prompt_error": {
            if (ctx.activeTurnId === undefined) return;
            const turnId = ctx.activeTurnId;
            ctx.activeTurnId = undefined;
            ctx.activeAssistantMessage = undefined;
            ctx.pendingTurnError = undefined;
            yield* offerRuntimeEvent({
              ...base,
              type: "turn.completed",
              turnId,
              payload: { state: "failed", errorMessage: String(event.error ?? "Pi prompt failed") },
            });
            return;
          }
          case "agent_settled": {
            if (ctx.activeTurnId !== undefined) {
              const turnId = ctx.activeTurnId;
              yield* publishPiTokenUsage(ctx, "settled");
              ctx.activeTurnId = undefined;
              ctx.activeAssistantMessage = undefined;
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
            // Deferred Pi events (compaction_start, auto_retry_*, queue_update,
            // …) are intentionally dropped for v1. See the
            // carry-forward list in the provider design notes.
            return;
        }
      }).pipe(
        // A listener that throws would tear down the SDK's event dispatch.
        // Keep the stream alive, but log the failure instead of swallowing
        // it: silent translation drops are invisible broken turns.
        Effect.catchCause((cause) =>
          Effect.logWarning("Pi runtime event translation failed.", {
            threadId: ctx.threadId,
            eventType: event.type,
            cause,
          }),
        ),
      );

    const startSession: PiAdapterContract["startSession"] = (input: ProviderSessionStartInput) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const existing = sessions.get(input.threadId);
          if (existing) {
            return yield* providerSessionFor(existing, "ready");
          }

          const cwd = input.cwd ?? process.cwd();
          // A thread-scoped model selection (the composer's pick at thread
          // creation) wins over the instance-level settings defaults.
          const modelSelection = ownModelSelection(input, boundInstanceId);
          const initialModelSlug =
            selectedModelSlug(modelSelection) ??
            (piSettings.model.trim().length > 0 ? piSettings.model : undefined);
          const session = yield* Effect.tryPromise({
            try: () => {
              const cursor = parsePiResumeCursor(input.resumeCursor);
              return createSession({
                cwd,
                model: initialModelSlug,
                thinkingLevel:
                  getModelSelectionStringOptionValue(modelSelection, PI_THINKING_DESCRIPTOR_ID) ??
                  piSettings.thinkingLevel ??
                  undefined,
                resumeSessionId: cursor?.sessionId,
                resumeSessionFile: cursor?.sessionFile,
                // The registry rebuilds the adapter when Pi settings change, so
                // this closure always reflects the current disabled set; the
                // next turn's resumed session applies it.
                disabledExtensions: piSettings.disabledExtensions,
              });
            },
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "startSession",
                detail: `Failed to create Pi session in ${cwd}. ${cause instanceof Error ? cause.message : String(cause)}`,
                cause,
              }),
          });

          const outcome = session.resumeOutcome;
          const resumed = outcome?.resumed === true;
          const ctx: PiSessionContext = {
            threadId: input.threadId,
            session,
            cwd,
            resumed,
            currentModelSlug: initialModelSlug,
            activeTurnId: undefined,
            activeAssistantMessage: undefined,
            nextAssistantMessageIndex: 0,
            pendingTurnError: undefined,
            toolCallArgs: new Map(),
            seenNotifyMessages: new WeakSet(),
            openSingles: [],
            unsubscribe: () => {},
          };
          ctx.pendingTurnError = undefined;
          ctx.unsubscribe = session.subscribe((event) => {
            runFork(withThreadLock(input.threadId, handleSdkEvent(ctx, event)));
          });
          sessions.set(input.threadId, ctx);

          yield* offerRuntimeEvent({
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : undefined),
            threadId: input.threadId,
            type: "session.started",
            payload: { resume: resumed },
          });
          yield* offerRuntimeEvent({
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : undefined),
            threadId: input.threadId,
            type: "session.state.changed",
            payload: { state: "ready", reason: "Pi session ready" },
          });
          yield* publishPiTokenUsage(ctx, "startup");

          return yield* providerSessionFor(ctx, "ready");
        }),
      );

    const sendTurn: PiAdapterContract["sendTurn"] = (input: ProviderSendTurnInput) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
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

            // Steering reuses the running turn: Pi folds the new text into
            // the live agent loop and closes it once, so the composer keeps
            // one open turn instead of orphaning the running one.
            const steeringTurnId = ctx.activeTurnId;
            const freshTurnId = TurnId.make(
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
            const turnId = steeringTurnId ?? freshTurnId;
            ctx.activeTurnId = turnId;
            return { ctx, turnId, steeringTurnId, text: translatePiSkillToken(rawText) };
          }),
        );
        const { ctx, turnId, steeringTurnId, text } = prepared;

        return yield* Effect.gen(function* () {
          // Apply the composer's per-thread model options before prompting.
          // Pi sessions support in-session model switches, so a changed picker
          // value takes effect on the very next turn of the same thread.
          const modelSelection = ownModelSelection(input, boundInstanceId);
          let modelChanged = false;
          if (modelSelection !== undefined) {
            const modelSlug = selectedModelSlug(modelSelection);
            const thinkingLevel = getModelSelectionStringOptionValue(
              modelSelection,
              PI_THINKING_DESCRIPTOR_ID,
            );
            const switchOutcome = yield* Effect.tryPromise({
              try: async () => {
                let changed = false;
                if (ctx.session.setModel !== undefined && modelSlug !== undefined) {
                  changed = modelSlug !== ctx.currentModelSlug;
                  await ctx.session.setModel(modelSlug);
                  ctx.currentModelSlug = modelSlug;
                }
                if (ctx.session.setThinkingLevel !== undefined && thinkingLevel !== undefined) {
                  ctx.session.setThinkingLevel(thinkingLevel);
                }
                return changed;
              },
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "sendTurn",
                  detail: `Failed to apply model selection to Pi session ${ctx.session.sessionId}.`,
                  cause,
                }),
            });
            const live = sessions.get(input.threadId);
            if (live === undefined || live.activeTurnId !== turnId) {
              return {
                threadId: input.threadId,
                turnId,
                resumeCursor: {
                  sessionId: ctx.session.sessionId,
                  ...(ctx.session.sessionFile !== undefined
                    ? { sessionFile: ctx.session.sessionFile }
                    : undefined),
                },
              } satisfies ProviderTurnStartResult;
            }
            modelChanged = switchOutcome;
          }
          if (modelChanged) {
            yield* publishPiTokenUsage(ctx, "model-switch");
          }

          // The SDK prompt promise waits for the whole run, not just acceptance.
          const acceptance = yield* Deferred.make<boolean>();
          runFork(
            Effect.promise(async () => {
              try {
                await ctx.session.prompt(text, {
                  ...(steeringTurnId !== undefined ? { streamingBehavior: "steer" } : undefined),
                  preflightResult: (success) => {
                    Deferred.doneUnsafe(acceptance, Effect.succeed(success));
                  },
                });
                Deferred.doneUnsafe(acceptance, Effect.succeed(true));
              } catch {
                Deferred.doneUnsafe(acceptance, Effect.succeed(false));
              }
            }),
          );
          const promptAccepted = yield* Deferred.await(acceptance);
          if (!promptAccepted) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: `Pi rejected the turn for session ${ctx.session.sessionId}.`,
            });
          }

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: {
              sessionId: ctx.session.sessionId,
              ...(ctx.session.sessionFile !== undefined
                ? { sessionFile: ctx.session.sessionFile }
                : undefined),
            },
          } satisfies ProviderTurnStartResult;
        }).pipe(
          Effect.catch((error) =>
            withThreadLock(
              input.threadId,
              Effect.gen(function* () {
                if (
                  steeringTurnId === undefined &&
                  sessions.get(input.threadId) === ctx &&
                  ctx.activeTurnId === turnId
                ) {
                  ctx.activeTurnId = undefined;
                  ctx.activeAssistantMessage = undefined;
                  ctx.pendingTurnError = undefined;
                }
                return yield* error;
              }),
            ),
          ),
        );
      });

    const interruptTurn: PiAdapterContract["interruptTurn"] = (threadId, turnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* getSession(threadId, "interruptTurn");
          const liveTurnId = ctx.activeTurnId;
          if (turnId !== undefined && liveTurnId !== undefined && liveTurnId !== turnId) {
            return;
          }
          const abortedId = turnId ?? liveTurnId;
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
          // SDK settlement waits on this lock and observes the cleared turn.
          if (
            ctx.activeTurnId !== undefined &&
            (abortedId === undefined || ctx.activeTurnId === abortedId)
          ) {
            const settledId = abortedId ?? ctx.activeTurnId;
            if (settledId !== undefined) {
              ctx.activeTurnId = undefined;
              ctx.activeAssistantMessage = undefined;
              ctx.pendingTurnError = undefined;
              yield* offerRuntimeEvent({
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : undefined),
                threadId,
                type: "turn.aborted",
                turnId: settledId,
                payload: { reason: "Interrupted by user" },
              });
            }
          }
        }),
      );

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
        return Effect.tryPromise({
          try: async () => {
            await ctx.session.dispose();
          },
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
        const fork = session.fork;
        if (
          fork === undefined ||
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
        const userEntries: Array<{ id: string; parentId: string | null | undefined }> = [];
        {
          let cursor = session.getLeafId();
          while (cursor !== undefined) {
            const entry = byId.get(cursor);
            if (entry === undefined) break;
            if (entry.message?.role === "user") {
              userEntries.unshift({ id: entry.id, parentId: entry.parentId });
            }
            cursor = entry.parentId ?? undefined;
          }
        }

        const turnIndex = userEntries.length - numTurns;
        const target = turnIndex >= 0 ? userEntries[turnIndex] : undefined;
        const forkTarget = target?.parentId;
        if (target === undefined || !RuntimePredicate.isString(forkTarget)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "rollbackThread",
            detail: `Cannot fork Pi session ${numTurns} turns back: branch has ${userEntries.length} user turns.`,
          });
        }

        yield* Effect.tryPromise({
          try: () => fork.call(session, forkTarget),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "rollbackThread",
              detail: `Failed to fork Pi session ${session.sessionId}.`,
              cause,
            }),
        });
        yield* publishPiTokenUsage(ctx, "rollback");
        const turn: ProviderThreadTurnSnapshot = {
          id: ctx.activeTurnId ?? TurnId.make("pi-history"),
          items: [...session.messages],
        };
        return { threadId, turns: [turn] } satisfies ProviderThreadSnapshot;
      });

    const stopAll: PiAdapterContract["stopAll"] = () =>
      Effect.suspend(() => {
        return Effect.forEach([...sessions.keys()], stopSession, { discard: true });
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
