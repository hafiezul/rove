import { useEffect, useReducer, useState } from "react";
import type {
  EnvironmentId,
  OrchestrationThreadShell,
  ThreadLimitRecovery,
} from "@rove-code/contracts";
import { MAX_LIMIT_RECOVERY_ATTEMPTS } from "@rove-code/contracts";
import { visibleLimitRecovery, scheduledLimitResumeAt } from "@rove-code/shared/limitRecovery";
import { canSnooze, effectiveSnoozed } from "@rove-code/client-runtime/state/thread-settled";
import { ClockIcon } from "lucide-react";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type RecoveryNoticeThread = Parameters<typeof visibleLimitRecovery>[0] &
  Pick<
    OrchestrationThreadShell,
    | "id"
    | "snoozedUntil"
    | "snoozedAt"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "latestUserMessageAt"
    | "session"
  >;

export function useUsageLimitRecoveryBannerItem(
  environmentId: EnvironmentId | null,
  thread: RecoveryNoticeThread | null,
): ComposerBannerStackItem | null {
  const [tick, refresh] = useReducer((value: number) => value + 1, 0);
  const recovery = thread === null ? null : visibleLimitRecovery(thread, Date.now());
  const resetAt = recovery?.resetAt ?? null;
  const resumeAt = recovery?.resumeAt ?? null;
  const snoozedUntil = thread?.snoozedUntil ?? null;
  useEffect(() => {
    if (resetAt === null) return;
    const now = Date.now();
    const nextChange = Math.min(
      ...[resetAt, snoozedUntil].map((at) => Date.parse(at ?? "")).filter((at) => at > now),
    );
    if (!Number.isFinite(nextChange)) return;
    const timer = setTimeout(refresh, Math.min(nextChange - now + 1, 2147483647));
    return () => clearTimeout(timer);
  }, [resetAt, snoozedUntil, tick]);
  if (environmentId === null || thread === null || recovery === null || resetAt === null)
    return null;
  const scheduled = resumeAt !== null;
  const at = scheduledLimitResumeAt(thread) ?? resetAt;
  const time = new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const stopped = (recovery.attempts ?? 0) >= MAX_LIMIT_RECOVERY_ATTEMPTS;
  return {
    id: `limit-recovery:${thread.id}`,
    variant: "info",
    compact: true,
    icon: <ClockIcon />,
    title: scheduled
      ? "Auto-resume scheduled"
      : stopped
        ? "Auto-resume paused"
        : "Usage limit reached",
    description: `${scheduled ? "Resumes" : "Reset"} ${time}. ${stopped ? "Automatic retry limit reached." : "Keep the environment running."}`,
    actions: (
      <UsageLimitRecoveryActions
        key={thread.id}
        environmentId={environmentId}
        threadId={thread.id}
        recovery={recovery}
        snoozed={effectiveSnoozed(thread, { now: new Date().toISOString() })}
        canSnoozeAtReset={
          Date.parse(resetAt) > Date.now() && canSnooze(thread, { now: new Date().toISOString() })
        }
      />
    ),
  };
}

function UsageLimitRecoveryActions({
  environmentId,
  threadId,
  recovery,
  snoozed,
  canSnoozeAtReset,
}: {
  environmentId: EnvironmentId;
  threadId: OrchestrationThreadShell["id"];
  recovery: ThreadLimitRecovery;
  snoozed: boolean;
  canSnoozeAtReset: boolean;
}) {
  const update = useAtomCommand(threadEnvironment.setLimitRecovery, "usage-limit recovery");
  const snooze = useAtomCommand(threadEnvironment.snooze, "snooze until usage-limit reset");
  const wake = useAtomCommand(threadEnvironment.unsnooze, "wake limited thread");
  const [busy, setBusy] = useState(false);
  const scheduled = recovery.resumeAt !== null;
  const change = (action: "resume" | "snooze") => {
    const resetAt = recovery.resetAt;
    if (busy || resetAt === null) return;
    if (action === "snooze" && !snoozed && (!canSnoozeAtReset || Date.parse(resetAt) <= Date.now()))
      return;
    setBusy(true);
    const request =
      action === "resume"
        ? update({
            environmentId,
            input: {
              threadId,
              requestId: recovery.requestId,
              resumeAt: scheduled ? null : resetAt,
            },
          })
        : snoozed
          ? wake({ environmentId, input: { threadId, reason: "user" } })
          : snooze({ environmentId, input: { threadId, snoozedUntil: resetAt } });
    void request.finally(() => setBusy(false));
  };
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={() => change("resume")}
        aria-label={scheduled ? "Cancel automatic resume" : "Resume at reset"}
      >
        {scheduled ? "Cancel" : "Resume at reset"}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={busy || (!snoozed && !canSnoozeAtReset)}
        onClick={() => change("snooze")}
      >
        {snoozed ? "Wake now" : "Snooze until reset"}
      </Button>
    </>
  );
}
