/**
 * PiAdapter — `ProviderAdapterContract` implementation backed by the Pi SDK
 * (`@earendil-works/pi-coding-agent`) running in-process. See
 * docs/adr/0001-pi-provider-uses-sdk-in-process.md for why this is not a
 * subprocess adapter.
 *
 * One Pi `AgentSession` per Rove Code thread. Sessions run with the user's global
 * Pi config and extensions. Standard extension dialogs use Rove's question UI;
 * terminal rendering remains unavailable. Rollback is fork-as-rollback: Pi sessions are
 * trees, so rolling back N turns forks the session at the entry that precedes
 * them and the fork becomes the thread's live session.
 *
 * The SDK surface is injected as `PiSdkLike` so tests can drive the adapter
 * with a fake in-process Pi instead of real LLM calls.
 *
 * @module provider/Layers/PiAdapter
 */
import {
  type ChatAttachment,
  EventId,
  PiSettings,
  PiExtensionStatusSnapshot,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  UserInputRequestedPayload,
  type ProviderUserInputAnswers,
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
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";

import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { PI_THINKING_DESCRIPTOR_ID } from "./PiProvider.ts";
import { acquirePiResource, disposePiResource, PI_STARTUP_TIMEOUT_MS } from "./PiLifecycle.ts";

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

function translatePiSkillToken(text: string): string {
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
const decodePiUserInput = Schema.decodeUnknownEffect(UserInputRequestedPayload);
const decodePiExtensionStatus = Schema.decodeUnknownSync(PiExtensionStatusSnapshot);

/**
 * Registered subagent dialects. pi-subagents is the first (and currently only)
 * entry; add new extensions here — the synthesis paths below dispatch through
 * this list and never branch on extension identity.
 */
const PI_SUBAGENT_DIALECTS: ReadonlyArray<PiSubagentDialect> = [piSubagentsDialect];

/**
 * Pi SDK `ImageContent` — a base64-encoded image inlined into a user message
 * (the same `{ type, data, mimeType }` shape ACP adapters build).
 */
export interface PiImageContentLike {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

/**
 * Narrow model descriptor for capability checks: the SDK `Model` fields the
 * adapter reads to decide whether image attachments can reach the model.
 * `provider` is present on SDK models and composes the effective slug for
 * session records; test fakes may omit it.
 */
export interface PiSessionModelLike {
  readonly id: string;
  readonly provider?: string | undefined;
  readonly input: ReadonlyArray<string>;
}

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
  readonly hasPendingUserInput?: boolean | undefined;
  readonly isPreparingPrompt?: boolean | undefined;
  readonly messages: ReadonlyArray<unknown>;
  readonly sessionFile?: string | undefined;
  readonly resumeOutcome?: PiSessionResumeOutcome | undefined;
  readonly autoCompactionEnabled?: boolean | undefined;
  /**
   * Set when the effective model/reasoning selection differs from the
   * requested one (SDK restore fallback, resolver warnings, clamped
   * reasoning). The adapter publishes it as a runtime warning at session
   * start so the mismatch is visible instead of silent.
   */
  readonly modelFallbackMessage?: string | undefined;
  prompt(
    text: string,
    options?: {
      readonly images?: Array<PiImageContentLike>;
      readonly streamingBehavior?: "steer" | "followUp";
      readonly preflightResult?: (success: boolean) => void;
    },
  ): Promise<void>;
  followUp(text: string): Promise<void>;
  respondToUserInput?(requestId: string, answers: ProviderUserInputAnswers): boolean;
  compact?(): Promise<void>;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  setModel?(model: string): Promise<void>;
  setThinkingLevel?(level: string): void;
  getThinkingLevel?(): string;
  /**
   * Current model for image-input capability checks; undefined when no model
   * is selected yet. Sessions without the accessor (test fakes) skip checks.
   */
  getModel?(): PiSessionModelLike | undefined;
  subscribe(listener: (event: PiSessionEventLike) => void): () => void;
  getEntries?(): ReadonlyArray<PiSessionEntryLike>;
  getBranch?(): ReadonlyArray<PiSessionEntryLike>;
  getSessionStats?(): PiSessionStatsLike | undefined;
  getLeafId?(): string | undefined;
  fork?(entryId: string | null): Promise<void>;
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

interface PiTurnBoundary {
  readonly turnId: string;
  readonly entryId: string | null;
}

export function parsePiResumeCursor(raw: unknown):
  | {
      readonly sessionId: string;
      readonly sessionFile?: string;
      readonly turnBoundaries?: ReadonlyArray<PiTurnBoundary>;
    }
  | undefined {
  if (raw === undefined || raw === null) return undefined;
  const record = piRecord(raw);
  const sessionId = record !== undefined ? piTrimmed(record.sessionId) : undefined;
  const sessionFile = record !== undefined ? piTrimmed(record.sessionFile) : undefined;
  if (sessionId === undefined || (record?.sessionFile !== undefined && sessionFile === undefined)) {
    throw new Error(
      "Invalid Pi resume cursor. Restore the saved session cursor or create a new thread to start fresh.",
    );
  }
  const rawBoundaries = record?.turnBoundaries;
  const turnBoundaries: PiTurnBoundary[] = [];
  if (rawBoundaries !== undefined) {
    if (!Array.isArray(rawBoundaries))
      throw new Error("Invalid Pi turn boundaries in resume cursor.");
    for (const rawBoundary of rawBoundaries) {
      const boundary = piRecord(rawBoundary);
      const turnId = piTrimmed(boundary?.turnId);
      const entryId = boundary?.entryId === null ? null : piTrimmed(boundary?.entryId);
      if (!turnId || entryId === undefined) {
        throw new Error("Invalid Pi turn boundary in resume cursor.");
      }
      turnBoundaries.push({ turnId, entryId });
    }
  }
  return {
    sessionId,
    ...(sessionFile !== undefined ? { sessionFile } : {}),
    ...(rawBoundaries !== undefined ? { turnBoundaries } : {}),
  };
}

export interface PiCreateSessionInput {
  readonly threadId?: ThreadId | undefined;
  /** Bind interactive extensions on the first prompt, once responses can be routed. */
  readonly interactive?: boolean | undefined;
  readonly cwd: string;
  /** Per-instance Pi agent directory; blank falls back to the global default. */
  readonly agentDir?: string | undefined;
  readonly model: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly resumeSessionId: string | undefined;
  readonly resumeSessionFile?: string | undefined;
  /** Pi extension paths blocked from loading; matched against the loader's discovered paths. */
  readonly disabledExtensions?: ReadonlyArray<string> | undefined;
}

export class PiExtensionLoadError extends Error {
  readonly failedExtensionPaths: ReadonlyArray<string>;
  constructor(message: string, failedExtensionPaths: ReadonlyArray<string>) {
    super(message);
    this.name = "PiExtensionLoadError";
    this.failedExtensionPaths = failedExtensionPaths;
  }
}

export interface PiAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly getSettings?: Effect.Effect<PiSettings> | undefined;
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
  session: PiSessionLike;
  readonly cwd: string;
  readonly resumed: boolean;
  readonly createdAt: string;
  updatedAt: string;
  currentModelSlug: string | undefined;
  compacting: boolean;
  /** Exact Rove boundaries: steering messages never add a new entry here. */
  turnBoundaries: PiTurnBoundary[];
  lastSettledEntryId: string | null;
  activeTurnId: TurnId | undefined;
  activeAssistantMessage: PiAssistantMessageItem | undefined;
  nextAssistantMessageIndex: number;
  /** Deferred error from a failed assistant message, held until we know whether Pi will auto-retry. */
  pendingTurnError: string | undefined;
  /** Pi (or an extension) aborted without a Rove Stop request. */
  pendingTurnAborted: boolean;
  /** Resolved tool-call arguments by toolCallId (Pi SDK events omit args). */
  toolCallArgs: Map<string, Record<string, SchemaJson>>;
  /** Progress is sampled before queueing work, so bursts cannot build a fiber backlog. */
  lastToolProgressAt: number;
  /** Pi reuses message objects between message_end and agent_end. */
  seenNotifyMessages: WeakSet<object>;
  /** Open single subagent runs (no coordinator) for notify correlation. */
  openSingles: Array<{ agent: string | undefined; taskId: string }>;
  readonly liveTaskIds: Set<string>;
  readonly openUiRequestIds: Set<string>;
  readonly stopped: Deferred.Deferred<never, ProviderAdapterRequestError>;
  unsubscribe: () => void;
  loadedDisabledExtensions: ReadonlyArray<string>;
  /** Failed extensions this session auto-skipped at startup, beyond the settings-disabled set. */
  recoveredFailedExtensions: ReadonlyArray<string>;
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
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;

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

    const input = finiteNonNegativeInteger(usage.input);
    const output = finiteNonNegativeInteger(usage.output);
    const cacheRead = finiteNonNegativeInteger(usage.cacheRead);
    const cacheWrite = finiteNonNegativeInteger(usage.cacheWrite);
    inputTokens += input ?? 0;
    cachedInputTokens += cacheRead ?? 0;
    cacheCreationTokens += cacheWrite ?? 0;
    outputTokens += output ?? 0;
    total += (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
    hasUsage ||=
      input !== undefined ||
      output !== undefined ||
      cacheRead !== undefined ||
      cacheWrite !== undefined;
  }

  return {
    hasAssistantMessage,
    totalProcessedTokens: hasUsage && total > 0 ? total : undefined,
    inputTokens: hasUsage ? inputTokens + cachedInputTokens + cacheCreationTokens : undefined,
    cachedInputTokens: hasUsage ? cachedInputTokens : undefined,
    cacheCreationTokens: hasUsage ? cacheCreationTokens : undefined,
    outputTokens: hasUsage ? outputTokens : undefined,
  };
}

export interface PiAdapterContract extends ProviderAdapterContract<ProviderAdapterRequestError> {
  /** Permanently retire this adapter, drain its turns, and close its event stream. */
  readonly shutdown: () => Effect.Effect<void>;
  readonly waitForActiveTurnsToSettle?: (timeoutMs?: number) => Effect.Effect<void>;
}

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

/**
 * Image mime types Pi itself accepts for pasted images. pi-ai forwards the
 * declared type verbatim to the model's API, so an exotic type here would
 * surface as an opaque upstream error instead of this preflight rejection.
 */
const PI_IMAGE_MIME_TYPES: ReadonlyArray<string> = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/**
 * Inline attachment pixels into Pi `ImageContent` blocks so the model receives
 * the image itself, matching Codex and Claude. Attachment id and read failures
 * surface here as clear turn errors; ProviderService appends the on-disk paths
 * to the text separately, so the agent can still dereference the file with tools.
 */
const buildPiImageAttachments = Effect.fn("buildPiImageAttachments")(function* (
  attachments: ReadonlyArray<ChatAttachment>,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
  },
) {
  const images: Array<PiImageContentLike> = [];
  for (const attachment of attachments) {
    // Generic files are supplied through ProviderService's on-disk path notes.
    if (attachment.type !== "image") continue;
    const mimeType = attachment.mimeType.toLowerCase();
    if (!PI_IMAGE_MIME_TYPES.includes(mimeType)) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "sendTurn",
        detail: `Unsupported Pi image attachment type '${attachment.mimeType}' for '${attachment.name}'. Supported types: ${PI_IMAGE_MIME_TYPES.join(", ")}.`,
      });
    }
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: dependencies.attachmentsDir,
      attachment,
    });
    if (attachmentPath === null) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "sendTurn",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }
    const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: `Failed to read attachment file '${attachment.name}'. ${cause.message}`,
            cause,
          }),
      ),
    );
    images.push({
      type: "image",
      data: Buffer.from(bytes).toString("base64"),
      mimeType,
    });
  }
  return images;
});

