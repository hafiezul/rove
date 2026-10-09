import { describe, expect, it } from "vite-plus/test";

import type { PiAgentEntry } from "./PiAgentHook.ts";
import { PiAgentRoster, type PiAgentTaskDescriptor } from "./PiAgentRoster.ts";

function harness(replay: Record<string, PiAgentEntry[]> = {}) {
  const tasks: PiAgentTaskDescriptor[] = [];
  const timers: Array<() => void> = [];
  const roster = new PiAgentRoster({
    emit: (_threadId, task) => tasks.push(task),
    schedule: (run) => {
      timers.push(run);
      return { cancel: () => timers.splice(timers.indexOf(run), 1) };
    },
    progressIntervalMs: 0,
    replay: (_threadId, agentId) => replay[agentId] ?? [],
  });
  let sequence = 0;
  const entry = (a: string, k: PiAgentEntry["k"], fields: Partial<PiAgentEntry> = {}) =>
    ({ v: 1, a, th: "thread", w: 1, q: ++sequence, at: sequence, k, ...fields }) as PiAgentEntry;
  return {
    roster,
    tasks,
    entry,
    runTimers: () => {
      for (const run of timers.splice(0)) run();
    },
    statuses: (id: string) =>
      tasks
        .filter((task) => task.payload.taskId === id)
        .map((task) =>
          task.type === "task.completed"
            ? `completed:${task.payload.status}`
            : task.type === "task.updated"
              ? `updated:${task.payload.status}`
              : task.type,
        ),
  };
}

describe("PiAgentRoster", () => {
  it("hides an agent CLI that exits quickly without output", () => {
    const { roster, tasks, entry } = harness();
    roster.ingest(entry("cli", "start", { src: "cli", label: "claude", cmd: "claude --version" }));
    roster.ingest(entry("cli", "exit", { code: 0 }));
    expect(tasks).toEqual([]);
  });

  it("reveals an agent CLI once it produces output, and fails it on a non-zero exit", () => {
    const { roster, entry, statuses, tasks } = harness();
    roster.ingest(entry("cli", "start", { src: "cli", label: "codex", cmd: "codex exec fix" }));
    roster.ingest(entry("cli", "tool", { id: "1", name: "command", target: "ls" }));
    roster.ingest(entry("cli", "exit", { code: 2 }));
    expect(statuses("cli")).toEqual(["task.started", "task.progress", "completed:failed"]);
    expect(tasks.at(-1)?.payload).toMatchObject({ summary: "Exited with code 2." });
  });

  it("reopens a settled agent when it starts working again", () => {
    const { roster, entry, statuses } = harness();
    roster.ingest(entry("pi", "start", { src: "pi", parent: { th: "thread", t: "call" } }));
    roster.ingest(entry("pi", "busy"));
    roster.ingest(entry("pi", "idle"));
    roster.ingest(entry("pi", "busy"));
    roster.ingest(entry("pi", "text", { text: "boom", stop: "error", error: "Rate limited" }));
    roster.ingest(entry("pi", "idle"));
    expect(statuses("pi")).toEqual([
      "task.started",
      "task.progress",
      "completed:completed",
      "updated:running",
      "task.progress",
      "task.progress",
      "completed:failed",
    ]);
  });

  it("recovers a child's last entries from disk when its process exits first", () => {
    const { roster, entry, statuses, tasks } = harness({
      pi: [
        { v: 1, a: "pi", th: "thread", w: 2, q: 1, at: 1, k: "start", src: "pi" },
        {
          v: 1,
          a: "pi",
          th: "thread",
          w: 2,
          q: 2,
          at: 2,
          k: "text",
          text: "All done",
          stop: "stop",
        },
      ],
    });
    // Only the spawner's exit arrived over the channel.
    roster.ingest(entry("pi", "exit", { code: 0 }));
    expect(statuses("pi")).toEqual(["task.started", "task.progress", "completed:completed"]);
    expect(tasks.at(-1)?.payload).toMatchObject({ summary: "All done" });
  });

  it("fails an agent whose process vanished mid-run", () => {
    const { roster, entry, statuses, runTimers } = harness();
    roster.ingest(entry("pi", "start", { src: "pi" }));
    roster.ingest(entry("pi", "busy"));
    roster.channelClosed(["pi"]);
    runTimers();
    expect(statuses("pi").at(-1)).toBe("completed:failed");
  });
});
