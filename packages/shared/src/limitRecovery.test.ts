import { CommandId, ProviderInstanceId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { scheduledLimitResumeAt, visibleLimitRecovery } from "./limitRecovery.ts";

const recovery = {
  requestId: CommandId.make("recovery"),
  turnId: TurnId.make("limited-turn"),
  modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "openai/gpt-5.4" },
  resetAt: "2026-10-05T00:00:00.000Z",
  resumeAt: "2026-10-05T00:00:00.000Z",
};

describe("visibleLimitRecovery", () => {
  const thread = {
    archivedAt: null,
    settledOverride: null,
    modelSelection: recovery.modelSelection,
    limitRecovery: recovery,
    latestTurn: {
      turnId: recovery.turnId,
      state: "error" as const,
      requestedAt: "2026-10-03T00:00:00.000Z",
      startedAt: null,
      completedAt: "2026-10-03T00:00:00.000Z",
      assistantMessageId: null,
    },
  };
  const before = Date.parse("2026-10-04T00:00:00.000Z");
  it("offers recovery for a known future reset whether scheduled or off", () => {
    expect(visibleLimitRecovery(thread, before)).not.toBeNull();
    expect(
      visibleLimitRecovery({ ...thread, limitRecovery: { ...recovery, resumeAt: null } }, before),
    ).not.toBeNull();
  });
  it("leaves unknown reset times and expired unscheduled limits to the normal error UI", () => {
    expect(
      visibleLimitRecovery(
        { ...thread, limitRecovery: { ...recovery, resetAt: null, resumeAt: null } },
        before,
      ),
    ).toBeNull();
    expect(
      visibleLimitRecovery(
        { ...thread, limitRecovery: { ...recovery, resumeAt: null } },
        Date.parse(recovery.resetAt),
      ),
    ).toBeNull();
  });
  it("keeps a due schedule visible until the server decides its outcome", () => {
    expect(visibleLimitRecovery(thread, Date.parse("2026-10-06T00:00:00.000Z"))).not.toBeNull();
  });
});

describe("scheduledLimitResumeAt", () => {
  it("does not label unscheduled or cancelled recovery as automatic", () => {
    expect(scheduledLimitResumeAt({})).toBeNull();
    expect(scheduledLimitResumeAt({ limitRecovery: null })).toBeNull();
    expect(scheduledLimitResumeAt({ limitRecovery: { ...recovery, resumeAt: null } })).toBeNull();
  });
  it("reports the effective retry time when snooze postpones recovery", () => {
    expect(
      scheduledLimitResumeAt({ limitRecovery: recovery, snoozedUntil: "2026-10-06T00:00:00.000Z" }),
    ).toBe("2026-10-06T00:00:00.000Z");
    expect(
      scheduledLimitResumeAt({ limitRecovery: recovery, snoozedUntil: "2026-10-04T00:00:00.000Z" }),
    ).toBe(recovery.resumeAt);
  });
  it("keeps an overdue schedule visible until the server consumes it", () => {
    expect(
      scheduledLimitResumeAt({
        limitRecovery: { ...recovery, resumeAt: "1970-01-01T00:01:00.000Z" },
      }),
    ).toBe("1970-01-01T00:01:00.000Z");
  });
});
