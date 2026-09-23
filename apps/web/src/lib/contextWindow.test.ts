import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  contextWindowTokenCounters,
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
} from "./contextWindow";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
        autoCompactThreshold: 200_000,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
    expect(snapshot?.autoCompactThreshold).toBe(200_000);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("keeps valid zero-usage snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        maxTokens: 100_000,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      remainingTokens: 100_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  it("derives an intentional unknown context state without retaining stale usage", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-known", "context-window.updated", {
        usedTokens: 81_659,
        maxTokens: 400_000,
        inputTokens: 70_000,
        cachedInputTokens: 30_000,
        cacheCreationTokens: 500,
        tokenBreakdownScope: "activeBranch",
      }),
      makeActivity("activity-unknown", "context-window.updated", {
        contextUsageState: "unknown",
        contextUsageUnknownReason: "compacted",
        maxTokens: 400_000,
        totalProcessedTokens: 748_126,
        totalProcessedTokensScope: "activeBranch",
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: null,
      maxTokens: 400_000,
      usedPercentage: null,
      remainingTokens: null,
      contextUsageState: "unknown",
      contextUsageUnknownReason: "compacted",
      totalProcessedTokens: 748_126,
      totalProcessedTokensScope: "activeBranch",
      inputTokens: null,
      cachedInputTokens: null,
      cacheCreationTokens: null,
      tokenBreakdownScope: null,
    });
  });

  it("clears a previous meter when context-window metadata becomes unavailable", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-known", "context-window.updated", {
        usedTokens: 81_659,
        maxTokens: 400_000,
      }),
      makeActivity("activity-unavailable", "context-window.updated", {
        contextUsageState: "unavailable",
      }),
    ]);

    expect(snapshot).toBeNull();
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
    expect(formatContextWindowTokens(999_999)).toBe("1m");
  });

  it("separates uncached input from cache reads and writes without double-counting", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 130_000,
        maxTokens: 1_000_000,
        inputTokens: 36_948_000,
        cachedInputTokens: 32_000_000,
        cacheCreationTokens: 948_000,
        outputTokens: 130_000,
        tokenBreakdownScope: "activeBranch",
      }),
    ]);

    expect(snapshot?.tokenBreakdownScope).toBe("activeBranch");
    expect(snapshot && contextWindowTokenCounters(snapshot)).toEqual([
      { label: "Uncached input", value: 4_000_000 },
      { label: "Output", value: 130_000 },
      { label: "Cache read", value: 32_000_000 },
      { label: "Cache write", value: 948_000 },
    ]);
  });

  it("does not infer uncached input if cache writes are unreported", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 100,
        inputTokens: 400,
        cachedInputTokens: 300,
        outputTokens: 0,
        tokenBreakdownScope: "latestResponse",
      }),
    ]);

    expect(snapshot?.tokenBreakdownScope).toBe("latestResponse");
    expect(snapshot && contextWindowTokenCounters(snapshot)).toEqual([
      { label: "Input total", value: 400 },
      { label: "Cache read", value: 300 },
    ]);
  });

  it("shows zero uncached input when the entire reported input was cached", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 100,
        inputTokens: 400,
        cachedInputTokens: 400,
        cacheCreationTokens: 0,
      }),
    ]);

    expect(snapshot && contextWindowTokenCounters(snapshot)).toEqual([
      { label: "Uncached input", value: 0 },
      { label: "Cache read", value: 400 },
    ]);
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });
});
