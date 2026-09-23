import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { latestPiExtensionStatuses } from "./piExtensionStatus.js";

function activity(
  id: string,
  kind: string,
  payload: OrchestrationThreadActivity["payload"],
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind,
    payload,
    createdAt: "2026-01-01T00:00:00.000Z",
    turnId: null,
    summary: "",
    tone: "info",
  };
}

describe("latestPiExtensionStatuses", () => {
  it("returns the current keyed snapshot, including an explicit clear", () => {
    const activities = [
      activity("first", "pi.extension-status", {
        statuses: [
          { key: "quota", text: "80%" },
          { key: "tps", text: "90 t/s" },
        ],
      }),
      activity("notice", "runtime.info", { message: "Done" }),
      activity("next", "pi.extension-status", { statuses: [{ key: "quota", text: "75%" }] }),
    ];
    expect(latestPiExtensionStatuses(activities)).toEqual([{ key: "quota", text: "75%" }]);
    expect(
      latestPiExtensionStatuses([
        ...activities,
        activity("clear", "pi.extension-status", { statuses: [] }),
      ]),
    ).toEqual([]);
  });

  it("ignores unrelated and malformed activities", () => {
    expect(
      latestPiExtensionStatuses([
        activity("notice", "runtime.info", { message: "Done" }),
        activity("invalid", "pi.extension-status", { statuses: "oops" }),
      ]),
    ).toEqual([]);
  });
});
