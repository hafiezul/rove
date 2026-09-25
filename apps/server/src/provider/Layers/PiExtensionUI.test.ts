import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { UserInputRequestedPayload } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { createPiExtensionUI } from "./PiExtensionUI.ts";
import type { PiSessionEventLike } from "./PiAdapter.ts";

const decodeQuestions = Schema.decodeUnknownSync(UserInputRequestedPayload);

function createUI(reportUnsupportedUI = () => {}) {
  const events: PiSessionEventLike[] = [];
  // SAFETY: Tests call only the mocked terminal input hook and bridge-owned methods.
  const fallback = Object.assign({} as ExtensionUIContext, { onTerminalInput: () => () => {} });
  const bridge = createPiExtensionUI(
    fallback,
    (event) => events.push(event),
    () => {},
    reportUnsupportedUI,
  );
  const latestQuestion = () => {
    const request = events.findLast((event) => event.type === "rove_ui_request");
    if (request?.type !== "rove_ui_request") throw new Error("Expected an extension question");
    return {
      requestId: request.requestId,
      questions: decodeQuestions({ questions: request.questions }).questions,
    };
  };
  return { bridge, events, latestQuestion };
}

describe("Pi extension compatibility", () => {
  it("reports terminal-only UI once outside the thread and stops after disposal", () => {
    const report = vi.fn();
    const { bridge, events } = createUI(report);
    const unsubscribe = bridge.ui.onTerminalInput(() => ({ consume: true }));
    bridge.ui.setWidget("fleet", () => {
      throw new Error("terminal widget rendered");
    });
    bridge.ui.setTitle("Terminal title");
    expect(report).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
    unsubscribe();
    bridge.stop();
    bridge.ui.setTitle("after stop");
    expect(report).toHaveBeenCalledOnce();
  });
});

describe("Pi extension editor questions", () => {
  it("prefills a multiline answer and returns the user's edit", async () => {
    const { bridge, latestQuestion } = createUI();
    const result = bridge.ui.editor("Edit", "First line\nSecond line");
    const request = latestQuestion();
    expect(request.questions).toMatchObject([
      {
        question: "Edit",
        inputMode: "multiline",
        initialAnswer: "First line\nSecond line",
        allowCustomAnswer: true,
      },
    ]);
    expect(bridge.respond(String(request.requestId), { answer: "Revised\nSecond line" })).toBe(
      true,
    );
    await expect(result).resolves.toBe("Revised\nSecond line");
    bridge.stop();
  });

  it.each(["  first\nsecond\n", "  \n", ""])(
    "returns an editor answer exactly as submitted: %j",
    async (answer) => {
      const { bridge, latestQuestion } = createUI();
      const result = bridge.ui.editor("Edit", "Original");
      const request = latestQuestion();
      expect(bridge.respond(String(request.requestId), { answer })).toBe(true);
      await expect(result).resolves.toBe(answer);
      bridge.stop();
    },
  );

  it("rejects oversized prefill instead of sending or silently truncating it", async () => {
    const { bridge } = createUI();
    expect(() => bridge.ui.editor("Edit", "x".repeat(65_537))).toThrow(
      "prefill exceeds 65,536 characters",
    );
    expect(bridge.hasPendingInput).toBe(false);
    bridge.stop();
  });

  it("keeps an editor multiline without prefill and leaves ordinary input unprefilled", async () => {
    const { bridge, latestQuestion } = createUI();
    const editing = bridge.ui.editor("Edit", undefined);
    const editorRequest = latestQuestion();
    expect(editorRequest.questions[0]).toMatchObject({ inputMode: "multiline" });
    expect(editorRequest.questions[0]).not.toHaveProperty("initialAnswer");
    bridge.respond(String(editorRequest.requestId), { answer: "A\nB" });
    await expect(editing).resolves.toBe("A\nB");

    const input = bridge.ui.input("Name", "Your name");
    const inputRequest = latestQuestion();
    expect(inputRequest.questions[0]).not.toHaveProperty("inputMode");
    expect(inputRequest.questions[0]).not.toHaveProperty("initialAnswer");
    bridge.respond(String(inputRequest.requestId), { answer: "Ada" });
    await expect(input).resolves.toBe("Ada");
    bridge.stop();
  });
});
