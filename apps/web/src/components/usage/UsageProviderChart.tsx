import type { UsageProviderKind } from "@rove-code/contracts";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { DailyTotals, HourlyTotals } from "@rove-code/shared/usageMerge";
import {
  formatDayShort,
  formatHourShort,
  formatRelativeHourShort,
  formatTokens,
  formatUsd,
} from "@rove-code/shared/usageFormat";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;

export type UsageChartMetric = "tokens" | "cost";

interface UsageProviderChartProps {
  readonly providers: readonly UsageProviderKind[];
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly hours: readonly string[];
  readonly hourly: readonly HourlyTotals[];
  readonly metric: UsageChartMetric;
  readonly referenceTime: string | undefined;
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
  /** Inclusive focused period keys, drawn as a band over the plot. */
  readonly selection: UsagePeriodRange | null;
  readonly onSelectionChange: (selection: UsagePeriodRange | null) => void;
}

export interface UsagePeriodRange {
  readonly start: string;
  readonly end: string;
}

/**
 * Resolves a click or drag between two period indexes. Clicking the period that
 * is already the whole selection clears it, so a click is its own way out.
 */
export function resolvePeriodSelection(
  periods: readonly string[],
  anchor: number,
  current: number,
  selection: UsagePeriodRange | null,
): UsagePeriodRange | null {
  const start = periods[Math.min(anchor, current)];
  const end = periods[Math.max(anchor, current)];
  if (start === undefined || end === undefined) return null;
  if (start === end && selection?.start === start && selection.end === end) return null;
  return { start, end };
}

