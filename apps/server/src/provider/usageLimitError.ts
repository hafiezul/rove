import { ProviderUsageLimit } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const decodeStructuredError = Schema.decodeUnknownOption(
  Schema.Struct({
    error: Schema.Struct({
      code: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      resets_at: Schema.optional(Schema.Number),
      resets_in_seconds: Schema.optional(Schema.Number),
    }),
  }),
);

function futureReset(resetMs: number | null, observedMs: number): string | null {
  return resetMs !== null &&
    Number.isFinite(resetMs) &&
    resetMs > observedMs &&
    resetMs <= 8640000000000000
    ? DateTime.formatIso(DateTime.makeUnsafe(resetMs))
    : null;
}

/**
 * Reads an upstream `{ error: { type | code, resets_at | resets_in_seconds } }`
 * body, such as Codex's HTTP 429 body or its WebSocket `error` event.
 */
export function usageLimitFromErrorPayload(
  payload: unknown,
  observedAt: string,
): ProviderUsageLimit | null {
  const observedMs = Date.parse(observedAt);
  const decoded = decodeStructuredError(payload);
  if (!Number.isFinite(observedMs) || Option.isNone(decoded)) return null;
  const error = decoded.value.error;
  if (!/^(?:usage_limit_reached|rate_limit_exceeded)$/.test(error.code ?? error.type ?? ""))
    return null;
  const resetMs =
    error.resets_at !== undefined
      ? error.resets_at * 1000
      : error.resets_in_seconds !== undefined
        ? observedMs + error.resets_in_seconds * 1000
        : null;
  return { resetAt: futureReset(resetMs, observedMs) };
}

export function usageLimitFromError(
  message: string,
  observedAt: string,
): ProviderUsageLimit | null {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return null;
  if (
    /\b(?:usage_not_included|insufficient_quota|billing|payment required|subscription required|authentication|unauthorized)\b/i.test(
      message,
    )
  )
    return null;
  try {
    const payload: unknown = JSON.parse(message);
    if (Option.isSome(decodeStructuredError(payload)))
      return usageLimitFromErrorPayload(payload, observedAt);
  } catch {
    // Pi's SDK replaces the upstream JSON with a human-readable limit message.
  }
  if (!/\b(?:usage limit|rate limit|usage_limit_reached|rate_limit_exceeded)\b/i.test(message))
    return null;
  let resetMs: number | null = null;
  const duration =
    /(?:try again in|resets? in)\s*(~)?\s*((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|h|minutes?|mins?|m|seconds?|secs?|s)\s*)+)/i.exec(
      message,
    );
  if (duration) {
    let delayMs = 0;
    for (const part of duration[2]!.matchAll(
      /(\d+(?:\.\d+)?)\s*(days?|d|hours?|h|minutes?|mins?|m|seconds?|secs?|s)/gi,
    )) {
      const unit = part[2]!.toLowerCase()[0];
      delayMs +=
        Number(part[1]) *
        (unit === "d" ? 86400000 : unit === "h" ? 3600000 : unit === "m" ? 60000 : 1000);
    }
    if (delayMs > 0) resetMs = observedMs + delayMs + (duration[1] ? 60000 : 0);
  }
  return { resetAt: futureReset(resetMs, observedMs) };
}
