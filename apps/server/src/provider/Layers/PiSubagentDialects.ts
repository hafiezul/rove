/**
 * Pi subagent dialects — provider-neutral framework for Agents-tab observability.
 *
 * Pi's SDK has no first-class subagent lifecycle: it exposes tool calls and a
 * message transcript, while every subagent extension invents its own reporting
 * dialect (tool names, result shapes, wake-message grammars). Per-child tracking
 * therefore requires per-dialect knowledge, but that knowledge must not leak
 * into the adapter core. This module owns the neutral half:
 *
 * - the shared `task.*` descriptor vocabulary the roster fold consumes;
 * - small total parsing primitives;
 * - the `PiSubagentDialect` interface (one implementation per extension);
 * - dispatch over a registry plus the generic notify-reading applier.
 *
 * The adapter core (`PiAdapter.ts`) only transports: it resolves tool args,
 * dedupes wake notifications, tracks open singles, and emits whatever the
 * registry returns. Adding an extension is a new file implementing the
 * interface plus one registration line — core behavior never branches on
 * extension identity. Tools no dialect claims render as ordinary tool rows,
 * which always settle with their tool result.
 *
 * @module provider/Layers/PiSubagentDialects
 */
import {
  RuntimeTaskId,
  type RuntimeTaskStatus,
  type RuntimeTaskUsage,
  type TaskCompletedPayload,
  type TaskProgressPayload,
  type TaskStartedPayload,
  type TaskUpdatedPayload,
} from "@t3tools/contracts";
import * as RuntimePredicate from "effect/Predicate";
import type { Json as SchemaJson } from "effect/Schema";

export type PiSubagentTaskDescriptor =
  | { readonly type: "task.started"; readonly payload: TaskStartedPayload }
  | { readonly type: "task.progress"; readonly payload: TaskProgressPayload }
  | { readonly type: "task.updated"; readonly payload: TaskUpdatedPayload }
  | { readonly type: "task.completed"; readonly payload: TaskCompletedPayload };

/** Tool-result synthesis input. `toolCallId`/`isError` ride the SDK event. */
export interface PiSubagentToolInput {
  readonly toolName: string;
  readonly args: unknown;
  readonly result: unknown;
  /** Host tool-call id (SDK event). Falls back to details.toolCallId. */
  readonly toolCallId?: unknown;
  /** SDK isError flag for the tool result. */
  readonly isError?: unknown;
}

/** One wake-notification child in extension-neutral shape. */
export interface PiNotifyChildReading {
  readonly workflowKey?: string | undefined;
  readonly runId: string;
  readonly agent?: string | undefined;
  readonly status?: string | undefined;
}

/** A parsed completion wake in extension-neutral shape. */
export interface PiNotifyReading {
  readonly agent: string;
  readonly status: string;
  readonly workflowRunId?: string | undefined;
  readonly childRuns: ReadonlyArray<PiNotifyChildReading>;
}

/**
 * One subagent extension's observability dialect. All methods are pure and
 * total: malformed payloads yield no descriptors, never throw, so synthesis
 * can never break the tool row it rides on.
 */
export interface PiSubagentDialect {
  readonly name: string;
  /** Tool names this dialect claims (e.g. `subagent`, `bg_wait`). */
  readonly toolNames: ReadonlySet<string>;
  /** Custom message types this dialect observes (e.g. `subagent-notify`). */
  readonly customMessageTypes: ReadonlySet<string>;
  /** Roster rows for one tool result. */
  describeToolTasks(input: PiSubagentToolInput): ReadonlyArray<PiSubagentTaskDescriptor>;
  /** Parse one wake-message content into neutral shape (undefined = not ours). */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This parser is the boundary for untrusted extension message content.
  parseNotifyContent(content: unknown): PiNotifyReading | undefined;
}

/** First dialect whose tool names claim this tool, if any. */
export function findToolDialect(
  dialects: ReadonlyArray<PiSubagentDialect>,
  toolName: string,
): PiSubagentDialect | undefined {
  return dialects.find((dialect) => dialect.toolNames.has(toolName));
}

/** Roster rows for one tool result via the claiming dialect (none = []). */
export function describeDialectToolTasks(
  dialects: ReadonlyArray<PiSubagentDialect>,
  input: PiSubagentToolInput,
): ReadonlyArray<PiSubagentTaskDescriptor> {
  return findToolDialect(dialects, input.toolName)?.describeToolTasks(input) ?? [];
}