/** One day's per-provider values, shared by the paths and the hover readout. */
export interface DayColumn {
  readonly bands: readonly {
    readonly provider: UsageProviderKind;
    readonly value: number;
  }[];
  readonly total: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

function valueFor(
  totals: DailyTotals | HourlyTotals | undefined,
  provider: UsageProviderKind,
  metric: UsageChartMetric,
): number {
  const entry = totals?.byProvider.get(provider);
  if (entry === undefined) return 0;
  return metric === "tokens" ? entry.totalTokens : entry.costUsd;
}

export function buildPeriodColumns(
  periods: readonly string[],
  byPeriod: ReadonlyMap<string, DailyTotals | HourlyTotals>,
  metric: UsageChartMetric,
): readonly DayColumn[] {
  return periods.map((period) => {
    const entry = byPeriod.get(period);
    const bands = PROVIDER_ORDER.map((provider) => ({
      provider,
      value: valueFor(entry, provider, metric),
    }));
    return { bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
  });
}

/** Shape-preserving cubic tangents that cannot overshoot spiky usage data. */
function monotoneTangents(points: readonly Point[]): readonly number[] {
  const count = points.length;
  if (count < 2) return [0];

  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const dx = (points[index + 1]?.x ?? 0) - (points[index]?.x ?? 0);
    const dy = (points[index + 1]?.y ?? 0) - (points[index]?.y ?? 0);
    slopes.push(dx === 0 ? 0 : dy / dx);
  }

  const tangents: number[] = Array.from({ length: count }, () => 0);
  tangents[0] = slopes[0] ?? 0;
  tangents[count - 1] = slopes[count - 2] ?? 0;
  for (let index = 1; index < count - 1; index += 1) {
    const previous = slopes[index - 1] ?? 0;
    const next = slopes[index] ?? 0;
    tangents[index] = previous * next <= 0 ? 0 : (previous + next) / 2;
  }

  for (let index = 0; index < count - 1; index += 1) {
    const slope = slopes[index] ?? 0;
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const a = (tangents[index] ?? 0) / slope;
    const b = (tangents[index + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * a * slope;
      tangents[index + 1] = scale * b * slope;
    }
  }

  return tangents;
}

interface CurveSegment {
  readonly from: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly to: Point;
}

function smoothCurve(points: readonly Point[]): readonly CurveSegment[] {
  if (points.length < 2) return [];
  const tangents = monotoneTangents(points);
  const segments: CurveSegment[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (from === undefined || to === undefined) continue;
    const dx = to.x - from.x;
    segments.push({
      from,
      c1: { x: from.x + dx / 3, y: from.y + ((tangents[index] ?? 0) * dx) / 3 },
      c2: { x: to.x - dx / 3, y: to.y - ((tangents[index + 1] ?? 0) * dx) / 3 },
      to,
    });
  }
  return segments;
}

function curvePath(segments: readonly CurveSegment[]): string {
  const first = segments[0];
  if (first === undefined) return "";
  let path = `M${first.from.x.toFixed(2)},${first.from.y.toFixed(2)}`;
  for (const segment of segments) {
    path += ` C${segment.c1.x.toFixed(2)},${segment.c1.y.toFixed(2)} ${segment.c2.x.toFixed(2)},${segment.c2.y.toFixed(2)} ${segment.to.x.toFixed(2)},${segment.to.y.toFixed(2)}`;
  }
  return path;
}

/**
 * Builds a scale whose maximum is a readable 1/2/5 x 10^n step at or above the
 * peak.
 *
 * Rounding the maximum *up* is the point: stopping at the last step below the
 * peak leaves the tallest day drawn past the top of the plot, where it is
 * clipped.
 */
export function niceScale(peak: number, count: number) {
  if (peak <= 0) return { max: 0, ticks: [0] };

  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;

  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

export function UsageProviderChart({
  providers,
  days,
  daily,
  hours,
  hourly,
  metric,
  referenceTime,
  resolution,
  timeZone,
  selection,
  onSelectionChange,
}: UsageProviderChartProps) {
  const periods = resolution === "hour" ? hours : days;
  const byPeriod = useMemo(
    () =>
      resolution === "hour"
        ? new Map(hourly.map((entry) => [entry.hourStart, entry]))
        : new Map(daily.map((entry) => [entry.day, entry])),
    [daily, hourly, resolution],
  );
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ anchor: number; current: number } | null>(null);

  const { paths, ticks, stepX, toY, series } = useMemo(() => {
    if (periods.length === 0) {
      return {
        paths: [],
        series: [] as readonly DayColumn[],
        stepX: 0,
        ticks: [0] as readonly number[],
        toY: () => VIEW_HEIGHT,
      };
    }

    const columns = buildPeriodColumns(periods, byPeriod, metric);
    // The scale tops out at the largest single provider-period, not the sum:
    // layered series each measure from zero, so a combined peak would leave
    // the plot permanently half empty.
    const peak = columns.reduce(
      (max, column) => column.bands.reduce((inner, band) => Math.max(inner, band.value), max),
      0,
    );
    const { max, ticks: tickValues } = niceScale(peak, TICK_COUNT);
    const step = periods.length === 1 ? 0 : VIEW_WIDTH / (periods.length - 1);
    // Leave room above the top gridline so the constant-width stroke is not
    // clipped when a series reaches the peak.
    const toY = (value: number) =>
      max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);

    const built = providers.map((provider) => {
      const providerIndex = PROVIDER_ORDER.indexOf(provider);
      const line = curvePath(
        smoothCurve(
          columns.map((column, periodIndex) => ({
            x: periodIndex * step,
            y: toY(column.bands[providerIndex]?.value ?? 0),
          })),
        ),
      );
      return {
        provider,
        total: columns.reduce((sum, column) => sum + (column.bands[providerIndex]?.value ?? 0), 0),
        area: line === "" ? "" : `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z`,
        line,
      };
    });

    // Paint the heavier series first so the lighter one is not buried.
    return {
      paths: built.toSorted((a, b) => b.total - a.total),
      series: columns,
      stepX: step,
      ticks: tickValues,
      toY,
    };
  }, [byPeriod, metric, periods, providers]);

  const format = metric === "tokens" ? formatTokens : formatUsd;

  const positionTooltip = useCallback(() => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const hoverPosition = hoverPositionRef.current;
    if (plot === null || tooltip === null || hoverPosition === null) return;

    const gap = 12;
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const plotWidth = plot.clientWidth;
    const plotHeight = plot.clientHeight;
    const preferredLeft =
      hoverPosition.x + gap + tooltipWidth <= plotWidth
        ? hoverPosition.x + gap
        : hoverPosition.x - gap - tooltipWidth;
    const preferredTop =
      hoverPosition.y + gap + tooltipHeight <= plotHeight
        ? hoverPosition.y + gap
        : hoverPosition.y - gap - tooltipHeight;
    const left = Math.min(Math.max(0, preferredLeft), Math.max(0, plotWidth - tooltipWidth));
    const top = Math.min(Math.max(0, preferredTop), Math.max(0, plotHeight - tooltipHeight));
    plot.style.setProperty("--usage-tooltip-left", `${left}px`);
    plot.style.setProperty("--usage-tooltip-top", `${top}px`);
  }, []);

