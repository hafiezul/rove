// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";

import {
  collectPiNotifyContents,
  describeDialectToolTasks,
  describeNotifyReading,
  type PiSubagentDialect,
  type PiSubagentTaskDescriptor,
} from "./PiSubagentDialects.ts";
import {
  parsePiNotifyContent,
  parsePiWorkflowScript,
  piSubagentsDialect,
  describePiSubagentToolTasks,
} from "./PiSubagentsDialect.ts";

const DIALECTS: ReadonlyArray<PiSubagentDialect> = [piSubagentsDialect];

function toolTasks(
  input: Parameters<typeof describePiSubagentToolTasks>[0],
): ReadonlyArray<PiSubagentTaskDescriptor> {
  return describeDialectToolTasks(DIALECTS, input);
}

describe("pi-subagents dialect", () => {
  it("ignores non-subagent tools and management reads", () => {
    assert.deepStrictEqual(toolTasks({ toolName: "bash", args: {}, result: {} }), []);
    assert.deepStrictEqual(
      toolTasks({
        toolName: "subagent",
        args: { action: "list" },
        result: {
          content: [{ type: "text", text: "agents" }],
          details: { mode: "management", results: [] },
        },
      }),
      [],
    );
    assert.deepStrictEqual(toolTasks({ toolName: "subagent", args: null, result: null }), []);
    assert.deepStrictEqual(toolTasks({ toolName: "subagent", args: [], result: [] }), []);
  });

  it("starts a leaf agent on single spawn", () => {
    const descriptors = toolTasks({
      toolName: "subagent",
      args: { agent: "delegate", task: "Report shell/OS/date" },
      result: {
        content: [{ type: "text", text: "Async: delegate [eb8d654a]" }],
        details: {
          mode: "single",
          runId: "eb8d654a-606f-4f01-ab60-ef2733a18f68",
          toolCallId: "call_1",
          results: [],
        },
      },
    });
    assert.strictEqual(descriptors.length, 1);
    assert.strictEqual(descriptors[0]?.type, "task.started");
    if (descriptors[0]?.type !== "task.started") return;
    assert.strictEqual(descriptors[0].payload.taskId, "eb8d654a-606f-4f01-ab60-ef2733a18f68");
    assert.strictEqual(descriptors[0].payload.title, "delegate: Report shell/OS/date");
    assert.strictEqual(descriptors[0].payload.role, "delegate");
    assert.strictEqual(descriptors[0].payload.taskType, "subagent");
  });

  it("falls back to the spawn text for the agent name", () => {
    const descriptors = toolTasks({
      toolName: "subagent",
      args: {},
      result: {
        content: [{ type: "text", text: "Async: scout [29d83be0]" }],
        details: { mode: "single", runId: "29d83be0-034d-471b-a4b7-1904c0ddb3c4", results: [] },
      },
    });
    assert.strictEqual(descriptors.length, 1);
    if (descriptors[0]?.type !== "task.started") return;
    assert.strictEqual(descriptors[0].payload.role, "scout");
  });

  it("starts a workflow coordinator on workflow spawn", () => {
    const descriptors = toolTasks({
      toolName: "subagent",
      args: { async: true },
      result: {
        content: [{ type: "text", text: "Async workflow [c7cec267]" }],
        details: {
          mode: "workflow",
          runId: "c7cec267-058d-4f41-8cdb-5e94cb99f4d7",
          toolCallId: "call_2",
          results: [],
        },
      },
    });
    assert.strictEqual(descriptors.length, 1);
    assert.strictEqual(descriptors[0]?.type, "task.started");
    if (descriptors[0]?.type !== "task.started") return;
    assert.strictEqual(descriptors[0].payload.taskType, "local_workflow");
    assert.strictEqual(descriptors[0].payload.title, "Workflow c7cec267");
  });

  it("emits launch-time children from workflowScript", () => {
    const descriptors = toolTasks({
      toolName: "subagent",
      args: {
        async: true,
        workflowScript: `const results = await runs.all([
          { key: "scout-dirs", agent: "scout", task: "List dirs" },
          { key: "delegate-os-date", agent: "delegate", task: "Report OS" },
        ]);`,
      },
      result: {
        content: [{ type: "text", text: "Async workflow [a9154cbe-9c7c-4947-ae51-102579e87132]" }],
        details: {
          mode: "workflow",
          runId: "a9154cbe-9c7c-4947-ae51-102579e87132",
          toolCallId: "call_1",
          results: [],
        },
      },
    });
    const started = descriptors.filter((d) => d.type === "task.started");
    assert.strictEqual(started.length, 3);
    const ids = new Set(started.map((d) => String(d.payload.taskId)));
    assert.ok(ids.has("a9154cbe-9c7c-4947-ae51-102579e87132"));
    assert.ok(ids.has("a9154cbe-9c7c-4947-ae51-102579e87132:wf:scout-dirs"));
    assert.ok(ids.has("a9154cbe-9c7c-4947-ae51-102579e87132:wf:delegate-os-date"));
  });

  it("fails the leaf on unknown-model launch without a run id", () => {
    const descriptors = toolTasks({
      toolName: "subagent",
      args: {
        async: true,
        agent: "scout",
        task: "Read-only: check.",
        model: "nonexistent/fake-model-9",
      },
      result: {
        content: [
          {
            type: "text",
            text: "Unknown subagent model 'nonexistent/fake-model-9' in the active Pi model registry.",
          },
        ],
        details: {},
      },
      toolCallId: "call_2927294",
      isError: true,
    });
    assert.strictEqual(descriptors.length, 2);
    assert.strictEqual(descriptors[0]?.type, "task.started");
    assert.strictEqual(descriptors[1]?.type, "task.completed");
    if (descriptors[1]?.type !== "task.completed") return;
    assert.strictEqual(descriptors[1].payload.status, "failed");
    assert.ok((descriptors[1].payload.summary ?? "").includes("Unknown subagent model"));
  });

  it("reactivates instead of restarting on resume", () => {
    const descriptors = toolTasks({
      toolName: "subagent",
      args: { action: "resume", id: "eb8d654a" },
      result: {
        content: [],
        details: { mode: "single", runId: "eb8d654a-606f-4f01-ab60-ef2733a18f68" },
      },
    });
    assert.strictEqual(descriptors.length, 1);
    assert.strictEqual(descriptors[0]?.type, "task.updated");
    if (descriptors[0]?.type !== "task.updated") return;
    assert.strictEqual(descriptors[0].payload.status, "running");
  });

  it("reports coordinator and member progress on status", () => {
    const descriptors = toolTasks({
      toolName: "subagent",
      args: { action: "status", id: "c7cec267" },
      result: {
        content: [{ type: "text", text: "State: running" }],
        details: {
          mode: "single",
          results: [],
          workflowChildren: {
            version: 1,
            parentToolCallId: "call_2",
            workflowRunId: "c7cec267-058d-4f41-8cdb-5e94cb99f4d7",
            inventoryComplete: false,
            workflowState: "running",
            children: [
              {
                childId: "scout-agent",
                state: "running",
                runId: "29d83be0-034d-471b-a4b7-1904c0ddb3c4",
                agent: "scout",
                sessionName: "scout: List 3 files",
              },
              {
                childId: "delegate-agent",
                state: "pending",
                agent: "delegate",
                sessionName: "delegate: Report shell",
              },
            ],
          },
        },
      },
    });
    const progresses = descriptors.filter((d) => d.type === "task.progress");
    assert.strictEqual(progresses.length, 3);
    const coordinator = progresses.find(
      (d) =>
        d.type === "task.progress" && d.payload.taskId === "c7cec267-058d-4f41-8cdb-5e94cb99f4d7",
    );
    assert.strictEqual(coordinator?.type, "task.progress");
    if (coordinator?.type !== "task.progress") return;
    assert.strictEqual(coordinator.payload.summary, "0/2 done · 2 active");
    // Stable workflow-key identity: the pending child without a run id still
    // joins under `<runId>:wf:<key>` so it correlates with launch-time rows.
    const member = progresses.find(
      (d) =>
        d.type === "task.progress" &&
        d.payload.taskId === "c7cec267-058d-4f41-8cdb-5e94cb99f4d7:wf:scout-agent",
    );
    assert.strictEqual(member?.type, "task.progress");
    if (member?.type !== "task.progress") return;
    assert.strictEqual(member.payload.role, "scout");
    assert.strictEqual(member.payload.parentAgentId, "c7cec267-058d-4f41-8cdb-5e94cb99f4d7");
    assert.strictEqual(member.payload.status, "running");
  });

  it("completes the coordinator when the workflow state settles", () => {
    const descriptors = toolTasks({
      toolName: "subagent",
      args: { action: "status", id: "c7cec267" },
      result: {
        content: [{ type: "text", text: "State: complete" }],
        details: {
          mode: "single",
          results: [],
          workflowChildren: {
            version: 1,
            parentToolCallId: "call_2",
            workflowRunId: "c7cec267-058d-4f41-8cdb-5e94cb99f4d7",
            inventoryComplete: true,
            workflowState: "completed",
            children: [],
          },
        },
      },
    });
    assert.strictEqual(descriptors.length, 1);
    assert.strictEqual(descriptors[0]?.type, "task.completed");
    if (descriptors[0]?.type !== "task.completed") return;
    assert.strictEqual(descriptors[0].payload.status, "completed");
  });

  it("completes a leaf run on process-terminal observation", () => {
    const descriptors = toolTasks({
      toolName: "subagent",
      args: { action: "status", id: "eb8d654a" },
      result: {
        content: [{ type: "text", text: "State: complete" }],
        details: {
          mode: "single",
          results: [],
          lifecycleStatus: {
            processTerminal: {
              version: 1,
              state: "observed",
              runId: "eb8d654a-606f-4f01-ab60-ef2733a18f68",
              observedAt: 1789052428332,
              instances: [{ kind: "runner", exitCode: 0, signal: null }],
              resumeDisposition: "resumable",
            },
          },
        },
      },
    });
    assert.strictEqual(descriptors.length, 1);
    assert.strictEqual(descriptors[0]?.type, "task.completed");
    if (descriptors[0]?.type !== "task.completed") return;
    assert.strictEqual(descriptors[0].payload.status, "completed");
  });

  it("fails the leaf run on nonzero exit", () => {
    const descriptors = toolTasks({
      toolName: "subagent",
      args: { action: "status", id: "eb8d654a" },
      result: {
        content: [{ type: "text", text: "State: complete" }],
        details: {
          mode: "single",
          results: [],
          lifecycleStatus: {
            processTerminal: {
              state: "observed",
              runId: "eb8d654a-606f-4f01-ab60-ef2733a18f68",
              instances: [{ exitCode: 1 }],
            },
          },
        },
      },
    });
    assert.strictEqual(descriptors[0]?.type, "task.completed");
    if (descriptors[0]?.type !== "task.completed") return;
    assert.strictEqual(descriptors[0].payload.status, "failed");
  });

  it("completes bg_wait runs with usage and model", () => {
    const descriptors = toolTasks({
      toolName: "bg_wait",
      args: { id: "eb8d654a" },
      result: {
        content: [{ type: "text", text: "Outcome: 1 complete." }],
        details: {
          mode: "management",
          completions: [
            {
              runId: "eb8d654a-606f-4f01-ab60-ef2733a18f68",
              agent: "delegate",
              mode: "single",
              state: "complete",
              success: true,
              results: [
                {
                  agent: "delegate",
                  usage: {
                    input: 3167,
                    output: 12,
                    cacheRead: 256,
                    cacheWrite: 0,
                    cost: 0,
                    turns: 1,
                  },
                  model: "commandcode/deepseek/deepseek-v4.1-flash",
                  success: true,
                },
              ],
            },
          ],
        },
      },
    });
    assert.strictEqual(descriptors.length, 1);
    assert.strictEqual(descriptors[0]?.type, "task.completed");
    if (descriptors[0]?.type !== "task.completed") return;
    assert.strictEqual(descriptors[0].payload.status, "completed");
    assert.strictEqual(descriptors[0].payload.role, "delegate");
    assert.deepStrictEqual(descriptors[0].payload.typedUsage, {
      totalTokens: 3435,
      inputTokens: 3167,
      cachedInputTokens: 256,
      outputTokens: 12,
    });
    assert.strictEqual(descriptors[0].payload.model, "commandcode/deepseek/deepseek-v4.1-flash");
  });

  it("completes workflow coordinators and members from bg_wait", () => {
    const descriptors = toolTasks({
      toolName: "bg_wait",
      args: {},
      result: {
        content: [{ type: "text", text: "Outcome: 2 complete, 1 failed." }],
        details: {
          mode: "management",
          completions: [
            {
              runId: "451f5e62-04f3-4b02-947c-d3eedadf1d67",
              mode: "workflow",
              state: "complete",
              success: true,
              results: [
                {
                  agent: "scout",
                  runId: "aaaa1111-034d-471b-a4b7-1904c0ddb3c4",
                  usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
                  success: true,
                  model: "m",
                },
                {
                  agent: "reviewer",
                  runId: "bbbb2222-034d-471b-a4b7-1904c0ddb3c4",
                  success: false,
                  error: "Stream error occurred",
                },
              ],
            },
          ],
        },
      },
    });
    const completed = descriptors.filter((d) => d.type === "task.completed");
    assert.strictEqual(completed.length, 3);
    const member = completed.find(
      (d) =>
        d.type === "task.completed" && d.payload.taskId === "bbbb2222-034d-471b-a4b7-1904c0ddb3c4",
    );
    assert.strictEqual(member?.type, "task.completed");
    if (member?.type !== "task.completed") return;
    assert.strictEqual(member.payload.status, "failed");
    assert.strictEqual(member.payload.parentAgentId, "451f5e62-04f3-4b02-947c-d3eedadf1d67");
    assert.include(member.payload.summary ?? "", "Stream error");
  });

  it("parses workflowScript child specs", () => {
    assert.deepStrictEqual(parsePiWorkflowScript(undefined), []);
    assert.deepStrictEqual(parsePiWorkflowScript(""), []);
    const specs = parsePiWorkflowScript(`const r = await runs.all([
      { key: "a", agent: "scout", task: "Do a" },
      { key: "b", agent: "delegate", task: "Do b" },
    ]);`);
    assert.strictEqual(specs.length, 2);
    assert.strictEqual(specs[0]?.key, "a");
    assert.strictEqual(specs[0]?.agent, "scout");
  });

  it("completes workflows from subagent-notify", () => {
    const descriptors = describeNotifyReading({
      agent: "workflow",
      status: "completed",
      workflowRunId: "a9154cbe-9c7c-4947-ae51-102579e87132",
      childRuns: [
        { runId: "child-1", workflowKey: "scout-dirs", agent: "scout", status: "completed" },
        { runId: "child-2", workflowKey: "delegate-os-date", agent: "delegate", status: "failed" },
      ],
    });
    const completed = descriptors.filter((d) => d.type === "task.completed");
    assert.strictEqual(completed.length, 3);
    const member = completed.find(
      (d) =>
        d.type === "task.completed" &&
        d.payload.taskId === "a9154cbe-9c7c-4947-ae51-102579e87132:wf:scout-dirs",
    );
    assert.strictEqual(member?.type, "task.completed");
    if (member?.type !== "task.completed") return;
    assert.strictEqual(member.payload.status, "completed");
  });

  it("parses notify content into workflow identity and children", () => {
    const contents = collectPiNotifyContents([
      {
        role: "custom",
        customType: "subagent-notify",
        content: "Background task completed: **workflow**",
      },
      { role: "user", content: "hi" },
    ]);
    assert.strictEqual(contents.length, 1);
    const parsed = parsePiNotifyContent(
      [
        "Background task completed: **workflow**",
        "Workflow receipt: /tmp/async-subagent-runs/e0f005a9-29c4-4166-b829-82e1ba39413e/workflow-receipt.json",
        "",
        "Workflow completed with 3 child run(s).",
        "",
        "Child outputs:",
        "- key=scout-dirs run=584462b7-4e5c-4d84-bf9f-088ff2f04ed3 status=completed",
        "- key=delegate-sys run=aaaa1111-0000-1111-2222-333344445555 status=failed",
      ].join("\n"),
    );
    assert.strictEqual(parsed?.agent, "workflow");
    assert.strictEqual(parsed?.status, "completed");
    assert.strictEqual(parsed?.workflowRunId, "e0f005a9-29c4-4166-b829-82e1ba39413e");
    assert.strictEqual(parsed?.childRuns.length, 2);
    assert.strictEqual(parsed?.childRuns[0]?.workflowKey, "scout-dirs");
    assert.strictEqual(parsed?.childRuns[1]?.status, "failed");
    assert.strictEqual(parsePiNotifyContent("hello world"), undefined);
    assert.strictEqual(parsePiNotifyContent(undefined), undefined);
  });

  it("settles launch-time members from parsed notify content", () => {
    const parsed = parsePiNotifyContent(
      "Background task completed: **workflow**\nWorkflow receipt: /tmp/async-subagent-runs/e0f005a9-29c4-4166-b829-82e1ba39413e/workflow-receipt.json\n\nChild outputs:\n- key=scout-dirs run=584462b7 status=completed",
    );
    assert.ok(parsed?.workflowRunId);
    if (!parsed) return;
    const descriptors = describeNotifyReading({
      agent: parsed.agent,
      status: parsed.status,
      workflowRunId: parsed.workflowRunId,
      childRuns: parsed.childRuns.map((child) => ({ ...child })),
    });
    const completed = descriptors.filter((d) => d.type === "task.completed");
    assert.ok(
      completed.some(
        (d) =>
          d.type === "task.completed" &&
          String(d.payload.taskId) === "e0f005a9-29c4-4166-b829-82e1ba39413e:wf:scout-dirs",
      ),
    );
  });

  it("emits started and completed for foreground children", () => {
    const descriptors = toolTasks({
      toolName: "subagent",
      args: { agent: "delegate", task: "hi" },
      result: {
        content: [{ type: "text", text: "I am reachable" }],
        details: {
          mode: "single",
          toolCallId: "call_9",
          results: [
            {
              index: 0,
              agent: "delegate",
              task: "hi",
              exitCode: 0,
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
              model: "m",
            },
          ],
        },
      },
    });
    assert.strictEqual(descriptors.length, 2);
    assert.strictEqual(descriptors[0]?.type, "task.started");
    assert.strictEqual(descriptors[1]?.type, "task.completed");
    if (descriptors[0]?.type !== "task.started" || descriptors[1]?.type !== "task.completed")
      return;
    assert.strictEqual(descriptors[0].payload.taskId, "call_9");
    assert.strictEqual(descriptors[1].payload.taskId, "call_9");
    assert.strictEqual(descriptors[1].payload.status, "completed");
  });

  it("routes unknown tools to no dialect", () => {
    assert.deepStrictEqual(
      describeDialectToolTasks(DIALECTS, { toolName: "mystery-tool", args: {}, result: {} }),
      [],
    );
    assert.deepStrictEqual(parsePiNotifyContent("hello world"), undefined);
  });
});
