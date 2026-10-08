import type { DesktopUpdateReleaseNote, DesktopUpdateState } from "@rove-code/contracts";

import {
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
} from "../desktopUpdate.logic";

export type ReleaseNoteKind = "new" | "fixed" | "other";

export interface ReleaseNoteEntry {
  readonly key: string;
  readonly kind: ReleaseNoteKind;
  readonly scope: string | null;
  readonly title: string;
  readonly author: string | null;
  readonly pullRequest: number | null;
}

export interface ReleaseNoteGroup {
  readonly kind: ReleaseNoteKind;
  readonly label: string;
  readonly entries: ReadonlyArray<ReleaseNoteEntry>;
}

const RELEASE_NOTE_GROUP_LABELS = {
  new: "New",
  fixed: "Fixed",
  other: "Other changes",
} satisfies Record<ReleaseNoteKind, string>;

const RELEASE_NOTE_GROUP_ORDER: ReadonlyArray<ReleaseNoteKind> = ["new", "fixed", "other"];

// GitHub's generated notes end each line with "by @author in #123" (or the PR URL in Markdown).
const ATTRIBUTION_PATTERN =
  /\s+by\s+@(?<author>[\w-]+(?:\[bot\])?)(?:\s+in\s+(?:#(?<number>\d+)|https?:\/\/\S+\/pull\/(?<urlNumber>\d+)))?$/i;
const CONVENTIONAL_COMMIT_PATTERN = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?!?:\s+(?<title>.+)$/i;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function kindForCommitType(type: string): ReleaseNoteKind {
  switch (type.toLowerCase()) {
    case "feat":
      return "new";
    case "fix":
      return "fixed";
    default:
      return "other";
  }
}

/** Splits a GitHub generated release note line into its commit type, scope, and attribution. */
export function parseReleaseNoteItem(item: string): Omit<ReleaseNoteEntry, "key"> {
  let rest = item.trim();
  let author: string | null = null;
  let pullRequest: number | null = null;

  const attribution = ATTRIBUTION_PATTERN.exec(rest);
  if (attribution?.groups) {
    author = attribution.groups.author ?? null;
    const number = attribution.groups.number ?? attribution.groups.urlNumber;
    pullRequest = number ? Number(number) : null;
    rest = rest.slice(0, attribution.index).trimEnd();
  }

  const commit = CONVENTIONAL_COMMIT_PATTERN.exec(rest);
  if (!commit?.groups?.type || !commit.groups.title) {
    return { kind: "other", scope: null, title: capitalize(rest), author, pullRequest };
  }
  return {
    kind: kindForCommitType(commit.groups.type),
    scope: commit.groups.scope?.trim() || null,
    title: capitalize(commit.groups.title.trim()),
    author,
    pullRequest,
  };
}

export interface DesktopUpdateReleaseSummary {
  readonly groups: ReadonlyArray<ReleaseNoteGroup>;
  /** Authors are noise when one person wrote every change. */
  readonly showAuthors: boolean;
  readonly footer: { readonly url: string; readonly label: string } | null;
}

/** Merges every release the update spans into one list grouped by kind of change. */
export function summarizeDesktopUpdateReleaseNotes(
  releaseNotes: ReadonlyArray<DesktopUpdateReleaseNote>,
  omittedReleaseCount: number,
): DesktopUpdateReleaseSummary {
  const entriesByKind = new Map<ReleaseNoteKind, ReleaseNoteEntry[]>();
  const authors = new Set<string>();
  let omittedChangeCount = 0;

  for (const releaseNote of releaseNotes) {
    omittedChangeCount += Math.max(0, releaseNote.totalItems - releaseNote.items.length);
    releaseNote.items.forEach((item, index) => {
      const entry = { key: `${releaseNote.version}:${index}`, ...parseReleaseNoteItem(item) };
      if (entry.author) authors.add(entry.author);
      const entries = entriesByKind.get(entry.kind) ?? [];
      entries.push(entry);
      entriesByKind.set(entry.kind, entries);
    });
  }

  const groups = RELEASE_NOTE_GROUP_ORDER.flatMap((kind) => {
    const entries = entriesByKind.get(kind);
    return entries ? [{ kind, label: RELEASE_NOTE_GROUP_LABELS[kind], entries }] : [];
  });

  const singleRelease = releaseNotes.length === 1 && omittedReleaseCount === 0;
  const url = singleRelease
    ? getDesktopUpdateReleaseUrl(releaseNotes[0]?.version ?? null)
    : getDesktopUpdateReleaseHistoryUrl();
  const hiddenLabel =
    omittedReleaseCount > 0
      ? `${omittedReleaseCount} older ${omittedReleaseCount === 1 ? "release" : "releases"}`
      : omittedChangeCount > 0
        ? `${omittedChangeCount} more ${omittedChangeCount === 1 ? "change" : "changes"}`
        : null;

  return {
    groups,
    showAuthors: authors.size > 1,
    footer: url
      ? { url, label: hiddenLabel ? `${hiddenLabel} on GitHub` : "Release notes on GitHub" }
      : null,
  };
}

const NIGHTLY_VERSION_PATTERN =
  /-nightly\.(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})\.(?<build>\d+)$/;
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Nightly versions read as "Nightly 679, Oct 8"; anything else is shown as is. */
export function formatDesktopUpdateVersion(version: string): string {
  const groups = NIGHTLY_VERSION_PATTERN.exec(version)?.groups;
  const month = groups ? MONTH_NAMES[Number(groups.month) - 1] : undefined;
  if (!groups || !month) return version;
  return `Nightly ${groups.build}, ${month} ${Number(groups.day)}`;
}

/** The headline the update popover and its trigger tooltip share. */
export function getDesktopUpdatePopoverTitle(state: DesktopUpdateState): string {
  switch (state.status) {
    case "available":
      return "Update available";
    case "downloading":
      return "Downloading update";
    case "downloaded":
      return "Ready to install";
    case "error":
      if (state.errorContext === "download") return "Download failed";
      if (state.errorContext === "install") return "Install failed";
      return state.downloadedVersion ? "Ready to install" : "Update failed";
    default:
      return "Update";
  }
}
