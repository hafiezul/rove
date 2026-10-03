import { useEffect, useReducer, useState } from "react";
import type {
  EnvironmentId,
  OrchestrationThreadShell,
  ThreadLimitRecovery,
} from "@t3tools/contracts";
import { MAX_LIMIT_RECOVERY_ATTEMPTS } from "@t3tools/contracts";
import { visibleLimitRecovery, scheduledLimitResumeAt } from "@t3tools/shared/limitRecovery";
import { ClockIcon } from "lucide-react";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type RecoveryNoticeThread = Parameters<typeof visibleLimitRecovery>[0] &
  Pick<OrchestrationThreadShell, "id" | "snoozedUntil">;

export function useUsageLimitRecoveryBannerItem(
  environmentId: EnvironmentId | null,
  thread: RecoveryNoticeThread | null,
): ComposerBannerStackItem | null {
  const [tick, refresh] = useReducer((value: number) => value + 1, 0);
  const recovery = thread === null ? null : visibleLimitRecovery(thread, Date.now());
  const resetAt = recovery?.resetAt ?? null;
  const resumeAt = recovery?.resumeAt ?? null;
  useEffect(() => {
    if (resetAt === null || resumeAt !== null) return;
    const delay = Date.parse(resetAt) - Date.now();
    const timer = setTimeout(refresh, Math.max(0, Math.min(delay + 1, 2147483647)));
    return () => clearTimeout(timer);
  }, [resetAt, resumeAt, tick]);
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
      />
    ),
  };
}

function UsageLimitRecoveryActions({
  environmentId,
  threadId,
  recovery,
}: {
  environmentId: EnvironmentId;
  threadId: OrchestrationThreadShell["id"];
  recovery: ThreadLimitRecovery;
}) {
  const update = useAtomCommand(threadEnvironment.setLimitRecovery, "usage-limit recovery");
  const [busy, setBusy] = useState(false);
  const scheduled = recovery.resumeAt !== null;
  const change = () => {
    if (busy) return;
    setBusy(true);
    void update({
      environmentId,
      input: {
        threadId,
        requestId: recovery.requestId,
        resumeAt: scheduled ? null : recovery.resetAt,
      },
    }).finally(() => setBusy(false));
  };
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      disabled={busy}
      onClick={change}
      aria-label={scheduled ? "Cancel automatic resume" : "Resume at reset"}
    >
      {scheduled ? "Cancel" : "Resume at reset"}
    </Button>
  );
}
