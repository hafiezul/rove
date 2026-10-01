import type {
  EnvironmentId,
  ProjectId,
  WorktreeInventoryEntry,
  WorktreeInventoryInspection,
} from "@t3tools/contracts";
import {
  filterWorktrees,
  formatWorktreeSize,
  type WorktreeSizeState,
} from "@t3tools/client-runtime/worktree-inventory";
import { useNavigation } from "@react-navigation/native";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

function commandError(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : "The request failed. Refresh and try again.";
}

export function SettingsWorktreesRouteScreen() {
  const insets = useSafeAreaInsets();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const group = projectGroups.find((entry) => entry.key === selectedProjectKey);
  const [query, setQuery] = useState("");
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Worktrees" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <Text className="text-sm text-foreground-muted">
            Review checkouts without deleting branches or thread history. Last activity only
            reflects work in Rove, not use in other apps.
          </Text>
          <AppTextInput
            accessibilityLabel="Search worktrees"
            placeholder="Search branches, projects, or threads"
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            className="min-h-11 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
          />
          {selectedTargets.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              Connect an environment to review its worktrees.
            </Text>
          ) : (
            selectedTargets.map((target) => (
              <EnvironmentWorktrees
                key={target.environmentId}
                environmentId={target.environmentId}
                label={target.label}
                supported={target.serverConfig.environment.capabilities.worktreeInventory === true}
                projectIds={
                  selectedProjectKey === null
                    ? undefined
                    : (group?.members
                        .filter((member) => member.project.environmentId === target.environmentId)
                        .map((member) => member.project.id) ?? [])
                }
                query={query}
              />
            ))
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function EnvironmentWorktrees(props: {
  environmentId: EnvironmentId;
  label: string;
  supported: boolean;
  projectIds: ProjectId[] | undefined;
  query: string;
}) {
  const inventory = useEnvironmentQuery(
    props.supported
      ? vcsEnvironment.worktreeInventory({
          environmentId: props.environmentId,
          input: props.projectIds === undefined ? {} : { projectIds: props.projectIds },
        })
      : null,
  );
  const entries = filterWorktrees(inventory.data?.worktrees ?? [], props.query);
  return (
    <SettingsSection
      title={props.label}
      trailing={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Refresh worktrees on ${props.label}`}
          disabled={!props.supported || inventory.isPending}
          onPress={inventory.refresh}
          className="min-h-11 justify-center px-3 active:opacity-70 disabled:opacity-40"
        >
          <Text className="text-sm text-primary-text">
            {inventory.isPending ? "Refreshing…" : "Refresh"}
          </Text>
        </Pressable>
      }
    >
      {!props.supported ? (
        <Text className="p-4 text-sm text-foreground-muted">
          Update this environment to review its worktrees.
        </Text>
      ) : inventory.error ? (
        <Text accessibilityRole="alert" className="p-4 text-sm text-destructive">
          Could not load worktrees. {inventory.error} Try Refresh.
        </Text>
      ) : inventory.data === null ? (
        <Text className="p-4 text-sm text-foreground-muted">Loading worktrees…</Text>
      ) : (
        <>
          {inventory.data.issues.map((issue) => (
            <Text
              key={issue.projectId}
              accessibilityRole="alert"
              className="p-4 text-sm text-destructive"
            >
              {issue.projectTitle}. {issue.detail}
            </Text>
          ))}
          {entries.length === 0 ? (
            <Text className="p-4 text-sm text-foreground-muted">
              {props.query.trim()
                ? "No worktrees match your search."
                : "No linked worktrees found. Main checkouts are not listed."}
            </Text>
          ) : (
            entries.map((entry) => (
              <WorktreeRow
                key={entry.path}
                entry={entry}
                environmentId={props.environmentId}
                onRemoved={inventory.refresh}
              />
            ))
          )}
        </>
      )}
    </SettingsSection>
  );
}

function WorktreeRow({
  entry,
  environmentId,
  onRemoved,
}: {
  entry: WorktreeInventoryEntry;
  environmentId: EnvironmentId;
  onRemoved: () => void;
}) {
  const navigation = useNavigation();
  const [expanded, setExpanded] = useState(false);
  const inspection = useEnvironmentQuery(
    expanded
      ? vcsEnvironment.inspectWorktree({
          environmentId,
          input: { projectId: entry.projectId, path: entry.path },
        })
      : null,
  );
  const blockers = inspection.data?.removalBlockers ?? null;
  const [size, setSize] = useState<WorktreeSizeState>({ kind: "idle" });
  const [removing, setRemoving] = useState(false);
  const measure = useAtomCommand(vcsEnvironment.measureWorktree, { reportFailure: false });
  const remove = useAtomCommand(vcsEnvironment.removeInventoryWorktree, { reportFailure: false });
  const measureSize = async () => {
    setSize({ kind: "measuring" });
    const result = await measure({
      environmentId,
      input: { projectId: entry.projectId, path: entry.path },
    });
    setSize(
      result._tag === "Success"
        ? { kind: "ready", bytes: result.value.bytes }
        : { kind: "error", message: commandError(result.cause) },
    );
  };
  const removeCheckout = async (target: WorktreeInventoryInspection) => {
    setRemoving(true);
    const result = await remove({
      environmentId,
      input: {
        projectId: target.projectId,
        path: target.path,
        expectedHead: target.head,
        expectedBranch: target.branch,
      },
    });
    setRemoving(false);
    if (result._tag === "Failure")
      Alert.alert("Could not remove worktree", commandError(result.cause));
    else onRemoved();
  };
  const confirmRemoval = () => {
    const target = inspection.data;
    if (target === null) return;
    Alert.alert(
      "Remove worktree?",
      `Remove the checkout and installed dependencies at ${target.path}? The branch, commits, and thread history stay. Starting another turn recreates a linked thread's checkout.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove worktree",
          style: "destructive",
          onPress: () => void removeCheckout(target),
        },
      ],
    );
  };
  return (
    <View className="border-b border-border-subtle">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="gap-1 p-4 active:opacity-70"
      >
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={2}>
          {entry.branch ?? "Detached HEAD"}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {entry.projectTitle}
          {entry.threads.length === 0
            ? ", no linked threads"
            : `, ${entry.threads.length} linked ${entry.threads.length === 1 ? "thread" : "threads"}`}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {entry.lastActivityAt === null
            ? "Activity unknown"
            : `Last activity in Rove ${new Date(entry.lastActivityAt).toLocaleDateString()}`}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {!entry.managed
            ? "External worktree"
            : blockers === null
              ? "Not checked"
              : blockers.length === 0
                ? "Ready for review"
                : "Kept for safety"}
        </Text>
      </Pressable>
      {expanded ? (
        <View className="gap-3 px-4 pb-4">
          <Text selectable className="text-sm text-foreground">
            {entry.path}
          </Text>
          <View className="flex-row flex-wrap items-center justify-between gap-2">
            <Text className="text-sm text-foreground-muted">
              Estimated size{" "}
              {size.kind === "ready"
                ? formatWorktreeSize(size.bytes)
                : size.kind === "measuring"
                  ? "Calculating…"
                  : "Not calculated"}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={size.kind === "measuring"}
              onPress={() => void measureSize()}
              className="min-h-11 justify-center px-2 active:opacity-70 disabled:opacity-40"
            >
              <Text className="text-sm text-primary-text">
                {size.kind === "ready" ? "Recalculate size" : "Calculate size"}
              </Text>
            </Pressable>
          </View>
          {size.kind === "error" ? (
            <Text accessibilityRole="alert" className="text-sm text-destructive">
              {size.message}
            </Text>
          ) : null}
          <Text className="text-xs text-foreground-muted">
            File sizes exclude Git history and linked files. Actual disk space recovered may differ.
          </Text>
          {entry.threads.map((thread) => (
            <Pressable
              key={thread.id}
              accessibilityRole="button"
              onPress={() =>
                thread.archived
                  ? navigation.navigate("SettingsSheet", {
                      screen: "SettingsContent",
                      params: { screen: "SettingsArchive" },
                    })
                  : navigation.navigate("Thread", { environmentId, threadId: thread.id })
              }
              className="min-h-11 justify-center active:opacity-70"
            >
              <Text className="text-sm text-primary-text">
                {thread.archived ? `View archive for ${thread.title}` : thread.title}
              </Text>
            </Pressable>
          ))}
          {inspection.error ? (
            <Text accessibilityRole="alert" className="text-sm text-destructive">
              Could not check this worktree. {inspection.error}
            </Text>
          ) : null}
          {blockers === null ? (
            <Text className="text-xs text-foreground-muted">
              {inspection.isPending
                ? "Checking removal safety…"
                : "Removal safety has not been checked."}
            </Text>
          ) : blockers.length > 0 ? (
            blockers.map((blocker) => (
              <Text key={blocker} className="text-xs text-foreground-muted">
                {blocker}
              </Text>
            ))
          ) : (
            <Text className="text-xs text-foreground-muted">
              Review this checkout before removing it. Rove cannot detect every use outside the app.
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Remove worktree"
            disabled={removing || inspection.isPending || blockers === null || blockers.length > 0}
            onPress={confirmRemoval}
            className="min-h-11 justify-center active:opacity-70 disabled:opacity-40"
          >
            <Text className="text-sm text-destructive">
              {removing ? "Removing…" : "Remove worktree"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={inspection.isPending}
            onPress={inspection.refresh}
            className="min-h-11 justify-center active:opacity-70 disabled:opacity-40"
          >
            <Text className="text-sm text-primary-text">Check again</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
