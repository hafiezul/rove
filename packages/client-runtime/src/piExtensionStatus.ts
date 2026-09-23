import {
  PI_EXTENSION_STATUS_ACTIVITY_KIND,
  PiExtensionStatusSnapshot,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isStatusSnapshot = Schema.is(PiExtensionStatusSnapshot);

export function latestPiExtensionStatuses(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PiExtensionStatusSnapshot["statuses"] {
  for (let index = activities.length - 1; index >= 0; index--) {
    const activity = activities[index]!;
    if (activity.kind === PI_EXTENSION_STATUS_ACTIVITY_KIND && isStatusSnapshot(activity.payload)) {
      return activity.payload.statuses;
    }
  }
  return [];
}
