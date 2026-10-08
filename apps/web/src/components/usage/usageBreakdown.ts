import { isModelCostUnknown, type ModelTotals } from "@rove-code/shared/usageMerge";

export type ModelSortKey = "cost" | "tokens" | "responses" | "cacheHit";

/** Share of all input tokens served from cache, or null without input. */
export function cacheHitRate(totals: {
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly uncachedInputTokens: number;
}): number | null {
  const input = totals.cachedInputTokens + totals.cacheCreationTokens + totals.uncachedInputTokens;
  return input === 0 ? null : totals.cachedInputTokens / input;
}

function sortValue(model: ModelTotals, key: ModelSortKey): number {
  switch (key) {
    case "cost":
      // Unknown cost is not zero cost; keep it below every priced model.
      return isModelCostUnknown(model) ? -1 : model.costUsd;
    case "tokens":
      return model.totalTokens;
    case "responses":
      return model.records;
    case "cacheHit":
      return cacheHitRate(model) ?? -1;
  }
}

/** Descending by `key`, ties broken by tokens then cost. Leaves the input alone. */
export function sortModels(models: readonly ModelTotals[], key: ModelSortKey) {
  return models.toSorted(
    (left, right) =>
      sortValue(right, key) - sortValue(left, key) ||
      right.totalTokens - left.totalTokens ||
      right.costUsd - left.costUsd,
  );
}
