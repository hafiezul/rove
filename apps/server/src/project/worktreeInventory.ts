import {
  WorktreeInventoryError,
  type OrchestrationThreadShell,
  type TerminalSummary,
  type WorktreeInventoryEntry,
  type WorktreeInventoryInput,
  type WorktreeInventoryRemoveInput,
  type WorktreeInventoryTarget,
} from "@rove-code/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { threadHasQueuedTurnStart } from "../orchestration/ThreadSettlementPolicy.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as DateTime from "effect/DateTime";

export function parseWorktreeInventory(stdout: string) {
  return stdout.split("\0\0").flatMap((record, index) => {
    const fields = record.split("\0");
    const worktree = fields.find((field) => field.startsWith("worktree "));
    if (worktree === undefined) return [];
    const branch = fields.find((field) => field.startsWith("branch refs/heads/"));
    return [
      {
        path: worktree.slice("worktree ".length),
        branch: branch?.slice("branch refs/heads/".length) ?? null,
        head: fields.find((field) => field.startsWith("HEAD "))?.slice(5) ?? "",
        main: index === 0,
        locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
        prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
      },
    ];
  });
}

type GitWorktree = ReturnType<typeof parseWorktreeInventory>[number];
type InventoryProject = Pick<
  WorktreeInventoryEntry,
  "projectId" | "projectTitle" | "workspaceRoot"
>;

export function worktreeLastActivity(threads: readonly OrchestrationThreadShell[]) {
  const timestamps = threads
    .flatMap((thread) => [
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestTurn?.requestedAt,
      thread.latestTurn?.startedAt,
      thread.latestTurn?.completedAt,
    ])
    .filter((value): value is string => value != null);
  return timestamps.reduce<string | null>(
    (latest, value) => (latest === null || Date.parse(value) > Date.parse(latest) ? value : latest),
    null,
  );
}

