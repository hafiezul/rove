import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { lookupRate, type ModelRate, type RateTable } from "./usagePricing.ts";
import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

const NonNegativeNumber = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const PiUsage = Schema.Struct({
  input: Schema.optional(NonNegativeNumber),
  output: Schema.optional(NonNegativeNumber),
  cacheRead: Schema.optional(NonNegativeNumber),
  cacheWrite: Schema.optional(NonNegativeNumber),
  reasoning: Schema.optional(NonNegativeNumber),
  cost: Schema.optional(Schema.Unknown),
});
const PiCost = Schema.Struct({
  input: Schema.optional(NonNegativeNumber),
  cacheRead: Schema.optional(NonNegativeNumber),
  total: Schema.optional(NonNegativeNumber),
});
const PiEntry = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  usage: Schema.optional(Schema.Unknown),
  message: Schema.optional(
    Schema.Struct({
      role: Schema.String,
      provider: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      usage: Schema.optional(Schema.Unknown),
    }),
  ),
});

export const PiScanState = Schema.Struct({
  sessionId: Schema.String,
  model: Schema.String,
  rateModel: Schema.String,
});
export type PiScanState = {
  -readonly [Key in keyof typeof PiScanState.Type]: (typeof PiScanState.Type)[Key];
};

export function initialPiScanState(): PiScanState {
  return { sessionId: "", model: "", rateModel: "" };
}

const decodeEntry = Schema.decodeUnknownOption(PiEntry);
const decodeUsage = Schema.decodeUnknownOption(PiUsage);
const decodeCost = Schema.decodeUnknownOption(PiCost);

export function parsePiLine(line: string, state: PiScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parsePiRecord(parsed, state);
}

export function parsePiRecord(parsed: unknown, state: PiScanState): UsageRecord | null {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return null;
  const entry = decoded.value;
  if (entry.type === "session") {
    state.sessionId = entry.id ?? "";
    return null;
  }
  if (entry.type === "model_change") {
    if (entry.provider && entry.modelId) {
      state.model = `${entry.provider}/${entry.modelId}`;
      state.rateModel = entry.modelId;
    }
    return null;
  }

  const message = entry.message;
  const isMessage = entry.type === "message";
  if (
    isMessage
      ? message?.role !== "assistant" && message?.role !== "toolResult"
      : entry.type !== "compaction" && entry.type !== "branch_summary" && entry.type !== "usage"
  ) {
    return null;
  }
  const provider = isMessage ? message?.provider : entry.provider;
  const modelId = isMessage ? message?.model : entry.model;
  if (provider && modelId && isMessage && message?.role === "assistant") {
    state.model = `${provider}/${modelId}`;
    state.rateModel = modelId;
  }
  const model =
    provider && modelId
      ? `${provider}/${modelId}`
      : message?.role === "toolResult"
        ? "tool-usage"
        : state.model;
  if (!model || !entry.timestamp) return null;
  const timestampMs = Date.parse(entry.timestamp);
  if (!Number.isFinite(timestampMs)) return null;
  const usage = decodeUsage(isMessage ? message?.usage : entry.usage);
  if (Option.isNone(usage)) return null;
  const totals = {
    uncachedInputTokens: Math.trunc(usage.value.input ?? 0),
    cachedInputTokens: Math.trunc(usage.value.cacheRead ?? 0),
    cacheCreationTokens: Math.trunc(usage.value.cacheWrite ?? 0),
    outputTokens: Math.trunc(usage.value.output ?? 0),
    reasoningTokens: Math.min(
      Math.trunc(usage.value.output ?? 0),
      Math.trunc(usage.value.reasoning ?? 0),
    ),
  };
  const cost = decodeCost(usage.value.cost);
  const savedCost = Option.isSome(cost) ? cost.value : undefined;
  if (totalTokens(totals) === 0 && !(savedCost?.total && savedCost.total > 0)) return null;
  const reportedCacheSavingsUsd =
    totals.uncachedInputTokens > 0 &&
    savedCost?.input !== undefined &&
    savedCost.cacheRead !== undefined &&
    (savedCost.total ?? 0) > 0
      ? totals.cachedInputTokens * (savedCost.input / totals.uncachedInputTokens) -
        savedCost.cacheRead
      : undefined;
  return {
    provider: "pi",
    timestampMs,
    model,
    ...(model === "tool-usage" ? undefined : { rateModel: modelId ?? state.rateModel }),
    sessionId: state.sessionId,
    totals,
    // Pi also writes zero when no model price is configured. Resolve that through rates.
    reportedCostUsd: savedCost?.total && savedCost.total > 0 ? savedCost.total : null,
    ...(reportedCacheSavingsUsd !== undefined ? { reportedCacheSavingsUsd } : undefined),
    fast: false,
    dedupeKey: entry.id ? `pi:${entry.type}:${entry.id}:${timestampMs}:${model}` : null,
  };
}