  useLayoutEffect(() => {
    if (hoverIndex === null) return;
    positionTooltip();

    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (plot === null || tooltip === null || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(positionTooltip);
    observer.observe(plot);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [hoverIndex, positionTooltip]);

  const indexAt = useCallback(
    (clientX: number, clientY: number) => {
      const plot = plotRef.current;
      if (plot === null || periods.length === 0) return null;
      const bounds = plot.getBoundingClientRect();
      if (bounds.width === 0) return null;
      const localX = Math.min(bounds.width, Math.max(0, clientX - bounds.left));
      const localY = Math.min(bounds.height, Math.max(0, clientY - bounds.top));
      hoverPositionRef.current = { x: localX, y: localY };
      const index = Math.round((localX / bounds.width) * (periods.length - 1));
      return Math.min(periods.length - 1, Math.max(0, index));
    },
    [periods.length],
  );

  const showIndex = (index: number) => {
    positionTooltip();
    setHoverIndex(index);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const index = indexAt(event.clientX, event.clientY);
    if (index === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ anchor: index, current: index });
    showIndex(index);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const index = indexAt(event.clientX, event.clientY);
    if (index === null) return;
    if (drag !== null && drag.current !== index) setDrag({ anchor: drag.anchor, current: index });
    showIndex(index);
  };

  const handlePointerUp = () => {
    if (drag === null) return;
    onSelectionChange(resolvePeriodSelection(periods, drag.anchor, drag.current, selection));
    setDrag(null);
  };

  /** Arrow keys move the readout; Enter focuses it; Shift extends the focus. */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const plot = plotRef.current;
    if (plot === null || periods.length === 0) return;
    const last = periods.length - 1;
    const from = hoverIndex ?? (selection ? periods.indexOf(selection.end) : last);
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    let next: number | null = null;
    if (step !== undefined) next = Math.min(last, Math.max(0, from + step));
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;

    if (next !== null) {
      event.preventDefault();
      hoverPositionRef.current = {
        x: last === 0 ? 0 : (next / last) * plot.clientWidth,
        y: 0,
      };
      showIndex(next);
      if (event.shiftKey) {
        // Keep the edge opposite the cursor fixed so Shift+arrows can grow or shrink.
        const start = selection ? periods.indexOf(selection.start) : -1;
        const end = selection ? periods.indexOf(selection.end) : -1;
        const anchor = start < 0 || end < 0 ? from : from === start ? end : start;
        onSelectionChange(resolvePeriodSelection(periods, anchor, next, null));
      }
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && hoverIndex !== null) {
      event.preventDefault();
      onSelectionChange(resolvePeriodSelection(periods, hoverIndex, hoverIndex, selection));
    }
  };

  const band = (() => {
    const range =
      drag !== null
        ? { lo: Math.min(drag.anchor, drag.current), hi: Math.max(drag.anchor, drag.current) }
        : selection === null
          ? null
          : { lo: periods.indexOf(selection.start), hi: periods.indexOf(selection.end) };
    if (range === null || range.lo < 0 || range.hi < 0) return null;
    const half = periods.length === 1 ? VIEW_WIDTH / 2 : stepX / 2;
    const x1 = Math.max(0, range.lo * stepX - half);
    const x2 = Math.min(VIEW_WIDTH, range.hi * stepX + half);
    return { x: x1, width: Math.max(0, x2 - x1) };
  })();

