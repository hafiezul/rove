import { describe, expect, it, vi } from "vite-plus/test";
import {
  quotaResetAt,
  readPiSubscriptionLimit,
  piQuotaStatus,
  readPiSubscriptionStatus,
} from "./piUsageLimitRecovery.ts";

const now = "2026-10-03T00:00:00.000Z";
const at = Date.parse(now) / 1000;
const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.test`;

describe("Pi subscription quota recovery", () => {
  it("distinguishes an early reset from unreadable quota", () => {
    expect(
      piQuotaStatus(
        { rate_limit: { primary_window: { used_percent: 0, reset_at: at + 3600 } } },
        now,
      ),
    ).toEqual({ type: "available" });
    expect(piQuotaStatus({ rate_limit: { allowed: true, limit_reached: false } }, now)).toEqual({
      type: "available",
    });
    expect(piQuotaStatus({ rate_limit: { allowed: false, limit_reached: true } }, now)).toEqual({
      type: "limited",
      resetAt: null,
    });
    expect(piQuotaStatus({}, now)).toEqual({ type: "unavailable" });
  });
  it("reads Anthropic subscription windows without sending a prompt", async () => {
    const quotaFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        five_hour: { utilization: 0, resets_at: "2026-10-03T05:00:00.000Z" },
        seven_day_opus: { utilization: 100, resets_at: "2026-10-10T00:00:00.000Z" },
      }),
    );
    const input = {
      baseUrl: "https://api.anthropic.com",
      apiKey: "synthetic-oauth-token",
      observedAt: now,
      signal: new AbortController().signal,
    };
    expect(
      await readPiSubscriptionStatus({ ...input, model: "claude-sonnet-4-6" }, quotaFetch),
    ).toEqual({ type: "available" });
    expect(
      await readPiSubscriptionStatus({ ...input, model: "claude-opus-4-6" }, quotaFetch),
    ).toEqual({ type: "limited", resetAt: "2026-10-10T00:00:00.000Z" });
    expect(
      quotaFetch.mock.calls.every(([url]) => url === "https://api.anthropic.com/api/oauth/usage"),
    ).toBe(true);
  });
  it("waits for every exhausted window, including weekly limits", () => {
    expect(
      quotaResetAt(
        {
          rate_limit: {
            primary_window: { used_percent: 100, reset_at: at + 3600 },
            secondary_window: { used_percent: 100, reset_at: at + 7 * 86400 },
          },
        },
        now,
      ),
    ).toBe("2026-10-10T00:00:00.000Z");
    expect(
      quotaResetAt(
        {
          rate_limit: {
            primary_window: { used_percent: 100, reset_after_seconds: 30 },
            secondary_window: { used_percent: 20, reset_at: at + 7 * 86400 },
          },
        },
        now,
      ),
    ).toBe("2026-10-03T00:00:30.000Z");
  });
  it("keeps ambiguous and expired quota data unscheduled", () => {
    for (const response of [
      null,
      {},
      { rate_limit: null },
      { rate_limit: { primary_window: { used_percent: 100 } } },
      { rate_limit: { primary_window: { used_percent: 100, reset_at: at - 1 } } },
      { rate_limit: { primary_window: { used_percent: 10, reset_at: at + 3600 } } },
      {
        rate_limit: {
          primary_window: { used_percent: 100, reset_at: at + 3600 },
          secondary_window: { used_percent: 100 },
        },
      },
    ]) {
      expect(quotaResetAt(response, now)).toBeNull();
    }
  });
  it("reads account quota without sending a model prompt", async () => {
    const quotaFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ rate_limit: { primary_window: { used_percent: 100, reset_at: at + 7200 } } }),
    );
    const result = await readPiSubscriptionLimit(
      {
        baseUrl: "https://chatgpt.com/backend-api",
        apiKey: token,
        observedAt: now,
        signal: new AbortController().signal,
      },
      quotaFetch,
    );
    expect(result).toEqual({ resetAt: "2026-10-03T02:00:00.000Z" });
    expect(quotaFetch).toHaveBeenCalledExactlyOnceWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": "synthetic-account" },
        redirect: "error",
      }),
    );
  });
  it("does not send subscription credentials to a custom endpoint", async () => {
    const quotaFetch = vi.fn<typeof fetch>();
    expect(
      await readPiSubscriptionLimit(
        {
          baseUrl: "https://custom.example/v1",
          apiKey: token,
          observedAt: now,
          signal: new AbortController().signal,
        },
        quotaFetch,
      ),
    ).toBeNull();
    expect(quotaFetch).not.toHaveBeenCalled();
  });
  it("leaves quota read failures unscheduled", async () => {
    const quotaFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 403 }));
    expect(
      await readPiSubscriptionLimit(
        {
          baseUrl: "https://chatgpt.com/backend-api",
          apiKey: token,
          observedAt: now,
          signal: new AbortController().signal,
        },
        quotaFetch,
      ),
    ).toBeNull();
  });
  it("honors a model-specific Codex limit while the account windows are open", async () => {
    const quotaFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 10, reset_at: at + 3600 },
        },
        model_usage: {
          "gpt-limited": { available: false, available_at: at + 7200 },
          "gpt-open": { available: true, available_at: null },
          "gpt-unknown-format": { available: false, available_at: "tomorrow" },
        },
      }),
    );
    const input = {
      baseUrl: "https://chatgpt.com/backend-api",
      apiKey: token,
      observedAt: now,
      signal: new AbortController().signal,
    };
    expect(await readPiSubscriptionStatus({ ...input, model: "gpt-limited" }, quotaFetch)).toEqual({
      type: "limited",
      resetAt: "2026-10-03T02:00:00.000Z",
    });
    expect(await readPiSubscriptionStatus({ ...input, model: "gpt-open" }, quotaFetch)).toEqual({
      type: "available",
    });
    expect(
      await readPiSubscriptionStatus({ ...input, model: "gpt-unknown-format" }, quotaFetch),
    ).toEqual({ type: "limited", resetAt: null });
  });
});
