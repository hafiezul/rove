import * as Effect from "effect/Effect";
import * as Data from "effect/Data";

class PiLifecycleError extends Data.TaggedError("PiLifecycleError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const PI_STARTUP_TIMEOUT_MS = 60_000;
export const PI_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Deadlines bound asynchronous waits, not code blocking the server's event loop. */
export function disposePiResource(dispose: () => void | Promise<void>) {
  return Effect.tryPromise({
    try: async () => {
      await dispose();
    },
    catch: (cause) => new PiLifecycleError({ message: "Pi cleanup failed.", cause }),
  }).pipe(
    Effect.timeout(PI_SHUTDOWN_TIMEOUT_MS),
    Effect.interruptible,
    Effect.catchCause((cause) => Effect.logWarning("Pi cleanup failed or timed out.", { cause })),
  );
}

/** Dispose late arrivals rather than installing a resource after its caller gave up. */
export function acquirePiResource<A>(
  create: () => Promise<A>,
  dispose: (resource: A) => void | Promise<void>,
) {
  return Effect.tryPromise({
    try: async (signal) => {
      const resource = await create();
      if (signal.aborted) {
        Effect.runFork(disposePiResource(() => dispose(resource)));
        throw new PiLifecycleError({ message: "Pi startup was cancelled." });
      }
      return resource;
    },
    catch: (cause) =>
      new PiLifecycleError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: PI_STARTUP_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(new PiLifecycleError({ message: "Pi startup timed out after 60 seconds." })),
    }),
    Effect.interruptible,
  );
}
