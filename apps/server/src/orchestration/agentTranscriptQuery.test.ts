// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { readAgentTranscript } from "./agentTranscriptQuery.ts";

const line = (fields: Record<string, unknown>) =>
  JSON.stringify({ v: 1, a: "agent-1", th: "thread-1", w: 1, q: 1, at: 1_000, ...fields });

it.effect("reads a thread's agent transcript and never leaves the transcript root", () =>
  Effect.gen(function* () {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-agent-transcript-"));
    const dir = NodePath.join(stateDir, "agent-transcripts", "thread-1");
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(dir, "agent-1.jsonl"),
      [
        line({ k: "start", src: "cli", cmd: "codex exec fix", cwd: "/repo" }),
        line({ k: "task", text: "Fix the build" }),
        line({ k: "tool", id: "t1", name: "command", target: "pnpm build", at: 2_000 }),
        line({ k: "toolEnd", id: "t1", isError: true, out: "error TS2304", at: 3_500 }),
        line({ k: "usage", in: 10, outTok: 2, cost: 0.002 }),
        "not json",
        line({ k: "exit", code: 1 }),
      ].join("\n"),
    );
    // A secret beside the root must stay unreachable through a crafted task id.
    NodeFS.writeFileSync(NodePath.join(stateDir, "secret.jsonl"), line({ k: "task", text: "x" }));

    const transcript = yield* readAgentTranscript({
      stateDir,
      threadId: "thread-1",
      taskId: "agent-1",
    });
    expect(transcript).toMatchObject({
      command: "codex exec fix",
      cwd: "/repo",
      costUsd: 0.002,
      truncated: false,
      entries: [
        { kind: "task", text: "Fix the build" },
        {
          kind: "tool",
          name: "command",
          target: "pnpm build",
          status: "failed",
          output: "error TS2304",
          durationMs: 1_500,
        },
        { kind: "text", error: "Exited with code 1." },
      ],
    });

    const escaped = yield* Effect.flip(
      readAgentTranscript({ stateDir, threadId: "thread-1", taskId: "../../secret" }),
    );
    expect(escaped.reason).toBe("not-found");
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  }),
);
