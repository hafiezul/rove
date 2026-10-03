import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { currentLimitRecovery } from "@t3tools/shared/limitRecovery";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerSettingsService } from "../serverSettings.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { forkParked } from "../serverActivation.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const sql = yield* SqlClient.SqlClient;
  const dueThreads = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ threadId: ThreadId }),
    execute: (now) => sql`
      SELECT thread_id AS "threadId" FROM projection_threads
      WHERE deleted_at IS NULL AND archived_at IS NULL
        AND settled_override IS NOT 'settled'
        AND pending_approval_count = 0 AND pending_user_input_count = 0
        AND (snoozed_until IS NULL OR snoozed_until <= ${now})
        AND json_extract(limit_recovery_json, '$.resetAt') IS NOT NULL
        AND json_extract(limit_recovery_json, '$.resumeAt') <= ${now}
      ORDER BY json_extract(limit_recovery_json, '$.resumeAt'), thread_id
    `,
  });
  return Effect.fn("UsageLimitRecoveryReactor.sweep")(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const due = yield* dueThreads(now);
    const resumedInstances = new Set<string>();
    for (const { threadId } of due) {
      const thread = yield* snapshots.getThreadShellById(threadId);
      if (Option.isNone(thread)) continue;
      const recovery = currentLimitRecovery(thread.value);
      if (
        recovery === null ||
        recovery.resumeAt === null ||
        Date.parse(recovery.resumeAt) > Date.parse(now) ||
        thread.value.hasPendingApprovals ||
        thread.value.hasPendingUserInput ||
        thread.value.backgroundLiveness != null ||
        (thread.value.snoozedUntil != null &&
          Date.parse(thread.value.snoozedUntil) > Date.parse(now)) ||
        resumedInstances.has(recovery.modelSelection.instanceId)
      )
        continue;
      resumedInstances.add(recovery.modelSelection.instanceId);
      const { snapshotSequence } = yield* snapshots.getSnapshotSequence();
      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`limit-resume:${recovery.requestId}:${snapshotSequence}`),
          threadId,
          limitRecoveryRequestId: recovery.requestId,
          message: {
            messageId: MessageId.make(`limit-resume:${recovery.requestId}`),
            role: "user",
            text: "Continue where you left off.",
            attachments: [],
          },
          runtimeMode: thread.value.runtimeMode,
          interactionMode: thread.value.interactionMode,
          createdAt: now,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Usage-limit continuation skipped", { threadId, cause }),
          ),
        );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* make;
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const sql = yield* SqlClient.SqlClient;
    const settings = yield* ServerSettingsService;
    const scheduled = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ threadId: ThreadId }),
      execute: () => sql`
      SELECT thread_id AS "threadId" FROM projection_threads
      WHERE deleted_at IS NULL AND json_extract(limit_recovery_json, '$.resumeAt') IS NOT NULL
    `,
    });
    const cancel = Effect.fn("UsageLimitRecoveryReactor.cancelSchedules")(function* (
      includeManual: boolean,
      unknownOnly = false,
    ) {
      for (const { threadId } of yield* scheduled(undefined)) {
        const thread = yield* snapshots.getThreadShellById(threadId);
        const recovery = Option.isSome(thread) ? currentLimitRecovery(thread.value) : null;
        if (
          recovery === null ||
          (unknownOnly && recovery.resetAt !== null) ||
          (!includeManual && recovery.manual === true && recovery.resetAt !== null)
        )
          continue;
        yield* engine
          .dispatch({
            type: "thread.limit-recovery.set",
            commandId: CommandId.make(`limit-off:${recovery.requestId}`),
            threadId,
            requestId: recovery.requestId,
            resumeAt: null,
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }
    });
    const changes = yield* settings.subscribeChanges;
    let previous = (yield* settings.getSettings).autoResumeLimitedThreads;
    if (!previous) yield* cancel(false);
    else yield* cancel(false, true);
    yield* changes.pipe(
      Stream.map((value) => value.autoResumeLimitedThreads),
      Stream.changes,
      Stream.runForEach((enabled) => {
        const disabling = previous && !enabled;
        previous = enabled;
        return disabling ? cancel(true) : Effect.void;
      }),
      Effect.forkScoped,
    );
    yield* forkParked(
      sweep().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Usage-limit recovery sweep failed", { cause }),
        ),
        Effect.repeat(Schedule.spaced("5 seconds")),
      ),
    );
  }),
);
