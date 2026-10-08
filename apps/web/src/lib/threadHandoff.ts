import {
  THREAD_CONTINUED_ACTIVITY_KIND,
  ThreadContinuationLink,
  type EnvironmentId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
  type ProjectId,
  type RepositoryIdentity,
  type VcsStatusResult,
} from "@rove-code/contracts";
import * as Schema from "effect/Schema";
import { assistantCitationsToPlainText } from "@rove-code/shared/assistantCitations";

import { stripInlineContextReferences } from "./composerContextReferences";

/**
 * "Continue on another environment": the same repository checked out on
 * another machine picks a thread up from its pushed branch. Git carries the
 * code and the client carries the conversation, so the environments never
 * talk to each other.
 */

export interface HandoffTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projectId: ProjectId;
  /** The target checkout's own name for the shared remote, e.g. `origin`. */
  readonly remoteName: string;
}

interface HandoffProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

/**
 * Other environments that hold the same repository and can check out an
 * existing branch. One target per environment, the first matching project.
 */
export function resolveHandoffTargets(input: {
  readonly source: HandoffProject;
  readonly projects: ReadonlyArray<HandoffProject>;
  readonly environments: ReadonlyMap<
    EnvironmentId,
    { readonly label: string; readonly supportsCheckoutBaseBranch: boolean }
  >;
}): ReadonlyArray<HandoffTarget> {
  const canonicalKey = input.source.repositoryIdentity?.canonicalKey;
  if (!canonicalKey) return [];
  const targets = new Map<EnvironmentId, HandoffTarget>();
  for (const project of input.projects) {
    const identity = project.repositoryIdentity;
    if (
      project.environmentId === input.source.environmentId ||
      targets.has(project.environmentId) ||
      identity?.canonicalKey !== canonicalKey
    ) {
      continue;
    }
    const environment = input.environments.get(project.environmentId);
    if (!environment?.supportsCheckoutBaseBranch) continue;
    targets.set(project.environmentId, {
      environmentId: project.environmentId,
      label: environment.label,
      projectId: project.id,
      remoteName: identity.locator.remoteName,
    });
  }
  return [...targets.values()].toSorted((left, right) => left.label.localeCompare(right.label));
}

/**
 * Why the source thread cannot be continued elsewhere yet, or null when its
 * branch is fully on the remote. The other machine only sees what was pushed.
 */
export function resolveHandoffBlocker(status: VcsStatusResult): string | null {
  if (!status.isRepo) return "This thread is not in a Git repository.";
  if (status.refName === null) return "Check out a branch before continuing elsewhere.";
  if (status.hasWorkingTreeChanges) {
    return "This thread has uncommitted changes. Commit and push them first.";
  }
  if (!status.hasUpstream) return "This branch has not been pushed yet. Push it first.";
  if (status.aheadCount > 0) {
    return `This branch has ${status.aheadCount} unpushed commit${status.aheadCount === 1 ? "" : "s"}. Push first.`;
  }
  return null;
}

const HANDOFF_MESSAGE_MAX_CHARS = 4_000;
const HANDOFF_TRANSCRIPT_MAX_CHARS = 16_000;

function truncateMessage(text: string): string {
  return text.length <= HANDOFF_MESSAGE_MAX_CHARS
    ? text
    : `${text.slice(0, HANDOFF_MESSAGE_MAX_CHARS).trimEnd()}\n[…truncated]`;
}

/**
 * The first message of the continued thread: where the work came from and the
 * most recent conversation, newest kept when the transcript is too long. The
 * user reviews and sends it, so nothing runs on the other machine until then.
 */
export function buildHandoffPrompt(input: {
  readonly title: string;
  readonly sourceLabel: string;
  readonly branch: string;
  readonly messages: ReadonlyArray<Pick<OrchestrationMessage, "role" | "text" | "streaming">>;
}): string {
  const entries: string[] = [];
  let used = 0;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index]!;
    if (message.role === "system" || message.streaming) continue;
    const text = assistantCitationsToPlainText(stripInlineContextReferences(message.text)).trim();
    if (text.length === 0) continue;
    const entry = `### ${message.role === "user" ? "User" : "Assistant"}\n\n${truncateMessage(text)}`;
    if (used > 0 && used + entry.length > HANDOFF_TRANSCRIPT_MAX_CHARS) break;
    entries.unshift(entry);
    used += entry.length;
  }
  const header = [
    `I'm continuing a thread from ${input.sourceLabel}: "${input.title}".`,
    `This worktree is on its branch \`${input.branch}\`, with everything that was pushed from there.`,
  ];
  if (entries.length === 0) {
    return [...header, "", "Review the branch and continue the work."].join("\n");
  }
  return [
    ...header,
    "",
    "Recent conversation, oldest first:",
    "",
    entries.join("\n\n"),
    "",
    "Review the branch and continue where that thread left off.",
  ].join("\n");
}

const isThreadContinuationLink = Schema.is(ThreadContinuationLink);

/** The most recent continuation recorded on a thread, newest activity last. */
export function resolveLatestContinuation(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>,
): ThreadContinuationLink | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (
      activity.kind === THREAD_CONTINUED_ACTIVITY_KIND &&
      isThreadContinuationLink(activity.payload)
    ) {
      return activity.payload;
    }
  }
  return null;
}
