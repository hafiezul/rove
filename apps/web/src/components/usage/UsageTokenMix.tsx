import { useState } from "react";

import { formatPercent, formatTokens, formatUsd } from "@rove-code/shared/usageFormat";
import type { MergedUsage } from "@rove-code/shared/usageMerge";

import { cn } from "../../lib/utils";
import { cacheHitRate } from "./usageBreakdown";

type SegmentKey = "cachedInput" | "cacheCreation" | "uncachedInput" | "output";

/** Darker means pricier per token, so the bar reads as where cost comes from. */
const SEGMENTS = [
  { key: "cachedInput", label: "Cache reads", shade: "bg-foreground/20" },
  { key: "cacheCreation", label: "Cache writes", shade: "bg-foreground/45" },
  { key: "uncachedInput", label: "Uncached input", shade: "bg-foreground/70" },
  { key: "output", label: "Output", shade: "bg-foreground/95" },
] as const satisfies readonly { key: SegmentKey; label: string; shade: string }[];

function segmentValue(usage: MergedUsage, key: SegmentKey): number {
  switch (key) {
    case "cachedInput":
      return usage.cachedInputTokens;
    case "cacheCreation":
      return usage.cacheCreationTokens;
    case "uncachedInput":
      return usage.uncachedInputTokens;
    case "output":
      return usage.outputTokens;
  }
}

/** Token composition for the current focus, plus figures derived from it. */
export function UsageTokenMix({ usage }: { readonly usage: MergedUsage }) {
  const [active, setActive] = useState<SegmentKey | null>(null);
  const total = usage.totalTokens;
  const hitRate = cacheHitRate(usage);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Tokens</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatTokens(total)} processed
        </span>
      </div>

      <div
        className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={SEGMENTS.map(
          (segment) =>
            `${segment.label} ${formatPercent(total === 0 ? 0 : segmentValue(usage, segment.key) / total)}`,
        ).join(", ")}
      >
        {SEGMENTS.map((segment) => {
          const value = segmentValue(usage, segment.key);
          if (value === 0) return null;
          return (
            <span
              key={segment.key}
              className={cn(
                "h-full transition-opacity duration-150",
                segment.shade,
                active !== null && active !== segment.key && "opacity-30",
              )}
              style={{ flexGrow: value, flexBasis: 0, minWidth: 3 }}
              onPointerEnter={() => setActive(segment.key)}
              onPointerLeave={() => setActive(null)}
            />
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
        {SEGMENTS.map((segment) => {
          const value = segmentValue(usage, segment.key);
          return (
            <div
              key={segment.key}
              className={cn(
                "flex min-w-0 flex-col gap-0.5 transition-opacity duration-150",
                active !== null && active !== segment.key && "opacity-50",
              )}
              onPointerEnter={() => setActive(segment.key)}
              onPointerLeave={() => setActive(null)}
            >
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span aria-hidden className={cn("size-2 shrink-0 rounded-full", segment.shade)} />
                {segment.label}
              </span>
              <span className="text-base font-medium text-foreground tabular-nums">
                {formatTokens(value)}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatPercent(total === 0 ? 0 : value / total)} of tokens
              </span>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border/50 pt-4 md:grid-cols-4">
        <Figure
          label="Cache hit rate"
          value={hitRate === null ? "—" : formatPercent(hitRate)}
          detail="of input read from cache"
        />
        <Figure
          label="Cache savings"
          value={formatUsd(usage.costQuality.cacheSavingsUsd)}
          detail="vs. uncached input rates"
        />
        <Figure
          label="Reasoning"
          value={formatTokens(usage.reasoningTokens)}
          detail={
            usage.outputTokens === 0
              ? "of output"
              : `${formatPercent(usage.reasoningTokens / usage.outputTokens)} of output`
          }
        />
        <Figure
          label="Per response"
          value={usage.records === 0 ? "—" : formatUsd(usage.costUsd / usage.records)}
          detail={
            usage.records === 0
              ? "No responses"
              : `${formatTokens(total / usage.records)} tokens on average`
          }
        />
      </div>
    </section>
  );
}

function Figure({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-medium text-foreground tabular-nums">{value}</span>
      <span className="truncate text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}
