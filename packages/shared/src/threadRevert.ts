import {
  isImportedAgentSessionMessageId,
  type OrchestrationMessage,
  type ThreadRevertMessageBoundary,
} from "@rove-code/contracts";
import { compareDateTimeStrings } from "./dateTime.ts";

export function retainThreadMessagesAfterRevert<
  T extends Pick<OrchestrationMessage, "id" | "role" | "turnId" | "createdAt">,
>(
  messages: ReadonlyArray<T>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
  boundary?: ThreadRevertMessageBoundary,
): T[] {
  if (boundary !== undefined) {
    return messages.filter((message) => {
      if (message.id === boundary.messageId) return false;
      if (message.role === "system" || isImportedAgentSessionMessageId(message.id)) return true;
      const order = compareDateTimeStrings(message.createdAt, boundary.createdAt);
      return order < 0 || (order === 0 && message.id < boundary.messageId);
    });
  }

  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system" || isImportedAgentSessionMessageId(message.id)) {
      retainedMessageIds.add(message.id);
    } else if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }
  for (const role of ["user", "assistant"] as const) {
    const retainedCount = messages.filter(
      (message) =>
        message.role === role &&
        !isImportedAgentSessionMessageId(message.id) &&
        retainedMessageIds.has(message.id),
    ).length;
    const missingCount = Math.max(0, turnCount - retainedCount);
    const fallback = messages
      .filter(
        (message) =>
          message.role === role &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .sort(
        (left, right) =>
          compareDateTimeStrings(left.createdAt, right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, missingCount);
    for (const message of fallback) retainedMessageIds.add(message.id);
  }
  return messages.filter((message) => retainedMessageIds.has(message.id));
}

export function retainThreadTurnItemsAfterRevert<
  T extends { readonly turnId: string | null; readonly createdAt: string },
>(
  items: ReadonlyArray<T>,
  retainedTurnIds: ReadonlySet<string>,
  boundary?: ThreadRevertMessageBoundary,
): T[] {
  return items.filter(
    (item) =>
      item.turnId === null ||
      (boundary === undefined
        ? retainedTurnIds.has(item.turnId)
        : compareDateTimeStrings(item.createdAt, boundary.createdAt) < 0),
  );
}
