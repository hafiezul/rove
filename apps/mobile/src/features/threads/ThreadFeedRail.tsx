import type { OrchestrationCheckpointSummary } from "@rove-code/contracts";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { isContextCompactionActivityGroup } from "../../lib/threadActivity";
import type { PendingThreadFeedEntry } from "./pending-thread-feed";

/**
 * The checkpoint rail, mirroring web's timeline: agent rows of a turn indent
 * by the gutter and each draws one segment, so adjacent rows read as one
 * continuous path. Static; it only redraws when rows change.
 */
export const THREAD_FEED_RAIL_GUTTER = 12;
const RAIL_X = 3;
const RAIL_WIDTH = 1.5;
// Assistant rows pad their content by px-1 (3.5px on the 14px mobile rem).
const ASSISTANT_CONTENT_INSET = 3.5;
const CHECKPOINT_REACH = THREAD_FEED_RAIL_GUTTER + ASSISTANT_CONTENT_INSET - RAIL_X;

/** Rows that belong to the agent's leg of a turn and sit on the rail. */
export function isThreadFeedRailEntry(entry: PendingThreadFeedEntry): boolean {
  switch (entry.type) {
    case "turn-fold":
    case "thinking":
    case "agent-spawn":
    case "work-toggle":
      return true;
    case "activity-group":
      return !isContextCompactionActivityGroup(entry);
    case "message":
      return entry.message.role === "assistant";
    default:
      return false;
  }
}

export function ThreadFeedRail(props: { readonly color: string; readonly children: ReactNode }) {
  return (
    <View style={{ paddingLeft: THREAD_FEED_RAIL_GUTTER }}>
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: RAIL_X,
          width: RAIL_WIDTH,
          backgroundColor: props.color,
        }}
      />
      {props.children}
    </View>
  );
}

/**
 * Where a turn's leg folds into its checkpoint: a 45° jog from the rail into
 * the turn's change summary. Opens Review on that turn.
 */
export function ThreadFeedCheckpointMarker(props: {
  readonly checkpoint: OrchestrationCheckpointSummary;
  readonly color: string;
  readonly surfaceColor: string;
  readonly onPress: (checkpoint: OrchestrationCheckpointSummary) => void;
}) {
  const { checkpoint } = props;
  let additions = 0;
  let deletions = 0;
  for (const file of checkpoint.files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  const fileCount = checkpoint.files.length;
  const label = `${fileCount} changed ${fileCount === 1 ? "file" : "files"}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. Review changes at checkpoint ${checkpoint.checkpointTurnCount}`}
      onPress={() => props.onPress(checkpoint)}
      className="mt-2 min-h-9 flex-row items-center gap-2 self-start rounded-lg bg-subtle px-3 active:opacity-65"
    >
      <Svg
        width={CHECKPOINT_REACH}
        height={CHECKPOINT_REACH}
        viewBox="0 0 14 14"
        style={{ position: "absolute", left: -CHECKPOINT_REACH, top: 6, overflow: "visible" }}
      >
        <Path d="M0.75 1L14 14.25" stroke={props.color} strokeWidth={1.5} strokeLinecap="round" />
        <Rect
          x={-2.25}
          y={-2}
          width={6}
          height={6}
          fill={props.surfaceColor}
          stroke={props.color}
          strokeWidth={1.5}
          transform="rotate(45 0.75 1)"
        />
      </Svg>
      <Text className="font-rove-medium text-xs text-foreground">{label}</Text>
      <Text className="font-rove-medium text-xs tabular-nums text-adaptive-emerald-600-400">
        +{additions}
      </Text>
      <Text className="font-rove-medium text-xs tabular-nums text-adaptive-red-700-300">
        −{deletions}
      </Text>
    </Pressable>
  );
}
