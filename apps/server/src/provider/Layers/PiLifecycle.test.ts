import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  acquirePiResource,
  disposePiResource,
  PI_STARTUP_TIMEOUT_MS,
  PI_SHUTDOWN_TIMEOUT_MS,
} from "./PiLifecycle.ts";

it.effect("times out startup and disposes a late resource", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const disposed = yield* Deferred.make<void>();
    let resolve: (value: string) => void = () => {};
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const fiber = yield* acquirePiResource(
      () => {
        Deferred.doneUnsafe(started, Effect.void);
        return pending;
      },
      (resource) => {
        assert.strictEqual(resource, "late");
        Deferred.doneUnsafe(disposed, Effect.void);
      },
    ).pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    yield* TestClock.adjust(PI_STARTUP_TIMEOUT_MS);
    const result = yield* Fiber.join(fiber);
    assert.strictEqual(result._tag, "Failure");
    resolve("late");
    yield* Deferred.await(disposed);
  }),
);

it.effect("bounds shutdown when dispose never resolves", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const fiber = yield* disposePiResource(() => {
      Deferred.doneUnsafe(started, Effect.void);
      return new Promise<void>(() => {});
    }).pipe(Effect.uninterruptible, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    yield* TestClock.adjust(PI_SHUTDOWN_TIMEOUT_MS);
    yield* Fiber.join(fiber);
  }),
);
