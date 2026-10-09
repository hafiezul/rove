import {
  GitMergeIcon,
  GitPullRequestIcon,
  LinkBreakIcon,
  LinkIcon,
  StackIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import type { PullRequestState } from "@rove-code/contracts";

import { createPhosphorStrokeIcon } from "../phosphorStrokeIcon";

// Phosphor has no draft or closed pull request, so draw them on its grid: the same
// source branch as GitPullRequest, with dots (draft) or a cross (closed) for the head.
const PULL_REQUEST_SOURCE_BRANCH = (
  <>
    <circle cx="72" cy="64" r="24" />
    <line x1="72" y1="88" x2="72" y2="168" />
    <circle cx="72" cy="192" r="24" />
    <circle cx="200" cy="192" r="24" />
  </>
);

const GitPullRequestDraftIcon = createPhosphorStrokeIcon(
  "GitPullRequestDraftIcon",
  <>
    {PULL_REQUEST_SOURCE_BRANCH}
    <circle cx="200" cy="128" r="12" fill="currentColor" stroke="none" />
    <circle cx="200" cy="72" r="12" fill="currentColor" stroke="none" />
  </>,
);

const GitPullRequestClosedIcon = createPhosphorStrokeIcon(
  "GitPullRequestClosedIcon",
  <>
    {PULL_REQUEST_SOURCE_BRANCH}
    <line x1="200" y1="168" x2="200" y2="128" />
    <path d="M180,52l40,40M220,52l-40,40" />
  </>,
);

export const PullRequestGlyph = {
  pullRequest: GitPullRequestIcon,
  reopen: GitPullRequestIcon,
  draft: GitPullRequestDraftIcon,
  closed: GitPullRequestClosedIcon,
  merged: GitMergeIcon,
  conflicting: WarningIcon,
  stack: StackIcon,
  link: LinkIcon,
  unlink: LinkBreakIcon,
} as const;

export type PullRequestGlyphIcon = (typeof PullRequestGlyph)[keyof typeof PullRequestGlyph];

export interface PullRequestStatePresentation {
  readonly label: string;
  readonly toneClassName: string;
  readonly Icon: PullRequestGlyphIcon;
}

export const PULL_REQUEST_STATE_PRESENTATION = {
  open: {
    label: "Open",
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
    Icon: PullRequestGlyph.pullRequest,
  },
  draft: {
    label: "Draft",
    toneClassName: "text-zinc-500 dark:text-zinc-400/80",
    Icon: PullRequestGlyph.draft,
  },
  closed: {
    label: "Closed",
    toneClassName: "text-red-600 dark:text-red-300/90",
    Icon: PullRequestGlyph.closed,
  },
  merged: {
    label: "Merged",
    toneClassName: "text-violet-600 dark:text-violet-300/90",
    Icon: PullRequestGlyph.merged,
  },
} as const satisfies Record<PullRequestState | "draft", PullRequestStatePresentation>;
