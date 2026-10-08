import { EnvironmentId, ProjectId, type VcsStatusResult } from "@rove-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildHandoffPrompt, resolveHandoffBlocker, resolveHandoffTargets } from "./threadHandoff";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");
const desk = EnvironmentId.make("desk");

function identity(canonicalKey: string, remoteName = "origin") {
  return {
    canonicalKey,
    locator: { source: "git-remote" as const, remoteName, remoteUrl: `git@x:${canonicalKey}` },
  };
}

describe("resolveHandoffTargets", () => {
  const environments = new Map([
    [laptop, { label: "Laptop", supportsCheckoutBaseBranch: true }],
    [server, { label: "Server", supportsCheckoutBaseBranch: true }],
    [desk, { label: "Desk", supportsCheckoutBaseBranch: false }],
  ]);

  it("lists other capable environments holding the same repository", () => {
    const source = {
      id: ProjectId.make("p-laptop"),
      environmentId: laptop,
      repositoryIdentity: identity("github.com/acme/app"),
    };
    expect(
      resolveHandoffTargets({
        source,
        environments,
        projects: [
          source,
          {
            id: ProjectId.make("p-server"),
            environmentId: server,
            repositoryIdentity: identity("github.com/acme/app", "upstream"),
          },
          {
            id: ProjectId.make("p-server-dupe"),
            environmentId: server,
            repositoryIdentity: identity("github.com/acme/app"),
          },
          {
            id: ProjectId.make("p-desk"),
            environmentId: desk,
            repositoryIdentity: identity("github.com/acme/app"),
          },
          {
            id: ProjectId.make("p-other"),
            environmentId: server,
            repositoryIdentity: identity("github.com/acme/other"),
          },
        ],
      }),
    ).toEqual([
      {
        environmentId: server,
        label: "Server",
        projectId: ProjectId.make("p-server"),
        remoteName: "upstream",
      },
    ]);
  });

  it("offers nothing for a project without a repository identity", () => {
    expect(
      resolveHandoffTargets({
        source: { id: ProjectId.make("p"), environmentId: laptop, repositoryIdentity: null },
        environments,
        projects: [
          {
            id: ProjectId.make("p-server"),
            environmentId: server,
            repositoryIdentity: identity("github.com/acme/app"),
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe("resolveHandoffBlocker", () => {
  const pushed: VcsStatusResult = {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/x",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  };

  it("allows a branch that is fully pushed", () => {
    expect(resolveHandoffBlocker(pushed)).toBeNull();
  });

  it("asks for uncommitted and unpushed work to reach the remote first", () => {
    expect(resolveHandoffBlocker({ ...pushed, hasWorkingTreeChanges: true })).toMatch(
      /uncommitted/,
    );
    expect(resolveHandoffBlocker({ ...pushed, hasUpstream: false })).toMatch(/not been pushed/);
    expect(resolveHandoffBlocker({ ...pushed, aheadCount: 2 })).toMatch(/2 unpushed commits/);
    expect(resolveHandoffBlocker({ ...pushed, refName: null })).toMatch(/Check out a branch/);
  });
});

describe("buildHandoffPrompt", () => {
  it("carries the conversation without system or in-flight messages", () => {
    const prompt = buildHandoffPrompt({
      title: "Speed up CI",
      sourceLabel: "Hafiezul",
      branch: "rove/ci",
      messages: [
        { role: "system", text: "internal", streaming: false },
        { role: "user", text: "Make typecheck faster", streaming: false },
        { role: "assistant", text: "Switched to tsgo.", streaming: false },
        { role: "assistant", text: "partial", streaming: true },
      ],
    });
    expect(prompt).toContain('continuing a thread from Hafiezul: "Speed up CI"');
    expect(prompt).toContain("`rove/ci`");
    expect(prompt).toContain(
      "### User\n\nMake typecheck faster\n\n### Assistant\n\nSwitched to tsgo.",
    );
    expect(prompt).not.toContain("internal");
    expect(prompt).not.toContain("partial");
  });

  it("keeps the newest messages when the transcript is long", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `message-${index} ${"x".repeat(3_000)}`,
      streaming: false,
    }));
    const prompt = buildHandoffPrompt({
      title: "t",
      sourceLabel: "s",
      branch: "b",
      messages,
    });
    expect(prompt).toContain("message-19");
    expect(prompt).not.toContain("message-0 ");
    expect(prompt.length).toBeLessThan(20_000);
  });
});
