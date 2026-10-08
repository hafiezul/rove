import type { ModelTotals } from "@rove-code/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { cacheHitRate, sortModels } from "./usageBreakdown";

const model = (
  name: string,
  totalTokens: number,
  costUsd: number,
  overrides: Partial<ModelTotals> = {},
): ModelTotals => ({
  model: name,
  provider: "codex",
  costUsd,
  totalTokens,
  records: 1,
  unpricedRecords: 0,
  costShare: 0,
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  ...overrides,
});

describe("sortModels", () => {
  it("sorts by tokens, breaks ties by cost, and leaves the input alone", () => {
    const models = [
      model("lower-cost", 100, 1),
      model("more-tokens", 200, 2),
      model("higher-cost", 100, 3),
    ];

    expect(sortModels(models, "tokens").map((item) => item.model)).toEqual([
      "more-tokens",
      "higher-cost",
      "lower-cost",
    ]);
    expect(models.map((item) => item.model)).toEqual(["lower-cost", "more-tokens", "higher-cost"]);
  });

  it("ranks unpriced models below free priced ones by cost", () => {
    const models = [
      model("unpriced", 900, 0, { unpricedRecords: 1 }),
      model("free", 10, 0),
      model("paid", 10, 5),
    ];
    expect(sortModels(models, "cost").map((item) => item.model)).toEqual([
      "paid",
      "free",
      "unpriced",
    ]);
  });

  it("ranks models without input last by cache hit rate", () => {
    const models = [
      model("none", 10, 0),
      model("half", 10, 0, { cachedInputTokens: 5, uncachedInputTokens: 5 }),
      model("most", 10, 0, { cachedInputTokens: 9, cacheCreationTokens: 1 }),
    ];
    expect(sortModels(models, "cacheHit").map((item) => item.model)).toEqual([
      "most",
      "half",
      "none",
    ]);
    expect(cacheHitRate(models[0]!)).toBeNull();
  });
});
