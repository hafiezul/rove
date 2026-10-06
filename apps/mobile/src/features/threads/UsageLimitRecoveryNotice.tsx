import { useEffect, useReducer, useState } from "react";
import { Pressable, View } from "react-native";
import {
  MAX_LIMIT_RECOVERY_ATTEMPTS,
  type EnvironmentId,
  type OrchestrationThreadShell,
} from "@rove-code/contracts";
import { visibleLimitRecovery, scheduledLimitResumeAt } from "@rove-code/shared/limitRecovery";
import { canSnooze, effectiveSnoozed } from "@rove-code/client-runtime/state/thread-settled";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ChatGptUsageLimitNotice } from "./ChatGptUsageLimitNotice";

export function UsageLimitRecoveryNotice({
  environmentId,
  thread,
}: {
  environmentId: EnvironmentId;
  thread: OrchestrationThreadShell;
}) {
  const update = useAtomCommand(threadEnvironment.setLimitRecovery, "usage-limit recovery");
  const snooze = useAtomCommand(threadEnvironment.snooze, "snooze until usage-limit reset");
  const wake = useAtomCommand(threadEnvironment.unsnooze, "wake limited thread");
  const [busy, setBusy] = useState(false);
  const [tick, refresh] = useReducer((value: number) => value + 1, 0);
  const recovery = visibleLimitRecovery(thread, Date.now());
  const resetAt = recovery?.resetAt ?? null;
  const resumeAt = recovery?.resumeAt ?? null;
  const snoozedUntil = thread.snoozedUntil;
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
  if (recovery === null || resetAt === null)
    return <ChatGptUsageLimitNotice environmentId={environmentId} thread={thread} />;
  const scheduled = resumeAt !== null;
  const snoozed = effectiveSnoozed(thread, { now: new Date().toISOString() });
  const canSnoozeAtReset =
    Date.parse(resetAt) > Date.now() && canSnooze(thread, { now: new Date().toISOString() });
  const at = scheduledLimitResumeAt(thread) ?? resetAt;
  const time = new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const stopped = (recovery.attempts ?? 0) >= MAX_LIMIT_RECOVERY_ATTEMPTS;
  const change = (action: "resume" | "snooze") => {
    if (busy) return;
    if (action === "snooze" && !snoozed && (!canSnoozeAtReset || Date.parse(resetAt) <= Date.now()))
      return;
    setBusy(true);
    const request =
      action === "resume"
        ? update({
            environmentId,
            input: {
              threadId: thread.id,
              requestId: recovery.requestId,
              resumeAt: scheduled ? null : resetAt,
            },
          })
        : snoozed
          ? wake({ environmentId, input: { threadId: thread.id, reason: "user" } })
          : snooze({ environmentId, input: { threadId: thread.id, snoozedUntil: resetAt } });
    void request.finally(() => setBusy(false));
  };
  return (
    <View
      accessibilityRole="alert"
      className="mx-3 mb-1 rounded-xl border border-border-subtle bg-composer-panel px-3 py-1"
    >
      <View className="flex-row items-center gap-2">
        <SymbolView
          name="clock"
          size={14}
          type="monochrome"
          tintColorClassName="accent-icon-muted"
        />
        <View className="flex-1 py-2">
          <Text numberOfLines={1} className="text-xs font-rove-medium text-foreground">
            {scheduled
              ? "Auto-resume scheduled"
              : stopped
                ? "Auto-resume paused"
                : "Usage limit reached"}
          </Text>
          <Text className="text-xs text-foreground-muted">{`${scheduled ? "Resumes" : "Reset"} ${time}. ${stopped ? "Automatic retry limit reached." : "Keep the environment running."}`}</Text>
        </View>
      </View>
      <View className="flex-row flex-wrap justify-end gap-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={scheduled ? "Cancel automatic resume" : "Resume at reset"}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          className="min-h-11 justify-center px-2"
          onPress={() => change("resume")}
        >
          <Text className="text-xs font-rove-medium text-foreground">
            {scheduled ? "Cancel" : "Resume at reset"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={snoozed ? "Wake now" : "Snooze until reset"}
          accessibilityState={{ disabled: busy || (!snoozed && !canSnoozeAtReset) }}
          disabled={busy || (!snoozed && !canSnoozeAtReset)}
          className="min-h-11 justify-center px-2"
          onPress={() => change("snooze")}
        >
          <Text className="text-xs font-rove-medium text-foreground">
            {snoozed ? "Wake now" : "Snooze until reset"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
