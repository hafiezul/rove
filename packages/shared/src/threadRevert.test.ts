import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { retainThreadMessagesAfterRevert } from "./threadRevert.ts";

describe("rewind message boundary", () => {
  it("retains an older page even when the selected message is not loaded", () => {
    const messages = [
      {
        id: MessageId.make("earlier"),
        role: "user" as const,
        turnId: null,
        createdAt: "2026-04-01T08:30:00.000Z",
      },
      {
        id: MessageId.make("later"),
        role: "user" as const,
        turnId: null,
        createdAt: "2026-04-01T09:30:00.000Z",
      },
    ];
    const retained = retainThreadMessagesAfterRevert(messages, new Set(), 0, {
      messageId: MessageId.make("selected"),
      createdAt: "2026-04-01T11:00:00.000+02:00",
    });
    expect(retained.map((message) => message.id)).toEqual(["earlier"]);
  });

  it("uses the message ordering to break timestamp ties and excludes the selected message", () => {
    const createdAt = "2026-04-01T09:00:00.000Z";
    const messages = ["message-1", "message-2", "message-3"].map((id) => ({
      id: MessageId.make(id),
      role: "user" as const,
      turnId: null,
      createdAt,
    }));
    const retained = retainThreadMessagesAfterRevert(messages, new Set(), 0, {
      messageId: MessageId.make("message-2"),
      createdAt,
    });
    expect(retained.map((message) => message.id)).toEqual(["message-1"]);
  });
});
