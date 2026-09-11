import { VcsProcessExitError, VcsProcessTimeoutError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { captureCheckpointWithTimeoutRetry } from "./CheckpointReactor.ts";

const timeoutError = () =>
  new VcsProcessTimeoutError({
    operation: "GitVcsDriver.checkpoints.captureCheckpoint",
    command: "git add -A",
    cwd: "/tmp/repo",
    timeoutMs: 30_000,
  });

const exitError = () =>
  new VcsProcessExitError({
    operation: "GitVcsDriver.checkpoints.captureCheckpoint",
    command: "git write-tree",
    cwd: "/tmp/repo",
    exitCode: 128,
    detail: "not a git repository",
  });

// Fast schedule: production uses the 10s default; the policy (once, timeouts
// only) is what these pin down.
it.live("retries checkpoint capture once on timeout, then succeeds", () =>
  Effect.gen(function* () {
    let attempts = 0;
    yield* captureCheckpointWithTimeoutRetry(
      Effect.suspend(() => {
        attempts += 1;
        return attempts === 1 ? Effect.fail(timeoutError()) : Effect.void;
      }),
      Schedule.fixed("1 millis"),
    );
    assert.strictEqual(attempts, 2);
  }),
);

it.live("surfaces the timeout when the retry also times out", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const result = yield* captureCheckpointWithTimeoutRetry(
      Effect.suspend(() => {
        attempts += 1;
        return Effect.fail(timeoutError());
      }),
      Schedule.fixed("1 millis"),
    ).pipe(Effect.flip);
    assert.strictEqual(attempts, 2);
    assert.match(result.message, /timed out/);
  }),
);

it.live("does not retry non-timeout checkpoint failures", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const result = yield* captureCheckpointWithTimeoutRetry(
      Effect.suspend(() => {
        attempts += 1;
        return Effect.fail(exitError());
      }),
      Schedule.fixed("1 millis"),
    ).pipe(Effect.flip);
    assert.strictEqual(attempts, 1);
    assert.match(result.message, /not a git repository/);
  }),
);
