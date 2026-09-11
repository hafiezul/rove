/**
 * pi-subagents dialect — observability mapping for the `pi-subagents` extension.
 *
 * This is the pi-subagents implementation of the `PiSubagentDialect` interface
 * (`PiSubagentDialects.ts`): it translates this extension's payload shapes
 * (`workflowScript` launches, `workflowChildren` status polls, `completions`
 * from `bg_wait`, `subagent-notify` wake text) into the shared `task.*`
 * vocabulary. Everything here is pure and total — malformed payloads yield no
 * descriptors, never throw.
 *
 * New extensions copy this pattern: implement the interface in a new file and
 * register it in the adapter's dialect list. The adapter core never branches
 * on extension identity.
 *
 * @module provider/Layers/PiSubagentsDialect
 */
import { RuntimeTaskId } from "@t3tools/contracts";
import * as RuntimePredicate from "effect/Predicate";
import type { Json as SchemaJson } from "effect/Schema";
import {
  optChildStatus,
  optModel,
  optTypedUsage,
  piBounded,
  piChildStatus,
  piFirstText,
  piNonNegativeInt,
  piNotifyContentText,
  piRecord,
  piShortId,
  piTrimmed,
  piWorkflowMemberId,
  type PiNotifyReading,
  type PiSubagentDialect,
  type PiSubagentTaskDescriptor,
  type PiSubagentToolInput,
} from "./PiSubagentDialects.ts";

const PI_SUBAGENTS_TOOL_NAMES: ReadonlySet<string> = new Set(["subagent", "bg_wait"]);

export const piSubagentsDialect: PiSubagentDialect = {
  name: "pi-subagents",
  toolNames: PI_SUBAGENTS_TOOL_NAMES,
  customMessageTypes: new Set(["subagent-notify"]),
  describeToolTasks: describePiSubagentToolTasks,
  parseNotifyContent: (content) => parsePiNotifyContent(content),
};

function piCompletionStatus(state: unknown, success: unknown): "completed" | "failed" | "stopped" {
  if (success === false) return "failed";
  const normalized = RuntimePredicate.isString(state) ? state.trim().toLowerCase() : "";
  if (normalized === "failed") return "failed";
  if (normalized === "stopped") return "stopped";
  return "completed";
}

/** Agent name fallback parsed from single-spawn text (`Async: delegate [runId]`). */
const PI_SINGLE_SPAWN_AGENT_PATTERN = /^Async:\s*(\S+)/;

function piSpawnAgent(
  args: Record<string, SchemaJson> | undefined,
  text: string | undefined,
): string | undefined {
  return (
    piTrimmed(args?.agent) ??
    (text ? piTrimmed(PI_SINGLE_SPAWN_AGENT_PATTERN.exec(text)?.[1]) : undefined)
  );
}

interface PiWorkflowChildSpec {
  readonly key?: string | undefined;
  readonly agent?: string | undefined;
  readonly task?: string | undefined;
}

/** Parse `workflowScript` JS (`runs.all([{key, agent, task}])`) into ordered
 *  child specs. Regex-based: scripts are small, model-generated, and consistently
 *  shaped; a full JS parse would drag a parser into the adapter for no gain.
 *  Capped to the fanout budget so a pathological script can't flood the roster. */
const PI_WORKFLOW_SCRIPT_CHILD_CAP = 64;

