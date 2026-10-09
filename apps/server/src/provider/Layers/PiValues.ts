/**
 * Small total readers for untyped Pi SDK payloads.
 *
 * @module provider/Layers/PiValues
 */
import * as RuntimePredicate from "effect/Predicate";
import type { Json as SchemaJson } from "effect/Schema";

export function piRecord(value: unknown): Record<string, SchemaJson> | undefined {
  // SAFETY: Callers narrow through this gate before field access.
  return RuntimePredicate.isObjectOrArray(value) && !Array.isArray(value)
    ? (value as Record<string, SchemaJson>)
    : undefined;
}

export function piTrimmed(value: unknown): string | undefined {
  return RuntimePredicate.isString(value) && value.trim().length > 0 ? value.trim() : undefined;
}

const PI_SUMMARY_LIMIT = 180;

export function piBounded(value: string, limit: number = PI_SUMMARY_LIMIT): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
