import * as Predicate from "effect/Predicate";

/** A stable label for JavaScript's complete set of runtime value categories. */
export type RuntimeValueKind =
  | "bigint"
  | "boolean"
  | "function"
  | "number"
  | "object"
  | "string"
  | "symbol"
  | "undefined";

/** Classifies a value for diagnostics without relying on an inline `typeof` check. */
export function runtimeValueKind<Value>(value: Value): RuntimeValueKind {
  if (Predicate.isUndefined(value)) return "undefined";
  if (Predicate.isString(value)) return "string";
  if (Predicate.isNumber(value)) return "number";
  if (Predicate.isBoolean(value)) return "boolean";
  if (Predicate.isBigInt(value)) return "bigint";
  if (Predicate.isSymbol(value)) return "symbol";
  if (Predicate.isFunction(value)) return "function";
  return "object";
}
