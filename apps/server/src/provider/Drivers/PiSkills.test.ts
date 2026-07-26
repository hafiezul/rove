import { describe, expect, it } from "@effect/vitest";

import {
  mapPiExtensionCommandsToServerProviderSlashCommands,
  mapPiSkillsToServerProviderSkills,
  parsePiExtensionCommandsResponse,
  parsePiGetCommandsResponse,
  rewritePiSkillTokens,
} from "./PiSkills.ts";

describe("parsePiGetCommandsResponse", () => {
  it("maps skill commands from structured sourceInfo provenance", () => {
    const response = {
      commands: [
        {
          name: "llama",
          description: "Manage llama.cpp router models",
          source: "extension",
          sourceInfo: { path: "<inline:llama.cpp>", source: "inline", scope: "temporary" },
        },
        {
          name: "skill:code-review",
          description: "Review the changes since a fixed point.",
          source: "skill",
          sourceInfo: {
            path: "/Users/example/.agents/skills/code-review/SKILL.md",
            source: "auto",
            scope: "user",
            origin: "top-level",
          },
        },
        {
          name: "skill:test-probe-skill",
          description: "A project skill.",
          source: "skill",
          sourceInfo: {
            path: "/workspace/project/.agents/skills/test-probe-skill/SKILL.md",
            source: "auto",
            scope: "project",
          },
        },
        {
          name: "fix-tests",
          description: "Fix failing tests",
          source: "prompt",
          sourceInfo: { path: "/workspace/project/.pi/prompts/fix-tests.md", scope: "project" },
        },
      ],
    };

    expect(parsePiGetCommandsResponse(response)).toEqual([
      {
        name: "code-review",
        description: "Review the changes since a fixed point.",
        scope: "user",
        path: "/Users/example/.agents/skills/code-review/SKILL.md",
      },
      {
        name: "test-probe-skill",
        description: "A project skill.",
        scope: "project",
        path: "/workspace/project/.agents/skills/test-probe-skill/SKILL.md",
      },
    ]);
  });

  it("returns an empty list for malformed responses", () => {
    expect(parsePiGetCommandsResponse(undefined)).toEqual([]);
    expect(parsePiGetCommandsResponse({})).toEqual([]);
    expect(parsePiGetCommandsResponse({ commands: "nope" })).toEqual([]);
  });

  it("drops skill entries without a usable name or path", () => {
    const response = {
      commands: [
        { name: "skill:ok", source: "skill", sourceInfo: { path: "/x/SKILL.md", scope: "user" } },
        { name: "skill:no-path", source: "skill", sourceInfo: { scope: "user" } },
        { name: "skill:", source: "skill", sourceInfo: { path: "/y/SKILL.md", scope: "user" } },
        { name: "not-a-skill", source: "skill", sourceInfo: { path: "/z/SKILL.md" } },
      ],
    };

    expect(parsePiGetCommandsResponse(response)).toEqual([
      { name: "ok", path: "/x/SKILL.md", scope: "user" },
    ]);
  });
});

describe("parsePiExtensionCommandsResponse", () => {
  it("maps extension commands from structured sourceInfo provenance", () => {
    const response = {
      commands: [
        {
          name: "fast",
          description: "Toggle fast mode: /fast on|off|status",
          source: "extension",
          sourceInfo: { path: "/Users/example/pi-extensions/pi-fast-mode.ts", scope: "user" },
        },
        {
          name: "llama",
          source: "extension",
          sourceInfo: { path: "<inline:llama.cpp>", source: "inline", scope: "temporary" },
        },
        {
          name: "skill:code-review",
          description: "Review the changes since a fixed point.",
          source: "skill",
          sourceInfo: { path: "/x/SKILL.md", scope: "user" },
        },
        {
          name: "fix-tests",
          description: "Fix failing tests",
          source: "prompt",
          sourceInfo: { path: "/workspace/project/.pi/prompts/fix-tests.md", scope: "project" },
        },
      ],
    };

    expect(parsePiExtensionCommandsResponse(response)).toEqual([
      {
        name: "fast",
        description: "Toggle fast mode: /fast on|off|status",
        path: "/Users/example/pi-extensions/pi-fast-mode.ts",
      },
      { name: "llama", path: "<inline:llama.cpp>" },
    ]);
  });

  it("returns an empty list for malformed responses", () => {
    expect(parsePiExtensionCommandsResponse(undefined)).toEqual([]);
    expect(parsePiExtensionCommandsResponse({})).toEqual([]);
    expect(parsePiExtensionCommandsResponse({ commands: "nope" })).toEqual([]);
  });

  it("drops extension entries without a usable name or path", () => {
    const response = {
      commands: [
        { name: "fast", source: "extension", sourceInfo: { path: "/x/fast.ts" } },
        { name: "no-path", source: "extension", sourceInfo: { scope: "user" } },
        { name: " ", source: "extension", sourceInfo: { path: "/y/blank.ts" } },
        { name: "no-source-info", source: "extension" },
      ],
    };

    expect(parsePiExtensionCommandsResponse(response)).toEqual([
      { name: "fast", path: "/x/fast.ts" },
    ]);
  });
});