const PiModelCost = Schema.Struct({
  input: NonNegativeNumber,
  output: NonNegativeNumber,
  cacheRead: NonNegativeNumber,
  cacheWrite: NonNegativeNumber,
});
const PiModelCostOverride = Schema.Struct({
  input: Schema.optional(NonNegativeNumber),
  output: Schema.optional(NonNegativeNumber),
  cacheRead: Schema.optional(NonNegativeNumber),
  cacheWrite: Schema.optional(NonNegativeNumber),
});
const PiModelsDocument = Schema.Struct({
  providers: Schema.Record(
    Schema.String,
    Schema.Struct({
      models: Schema.optional(
        Schema.Array(Schema.Struct({ id: Schema.String, cost: Schema.optional(Schema.Unknown) })),
      ),
      modelOverrides: Schema.optional(
        Schema.Record(Schema.String, Schema.Struct({ cost: Schema.optional(Schema.Unknown) })),
      ),
    }),
  ),
});
const decodeModels = Schema.decodeUnknownOption(PiModelsDocument);
const decodeModelCost = Schema.decodeUnknownOption(PiModelCost);
const decodeModelCostOverride = Schema.decodeUnknownOption(PiModelCostOverride);

export function parsePiModelRates(
  document: unknown,
  fallbackRates: RateTable = new Map<string, ModelRate>(),
): RateTable {
  const table = new Map<string, ModelRate>();
  const decoded = decodeModels(document);
  if (Option.isNone(decoded)) return table;
  for (const [provider, config] of Object.entries(decoded.value.providers)) {
    for (const model of config.models ?? []) {
      const id = model.id;
      const cost = decodeModelCost(model.cost);
      if (Option.isNone(cost)) continue;
      table.set(`${provider}/${id}`.toLowerCase(), {
        inputCostPerToken: cost.value.input / 1_000_000,
        outputCostPerToken: cost.value.output / 1_000_000,
        cacheReadCostPerToken: cost.value.cacheRead / 1_000_000,
        cacheCreationCostPerToken: cost.value.cacheWrite / 1_000_000,
        fastMultiplier: 1,
      });
    }
    for (const [id, override] of Object.entries(config.modelOverrides ?? {})) {
      const cost = decodeModelCostOverride(override.cost);
      if (Option.isNone(cost)) continue;
      const key = `${provider}/${id}`.toLowerCase();
      const base =
        table.get(key) ?? lookupRate(fallbackRates, key) ?? lookupRate(fallbackRates, id);
      if (base === null) continue;
      table.set(key, {
        inputCostPerToken:
          cost.value.input === undefined ? base.inputCostPerToken : cost.value.input / 1_000_000,
        outputCostPerToken:
          cost.value.output === undefined ? base.outputCostPerToken : cost.value.output / 1_000_000,
        cacheReadCostPerToken:
          cost.value.cacheRead === undefined
            ? base.cacheReadCostPerToken
            : cost.value.cacheRead / 1_000_000,
        cacheCreationCostPerToken:
          cost.value.cacheWrite === undefined
            ? base.cacheCreationCostPerToken
            : cost.value.cacheWrite / 1_000_000,
        fastMultiplier: 1,
      });
    }
  }
  return table;
}
