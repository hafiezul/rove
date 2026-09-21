// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { afterEach, beforeEach, describe, vi } from "vite-plus/test";

import { makeSdkDiscoveryClient } from "./PiDriver.ts";

describe("Pi SDK discovery client", () => {
  let root: string;
  let agentDir: string;

  beforeEach(() => {
    root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-pi-discovery-")),
    );
    agentDir = NodePath.join(root, "agent");
    NodeFS.mkdirSync(NodePath.join(agentDir, "skills", "fixture-skill"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(agentDir, "skills", "fixture-skill", "SKILL.md"),
      "---\nname: fixture-skill\ndescription: A fixture skill\n---\n\nBody\n",
    );
    NodeFS.mkdirSync(NodePath.join(agentDir, "prompts"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(agentDir, "prompts", "greet.md"),
      "---\ndescription: Greet someone\nargument-hint: name\n---\n\nHello {{args}}\n",
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_OFFLINE", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("lists user-scope skills and prompt templates plus loaded extension commands", async () => {
    const client = makeSdkDiscoveryClient(() => [
      { name: "subagents", description: "Run a subagent" },
      // Collides with the greet template; the extension command wins.
      { name: "greet", description: "Extension command wins" },
    ]);
    const discovered = await client.discover({ cwd: undefined });

    assert.deepEqual(discovered.slashCommands, [
      { name: "subagents", description: "Run a subagent" },
      { name: "greet", description: "Extension command wins" },
    ]);
    const skill = discovered.skills.find((candidate) => candidate.name === "fixture-skill");
    assert.isDefined(skill);
    assert.strictEqual(skill?.scope, "user");
    assert.strictEqual(skill?.enabled, true);
  });

  it("describes neither the server cwd nor a random project when no cwd is given", async () => {
    // A project directory with its own resources exists, but the instance
    // snapshot is global: without an explicit cwd only user scope loads.
    const project = NodePath.join(root, "project");
    NodeFS.mkdirSync(NodePath.join(project, ".pi", "prompts"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(project, ".pi", "prompts", "local.md"),
      "---\ndescription: Project local\n---\n\nLocal\n",
    );
    const client = makeSdkDiscoveryClient();
    const discovered = await client.discover({ cwd: undefined });
    assert.isFalse(discovered.slashCommands.some((command) => command.name === "local"));

    // An explicit cwd (future thread-scoped callers) is still honored. The
    // loader follows Pi's trust rules, so the project opts in via settings.
    NodeFS.writeFileSync(
      NodePath.join(agentDir, "settings.json"),
      JSON.stringify({ defaultProjectTrust: "always" }),
    );
    const scoped = await client.discover({ cwd: project });
    const local = scoped.slashCommands.find((command) => command.name === "local");
    assert.isDefined(local);
    assert.strictEqual(local?.description, "Project local");
  });
});
