import type {
  DesktopHostTelemetrySnapshot,
  ResourceMonitorSnapshotEvent,
  ResourceTelemetryHealth,
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryBucket,
  ResourceTelemetryProcess,
  ResourceTelemetryProcessSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  emptyTelemetryCounters,
  mergeProcesses,
  processIdentityKey,
  type ProcessState,
  type TelemetryCounters,
} from "./Model.ts";

const MAX_HISTORY_WINDOW_MS = 60 * 60_000;

export function normalizeResourceTelemetryHistoryInput(input: {
  readonly windowMs: number;
  readonly bucketMs: number;
}) {
  const windowMs = Math.max(1_000, Math.min(MAX_HISTORY_WINDOW_MS, input.windowMs));
  return {
    windowMs,
    bucketMs: Math.max(1_000, Math.min(windowMs, input.bucketMs)),
  };
}

interface AggregateSample {
  readonly sampledAtMs: number;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly processCount: number;
  readonly ioReadBytes: number;
  readonly ioWriteBytes: number;
}

interface ProcessSummary {
  readonly firstSeenAt: DateTime.Utc;
  latest: ResourceTelemetryProcess;
  cpuTotal: number;
  maxCpuPercent: number;
  cpuTimeMs: number;
  peakRssBytes: number;
  ioReadBytes: number;
  ioWriteBytes: number;
  sampleCount: number;
}

export interface BuildResourceTelemetryHistoryInput {
  readonly readAt: DateTime.Utc;
  readonly windowMs: number;
  readonly bucketMs: number;
  readonly sampleIntervalMs: number;
  readonly serverPid: number;
  readonly sidecarPid: Option.Option<number>;
  readonly desktopSnapshot: Option.Option<DesktopHostTelemetrySnapshot>;
  readonly snapshots: ReadonlyArray<ResourceMonitorSnapshotEvent>;
  readonly health: ResourceTelemetryHealth;
}

export type ResourceTelemetryHistoryWithLegacyBuckets = ResourceTelemetryHistory & {
  readonly legacyBackendBuckets?: ReadonlyArray<ResourceTelemetryHistoryBucket>;
};

function summarizeProcesses(
  summaries: ReadonlyMap<string, ProcessSummary>,
): ReadonlyArray<ResourceTelemetryProcessSummary> {
  return [...summaries.values()]
    .map((summary): ResourceTelemetryProcessSummary => ({
      identity: summary.latest.identity,
      ppid: summary.latest.ppid,
      depth: summary.latest.depth,
      name: summary.latest.name,
      command: summary.latest.command,
      category: summary.latest.category,
      firstSeenAt: summary.firstSeenAt,
      lastSeenAt: summary.latest.lastSeenAt,
      currentCpuPercent: summary.latest.cpuPercent,
      avgCpuPercent: summary.cpuTotal / summary.sampleCount,
      maxCpuPercent: summary.maxCpuPercent,
      cpuTimeMs: summary.cpuTimeMs,
      currentRssBytes: summary.latest.residentBytes,
      peakRssBytes: summary.peakRssBytes,
      ioReadBytes: summary.ioReadBytes,
      ioWriteBytes: summary.ioWriteBytes,
      ioSemantics: summary.latest.ioSemantics,
      sampleCount: summary.sampleCount,
    }))
    .toSorted(
      (left, right) => right.cpuTimeMs - left.cpuTimeMs || right.peakRssBytes - left.peakRssBytes,
    );
}

