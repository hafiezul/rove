// @vitest-environment jsdom
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorktreeInventoryError,
  type WorktreeInventoryEntry,
} from "@rove-code/contracts";
import * as Cause from "effect/Cause";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  inspection: vi.fn(),
  refresh: vi.fn(),
  measure: vi.fn(),
  remove: vi.fn(),
  commands: {
    measureWorktree: {},
    removeInventoryWorktree: {},
    worktreeInventory: vi.fn(() => "inventory"),
    inspectWorktree: vi.fn(() => "inspection"),
  },
}));

vi.mock("../../state/vcs", () => ({ vcsEnvironment: mocks.commands }));
vi.mock("../../state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/query")>()),
  useEnvironmentQuery: mocks.query,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === mocks.commands.measureWorktree ? mocks.measure : mocks.remove,
}));
vi.mock("./SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => null,
  useSettingsScope: () => ({
    scope: { kind: "all", members: [] },
    connectedEnvironments: [
      {
        environmentId: "env-1",
        label: "Laptop",
        serverConfig: { environment: { capabilities: { worktreeInventory: true } } },
      },
    ],
  }),
}));

import { WorktreeInventoryPanel } from "./WorktreeInventory";

const entry: WorktreeInventoryEntry = {
  projectId: ProjectId.make("project-1"),
  projectTitle: "Rove",
  workspaceRoot: "/repo",
  path: "/worktrees/feature",
  branch: "feature/storage",
  head: "original-head",
  managed: true,
  lastActivityAt: null,
  threads: [],
  removalBlockers: null,
};
let root: Root;
let container: HTMLDivElement;

function setInventory(worktrees: readonly WorktreeInventoryEntry[]) {
  mocks.inspection.mockReturnValue({
    data: worktrees[0]
      ? { ...worktrees[0], removalBlockers: worktrees[0].removalBlockers ?? [] }
      : null,
    error: null,
    isPending: false,
    refresh: mocks.refresh,
  });
  mocks.query.mockImplementation((atom) =>
    atom === "inspection"
      ? mocks.inspection()
      : {
          data: atom === null ? null : { worktrees, issues: [] },
          error: null,
          isPending: false,
          refresh: mocks.refresh,
        },
  );
}

function button(label: string) {
  const match = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button ${label}`);
  return match;
}

async function click(element: HTMLElement) {
  await act(() => element.click());
}

async function expandFirst() {
  await act(() => {
    const details = container.querySelector("details")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  setInventory([entry]);
  mocks.measure.mockResolvedValue({ _tag: "Success", value: { bytes: 1536 } });
  mocks.remove.mockResolvedValue({ _tag: "Success", value: undefined });
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("worktree inventory interactions", () => {
  it("shows unlinked worktrees and measures only when requested", async () => {
    await act(() => root.render(<WorktreeInventoryPanel />));
    expect(container.textContent).toContain("no linked threads");
    expect(container.textContent).toContain("Activity unknown");
    expect(mocks.measure).not.toHaveBeenCalled();
    expect(mocks.commands.inspectWorktree).not.toHaveBeenCalled();
    await expandFirst();
    await click(button("Calculate size"));
    expect(container.textContent).toContain("1.5 KiB");
    expect(container.textContent).toContain("Actual disk space recovered may differ");
  });

  it("keeps removal disabled until inspection succeeds and offers retry after failure", async () => {
    mocks.inspection.mockReturnValue({
      data: null,
      isPending: true,
      error: null,
      refresh: mocks.refresh,
    });
    await act(() => root.render(<WorktreeInventoryPanel />));
    expect(container.textContent).toContain("Not checked");
    await expandFirst();
    expect(container.textContent).toContain("Checking removal safety");
    expect(button("Remove worktree").disabled).toBe(true);
    mocks.inspection.mockReturnValue({
      data: null,
      isPending: false,
      error: "Checkout unavailable",
      refresh: mocks.refresh,
    });
    await act(() => root.render(<WorktreeInventoryPanel />));
    expect(container.textContent).toContain("Checkout unavailable");
    expect(button("Remove worktree").disabled).toBe(true);
    await click(button("Check again"));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();
    mocks.inspection.mockReturnValue({
      data: { ...entry, removalBlockers: [] },
      isPending: false,
      error: null,
      refresh: mocks.refresh,
    });
    await act(() => root.render(<WorktreeInventoryPanel />));
    expect(button("Remove worktree").disabled).toBe(false);
  });

  it("explains why removal is unavailable instead of treating age as permission", async () => {
    setInventory([
      { ...entry, removalBlockers: ["Close the running terminal before removing this worktree."] },
    ]);
    await act(() => root.render(<WorktreeInventoryPanel />));
    await expandFirst();
    expect(container.textContent).toContain("Close the running terminal");
    expect(button("Remove worktree").disabled).toBe(true);
    await click(button("Remove worktree"));
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
  });

  it("opens archive management without silently restoring an archived thread", async () => {
    setInventory([
      { ...entry, threads: [{ id: ThreadId.make("archived"), title: "Old work", archived: true }] },
    ]);
    const routeRoot = createRootRoute({ component: Outlet });
    const router = createRouter({
      routeTree: routeRoot.addChildren([
        createRoute({
          getParentRoute: () => routeRoot,
          path: "/settings/storage",
          component: WorktreeInventoryPanel,
        }),
        createRoute({
          getParentRoute: () => routeRoot,
          path: "/settings/archived",
          component: () => <p>Archived threads</p>,
        }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/settings/storage"] }),
    });
    await router.load();
    await act(() => root.render(<RouterProvider router={router} />));
    await expandFirst();
    const archive = [...container.querySelectorAll("a")].find(
      (link) => link.textContent === "View archived threads",
    )!;
    await click(archive);
    await act(() => router.load());
    expect(container.textContent).toBe("Archived threads");
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("confirms against the reviewed snapshot and leaves failures visible", async () => {
    mocks.remove.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(
        new WorktreeInventoryError({
          detail: "The worktree changed. Refresh and review it again.",
        }),
      ),
    });
    await act(() => root.render(<WorktreeInventoryPanel />));
    await expandFirst();
    await click(button("Remove worktree"));
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(document.querySelector("[role=alertdialog]")?.textContent).toContain(
      "The branch, commits, and thread history stay",
    );
    setInventory([{ ...entry, head: "new-head" }]);
    await act(() => root.render(<WorktreeInventoryPanel />));
    const dialog = document.querySelector<HTMLElement>("[role=alertdialog]")!;
    const confirm = [...dialog.querySelectorAll("button")].find(
      (element) => element.textContent === "Remove worktree",
    )!;
    await click(confirm);
    expect(mocks.remove).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("env-1"),
      input: {
        projectId: entry.projectId,
        path: entry.path,
        expectedHead: "original-head",
        expectedBranch: entry.branch,
      },
    });
    expect(dialog.textContent).toContain("The worktree changed. Refresh and review it again.");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
