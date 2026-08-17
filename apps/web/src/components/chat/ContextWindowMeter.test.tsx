import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import { type ContextWindowSnapshot } from "~/lib/contextWindow";

import { ContextWindowMeter } from "./ContextWindowMeter";

function makeUsage(overrides: Partial<ContextWindowSnapshot> = {}): ContextWindowSnapshot {
  return {
    contextUsageState: "known",
    contextUsageUnknownReason: null,
    usedTokens: 12_000,
    totalProcessedTokens: null,
    totalProcessedTokensScope: null,
    maxTokens: 200_000,
    remainingTokens: 188_000,
    usedPercentage: 6,
    remainingPercentage: 94,
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
    compactsAutomatically: false,
    updatedAt: "2026-03-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("ContextWindowMeter", () => {
  it("labels an unknown context reading without presenting it as zero usage", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={makeUsage({
          contextUsageState: "unknown",
          contextUsageUnknownReason: "compacted",
          usedTokens: null,
          usedPercentage: null,
          remainingTokens: null,
          remainingPercentage: null,
        })}
        providerDisplayName="Pi"
      />,
    );

    expect(markup).toContain('aria-label="Context window usage unavailable"');
    expect(markup).not.toContain('aria-label="Context window 0 tokens used"');
  });
});
