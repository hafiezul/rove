/**
 * Pi subagent dialects — provider-neutral framework for Agents-tab observability.
 *
 * Pi's SDK has no first-class subagent lifecycle: it exposes tool calls and a
 * message transcript, while each subagent extension reports children through
 * its own tool result shape. Per-child tracking therefore requires per-shape
 * knowledge, but that knowledge must not leak into the adapter core. This
 * module owns the neutral half:
 *
 * - the shared `task.*` descriptor vocabulary the roster fold consumes;
 * - small total parsing primitives;
 * - the `PiSubagentDialect` interface and dispatch over a registry.
 *
 * The adapter core (`PiAdapter.ts`) only transports: it resolves tool args and
 * emits whatever the registry returns. Rove recognizes the result shape of
 * Pi's own `examples/extensions/subagent`; extensions that report the same
 * shape get Agents rows for free. Tools no dialect claims render as ordinary
 * tool rows, which always settle with their tool result.
 *
 * @module provider/Layers/PiSubagentDialects
 */
import {
  type RuntimeTaskUsage,
  type TaskCompletedPayload,
  type TaskProgressPayload,
  type TaskStartedPayload,
  type TaskUpdatedPayload,
} from "@rove-code/contracts";
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
  readonly phase?: "update" | "result";
  /** The tool ended without a final child result after an identified update. */
  readonly interrupted?: boolean;
}

/**
 * One subagent extension's observability dialect. All methods are pure and
 * total: malformed payloads yield no descriptors, never throw, so synthesis
 * can never break the tool row it rides on.
 */
export interface PiSubagentDialect {
  readonly name: string;
  /** Tool names this dialect can inspect (e.g. `subagent`). */
  readonly toolNames: ReadonlySet<string>;
  /** Positively identify this extension from the tool payload, not its name alone. */
  matchesTool(input: PiSubagentToolInput): boolean;
  /** Roster rows for one tool result. */
  describeToolTasks(input: PiSubagentToolInput): ReadonlyArray<PiSubagentTaskDescriptor>;
}

/** First dialect whose name and payload shape identify this tool. */
function findToolDialect(
  dialects: ReadonlyArray<PiSubagentDialect>,
  input: PiSubagentToolInput,
): PiSubagentDialect | undefined {
  return dialects.find(
    (dialect) => dialect.toolNames.has(input.toolName) && dialect.matchesTool(input),
  );
}

/** Roster rows for one tool result via the claiming dialect (none = []). */
export function describeDialectToolTasks(
  dialects: ReadonlyArray<PiSubagentDialect>,
  input: PiSubagentToolInput,
): ReadonlyArray<PiSubagentTaskDescriptor> {
  return findToolDialect(dialects, input)?.describeToolTasks(input) ?? [];
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

const PI_TASK_SUMMARY_LIMIT = 180;

export function piBounded(value: string, limit: number = PI_TASK_SUMMARY_LIMIT): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function piUsageToTypedUsage(value: unknown): RuntimeTaskUsage | undefined {
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
