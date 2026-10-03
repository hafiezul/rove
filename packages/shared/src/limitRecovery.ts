import {
  CommandId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ThreadLimitRecovery,
} from "@t3tools/contracts";
export function sameLimitRecoveryModel(left: ModelSelection, right: ModelSelection) {
  return left.instanceId === right.instanceId && left.model === right.model;
}

export function currentLimitRecovery(
  thread: Pick<
    OrchestrationThreadShell,
    "limitRecovery" | "latestTurn" | "modelSelection" | "archivedAt" | "settledOverride"
  >,
) {
  const recovery = thread.limitRecovery;
  return recovery != null &&
    thread.latestTurn?.turnId === recovery.turnId &&
    thread.latestTurn.state === "error" &&
    thread.archivedAt === null &&
    thread.settledOverride !== "settled" &&
    sameLimitRecoveryModel(thread.modelSelection, recovery.modelSelection)
    ? recovery
    : null;
}

export function visibleLimitRecovery(
  thread: Parameters<typeof currentLimitRecovery>[0],
  now: number,
) {
  const recovery = currentLimitRecovery(thread);
  return recovery !== null &&
    recovery.resetAt !== null &&
    (recovery.resumeAt !== null || Date.parse(recovery.resetAt) > now)
    ? recovery
    : null;
}

export function scheduledLimitResumeAt(
  thread: Pick<OrchestrationThreadShell, "limitRecovery" | "snoozedUntil">,
): string | null {
  const resumeAt = thread.limitRecovery?.resumeAt ?? null;
  return resumeAt !== null &&
    thread.snoozedUntil != null &&
    Date.parse(thread.snoozedUntil) > Date.parse(resumeAt)
    ? thread.snoozedUntil
    : resumeAt;
}

export function cancelsLimitRecoverySchedule(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.session-stop-requested" ||
    event.type === "thread.turn-interrupt-requested" ||
    (event.type === "thread.meta-updated" &&
      (event.payload.branch !== undefined || event.payload.worktreePath !== undefined))
  );
}

export function cancelLimitRecovery(
  recovery: ThreadLimitRecovery | null | undefined,
  event: OrchestrationEvent,
  fallback?: Pick<ThreadLimitRecovery, "turnId" | "modelSelection">,
) {
  // A stop can precede limit evidence; retain its turn binding so late evidence cannot re-arm it.
  const existing =
    recovery ??
    (fallback === undefined
      ? null
      : {
          ...fallback,
          requestId: event.commandId ?? CommandId.make(`limit-cancel:${event.eventId}`),
          resetAt: null,
          resumeAt: null,
        });
  return existing == null
    ? existing
    : {
        ...existing,
        requestId: event.commandId ?? CommandId.make(`limit-cancel:${event.eventId}`),
        resumeAt: null,
        manual: true,
      };
}

export function clearsLimitRecovery(
  event: OrchestrationEvent,
  recovery?: ThreadLimitRecovery | null,
): boolean {
  switch (event.type) {
    case "thread.archived":
    case "thread.settled":
    case "thread.deleted":
    case "thread.turn-start-requested":
    case "thread.reverted":
      return true;
    case "thread.message-sent":
      return event.payload.role === "user";
    case "thread.session-set":
      return (
        (event.payload.session.status === "running" ||
          event.payload.session.status === "starting") &&
        recovery?.resumeAt != null
      );
    case "thread.meta-updated":
      return (
        event.payload.modelSelection !== undefined &&
        (recovery == null ||
          !sameLimitRecoveryModel(event.payload.modelSelection, recovery.modelSelection))
      );
    default:
      return false;
  }
}
