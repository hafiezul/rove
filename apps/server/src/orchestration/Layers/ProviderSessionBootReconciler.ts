import {
  CommandId,
  EventId,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  ProviderSessionDirectory,
  type ProviderRuntimeBindingWithMetadata,
} from "../../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { stalePendingRequestDetail } from "../stalePendingRequest.ts";
import {
  ProviderSessionBootReconcilerService,
  type ProviderSessionBootReconcilerShape,
} from "../Services/ProviderSessionBootReconciler.ts";

export const RESTART_INTERRUPTED_ACTIVITY_KIND = "provider.session.restart-interrupted";

const RESTART_INTERRUPT_REASON = "Server restarted while the turn was running.";

/**
 * Prompt kinds whose answer travels back through an in-memory provider
 * callback, paired with the failure activity that retires one.
 *
 * Retiring a prompt here reuses the tombstone the respond path already emits
 * when a user answers a dead prompt, so the shell summary and every client
 * derive the same "no longer pending" state. See `stalePendingRequest.ts`.
 */
const STALE_PROMPT_KINDS = [
  {
    requestedKind: "user-input.requested",
    resolvedKind: "user-input.resolved",
    failedKind: "provider.user-input.respond.failed",
    summary: "Provider user input response failed",
    detailKind: "user-input",
  },
  {
    requestedKind: "approval.requested",
    resolvedKind: "approval.resolved",
    failedKind: "provider.approval.respond.failed",
    summary: "Provider approval response failed",
    detailKind: "approval",
  },
] as const;

function activityRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
}

/**
 * Request ids still awaiting an answer.
 *
 * Replays the thread's activities in order so a prompt already answered or
 * already retired before the restart is not reopened.
 */
function findOpenPromptRequestIds(
  activities: ReadonlyArray<{
    readonly kind: string;
    readonly payload: unknown;
    readonly turnId: TurnId | null;
  }>,
  kinds: (typeof STALE_PROMPT_KINDS)[number],
): ReadonlyArray<{ readonly requestId: string; readonly turnId: TurnId | null }> {
  const open = new Map<string, { requestId: string; turnId: TurnId | null }>();
  for (const activity of activities) {
    const requestId = activityRequestId(activity.payload);
    if (requestId === null) {
      continue;
    }
    if (activity.kind === kinds.requestedKind) {
      open.set(requestId, { requestId, turnId: activity.turnId });
      continue;
    }
    if (activity.kind === kinds.resolvedKind || activity.kind === kinds.failedKind) {
      open.delete(requestId);
    }
  }
  return [...open.values()];
}

const makeProviderSessionBootReconciler = Effect.gen(function* () {
  const directory = yield* ProviderSessionDirectory;
  const ingestion = yield* ProviderRuntimeIngestionService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const eventId = crypto.randomUUIDv4.pipe(Effect.map(EventId.make));

  const appendRestartInterruptedActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const [commandId, activityId] = yield* Effect.all([
        crypto.randomUUIDv4.pipe(
          Effect.map((uuid) => CommandId.make(`server:restart-interrupted:${uuid}`)),
        ),
        eventId,
      ]);
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId,
        threadId: input.threadId,
        activity: {
          id: activityId,
          tone: "info",
          kind: RESTART_INTERRUPTED_ACTIVITY_KIND,
          summary: "Turn interrupted by server restart",
          payload: { detail: RESTART_INTERRUPT_REASON },
          turnId: input.turnId,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    });

  /**
   * Retires prompts whose provider callback died with the session.
   *
   * Ordered after the synthetic `session.exited` so the tombstones land
   * below the turn they belong to.
   */
  const retireOpenPrompts = (input: { readonly threadId: ThreadId; readonly createdAt: string }) =>
    Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery
        .getThreadDetailById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (!thread) {
        return;
      }

      for (const kinds of STALE_PROMPT_KINDS) {
        for (const open of findOpenPromptRequestIds(thread.activities, kinds)) {
          const [commandId, activityId] = yield* Effect.all([
            crypto.randomUUIDv4.pipe(
              Effect.map((uuid) => CommandId.make(`server:stale-prompt:${uuid}`)),
            ),
            eventId,
          ]);
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId,
            threadId: input.threadId,
            activity: {
              id: activityId,
              tone: "error",
              kind: kinds.failedKind,
              summary: kinds.summary,
              payload: {
                requestId: open.requestId,
                detail: stalePendingRequestDetail(kinds.detailKind, open.requestId),
              },
              turnId: open.turnId,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          });
        }
      }
    });

  const reconcileBinding = (binding: ProviderRuntimeBindingWithMetadata) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(binding.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      const activeTurnId = thread?.session?.activeTurnId ?? undefined;
      const instanceId =
        binding.providerInstanceId !== undefined
          ? { providerInstanceId: binding.providerInstanceId }
          : {};

      // `session.exited` is the whole repair: ingestion stops the session
      // and clears its active turn, which settles every still-running turn
      // as interrupted. A synthetic `turn.completed` would be wrong here —
      // it settles the session as `ready`, which records the turn as
      // *completed* — and its finalization work only drains in-memory
      // buffers that the restart already emptied.
      const sessionExited: ProviderRuntimeEvent = {
        provider: binding.provider,
        ...instanceId,
        threadId: binding.threadId,
        createdAt,
        eventId: yield* eventId,
        type: "session.exited",
        payload: { reason: RESTART_INTERRUPT_REASON, recoverable: true },
      };
      yield* ingestion.ingestSynthetic(sessionExited);

      yield* directory.upsert({
        threadId: binding.threadId,
        provider: binding.provider,
        ...instanceId,
        status: "stopped",
      });

      if (activeTurnId !== undefined) {
        // Ordered after the synthetic event so the notice lands below the
        // turn it explains.
        yield* ingestion.drain;
        yield* appendRestartInterruptedActivity({
          threadId: binding.threadId,
          turnId: activeTurnId,
          createdAt,
        });
      }

      yield* ingestion.drain;
      yield* retireOpenPrompts({ threadId: binding.threadId, createdAt });
    });

  const reconcile: ProviderSessionBootReconcilerShape["reconcile"] = () =>
    Effect.gen(function* () {
      const bindings = yield* directory.listBindings().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.boot-reconcile-list-failed", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as([] as ReadonlyArray<ProviderRuntimeBindingWithMetadata>)),
        ),
      );
      const pending = bindings.filter((binding) => binding.status !== "stopped");

      // One unreconcilable thread must not leave every later thread stuck
      // reporting work that is not running.
      yield* Effect.forEach(
        pending,
        (binding) =>
          reconcileBinding(binding).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.boot-reconcile-failed", {
                threadId: binding.threadId,
                provider: binding.provider,
                cause: Cause.pretty(cause),
              }),
            ),
            Effect.catchDefect((defect) =>
              Effect.logWarning("provider.session.boot-reconcile-defect", {
                threadId: binding.threadId,
                provider: binding.provider,
                defect,
              }),
            ),
          ),
        { discard: true },
      );

      yield* ingestion.drain;

      if (pending.length > 0) {
        yield* Effect.logInfo("provider.session.boot-reconciled", {
          reconciledCount: pending.length,
          totalBindings: bindings.length,
        });
      }
    });

  return { reconcile } satisfies ProviderSessionBootReconcilerShape;
});

export const ProviderSessionBootReconcilerLive = Layer.effect(
  ProviderSessionBootReconcilerService,
  makeProviderSessionBootReconciler,
);
