// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  migrateLegacyCheckpointRefs,
  planLegacyCheckpointRefMigration,
} from "./legacyCheckpointRefs.ts";

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "rove-legacy-refs-" }),
  ),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "legacyCheckpointRefs.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const makeRepoWithTwoCommits = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "legacy-checkpoint-refs-" });
  yield* git(cwd, ["init"]);
  yield* git(cwd, ["config", "user.email", "test@test.com"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* fs.writeFileString(NodePath.join(cwd, "README.md"), "one\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "one"]);
  const first = yield* git(cwd, ["rev-parse", "HEAD"]);
  yield* fs.writeFileString(NodePath.join(cwd, "README.md"), "two\n");
  yield* git(cwd, ["commit", "-am", "two"]);
  const second = yield* git(cwd, ["rev-parse", "HEAD"]);
  return { cwd, first, second };
});

it("keeps an existing Rove ref and ignores a truncated final line", () => {
  expect(
    planLegacyCheckpointRefMigration(
      [
        "a1 refs/t3/checkpoints/x/turn/1",
        "b2 refs/t3/checkpoints/y/turn/1",
        "c3 refs/rove/checkpoints/y/turn/1",
        "d4 refs/t3/checkpoints/z/tu",
      ].join("\n"),
      true,
    ),
  ).toEqual([
    "create refs/rove/checkpoints/x/turn/1 a1",
    "delete refs/t3/checkpoints/x/turn/1 a1",
    "delete refs/t3/checkpoints/y/turn/1 b2",
  ]);
});

it.layer(TestLayer)("migrateLegacyCheckpointRefs", (it) => {
  it.effect("moves legacy refs once and leaves non-repositories alone", () =>
    Effect.gen(function* () {
      const { cwd, first, second } = yield* makeRepoWithTwoCommits;
      yield* git(cwd, ["update-ref", "refs/t3/checkpoints/x/turn/1", first]);
      yield* git(cwd, ["update-ref", "refs/t3/checkpoints/y/turn/1", first]);
      yield* git(cwd, ["update-ref", "refs/rove/checkpoints/y/turn/1", second]);
      const fs = yield* FileSystem.FileSystem;
      const notARepo = yield* fs.makeTempDirectoryScoped({ prefix: "legacy-checkpoint-plain-" });

      yield* migrateLegacyCheckpointRefs([cwd, cwd, notARepo]);
      const list = () =>
        git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/t3", "refs/rove"]);
      const after = yield* list();
      expect(after.split("\n")).toEqual([
        `refs/rove/checkpoints/x/turn/1 ${first}`,
        `refs/rove/checkpoints/y/turn/1 ${second}`,
      ]);

      yield* migrateLegacyCheckpointRefs([cwd]);
      expect(yield* list()).toBe(after);
    }),
  );
});
