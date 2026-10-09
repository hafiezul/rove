import type { DesktopBridge, DesktopUpdateState } from "@rove-code/contracts";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import {
  type DesktopUpdateButtonAction,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdatePullRequestUrl,
} from "../desktopUpdate.logic";
import { cn } from "../../lib/utils";
import { openDesktopUpdateReleaseNotes } from "../desktopUpdate.toast";
import { Button } from "../ui/button";
import {
  formatDesktopUpdateVersion,
  getDesktopUpdatePopoverTitle,
  summarizeDesktopUpdateReleaseNotes,
} from "./updateReleaseNotes.logic";

type DesktopUpdateShell = Pick<DesktopBridge, "openExternal">;

function ExternalLink({
  children,
  className,
  href,
  shell,
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly href: string;
  readonly shell: DesktopUpdateShell | undefined;
}) {
  return (
    <a
      className={cn(
        "rounded-sm outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        void openDesktopUpdateReleaseNotes(shell, href);
      }}
    >
      {children}
    </a>
  );
}

function actionLabel(state: DesktopUpdateState, action: DesktopUpdateButtonAction): string | null {
  if (action === "none") return null;
  if (state.status === "error" && state.errorContext !== null) return "Retry";
  return action === "install" ? "Restart" : "Download";
}

function clampPercent(percent: number | null): number {
  if (percent === null || !Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

/** The nightly update card: what the update is, its one action, and what changed. */
export function SidebarUpdateReleaseNotes({
  action,
  isActionPending,
  onAction,
  shell,
  state,
}: {
  readonly action: DesktopUpdateButtonAction;
  readonly isActionPending: boolean;
  readonly onAction: () => void;
  readonly shell: DesktopUpdateShell | undefined;
  readonly state: DesktopUpdateState;
}) {
  const version = getDesktopUpdateDownloadedVersion(state);
  const label = actionLabel(state, action);
  const isDownloading = state.status === "downloading";
  const percent = clampPercent(state.downloadPercent);
  const errorMessage = state.status === "error" ? state.message?.trim() : null;
  const { groups, showAuthors, footer } = summarizeDesktopUpdateReleaseNotes(
    state.releaseNotes,
    state.omittedReleaseCount,
  );
  const showScopes = groups.some((group) => group.entries.some((entry) => entry.scope));

  return (
    <div className="flex max-h-[min(34rem,var(--available-height))] w-[23rem] max-w-[calc(100vw-2rem)] min-h-0 flex-col text-left">
      <header className="flex shrink-0 items-center gap-3 px-4 pt-3.5 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm leading-5 font-medium text-foreground">
            {getDesktopUpdatePopoverTitle(state)}
          </h2>
          {version ? (
            <p className="truncate text-xs leading-4 text-muted-foreground">
              {formatDesktopUpdateVersion(version)}
            </p>
          ) : null}
        </div>
        {label ? (
          <Button
            disabled={isActionPending}
            onClick={(event) => {
              // Downloading swaps this button for progress; keep focus inside the popover.
              if (action === "download") {
                event.currentTarget.closest<HTMLElement>("[data-slot=popover-popup]")?.focus();
              }
              onAction();
            }}
            size="xs"
          >
            {label}
          </Button>
        ) : isDownloading ? (
          <span className="text-xs tabular-nums text-muted-foreground">{Math.floor(percent)}%</span>
        ) : null}
      </header>
      {isDownloading ? (
        <div
          aria-label="Download progress"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.floor(percent)}
          className="mx-4 mb-3 h-0.5 shrink-0 overflow-hidden rounded-full bg-foreground/10"
          role="progressbar"
        >
          <div
            className="h-full origin-left bg-primary transition-transform duration-300 ease-out motion-reduce:transition-none"
            style={{ transform: `scaleX(${percent / 100})` }}
          />
        </div>
      ) : null}
      {errorMessage ? (
        <p className="-mt-1 shrink-0 px-4 pb-3 text-xs leading-4 text-destructive-foreground">
          {errorMessage}
        </p>
      ) : null}
      {/* One grid for every group, so the scope column fits the longest scope. */}
      <div
        className={cn(
          "grid min-h-0 flex-1 content-start gap-x-3 gap-y-1.5 overflow-y-auto border-t border-border/60 px-4 py-3 text-xs leading-5",
          showScopes ? "grid-cols-[auto_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]",
        )}
      >
        {groups.map((group, index) => (
          <section className="contents" key={group.kind}>
            <h3
              className={cn("col-span-full font-medium text-muted-foreground", index > 0 && "mt-2")}
            >
              {group.label}
            </h3>
            <ul className="contents">
              {group.entries.map((entry) => (
                <li className="contents" key={entry.key}>
                  {showScopes ? (
                    <span className="max-w-24 truncate text-muted-foreground">{entry.scope}</span>
                  ) : null}
                  <span className="break-words text-popover-foreground">
                    {entry.title}
                    {showAuthors && entry.author ? (
                      <span className="text-muted-foreground"> by @{entry.author}</span>
                    ) : null}
                  </span>
                  {entry.pullRequest !== null ? (
                    <ExternalLink
                      className="self-start tabular-nums text-muted-foreground"
                      href={getDesktopUpdatePullRequestUrl(entry.pullRequest)}
                      shell={shell}
                    >
                      #{entry.pullRequest}
                    </ExternalLink>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {footer ? (
        <div className="shrink-0 border-t border-border/60 px-4 py-2.5">
          <ExternalLink
            className="inline-flex items-center gap-1 text-xs leading-5 text-muted-foreground"
            href={footer.url}
            shell={shell}
          >
            {footer.label}
            <ArrowSquareOutIcon aria-hidden className="size-3 shrink-0" weight="bold" />
          </ExternalLink>
        </div>
      ) : null}
    </div>
  );
}
