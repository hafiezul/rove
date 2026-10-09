// @effect-diagnostics nodeBuiltinImport:off - Spawns the observer harness as a real process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { foldAgentTranscript } from "../../orchestration/agentTranscriptQuery.ts";
import type { PiAgentTaskDescriptor } from "./PiAgentRoster.ts";

const fixtures = NodeURL.fileURLToPath(new URL("./fixtures", import.meta.url));
const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

function runHarness() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-agent-observer-"));
  temporary.push(root);
  const transcripts = NodePath.join(root, "agent-transcripts");
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(fixtures, "pi-agent-observer-harness.ts"), transcripts, fixtures],
    { encoding: "utf8", timeout: 30_000 },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const tasks = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { threadId: string; task: PiAgentTaskDescriptor });
  return { transcripts, tasks };
}

// oxlint-disable-next-line rove/no-global-process-runtime -- The harness needs a POSIX shell and executable scripts.
describe.skipIf(NodeOS.platform() === "win32")("PiAgentObserver", () => {
  it("reports every way a tool can start an agent, without knowing the extension", () => {
    const { transcripts, tasks } = runHarness();
    expect(new Set(tasks.map(({ threadId }) => threadId))).toEqual(new Set(["thread-1"]));
    const completed = tasks.flatMap(({ task }) =>
      task.type === "task.completed" && task.payload.taskType === "subagent" ? [task.payload] : [],
    );
    const byRole = Object.fromEntries(
      completed.map((payload) => [`${payload.role}:${payload.title}`, payload]),
    );
    expect(Object.keys(byRole).toSorted()).toEqual(
      [
        "bash:Run through a shell",
        "claude:claude -p review",
        "fanout:Left half",
        "fanout:Right half",
        "inproc:Plan the work",
        "runner:Audit the runner",
        "subagent:Inspect the repo",
        "summarize:summarize model calls",
      ].toSorted(),
    );
    expect(byRole["subagent:Inspect the repo"]).toMatchObject({
      status: "completed",
      summary: "Done: found 3 files",
      toolUseId: "call-subagent",
      model: "test/fake-model",
      typedUsage: { totalTokens: 15, inputTokens: 10, outputTokens: 5, toolUses: 1 },
      runHandles: { hasTranscript: true },
    });
    expect(byRole["claude:claude -p review"]).toMatchObject({
      status: "completed",
      summary: "Review passed",
      typedUsage: { totalTokens: 16, toolUses: 1 },
    });
    expect(byRole["inproc:Plan the work"]).toMatchObject({ summary: "Plan ready" });
    expect(byRole["runner:Audit the runner"]).toMatchObject({
      status: "completed",
      summary: "Runner audited",
      model: "test/runner-model",
    });
    expect(byRole["summarize:summarize model calls"]).toMatchObject({
      summary: "Short summary",
      model: "test/summary-model",
    });

    // Two agents from one call become a group that settles with them.
    const group = tasks.filter(({ task }) => task.payload.taskId === "group-call-fanout");
    expect(group.map(({ task }) => task.type)).toEqual(["task.started", "task.completed"]);
    // Whichever child started first joins the group when the second arrives.
    for (const member of [byRole["fanout:Left half"], byRole["fanout:Right half"]]) {
      expect(
        tasks.some(
          ({ task }) =>
            task.payload.taskId === member?.taskId &&
            "parentAgentId" in task.payload &&
            task.payload.parentAgentId === "group-call-fanout",
        ),
      ).toBe(true);
    }

    // The child wrote its own transcript: task, tool with its result, and reply.
    const agentId = byRole["subagent:Inspect the repo"]!.taskId;
    const lines = NodeFS.readFileSync(
      NodePath.join(transcripts, "thread-1", `${agentId}.jsonl`),
      "utf8",
    ).split("\n");
    const transcript = foldAgentTranscript(lines, false);
    expect(transcript.model).toBe("test/fake-model");
    expect(
      transcript.entries.map((entry) =>
        entry.kind === "tool"
          ? [entry.kind, entry.name, entry.target, entry.status, entry.output]
          : [entry.kind, entry.kind === "text" ? entry.text : entry.text],
      ),
    ).toEqual([
      ["task", "Inspect the repo\nand report back"],
      ["tool", "read", "src/a.ts", "completed", "file body"],
      ["text", "Done: found 3 files"],
    ]);
  });
});
