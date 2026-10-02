import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProviderSession,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { GitVcsDriver, layer as GitVcsDriverLayer } from "../vcs/GitVcsDriver.ts";
import {
  makeWorktreeInventory,
  parseWorktreeInventory,
  worktreeLastActivity,
} from "./worktreeInventory.ts";

const TestLayer = GitVcsDriverLayer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "rove-worktree-inventory-" })),
  Layer.provideMerge(NodeServices.layer),
);
const projectId = ProjectId.make("project-1");
const createdAt = "2026-01-01T00:00:00.000Z";

function thread(
  worktreePath: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId,
    title: "Feature work",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.3-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath,
    latestTurn: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    session: null,
    pullRequests: [],
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const driver = yield* GitVcsDriver;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "rove-inventory-repo-" });
  const git = (args: readonly string[], directory = cwd) =>
    driver.execute({ operation: "WorktreeInventory.test", cwd: directory, args });
  yield* git(["init", "--initial-branch=main"]);
  yield* git(["config", "user.name", "Worktree test"]);
  yield* git(["config", "user.email", "worktree@example.test"]);
  yield* fs.writeFileString(path.join(cwd, "README.md"), "example\n");
  yield* fs.writeFileString(path.join(cwd, ".gitignore"), "node_modules/\n.env\nbuild/\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "initial"]);
  const worktreePath = path.join(config.worktreesDir, "feature");
  yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
  yield* git(["worktree", "add", "-b", "feature", worktreePath]);
  const projects: OrchestrationProjectShell[] = [
    {
      id: projectId,
      title: "Example",
      workspaceRoot: cwd,
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  ];
  const threads: OrchestrationThreadShell[] = [];
  const archivedThreads: OrchestrationThreadShell[] = [];
  const sessions: ProviderSession[] = [];
  const terminalEntries: TerminalSummary[] = [];
  let subscriptions = 0;
  const operations: string[] = [];
  const inventory = yield* makeWorktreeInventory.pipe(
    Effect.provideService(GitVcsDriver, {
      ...driver,
      execute: (input) => {
        operations.push(input.operation);
        return driver.execute(input);
      },
    }),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery, {
          getShellSnapshot: () =>
            Effect.succeed({ projects, threads, snapshotSequence: 0, updatedAt: createdAt }),
          getArchivedShellSnapshot: () =>
            Effect.succeed({
              projects: [],
              threads: archivedThreads,
              snapshotSequence: 0,
              updatedAt: createdAt,
            }),
        }),
        Layer.mock(ProviderService, { listSessions: () => Effect.succeed(sessions) }),
        Layer.mock(TerminalManager, {
          subscribeMetadata: (listener) =>
            Effect.gen(function* () {
              subscriptions++;
              yield* listener({ type: "snapshot", terminals: terminalEntries });
              return () => {
                subscriptions--;
              };
            }),
        }),
      ),
    ),
  );
  return {
    fs,
    path,
    cwd,
    worktreePath,
    inventory,
    projects,
    threads,
    archivedThreads,
    sessions,
    terminalEntries,
    git,
    subscriptions: () => subscriptions,
    operations,
  };
});

const firstEntry = (inventory: Effect.Success<typeof makeWorktreeInventory>) =>
  inventory.list({}).pipe(
    Effect.flatMap((result) =>
      inventory.inspect({
        projectId: result.worktrees[0]!.projectId,
        path: result.worktrees[0]!.path,
      }),
    ),
  );