describe("mapPiExtensionCommandsToServerProviderSlashCommands", () => {
  it("maps to the snapshot contract, deduped by name with first registration winning", () => {
    expect(
      mapPiExtensionCommandsToServerProviderSlashCommands([
        {
          name: "fast",
          description: "Toggle fast mode: /fast on|off|status",
          path: "/x/fast-mode.ts",
        },
        { name: "llama", path: "<inline:llama.cpp>" },
        { name: "fast", description: "duplicate registration", path: "/other/fast.ts" },
      ]),
    ).toEqual([
      { name: "fast", description: "Toggle fast mode: /fast on|off|status" },
      { name: "llama" },
    ]);
  });
});

describe("mapPiSkillsToServerProviderSkills", () => {
  it("maps to the snapshot contract with every skill enabled", () => {
    expect(
      mapPiSkillsToServerProviderSkills([
        {
          name: "code-review",
          description: "Review the changes since a fixed point.",
          scope: "user",
          path: "/Users/example/.agents/skills/code-review/SKILL.md",
        },
        { name: "bare", path: "/x/bare/SKILL.md" },
      ]),
    ).toEqual([
      {
        name: "code-review",
        description: "Review the changes since a fixed point.",
        scope: "user",
        path: "/Users/example/.agents/skills/code-review/SKILL.md",
        enabled: true,
      },
      { name: "bare", path: "/x/bare/SKILL.md", enabled: true },
    ]);
  });
});

describe("rewritePiSkillTokens", () => {
  const known = new Set(["code-review", "grill-me"]);

  it("rewrites a sole-content skill token into a /skill: command with args", () => {
    expect(rewritePiSkillTokens("$code-review main", known)).toEqual({
      text: "/skill:code-review main",
      invokedSkills: ["code-review"],
    });
  });

  it("rewrites a bare sole-content skill token", () => {
    expect(rewritePiSkillTokens("$grill-me", known)).toEqual({
      text: "/skill:grill-me",
      invokedSkills: ["grill-me"],
    });
  });

  it("prepends /skill:name ahead of free prose for mid-text tokens", () => {
    expect(rewritePiSkillTokens("please $code-review this diff carefully", known)).toEqual({
      text: "/skill:code-review\nplease /skill:code-review this diff carefully",
      invokedSkills: ["code-review"],
    });
  });

  it("prepends the first known skill when prose leads the message", () => {
    expect(rewritePiSkillTokens("review this. $code-review main please", known)).toEqual({
      text: "/skill:code-review\nreview this. /skill:code-review main please",
      invokedSkills: ["code-review"],
    });
  });

  it("rewrites multiple distinct skills and reports them in first-use order", () => {
    expect(rewritePiSkillTokens("$grill-me then $code-review and $grill-me again", known)).toEqual({
      text: "/skill:grill-me then /skill:code-review and /skill:grill-me again",
      invokedSkills: ["grill-me", "code-review"],
    });
  });

  it("prepends the first of multiple mid-text skills", () => {
    expect(rewritePiSkillTokens("use $grill-me and $code-review here", known)).toEqual({
      text: "/skill:grill-me\nuse /skill:grill-me and /skill:code-review here",
      invokedSkills: ["grill-me", "code-review"],
    });
  });

  it("passes unknown tokens through untouched", () => {
    expect(rewritePiSkillTokens("costs $5 and $unknown-skill is prose", known)).toEqual({
      text: "costs $5 and $unknown-skill is prose",
      invokedSkills: [],
    });
  });

  it("does not rewrite tokens embedded in words or variables", () => {
    expect(rewritePiSkillTokens("echo $code-review$grill-me foo$code-review", known)).toEqual({
      text: "/skill:code-review\necho /skill:code-review$grill-me foo$code-review",
      invokedSkills: ["code-review"],
    });
  });

  it("leaves text without tokens unchanged", () => {
    expect(rewritePiSkillTokens("plain prompt", known)).toEqual({
      text: "plain prompt",
      invokedSkills: [],
    });
  });
});
