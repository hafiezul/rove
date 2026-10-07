import { EnvironmentId, ProjectId, ThreadId } from "@rove-code/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useActiveProjectTarget } from "./useActiveProjectTarget";

const mocks = vi.hoisted(() => ({ selection: vi.fn(), projects: vi.fn() }));
vi.mock("./useHandleNewThread", () => ({ useHandleNewThread: mocks.selection }));
vi.mock("~/state/entities", () => ({ useProjects: mocks.projects }));

const environmentId = EnvironmentId.make("fixture-environment");
const threadId = ThreadId.make("fixture-thread");

beforeEach(() => {
  mocks.projects.mockReturnValue([]);
  mocks.selection.mockReturnValue({ activeThread: null, activeDraftThread: null });
});

describe("workspace targets for file picking and content search", () => {
  it("queries a standalone workspace without a registered project", () => {
    mocks.selection.mockReturnValue({
      activeThread: {
        id: threadId,
        environmentId,
        projectId: null,
        worktreePath: null,
        workspacePath: "/fixture/workspaces/thread",
      },
      activeDraftThread: null,
    });
    expect(useActiveProjectTarget()).toEqual({
      environmentId,
      cwd: "/fixture/workspaces/thread",
      projectName: "Thread workspace",
      threadRef: { environmentId, threadId },
    });
  });

  it("keeps project worktrees ahead of the project root", () => {
    const projectId = ProjectId.make("fixture-project");
    mocks.projects.mockReturnValue([
      { id: projectId, environmentId, title: "Fixture project", workspaceRoot: "/fixture/project" },
    ]);
    mocks.selection.mockReturnValue({
      activeThread: { id: threadId, environmentId, projectId, worktreePath: "/fixture/worktree" },
      activeDraftThread: null,
    });
    expect(useActiveProjectTarget()).toMatchObject({
      cwd: "/fixture/worktree",
      projectName: "Fixture project",
    });
  });

  it("does not fall back to an unrelated project or the browser's directory", () => {
    mocks.projects.mockReturnValue([
      {
        id: ProjectId.make("other"),
        environmentId,
        title: "Other",
        workspaceRoot: "/fixture/other",
      },
    ]);
    mocks.selection.mockReturnValue({
      activeThread: { id: threadId, environmentId, projectId: null, worktreePath: null },
      activeDraftThread: null,
    });
    expect(useActiveProjectTarget()).toBeNull();
  });
});
