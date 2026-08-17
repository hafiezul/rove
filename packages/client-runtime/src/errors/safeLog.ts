import * as RuntimePredicate from "effect/Predicate";
const SAFE_ERROR_LABEL =
  /^(?:Error|EvalError|RangeError|ReferenceError|SyntaxError|TypeError|URIError|AggregateError|DOMException|[A-Za-z][A-Za-z0-9]*(?:Error|Failure))$/;
const SAFE_TRACE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const STACK_FRAME_LIMIT = 32;

export interface SafeErrorLogAttributes {
  readonly errorType: "error" | "array" | "null" | "object" | "primitive";
  readonly errorName?: string;
  readonly errorTag?: string;
  readonly traceId?: string;
  readonly stack?: string;
}

function readSafeLabel(value: unknown): string | undefined {
  return RuntimePredicate.isString(value) && SAFE_ERROR_LABEL.test(value) ? value : undefined;
}

function sanitizeStackUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function sanitizeStackFrame(frame: string): string {
  return frame.replace(/(?:https?|file):\/\/[^\s)]+/g, sanitizeStackUrl);
}

function readSafeStack(error: Error): string | undefined {
  try {
    const frames = error.stack
      ?.split(/\r?\n/)
      .filter((line) => /^\s*at\s+/.test(line) || /^[^@\s]+@(?:https?|file):\/\//.test(line))
      .slice(0, STACK_FRAME_LIMIT)
      .map(sanitizeStackFrame);
    return frames && frames.length > 0 ? frames.join("\n") : undefined;
  } catch {
    return undefined;
  }
}

function readErrorTag(error: unknown): string | undefined {
  try {
    if (!RuntimePredicate.isObjectOrArray(error)) {
      return undefined;
    }
    // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    return readSafeLabel((error as { readonly _tag?: unknown })._tag);
  } catch {
    return undefined;
  }
}

function readTraceId(error: unknown): string | undefined {
  try {
    const seen = new Set<object>();
    let current: unknown = error;

    while (RuntimePredicate.isObjectOrArray(current) && !seen.has(current)) {
      seen.add(current);
      const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
        record = current as { readonly cause?: unknown; readonly traceId?: unknown };
      if (RuntimePredicate.isString(record.traceId) && SAFE_TRACE_ID.test(record.traceId)) {
        return record.traceId;
      }
      current = record.cause;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

export function safeErrorLogAttributes(error: unknown): SafeErrorLogAttributes {
  const errorTag = readErrorTag(error);
  const traceId = readTraceId(error);

  if (error instanceof Error) {
    const errorName = readSafeLabel(error.name);
    const stack = readSafeStack(error);
    return {
      errorType: "error",
      ...(errorName !== undefined ? { errorName } : undefined),
      ...(errorTag !== undefined ? { errorTag } : undefined),
      ...(traceId !== undefined ? { traceId } : undefined),
      ...(stack !== undefined ? { stack } : undefined),
    };
  }

  return {
    errorType:
      error === null
        ? "null"
        : Array.isArray(error)
          ? "array"
          : RuntimePredicate.isObjectOrArray(error) || error === null
            ? "object"
            : "primitive",
    ...(errorTag !== undefined ? { errorTag } : undefined),
    ...(traceId !== undefined ? { traceId } : undefined),
  };
}
