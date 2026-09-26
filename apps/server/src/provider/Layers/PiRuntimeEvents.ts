import * as RuntimePredicate from "effect/Predicate";
import type { PiSessionEventLike } from "./PiAdapter.ts";
import { compactPiExampleUpdate } from "./PiExampleSubagentDialect.ts";
import { piBounded, piRecord } from "./PiSubagentDialects.ts";

/** Bound cumulative tool output before either the IPC or adapter queue. Final results stay intact. */
export function compactPiToolProgress(event: PiSessionEventLike): PiSessionEventLike {
  if (RuntimePredicate.isString(event.progress)) return event;
  const content = piRecord(event.partialResult)?.content;
  let progress = "";
  if (Array.isArray(content)) {
    for (let index = content.length - 1; index >= 0; index--) {
      const text = piRecord(content[index]);
      if (text?.type !== "text" || !RuntimePredicate.isString(text.text)) continue;
      progress = text.text.slice(-(1024 - progress.length)) + progress;
      if (progress.length >= 1024) break;
    }
  }
  const exampleUpdate =
    event.toolName === "subagent"
      ? piRecord(compactPiExampleUpdate(event.partialResult))
      : undefined;
  return {
    type: event.type,
    toolCallId: String(event.toolCallId ?? ""),
    toolName: piBounded(String(event.toolName ?? "tool"), 120),
    progress: progress.trim() || "Tool running",
    ...(exampleUpdate !== undefined ? { exampleUpdate } : undefined),
  };
}

/** Pi includes a cumulative assistant snapshot with each delta; Rove only consumes the delta. */
export function compactPiMessageUpdate(event: PiSessionEventLike): PiSessionEventLike {
  const update = piRecord(event.assistantMessageEvent);
  return {
    type: event.type,
    assistantMessageEvent: {
      type: String(update?.type ?? ""),
      ...(RuntimePredicate.isString(update?.delta) ? { delta: update.delta } : undefined),
      ...(RuntimePredicate.isNumber(update?.contentIndex)
        ? { contentIndex: update.contentIndex }
        : undefined),
    },
  };
}