describe("worktree inventory", () => {
  it("parses paths and lock reasons containing whitespace without unquoting them", () => {
    const entries = parseWorktreeInventory(
      "worktree /repo\0HEAD abc\0branch refs/heads/main\0\0worktree /work tree/line\nbreak\0HEAD def\0branch refs/heads/feature\0locked a\nb\0\0worktree /missing\0HEAD 123\0detached\0prunable missing\0\0",
    );
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[1]!.path, "/work tree/line\nbreak");
    assert.isTrue(entries[0]!.main);
    assert.isTrue(entries[1]!.locked);
    assert.isTrue(entries[2]!.prunable);
    assert.isNull(entries[2]!.branch);
  });

  it.effect("discovers a worktree with no thread and excludes the main checkout", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, fs, subscriptions, operations } = yield* fixture;
      const result = yield* inventory.list({});
      assert.strictEqual(result.worktrees.length, 1);
      assert.strictEqual(result.worktrees[0]!.path, yield* fs.realPath(worktreePath));
      assert.isNull(result.worktrees[0]!.lastActivityAt);
      assert.isNull(result.worktrees[0]!.removalBlockers);
      assert.strictEqual(subscriptions(), 0);
      assert.deepStrictEqual(operations, ["WorktreeInventory.discover"]);
      const checked = yield* inventory.inspect({ projectId, path: worktreePath });
      assert.deepStrictEqual(checked.removalBlockers, []);
      assert.isTrue(operations.includes("WorktreeInventory.localChanges"));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("does not scan checkout files when listing many managed worktrees", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, path, git, operations } = yield* fixture;
      for (let index = 0; index < 12; index++) {
        yield* git([
          "worktree",
          "add",
          "-b",
          `extra-${index}`,
          path.join(path.dirname(worktreePath), `extra-${index}`),
        ]);
      }
      const result = yield* inventory.list({});
      assert.strictEqual(result.worktrees.length, 13);
      assert.isTrue(
        result.worktrees.every((entry) => entry.managed && entry.removalBlockers === null),
      );
      assert.deepStrictEqual(operations, ["WorktreeInventory.discover"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("joins archived activity and ignores metadata refresh timestamps", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, archivedThreads } = yield* fixture;
      const activityAt = "2026-02-01T00:00:00.000Z";
      archivedThreads.push(
        thread(worktreePath, {
          archivedAt: activityAt,
          latestUserMessageAt: activityAt,
          updatedAt: "2026-03-01T00:00:00.000Z",
        }),
      );
      const entry = yield* firstEntry(inventory);
      assert.strictEqual(entry.lastActivityAt, activityAt);
      assert.isTrue(entry.threads[0]!.archived);
      assert.deepStrictEqual(entry.removalBlockers, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("filters projects and deduplicates worktrees across checkouts of one repository", () =>
    Effect.gen(function* () {
      const { inventory, projects, worktreePath } = yield* fixture;
      projects.push({
        ...projects[0]!,
        id: ProjectId.make("project-2"),
        workspaceRoot: worktreePath,
      });
      assert.strictEqual((yield* inventory.list({})).worktrees.length, 1);
      assert.strictEqual((yield* inventory.list({ projectIds: [] })).worktrees.length, 0);
      assert.strictEqual((yield* inventory.list({ projectIds: [projectId] })).worktrees.length, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports repository failures instead of presenting an empty successful scan", () =>
    Effect.gen(function* () {
      const { inventory, projects, fs } = yield* fixture;
      const missing = yield* fs.makeTempDirectoryScoped({ prefix: "rove-inventory-not-git-" });
      projects.push({ ...projects[0]!, id: ProjectId.make("project-2"), workspaceRoot: missing });
      const result = yield* inventory.list({});
      assert.strictEqual(result.worktrees.length, 1);
      assert.strictEqual(result.issues.length, 1);
      assert.strictEqual(result.issues[0]!.projectId, projects[1]!.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("removes only the checkout while preserving its branch and thread records", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, threads, fs, git } = yield* fixture;
      threads.push(thread(worktreePath));
      const entry = yield* firstEntry(inventory);
      yield* inventory.remove({
        projectId,
        path: entry.path,
        expectedHead: entry.head,
        expectedBranch: entry.branch,
      });
      assert.isFalse(yield* fs.exists(worktreePath));
      assert.strictEqual(threads.length, 1);
      assert.strictEqual((yield* git(["rev-parse", "feature"])).stdout.trim(), entry.head);
      assert.strictEqual((yield* inventory.list({})).worktrees.length, 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rechecks local changes created after the inventory was loaded", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, fs, path } = yield* fixture;
      const entry = yield* firstEntry(inventory);
      yield* fs.writeFileString(path.join(worktreePath, "notes.txt"), "keep this");
      const failure = yield* inventory
        .remove({
          projectId,
          path: entry.path,
          expectedHead: entry.head,
          expectedBranch: entry.branch,
        })
        .pipe(Effect.flip);
      assert.include(failure.detail, "local changes");
      assert.isTrue(yield* fs.exists(worktreePath));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps ignored secrets but allows reproducible dependency installs", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, fs, path } = yield* fixture;
      yield* fs.makeDirectory(path.join(worktreePath, "node_modules"));
      yield* fs.writeFileString(
        path.join(worktreePath, "node_modules", "package.js"),
        "dependency",
      );
      assert.deepStrictEqual((yield* firstEntry(inventory)).removalBlockers, []);
      yield* fs.writeFileString(path.join(worktreePath, ".env"), "SECRET=keep");
      const entry = yield* firstEntry(inventory);
      assert.isTrue(entry.removalBlockers.some((blocker) => blocker.includes("ignored files")));
      const failure = yield* inventory
        .remove({
          projectId,
          path: entry.path,
          expectedHead: entry.head,
          expectedBranch: entry.branch,
        })
        .pipe(Effect.flip);
      assert.include(failure.detail, "ignored files");
      assert.isTrue(yield* fs.exists(path.join(worktreePath, ".env")));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps worktrees shared by active and archived threads", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, threads, archivedThreads } = yield* fixture;
      threads.push(thread(worktreePath));
      archivedThreads.push(
        thread(worktreePath, { id: ThreadId.make("thread-2"), archivedAt: createdAt }),
      );
      const entry = yield* firstEntry(inventory);
      assert.strictEqual(entry.threads.length, 2);
      assert.isTrue(entry.removalBlockers.some((blocker) => blocker.includes("Multiple threads")));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps active background work and pending user input", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, threads, fs } = yield* fixture;
      threads.push(thread(worktreePath, { backgroundLiveness: "working" }));
      const entry = yield* firstEntry(inventory);
      assert.isTrue(entry.removalBlockers.some((blocker) => blocker.includes("agent session")));
      threads[0] = thread(worktreePath, { hasPendingUserInput: true });
      const failure = yield* inventory
        .remove({
          projectId,
          path: entry.path,
          expectedHead: entry.head,
          expectedBranch: entry.branch,
        })
        .pipe(Effect.flip);
      assert.include(failure.detail, "agent session");
      assert.isTrue(yield* fs.exists(worktreePath));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps live provider sessions that use an otherwise unlinked checkout", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, sessions, fs } = yield* fixture;
      const entry = yield* firstEntry(inventory);
      sessions.push({
        provider: ProviderDriverKind.make("codex"),
        threadId: ThreadId.make("outside-thread"),
        status: "ready",
        runtimeMode: "full-access",
        cwd: worktreePath,
        createdAt,
        updatedAt: createdAt,
      });
      const failure = yield* inventory
        .remove({
          projectId,
          path: entry.path,
          expectedHead: entry.head,
          expectedBranch: entry.branch,
        })
        .pipe(Effect.flip);
      assert.include(failure.detail, "agent session");
      assert.isTrue(yield* fs.exists(worktreePath));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps a queued turn before its provider session starts", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, threads } = yield* fixture;
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      threads.push(thread(worktreePath, { latestUserMessageAt: now }));
      assert.isTrue(
        (yield* firstEntry(inventory)).removalBlockers.some((blocker) =>
          blocker.includes("agent session"),
        ),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps running terminals even when their thread is not linked", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, terminalEntries, fs } = yield* fixture;
      terminalEntries.push({
        threadId: "unrelated",
        terminalId: "default",
        cwd: worktreePath,
        worktreePath: null,
        status: "running",
        pid: 1,
        exitCode: null,
        exitSignal: null,
        hasRunningSubprocess: false,
        label: "Shell",
        updatedAt: createdAt,
      });
      const entry = yield* firstEntry(inventory);
      const failure = yield* inventory
        .remove({
          projectId,
          path: entry.path,
          expectedHead: entry.head,
          expectedBranch: entry.branch,
        })
        .pipe(Effect.flip);
      assert.include(failure.detail, "terminal");
      assert.isTrue(yield* fs.exists(worktreePath));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps project roots and detached or locked worktrees", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, projects, git } = yield* fixture;
      yield* git(["worktree", "lock", worktreePath]);
      assert.isTrue(
        (yield* firstEntry(inventory)).removalBlockers.some((blocker) =>
          blocker.includes("locked"),
        ),
      );
      yield* git(["worktree", "unlock", worktreePath]);
      yield* git(["checkout", "--detach"], worktreePath);
      assert.isTrue(
        (yield* firstEntry(inventory)).removalBlockers.some((blocker) =>
          blocker.includes("detached HEAD"),
        ),
      );
      projects.push({
        ...projects[0]!,
        id: ProjectId.make("project-2"),
        workspaceRoot: worktreePath,
      });
      assert.isTrue(
        (yield* firstEntry(inventory)).removalBlockers.some((blocker) =>
          blocker.includes("workspace"),
        ),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects a main checkout and a path not registered to the project", () =>
    Effect.gen(function* () {
      const { inventory, cwd, fs, path } = yield* fixture;
      for (const target of [cwd, path.join(cwd, "unknown")]) {
        const failure = yield* inventory
          .remove({ projectId, path: target, expectedHead: "old", expectedBranch: "main" })
          .pipe(Effect.flip);
        assert.include(failure.detail, "no longer registered");
      }
      assert.isTrue(yield* fs.exists(cwd));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("shows external worktrees but never removes them", () =>
    Effect.gen(function* () {
      const { inventory, cwd, path, git, fs } = yield* fixture;
      const external = path.join(cwd, "external");
      yield* git(["worktree", "add", "-b", "external", external]);
      const entry = (yield* inventory.list({})).worktrees.find(
        (worktree) => worktree.branch === "external",
      )!;
      assert.isFalse(entry.managed);
      const failure = yield* inventory
        .remove({
          projectId,
          path: entry.path,
          expectedHead: entry.head,
          expectedBranch: entry.branch,
        })
        .pipe(Effect.flip);
      assert.include(failure.detail, "outside Rove");
      assert.isTrue(yield* fs.exists(external));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects a changed commit after confirmation", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, git, fs } = yield* fixture;
      const entry = yield* firstEntry(inventory);
      yield* git(["commit", "--allow-empty", "-m", "new work"], worktreePath);
      const failure = yield* inventory
        .remove({
          projectId,
          path: entry.path,
          expectedHead: entry.head,
          expectedBranch: entry.branch,
        })
        .pipe(Effect.flip);
      assert.include(failure.detail, "changed since");
      assert.isTrue(yield* fs.exists(worktreePath));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects a changed branch even when the commit stays the same", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, git, fs } = yield* fixture;
      const entry = yield* firstEntry(inventory);
      yield* git(["checkout", "-b", "other"], worktreePath);
      const failure = yield* inventory
        .remove({
          projectId,
          path: entry.path,
          expectedHead: entry.head,
          expectedBranch: entry.branch,
        })
        .pipe(Effect.flip);
      assert.include(failure.detail, "changed since");
      assert.isTrue(yield* fs.exists(worktreePath));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("estimates checkout files without following links into shared stores", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, fs, path, cwd } = yield* fixture;
      const external = path.join(cwd, "large-file");
      yield* fs.writeFileString(external, "x".repeat(5000));
      yield* fs.symlink(external, path.join(worktreePath, "linked-file"));
      const size = yield* inventory.measure({ projectId, path: worktreePath });
      assert.strictEqual(
        size.bytes,
        new TextEncoder().encode("example\nnode_modules/\n.env\nbuild/\n").length,
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it("returns unknown activity when no thread is linked", () => {
    assert.isNull(worktreeLastActivity([]));
  });
});
