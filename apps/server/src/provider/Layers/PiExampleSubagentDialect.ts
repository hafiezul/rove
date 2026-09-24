import { RuntimeTaskId } from "@t3tools/contracts";
import * as RuntimePredicate from "effect/Predicate";
import type { Json as SchemaJson } from "effect/Schema";
import {
  optModel,
  optTypedUsage,
  piBounded,
  piNonNegativeInt,
  piRecord,
  piTrimmed,
  type PiSubagentDialect,
  type PiSubagentTaskDescriptor,
} from "./PiSubagentDialects.ts";

const CHILD_CAP = 64;
type ExampleDetails = {
  readonly mode: "single" | "parallel" | "chain";
  readonly results: ReadonlyArray<SchemaJson>;
};

function exampleDetails(value: unknown): ExampleDetails | undefined {
  const details = piRecord(piRecord(value)?.details);
  const mode = details?.mode;
  if (
    (mode !== "single" && mode !== "parallel" && mode !== "chain") ||
    (details?.agentScope !== "user" &&
      details?.agentScope !== "project" &&
      details?.agentScope !== "both") ||
    (details?.projectAgentsDir !== null && !RuntimePredicate.isString(details?.projectAgentsDir)) ||
    !Array.isArray(details?.results)
  )
    return undefined;
  return { mode, results: details.results };
}

/** Retain only small, structured fields before the SDK's partial result enters the event queue. */
export function compactPiExampleUpdate(value: unknown) {
  const details = exampleDetails(value);
  if (!details) return undefined;
  const source = piRecord(piRecord(value)?.details);
  return {
    details: {
      mode: details.mode,
      agentScope: source?.agentScope,
      projectAgentsDir: source?.projectAgentsDir,
      results: details.results.slice(0, CHILD_CAP).map((entry) => {
        const child = piRecord(entry);
        if (!child) return null;
        const usage = piRecord(child.usage);
        return {
          agent: piBounded(piTrimmed(child.agent) ?? "", 120),
          task: piBounded(piTrimmed(child.task) ?? "", 120),
          exitCode: child.exitCode,
          stopReason: child.stopReason,
          errorMessage: piBounded(piTrimmed(child.errorMessage) ?? ""),
          model: piBounded(piTrimmed(child.model) ?? "", 120),
          usage: usage
            ? {
                input: piNonNegativeInt(usage.input),
                output: piNonNegativeInt(usage.output),
                cacheRead: piNonNegativeInt(usage.cacheRead),
                cacheWrite: piNonNegativeInt(usage.cacheWrite),
                turns: piNonNegativeInt(usage.turns),
              }
            : undefined,
        };
      }),
    },
  };
}

export const piExampleSubagentDialect: PiSubagentDialect = {
  name: "pi-bundled-subagent-example",
  toolNames: new Set(["subagent"]),
  matchesTool: (input) => exampleDetails(input.result) !== undefined,
  customMessageTypes: new Set(),
  parseNotifyContent: () => undefined,
  describeToolTasks(input) {
    const details = exampleDetails(input.result);
    const toolCallId = piTrimmed(input.toolCallId);
    if (!details || !toolCallId) return [];
    const args = piRecord(input.args);
    const requested = details.mode === "parallel" ? args?.tasks : args?.chain;
    const specs: ReadonlyArray<unknown> =
      details.mode === "single" ? [args] : Array.isArray(requested) ? requested : [];
    const count = Math.min(CHILD_CAP, Math.max(specs.length, details.results.length));
    const descriptors: PiSubagentTaskDescriptor[] = [];
    for (let index = 0; index < count; index++) {
      const result = piRecord(details.results[index]);
      const spec = piRecord(specs[index]);
      const agent = piTrimmed(spec?.agent) ?? piTrimmed(result?.agent);
      const task = piTrimmed(spec?.task) ?? piTrimmed(result?.task);
      if (!agent || !task) continue;
      const taskId = RuntimeTaskId.make(`${toolCallId}:${index}`);
      const title = piBounded(`${piBounded(agent, 60)}: ${piBounded(task, 100)}`, 120);
      const linkage = {
        taskId,
        taskType: "subagent",
        toolUseId: toolCallId,
        agentIndex: index,
        title,
        role: piBounded(agent, 120),
      } as const;
      if (input.phase === "update") {
        descriptors.push({ type: "task.started", payload: linkage });
        descriptors.push({
          type: "task.progress",
          payload: {
            ...linkage,
            description: title,
            status:
              !result ||
              (details.mode === "parallel" &&
                result.exitCode === -1 &&
                (piNonNegativeInt(piRecord(result.usage)?.turns) ?? 0) === 0)
                ? "pending"
                : "running",
            ...optModel(result?.model),
            ...optTypedUsage(result?.usage),
          },
        });
        continue;
      }
      if (!result && input.isError !== true && input.interrupted !== true) continue;
      descriptors.push({ type: "task.started", payload: linkage });
      const stopped =
        input.interrupted === true ||
        result?.stopReason === "aborted" ||
        result?.exitCode === -1 ||
        (!result && input.isError === true);
      const failed =
        result?.stopReason === "error" || (result !== undefined && result.exitCode !== 0);
      const status = stopped ? "stopped" : failed ? "failed" : "completed";
      const error = piTrimmed(result?.errorMessage);
      descriptors.push({
        type: "task.completed",
        payload: {
          ...linkage,
          status,
          ...(error ? { summary: piBounded(error) } : undefined),
          ...optModel(result?.model),
          ...optTypedUsage(result?.usage),
        },
      });
    }
    return descriptors;
  },
};
