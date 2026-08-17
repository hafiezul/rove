import * as RuntimePredicate from "effect/Predicate";
import type { Json as SchemaJson } from "effect/Schema";
function isRecord(value: unknown): value is Record<string, SchemaJson> {
  return RuntimePredicate.isObjectOrArray(value) && !Array.isArray(value);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
