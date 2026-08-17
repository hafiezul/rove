import type { OrchestrationThreadActivity } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export type ContextWindowSnapshot = {
  readonly contextUsageState: "known" | "unknown";
  readonly contextUsageUnknownReason: "compacted" | null;
  readonly usedTokens: number | null;
  readonly totalProcessedTokens: number | null;
  readonly totalProcessedTokensScope: "activeBranch" | null;
  readonly maxTokens: number | null;
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningOutputTokens: number | null;
  readonly lastUsedTokens: number | null;
  readonly lastInputTokens: number | null;
  readonly lastCachedInputTokens: number | null;
  readonly lastOutputTokens: number | null;
  readonly lastReasoningOutputTokens: number | null;
  readonly toolUses: number | null;
  readonly durationMs: number | null;
  readonly compactsAutomatically: boolean;
  readonly updatedAt: string;
};

/** Map a provider driver kind to a user-facing display name. */
export function formatProviderDisplayName(provider: string | null | undefined): string {
  if (!provider) return "This agent";
  switch (provider) {
    case "claudeAgent":
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
    default: {
      // Title-case unknown driver kinds so they read reasonably.
      const trimmed = provider.replace(/Agent$/i, "").trim();
      if (trimmed.length === 0) return provider;
      return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }
  }
}

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const contextUsageState = payload?.contextUsageState;
    if (contextUsageState === "unavailable") {
      return null;
    }

    const maxTokens = asFiniteNumber(payload?.maxTokens);
    if (contextUsageState === "unknown") {
      if (maxTokens === null || maxTokens <= 0) {
        continue;
      }

      return {
        contextUsageState: "unknown",
        contextUsageUnknownReason:
          payload?.contextUsageUnknownReason === "compacted" ? "compacted" : null,
        usedTokens: null,
        totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
        totalProcessedTokensScope:
          payload?.totalProcessedTokensScope === "activeBranch" ? "activeBranch" : null,
        maxTokens,
        remainingTokens: null,
        usedPercentage: null,
        remainingPercentage: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
        lastUsedTokens: null,
        lastInputTokens: null,
        lastCachedInputTokens: null,
        lastOutputTokens: null,
        lastReasoningOutputTokens: null,
        toolUses: null,
        durationMs: null,
        compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
        updatedAt: activity.createdAt,
      };
    }

    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens < 0) {
      continue;
    }

    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      contextUsageState: "known",
      contextUsageUnknownReason: null,
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
      totalProcessedTokensScope:
        payload?.totalProcessedTokensScope === "activeBranch" ? "activeBranch" : null,
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: asFiniteNumber(payload?.inputTokens),
      cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
      outputTokens: asFiniteNumber(payload?.outputTokens),
      reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
      lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(payload?.toolUses),
      durationMs: asFiniteNumber(payload?.durationMs),
      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
