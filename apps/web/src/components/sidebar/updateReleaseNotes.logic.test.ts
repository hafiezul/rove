import { describe, expect, it } from "vite-plus/test";

import {
  formatDesktopUpdateVersion,
  parseReleaseNoteItem,
  summarizeDesktopUpdateReleaseNotes,
} from "./updateReleaseNotes.logic";

describe("parseReleaseNoteItem", () => {
  it("splits a generated GitHub line into kind, scope, title, author, and PR", () => {
    expect(
      parseReleaseNoteItem(
        "feat(worktrees): support checking out existing branch directly by @hafiezul in #243",
      ),
    ).toEqual({
      kind: "new",
      scope: "worktrees",
      title: "Support checking out existing branch directly",
      author: "hafiezul",
      pullRequest: 243,
    });
  });

  it("reads PR numbers from Markdown pull URLs and bot authors", () => {
    expect(
      parseReleaseNoteItem(
        "fix!: drop stale sockets by @renovate[bot] in https://github.com/acme/app/pull/12",
      ),
    ).toEqual({
      kind: "fixed",
      scope: null,
      title: "Drop stale sockets",
      author: "renovate[bot]",
      pullRequest: 12,
    });
  });

  it("keeps free-form lines whole under other changes", () => {
    expect(parseReleaseNoteItem("bump electron to 39")).toEqual({
      kind: "other",
      scope: null,
      title: "Bump electron to 39",
      author: null,
      pullRequest: null,
    });
    expect(parseReleaseNoteItem("chore(deps): update effect").kind).toBe("other");
  });
});

describe("summarizeDesktopUpdateReleaseNotes", () => {
  it("merges releases into New, Fixed, then other groups", () => {
    const { groups } = summarizeDesktopUpdateReleaseNotes(
      [
        {
          version: "0.0.3-nightly.20261008.679",
          items: ["fix(pr): restart reads by @a in #244", "feat(usage): add filters by @a in #247"],
          totalItems: 2,
        },
        {
          version: "0.0.3-nightly.20261007.678",
          items: ["docs: tidy readme by @a in #240", "feat(web): palette by @a in #245"],
          totalItems: 2,
        },
      ],
      0,
    );

    expect(groups.map((group) => [group.label, group.entries.map((entry) => entry.title)])).toEqual(
      [
        ["New", ["Add filters", "Palette"]],
        ["Fixed", ["Restart reads"]],
        ["Other changes", ["Tidy readme"]],
      ],
    );
  });

  it("shows authors only when more than one person contributed", () => {
    const note = (items: string[]) => [{ version: "1.0.0", items, totalItems: items.length }];

    expect(
      summarizeDesktopUpdateReleaseNotes(note(["feat: a by @x in #1", "fix: b by @x in #2"]), 0)
        .showAuthors,
    ).toBe(false);
    expect(
      summarizeDesktopUpdateReleaseNotes(note(["feat: a by @x in #1", "fix: b by @y in #2"]), 0)
        .showAuthors,
    ).toBe(true);
  });

  it("links one release to its tag and several to the history with hidden counts", () => {
    expect(
      summarizeDesktopUpdateReleaseNotes(
        [{ version: "0.0.36-nightly.3", items: ["feat: a"], totalItems: 1 }],
        0,
      ).footer,
    ).toEqual({
      url: "https://github.com/hafiezul/rove/releases/tag/v0.0.36-nightly.3",
      label: "Release notes on GitHub",
    });
    expect(
      summarizeDesktopUpdateReleaseNotes(
        [
          { version: "0.0.36-nightly.3", items: ["feat: a"], totalItems: 3 },
          { version: "0.0.36-nightly.2", items: ["feat: b"], totalItems: 1 },
        ],
        0,
      ).footer,
    ).toEqual({
      url: "https://github.com/hafiezul/rove/releases",
      label: "2 more changes on GitHub",
    });
    expect(
      summarizeDesktopUpdateReleaseNotes(
        [{ version: "0.0.36-nightly.3", items: ["feat: a"], totalItems: 1 }],
        1,
      ).footer,
    ).toEqual({
      url: "https://github.com/hafiezul/rove/releases",
      label: "1 older release on GitHub",
    });
  });
});

describe("formatDesktopUpdateVersion", () => {
  it("shortens nightly versions to build and date", () => {
    expect(formatDesktopUpdateVersion("0.0.3-nightly.20261008.679")).toBe("Nightly 679, Oct 8");
  });

  it("leaves other versions untouched", () => {
    expect(formatDesktopUpdateVersion("0.0.42")).toBe("0.0.42");
    expect(formatDesktopUpdateVersion("0.0.36-nightly.3")).toBe("0.0.36-nightly.3");
  });
});
