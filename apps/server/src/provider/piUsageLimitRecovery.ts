import type { ProviderUsageLimit } from "@rove-code/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { usageLimitStatusFromWindows, type UsageLimitStatus } from "./usageLimitStatus.ts";

const QuotaWindow = Schema.Struct({
  used_percent: Schema.Number,
  reset_at: Schema.optional(Schema.NullOr(Schema.Number)),
  reset_after_seconds: Schema.optional(Schema.NullOr(Schema.Number)),
});
const QuotaResponse = Schema.Struct({
  rate_limit: Schema.Struct({
    allowed: Schema.optional(Schema.Boolean),
    limit_reached: Schema.optional(Schema.Boolean),
    primary_window: Schema.optional(Schema.NullOr(QuotaWindow)),
    secondary_window: Schema.optional(Schema.NullOr(QuotaWindow)),
  }),
});
const decodeQuota = Schema.decodeUnknownOption(QuotaResponse);
// Decoded apart from `rate_limit` so an unexpected entry cannot hide the account windows.
const decodeModelUsage = Schema.decodeUnknownOption(
  Schema.Struct({
    model_usage: Schema.Record(
      Schema.String,
      Schema.Struct({
        available: Schema.Boolean,
        // Undocumented; observed as an ISO string, while other wham timestamps are epoch seconds.
        available_at: Schema.optional(Schema.Unknown),
      }),
    ),
  }),
);
const decodeEpochSeconds = Schema.decodeUnknownOption(Schema.Number);
const decodeTimestamp = Schema.decodeUnknownOption(Schema.String);
const decodeAccount = Schema.decodeUnknownOption(
  Schema.Struct({
    "https://api.openai.com/auth": Schema.Struct({ chatgpt_account_id: Schema.String }),
  }),
);

export function quotaResetAt(payload: unknown, observedAt: string): string | null {
  const decoded = decodeQuota(payload);
  const nowMs = Date.parse(observedAt);
  if (Option.isNone(decoded) || !Number.isFinite(nowMs)) return null;
  const windows = [
    decoded.value.rate_limit.primary_window,
    decoded.value.rate_limit.secondary_window,
  ]
    .filter((window) => window != null)
    .filter((window) => window.used_percent >= 100);
  if (windows.length === 0) return null;
  const resets = windows.map((window) =>
    window.reset_at != null
      ? window.reset_at * 1000
      : window.reset_after_seconds != null
        ? nowMs + window.reset_after_seconds * 1000
        : NaN,
  );
  if (resets.some((reset) => !Number.isFinite(reset) || reset <= nowMs || reset > 8640000000000000))
    return null;
  return DateTime.formatIso(DateTime.makeUnsafe(Math.max(...resets)));
}