  const hoveredPeriod = hoverIndex === null ? undefined : periods[hoverIndex];
  const hoveredColumn = hoverIndex === null ? undefined : series[hoverIndex];
  const formatPeriod = (period: string) =>
    resolution === "hour" ? formatHourShort(period, timeZone) : formatDayShort(period);
  const formatTooltipPeriod = (period: string) =>
    resolution === "hour" && referenceTime !== undefined
      ? formatRelativeHourShort(period, referenceTime, timeZone)
      : formatPeriod(period);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {/* Axis labels sit outside the plot so they stay aligned to gridlines. */}
        <div className="relative h-56 w-14 shrink-0">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
              style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : format(tick)}
            </span>
          ))}
        </div>

        <div
          ref={plotRef}
          role="group"
          tabIndex={0}
          aria-label="Usage over time. Click or drag to focus a period. Use arrow keys to inspect, Enter to focus, and Shift with arrows to extend."
          className="relative h-56 flex-1 cursor-crosshair touch-pan-y rounded-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => setDrag(null)}
          onPointerLeave={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) return;
            hoverPositionRef.current = null;
            setHoverIndex(null);
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            hoverPositionRef.current = null;
            setHoverIndex(null);
          }}
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${resolution === "hour" ? "Hourly" : "Daily"} ${metric === "tokens" ? "processed tokens" : "cost"} by provider`}
          >
            {ticks.map((tick) => {
              const y = toY(tick);
              return (
                <line
                  key={tick}
                  x1={0}
                  x2={VIEW_WIDTH}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth={1}
                  className="text-border"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

            {band === null ? null : (
              <rect
                x={band.x}
                y={0}
                width={band.width}
                height={VIEW_HEIGHT}
                fill="currentColor"
                className="text-foreground"
                fillOpacity={0.07}
              />
            )}

            {/* Fills first, then every stroke, so no series covers another's line. */}
            {paths.map(({ provider, area }) => (
              <path
                key={provider}
                d={area}
                fill={PROVIDER_PRESENTATION[provider].color}
                fillOpacity={0.12}
              />
            ))}
            {paths.map(({ provider, line }) => (
              <path
                key={provider}
                d={line}
                fill="none"
                stroke={PROVIDER_PRESENTATION[provider].color}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {hoverIndex === null ? null : (
              <line
                x1={hoverIndex * stepX}
                x2={hoverIndex * stepX}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {hoveredPeriod === undefined ? null : (
            <div
              ref={tooltipRef}
              className="surface-glass pointer-events-none absolute z-10 min-w-36 max-w-full rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
              style={{
                left: "var(--usage-tooltip-left, 0px)",
                top: "var(--usage-tooltip-top, 0px)",
              }}
            >
              <div className="mb-1 text-muted-foreground">{formatTooltipPeriod(hoveredPeriod)}</div>
              {providers.map((provider) => {
                const { label, mark: Mark } = PROVIDER_PRESENTATION[provider];
                return (
                  <div key={provider} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Mark className="size-3 shrink-0" aria-hidden />
                      {label}
                    </span>
                    <span className="text-foreground tabular-nums">
                      {format(
                        hoveredColumn?.bands.find((band) => band.provider === provider)?.value ?? 0,
                      )}
                    </span>
                  </div>
                );
              })}
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
                <span className="text-muted-foreground">Total</span>
                <span className="text-foreground tabular-nums">
                  {format(hoveredColumn?.total ?? 0)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-between pl-16 text-3xs text-muted-foreground uppercase">
        <span>{periods[0] === undefined ? "" : formatPeriod(periods[0])}</span>
        <span>
          {periods[Math.floor(periods.length / 2)] === undefined
            ? ""
            : formatPeriod(periods[Math.floor(periods.length / 2)] ?? "")}
        </span>
        <span>
          {periods[periods.length - 1] === undefined
            ? ""
            : formatPeriod(periods[periods.length - 1] ?? "")}
        </span>
      </div>
    </div>
  );
}
