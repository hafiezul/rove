// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@rove-code/shared/hostProcess";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { isCwdInside, isServerOwnedCgroup, stopWorktreeProcesses } from "./worktreeProcesses.ts";

it("matches deleted worktree directories without matching sibling paths", () => {
  const roots = ["/w/rove-a"];
  expect(isCwdInside("/w/rove-a (deleted)", roots)).toBe(true);
  expect(isCwdInside("/w/rove-a/apps/web (deleted)", roots)).toBe(true);
  expect(isCwdInside("/w/rove-ab/apps/web", roots)).toBe(false);
  expect(isCwdInside("/w", roots)).toBe(false);
});

it("treats only the server's cgroup subtree and guarded workloads as server-owned", () => {
  const server = "/user.slice/user@1000.service/app.slice/rove.service";
  expect(isServerOwnedCgroup(server, server)).toBe(true);
  expect(isServerOwnedCgroup(`${server}/tools`, server)).toBe(true);
  expect(isServerOwnedCgroup(`${server}2`, server)).toBe(false);
  expect(isServerOwnedCgroup("/user.slice/user@1000.service/app.slice/tmux.scope", server)).toBe(
    false,
  );
  expect(
    isServerOwnedCgroup(
      "/user.slice/user@1000.service/rove.slice/rove-provider.slice/rove-provider-workloads.slice/rove-budget-x.scope",
      server,
    ),
  ).toBe(true);
});

it.effect("does nothing off Linux", () =>
  Effect.gen(function* () {
    const stopped = yield* stopWorktreeProcesses(["/"]).pipe(
      Effect.provideService(HostProcessPlatform, "darwin"),
    );
    expect(stopped).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const spawnIdle = (cwd: string) => {
  const child = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], {
    cwd,
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const spawned = new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  return { child, exited, spawned };
};

describe.runIf(HostProcessPlatform.defaultValue() === "linux")(
  "Linux worktree process cleanup",
  () => {
    it.live("stops processes left in a removed worktree and spares others", () =>
      Effect.gen(function* () {
        const base = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "rove-worktree-processes-")),
        );
        const worktree = NodePath.join(base, "worktree");
        const nested = NodePath.join(worktree, "apps", "web");
        const outside = NodePath.join(base, "worktree-sibling");
        yield* Effect.promise(() => NodeFSP.mkdir(nested, { recursive: true }));
        yield* Effect.promise(() => NodeFSP.mkdir(outside));
        const leftover = spawnIdle(nested);
        const bystander = spawnIdle(outside);
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            bystander.child.kill("SIGKILL");
            leftover.child.kill("SIGKILL");
            await NodeFSP.rm(base, { recursive: true, force: true });
          }),
        );
        // Wait until both children have chdir'd before deleting their directories.
        yield* Effect.promise(() => Promise.all([leftover.spawned, bystander.spawned]));
        yield* Effect.promise(() => NodeFSP.rm(worktree, { recursive: true, force: true }));

        const stopped = yield* stopWorktreeProcesses([worktree]);

        expect(stopped).toEqual([leftover.child.pid]);
        yield* Effect.promise(() => leftover.exited);
        expect(leftover.child.signalCode).toBe("SIGTERM");
        expect(bystander.child.exitCode).toBeNull();
        expect(bystander.child.signalCode).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);