/** Parse wake content via the dialect observing this custom message type. */
export function parseDialectNotify(
  dialects: ReadonlyArray<PiSubagentDialect>,
  customType: unknown,
  content: unknown,
): PiNotifyReading | undefined {
  if (!RuntimePredicate.isString(customType)) return undefined;
  const dialect = dialects.find((candidate) => candidate.customMessageTypes.has(customType));
  return dialect?.parseNotifyContent(content);
}

export function piRecord(value: unknown): Record<string, SchemaJson> | undefined {
  // SAFETY: Callers narrow through this gate before field access.
  return RuntimePredicate.isObjectOrArray(value) && !Array.isArray(value)
    ? (value as Record<string, SchemaJson>)
    : undefined;
}

export function piTrimmed(value: unknown): string | undefined {
  return RuntimePredicate.isString(value) && value.trim().length > 0 ? value.trim() : undefined;
}

export function piNonNegativeInt(value: unknown): number | undefined {
  return RuntimePredicate.isNumber(value) && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export function piShortId(id: string): string {
  return id.slice(0, 8);
}

const PI_TASK_SUMMARY_LIMIT = 180;

export function piBounded(value: string, limit: number = PI_TASK_SUMMARY_LIMIT): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function piFirstText(result: Record<string, SchemaJson> | undefined): string | undefined {
  const content = result?.content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  return piTrimmed(piRecord(content[0])?.text);
}

export function piUsageToTypedUsage(value: unknown): RuntimeTaskUsage | undefined {
  const usage = piRecord(value);
  if (!usage) return undefined;
  const input = piNonNegativeInt(usage.input);
  const output = piNonNegativeInt(usage.output);
  const cacheRead = piNonNegativeInt(usage.cacheRead);
  const cacheWrite = piNonNegativeInt(usage.cacheWrite);
  const total =
    piNonNegativeInt(usage.totalTokens) ??
    (input !== undefined ||
    output !== undefined ||
    cacheRead !== undefined ||
    cacheWrite !== undefined
      ? (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
      : undefined);
  if (total === undefined) return undefined;
  return {
    totalTokens: total,
    ...(input !== undefined ? { inputTokens: input } : undefined),
    ...(cacheRead !== undefined ? { cachedInputTokens: cacheRead } : undefined),
    ...(output !== undefined ? { outputTokens: output } : undefined),
  };
}

const PI_CHILD_STATUS: ReadonlyMap<string, RuntimeTaskStatus> = new Map([
  ["pending", "pending"],
  ["running", "running"],
  ["completed", "completed"],
  ["complete", "completed"],
  ["failed", "failed"],
  ["paused", "waiting"],
  ["stopped", "interrupted"],
  ["rejected", "failed"],
  ["detached", "running"],
]);

export function piChildStatus(state: unknown): RuntimeTaskStatus | undefined {
  if (!RuntimePredicate.isString(state)) return undefined;
  return PI_CHILD_STATUS.get(state.trim().toLowerCase());
}

/** Optional-field spreads without assertions: bind once, spread when present. */
export function optModel(value: unknown): { readonly model: string } | undefined {
  const model = piTrimmed(value);
  return model ? { model } : undefined;
}

export function optTypedUsage(
  value: unknown,
): { readonly typedUsage: RuntimeTaskUsage } | undefined {
  const typedUsage = piUsageToTypedUsage(value);
  return typedUsage ? { typedUsage } : undefined;
}

export function optChildStatus(value: unknown): { readonly status: RuntimeTaskStatus } | undefined {
  const status = piChildStatus(value);
  return status ? { status } : undefined;
}

/**
 * Stable workflow-member identity: `<runId>:wf:<key>` matches the frontend
 * `:wf:` grouping convention (shared with the Claude adapter), so members
 * collapse into their coordinator's single timeline CTA row.
 */
export function piWorkflowMemberId(runId: string, key: string): string {
  const safe = key.trim().length > 0 ? key.trim().slice(0, 128) : "child";
  return `${runId}:wf:${safe}`;
}

/** Map notify status to a terminal task status. Paused attention is not
 *  terminal: it surfaces as waiting progress so the card stays live. */
export function piNotifyTerminalStatus(
  status: string | undefined,
): "completed" | "failed" | "stopped" | undefined {
  const s = status?.trim().toLowerCase();
  if (s === "completed") return "completed";
  if (s === "failed") return "failed";
  if (s === "stopped") return "stopped";
  return undefined;
}

/**
 * Translate a parsed completion wake into roster rows. Members reconcile to
 * the stable `<runId>:wf:<key>` identity launch rows use, so completions land
 * on existing cards instead of forking duplicates. Pure and total.
 */
export function describeNotifyReading(
  reading: PiNotifyReading,
): ReadonlyArray<PiSubagentTaskDescriptor> {
  const workflowRunId = reading.workflowRunId;
  if (workflowRunId === undefined) return [];
  const children = reading.childRuns;
  const descriptors: Array<PiSubagentTaskDescriptor> = [];
  const terminal = piNotifyTerminalStatus(reading.status);
  if (terminal !== undefined) {
    const failedKids = children.filter((c) => c.status?.trim().toLowerCase() === "failed").length;
    descriptors.push({
      type: "task.completed",
      payload: {
        taskId: RuntimeTaskId.make(workflowRunId),
        status: terminal,
        ...(failedKids > 0 ? { summary: `${failedKids}/${children.length} failed` } : undefined),
        taskType: "local_workflow",
        title: `Workflow ${piShortId(workflowRunId)}`,
        runHandles: { runId: workflowRunId },
      },
    });
  } else {
    descriptors.push({
      type: "task.progress",
      payload: {
        taskId: RuntimeTaskId.make(workflowRunId),
        description: `Workflow ${piShortId(workflowRunId)}`,
        status: reading.status.trim().toLowerCase() === "paused" ? "waiting" : "running",
        taskType: "local_workflow",
        title: `Workflow ${piShortId(workflowRunId)}`,
      },
    });
  }
  for (const child of children) {
    const stableId =
      child.workflowKey !== undefined
        ? piWorkflowMemberId(workflowRunId, child.workflowKey)
        : child.runId;
    if (!stableId) continue;
    const terminalChild = piNotifyTerminalStatus(child.status);
    if (terminalChild !== undefined) {
      descriptors.push({
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.make(stableId),
          status: terminalChild,
          taskType: "subagent",
          ...(child.agent
            ? { role: child.agent, title: child.agent }
            : { title: child.workflowKey ?? `Child ${piShortId(child.runId)}` }),
          parentAgentId: workflowRunId,
          ...(child.runId ? { runHandles: { runId: child.runId } } : undefined),
        },
      });
    } else {
      descriptors.push({
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make(stableId),
          description: child.agent ?? child.workflowKey ?? `Child ${piShortId(child.runId)}`,
          ...(child.agent ? { role: child.agent } : undefined),
          taskType: "subagent",
          parentAgentId: workflowRunId,
          status: piChildStatus(child.status) ?? "running",
          ...(child.runId ? { runHandles: { runId: child.runId } } : undefined),
        },
      });
    }
  }
  return descriptors;
}

export function piNotifyContentText(content: unknown): string | undefined {
  if (RuntimePredicate.isString(content)) return content.trim().length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: Array<string> = [];
  for (const block of content) {
    const record = piRecord(block);
    if (
      record?.type === "text" &&
      RuntimePredicate.isString(record.text) &&
      record.text.trim().length > 0
    ) {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Extract `subagent-notify`-typed message contents from a transcript. The hook
 * is generic (SDK-level `messages`); only the `customType` string is
 * dialect-specific. Extensions deliver completions as text (structured details
 * do not survive the session round-trip), so callers parse with
 * `parseDialectNotify` and apply with `describeNotifyReading`.
 */
export function collectPiNotifyContents(
  messages: unknown,
  customMessageType = "subagent-notify",
): ReadonlyArray<string> {
  if (!Array.isArray(messages)) return [];
  const out: Array<string> = [];
  for (const entry of messages) {
    const message = piRecord(entry);
    if (!message || message.role !== "custom" || message.customType !== customMessageType) continue;
    const text = piNotifyContentText(message.content);
    if (text !== undefined) out.push(text);
  }
  return out;
}
