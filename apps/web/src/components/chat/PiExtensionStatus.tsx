import type { PiExtensionStatusSnapshot } from "@t3tools/contracts";
import { useState } from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerSurface } from "./ComposerSurface";
import { composerFloatingLayerProps } from "./composerEventScope";

function PiExtensionStatusCard({ name, text }: { name: string; text: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen, eventDetails) => {
        if (eventDetails.reason === "trigger-press") return;
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <span
            tabIndex={0}
            className="flex h-7 max-w-[32rem] cursor-default select-none items-center justify-center rounded-md px-2 text-center font-normal text-muted-foreground/75 text-xs outline-none transition-colors hover:bg-accent hover:text-foreground/85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background sm:h-6"
            aria-label={`${name}: ${text}`}
          />
        }
      >
        <span className="min-w-0 truncate tabular-nums">{text}</span>
      </PopoverTrigger>
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="center"
        viewportClassName="p-0"
        className="w-72 max-w-[calc(100vw-2rem)] text-center whitespace-normal"
      >
        <div className="flex flex-col items-center gap-2 p-[var(--floating-content-inset)] text-center">
          <div className="font-medium text-secondary-label text-xs">{name}</div>
          <div className="text-foreground text-sm leading-5 tabular-nums">{text}</div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function PiExtensionStatus({
  statuses,
}: {
  readonly statuses: PiExtensionStatusSnapshot["statuses"];
}) {
  if (statuses.length === 0) return null;

  return (
    <ComposerSurface.TopContextStrip
      data-pi-extension-status="true"
      aria-live="off"
      className="justify-center gap-1 text-xs font-normal text-muted-foreground/70"
    >
      <ul
        aria-label="Pi extension statuses"
        className="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-1"
      >
        {statuses.map(({ key, text }) => (
          <li key={key} className="min-w-0 max-w-full">
            <PiExtensionStatusCard name={key} text={text} />
          </li>
        ))}
      </ul>
    </ComposerSurface.TopContextStrip>
  );
}
