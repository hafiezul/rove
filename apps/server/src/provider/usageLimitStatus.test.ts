import { describe, expect, it } from "vite-plus/test";
import { usageLimitStatusFromWindows } from "./usageLimitStatus.ts";

const now = "2026-10-03T00:00:00.000Z";
const window = {
  id: "primary",
  kind: "session" as const,
  label: "Session",
  usedPercent: 100,
  resetsAt: "2026-10-03T02:00:00.000Z",
};

describe("fresh provider quota evidence", () => {
  it("rejects cached and unavailable snapshots", () => {
    expect(usageLimitStatusFromWindows(undefined, "gpt-5.4", now)).toEqual({ type: "unavailable" });
    expect(
      usageLimitStatusFromWindows(
        { checkedAt: "2026-10-02T23:59:59.000Z", windows: [window] },
        "gpt-5.4",
        now,
      ),
    ).toEqual({ type: "unavailable" });
    expect(
      usageLimitStatusFromWindows(
        { checkedAt: now, windows: [window], unavailable: { reason: "probeFailed" } },
        "gpt-5.4",
        now,
      ),
    ).toEqual({ type: "unavailable" });
  });
  it("waits for all blocking windows and detects restored quota", () => {
    expect(
      usageLimitStatusFromWindows(
        {
          checkedAt: now,
          windows: [
            window,
            { ...window, id: "weekly", kind: "weekly", resetsAt: "2026-10-10T00:00:00.000Z" },
          ],
        },
        "gpt-5.4",
        now,
      ),
    ).toEqual({ type: "limited", resetAt: "2026-10-10T00:00:00.000Z" });
    expect(
      usageLimitStatusFromWindows(
        { checkedAt: now, windows: [{ ...window, usedPercent: 0 }] },
        "gpt-5.4",
        now,
      ),
    ).toEqual({ type: "available" });
  });
  it("does not invent a reset or treat expired exhausted quota as available", () => {
    expect(
      usageLimitStatusFromWindows(
        { checkedAt: now, windows: [{ ...window, resetsAt: "2026-10-02T00:00:00.000Z" }] },
        "gpt-5.4",
        now,
      ),
    ).toEqual({ type: "limited", resetAt: null });
  });
});
