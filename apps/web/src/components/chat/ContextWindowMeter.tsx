import { Button } from "../ui/button";
import {
  type ContextWindowSnapshot,
  contextWindowTokenCounters,
  formatContextWindowTokens,
} from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";
import { Minimize2Icon } from "lucide-react";
import { composerFloatingLayerProps } from "./composerEventScope";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const { usage, modelDisplayName, onCompact, compactDisabled, compactDisabledReason } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const isUnknownContextUsage = usage.contextUsageState === "unknown";
  const hasKnownContextUsage = usage.contextUsageState === "known" && usage.usedTokens !== null;
  const hasContextWindow = usage.maxTokens !== null;
  const normalizedPercentage = hasKnownContextUsage
    ? Math.max(0, Math.min(100, usage.usedPercentage ?? 0))
    : 0;
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const usedTokensLabel = formatContextWindowTokens(usage.usedTokens);
  const maxTokensLabel = formatContextWindowTokens(usage.maxTokens);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const totalProcessedTokensLabel = formatContextWindowTokens(totalProcessedTokens);
  const showTotalProcessed =
    totalProcessedTokens !== null &&
    totalProcessedTokens > 0 &&
    (!hasKnownContextUsage || totalProcessedTokensLabel !== usedTokensLabel);
  const totalProcessedLabel =
    usage.totalProcessedTokensScope === "activeBranch"
      ? "Processed on this branch"
      : "Total processed";
  const tokenCounters = contextWindowTokenCounters(usage);
  const tokenScope =
    usage.tokenBreakdownScope === "activeBranch"
      ? "This branch"
      : usage.tokenBreakdownScope === "latestResponse"
        ? "Latest response"
        : null;
  const isNearCapacity = hasKnownContextUsage && normalizedPercentage >= 75;
  const isOverloaded = hasKnownContextUsage && normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : isNearCapacity
      ? "var(--color-warning)"
      : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
  const usageTone = isOverloaded
    ? "text-error-foreground"
    : isNearCapacity
      ? "text-warning-foreground"
      : "text-muted-foreground";
  const usageSummary =
    !isUnknownContextUsage && usedPercentage !== null ? `${usedPercentage} used` : null;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7 rounded-full hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={
              isUnknownContextUsage
                ? "Context window usage unavailable"
                : usage.maxTokens !== null && usedPercentage !== null
                  ? `Context window ${usedPercentage} used`
                  : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-72 max-w-[calc(100vw-2rem)] text-left whitespace-normal"
      >
        <div className="flex flex-col gap-3 p-[var(--floating-content-inset)]">
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <div className="font-medium text-secondary-label text-xs">Context window</div>
              {usageSummary ? (
                <div className={`shrink-0 text-[11px] font-medium tabular-nums ${usageTone}`}>
                  {usageSummary}
                </div>
              ) : null}
            </div>
            <div className="mt-1 flex items-baseline gap-1.5 tabular-nums">
              {isUnknownContextUsage ? (
                <span className="font-medium text-foreground text-sm">Estimate pending</span>
              ) : (
                <span className="font-semibold text-foreground text-xl leading-none">
                  {usedTokensLabel}
                </span>
              )}
              <span className="text-secondary-label text-xs">
                {hasContextWindow ? `of ${maxTokensLabel} tokens` : "tokens in context"}
              </span>
            </div>
          </div>
          {hasContextWindow ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              {...(hasKnownContextUsage
                ? { "aria-valuenow": Math.round(normalizedPercentage) }
                : { "aria-valuetext": "Usage unavailable" })}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">{totalProcessedLabel}</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {totalProcessedTokensLabel}
              </span>
            </div>
          ) : null}
          {tokenCounters.length > 0 ? (
            <div className="border-border/50 border-t pt-2.5">
              <div className="flex items-baseline justify-between gap-2 text-secondary-label text-[11px]">
                <span>Token activity</span>
                {tokenScope ? <span>{tokenScope}</span> : null}
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-5 gap-y-2.5">
                {tokenCounters.map((counter) => (
                  <div key={counter.label} className="min-w-0">
                    <dt className="text-secondary-label text-[11px] leading-4">{counter.label}</dt>
                    <dd className="font-medium text-foreground text-sm leading-5 tabular-nums">
                      {formatContextWindowTokens(counter.value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          {isUnknownContextUsage ? (
            <div className="text-pretty text-secondary-label text-[11px] leading-4">
              {usage.contextUsageUnknownReason === "compacted"
                ? "Context was compacted. A fresh estimate appears after the next response."
                : "A fresh estimate appears after the next response."}
            </div>
          ) : usage.compactsAutomatically ? (
            <div className="text-pretty text-secondary-label text-[11px] leading-4">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </div>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-[11px]">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Holds the meter's footprint while a thread's activities are still loading. */
export function ContextWindowMeterPlaceholder() {
  return <span aria-hidden="true" className="size-7 shrink-0" />;
}
