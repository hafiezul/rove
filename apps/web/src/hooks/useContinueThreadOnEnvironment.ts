import { scopeProjectRef } from "@rove-code/client-runtime/environment";
import { squashAtomCommandFailure } from "@rove-code/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@rove-code/contracts";
import { useCallback, useMemo } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  buildHandoffPrompt,
  type HandoffTarget,
  resolveHandoffBlocker,
  resolveHandoffTargets,
} from "../lib/threadHandoff";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readProjects, readThreadShell, waitForThreadDetail } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { useThreadHandoffStore } from "../threadHandoffStore";
import { useWorktreeCheckoutStore } from "../worktreeCheckoutStore";
import { useNewThreadHandler } from "./useHandleNewThread";

function readEnvironments() {
  const configs = appAtomRegistry.get(environmentServerConfigsAtom);
  return new Map(
    [...configs].map(([environmentId, config]) => [
      environmentId,
      {
        label: config.environment.label,
        supportsCheckoutBaseBranch:
          config.environment.capabilities.worktreeCheckoutBaseBranch === true,
        supportsContinuationLinks: config.environment.capabilities.threadContinuationLinks === true,
      },
    ]),
  );
}

/**
 * "Continue on another environment" for the thread menus. Targets are read
 * at menu-open time; continuing checks the branch is pushed, then opens a
 * draft on the target that checks out the same branch with the conversation
 * in its composer. Nothing is sent until the user sends it.
 */
export function useContinueThreadOnEnvironment() {
  const handleNewThread = useNewThreadHandler();
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });

  const resolveTargets = useCallback((threadRef: ScopedThreadRef): ReadonlyArray<HandoffTarget> => {
    const thread = readThreadShell(threadRef);
    if (!thread?.projectId || !thread.branch) return [];
    const source = readProject(scopeProjectRef(thread.environmentId, thread.projectId));
    if (!source) return [];
    return resolveHandoffTargets({
      source,
      projects: readProjects(),
      environments: readEnvironments(),
    });
  }, []);

  const continueOn = useCallback(
    async (threadRef: ScopedThreadRef, target: HandoffTarget) => {
      const thread = readThreadShell(threadRef);
      const project = thread?.projectId
        ? readProject(scopeProjectRef(thread.environmentId, thread.projectId))
        : null;
      if (!thread || !project) return;
      const blocked = (description: string) =>
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: `Can't continue on ${target.label} yet`,
            description,
          }),
        );
      const status = await refreshStatus({
        environmentId: thread.environmentId,
        input: { cwd: thread.worktreePath ?? project.workspaceRoot },
      });
      if (status._tag === "Failure") {
        const error = squashAtomCommandFailure(status);
        blocked(error instanceof Error ? error.message : "Could not read the branch status.");
        return;
      }
      const blocker = resolveHandoffBlocker(status.value);
      const branch = status.value.refName;
      if (blocker !== null || branch === null) {
        blocked(blocker ?? "Check out a branch before continuing elsewhere.");
        return;
      }
      const detail = await waitForThreadDetail(threadRef);
      const prompt = buildHandoffPrompt({
        title: thread.title,
        sourceLabel: readEnvironments().get(thread.environmentId)?.label ?? "another machine",
        branch,
        messages: detail?.messages ?? [],
      });
      const opened = await handleNewThread(
        scopeProjectRef(target.environmentId, target.projectId),
        {
          branch: `${target.remoteName}/${branch}`,
          worktreePath: null,
          envMode: "worktree",
          startFromOrigin: false,
        },
      );
      if (opened === null) return;
      useWorktreeCheckoutStore.getState().setCheckoutBaseBranch(opened.threadId, true);
      useThreadHandoffStore.getState().setPending(opened.threadId, {
        sourceEnvironmentId: threadRef.environmentId,
        sourceThreadId: threadRef.threadId,
      });
      useComposerDraftStore.getState().setPrompt(opened.draftId, prompt);
    },
    [handleNewThread, refreshStatus],
  );

  return useMemo(() => ({ resolveTargets, continueOn }), [continueOn, resolveTargets]);
}

/**
 * Links a thread created from a "Continue on" draft with the thread it came
 * from, on both environments. Called once the draft's first send succeeds.
 * Best effort: a missing link never undoes the continued thread.
 */
export function useRecordThreadHandoff() {
  const recordContinuation = useAtomCommand(threadEnvironment.recordContinuation, {
    reportFailure: false,
  });
  return useCallback(
    async (target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }) => {
      const pending = useThreadHandoffStore.getState().take(target.threadId);
      if (pending === null) return;
      const environments = readEnvironments();
      const source = environments.get(pending.sourceEnvironmentId);
      const destination = environments.get(target.environmentId);
      if (!source || !destination) return;
      const createdAt = new Date().toISOString();
      await Promise.all([
        destination.supportsContinuationLinks
          ? recordContinuation({
              environmentId: target.environmentId,
              input: {
                threadId: target.threadId,
                link: {
                  direction: "from",
                  environmentId: pending.sourceEnvironmentId,
                  threadId: pending.sourceThreadId,
                  environmentLabel: source.label,
                },
                createdAt,
              },
            })
          : null,
        source.supportsContinuationLinks
          ? recordContinuation({
              environmentId: pending.sourceEnvironmentId,
              input: {
                threadId: pending.sourceThreadId,
                link: {
                  direction: "to",
                  environmentId: target.environmentId,
                  threadId: target.threadId,
                  environmentLabel: destination.label,
                },
                createdAt,
              },
            })
          : null,
      ]);
    },
    [recordContinuation],
  );
}
