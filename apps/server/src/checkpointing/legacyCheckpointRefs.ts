import {
  LEGACY_CHECKPOINT_REFS_PREFIX,
  ROVE_CHECKPOINT_REFS_PREFIX,
} from "@rove-code/shared/roveMigration";
import * as Effect from "effect/Effect";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const OPERATION = "migrateLegacyCheckpointRefs";

/**
 * Plans the `git update-ref --stdin` transaction that moves every legacy checkpoint ref to the
 * Rove prefix. A Rove ref that already exists wins; its legacy twin is only deleted. Lines past an
 * output truncation are ignored, so a later run picks them up.
 */
export function planLegacyCheckpointRefMigration(
  forEachRefOutput: string,
  truncated: boolean,
): ReadonlyArray<string> {
  const lines = forEachRefOutput.split("\n");
  if (truncated) lines.pop();
  const refs = new Map<string, string>();
  for (const line of lines) {
    const [oid, ref] = line.trim().split(" ");
    if (oid && ref) refs.set(ref, oid);
  }
  const legacyPrefix = `${LEGACY_CHECKPOINT_REFS_PREFIX}/`;
  return [...refs].flatMap(([ref, oid]) => {
    if (!ref.startsWith(legacyPrefix)) return [];
    const target = `${ROVE_CHECKPOINT_REFS_PREFIX}/${ref.slice(legacyPrefix.length)}`;
    return refs.has(target)
      ? [`delete ${ref} ${oid}`]
      : [`create ${target} ${oid}`, `delete ${ref} ${oid}`];
  });
}

const migrateRepository = Effect.fn(OPERATION)(function* (cwd: string) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const listed = yield* git.execute({
    operation: OPERATION,
    cwd,
    args: [
      "for-each-ref",
      "--format=%(objectname) %(refname)",
      `${LEGACY_CHECKPOINT_REFS_PREFIX}/`,
      `${ROVE_CHECKPOINT_REFS_PREFIX}/`,
    ],
    allowNonZeroExit: true,
  });
  if (listed.exitCode !== 0) return;
  const commands = planLegacyCheckpointRefMigration(listed.stdout, listed.stdoutTruncated);
  if (commands.length === 0) return;
  yield* git.execute({
    operation: OPERATION,
    cwd,
    args: ["update-ref", "--stdin"],
    stdin: `${commands.join("\n")}\n`,
  });
  yield* Effect.logInfo("Moved legacy checkpoint refs", {
    cwd,
    refs: commands.filter((command) => command.startsWith("delete ")).length,
  });
});

/**
 * Moves checkpoint refs written before 0.0.3 from `refs/t3/checkpoints` to the Rove prefix in each
 * project repository. Safe to rerun: a repository with nothing left to move costs one
 * `for-each-ref`. Delete together with the legacy checkpoint read path.
 */
export const migrateLegacyCheckpointRefs = (workspaceRoots: ReadonlyArray<string>) =>
  Effect.forEach(
    new Set(workspaceRoots),
    (cwd) =>
      migrateRepository(cwd).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to move legacy checkpoint refs", { cwd, cause }),
        ),
      ),
    { concurrency: 4, discard: true },
  );
