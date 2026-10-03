import { ProviderUsageLimit } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";

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

export function usageLimitFromError(
  message: string,
  observedAt: string,
): ProviderUsageLimit | null {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return null;
  let resetMs: number | null = null;
  let limited = /\b(?:usage limit|rate limit|usage_limit_reached|rate_limit_exceeded)\b/i.test(
    message,
  );
  if (
    /\b(?:usage_not_included|insufficient_quota|billing|payment required|subscription required|authentication|unauthorized)\b/i.test(
      message,
    )
  )
    return null;
  try {
    const decoded = decodeStructuredError(JSON.parse(message));
    if (decoded._tag === "Some") {
      const error = decoded.value.error;
      limited = /^(?:usage_limit_reached|rate_limit_exceeded)$/.test(
        error.code ?? error.type ?? "",
      );
      if (error.resets_at !== undefined) resetMs = error.resets_at * 1000;
      else if (error.resets_in_seconds !== undefined)
        resetMs = observedMs + error.resets_in_seconds * 1000;
    }
  } catch {
    // Pi's SDK replaces the upstream JSON with a human-readable limit message.
  }
  if (!limited) return null;
  if (resetMs === null) {
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
  }
  return {
    resetAt:
      resetMs !== null &&
      Number.isFinite(resetMs) &&
      resetMs > observedMs &&
      resetMs <= 8640000000000000
        ? DateTime.formatIso(DateTime.makeUnsafe(resetMs))
        : null,
  };
}