const ClaudeWindow = Schema.Struct({
  utilization: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resets_at: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeClaudeQuota = Schema.decodeUnknownOption(
  Schema.Struct({
    five_hour: Schema.optional(Schema.NullOr(ClaudeWindow)),
    seven_day: Schema.optional(Schema.NullOr(ClaudeWindow)),
    seven_day_opus: Schema.optional(Schema.NullOr(ClaudeWindow)),
    seven_day_sonnet: Schema.optional(Schema.NullOr(ClaudeWindow)),
    seven_day_oauth_apps: Schema.optional(Schema.NullOr(ClaudeWindow)),
  }),
);

export function piQuotaStatus(
  payload: unknown,
  observedAt: string,
  model?: string,
): UsageLimitStatus {
  const account = accountQuotaStatus(payload, observedAt);
  if (model === undefined) return account;
  const usage = decodeModelUsage(payload);
  const entry = Option.isSome(usage) ? usage.value.model_usage[model] : undefined;
  if (entry === undefined || entry.available) return account;
  const availableAt = entry.available_at;
  const availableMs = decodeEpochSeconds(availableAt).pipe(
    Option.map((seconds) => seconds * 1000),
    Option.orElse(() => decodeTimestamp(availableAt).pipe(Option.map(Date.parse))),
    Option.getOrElse(() => NaN),
  );
  const modelReset =
    Number.isFinite(availableMs) &&
    availableMs > Date.parse(observedAt) &&
    availableMs <= 8640000000000000
      ? DateTime.formatIso(DateTime.makeUnsafe(availableMs))
      : null;
  if (account.type !== "limited") return { type: "limited", resetAt: modelReset };
  return {
    type: "limited",
    resetAt:
      account.resetAt === null || modelReset === null
        ? null
        : account.resetAt > modelReset
          ? account.resetAt
          : modelReset,
  };
}

function accountQuotaStatus(payload: unknown, observedAt: string): UsageLimitStatus {
  const decoded = decodeQuota(payload);
  if (Option.isNone(decoded)) return { type: "unavailable" };
  const windows = [
    decoded.value.rate_limit.primary_window,
    decoded.value.rate_limit.secondary_window,
  ].filter((window) => window != null);
  if (decoded.value.rate_limit.limit_reached === true || decoded.value.rate_limit.allowed === false)
    return { type: "limited", resetAt: quotaResetAt(payload, observedAt) };
  if (decoded.value.rate_limit.allowed === true && decoded.value.rate_limit.limit_reached === false)
    return { type: "available" };
  if (windows.length === 0 || windows.some((window) => !Number.isFinite(window.used_percent)))
    return { type: "unavailable" };
  return windows.some((window) => window.used_percent >= 100)
    ? { type: "limited", resetAt: quotaResetAt(payload, observedAt) }
    : { type: "available" };
}

export async function readPiSubscriptionStatus(
  input: {
    baseUrl: string;
    apiKey: string;
    headers?: Readonly<Record<string, string | null>>;
    observedAt: string;
    signal: AbortSignal;
    model?: string;
  },
  fetchQuota: typeof fetch = fetch,
): Promise<UsageLimitStatus> {
  const url = new URL(input.baseUrl);
  if (url.origin === "https://api.anthropic.com") {
    const response = await fetchQuota("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${input.apiKey}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: input.signal,
      redirect: "error",
    });
    if (!response.ok) return { type: "unavailable" };
    const quota = decodeClaudeQuota(await response.json());
    if (Option.isNone(quota)) return { type: "unavailable" };
    const windows = Object.entries(quota.value).flatMap(([id, window]) => {
      if (window == null) return [];
      const base = { id, kind: "other" as const, label: id, usedPercent: window.utilization };
      return window.resets_at == null ? [base] : [{ ...base, resetsAt: window.resets_at }];
    });
    return usageLimitStatusFromWindows(
      { checkedAt: input.observedAt, windows },
      input.model ?? "",
      input.observedAt,
    );
  }
  if (url.origin !== "https://chatgpt.com" || !url.pathname.startsWith("/backend-api"))
    return { type: "unavailable" };
  let accountId = Object.entries(input.headers ?? {}).find(
    ([key]) => key.toLowerCase() === "chatgpt-account-id",
  )?.[1];
  if (!accountId) {
    try {
      const payload = input.apiKey.split(".")[1];
      if (payload === undefined) return { type: "unavailable" };
      const account = decodeAccount(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
      if (Option.isNone(account)) return { type: "unavailable" };
      accountId = account.value["https://api.openai.com/auth"].chatgpt_account_id;
    } catch {
      return { type: "unavailable" };
    }
  }
  const response = await fetchQuota("https://chatgpt.com/backend-api/wham/usage", {
    headers: { Authorization: `Bearer ${input.apiKey}`, "ChatGPT-Account-Id": accountId },
    signal: input.signal,
    redirect: "error",
  });
  return response.ok
    ? piQuotaStatus(await response.json(), input.observedAt, input.model)
    : { type: "unavailable" };
}

export async function readPiSubscriptionLimit(
  input: {
    baseUrl: string;
    apiKey: string;
    headers?: Readonly<Record<string, string | null>>;
    observedAt: string;
    signal: AbortSignal;
  },
  fetchQuota: typeof fetch = fetch,
): Promise<ProviderUsageLimit | null> {
  const status = await readPiSubscriptionStatus(input, fetchQuota);
  return status.type === "limited" && status.resetAt !== null ? { resetAt: status.resetAt } : null;
}
