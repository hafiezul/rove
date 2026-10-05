import { describe, expect, it, vi } from "vite-plus/test";
import type { DailyTotals } from "@rove-code/shared/usageMerge";

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));

import { buildChartDays } from "./usageChartData";

const daily: readonly DailyTotals[] = [
  {
    day: "2026-08-01",
    costUsd: 7,
    totalTokens: 350,
    byProvider: new Map([
      ["codex", { costUsd: 5, totalTokens: 250 }],
      ["pi", { costUsd: 2, totalTokens: 100 }],
    ]),
  },
];

describe("Pi chart data", () => {
  it("includes Pi in provider bands and totals for both metrics", () => {
    const costs = buildChartDays(["2026-08-01", "2026-08-02"], daily, "cost");
    expect(costs[0]?.values.find((entry) => entry.provider === "pi")?.value).toBe(2);
    expect(costs.map((entry) => entry.total)).toEqual([7, 0]);
    const tokens = buildChartDays(["2026-08-01", "2026-08-02"], daily, "tokens");
    expect(tokens[0]?.values.find((entry) => entry.provider === "pi")?.value).toBe(100);
    expect(tokens.map((entry) => entry.total)).toEqual([350, 0]);
  });
});
