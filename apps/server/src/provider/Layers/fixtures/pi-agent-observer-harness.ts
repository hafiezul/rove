// @effect-diagnostics nodeBuiltinImport:off - Test harness process.
/**
 * Drives the agent observer in its own process, the way the Pi runtime worker
 * does, and prints every Agents row it emits as one JSON line.
 *
 * A fake thread agent runs one tool per way a Pi extension can start a
 * subagent. The process exits after the expected number of agents settle.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

import { startPiAgentObserver } from "../PiAgentObserver.ts";

const [transcriptsRoot, fixtures] = process.argv.slice(2) as [string, string];
const fakePi = NodePath.join(fixtures, "pi-agent-fake-pi", "cli.mjs");
const fakeClaude = NodePath.join(fixtures, "pi-agent-fake-cli", "claude");
const fakeRunner = NodePath.join(fixtures, "pi-agent-fake-sdk", "runner.mjs");
const expectedAgents = 8;

let settled = 0;
const observer = startPiAgentObserver({
  transcriptsRoot,
  hookDir: NodePath.join(transcriptsRoot, "..", "hook"),
  emit: (threadId, task) => {
    process.stdout.write(`${JSON.stringify({ threadId, task })}\n`);
    if (task.type === "task.completed" && task.payload.taskType === "subagent") {
      settled += 1;
      if (settled === expectedAgents) {
        observer.dispose();
        process.exit(0);
      }
    }
  },
});

type Listener = (event: { type: string } & Record<string, unknown>) => void;
interface Tool {
  readonly name: string;
  execute(toolCallId: string): Promise<unknown>;
}

/** Mirrors the pi-agent-core Agent surface the observer relies on. */
class FakeAgent {
  private readonly listeners: Listener[] = [];
  readonly state: { tools: Tool[]; model: { provider: string; id: string } };
  constructor(tools: Tool[]) {
    let current = tools.slice();
    this.state = {
      get tools() {
        return current;
      },
      set tools(next: Tool[]) {
        current = next.slice();
      },
      model: { provider: "test", id: "child-model" },
    };
  }
  async runWithLifecycle(executor: () => Promise<void>) {
    await executor();
  }
  subscribe(listener: Listener) {
    this.listeners.push(listener);
    return () => undefined;
  }
  emit(event: { type: string } & Record<string, unknown>) {
    for (const listener of this.listeners) listener(event);
  }
}

const exited = (child: NodeChildProcess.ChildProcess) =>
  new Promise<void>((resolve) => child.once("exit", () => resolve()));

const tools: Tool[] = [
  {
    name: "subagent",
    execute: () => exited(NodeChildProcess.spawn(process.execPath, [fakePi], { stdio: "inherit" })),
  },
  {
    name: "bash",
    // A shell starts Pi itself: the child only learns about the hook from NODE_OPTIONS.
    execute: () =>
      exited(
        NodeChildProcess.spawn("/bin/sh", ["-c", `"${process.execPath}" "${fakePi}"`], {
          stdio: "inherit",
          env: { ...process.env, FAKE_PI_TASK: "Run through a shell" },
        }),
      ),
  },
  {
    name: "fanout",
    execute: () =>
      Promise.all(
        ["Left half", "Right half"].map((task) =>
          exited(
            NodeChildProcess.spawn(process.execPath, [fakePi], {
              stdio: "inherit",
              env: { ...process.env, FAKE_PI_TASK: task },
            }),
          ),
        ),
      ),
  },
  {
    name: "runner",
    // A detached runner drives the SDK in its own process; no Pi CLI is involved.
    execute: () =>
      exited(NodeChildProcess.spawn(process.execPath, [fakeRunner], { stdio: "inherit" })),
  },
  {
    name: "inproc",
    execute: async () => {
      const child = new FakeAgent([]);
      await child.runWithLifecycle(async () => {
        child.emit({ type: "agent_start" });
        child.emit({ type: "message_end", message: { role: "user", content: "Plan the work" } });
        child.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Plan ready" }],
            usage: { input: 3, output: 1 },
            stopReason: "stop",
          },
        });
        child.emit({ type: "agent_end" });
      });
    },
  },
  {
    name: "summarize",
    execute: async () => {
      const stream = new AssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Short summary" }],
          usage: { input: 4, output: 2 },
          provider: "test",
          model: "summary-model",
        },
      } as never);
      await stream.result();
    },
  },
  {
    name: "review",
    execute: async () => {
      const child = NodeChildProcess.spawn(fakeClaude, ["-p", "review"], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      child.stdout.on("data", () => undefined);
      await exited(child);
    },
  },
];

const thread = new FakeAgent(tools);
observer.registerThreadAgent("thread-1", thread);
await thread.runWithLifecycle(async () => {
  for (const tool of tools) {
    await thread.state.tools
      .find((candidate) => candidate.name === tool.name)!
      .execute(`call-${tool.name}`);
  }
});
