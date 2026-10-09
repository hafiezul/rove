// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read side of observed-agent transcripts (ADR 0002).
 *
 * The agent hook writes one JSONL file per agent under
 * `<stateDir>/agent-transcripts/<threadId>/<agentId>.jsonl`. The client never
 * supplies a path: it names a thread and a task, and both are reduced to safe
 * file-name segments before the read, so a request cannot leave the root.
 *
 * @module orchestration/agentTranscriptQuery
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  OrchestrationGetAgentTranscriptError,
  type OrchestrationAgentTranscriptEntry,
  type OrchestrationGetAgentTranscriptResult,
} from "@rove-code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { PiAgentEntry } from "../provider/Layers/PiAgentHook.ts";

const TRANSCRIPT_BYTE_CAP = 4 * 1024 * 1024;
const ENTRY_LIMIT = 2_000;

export function agentTranscriptsRoot(stateDir: string): string {
  return NodePath.join(stateDir, "agent-transcripts");
}

const safeSegment = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);

function agentTranscriptPath(stateDir: string, threadId: string, taskId: string): string {
  return NodePath.join(
    agentTranscriptsRoot(stateDir),
    safeSegment(threadId),
    `${safeSegment(taskId)}.jsonl`,
  );
}

export function agentTranscriptThreadDir(stateDir: string, threadId: string): string {
  return NodePath.join(agentTranscriptsRoot(stateDir), safeSegment(threadId));
}

const iso = (at: unknown) =>
  DateTime.formatIso(DateTime.makeUnsafe(typeof at === "number" && Number.isFinite(at) ? at : 0));

/** Folds raw entries into the display transcript: tool starts absorb their ends. */
export function foldAgentTranscript(
  lines: ReadonlyArray<string>,
  truncated: boolean,
): OrchestrationGetAgentTranscriptResult {
  const entries: OrchestrationAgentTranscriptEntry[] = [];
  const tools = new Map<string, number>();
  const toolStarts = new Map<string, number>();
  let model: string | undefined;
  let sessionFile: string | undefined;
  let command: string | undefined;
  let cwd: string | undefined;
  let cost = 0;
  let clipped = truncated;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: PiAgentEntry;
    try {
      entry = JSON.parse(line) as PiAgentEntry;
    } catch {
      continue;
    }
    if (entry?.v !== 1) continue;
    if (entry.trunc) clipped = true;
    const at = iso(entry.at);
    switch (entry.k) {
      case "start":
        if (entry.cmd) command = entry.cmd;
        if (entry.cwd) cwd = entry.cwd;
        break;
      case "meta":
        if (entry.model) model = entry.model;
        if (entry.session) sessionFile = entry.session;
        break;
      case "task":
      case "user":
        if (entry.text) entries.push({ kind: entry.k, at, text: entry.text });
        break;
      case "text":
        if (entry.model) model = entry.model;
        if (entry.text || entry.error)
          entries.push({
            kind: "text",
            at,
            ...(entry.text ? { text: entry.text } : undefined),
            ...(entry.error ? { error: entry.error } : undefined),
          });
        break;
      case "usage":
        if (typeof entry.cost === "number" && entry.cost > 0)
          cost = entry.cum ? Math.max(cost, entry.cost) : cost + entry.cost;
        break;
      case "tool": {
        const id = entry.id ?? `${entries.length}`;
        tools.set(id, entries.length);
        toolStarts.set(id, typeof entry.at === "number" ? entry.at : 0);
        entries.push({
          kind: "tool",
          at,
          id,
          name: entry.name ?? "tool",
          status: "running",
          ...(entry.target ? { target: entry.target } : undefined),
        });
        break;
      }
      case "toolEnd": {
        const index = entry.id !== undefined ? tools.get(entry.id) : undefined;
        const tool = index !== undefined ? entries[index] : undefined;
        if (tool?.kind !== "tool" || index === undefined) break;
        const started = toolStarts.get(tool.id) ?? 0;
        entries[index] = {
          ...tool,
          status: entry.isError ? "failed" : "completed",
          ...(entry.out ? { output: entry.out } : undefined),
          ...(typeof entry.at === "number" && started > 0
            ? { durationMs: Math.max(0, entry.at - started) }
            : undefined),
        };
        break;
      }
      case "exit":
        if (entry.error || (typeof entry.code === "number" && entry.code !== 0))
          entries.push({
            kind: "text",
            at,
            error: entry.error ?? `Exited with code ${entry.code}.`,
          });
        break;
      case "busy":
      case "idle":
        break;
    }
  }
  const kept = entries.length > ENTRY_LIMIT ? entries.slice(-ENTRY_LIMIT) : entries;
  return {
    entries: kept,
    truncated: clipped || kept.length < entries.length,
    ...(model ? { model } : undefined),
    ...(sessionFile ? { sessionFile } : undefined),
    ...(command ? { command } : undefined),
    ...(cwd ? { cwd } : undefined),
    ...(cost > 0 ? { costUsd: cost } : undefined),
  };
}

export const readAgentTranscript = Effect.fn("orchestration.readAgentTranscript")(
  function* (input: {
    readonly stateDir: string;
    readonly threadId: string;
    readonly taskId: string;
  }) {
    const file = agentTranscriptPath(input.stateDir, input.threadId, input.taskId);
    const read = yield* Effect.tryPromise({
      try: async () => {
        const handle = await NodeFSP.open(file, "r");
        try {
          const { size } = await handle.stat();
          // Keep the newest entries when the file is over the cap.
          const length = Math.min(size, TRANSCRIPT_BYTE_CAP);
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, size - length);
          const text = buffer.toString("utf8");
          const lines = text.split("\n");
          if (size > length) lines.shift();
          return { lines, truncated: size > length };
        } finally {
          await handle.close();
        }
      },
      catch: (cause) =>
        new OrchestrationGetAgentTranscriptError({
          reason:
            (cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
              ? "not-found"
              : "read-failed",
          taskId: input.taskId,
          cause,
        }),
    });
    return foldAgentTranscript(read.lines, read.truncated);
  },
);
