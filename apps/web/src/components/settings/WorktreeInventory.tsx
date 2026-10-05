import type {
  EnvironmentId,
  ProjectId,
  WorktreeInventoryEntry,
  WorktreeInventoryInspection,
} from "@rove-code/contracts";
import {
  filterWorktrees,
  formatWorktreeSize,
  type WorktreeSizeState,
} from "@rove-code/client-runtime/worktree-inventory";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, GitBranchIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";
import { SettingsSection, SettingsSearchTarget } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

export function WorktreeInventoryPanel() {
  const { scope, connectedEnvironments } = useSettingsScope();
  const [query, setQuery] = useState("");
  if (scope.kind === "unavailable") {
    return <p className="text-sm text-muted-foreground">{scope.message}</p>;
  }
  return (
    <SettingsSearchTarget id="storage-inventory" className="space-y-4">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Review checkouts without deleting their branches or thread history. Last activity only
          reflects work in Rove, not use in other apps.
        </p>
        <Input
          aria-label="Search worktrees"
          placeholder="Search branches, projects, or threads"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {connectedEnvironments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Connect an environment to review its worktrees.
        </p>
      ) : (
        connectedEnvironments.map((environment) => (
          <EnvironmentWorktrees
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
            supported={
              environment.serverConfig?.environment.capabilities.worktreeInventory === true
            }
            projectIds={
              scope.kind === "project" || scope.kind === "checkout"
                ? scope.members
                    .filter((member) => member.environmentId === environment.environmentId)
                    .map((member) => member.id)
                : undefined
            }
            query={query}
          />
        ))
      )}
    </SettingsSearchTarget>
  );
}

function EnvironmentWorktrees(props: {
  environmentId: EnvironmentId;
  label: string;
  supported: boolean;
  projectIds: ProjectId[] | undefined;
  query: string;
}) {
  const inventory = useEnvironmentQuery(
    props.supported
      ? vcsEnvironment.worktreeInventory({
          environmentId: props.environmentId,
          input: props.projectIds === undefined ? {} : { projectIds: props.projectIds },
        })
      : null,
  );
  const worktrees = filterWorktrees(inventory.data?.worktrees ?? [], props.query);
  return (
    <SettingsSection
      title={`Worktree inventory on ${props.label}`}
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!props.supported || inventory.isPending}
          onClick={inventory.refresh}
        >
          <RefreshCwIcon /> {inventory.isPending ? "Refreshing…" : "Refresh"}
        </Button>
      }
    >
      <div
        role="region"
        aria-label={`Worktrees on ${props.label}`}
        tabIndex={0}
        className="max-h-[min(32rem,60dvh)] overflow-y-auto overscroll-contain rounded-[inherit] divide-y divide-border/50 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {!props.supported ? (
          <p className="p-4 text-sm text-muted-foreground">
            Update this environment to review its worktrees.
          </p>
        ) : inventory.error ? (
          <p role="alert" className="p-4 text-sm text-destructive-foreground">
            Could not load worktrees. {inventory.error} Try Refresh.
          </p>
        ) : inventory.data === null ? (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            Loading worktrees…
          </p>
        ) : (
          <>
            {inventory.data.issues.map((issue) => (
              <p
                key={issue.projectId}
                role="alert"
                className="p-4 text-sm text-destructive-foreground"
              >
                {issue.projectTitle}. {issue.detail}
              </p>
            ))}
            {worktrees.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                {props.query.trim()
                  ? "No worktrees match your search."
                  : "No linked worktrees found for these projects. Main checkouts are not listed."}
              </p>
            ) : (
              worktrees.map((entry) => (
                <WorktreeRow
                  key={entry.path}
                  entry={entry}
                  environmentId={props.environmentId}
                  onRemoved={inventory.refresh}
                />
              ))
            )}
          </>
        )}
      </div>
    </SettingsSection>
  );
}

type RemovalState =
  | { kind: "closed" }
  | { kind: "confirming"; entry: WorktreeInventoryInspection; error: string | null }
  | { kind: "removing"; entry: WorktreeInventoryInspection };