export function makePiAdapter(
  piSettings: PiSettings,
  options: PiAdapterLiveOptions,
): Effect.Effect<PiAdapterContract, never, Crypto.Crypto | FileSystem.FileSystem | ServerConfig> {
  return Effect.gen(function* () {
    const boundInstanceId = options.instanceId;
    const crypto = yield* Crypto.Crypto;
    const clock = yield* Clock.Clock;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const runFork = Effect.runForkWith(yield* Effect.context<Crypto.Crypto>());
    const createSession = options.createSession;

    let closed = false;
    const sessions = new Map<ThreadId, PiSessionContext>();
    const starting = new Map<ThreadId, Deferred.Deferred<never, ProviderAdapterRequestError>>();
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
      Effect.flatMap(getThreadSemaphore(`events:${threadId}`), (semaphore) =>
        semaphore.withPermit(effect),
      );

    // Serialize prompt preparation separately from SDK events and Stop. Two
    // concurrent sends must not both enter Pi's asynchronous preflight idle.
    const withSendLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(`send:${threadId}`), (semaphore) =>
        semaphore.withPermit(effect),
      );

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
          ...(branchUsage?.inputTokens !== undefined
            ? {
                inputTokens: branchUsage.inputTokens,
                tokenBreakdownScope: "activeBranch" as const,
                cachedInputTokens: branchUsage.cachedInputTokens,
                cacheCreationTokens: branchUsage.cacheCreationTokens,
                outputTokens: branchUsage.outputTokens,
              }
            : undefined),
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

    const resumeCursorFor = (ctx: PiSessionContext) => ({
      sessionId: ctx.session.sessionId,
      ...(ctx.session.sessionFile !== undefined ? { sessionFile: ctx.session.sessionFile } : {}),
      turnBoundaries: [...ctx.turnBoundaries],
    });

    const providerSessionFor = (
      ctx: PiSessionContext,
      status: ProviderSession["status"],
    ): Effect.Effect<ProviderSession> =>
      Effect.sync(() => {
        // The session's effective model, not the requested slug: fallbacks and
        // defaults make the two differ, and session records must not lie.
        const model = ctx.session.getModel?.();
        const effectiveModelSlug =
          model === undefined
            ? undefined
            : model.provider !== undefined && model.provider.trim().length > 0
              ? `${model.provider}/${model.id}`
              : model.id;
        return {
          provider: PROVIDER,
          ...(boundInstanceId !== undefined ? { providerInstanceId: boundInstanceId } : undefined),
          status: ctx.activeTurnId !== undefined ? "running" : status,
          runtimeMode: "full-access",
          cwd: ctx.cwd,
          ...(effectiveModelSlug !== undefined ? { model: effectiveModelSlug } : undefined),
          threadId: ctx.threadId,
          resumeCursor: resumeCursorFor(ctx),
          ...(ctx.activeTurnId !== undefined ? { activeTurnId: ctx.activeTurnId } : undefined),
          createdAt: ctx.createdAt,
          updatedAt: ctx.updatedAt,
        } satisfies ProviderSession;
      });

    const ensureOpen = (method: string) =>
      Effect.suspend(() =>
        closed
          ? Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method,
                detail: "Pi provider is shutting down. Retry with the replacement provider.",
              }),
            )
          : Effect.void,
      );

    const getSession = (threadId: ThreadId, method: string) =>
      Effect.gen(function* () {
        yield* ensureOpen(method);
        const ctx = sessions.get(threadId);
        return yield* ctx
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
        if (sessions.get(ctx.threadId) !== ctx) return;
        const stamp = yield* makeEventStamp();
        ctx.updatedAt = stamp.createdAt;
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
          ctx.turnBoundaries.push({ turnId, entryId: ctx.lastSettledEntryId });
          ctx.activeAssistantMessage = undefined;
          ctx.pendingTurnError = undefined;
          ctx.pendingTurnAborted = false;
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
                ctx.liveTaskIds.add(String(descriptor.payload.taskId));
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
                ctx.liveTaskIds.delete(taskId);
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
            ctx.pendingTurnAborted = false;
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
            let assistantMessage =
              message?.role === "assistant" ? ctx.activeAssistantMessage : undefined;
            if (message?.role === "assistant") {
              const content = piRecord(event.message)?.content;
              const text = RuntimePredicate.isString(content)
                ? content
                : Array.isArray(content)
                  ? content
                      .map((part) => {
                        const block = piRecord(part);
                        return block?.type === "text" && RuntimePredicate.isString(block.text)
                          ? block.text
                          : "";
                      })
                      .join("")
                  : "";
              if (
                !assistantMessage?.hasTextDelta &&
                text.length > 0 &&
                message.stopReason !== "error"
              ) {
                const turnId = yield* ensureActiveTurn();
                assistantMessage ??= {
                  turnId,
                  itemId: RuntimeItemId.make(
                    `pi-assistant:${turnId}:${ctx.nextAssistantMessageIndex++}`,
                  ),
                  hasTextDelta: false,
                };
                yield* offerRuntimeEvent({
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
                  threadId: ctx.threadId,
                  type: "content.delta",
                  turnId,
                  itemId: assistantMessage.itemId,
                  payload: { streamKind: "assistant_text", delta: text },
                });
                assistantMessage.hasTextDelta = true;
              }
              ctx.activeAssistantMessage = undefined;
              if (assistantMessage?.hasTextDelta && message.stopReason !== "error") {
                yield* offerRuntimeEvent({
                  ...base,
                  type: "item.completed",
                  turnId: assistantMessage.turnId,
                  itemId: assistantMessage.itemId,
                  payload: {
                    itemType: "assistant_message",
                    status: message.stopReason === "aborted" ? "failed" : "completed",
                    title: "Assistant message",
                  },
                });
              }
            }
            if (message?.role === "assistant" && message.stopReason === "aborted") {
              ctx.pendingTurnAborted = true;
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
              // Any extension can send visible messages, not just known
              // subagent dialects. Keep hidden context hidden and show text
              // without attempting to run an extension's terminal renderer.
              if (customMessage.display === true) {
                const content = customMessage.content;
                const text = RuntimePredicate.isString(content)
                  ? content
                  : Array.isArray(content)
                    ? content
                        .map((part) => {
                          const block = piRecord(part);
                          return block?.type === "text" && RuntimePredicate.isString(block.text)
                            ? block.text
                            : "";
                        })
                        .join("\n")
                    : "";
                if (text.trim())
                  yield* offerRuntimeEvent({
                    ...base,
                    type: "runtime.info",
                    ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                    payload: { message: piBounded(text, 16_384) },
                  });
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
          case "tool_execution_update": {
            if (ctx.activeTurnId === undefined) return;
            yield* offerRuntimeEvent({
              ...base,
              type: "item.updated",
              turnId: ctx.activeTurnId,
              itemId: RuntimeItemId.make(String(event.toolCallId ?? "")),
              payload: {
                itemType: toToolLifecycleItemType(String(event.toolName ?? "tool")),
                status: "inProgress",
                title: String(event.toolName ?? "tool"),
                detail: String(event.progress ?? "Tool running"),
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
            ctx.toolCallArgs.delete(toolCallId);
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
            // Only agent_settled closes the Rove turn. Retry or compaction can
            // fail without another agent_end, and extension follow-ups can
            // still continue a run whose willRetry flag was false.
            return;
          }
          case "auto_retry_start":
          case "compaction_start": {
            yield* offerRuntimeEvent({
              ...base,
              type: "runtime.info",
              ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : undefined),
              payload: {
                message:
                  event.type === "compaction_start"
                    ? "Compacting context…"
                    : `Retrying${RuntimePredicate.isNumber(event.attempt) ? ` (attempt ${event.attempt})` : ""}…`,
              },
            });
            return;
          }
          case "auto_retry_end": {
            yield* offerRuntimeEvent({
              ...base,
              type: "runtime.info",
              ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : undefined),
              payload: { message: event.success === true ? "Retry succeeded" : "Retry stopped" },
            });
            // A successful retry means the pending error is stale — clear it.
            if (event.success === true) {
              ctx.pendingTurnError = undefined;
            }
            return;
          }
          case "compaction_end": {
            yield* offerRuntimeEvent({
              ...base,
              type: "runtime.info",
              ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : undefined),
              payload: {
                message:
                  event.aborted === true
                    ? "Compaction stopped"
                    : event.errorMessage
                      ? "Compaction failed"
                      : "Compaction finished",
                ...(RuntimePredicate.isString(event.errorMessage)
                  ? { detail: piBounded(event.errorMessage, 1024) }
                  : undefined),
              },
            });
            if (event.aborted !== true && !event.errorMessage) {
              yield* publishPiTokenUsage(ctx, "compaction");
              yield* offerRuntimeEvent({
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
                threadId: ctx.threadId,
                type: "thread.state.changed",
                payload: { state: "compacted" },
              });
            }
            return;
          }
          case "rove_ui_request": {
            const payload = yield* decodePiUserInput({
              questions: event.questions,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "extensionUI",
                    detail: "Invalid Pi extension question.",
                    cause,
                  }),
              ),
            );
            const requestId = String(event.requestId);
            ctx.openUiRequestIds.add(requestId);
            yield* offerRuntimeEvent({
              ...base,
              type: "user-input.requested",
              requestId: RuntimeRequestId.make(requestId),
              ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
              payload,
            });
            return;
          }
          case "rove_ui_resolved": {
            const requestId = String(event.requestId);
            if (!ctx.openUiRequestIds.delete(requestId)) return;
            yield* offerRuntimeEvent({
              ...base,
              type: "user-input.resolved",
              requestId: RuntimeRequestId.make(requestId),
              ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
              payload: { answers: piRecord(event.answers) ?? {} },
            });
            return;
          }
          case "rove_ui_status": {
            yield* offerRuntimeEvent({
              ...base,
              type: "runtime.ui.status",
              payload: decodePiExtensionStatus({ statuses: event.statuses }),
            });
            return;
          }
          case "rove_ui_text": {
            yield* offerRuntimeEvent({
              ...base,
              type: "runtime.info",
              itemId: RuntimeItemId.make("pi-extension-ui-status"),
              ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
              payload: { message: String(event.message) },
            });
            return;
          }
          case "rove_ui_notify": {
            yield* offerRuntimeEvent({
              ...base,
              type: event.level === "info" ? "runtime.info" : "runtime.warning",
              ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
              payload: { message: String(event.message) },
            });
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
            ctx.pendingTurnAborted = false;
            ctx.lastSettledEntryId = ctx.session.getLeafId?.() ?? null;
            ctx.toolCallArgs.clear();
            yield* offerRuntimeEvent({
              ...base,
              type: "turn.completed",
              turnId,
              payload: { state: "failed", errorMessage: String(event.error ?? "Pi prompt failed") },
            });
            return;
          }
          case "agent_settled": {
            ctx.lastSettledEntryId = ctx.session.getLeafId?.() ?? null;
            ctx.toolCallArgs.clear();
            if (ctx.activeTurnId !== undefined) {
              const turnId = ctx.activeTurnId;
              const errorMessage = ctx.pendingTurnError;
              const aborted = ctx.pendingTurnAborted;
              yield* publishPiTokenUsage(ctx, "settled");
              ctx.activeTurnId = undefined;
              ctx.activeAssistantMessage = undefined;
              ctx.pendingTurnError = undefined;
              ctx.pendingTurnAborted = false;
              if (aborted) {
                yield* offerRuntimeEvent({
                  ...base,
                  type: "turn.aborted",
                  turnId,
                  payload: { reason: "Pi response was aborted" },
                });
              } else {
                yield* offerRuntimeEvent({
                  ...base,
                  type: "turn.completed",
                  turnId,
                  payload:
                    errorMessage !== undefined
                      ? { state: "failed", errorMessage }
                      : { state: "completed" },
                });
              }
            }
            return;
          }
          default:
            // Queue and SDK-internal events have no timeline representation.
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

    const subscribeToSession = (ctx: PiSessionContext) =>
      ctx.session.subscribe((event) => {
        if (sessions.get(ctx.threadId) !== ctx) return;
        let queued = event;
        if (event.type === "tool_execution_update") {
          // At most two small progress snapshots per second per session, including
          // parallel tools. Never queue the SDK's potentially huge partial result.
          const now = clock.currentTimeMillisUnsafe();
          if (now - ctx.lastToolProgressAt < 500) return;
          ctx.lastToolProgressAt = now;
          const content = piRecord(event.partialResult)?.content;
          let progress = "";
          if (Array.isArray(content)) {
            // SDK updates can contain cumulative output. Keep the newest text,
            // otherwise every snapshot looks identical once output exceeds the cap.
            for (let index = content.length - 1; index >= 0; index--) {
              const text = piRecord(content[index]);
              if (text?.type !== "text" || !RuntimePredicate.isString(text.text)) continue;
              progress = text.text.slice(-(1024 - progress.length)) + progress;
              if (progress.length >= 1024) break;
            }
          }
          queued = {
            type: event.type,
            toolCallId: String(event.toolCallId ?? ""),
            toolName: piBounded(String(event.toolName ?? "tool"), 120),
            progress: progress.trim() || "Tool running",
          };
        }
        runFork(withThreadLock(ctx.threadId, handleSdkEvent(ctx, queued)));
      });

    const startSession: PiAdapterContract["startSession"] = (input: ProviderSessionStartInput) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          yield* ensureOpen("startSession");
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
          // Extensions that failed to load are auto-skipped with a recovery
          // retry below; the failed set is reported to the thread and recorded
          // on the session context so the actual disabled set stays accurate.
          let recoveredFailures: ReadonlyArray<string> = [];
          const startupStopped = yield* Deferred.make<never, ProviderAdapterRequestError>();
          starting.set(input.threadId, startupStopped);
          const session = yield* acquirePiResource(
            async () => {
              const cursor = parsePiResumeCursor(input.resumeCursor);
              try {
                return await createSession({
                  threadId: input.threadId,
                  interactive: true,
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
              } catch (cause) {
                if (
                  cause instanceof PiExtensionLoadError &&
                  cause.failedExtensionPaths.length > 0
                ) {
                  recoveredFailures = cause.failedExtensionPaths;
                  return await createSession({
                    threadId: input.threadId,
                    interactive: true,
                    cwd,
                    model: initialModelSlug,
                    thinkingLevel:
                      getModelSelectionStringOptionValue(
                        modelSelection,
                        PI_THINKING_DESCRIPTOR_ID,
                      ) ??
                      piSettings.thinkingLevel ??
                      undefined,
                    resumeSessionId: cursor?.sessionId,
                    resumeSessionFile: cursor?.sessionFile,
                    disabledExtensions: [
                      ...(piSettings.disabledExtensions ?? []),
                      ...cause.failedExtensionPaths,
                    ],
                  });
                }
                throw cause;
              }
            },
            (session) => session.dispose(),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "startSession",
                  detail: `Failed to create Pi session in ${cwd}. ${cause.message}`,
                  cause,
                }),
            ),
            Effect.raceFirst(Deferred.await(startupStopped)),
            Effect.ensuring(
              Effect.sync(() => {
                if (starting.get(input.threadId) === startupStopped)
                  starting.delete(input.threadId);
              }),
            ),
          );

          // Creation is asynchronous and does not hold up driver retirement.
          // A late session must be disposed, never adopted by the retired adapter.
          if (closed) {
            yield* disposePiResource(() => session.dispose());
            yield* ensureOpen("startSession");
          }
          const failedExtensions = recoveredFailures;
          const settingsDisabled = piSettings.disabledExtensions ?? [];
          const effectiveDisabledExtensions = [
            ...new Set([...settingsDisabled, ...failedExtensions]),
          ];

          const outcome = session.resumeOutcome;
          const resumed = outcome?.resumed === true;
          const createdAt = yield* nowIso;
          const ctx: PiSessionContext = {
            threadId: input.threadId,
            session,
            cwd,
            resumed,
            createdAt,
            updatedAt: createdAt,
            currentModelSlug: initialModelSlug,
            compacting: false,
            turnBoundaries: [...(parsePiResumeCursor(input.resumeCursor)?.turnBoundaries ?? [])],
            lastSettledEntryId: session.getLeafId?.() ?? null,
            activeTurnId: undefined,
            activeAssistantMessage: undefined,
            nextAssistantMessageIndex: 0,
            pendingTurnError: undefined,
            pendingTurnAborted: false,
            toolCallArgs: new Map(),
            lastToolProgressAt: -Infinity,
            seenNotifyMessages: new WeakSet(),
            openSingles: [],
            liveTaskIds: new Set(),
            openUiRequestIds: new Set(),
            stopped: yield* Deferred.make<never, ProviderAdapterRequestError>(),
            unsubscribe: () => {},
            loadedDisabledExtensions: effectiveDisabledExtensions,
            recoveredFailedExtensions: failedExtensions,
          };
          // Register before subscribing: buffered startup events replay
          // synchronously inside subscribeToSession, and its membership guard
          // would drop them for a context that is not in the map yet.
          sessions.set(input.threadId, ctx);
          ctx.unsubscribe = subscribeToSession(ctx);

          // Load failures must never disappear: startup retried without the
          // failed extensions, so name each skipped path before the session
          // is announced. The user cannot otherwise tell why an extension's
          // tools or commands are missing.
          if (failedExtensions.length > 0) {
            const plural = failedExtensions.length === 1 ? "extension" : "extensions";
            yield* offerRuntimeEvent({
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : undefined),
              threadId: input.threadId,
              type: "runtime.warning",
              payload: {
                message:
                  `Skipped ${failedExtensions.length} Pi ${plural} that failed to load: ` +
                  `${failedExtensions.join(", ")}. ` +
                  "Skipped for this session; fix or disable them before starting a new session.",
              },
            });
          }
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
          // Model fallback must always be visible: Pi restores a session's
          // saved model (or picks a default) without a request, so surface the
          // effective selection as a warning the thread timeline renders.
          const modelFallbackMessage = session.modelFallbackMessage;
          if (modelFallbackMessage !== undefined && modelFallbackMessage.trim().length > 0) {
            yield* offerRuntimeEvent({
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : undefined),
              threadId: input.threadId,
              type: "runtime.warning",
              payload: { message: modelFallbackMessage },
            });
          }
          yield* publishPiTokenUsage(ctx, "startup");

          return yield* providerSessionFor(ctx, "ready");
        }),
      );

    const sendTurn: PiAdapterContract["sendTurn"] = (input: ProviderSendTurnInput) =>
      Effect.gen(function* () {
        // Image inlining reads attachment files up front, outside the thread
        // lock, so a slow disk never stalls other turns on the same thread.
        const images = yield* buildPiImageAttachments(input.attachments ?? [], {
          fileSystem,
          attachmentsDir: serverConfig.attachmentsDir,
        });
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* getSession(input.threadId, "sendTurn");
            if (ctx.session.hasPendingUserInput) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn",
                detail:
                  "Answer the pending Pi extension question or stop the thread before sending another message.",
              });
            }
            if (ctx.session.isPreparingPrompt) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn",
                detail:
                  "Pi is still preparing the previous message. Wait for it to start or finish.",
              });
            }
            if (ctx.compacting) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn",
                detail: "Wait for Pi context compaction to finish before sending a message.",
              });
            }
            const rawText = input.input?.trim() ?? "";
            if (rawText.length === 0 && images.length === 0) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn",
                detail: "Pi turns require text input or image attachments.",
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
            ctx.updatedAt = yield* nowIso;
            return {
              ctx,
              turnId,
              steeringTurnId,
              entryId: ctx.session.getLeafId?.() ?? null,
              text: translatePiSkillToken(rawText),
            };
          }),
        );
        const { ctx, turnId, steeringTurnId, entryId, text } = prepared;
        const preparationTimeout = new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "sendTurn",
          detail:
            "Pi turn preparation timed out after 60 seconds. The session was retired; check extension hooks and provider authentication before retrying.",
        });

        return yield* Effect.gen(function* () {
          // If disabled extensions changed while idle between turns, refresh the session
          // cleanly at the cursor before prompting, applying changes after active turns settle.
          const activePiSettings = options.getSettings ? yield* options.getSettings : piSettings;
          const currentDisabled = activePiSettings.disabledExtensions ?? [];
          // Recovery-skipped extensions are part of the loaded set but not of
          // the user's settings, so exclude them when detecting settings
          // changes; otherwise every turn would needlessly reload the session.
          const recovered = ctx.recoveredFailedExtensions;
          const settingsLoadedDisabled = recovered.some((p) =>
            ctx.loadedDisabledExtensions.includes(p),
          )
            ? ctx.loadedDisabledExtensions.filter((p) => !recovered.includes(p))
            : ctx.loadedDisabledExtensions;
          const disabledChanged =
            settingsLoadedDisabled.length !== currentDisabled.length ||
            currentDisabled.some((p) => !settingsLoadedDisabled.includes(p)) ||
            settingsLoadedDisabled.some((p) => !currentDisabled.includes(p));

          if (disabledChanged && steeringTurnId === undefined) {
            const cursor = {
              sessionId: ctx.session.sessionId,
              sessionFile: ctx.session.sessionFile,
            };
            ctx.unsubscribe();
            yield* disposePiResource(() => ctx.session.dispose());
            const newSession = yield* acquirePiResource(
              () =>
                createSession({
                  threadId: input.threadId,
                  interactive: true,
                  cwd: ctx.cwd,
                  model: ctx.currentModelSlug,
                  thinkingLevel:
                    getModelSelectionStringOptionValue(
                      ownModelSelection(input, boundInstanceId),
                      PI_THINKING_DESCRIPTOR_ID,
                    ) ??
                    activePiSettings.thinkingLevel ??
                    undefined,
                  resumeSessionId: cursor.sessionId,
                  resumeSessionFile: cursor.sessionFile,
                  disabledExtensions: currentDisabled,
                }),
              (session) => session.dispose(),
            ).pipe(
              Effect.mapError((cause) => {
                // A failed reload must not leave a disposed session available for reuse.
                if (sessions.get(input.threadId) === ctx) sessions.delete(input.threadId);
                return new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "sendTurn",
                  detail: `Failed to reload Pi session with updated extensions in ${ctx.cwd}. ${cause.message}`,
                  cause,
                });
              }),
            );
            if (sessions.get(input.threadId) !== ctx) {
              yield* disposePiResource(() => newSession.dispose());
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn",
                detail: "Pi session stopped during reload.",
              });
            }
            ctx.session = newSession;
            ctx.loadedDisabledExtensions = currentDisabled;
            // The reloaded session has no auto-skipped extensions: any load
            // failure here fails the turn instead of recovering.
            ctx.recoveredFailedExtensions = [];
            ctx.toolCallArgs.clear();
            ctx.unsubscribe = subscribeToSession(ctx);
          }
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
                if (
                  ctx.session.setModel !== undefined &&
                  modelSlug !== undefined &&
                  modelSlug !== ctx.currentModelSlug
                ) {
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
            const effectiveThinkingLevel = ctx.session.getThinkingLevel?.();
            if (
              thinkingLevel !== undefined &&
              effectiveThinkingLevel !== undefined &&
              thinkingLevel !== effectiveThinkingLevel
            ) {
              yield* offerRuntimeEvent({
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
                threadId: input.threadId,
                turnId,
                type: "runtime.warning",
                payload: {
                  message: `Reasoning level "${thinkingLevel}" is not supported by the selected Pi model; using "${effectiveThinkingLevel}".`,
                },
              });
            }
            modelChanged = switchOutcome;
          }
          if (modelChanged) {
            yield* publishPiTokenUsage(ctx, "model-switch");
          }

          yield* ensureOpen("sendTurn");
          if (sessions.get(input.threadId) !== ctx || ctx.activeTurnId !== turnId) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: "Pi session stopped during turn preparation.",
            });
          }

          // A non-vision model silently receives "(image omitted)" placeholder
          // text instead of pixels (pi-ai downgrades images), so reject up front
          // where the user gets a clear error instead of a blind answer. Checked
          // after the model switch above so the composer's model is the one that
          // gets judged. Failing here lands in the catch below, which releases
          // the reserved turn.
          if (images.length > 0) {
            const model = ctx.session.getModel?.();
            if (model !== undefined && !model.input.includes("image")) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn",
                detail: `The Pi model "${model.id}" does not support image input. Attach images to a thread on a vision model.`,
              });
            }
          }

          // The SDK prompt promise waits for the whole run, not just acceptance.
          const acceptance = yield* Deferred.make<void, ProviderAdapterRequestError>();
          let preflightResult: boolean | undefined;
          const accept = (success: boolean) => {
            if (preflightResult !== undefined) return;
            preflightResult = success;
            // Rejection is followed by a rejected prompt promise. Wait for its
            // cause so auth and extension failures remain actionable.
            if (!success) return;
            if (
              steeringTurnId === undefined &&
              !ctx.turnBoundaries.some((boundary) => boundary.turnId === turnId)
            ) {
              ctx.turnBoundaries.push({ turnId, entryId });
            }
            Deferred.doneUnsafe(acceptance, Effect.void);
          };
          runFork(
            Effect.promise(async () => {
              try {
                await ctx.session.prompt(text, {
                  ...(images.length > 0 ? { images } : undefined),
                  ...(steeringTurnId !== undefined ? { streamingBehavior: "steer" } : undefined),
                  preflightResult: accept,
                });
                if (preflightResult === false) throw new Error("Pi rejected the prompt.");
                accept(true);
              } catch (cause) {
                // Acceptance already returned to orchestration. A rejected SDK
                // promise must now fail that turn, not a newer turn or a retired
                // session, and must not disappear into an already-done Deferred.
                if (preflightResult === true) {
                  runFork(
                    withThreadLock(
                      input.threadId,
                      Effect.suspend(() =>
                        sessions.get(input.threadId) === ctx && ctx.activeTurnId === turnId
                          ? handleSdkEvent(ctx, {
                              type: "prompt_error",
                              error: cause instanceof Error ? cause.message : String(cause),
                            })
                          : Effect.void,
                      ),
                    ),
                  );
                }
                Deferred.doneUnsafe(
                  acceptance,
                  Effect.fail(
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "sendTurn",
                      detail: `Pi rejected the turn for session ${ctx.session.sessionId}. ${cause instanceof Error ? cause.message : String(cause)}`,
                      cause,
                    }),
                  ),
                );
              }
            }),
          );
          yield* Deferred.await(acceptance);

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: resumeCursorFor(ctx),
          } satisfies ProviderTurnStartResult;
        }).pipe(
          Effect.raceFirst(Deferred.await(ctx.stopped)),
          Effect.timeoutOrElse({
            duration: PI_STARTUP_TIMEOUT_MS,
            orElse: () => preparationTimeout,
          }),
          Effect.catch((error) =>
            withThreadLock(
              input.threadId,
              Effect.gen(function* () {
                if (error === preparationTimeout && sessions.get(input.threadId) === ctx) {
                  yield* stopSession(input.threadId);
                }
                if (
                  steeringTurnId === undefined &&
                  sessions.get(input.threadId) === ctx &&
                  ctx.activeTurnId === turnId
                ) {
                  ctx.activeTurnId = undefined;
                  ctx.activeAssistantMessage = undefined;
                  ctx.pendingTurnError = undefined;
                  ctx.pendingTurnAborted = false;
                }
                return yield* error;
              }),
            ),
          ),
        );
      }).pipe((effect) => withSendLock(input.threadId, effect));

    const compactThread = Effect.fn("compactPiThread")(function* (threadId: ThreadId) {
      const ctx = yield* withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* getSession(threadId, "compactThread");
          if (ctx.activeTurnId !== undefined || ctx.compacting || !ctx.session.compact) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "compactThread",
              detail: "Pi context compaction requires an idle session with compaction support.",
            });
          }
          ctx.compacting = true;
          return ctx;
        }),
      );
      yield* Effect.tryPromise({
        try: () => ctx.session.compact!(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "compactThread",
            detail: cause instanceof Error ? cause.message : "Pi context compaction failed.",
            cause,
          }),
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            ctx.compacting = false;
          }),
        ),
      );
    });

    const interruptTurn: PiAdapterContract["interruptTurn"] = (threadId, turnId) =>
      Effect.suspend(() =>
        starting.has(threadId)
          ? stopSession(threadId)
          : withThreadLock(
              threadId,
              Effect.gen(function* () {
                const ctx = yield* getSession(threadId, "interruptTurn");
                const liveTurnId = ctx.activeTurnId;
                if (turnId !== undefined && liveTurnId !== undefined && liveTurnId !== turnId) {
                  return;
                }
                const abortedId = turnId ?? liveTurnId;
                const aborted = yield* Effect.tryPromise({
                  try: () => ctx.session.abort(),
                  catch: (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "interruptTurn",
                      detail: `Failed to abort Pi session ${ctx.session.sessionId}. ${cause instanceof Error ? cause.message : String(cause)}`,
                      cause,
                    }),
                }).pipe(Effect.timeout("5 seconds"), Effect.result);
                if (aborted._tag === "Failure") {
                  yield* offerRuntimeEvent({
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
                    threadId,
                    type: "runtime.warning",
                    payload: {
                      message: `Pi did not acknowledge Stop. The session was retired; an unresponsive extension may still be running on the server. ${aborted.failure.message}`,
                    },
                  });
                }
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
                    ctx.pendingTurnAborted = false;
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
                // Retire the extension runtime as well: background notifications must
                // not revive a thread after the user pressed Stop.
                for (const taskId of ctx.liveTaskIds) {
                  yield* offerRuntimeEvent({
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
                    threadId,
                    ...(abortedId ? { turnId: abortedId } : {}),
                    type: "task.completed",
                    payload: { taskId: RuntimeTaskId.make(taskId), status: "stopped" },
                  });
                }
                yield* stopSession(threadId);
                yield* offerRuntimeEvent({
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
                  threadId,
                  type: "session.exited",
                  payload: {
                    reason: "Stopped by user",
                    exitKind: aborted._tag === "Failure" ? "error" : "graceful",
                  },
                });
              }),
            ),
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
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* getSession(threadId, "respondToUserInput");
        yield* Effect.try({
          try: () => {
            if (!ctx.session.respondToUserInput?.(requestId, answers)) {
              throw new Error(`Unknown pending user-input request: ${requestId}`);
            }
          },
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "respondToUserInput",
              detail: cause instanceof Error ? cause.message : "Pi extension response failed.",
              cause,
            }),
        });
      });

    const stopSession: PiAdapterContract["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const startupStopped = starting.get(threadId);
        if (startupStopped) {
          starting.delete(threadId);
          yield* Deferred.fail(
            startupStopped,
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "startSession",
              detail: "Pi session stopped during startup.",
            }),
          );
        }
        const ctx = sessions.get(threadId);
        if (!ctx) return;
        sessions.delete(threadId);
        ctx.unsubscribe();
        ctx.toolCallArgs.clear();
        yield* Deferred.fail(
          ctx.stopped,
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: "Pi session stopped during turn preparation.",
          }),
        );
        for (const requestId of ctx.openUiRequestIds) {
          yield* offerRuntimeEvent({
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
            threadId,
            type: "user-input.resolved",
            requestId: RuntimeRequestId.make(requestId),
            payload: { answers: {} },
          });
        }
        ctx.openUiRequestIds.clear();
        yield* disposePiResource(() => ctx.session.dispose());
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
      withThreadLock(
        threadId,
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

          const turnIndex = ctx.turnBoundaries.length - numTurns;
          const target = ctx.turnBoundaries[turnIndex];
          if (!Number.isInteger(numTurns) || numTurns < 1 || !target) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "rollbackThread",
              detail:
                "The exact Pi turn boundary is unavailable. Older history cannot safely distinguish steering messages from turns; start a new thread instead.",
            });
          }
          if (ctx.activeTurnId !== undefined || ctx.compacting || session.isStreaming) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "rollbackThread",
              detail: "Wait for Pi to finish before rolling back.",
            });
          }
          const forkTarget = target.entryId;

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
          ctx.turnBoundaries = ctx.turnBoundaries.slice(0, turnIndex);
          ctx.lastSettledEntryId = session.getLeafId?.() ?? null;
          yield* publishPiTokenUsage(ctx, "rollback");
          const turn: ProviderThreadTurnSnapshot = {
            id: ctx.activeTurnId ?? TurnId.make("pi-history"),
            items: [...session.messages],
          };
          return { threadId, turns: [turn] } satisfies ProviderThreadSnapshot;
        }),
      );

    const stopAll: PiAdapterContract["stopAll"] = () =>
      Effect.suspend(() => {
        return Effect.forEach(new Set([...sessions.keys(), ...starting.keys()]), stopSession, {
          discard: true,
          concurrency: "unbounded",
        });
      });

    const waitForActiveTurnsToSettle: NonNullable<
      PiAdapterContract["waitForActiveTurnsToSettle"]
    > = (timeoutMs = 30_000) =>
      Effect.gen(function* () {
        const activeSessions = [...sessions.values()].filter(
          (ctx) => ctx.activeTurnId !== undefined || ctx.session.isStreaming,
        );
        if (activeSessions.length === 0) return;

        const allSettled = yield* Deferred.make<void>();
        let settledCount = 0;
        const targetCount = activeSessions.length;

        const checkSettled = () => {
          if (++settledCount >= targetCount) {
            Deferred.doneUnsafe(allSettled, Exit.void);
          }
        };

        const subscriptions: Array<() => void> = [];
        for (const ctx of activeSessions) {
          if (ctx.activeTurnId === undefined && !ctx.session.isStreaming) {
            checkSettled();
            continue;
          }
          let settled = false;
          subscriptions.push(
            ctx.session.subscribe((event) => {
              // Streaming can pause during retries or compaction; only settlement
              // means the accepted prompt is finished.
              if (event.type === "agent_settled" && !settled) {
                settled = true;
                checkSettled();
              }
            }),
          );
        }

        yield* Deferred.await(allSettled).pipe(
          Effect.timeout(`${timeoutMs} millis`),
          Effect.ignore,
          Effect.ensuring(
            Effect.sync(() => {
              for (const unsubscribe of subscriptions) unsubscribe();
            }),
          ),
        );
      });

    const shutdown = () =>
      Effect.gen(function* () {
        closed = true;
        // A question or startup hook is still preparing a turn, not running
        // one. Retire it on provider replacement instead of waiting through
        // the entire turn-drain deadline for an answer it may never receive.
        yield* Effect.forEach(
          [...sessions.values()].filter(
            (ctx) => ctx.session.hasPendingUserInput || ctx.session.isPreparingPrompt,
          ),
          (ctx) => stopSession(ctx.threadId),
          { discard: true, concurrency: "unbounded" },
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Pi extension question cleanup failed.", { cause }),
          ),
        );
        yield* waitForActiveTurnsToSettle().pipe(
          Effect.interruptible,
          Effect.ensuring(
            stopAll().pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Pi adapter cleanup failed.", { cause }),
              ),
              Effect.ensuring(PubSub.shutdown(runtimeEventPubSub)),
            ),
          ),
        );
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      compaction: { type: "native", start: compactThread },
      shutdown,
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
      waitForActiveTurnsToSettle,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies PiAdapterContract;
  });
}