export function parsePiWorkflowScript(script: unknown): ReadonlyArray<PiWorkflowChildSpec> {
  if (!RuntimePredicate.isString(script) || script.trim().length === 0) return [];
  const specs: Array<PiWorkflowChildSpec> = [];
  const objectPattern = /\{[^{}]*?\}/g;
  let match: RegExpExecArray | null;
  while (
    (match = objectPattern.exec(script)) !== null &&
    specs.length < PI_WORKFLOW_SCRIPT_CHILD_CAP
  ) {
    const body = match[0] ?? "";
    if (!/\bagent\b|\bkey\b|\btask\b/.test(body)) continue;
    const key = /\bkey\s*:\s*["'`]([^"'`]+)["'`]/.exec(body)?.[1];
    const agent = /\bagent\s*:\s*["'`]([^"'`]+)["'`]/.exec(body)?.[1];
    const task = /\btask\s*:\s*["'`]([^"'`]*?)["'`]/.exec(body)?.[1];
    const trimmedKey = key?.trim();
    const trimmedAgent = agent?.trim();
    const trimmedTask = task?.trim();
    if (!trimmedKey && !trimmedAgent && !trimmedTask) continue;
    specs.push({
      ...(trimmedKey ? { key: trimmedKey } : undefined),
      ...(trimmedAgent ? { agent: trimmedAgent } : undefined),
      ...(trimmedTask ? { task: trimmedTask } : undefined),
    });
  }
  return specs;
}

function piWorkflowChildTitle(spec: PiWorkflowChildSpec, index: number): string {
  const agent = spec.agent?.trim();
  const task = spec.task?.trim();
  if (agent && task) return piBounded(`${agent}: ${task}`, 120);
  if (task) return piBounded(task, 120);
  if (agent) return agent;
  const key = spec.key?.trim();
  return key ? `Child ${key}` : `Child ${index + 1}`;
}

/** Provider errors that arrive as tool-result text with no run identity
 *  (e.g. `Unknown subagent model 'x'`). These must still settle the roster. */
function piFailureText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = text.trim();
  if (t.length === 0) return undefined;
  if (/unknown subagent model/i.test(t)) return t;
  if (/unknown model/i.test(t)) return t;
  if (/model .* not (found|available|in registry)/i.test(t)) return t;
  return undefined;
}

function piWorkflowChildrenOf(value: Record<string, SchemaJson> | undefined):
  | {
      readonly workflowRunId: string;
      readonly children: ReadonlyArray<Record<string, SchemaJson>>;
    }
  | undefined {
  if (!value) return undefined;
  const summary = piRecord(value.workflowChildren);
  if (!summary) return undefined;
  const workflowRunId = piTrimmed(summary.workflowRunId);
  const raw = summary.children;
  if (!workflowRunId || !Array.isArray(raw)) return undefined;
  return {
    workflowRunId,
    children: raw.flatMap((entry) => {
      const child = piRecord(entry);
      return child ? [child] : [];
    }),
  };
}

function piCompletionDescriptors(
  completions: ReadonlyArray<Record<string, SchemaJson>>,
): ReadonlyArray<PiSubagentTaskDescriptor> {
  const descriptors: Array<PiSubagentTaskDescriptor> = [];
  for (const completion of completions) {
    const runId = piTrimmed(completion.runId);
    if (!runId) continue;
    const agent = piTrimmed(completion.agent);
    const children = Array.isArray(completion.results)
      ? completion.results.flatMap((entry) => {
          const child = piRecord(entry);
          return child ? [child] : [];
        })
      : [];
    // Single-run completions carry their own result inline in results[0];
    // only workflow runs (or multi-result rows of unknown mode) fan out.
    const isWorkflow =
      completion.mode === "workflow" || (completion.mode !== "single" && children.length > 1);
    if (isWorkflow) {
      const failed = children.filter(
        (child) => child.success === false || piTrimmed(child.error) !== undefined,
      );
      descriptors.push({
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.make(runId),
          status: piCompletionStatus(
            completion.state,
            failed.length === 0 ? completion.success : false,
          ),
          ...(failed.length > 0 && failed.length === children.length && children.length > 0
            ? { summary: `${failed.length}/${children.length} children failed` }
            : undefined),
          taskType: "local_workflow",
          title: `Workflow ${piShortId(runId)}`,
          runHandles: { runId },
        },
      });
      children.forEach((child, index) => {
        // Prefer the stable workflow-key identity when the completion carries
        // its workflowChildren summary: launch-time rows use `<runId>:wf:<key>`
        // (parsed from workflowScript before child run ids exist), so completing
        // by raw run id would orphan them into duplicates that only the
        // coordinator cascade could settle.
        const workflowKids = piWorkflowChildrenOf(completion);
        const keyFor = (wantedRunId: string | undefined): string | undefined => {
          if (!wantedRunId || !workflowKids) return undefined;
          const found = workflowKids.children.find(
            (entry) => piTrimmed(entry.runId) === wantedRunId,
          );
          return found ? piTrimmed(found.childId) : undefined;
        };
        const rawChildRunId = piTrimmed(child.runId);
        const childKey = keyFor(rawChildRunId);
        const childRunId =
          childKey !== undefined
            ? piWorkflowMemberId(runId, childKey)
            : (rawChildRunId ??
              (agent !== undefined || piTrimmed(child.agent) !== undefined
                ? `${runId}:${piTrimmed(child.agent) ?? agent ?? index}`
                : undefined));
        if (!childRunId) return;
        const childAgent = piTrimmed(child.agent) ?? agent;
        const childError = piTrimmed(child.error);
        descriptors.push({
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.make(childRunId),
            status: child.success === false || childError !== undefined ? "failed" : "completed",
            ...(childError ? { summary: piBounded(`Failed: ${childError}`) } : undefined),
            ...(childAgent ? { role: childAgent, title: childAgent } : undefined),
            taskType: "subagent",
            parentAgentId: runId,
            ...optModel(child.model),
            ...optTypedUsage(child.usage),
            runHandles: { runId: rawChildRunId ?? childRunId },
          },
        });
      });
    } else {
      const child = children[0];
      const error = piTrimmed(completion.error) ?? (child ? piTrimmed(child.error) : undefined);
      descriptors.push({
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.make(runId),
          status:
            error !== undefined
              ? "failed"
              : piCompletionStatus(completion.state, completion.success),
          ...(error ? { summary: piBounded(`Failed: ${error}`) } : undefined),
          ...(agent ? { role: agent, title: agent } : { title: `Subagent ${piShortId(runId)}` }),
          taskType: "subagent",
          ...optModel(child?.model),
          ...optTypedUsage(child?.usage),
          runHandles: { runId },
        },
      });
    }
  }
  return descriptors;
}

export function describePiSubagentToolTasks(
  input: PiSubagentToolInput,
): ReadonlyArray<PiSubagentTaskDescriptor> {
  if (!PI_SUBAGENTS_TOOL_NAMES.has(input.toolName)) return [];
  const args = piRecord(input.args);
  const result = piRecord(input.result);
  const details = piRecord(result?.details) ?? {};
  const text = piFirstText(result);
  const action = piTrimmed(args?.action);
  const descriptors: Array<PiSubagentTaskDescriptor> = [];

  const completions = Array.isArray(details.completions)
    ? details.completions.flatMap((entry) => {
        const completion = piRecord(entry);
        return completion ? [completion] : [];
      })
    : [];
  if (completions.length > 0) {
    descriptors.push(...piCompletionDescriptors(completions));
  }

  const runId = piTrimmed(details.runId);
  const mode = piTrimmed(details.mode);
  const hostToolCallId = piTrimmed(input.toolCallId) ?? piTrimmed(details.toolCallId);
  const toolFailed = input.isError === true;
  if (input.toolName === "subagent" && runId !== undefined && action === undefined) {
    if (mode === "workflow") {
      descriptors.push({
        type: "task.started",
        payload: {
          taskId: RuntimeTaskId.make(runId),
          taskType: "local_workflow",
          title: `Workflow ${piShortId(runId)}`,
          runHandles: { runId },
          ...(hostToolCallId ? { toolUseId: hostToolCallId } : undefined),
        },
      });
      const specs = parsePiWorkflowScript(args?.workflowScript);
      specs.forEach((spec, index) => {
        const key = spec.key ?? spec.agent ?? String(index);
        const memberId = piWorkflowMemberId(runId, key);
        descriptors.push({
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.make(memberId),
            taskType: "subagent",
            title: piWorkflowChildTitle(spec, index),
            ...(spec.agent ? { role: spec.agent } : undefined),
            parentAgentId: runId,
            agentIndex: index,
            ...(hostToolCallId ? { toolUseId: hostToolCallId } : undefined),
          },
        });
      });
    } else {
      const agent = piSpawnAgent(args, text);
      const task = piTrimmed(args?.task);
      descriptors.push({
        type: "task.started",
        payload: {
          taskId: RuntimeTaskId.make(runId),
          taskType: "subagent",
          title: agent
            ? task
              ? piBounded(`${agent}: ${task}`, 120)
              : agent
            : `Subagent ${piShortId(runId)}`,
          ...(agent ? { role: agent } : undefined),
          runHandles: { runId },
          ...(hostToolCallId ? { toolUseId: hostToolCallId } : undefined),
        },
      });
    }
  } else if (input.toolName === "subagent" && runId !== undefined && action === "resume") {
    // A revived run must reactivate its roster row: a bare task.started on
    // an existing terminal id would only fill metadata without reopening it.
    descriptors.push({
      type: "task.updated",
      payload: { taskId: RuntimeTaskId.make(runId), status: "running" },
    });
  }

  // Foreground (synchronous) children resolve inside the tool call itself:
  // the result rows are the whole lifecycle, so emit the pair directly.
  const foreground = Array.isArray(details.results)
    ? details.results.flatMap((entry) => {
        const child = piRecord(entry);
        return child ? [child] : [];
      })
    : [];
  const toolCallId = hostToolCallId;
  if (
    input.toolName === "subagent" &&
    runId === undefined &&
    toolCallId !== undefined &&
    foreground.length > 0
  ) {
    foreground.forEach((child, index) => {
      if (child.detached === true) return;
      const agent = piTrimmed(child.agent);
      const task = piTrimmed(child.task);
      if (agent === undefined && task === undefined) return;
      const childTaskId = index === 0 ? toolCallId : `${toolCallId}:${index}`;
      const childError = piTrimmed(child.error);
      const title =
        task !== undefined
          ? agent !== undefined
            ? piBounded(`${agent}: ${task}`, 120)
            : piBounded(task, 120)
          : agent;
      if (title === undefined) return;
      descriptors.push({
        type: "task.started",
        payload: {
          taskId: RuntimeTaskId.make(childTaskId),
          taskType: "subagent",
          title,
          ...(agent ? { role: agent } : undefined),
          ...optModel(child.model),
          toolUseId: toolCallId,
        },
      });
      descriptors.push({
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.make(childTaskId),
          status: childError !== undefined || child.exitCode !== 0 ? "failed" : "completed",
          ...(childError ? { summary: piBounded(`Failed: ${childError}`) } : undefined),
          taskType: "subagent",
          ...optTypedUsage(child.usage),
        },
      });
    });
  }

  if (runId === undefined) {
    const childrenSummary = piRecord(details.workflowChildren);
    const workflowRunId = piTrimmed(childrenSummary?.workflowRunId);
    const childrenField = childrenSummary?.children;
    const children = Array.isArray(childrenField)
      ? childrenField.flatMap((entry) => {
          const child = piRecord(entry);
          return child ? [child] : [];
        })
      : [];
    if (workflowRunId !== undefined && action === "status") {
      const done = children.filter((child) => {
        const state = piChildStatus(child.state);
        return state === "completed" || state === "failed";
      }).length;
      const active = children.filter((child) => {
        const state = piChildStatus(child.state);
        return state === "running" || state === "pending";
      }).length;
      const workflowState = piTrimmed(childrenSummary?.workflowState)?.toLowerCase();
      if (
        workflowState === "completed" ||
        workflowState === "failed" ||
        workflowState === "stopped"
      ) {
        descriptors.push({
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.make(workflowRunId),
            status:
              workflowState === "completed"
                ? "completed"
                : workflowState === "failed"
                  ? "failed"
                  : "stopped",
            summary: `${done}/${children.length} done`,
            taskType: "local_workflow",
            title: `Workflow ${piShortId(workflowRunId)}`,
          },
        });
      } else {
        descriptors.push({
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.make(workflowRunId),
            description: `Workflow ${piShortId(workflowRunId)}`,
            ...(children.length > 0
              ? { summary: `${done}/${children.length} done · ${active} active` }
              : undefined),
            status: workflowState === "queued" ? "pending" : "running",
            taskType: "local_workflow",
            title: `Workflow ${piShortId(workflowRunId)}`,
          },
        });
      }
      for (const child of children) {
        const childId = piTrimmed(child.childId);
        const rawChildRunId = piTrimmed(child.runId);
        const childAgent = piTrimmed(child.agent);
        // Stable identity first: launch rows use `<runId>:wf:<key>`, so status
        // must reconcile to the same id instead of forking a duplicate keyed
        // by the late-arriving run id. Fall back to the run id only when the
        // summary carries no key (older payloads).
        const stableId =
          childId !== undefined ? piWorkflowMemberId(workflowRunId, childId) : rawChildRunId;
        if (!stableId) continue;
        const label =
          piTrimmed(child.sessionName) ??
          childId ??
          childAgent ??
          `Child ${piShortId(rawChildRunId ?? workflowRunId)}`;
        descriptors.push({
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.make(stableId),
            description: label,
            title: childAgent ? `${childAgent}: ${label}`.slice(0, 120) : label,
            ...(childAgent ? { role: childAgent } : undefined),
            taskType: "subagent",
            parentAgentId: workflowRunId,
            ...optChildStatus(child.state),
            ...optModel(child.model),
            ...(rawChildRunId ? { runHandles: { runId: rawChildRunId } } : undefined),
          },
        });
      }
    }
    if (action === "status") {
      const processTerminal = piRecord(piRecord(details.lifecycleStatus)?.processTerminal);
      const observedRunId = piTrimmed(processTerminal?.runId);
      if (observedRunId !== undefined) {
        const instancesField = processTerminal?.instances;
        const instances = Array.isArray(instancesField)
          ? instancesField.flatMap((entry) => {
              const instance = piRecord(entry);
              return instance ? [instance] : [];
            })
          : [];
        const failed = instances.some(
          (instance) =>
            (piNonNegativeInt(instance.exitCode) ?? 0) !== 0 ||
            (instance.signal !== undefined && instance.signal !== null),
        );
        descriptors.push({
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.make(observedRunId),
            status: failed ? "failed" : "completed",
            taskType: "subagent",
            title: agentFallbackTitle(args, text, observedRunId),
          },
        });
      }
    }
  }

  if (
    input.toolName === "subagent" &&
    runId === undefined &&
    descriptors.length === 0 &&
    foreground.length === 0 &&
    completions.length === 0
  ) {
    const failure = piFailureText(text);
    if ((toolFailed || failure !== undefined) && toolCallId !== undefined) {
      const agent = piSpawnAgent(args, text);
      const task = piTrimmed(args?.task);
      const title = agent
        ? task
          ? piBounded(`${agent}: ${task}`, 120)
          : agent
        : `Subagent ${piShortId(toolCallId)}`;
      const summary = piBounded(`Failed: ${failure ?? text ?? "subagent launch failed"}`);
      descriptors.push({
        type: "task.started",
        payload: {
          taskId: RuntimeTaskId.make(toolCallId),
          taskType: "subagent",
          title,
          ...(agent ? { role: agent } : undefined),
          toolUseId: toolCallId,
        },
      });
      descriptors.push({
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.make(toolCallId),
          status: "failed",
          summary,
          taskType: "subagent",
          ...(agent ? { role: agent } : undefined),
        },
      });
    }
  }

  return descriptors;
}

const PI_NOTIFY_HEADER_PATTERN =
  /^(Background task|Detached foreground task) (completed|failed|paused|stopped): \*\*(.+?)\*\*/;
const PI_NOTIFY_RECEIPT_RUN_PATTERN = /async-subagent-runs\/([0-9a-fA-F-]{8,})\//;
const PI_NOTIFY_CHILD_OUTPUT_PATTERN = /^- key=(\S+) run=(\S+) status=(\S+)\s*$/;

export function parsePiNotifyContent(content: unknown): PiNotifyReading | undefined {
  const text = piNotifyContentText(content);
  if (!text) return undefined;
  const lines = text.split("\n");
  const header = PI_NOTIFY_HEADER_PATTERN.exec(lines[0] ?? "");
  if (!header) return undefined;
  const status = header[2] ?? "";
  const agent = (header[3] ?? "").trim();
  if (!agent) return undefined;
  let workflowRunId: string | undefined;
  const childRuns: Array<PiNotifyReading["childRuns"][number]> = [];
  for (const line of lines) {
    const receipt = /^Workflow receipt: \s*(\S+)\s*$/.exec(line);
    if (receipt) {
      const run = PI_NOTIFY_RECEIPT_RUN_PATTERN.exec(receipt[1] ?? "");
      if (run?.[1] && !workflowRunId) workflowRunId = run[1];
      continue;
    }
    const runLine = /^Workflow run: \s*(\S+)\s*$/.exec(line);
    if (runLine?.[1]) {
      workflowRunId = runLine[1];
      continue;
    }
    const kidsLine = /^Child runs: \s*(.+?)\s*$/.exec(line);
    if (kidsLine?.[1]) {
      for (const part of kidsLine[1].split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const withStatus = /^(.*?)(?:\s*\(([^)]*)\))?$/.exec(trimmed);
        const raw = (withStatus?.[1] ?? trimmed).trim();
        const childStatus = withStatus?.[2]?.trim() || undefined;
        const sep = raw.indexOf("=");
        if (sep >= 0) {
          const key = raw.slice(0, sep).trim();
          const runId = raw.slice(sep + 1).trim();
          if (runId)
            childRuns.push({
              ...(key ? { workflowKey: key } : undefined),
              runId,
              ...(childStatus ? { status: childStatus } : undefined),
            });
        } else if (raw) {
          childRuns.push({ runId: raw, ...(childStatus ? { status: childStatus } : undefined) });
        }
      }
      continue;
    }
    const outputKid = PI_NOTIFY_CHILD_OUTPUT_PATTERN.exec(line.trim());
    if (outputKid?.[2]) {
      childRuns.push({
        ...(outputKid[1] && outputKid[1] !== "unavailable"
          ? { workflowKey: outputKid[1] }
          : undefined),
        runId: outputKid[2] === "unavailable" ? `unavailable-${childRuns.length}` : outputKid[2],
        ...(outputKid[3] && outputKid[3] !== "unavailable" ? { status: outputKid[3] } : undefined),
      });
    }
  }
  return { agent, status, ...(workflowRunId ? { workflowRunId } : undefined), childRuns };
}

function agentFallbackTitle(
  args: Record<string, SchemaJson> | undefined,
  text: string | undefined,
  runId: string,
): string {
  const agent = piSpawnAgent(args, text);
  return agent ?? `Subagent ${piShortId(runId)}`;
}