export const makeWorktreeInventory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const git = yield* GitVcsDriver;
  const snapshots = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderService;
  const terminals = yield* TerminalManager;
  const error = (detail: string) => new WorktreeInventoryError({ detail });
  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const atOrInside = (root: string, target: string) => root === target || inside(root, target);
  const normalize = (value: string) => path.resolve(value);

  const context = Effect.fn("WorktreeInventory.context")(
    function* () {
      const active = yield* snapshots.getShellSnapshot();
      const archived = yield* snapshots.getArchivedShellSnapshot();
      const terminalMap = new Map<string, TerminalSummary>();
      yield* Effect.acquireUseRelease(
        terminals.subscribeMetadata((event) =>
          Effect.sync(() => {
            if (event.type === "snapshot") {
              terminalMap.clear();
              for (const terminal of event.terminals)
                terminalMap.set(`${terminal.threadId}:${terminal.terminalId}`, terminal);
            } else if (event.type === "upsert") {
              terminalMap.set(
                `${event.terminal.threadId}:${event.terminal.terminalId}`,
                event.terminal,
              );
            } else {
              terminalMap.delete(`${event.threadId}:${event.terminalId}`);
            }
          }),
        ),
        () => Effect.void,
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      return {
        projects: active.projects,
        threadsByPath: Map.groupBy([...active.threads, ...archived.threads], (thread) =>
          thread.worktreePath === null ? null : normalize(thread.worktreePath),
        ),
        sessions: yield* providers.listSessions(),
        terminals: [...terminalMap.values()],
        now: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      };
    },
    Effect.mapError(() => error("Could not read worktree activity. Refresh and try again.")),
  );

  const discover = Effect.fn("WorktreeInventory.discover")(
    function* (cwd: string) {
      const result = yield* git.execute({
        operation: "WorktreeInventory.discover",
        cwd,
        args: ["worktree", "list", "--porcelain", "-z"],
        maxOutputBytes: 1024 * 1024,
      });
      if (result.stdoutTruncated)
        return yield* error("The worktree list is too large to read completely.");
      return parseWorktreeInventory(result.stdout);
    },
    Effect.mapError((cause) => error(cause.message)),
  );

  const managedRoot = fs
    .realPath(config.worktreesDir)
    .pipe(Effect.orElseSucceed(() => normalize(config.worktreesDir)));
  const summarize = (
    worktree: GitWorktree,
    project: InventoryProject,
    threads: readonly OrchestrationThreadShell[],
    root: string,
  ) =>
    ({
      ...project,
      path: normalize(worktree.path),
      branch: worktree.branch,
      head: worktree.head,
      managed: inside(root, normalize(worktree.path)),
      lastActivityAt: worktreeLastActivity(threads),
      threads: threads.map((thread) => ({
        id: thread.id,
        title: thread.title,
        archived: thread.archivedAt !== null,
      })),
      removalBlockers: null,
    }) satisfies WorktreeInventoryEntry;

  const inspect = Effect.fn("WorktreeInventory.inspect")(
    function* (
      worktree: GitWorktree,
      project: InventoryProject,
      state: Effect.Success<ReturnType<typeof context>>,
    ) {
      const worktreePath = normalize(worktree.path);
      const linkedThreads = state.threadsByPath.get(worktreePath) ?? [];
      const summary = summarize(worktree, project, linkedThreads, yield* managedRoot);
      const blockers: string[] = [];
      if (worktree.main) blockers.push("The main checkout cannot be removed.");
      if (!summary.managed)
        blockers.push(
          "This worktree is outside Rove's managed worktree directory. Remove it with Git.",
        );
      if (worktree.locked) blockers.push("This worktree is locked in Git.");
      if (worktree.prunable || !(yield* fs.exists(worktreePath)))
        blockers.push(
          "This checkout is missing. Use git worktree prune to clear its registration.",
        );
      if (worktree.branch === null)
        blockers.push(
          "This checkout has a detached HEAD. Save its commits to a branch before removing it.",
        );
      if (linkedThreads.length > 1) blockers.push("Multiple threads share this worktree.");
      if (
        linkedThreads.some(
          (thread) =>
            (thread.session !== null && thread.session.status !== "stopped") ||
            thread.latestTurn?.state === "running" ||
            thread.backgroundLiveness != null ||
            thread.hasPendingApprovals ||
            thread.hasPendingUserInput ||
            threadHasQueuedTurnStart(thread, state.now),
        ) ||
        state.sessions.some(
          (session) =>
            session.status !== "closed" &&
            (linkedThreads.some((thread) => thread.id === session.threadId) ||
              (session.cwd !== undefined && atOrInside(worktreePath, normalize(session.cwd)))),
        )
      )
        blockers.push("Stop the agent session before removing this worktree.");
      if (
        state.terminals.some(
          (terminal) =>
            (terminal.status === "starting" || terminal.status === "running") &&
            (atOrInside(worktreePath, normalize(terminal.cwd)) ||
              (terminal.worktreePath !== null &&
                normalize(terminal.worktreePath) === worktreePath)),
        )
      )
        blockers.push("Close the running terminal before removing this worktree.");
      for (const entry of state.projects) {
        const root = yield* fs
          .realPath(entry.workspaceRoot)
          .pipe(Effect.orElseSucceed(() => normalize(entry.workspaceRoot)));
        if (atOrInside(worktreePath, root)) {
          if (!worktree.main)
            blockers.push(
              "A project uses this checkout as its workspace. Remove the project first.",
            );
          break;
        }
      }
      if (blockers.length === 0) {
        yield* Effect.gen(function* () {
          if ((yield* fs.realPath(worktreePath)) !== worktreePath) {
            blockers.push("This path is a symbolic link. Remove the worktree with Git.");
            return;
          }
          const status = yield* git.execute({
            operation: "WorktreeInventory.localChanges",
            cwd: worktreePath,
            args: ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"],
            maxOutputBytes: 64 * 1024,
          });
          const fields = status.stdout.split("\0");
          const branch = fields
            .find((field) => field.startsWith("# branch.head "))
            ?.slice("# branch.head ".length);
          if (
            status.stdoutTruncated ||
            (branch === "(detached)" ? null : branch) !== worktree.branch
          )
            blockers.push("The checkout no longer matches its Git registration. Refresh the list.");
          if (fields.some((field) => field !== "" && !field.startsWith("# ")))
            blockers.push(
              "Commit or save local changes and untracked files before removing this worktree.",
            );
          const ignored = yield* git.execute({
            operation: "WorktreeInventory.ignoredFiles",
            cwd: worktreePath,
            args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
            maxOutputBytes: 64 * 1024,
          });
          if (
            ignored.stdoutTruncated ||
            ignored.stdout
              .split("\0")
              .some((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry))
          ) {
            blockers.push(
              "This worktree contains ignored files other than node_modules. Save or remove them first.",
            );
          }
        }).pipe(
          Effect.catch(() =>
            Effect.sync(() =>
              blockers.push(
                "Could not verify local files. Refresh the list before removing this worktree.",
              ),
            ),
          ),
        );
      }
      return { ...summary, removalBlockers: blockers };
    },
    Effect.mapError(() => error("Could not inspect this worktree. Refresh and try again.")),
  );

  const list = Effect.fn("WorktreeInventory.list")(function* (input: WorktreeInventoryInput) {
    const state = yield* context();
    const root = yield* managedRoot;
    const projects = state.projects.filter(
      (project) => input.projectIds === undefined || input.projectIds.includes(project.id),
    );
    const worktrees = new Map<string, WorktreeInventoryEntry>();
    const issues: {
      projectId: WorktreeInventoryEntry["projectId"];
      projectTitle: string;
      detail: string;
    }[] = [];
    for (const project of projects) {
      yield* Effect.gen(function* () {
        for (const worktree of yield* discover(project.workspaceRoot)) {
          if (worktree.main || worktrees.has(normalize(worktree.path))) continue;
          const entry = summarize(
            worktree,
            {
              projectId: project.id,
              projectTitle: project.title,
              workspaceRoot: project.workspaceRoot,
            },
            state.threadsByPath.get(normalize(worktree.path)) ?? [],
            root,
          );
          worktrees.set(entry.path, entry);
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            issues.push({
              projectId: project.id,
              projectTitle: project.title,
              detail: cause.message,
            }),
          ),
        ),
      );
    }
    return {
      worktrees: [...worktrees.values()].sort((left, right) => {
        if (left.lastActivityAt === null)
          return right.lastActivityAt === null ? left.path.localeCompare(right.path) : -1;
        if (right.lastActivityAt === null) return 1;
        return (
          Date.parse(left.lastActivityAt) - Date.parse(right.lastActivityAt) ||
          left.path.localeCompare(right.path)
        );
      }),
      issues,
    };
  });

  const target = Effect.fn("WorktreeInventory.target")(function* (input: WorktreeInventoryTarget) {
    const state = yield* context();
    const project = state.projects.find((entry) => entry.id === input.projectId);
    if (project === undefined)
      return yield* error("This project is no longer available. Refresh the list.");
    const worktree = (yield* discover(project.workspaceRoot)).find(
      (entry) => normalize(entry.path) === normalize(input.path),
    );
    if (worktree === undefined || worktree.main)
      return yield* error("This linked worktree is no longer registered. Refresh the list.");
    return {
      worktree,
      project: {
        projectId: project.id,
        projectTitle: project.title,
        workspaceRoot: project.workspaceRoot,
      },
      state,
    };
  });

  const inspectTarget = Effect.fn("WorktreeInventory.inspectTarget")(function* (
    input: WorktreeInventoryTarget,
  ) {
    const { worktree, project, state } = yield* target(input);
    return yield* inspect(worktree, project, state);
  });

  const measure = Effect.fn("WorktreeInventory.measure")(
    function* (input: WorktreeInventoryTarget) {
      const { worktree } = yield* target(input);
      const root = yield* fs.realPath(worktree.path);
      if (root !== normalize(worktree.path)) {
        return yield* error(
          "This checkout path is a symbolic link. Inspect its size on the server.",
        );
      }
      const pending = [root];
      let bytes = 0;
      let visited = 0;
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (++visited > 100_000)
          return yield* error(
            "This checkout has too many files to estimate. Inspect its size on the server.",
          );
        // Do not follow links into shared dependency stores or other checkouts.
        if ((yield* fs.realPath(current)) !== current) continue;
        const stat = yield* fs.stat(current);
        if (stat.type === "Directory") {
          for (const name of yield* fs.readDirectory(current)) {
            if (name === ".git") continue;
            if (visited + pending.length >= 100_000)
              return yield* error(
                "This checkout has too many files to estimate. Inspect its size on the server.",
              );
            pending.push(path.join(current, name));
          }
        } else if (stat.type === "File") {
          bytes += Number(stat.size);
        }
      }
      return { bytes };
    },
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) =>
      error(
        cause._tag === "WorktreeInventoryError"
          ? cause.detail
          : "Could not estimate this checkout's size. Inspect its size on the server.",
      ),
    ),
  );

  const remove = Effect.fn("WorktreeInventory.remove")(
    function* (input: WorktreeInventoryRemoveInput) {
      yield* withWorkspaceLease(
        normalize(input.path),
        Effect.gen(function* () {
          const { worktree, project, state } = yield* target(input);
          const entry = yield* inspect(worktree, project, state);
          if (entry.removalBlockers.length > 0)
            return yield* error(entry.removalBlockers.join(" "));
          if (worktree.head !== input.expectedHead || worktree.branch !== input.expectedBranch)
            return yield* error(
              "The worktree changed since you opened the confirmation. Refresh and review it again.",
            );
          const managedRoot = yield* fs.realPath(config.worktreesDir);
          if (!inside(managedRoot, entry.path))
            return yield* error("Only Rove-managed worktrees can be removed here.");
          const latest = yield* inspect(worktree, project, yield* context());
          if (latest.removalBlockers.length > 0)
            return yield* error(latest.removalBlockers.join(" "));
          const head = yield* git.resolveCommit({ cwd: entry.path, revision: "HEAD" });
          if (head.commitSha !== input.expectedHead)
            return yield* error(
              "The worktree changed since you opened the confirmation. Refresh and review it again.",
            );
          yield* git.removeWorktree({ cwd: project.workspaceRoot, path: entry.path, force: false });
        }),
      );
    },
    Effect.mapError((cause) => error(cause.message)),
  );

  return { list, inspect: inspectTarget, measure, remove };
});