function WorktreeRow({
  entry,
  environmentId,
  onRemoved,
}: {
  entry: WorktreeInventoryEntry;
  environmentId: EnvironmentId;
  onRemoved: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const inspection = useEnvironmentQuery(
    expanded
      ? vcsEnvironment.inspectWorktree({
          environmentId,
          input: { projectId: entry.projectId, path: entry.path },
        })
      : null,
  );
  const blockers = inspection.data?.removalBlockers ?? null;
  const [size, setSize] = useState<WorktreeSizeState>({ kind: "idle" });
  const [removal, setRemoval] = useState<RemovalState>({ kind: "closed" });
  const removing = removal.kind === "removing";
  const [copied, setCopied] = useState(false);
  const measure = useAtomCommand(vcsEnvironment.measureWorktree, { reportFailure: false });
  const remove = useAtomCommand(vcsEnvironment.removeInventoryWorktree, { reportFailure: false });
  const measureSize = async () => {
    setSize({ kind: "measuring" });
    const result = await measure({
      environmentId,
      input: { projectId: entry.projectId, path: entry.path },
    });
    setSize(
      result._tag === "Success"
        ? { kind: "ready", bytes: result.value.bytes }
        : { kind: "error", message: formatEnvironmentQueryError(result.cause) },
    );
  };
  const removeCheckout = async () => {
    if (removal.kind !== "confirming") return;
    const target = removal.entry;
    setRemoval({ kind: "removing", entry: target });
    const result = await remove({
      environmentId,
      input: {
        projectId: target.projectId,
        path: target.path,
        expectedHead: target.head,
        expectedBranch: target.branch,
      },
    });
    if (result._tag === "Failure") {
      setRemoval({
        kind: "confirming",
        entry: target,
        error: formatEnvironmentQueryError(result.cause),
      });
      return;
    }
    setRemoval({ kind: "closed" });
    onRemoved();
  };

  return (
    <details className="group" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground group-open:rotate-90"
        />
        <GitBranchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block break-all text-sm font-medium">
            {entry.branch ?? "Detached HEAD"}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {entry.projectTitle}
            {entry.threads.length === 0
              ? ", no linked threads"
              : `, ${entry.threads.length} linked ${entry.threads.length === 1 ? "thread" : "threads"}`}
          </span>
        </span>
        <span className="shrink-0 text-right text-xs text-muted-foreground">
          <span className="block">
            {entry.lastActivityAt === null
              ? "Activity unknown"
              : formatRelativeTimeLabel(entry.lastActivityAt)}
          </span>
          <span className="mt-1 block">
            {!entry.managed
              ? "External worktree"
              : blockers === null
                ? "Not checked"
                : blockers.length === 0
                  ? "Ready for review"
                  : "Kept for safety"}
          </span>
        </span>
      </summary>
      {expanded && (
        <div className="space-y-4 px-4 pb-4 sm:pl-14">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Path on this environment</p>
            <p className="break-all text-sm select-text">{entry.path}</p>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() =>
                void navigator.clipboard.writeText(entry.path).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              {copied ? "Copied" : "Copy path"}
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <span className="text-muted-foreground">Estimated size </span>
              {size.kind === "ready" ? (
                <span className="tabular-nums">{formatWorktreeSize(size.bytes)}</span>
              ) : (
                <span className="text-muted-foreground">
                  {size.kind === "measuring" ? "Calculating…" : "Not calculated"}
                </span>
              )}
            </div>
            <Button
              size="xs"
              variant="outline"
              disabled={size.kind === "measuring"}
              onClick={() => void measureSize()}
            >
              {size.kind === "ready" ? "Recalculate size" : "Calculate size"}
            </Button>
          </div>
          {size.kind === "error" ? (
            <p role="alert" className="text-xs text-destructive-foreground">
              {size.message}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            File sizes exclude Git history and linked files. Actual disk space recovered may differ.
          </p>
          {entry.lastActivityAt !== null ? (
            <p className="text-xs text-muted-foreground">
              Last activity in Rove {new Date(entry.lastActivityAt).toLocaleString()}.
            </p>
          ) : null}
          {entry.threads.length > 0 ? (
            <div className="space-y-2">
              {entry.threads.map((thread) =>
                thread.archived ? (
                  <div key={thread.id} className="space-y-1">
                    <p className="text-sm">{thread.title} (archived)</p>
                    <Link
                      to="/settings/archived"
                      className="block text-xs text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      View archived threads
                    </Link>
                  </div>
                ) : (
                  <Link
                    key={thread.id}
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId: thread.id }}
                    className="block text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {thread.title}
                  </Link>
                ),
              )}
            </div>
          ) : null}
          {inspection.error ? (
            <p role="alert" className="text-xs text-destructive-foreground">
              Could not check this worktree. {inspection.error}
            </p>
          ) : null}
          {blockers === null ? (
            <p role="status" className="text-xs text-muted-foreground">
              {inspection.isPending
                ? "Checking removal safety…"
                : "Removal safety has not been checked."}
            </p>
          ) : blockers.length > 0 ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              Review this checkout before removing it. Rove cannot detect every use outside the app.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={inspection.isPending || blockers === null || blockers.length > 0}
              onClick={() => {
                if (inspection.data !== null)
                  setRemoval({ kind: "confirming", entry: inspection.data, error: null });
              }}
            >
              Remove worktree
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={inspection.isPending}
              onClick={inspection.refresh}
            >
              Check again
            </Button>
          </div>
          <AlertDialog
            open={removal.kind !== "closed"}
            onOpenChange={(open) => {
              if (!open && !removing) setRemoval({ kind: "closed" });
            }}
          >
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove worktree?</AlertDialogTitle>
                <AlertDialogDescription>
                  Remove the checkout for{" "}
                  {(removal.kind === "closed" ? entry : removal.entry).branch ?? "this branch"} and
                  its installed dependencies. The branch, commits, and thread history stay. Starting
                  another turn recreates a linked thread's checkout.
                </AlertDialogDescription>
                <p className="break-all text-xs text-muted-foreground">
                  {(removal.kind === "closed" ? entry : removal.entry).path}
                </p>
                {removal.kind === "confirming" && removal.error ? (
                  <p role="alert" className="text-sm text-destructive-foreground">
                    {removal.error}
                  </p>
                ) : null}
              </AlertDialogHeader>
              <AlertDialogFooter>
                <Button
                  variant="outline"
                  disabled={removing}
                  onClick={() => setRemoval({ kind: "closed" })}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={removing}
                  onClick={() => void removeCheckout()}
                >
                  {removing ? "Removing…" : "Remove worktree"}
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </div>
      )}
    </details>
  );
}
