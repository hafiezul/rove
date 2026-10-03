import { useEffect, useReducer, useState } from "react";
import { Pressable, View } from "react-native";
import {
  MAX_LIMIT_RECOVERY_ATTEMPTS,
  type EnvironmentId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { visibleLimitRecovery, scheduledLimitResumeAt } from "@t3tools/shared/limitRecovery";
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
  const [busy, setBusy] = useState(false);
  const [tick, refresh] = useReducer((value: number) => value + 1, 0);
  const recovery = visibleLimitRecovery(thread, Date.now());
  const resetAt = recovery?.resetAt ?? null;
  const resumeAt = recovery?.resumeAt ?? null;
  useEffect(() => {
    if (resetAt === null || resumeAt !== null) return;
    const delay = Date.parse(resetAt) - Date.now();
    const timer = setTimeout(refresh, Math.max(0, Math.min(delay + 1, 2147483647)));
    return () => clearTimeout(timer);
  }, [resetAt, resumeAt, tick]);
  if (recovery === null || resetAt === null)
    return <ChatGptUsageLimitNotice environmentId={environmentId} thread={thread} />;
  const scheduled = resumeAt !== null;
  const at = scheduledLimitResumeAt(thread) ?? resetAt;
  const time = new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const stopped = (recovery.attempts ?? 0) >= MAX_LIMIT_RECOVERY_ATTEMPTS;
  const change = () => {
    if (busy) return;
    setBusy(true);
    void update({
      environmentId,
      input: {
        threadId: thread.id,
        requestId: recovery.requestId,
        resumeAt: scheduled ? null : resetAt,
      },
    }).finally(() => setBusy(false));
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
          <Text numberOfLines={1} className="text-xs font-t3-medium text-foreground">
            {scheduled
              ? "Auto-resume scheduled"
              : stopped
                ? "Auto-resume paused"
                : "Usage limit reached"}
          </Text>
          <Text className="text-xs text-foreground-muted">{`${scheduled ? "Resumes" : "Reset"} ${time}. ${stopped ? "Automatic retry limit reached." : "Keep the environment running."}`}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={scheduled ? "Cancel automatic resume" : "Resume at reset"}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          className="min-h-11 justify-center px-2"
          onPress={change}
        >
          <Text className="text-xs font-t3-medium text-foreground">
            {scheduled ? "Cancel" : "Resume at reset"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