function buildBuckets(input: {
  readonly samples: ReadonlyArray<AggregateSample>;
  readonly nowMs: number;
  readonly windowMs: number;
  readonly bucketMs: number;
}): ReadonlyArray<ResourceTelemetryHistoryBucket> {
  const windowStartMs = input.nowMs - input.windowMs;
  const buckets: ResourceTelemetryHistoryBucket[] = [];
  // History replay appends samples chronologically, so each sample belongs to one bucket.
  let sampleIndex = 0;
  for (let startedAtMs = windowStartMs; startedAtMs < input.nowMs; startedAtMs += input.bucketMs) {
    const endedAtMs = Math.min(input.nowMs, startedAtMs + input.bucketMs);
    let sampleCount = 0;
    let cpuTotal = 0;
    let maxCpuPercent = Number.NEGATIVE_INFINITY;
    let maxRssBytes = Number.NEGATIVE_INFINITY;
    let ioReadBytes = 0;
    let ioWriteBytes = 0;
    let maxProcessCount = Number.NEGATIVE_INFINITY;
    while (sampleIndex < input.samples.length) {
      const sample = input.samples[sampleIndex]!;
      if (
        sample.sampledAtMs > endedAtMs ||
        (sample.sampledAtMs === endedAtMs && endedAtMs !== input.nowMs)
      ) {
        break;
      }
      sampleIndex += 1;
      if (sample.sampledAtMs < startedAtMs) continue;
      sampleCount += 1;
      cpuTotal += sample.cpuPercent;
      maxCpuPercent = Math.max(maxCpuPercent, sample.cpuPercent);
      maxRssBytes = Math.max(maxRssBytes, sample.rssBytes);
      ioReadBytes += sample.ioReadBytes;
      ioWriteBytes += sample.ioWriteBytes;
      maxProcessCount = Math.max(maxProcessCount, sample.processCount);
    }
    buckets.push({
      startedAt: DateTime.makeUnsafe(startedAtMs),
      endedAt: DateTime.makeUnsafe(endedAtMs),
      avgCpuPercent: sampleCount === 0 ? 0 : cpuTotal / sampleCount,
      maxCpuPercent: sampleCount === 0 ? 0 : maxCpuPercent,
      maxRssBytes: sampleCount === 0 ? 0 : maxRssBytes,
      ioReadBytes,
      ioWriteBytes,
      maxProcessCount: sampleCount === 0 ? 0 : maxProcessCount,
    });
  }
  return buckets;
}

