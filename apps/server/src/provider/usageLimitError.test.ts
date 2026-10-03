import { describe, expect, it } from "vite-plus/test";
import { usageLimitFromError, usageLimitFromErrorPayload } from "./usageLimitError.ts";

const now = "2026-10-01T00:00:00.000Z";

describe("usageLimitFromError", () => {
  it("recognizes Pi SDK ChatGPT limits with a conservative rounding margin", () => {
    expect(
      usageLimitFromError(
        "You have hit your ChatGPT usage limit (plus plan). Try again in ~123 min.",
        now,
      ),
    ).toEqual({ resetAt: "2026-10-01T02:04:00.000Z" });
  });
  it("supports weekly and short windows without a fixed duration", () => {
    expect(
      usageLimitFromError("Codex usage limit reached. The weekly limit resets in 5d 5h.", now)
        ?.resetAt,
    ).toBe("2026-10-06T05:00:00.000Z");
    expect(usageLimitFromError("Rate limit reached. Try again in 30 seconds.", now)?.resetAt).toBe(
      "2026-10-01T00:00:30.000Z",
    );
  });
  it("preserves explicit upstream timestamps and relative reset seconds", () => {
    expect(
      usageLimitFromError(
        JSON.stringify({
          error: { type: "usage_limit_reached", resets_at: Date.parse(now) / 1000 + 7200 },
        }),
        now,
      )?.resetAt,
    ).toBe("2026-10-01T02:00:00.000Z");
    expect(
      usageLimitFromError(
        JSON.stringify({ error: { code: "rate_limit_exceeded", resets_in_seconds: 90 } }),
        now,
      )?.resetAt,
    ).toBe("2026-10-01T00:01:30.000Z");
  });
  it("reads Codex WebSocket limit events and ignores other stream events", () => {
    expect(
      usageLimitFromErrorPayload(
        {
          type: "error",
          status: 429,
          error: {
            type: "usage_limit_reached",
            message: "The usage limit has been reached",
            resets_at: Date.parse(now) / 1000 + 3600,
          },
        },
        now,
      ),
    ).toEqual({ resetAt: "2026-10-01T01:00:00.000Z" });
    expect(usageLimitFromErrorPayload({ type: "response.created" }, now)).toBeNull();
    expect(
      usageLimitFromErrorPayload({ type: "error", error: { type: "server_error" } }, now),
    ).toBeNull();
  });
  it("does not invent times for missing, expired, malformed, or zero windows", () => {
    for (const error of [
      "Usage limit reached.",
      "Codex error: The usage limit has been reached",
      "Usage limit reached. Try again in ~0 min.",
      JSON.stringify({ error: { code: "usage_limit_reached", resets_at: 1 } }),
    ]) {
      expect(usageLimitFromError(error, now)).toEqual({ resetAt: null });
    }
    expect(usageLimitFromError("Usage limit reached.", "invalid")).toBeNull();
  });
  it("does not schedule authentication, billing, or unrelated errors", () => {
    for (const error of [
      "429 overloaded",
      "Request failed",
      "Usage limit reached. Payment required",
      "insufficient_quota",
      JSON.stringify({ error: { code: "usage_not_included" } }),
    ]) {
      expect(usageLimitFromError(error, now)).toBeNull();
    }
  });
});
