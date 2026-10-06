import type {
  ResourceMonitorProcessSample,
  ResourceMonitorSnapshotEvent,
  ResourceTelemetryHealth,
} from "@rove-code/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { bench, describe } from "vite-plus/test";

import { buildResourceTelemetryHistory } from "./ResourceTelemetryHistory.ts";

const start = Date.parse("2026-06-17T12:00:00.000Z");
const health: ResourceTelemetryHealth = {
  native: { status: "healthy", lastSampleAt: Option.none(), lastError: Option.none() },
  desktop: { status: "healthy", lastSampleAt: Option.none(), lastError: Option.none() },
  sidecarVersion: Option.some("0.1.0"),
  sidecarPid: Option.some(400),
  restartCount: 0,
  collectionDurationMicros: 100,
  scannedProcessCount: 4,
  retainedProcessCount: 4,
  inaccessibleProcessCount: 0,
};

function processSample(
  pid: number,
  ppid: number,
  index: number,
  name = `process-${pid}`,
  command = name,
): ResourceMonitorProcessSample {
  return {
    pid,
    ppid,
    startTimeMs: pid * 1_000,
    runTimeMs: index * 1_000,
    name,
    command,
    status: "Running",
    cpuPercent: ((index * 13 + pid) % 30) / 10,
    cpuTimeMs: index * 100,
    residentBytes: (16 + (index % 3)) * 1_024 * 1_024,
    virtualBytes: 128 * 1_024 * 1_024,
    ioReadBytes: index * 1_024,
    ioWriteBytes: index * 2_048,
    ioSemantics: "storage",
  };
}

const scenarios = [
  { name: "15m default chart", seconds: 900, bucketMs: 30_000, churn: false, processCount: 4 },
  { name: "1h default chart", seconds: 3_600, bucketMs: 120_000, churn: false, processCount: 4 },
  {
    name: "1h with short-lived processes",
    seconds: 3_600,
    bucketMs: 120_000,
    churn: true,
    processCount: 4,
  },
  {
    name: "1h with one-second buckets",
    seconds: 3_600,
    bucketMs: 1_000,
    churn: false,
    processCount: 4,
  },
  {
    name: "1h with 32 processes",
    seconds: 3_600,
    bucketMs: 120_000,
    churn: false,
    processCount: 32,
  },
  {
    name: "1h with 32 short-lived processes",
    seconds: 3_600,
    bucketMs: 120_000,
    churn: true,
    processCount: 32,
  },
];

describe("resource history replay", () => {
  for (const scenario of scenarios) {
    const snapshots: ResourceMonitorSnapshotEvent[] = Array.from(
      { length: scenario.seconds },
      (_, index) => ({
        version: 3,
        type: "snapshot",
        sequence: index + 1,
        sampledAtUnixMs: start + index * 1_000,
        collectionDurationMicros: 100,
        scannedProcessCount: scenario.processCount,
        retainedProcessCount: scenario.processCount,
        inaccessibleProcessCount: 0,
        externalProcesses: [{ pid: 200, startTimeMs: 200_000 }],
        processes: [
          processSample(100, 1, index),
          processSample(200, 1, index, "electron"),
          processSample(400, 100, index, "rove-resource-monitor", "process-400"),
          processSample(
            scenario.churn ? 700 + Math.floor(index / 20) : 300,
            100,
            scenario.churn ? index % 20 : index,
            "codex",
            "codex app-server",
          ),
          ...Array.from({ length: scenario.processCount - 4 }, (_, processIndex) =>
            processSample(
              1_000 +
                processIndex +
                (scenario.churn ? Math.floor(index / 20) * scenario.processCount : 0),
              100,
              scenario.churn ? index % 20 : index,
              "codex",
              "codex app-server",
            ),
          ),
        ],
      }),
    );
    const input = {
      readAt: DateTime.makeUnsafe(start + scenario.seconds * 1_000),
      windowMs: scenario.seconds * 1_000,
      bucketMs: scenario.bucketMs,
      sampleIntervalMs: 1_000,
      serverPid: 100,
      sidecarPid: Option.some(400),
      desktopSnapshot: Option.none(),
      health,
      snapshots,
    };
    bench(
      scenario.name,
      () => {
        buildResourceTelemetryHistory(input);
      },
      { warmupTime: 1_000, time: 1_500 },
    );
  }
});
