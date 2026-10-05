import type { ServerProviderUsageLimits } from "@rove-code/contracts";
import * as DateTime from "effect/DateTime";

export type UsageLimitStatus =
  | { readonly type: "available" }
  | { readonly type: "limited"; readonly resetAt: string | null }
  | { readonly type: "unavailable" };

export function usageLimitStatusFromWindows(
  limits: ServerProviderUsageLimits | undefined,
  model: string,
  observedAt: string,
): UsageLimitStatus {
  if (
    limits === undefined ||
    limits.unavailable !== undefined ||
    Date.parse(limits.checkedAt) < Date.parse(observedAt)
  ) {
    return { type: "unavailable" };
  }
  const windows = limits.windows.filter((window) =>
    window.id.includes("opus")
      ? model.includes("opus")
      : window.id.includes("sonnet")
        ? model.includes("sonnet")
        : true,
  );
  if (windows.length === 0) return { type: "unavailable" };
  const blocking = windows.filter((window) => window.usedPercent >= 100);
  if (blocking.length === 0) return { type: "available" };
  const resets = blocking.map((window) =>
    window.resetsAt === undefined ? NaN : Date.parse(window.resetsAt),
  );
  return {
    type: "limited",
    resetAt: resets.every((at) => Number.isFinite(at) && at > Date.parse(observedAt))
      ? DateTime.formatIso(DateTime.makeUnsafe(Math.max(...resets)))
      : null,
  };
}
