/**
 * Strict structural validator for `PickedElementPayload` messages received
 * from the in-page picker preload (`apps/desktop/src/preview/PickPreload.ts`)
 * via `wc.ipc`. Lives in its own electron-free module so the validator is
 * trivially unit-testable.
 *
 * Validation must be tight: downstream `normalizeElementContextSelection`
 * calls `.trim()` on incoming strings, so a malformed payload (preload bug,
 * future schema mismatch, malicious page that intercepts the preload's IPC
 * channel via prototype pollution) would otherwise throw deep in the
 * renderer and the chip silently never appears.
 */
import type { PickedElementPayload, PreviewAnnotationPayload } from "@t3tools/contracts";
import * as RuntimePredicate from "effect/Predicate";
import type { Json as SchemaJson } from "effect/Schema";

function isStringOrNull(value: unknown): value is string | null {
  return value === null || RuntimePredicate.isString(value);
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (RuntimePredicate.isNumber(value) && Number.isFinite(value));
}

function isPickedStackFrame(value: unknown): boolean {
  if (!RuntimePredicate.isObjectOrArray(value)) return false;
  const // SAFETY: The surrounding adapter has established this JSON-object view before field access.
    frame = value as Record<string, SchemaJson>;
  return (
    isStringOrNull(frame["functionName"]) &&
    isStringOrNull(frame["fileName"]) &&
    isFiniteNumberOrNull(frame["lineNumber"]) &&
    isFiniteNumberOrNull(frame["columnNumber"])
  );
}

export function isPickedElementPayload(value: unknown): value is PickedElementPayload {
  if (!RuntimePredicate.isObjectOrArray(value)) return false;
  const // SAFETY: The surrounding adapter has established this JSON-object view before field access.
    c = value as Record<string, SchemaJson>;
  if (!RuntimePredicate.isString(c["pageUrl"])) return false;
  if (!RuntimePredicate.isString(c["tagName"])) return false;
  if (!RuntimePredicate.isString(c["htmlPreview"])) return false;
  if (!RuntimePredicate.isString(c["styles"])) return false;
  if (!RuntimePredicate.isString(c["pickedAt"])) return false;
  if (!isStringOrNull(c["pageTitle"])) return false;
  if (!isStringOrNull(c["selector"])) return false;
  if (!isStringOrNull(c["componentName"])) return false;
  if (c["source"] !== null && !isPickedStackFrame(c["source"])) return false;
  if (!Array.isArray(c["stack"])) return false;
  if (!c["stack"].every(isPickedStackFrame)) return false;
  return true;
}

function isRect(value: unknown): boolean {
  if (!RuntimePredicate.isObjectOrArray(value)) return false;
  const // SAFETY: The surrounding adapter has established this JSON-object view before field access.
    rect = value as Record<string, SchemaJson>;
  return ["x", "y", "width", "height"].every(
    (key) => RuntimePredicate.isNumber(rect[key]) && Number.isFinite(rect[key]),
  );
}

function isPoint(value: unknown): boolean {
  if (!RuntimePredicate.isObjectOrArray(value)) return false;
  const // SAFETY: The surrounding adapter has established this JSON-object view before field access.
    point = value as Record<string, SchemaJson>;
  return (
    RuntimePredicate.isNumber(point["x"]) &&
    Number.isFinite(point["x"]) &&
    RuntimePredicate.isNumber(point["y"]) &&
    Number.isFinite(point["y"])
  );
}

export function isPreviewAnnotationPayload(value: unknown): value is PreviewAnnotationPayload {
  if (!RuntimePredicate.isObjectOrArray(value)) return false;
  const // SAFETY: The surrounding adapter has established this JSON-object view before field access.
    annotation = value as Record<string, SchemaJson>;
  if (!RuntimePredicate.isString(annotation["id"])) return false;
  if (!RuntimePredicate.isString(annotation["pageUrl"])) return false;
  if (!isStringOrNull(annotation["pageTitle"])) return false;
  if (!RuntimePredicate.isString(annotation["comment"])) return false;
  if (!RuntimePredicate.isString(annotation["createdAt"])) return false;
  if (annotation["screenshot"] !== null) return false;

  const elements = annotation["elements"];
  if (!Array.isArray(elements)) return false;
  if (
    !elements.every((entry) => {
      if (!RuntimePredicate.isObjectOrArray(entry)) return false;
      const // SAFETY: The surrounding adapter has established this JSON-object view before field access.
        target = entry as Record<string, SchemaJson>;
      return (
        RuntimePredicate.isString(target["id"]) &&
        isPickedElementPayload(target["element"]) &&
        isRect(target["rect"])
      );
    })
  ) {
    return false;
  }

  const regions = annotation["regions"];
  if (!Array.isArray(regions)) return false;
  if (
    !regions.every((entry) => {
      if (!RuntimePredicate.isObjectOrArray(entry)) return false;
      const // SAFETY: The surrounding adapter has established this JSON-object view before field access.
        target = entry as Record<string, SchemaJson>;
      return RuntimePredicate.isString(target["id"]) && isRect(target["rect"]);
    })
  ) {
    return false;
  }

  const strokes = annotation["strokes"];
  if (!Array.isArray(strokes)) return false;
  if (
    !strokes.every((entry) => {
      if (!RuntimePredicate.isObjectOrArray(entry)) return false;
      const // SAFETY: The surrounding adapter has established this JSON-object view before field access.
        target = entry as Record<string, SchemaJson>;
      return (
        RuntimePredicate.isString(target["id"]) &&
        RuntimePredicate.isString(target["color"]) &&
        RuntimePredicate.isNumber(target["width"]) &&
        Number.isFinite(target["width"]) &&
        Array.isArray(target["points"]) &&
        target["points"].every(isPoint) &&
        isRect(target["bounds"])
      );
    })
  ) {
    return false;
  }

  const styleChanges = annotation["styleChanges"];
  if (!Array.isArray(styleChanges)) return false;
  if (
    !styleChanges.every((entry) => {
      if (!RuntimePredicate.isObjectOrArray(entry)) return false;
      const // SAFETY: The surrounding adapter has established this JSON-object view before field access.
        change = entry as Record<string, SchemaJson>;
      return (
        RuntimePredicate.isString(change["targetId"]) &&
        isStringOrNull(change["selector"]) &&
        RuntimePredicate.isString(change["property"]) &&
        RuntimePredicate.isString(change["previousValue"]) &&
        RuntimePredicate.isString(change["value"])
      );
    })
  ) {
    return false;
  }
  return true;
}
