import { EventId, TurnId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { type ContextWindowSnapshot, deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ closeDelay, render }: { closeDelay: number; render: ReactNode }) => (
    <div data-close-delay={closeDelay}>{render}</div>
  ),
}));

const usage = deriveLatestContextWindowSnapshot([
  {
    id: EventId.make("activity-1"),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context updated",
    payload: { usedTokens: 100_000, maxTokens: 1_000_000 },
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-08-24T12:00:00.000Z",
  },
]);

if (!usage) {
  throw new Error("The context window test fixture did not produce a snapshot.");
}

describe("ContextWindowMeter", () => {
  it("keeps the hover popover open while the pointer moves to the compact button", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usage} onCompact={() => {}} />);

    expect(markup).toContain('data-close-delay="150"');
    expect(markup).toContain("Compact context");
  });

  it("closes an informational hover popover without delay", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usage} />);

    expect(markup).toContain('data-close-delay="0"');
    expect(markup).not.toContain("Compact context");
  });

  it("explains why the compact action is disabled", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={usage}
        onCompact={() => {}}
        compactDisabled
        compactDisabledReason="Send or clear your draft before compacting"
      />,
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain(">Send or clear your draft before compacting<");
    expect(markup).not.toContain('aria-label="Send or clear your draft before compacting"');
  });
});

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
    cacheCreationTokens: null,
    tokenBreakdownScope: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastCacheCreationTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: false,
    autoCompactThreshold: null,
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
        modelDisplayName="Pi"
      />,
    );

    expect(markup).toContain('aria-label="Context window usage unavailable"');
    expect(markup).not.toContain('aria-label="Context window 0 tokens used"');
  });
});
