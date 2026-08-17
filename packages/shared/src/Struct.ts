import * as P from "effect/Predicate";
import type { Json as SchemaJson } from "effect/Schema";

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

interface MutableMergeRecord {
  [key: string]: SchemaJson | undefined;
}

export function deepMerge<T extends Record<string, SchemaJson>>(
  current: T,
  patch: DeepPartial<T>,
): T {
  if (!P.isObject(current) || !P.isObject(patch)) {
    // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    return patch as T;
  }

  const next: MutableMergeRecord = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;

    const existing = next[key];
    next[key] = P.isObject(existing) && P.isObject(value) ? deepMerge(existing, value) : value;
  }

  // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
  return next as T;
}
