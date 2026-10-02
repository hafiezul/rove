import { ProjectId, ThreadId, type WorktreeInventoryEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterWorktrees, formatWorktreeSize } from "./worktreeInventory.ts";

const entry: WorktreeInventoryEntry = {
  projectId: ProjectId.make("project-1"),
  projectTitle: "Rove",
  workspaceRoot: "/repo",
  path: "/worktrees/feature",
  branch: "feature/storage",
  head: "abc",
  managed: true,
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  removalBlockers: [],
  threads: [{ id: ThreadId.make("thread-1"), title: "Review abandoned checkouts", archived: true }],
};

describe("worktree inventory presentation", () => {
  it.each(["  FEATURE/Storage  ", "/worktrees", "rove", "abandoned"])(
    "finds worktrees by branch, path, project, and archived thread for %s",
    (query) => expect(filterWorktrees([entry], query)).toEqual([entry]),
  );

  it("keeps unlinked and detached worktrees searchable", () => {
    const detached = { ...entry, branch: null, threads: [], path: "/worktrees/detached" };
    expect(filterWorktrees([entry, detached], "detached")).toEqual([detached]);
    expect(filterWorktrees([entry, detached], "   ")).toEqual([entry, detached]);
    expect(filterWorktrees([entry, detached], "no match")).toEqual([]);
  });

  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1 KiB"],
    [1024 ** 2, "1 MiB"],
    [1.5 * 1024 ** 3, "1.5 GiB"],
  ])("formats %s bytes without implying exact disk space recovered", (bytes, expected) =>
    expect(formatWorktreeSize(bytes)).toBe(expected),
  );
});
