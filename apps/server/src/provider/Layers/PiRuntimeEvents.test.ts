import { describe, expect, it } from "vite-plus/test";
import { compactPiMessageUpdate, compactPiToolProgress } from "./PiRuntimeEvents.ts";

describe("Pi IPC progress projection", () => {
  it("sends only the delta instead of Pi's cumulative assistant snapshots", () => {
    const partial = { role: "assistant", content: [{ type: "text", text: "x".repeat(100_000) }] };
    const projected = compactPiMessageUpdate({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_delta", delta: "next", contentIndex: 0, partial },
    });
    expect(projected).toEqual({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "next", contentIndex: 0 },
    });
    expect(JSON.stringify(projected).length).toBeLessThan(200);
  });

  it("bounds tool progress at the newest text and preserves it across the second queue", () => {
    const projected = compactPiToolProgress({
      type: "tool_execution_update",
      toolCallId: "call",
      toolName: "bash",
      partialResult: {
        content: [
          { type: "text", text: "x".repeat(100_000) },
          { type: "text", text: "latest output" },
        ],
      },
    });
    expect(String(projected.progress)).toHaveLength(1024);
    expect(String(projected.progress)).toMatch(/latest output$/);
    expect(projected.partialResult).toBeUndefined();
    expect(compactPiToolProgress(projected)).toEqual(projected);
  });
});
