import { assert, describe, it } from "@effect/vitest";
import { describeDialectToolTasks } from "./PiSubagentDialects.ts";
import { piExampleSubagentDialect, compactPiExampleUpdate } from "./PiExampleSubagentDialect.ts";
import { piSubagentsDialect } from "./PiSubagentsDialect.ts";

const dialects = [piExampleSubagentDialect, piSubagentsDialect];
const child = (agent: string, task: string, exitCode: number) => ({
  agent,
  task,
  exitCode,
  agentSource: "user",
  messages: [{ content: [{ text: "private transcript" }] }],
  stderr: "private stderr",
  usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, turns: 1 },
  model: "example/model",
});
const result = (mode: string, results: unknown[]) => ({
  details: { mode, agentScope: "user", projectAgentsDir: null, results },
  content: [{ type: "text", text: "private output" }],
});
const tasks = (
  args: unknown,
  payload: unknown,
  phase: "update" | "result" = "result",
  isError = false,
) =>
  describeDialectToolTasks(dialects, {
    toolName: "subagent",
    toolCallId: "host",
    args,
    result: payload,
    phase,
    isError,
  });

describe("Pi bundled example subagent dialect", () => {
  it("starts and settles one child with identity, status and usage", () => {
    const events = tasks(
      { agent: "scout", task: "Find files" },
      result("single", [child("scout", "Find files", 0)]),
    );
    assert.deepStrictEqual(
      events.map((event) => event.type),
      ["task.started", "task.completed"],
    );
    assert.strictEqual(events[0]?.payload.taskId, "host:0");
    assert.strictEqual(events[0]?.payload.title, "scout: Find files");
    assert.strictEqual(events[1]?.payload.taskId, "host:0");
    if (events[1]?.type !== "task.completed") return;
    assert.strictEqual(events[1].payload.status, "completed");
    assert.strictEqual(events[1].payload.model, "example/model");
    assert.deepStrictEqual(events[1].payload.typedUsage, {
      totalTokens: 18,
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 5,
    });
    assert.notInclude(JSON.stringify(events), "private");
  });

  it("keeps parallel indices stable across placeholders, updates, and final results", () => {
    const args = {
      tasks: [
        { agent: "a", task: "First" },
        { agent: "b", task: "Second" },
      ],
    };
    const partial = result("parallel", [child("a", "First", -1), child("b", "Second", 0)]);
    const update = tasks(args, compactPiExampleUpdate(partial), "update");
    assert.deepStrictEqual(
      update.filter((e) => e.type === "task.started").map((e) => e.payload.taskId),
      ["host:0", "host:1"],
    );
    assert.deepStrictEqual(
      update.filter((e) => e.type === "task.progress").map((e) => e.payload.status),
      ["running", "running"],
    );
    assert.isFalse(update.some((e) => e.type === "task.completed"));
    assert.notInclude(JSON.stringify(compactPiExampleUpdate(partial)), "private");
    const final = tasks(
      args,
      result("parallel", [
        child("a", "First", 0),
        { ...child("b", "Second", 1), errorMessage: "bad" },
      ]),
    );
    assert.deepStrictEqual(
      final
        .filter((e) => e.type === "task.completed")
        .map((e) => [e.payload.taskId, e.payload.status]),
      [
        ["host:0", "completed"],
        ["host:1", "failed"],
      ],
    );
  });

  it("uses chain positions rather than substituted task text and stops unrun steps on interruption", () => {
    const args = {
      chain: [
        { agent: "a", task: "Start" },
        { agent: "b", task: "Use {previous}" },
        { agent: "c", task: "Finish" },
      ],
    };
    const update = tasks(
      args,
      result("chain", [child("a", "Start", 0), child("b", "Use a very long private output", 0)]),
      "update",
    );
    assert.deepStrictEqual(
      update.filter((e) => e.type === "task.started").map((e) => e.payload.taskId),
      ["host:0", "host:1", "host:2"],
    );
    assert.strictEqual(update[2]?.payload.title, "b: Use {previous}");
    const final = tasks(
      args,
      result("chain", [
        child("a", "Start", 0),
        { ...child("b", "Use secret", 1), stopReason: "error", errorMessage: "failure" },
      ]),
      "result",
      true,
    );
    assert.deepStrictEqual(
      final.filter((e) => e.type === "task.completed").map((e) => e.payload.status),
      ["completed", "failed", "stopped"],
    );
    assert.notInclude(JSON.stringify(final), "secret");
  });

  it("settles an identified partial when the tool is interrupted without final details", () => {
    const args = { agent: "a", task: "Work" };
    const partial = compactPiExampleUpdate(result("single", [child("a", "Work", 0)]));
    const events = describeDialectToolTasks(dialects, {
      toolName: "subagent",
      toolCallId: "host",
      args,
      result: partial,
      interrupted: true,
      isError: true,
    });
    assert.strictEqual(events[1]?.type, "task.completed");
    if (events[1]?.type === "task.completed")
      assert.strictEqual(events[1].payload.status, "stopped");
  });

  it("caps child count and task-event text without copying child transcripts", () => {
    const specs = Array.from({ length: 80 }, (_, index) => ({
      agent: `agent-${index}`,
      task: "x".repeat(1000),
    }));
    const payload = result(
      "parallel",
      specs.map((spec) => ({ ...child(spec.agent, spec.task, 0), errorMessage: "y".repeat(1000) })),
    );
    const update = compactPiExampleUpdate(payload);
    const events = tasks({ tasks: specs }, update, "update");
    assert.strictEqual(events.filter((event) => event.type === "task.started").length, 64);
    assert.isBelow(JSON.stringify(events).length, 55_000);
    assert.notInclude(JSON.stringify(update), "private transcript");
  });

  it("rejects malformed and unrelated payloads without guessing from tool names or prose", () => {
    const args = { agent: "scout", task: "Find files" };
    for (const payload of [
      null,
      {},
      result("other", [child("scout", "Find files", 0)]),
      { details: { mode: "single", results: [child("scout", "Find files", 0)] } },
      { content: [{ type: "text", text: "subagent completed" }] },
    ]) {
      assert.deepStrictEqual(tasks(args, payload), []);
    }
    assert.deepStrictEqual(
      describeDialectToolTasks(dialects, {
        toolName: "other_agent",
        args,
        result: result("single", [child("scout", "Find files", 0)]),
      }),
      [],
    );
    const old = describeDialectToolTasks(dialects, {
      toolName: "subagent",
      toolCallId: "host",
      args,
      result: {
        details: {
          mode: "single",
          toolCallId: "host",
          results: [{ agent: "scout", task: "Find files", exitCode: 0 }],
        },
      },
    });
    assert.deepStrictEqual(
      old.map((event) => event.type),
      ["task.started", "task.completed"],
    );
  });
});