export function buildResourceTelemetryHistory(
  input: BuildResourceTelemetryHistoryInput,
): ResourceTelemetryHistoryWithLegacyBuckets & {
  readonly legacyBackendBuckets: ReadonlyArray<ResourceTelemetryHistoryBucket>;
} {
  const readAtMs = DateTime.toEpochMillis(input.readAt);
  const { windowMs, bucketMs } = normalizeResourceTelemetryHistoryInput(input);
  const windowStartMs = readAtMs - windowMs;
  const eligibleSnapshots = input.snapshots
    .filter((snapshot) => snapshot.sampledAtUnixMs <= readAtMs)
    .toSorted((left, right) => left.sampledAtUnixMs - right.sampledAtUnixMs);
  const snapshotsInWindow = eligibleSnapshots.filter(
    (snapshot) => snapshot.sampledAtUnixMs >= windowStartMs,
  );
  const precedingSnapshot = eligibleSnapshots.findLast(
    (snapshot) => snapshot.sampledAtUnixMs < windowStartMs,
  );
  const snapshots = precedingSnapshot
    ? [precedingSnapshot, ...snapshotsInWindow]
    : snapshotsInWindow;
  const aggregateSamples: AggregateSample[] = [];
  const legacyBackendAggregateSamples: AggregateSample[] = [];
  const processSummaries = new Map<string, ProcessSummary>();
  let processSampleCount = 0;
  const previous = new Map<string, ProcessState>();
  const counters: TelemetryCounters = emptyTelemetryCounters();
  let previousSnapshotAtMs: number | undefined;

  for (const snapshot of snapshots) {
    const deltaWindowFraction =
      previousSnapshotAtMs !== undefined &&
      previousSnapshotAtMs < windowStartMs &&
      snapshot.sampledAtUnixMs > previousSnapshotAtMs
        ? Math.max(
            0,
            Math.min(
              1,
              (snapshot.sampledAtUnixMs - windowStartMs) /
                (snapshot.sampledAtUnixMs - previousSnapshotAtMs),
            ),
          )
        : 1;
    previousSnapshotAtMs = snapshot.sampledAtUnixMs;
    const recordedExternalProcesses =
      snapshot.externalProcesses ??
      Option.match(input.desktopSnapshot, {
        onNone: () => [],
        onSome: (desktopSnapshot) => [
          {
            pid: desktopSnapshot.electronPid,
            startTimeMs: desktopSnapshot.electronProcesses.find(
              (metric) => metric.pid === desktopSnapshot.electronPid,
            )?.creationTimeMs,
          },
        ],
      });
    const electronRootPids = new Set(recordedExternalProcesses.map((process) => process.pid));
    const electronRootStartTimes = new Map(
      recordedExternalProcesses.flatMap((process) =>
        process.startTimeMs === undefined ? [] : [[process.pid, process.startTimeMs] as const],
      ),
    );
    const merged = mergeProcesses({
      serverPid: input.serverPid,
      sidecarPid: input.sidecarPid,
      fallbackSampledAtMs: snapshot.sampledAtUnixMs,
      nativeSnapshot: Option.some(snapshot),
      desktopSnapshot: Option.none(),
      electronRootPids,
      electronRootStartTimes,
      previous,
      counters,
      updatePrevious: true,
      accumulateCounters: false,
    });
    for (const [identityKey, processState] of merged.previous) {
      previous.set(identityKey, processState);
    }
    if (snapshot.sampledAtUnixMs < windowStartMs) {
      continue;
    }
    const deltas =
      deltaWindowFraction === 1
        ? merged.deltas
        : merged.deltas.map((delta) => ({
            ...delta,
            cpuTimeMs: Math.round(delta.cpuTimeMs * deltaWindowFraction),
            ioReadBytes: Math.round(delta.ioReadBytes * deltaWindowFraction),
            ioWriteBytes: Math.round(delta.ioWriteBytes * deltaWindowFraction),
          }));
    const deltasByIdentity = new Map(
      deltas.map((processDelta) => [processDelta.identityKey, processDelta]),
    );
    aggregateSamples.push({
      sampledAtMs: snapshot.sampledAtUnixMs,
      cpuPercent: merged.groups.allT3.currentCpuPercent,
      rssBytes: merged.groups.allT3.currentRssBytes,
      processCount: merged.groups.allT3.processCount,
      ioReadBytes: deltas.reduce((total, process) => total + process.ioReadBytes, 0),
      ioWriteBytes: deltas.reduce((total, process) => total + process.ioWriteBytes, 0),
    });
    const backendDeltas = deltas.filter(
      (processDelta) =>
        processDelta.category === "server" ||
        processDelta.category === "server-child" ||
        processDelta.category === "provider-root" ||
        processDelta.category === "terminal-root",
    );
    legacyBackendAggregateSamples.push({
      sampledAtMs: snapshot.sampledAtUnixMs,
      cpuPercent: merged.groups.backend.currentCpuPercent,
      rssBytes: merged.groups.backend.currentRssBytes,
      processCount: merged.groups.backend.processCount,
      ioReadBytes: backendDeltas.reduce((total, process) => total + process.ioReadBytes, 0),
      ioWriteBytes: backendDeltas.reduce((total, process) => total + process.ioWriteBytes, 0),
    });
    for (const process of merged.processes) {
      const identityKey = processIdentityKey(process.identity.pid, process.identity.startTimeMs);
      const processDelta = deltasByIdentity.get(identityKey);
      let summary = processSummaries.get(identityKey);
      if (summary === undefined) {
        summary = {
          firstSeenAt: process.firstSeenAt,
          latest: process,
          cpuTotal: 0,
          maxCpuPercent: Number.NEGATIVE_INFINITY,
          cpuTimeMs: 0,
          peakRssBytes: Number.NEGATIVE_INFINITY,
          ioReadBytes: 0,
          ioWriteBytes: 0,
          sampleCount: 0,
        };
        processSummaries.set(identityKey, summary);
      }
      summary.latest = process;
      summary.cpuTotal += process.cpuPercent;
      summary.maxCpuPercent = Math.max(summary.maxCpuPercent, process.cpuPercent);
      summary.cpuTimeMs += processDelta?.cpuTimeMs ?? 0;
      summary.peakRssBytes = Math.max(summary.peakRssBytes, process.residentBytes);
      summary.ioReadBytes += processDelta?.ioReadBytes ?? 0;
      summary.ioWriteBytes += processDelta?.ioWriteBytes ?? 0;
      summary.sampleCount += 1;
      processSampleCount += 1;
    }
  }

  return {
    readAt: input.readAt,
    windowMs,
    bucketMs,
    sampleIntervalMs: input.sampleIntervalMs,
    retainedSampleCount: aggregateSamples.length + processSampleCount,
    buckets: buildBuckets({ samples: aggregateSamples, nowMs: readAtMs, windowMs, bucketMs }),
    legacyBackendBuckets: buildBuckets({
      samples: legacyBackendAggregateSamples,
      nowMs: readAtMs,
      windowMs,
      bucketMs,
    }),
    topProcesses: summarizeProcesses(processSummaries),
    health: input.health,
  };
}
