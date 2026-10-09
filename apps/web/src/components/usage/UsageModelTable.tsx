import type { UsageProviderKind } from "@rove-code/contracts";
import { CaretDownIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { formatCount, formatPercent, formatTokens, formatUsd } from "@rove-code/shared/usageFormat";
import { isModelCostUnknown, type ModelTotals } from "@rove-code/shared/usageMerge";

import { cn } from "../../lib/utils";
import { cacheHitRate, sortModels, type ModelSortKey } from "./usageBreakdown";
import { UsageProviderMark } from "./UsageProviderMark";
import { PROVIDER_PRESENTATION } from "./usageProviders";

export interface UsageModelKey {
  readonly provider: UsageProviderKind;
  readonly model: string;
}

const COLUMNS = [
  { key: "responses", label: "Responses", narrow: false },
  { key: "tokens", label: "Tokens", narrow: true },
  { key: "cacheHit", label: "Cache hit", narrow: false },
  { key: "cost", label: "Cost", narrow: true },
] as const satisfies readonly { key: ModelSortKey; label: string; narrow: boolean }[];

/**
 * Per-model breakdown. Headers sort descending; clicking a row focuses that
 * model across the page, and clicking it again releases the focus.
 */
export function UsageModelTable({
  models,
  defaultSort,
  selected,
  onSelect,
}: {
  readonly models: readonly ModelTotals[];
  readonly defaultSort: ModelSortKey;
  readonly selected: UsageModelKey | null;
  readonly onSelect: (model: UsageModelKey | null) => void;
}) {
  const [sortKey, setSortKey] = useState<ModelSortKey | null>(null);
  const activeSort = sortKey ?? defaultSort;
  const rows = sortModels(models, activeSort);
  const isSelected = (model: ModelTotals) =>
    selected?.provider === model.provider && selected.model === model.model;

  return (
    <table className="w-full table-fixed text-sm">
      <colgroup>
        <col className="w-1/2 md:w-[34%]" />
        <col className="hidden w-[12%] md:table-column" />
        <col className="w-1/4 md:w-[12%]" />
        <col className="hidden w-[12%] md:table-column" />
        <col className="w-1/4 md:w-[14%]" />
        <col className="hidden w-[16%] md:table-column" />
      </colgroup>
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th className="py-2 font-normal">Model</th>
          {COLUMNS.map((column) => (
            <th
              key={column.key}
              aria-sort={activeSort === column.key ? "descending" : "none"}
              className={cn(
                "py-2 text-right font-normal",
                !column.narrow && "hidden md:table-cell",
              )}
            >
              <button
                type="button"
                onClick={() => setSortKey(column.key)}
                className={cn(
                  "inline-flex items-center gap-0.5 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  activeSort === column.key && "text-foreground",
                )}
              >
                {column.label}
                <CaretDownIcon
                  aria-hidden
                  className={cn("size-3", activeSort !== column.key && "invisible")}
                />
              </button>
            </th>
          ))}
          <th className="hidden py-2 text-right font-normal md:table-cell">Share of cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={6} className="py-6 text-center text-muted-foreground">
              No activity in this period.
            </td>
          </tr>
        ) : (
          rows.map((model) => {
            const unknownCost = isModelCostUnknown(model);
            const hitRate = cacheHitRate(model);
            const rowSelected = isSelected(model);
            return (
              <tr
                key={`${model.provider}:${model.model}`}
                onClick={() =>
                  onSelect(rowSelected ? null : { provider: model.provider, model: model.model })
                }
                className={cn(
                  "cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/50",
                  rowSelected && "bg-muted/60",
                  selected !== null && !rowSelected && "text-muted-foreground",
                )}
              >
                <td className="py-2">
                  <button
                    type="button"
                    aria-pressed={rowSelected}
                    className="flex w-full min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <UsageProviderMark provider={model.provider} className="size-3.5" />
                    <span className="truncate">{model.model}</span>
                  </button>
                </td>
                <td className="hidden py-2 text-right text-muted-foreground tabular-nums md:table-cell">
                  {formatCount(model.records)}
                </td>
                <td className="py-2 text-right text-muted-foreground tabular-nums">
                  {formatTokens(model.totalTokens)}
                </td>
                <td className="hidden py-2 text-right text-muted-foreground tabular-nums md:table-cell">
                  {hitRate === null ? "—" : formatPercent(hitRate, 0)}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {unknownCost ? (
                    <span className="text-muted-foreground">Unpriced</span>
                  ) : (
                    formatUsd(model.costUsd)
                  )}
                </td>
                <td className="hidden py-2 md:table-cell">
                  <span className="flex items-center justify-end gap-2 text-muted-foreground tabular-nums">
                    {unknownCost ? (
                      "—"
                    ) : (
                      <>
                        <span
                          aria-hidden
                          className="h-1 w-12 overflow-hidden rounded-full bg-muted"
                        >
                          <span
                            className="block h-full rounded-full"
                            style={{
                              width: `${Math.min(100, model.costShare * 100)}%`,
                              backgroundColor: PROVIDER_PRESENTATION[model.provider].color,
                            }}
                          />
                        </span>
                        <span className="w-12 text-right">{formatPercent(model.costShare)}</span>
                      </>
                    )}
                  </span>
                </td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}
