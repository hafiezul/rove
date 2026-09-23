import type { PiExtensionStatusSnapshot } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { composerFloatingLayerProps } from "./composerEventScope";

export function PiExtensionStatus({
  statuses,
}: {
  readonly statuses: PiExtensionStatusSnapshot["statuses"];
}) {
  if (statuses.length === 0) return null;

  return (
    <div data-pi-extension-status="true" className="flex justify-end pe-1 pb-1">
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={`Pi extension statuses, ${statuses.length} ${statuses.length === 1 ? "entry" : "entries"}`}
              className="group flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-muted-foreground/75 text-xs outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-[popup-open]:bg-accent data-[popup-open]:text-foreground"
            />
          }
        >
          <span className="shrink-0 font-medium text-muted-foreground sm:hidden">Pi</span>
          <span className="hidden shrink-0 font-medium text-muted-foreground sm:inline">
            Pi extensions
          </span>
          <span aria-hidden="true" className="text-muted-foreground/50">
            ·
          </span>
          <span className="min-w-0 max-w-28 truncate tabular-nums sm:max-w-40">
            {statuses[0]!.text}
          </span>
          {statuses.length > 1 ? (
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {statuses.length - 1} more
            </span>
          ) : null}
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
        </PopoverTrigger>
        <PopoverPopup
          {...composerFloatingLayerProps}
          side="top"
          align="end"
          sideOffset={6}
          viewportClassName="p-0"
          className="w-80 max-w-[calc(100vw-2rem)] text-left"
        >
          <div className="p-3">
            <PopoverTitle className="font-medium text-sm">Pi extension status</PopoverTitle>
            <dl className="mt-2 max-h-80 space-y-0 overflow-y-auto">
              {statuses.map(({ key, text }) => (
                <div
                  key={key}
                  className="border-border/50 border-t py-2 first:border-t-0 first:pt-0 last:pb-0"
                >
                  <dt className="text-secondary-label text-xs">{key}</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground text-sm leading-5 tabular-nums">
                    {text}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
