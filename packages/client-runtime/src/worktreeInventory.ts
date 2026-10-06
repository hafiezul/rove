import type { WorktreeInventoryEntry } from "@rove-code/contracts";

export function filterWorktrees(worktrees: readonly WorktreeInventoryEntry[], query: string) {
  const search = query.trim().toLocaleLowerCase();
  if (search.length === 0) return worktrees;
  return worktrees.filter((entry) =>
    [
      entry.branch ?? "",
      entry.path,
      entry.projectTitle,
      ...entry.threads.map((thread) => thread.title),
    ].some((value) => value.toLocaleLowerCase().includes(search)),
  );
}

export function formatWorktreeSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 ** exponent)} ${units[exponent - 1]}`;
}

export type WorktreeSizeState =
  | { readonly kind: "idle" }
  | { readonly kind: "measuring" }
  | { readonly kind: "ready"; readonly bytes: number }
  | { readonly kind: "error"; readonly message: string };
