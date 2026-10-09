// @effect-diagnostics globalTimers:off globalDate:off - Runs inside the Pi runtime worker, outside the Effect runtime.
/**
 * Folds agent transcript entries (see PiAgentHook.ts) into Agents rows.
 *
 * Every observed agent, however it was found, becomes one `subagent` task.
 * When one tool call starts several agents, the call itself becomes a
 * `local_workflow` group so the panel shows the fan-out as a unit. Nothing here
 * knows which extension started an agent.
 *
 * Pure apart from the injected clock and scheduler, so tests drive it directly.
 *
 * @module provider/Layers/PiAgentRoster
 */
import {
  RuntimeTaskId,
  type RuntimeTaskUsage,
  type TaskCompletedPayload,
  type TaskProgressPayload,
  type TaskStartedPayload,
  type TaskUpdatedPayload,
} from "@rove-code/contracts";

import type { PiAgentEntry, PiAgentParent } from "./PiAgentHook.ts";

export type PiAgentTaskDescriptor =
  | { readonly type: "task.started"; readonly payload: TaskStartedPayload }
  | { readonly type: "task.progress"; readonly payload: TaskProgressPayload }
  | { readonly type: "task.updated"; readonly payload: TaskUpdatedPayload }
  | { readonly type: "task.completed"; readonly payload: TaskCompletedPayload };

export interface PiAgentRosterOptions {
  readonly emit: (threadId: string, task: PiAgentTaskDescriptor) => void;
  readonly now?: () => number;
  readonly schedule?: (run: () => void, delayMs: number) => { cancel(): void };
  /** Minimum gap between progress rows per agent. */
  readonly progressIntervalMs?: number;
  /** How long an agent CLI must run before it gets a row without output. */
  readonly cliRevealMs?: number;
  /** Grace period for a spawner's exit entry after a channel closes. */
  readonly closeGraceMs?: number;
  /**
   * Entries an agent's writers persisted. Writers append to disk before sending,
   * so replaying on exit and on a closed channel recovers entries still in flight.
   */
  readonly replay?: (threadId: string, agentId: string) => ReadonlyArray<PiAgentEntry>;
}

type Status = "running" | "completed" | "failed" | "stopped";

interface AgentState {
  readonly id: string;
  readonly th: string;
  src: NonNullable<PiAgentEntry["src"]>;
  parent: PiAgentParent | undefined;
  label: string | undefined;
  cmd: string | undefined;
  name: string | undefined;
  task: string | undefined;
  model: string | undefined;
  thinking: string | undefined;
  status: Status;
  visible: boolean;
  busy: boolean;
  exited: boolean;
  lastText: string | undefined;
  lastStop: string | undefined;
  lastError: string | undefined;
  usage: { in: number; out: number; cr: number; cw: number };
  toolCount: number;
  openTools: Map<string, { readonly name: string; readonly target: string | undefined }>;
  lastTool: string | undefined;
  groupId: string | undefined;
  seen: Set<string>;
  progressDue: boolean;
  progressTimer: { cancel(): void } | undefined;
  lastProgressAt: number;
  revealTimer: { cancel(): void } | undefined;
}

interface GroupState {
  readonly id: string;
  readonly th: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly members: string[];
  started: boolean;
  settled: boolean;
}

const TITLE_LIMIT = 100;
const SUMMARY_LIMIT = 180;
const SEEN_LIMIT = 4_096;
/** Settled agents kept for late entries and reactivation; older ones are forgotten. */
const SETTLED_RETENTION = 500;

function firstLine(value: string, limit: number): string {
  const line =
    value
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

function lastLine(value: string, limit: number): string {
  const lines = value
    .split("\n")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const line = lines.at(-1) ?? "";
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

const isTerminal = (status: Status) => status !== "running";

export class PiAgentRoster {
  private readonly agents = new Map<string, AgentState>();
  private readonly groups = new Map<string, GroupState>();
  private readonly now: () => number;
  private readonly schedule: NonNullable<PiAgentRosterOptions["schedule"]>;
  private readonly progressIntervalMs: number;
  private readonly cliRevealMs: number;
  private readonly closeGraceMs: number;
  private readonly options: PiAgentRosterOptions;

  constructor(options: PiAgentRosterOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ??
      ((run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        timer.unref?.();
        return { cancel: () => clearTimeout(timer) };
      });
    this.progressIntervalMs = options.progressIntervalMs ?? 750;
    this.cliRevealMs = options.cliRevealMs ?? 1_500;
    this.closeGraceMs = options.closeGraceMs ?? 1_000;
  }

  /** Apply one transcript entry. Duplicates (same writer and sequence) are ignored. */
  ingest(entry: PiAgentEntry): void {
    let agent = this.agents.get(entry.a);
    const key = `${entry.w}:${entry.q}`;
    if (agent?.seen.has(key)) return;
    if (!agent) {
      // Entries can precede `start` (a spawner's exit racing the child's start).
      agent = this.create(entry);
    }
    agent.seen.add(key);
    if (agent.seen.size > SEEN_LIMIT) agent.seen.clear();
    this.apply(agent, entry);
  }

  /** A model-call or in-process agent's tool call returned. */
  toolEnded(threadId: string, toolCallId: string): void {
    for (const agent of this.agents.values()) {
      if (
        agent.th === threadId &&
        agent.src === "model" &&
        agent.parent?.t === toolCallId &&
        !isTerminal(agent.status)
      ) {
        this.settle(agent, agent.lastError ? "failed" : "completed");
      }
    }
  }

  /**
   * A writer's channel closed, which means its process exited. Replay what it
   * wrote to disk but never delivered, then settle agents that did not finish.
   */
  channelClosed(agentIds: Iterable<string>): void {
    const ids = [...agentIds];
    this.schedule(() => {
      for (const id of ids) {
        const agent = this.agents.get(id);
        if (!agent || agent.exited) continue;
        this.replay(agent);
        if (agent.exited || agent.src === "cli" || agent.src === "model") continue;
        agent.exited = true;
        if (!isTerminal(agent.status)) {
          agent.lastError ??= "The agent process ended before it finished.";
          this.settle(agent, "failed");
        }
      }
    }, this.closeGraceMs);
  }

  private replay(agent: AgentState): void {
    for (const entry of this.options.replay?.(agent.th, agent.id) ?? []) this.ingest(entry);
  }

  private create(entry: PiAgentEntry): AgentState {
    const agent: AgentState = {
      id: entry.a,
      th: entry.th,
      src: entry.src ?? "pi",
      parent: entry.parent,
      label: undefined,
      cmd: undefined,
      name: undefined,
      task: undefined,
      model: undefined,
      thinking: undefined,
      status: "running",
      visible: false,
      busy: false,
      exited: false,
      lastText: undefined,
      lastStop: undefined,
      lastError: undefined,
      usage: { in: 0, out: 0, cr: 0, cw: 0 },
      toolCount: 0,
      openTools: new Map(),
      lastTool: undefined,
      groupId: undefined,
      seen: new Set(),
      progressDue: false,
      progressTimer: undefined,
      lastProgressAt: 0,
      revealTimer: undefined,
    };
    this.agents.set(entry.a, agent);
    return agent;
  }

  private apply(agent: AgentState, entry: PiAgentEntry): void {
    switch (entry.k) {
      case "start": {
        agent.src = entry.src ?? agent.src;
        agent.parent = entry.parent ?? agent.parent;
        agent.label = entry.label ?? agent.label;
        agent.cmd = entry.cmd ?? agent.cmd;
        if (agent.src === "cli") {
          agent.revealTimer = this.schedule(() => this.reveal(agent), this.cliRevealMs);
        } else this.reveal(agent);
        return;
      }
      case "meta": {
        if (entry.model) agent.model = entry.model;
        if (entry.thinking) agent.thinking = entry.thinking;
        if (entry.name) agent.name = entry.name;
        break;
      }
      case "task": {
        if (entry.text && !agent.task) agent.task = entry.text;
        break;
      }
      case "user":
        break;
      case "busy": {
        agent.busy = true;
        if (isTerminal(agent.status) && agent.visible && !agent.exited) {
          agent.status = "running";
          agent.lastError = undefined;
          agent.lastStop = undefined;
          this.options.emit(agent.th, {
            type: "task.updated",
            payload: { taskId: RuntimeTaskId.make(agent.id), status: "running" },
          });
          this.refreshGroup(agent);
        }
        break;
      }
      case "idle": {
        agent.busy = false;
        agent.openTools.clear();
        if (agent.src === "pi" || agent.src === "agent") {
          this.settle(agent, this.outcome(agent));
          return;
        }
        break;
      }
      case "text": {
        if (entry.text) agent.lastText = entry.text;
        if (entry.stop) agent.lastStop = entry.stop;
        if (entry.error) agent.lastError = entry.error;
        if (entry.model) agent.model = entry.model;
        break;
      }
      case "usage": {
        const next = {
          in: entry.in ?? 0,
          out: entry.outTok ?? 0,
          cr: entry.cr ?? 0,
          cw: entry.cw ?? 0,
        };
        if (entry.cum === true) {
          agent.usage = {
            in: Math.max(agent.usage.in, next.in),
            out: Math.max(agent.usage.out, next.out),
            cr: Math.max(agent.usage.cr, next.cr),
            cw: Math.max(agent.usage.cw, next.cw),
          };
        } else {
          agent.usage = {
            in: agent.usage.in + next.in,
            out: agent.usage.out + next.out,
            cr: agent.usage.cr + next.cr,
            cw: agent.usage.cw + next.cw,
          };
        }
        break;
      }
      case "tool": {
        agent.toolCount += 1;
        if (entry.name) {
          agent.lastTool = entry.name;
          agent.openTools.set(entry.id ?? String(agent.toolCount), {
            name: entry.name,
            target: entry.target,
          });
        }
        break;
      }
      case "toolEnd": {
        if (entry.id) agent.openTools.delete(entry.id);
        break;
      }
      case "exit": {
        // The process is gone; everything it wrote is on disk even if not yet delivered.
        this.replay(agent);
        if (agent.exited) return;
        agent.exited = true;
        agent.revealTimer?.cancel();
        if (entry.error) agent.lastError ??= entry.error;
        if (!agent.visible) {
          // A short agent CLI run with no output (`claude --version`) is not an agent.
          const failed = (entry.code !== 0 && entry.code !== undefined) || entry.error;
          if (agent.src === "cli" && !failed && !agent.lastText && agent.toolCount === 0) return;
          this.reveal(agent);
        }
        if (!isTerminal(agent.status)) {
          const signalled = typeof entry.signal === "string" && entry.signal.length > 0;
          const failedExit = typeof entry.code === "number" && entry.code !== 0;
          if (failedExit && !agent.lastError) agent.lastError = `Exited with code ${entry.code}.`;
          if (signalled) this.settle(agent, "stopped");
          else if (failedExit || entry.error) this.settle(agent, "failed");
          else this.settle(agent, this.outcome(agent));
        }
        return;
      }
    }
    if (agent.src === "cli" && !agent.visible && entry.k !== "meta") this.reveal(agent);
    this.queueProgress(agent);
  }

  private outcome(agent: AgentState): Exclude<Status, "running"> {
    if (agent.lastStop === "aborted") return "stopped";
    if (agent.lastStop === "error" || agent.lastError) return "failed";
    return "completed";
  }

  private title(agent: AgentState): string {
    if (agent.name) return firstLine(agent.name, TITLE_LIMIT);
    if (agent.task) return firstLine(agent.task, TITLE_LIMIT);
    if (agent.src === "model") return `${agent.parent?.n ?? "Tool"} model calls`;
    if (agent.src === "cli") return agent.cmd ? firstLine(agent.cmd, TITLE_LIMIT) : "Agent CLI";
    if (agent.label) return agent.label;
    return agent.src === "agent" ? "In-process agent" : "Pi agent";
  }

  private role(agent: AgentState): string | undefined {
    if (agent.src === "cli") return agent.label;
    if (agent.parent?.n) return agent.parent.n;
    return agent.parent?.p ? "nested" : undefined;
  }

  private typedUsage(agent: AgentState): RuntimeTaskUsage | undefined {
    const { usage } = agent;
    const total = usage.in + usage.out + usage.cr + usage.cw;
    if (total === 0 && agent.toolCount === 0) return undefined;
    return {
      totalTokens: total,
      ...(usage.in > 0 ? { inputTokens: usage.in } : undefined),
      ...(usage.cr > 0 ? { cachedInputTokens: usage.cr } : undefined),
      ...(usage.out > 0 ? { outputTokens: usage.out } : undefined),
      ...(agent.toolCount > 0 ? { toolUses: agent.toolCount } : undefined),
    };
  }

  private activity(agent: AgentState): string | undefined {
    const open = [...agent.openTools.values()].at(-1);
    if (open)
      return `▸ ${open.name}${open.target ? ` ${open.target}` : ""}`.slice(0, SUMMARY_LIMIT);
    if (agent.lastText) return lastLine(agent.lastText, SUMMARY_LIMIT);
    return undefined;
  }

  private linkage(agent: AgentState) {
    const role = this.role(agent);
    const usage = this.typedUsage(agent);
    return {
      taskId: RuntimeTaskId.make(agent.id),
      taskType: "subagent",
      title: this.title(agent),
      ...(role ? { role } : undefined),
      ...(agent.model ? { model: agent.model } : undefined),
      ...(agent.thinking ? { effort: agent.thinking } : undefined),
      ...(agent.parent?.t ? { toolUseId: agent.parent.t } : undefined),
      ...(agent.groupId ? { parentAgentId: agent.groupId } : undefined),
      ...(usage ? { typedUsage: usage } : undefined),
      runHandles: { hasTranscript: true },
    } as const;
  }

  private reveal(agent: AgentState): void {
    if (agent.visible) return;
    agent.visible = true;
    agent.revealTimer?.cancel();
    agent.revealTimer = undefined;
    const group = this.joinGroup(agent);
    const { typedUsage: _usage, ...linkage } = this.linkage(agent);
    this.options.emit(agent.th, {
      type: "task.started",
      payload: { ...linkage, description: linkage.title },
    });
    if (group) this.refreshGroup(agent);
  }

  /** The second agent from one tool call turns that call into a group. */
  private joinGroup(agent: AgentState): GroupState | undefined {
    const toolCallId = agent.parent?.t;
    if (!toolCallId) return undefined;
    const key = `${agent.th}\u0000${toolCallId}`;
    let group = this.groups.get(key);
    if (!group) {
      group = {
        id: `group-${toolCallId}`,
        th: agent.th,
        toolCallId,
        toolName: agent.parent?.n ?? "Tool call",
        members: [],
        started: false,
        settled: false,
      };
      this.groups.set(key, group);
    }
    group.members.push(agent.id);
    if (group.members.length < 2) return undefined;
    if (!group.started) {
      group.started = true;
      this.options.emit(agent.th, {
        type: "task.started",
        payload: {
          taskId: RuntimeTaskId.make(group.id),
          taskType: "local_workflow",
          title: group.toolName,
          description: group.toolName,
          workflowName: group.toolName,
          toolUseId: toolCallId,
        },
      });
      for (const memberId of group.members) {
        const member = this.agents.get(memberId);
        if (!member) continue;
        member.groupId = group.id;
        if (member !== agent) this.emitProgress(member);
      }
    }
    agent.groupId = group.id;
    return group;
  }

  private refreshGroup(agent: AgentState): void {
    const toolCallId = agent.parent?.t;
    if (!toolCallId || !agent.groupId) return;
    const group = this.groups.get(`${agent.th}\u0000${toolCallId}`);
    if (!group?.started) return;
    const members = group.members.flatMap((id) => {
      const member = this.agents.get(id);
      return member ? [member] : [];
    });
    const settled = members.every((member) => isTerminal(member.status));
    if (settled && !group.settled) {
      group.settled = true;
      const failed = members.filter((member) => member.status === "failed").length;
      this.options.emit(group.th, {
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.make(group.id),
          status: failed > 0 ? "failed" : "completed",
          summary: `${members.length - failed}/${members.length} finished${failed > 0 ? `, ${failed} failed` : ""}`,
          taskType: "local_workflow",
        },
      });
    } else if (!settled && group.settled) {
      group.settled = false;
      this.options.emit(group.th, {
        type: "task.updated",
        payload: { taskId: RuntimeTaskId.make(group.id), status: "running" },
      });
    }
  }

  private queueProgress(agent: AgentState): void {
    if (!agent.visible || isTerminal(agent.status)) return;
    agent.progressDue = true;
    if (agent.progressTimer) return;
    const wait = Math.max(0, agent.lastProgressAt + this.progressIntervalMs - this.now());
    if (wait === 0) {
      this.emitProgress(agent);
      return;
    }
    agent.progressTimer = this.schedule(() => {
      agent.progressTimer = undefined;
      if (agent.progressDue && !isTerminal(agent.status)) this.emitProgress(agent);
    }, wait);
  }

  private emitProgress(agent: AgentState): void {
    agent.progressDue = false;
    agent.lastProgressAt = this.now();
    const linkage = this.linkage(agent);
    const activity = this.activity(agent);
    this.options.emit(agent.th, {
      type: "task.progress",
      payload: {
        ...linkage,
        description: linkage.title,
        ...(activity ? { summary: activity } : undefined),
        ...(agent.lastTool ? { lastToolName: agent.lastTool } : undefined),
        ...(isTerminal(agent.status) ? undefined : { status: "running" as const }),
      },
    });
  }

  private settle(agent: AgentState, status: Exclude<Status, "running">): void {
    if (!agent.visible) this.reveal(agent);
    if (isTerminal(agent.status)) return;
    agent.status = status;
    agent.progressTimer?.cancel();
    agent.progressTimer = undefined;
    agent.progressDue = false;
    const linkage = this.linkage(agent);
    const summary =
      status === "failed"
        ? (agent.lastError ??
          (agent.lastText ? firstLine(agent.lastText, SUMMARY_LIMIT) : undefined))
        : agent.lastText
          ? firstLine(agent.lastText, SUMMARY_LIMIT)
          : undefined;
    this.options.emit(agent.th, {
      type: "task.completed",
      payload: {
        ...linkage,
        status,
        ...(summary ? { summary: summary.slice(0, SUMMARY_LIMIT) } : undefined),
      },
    });
    this.refreshGroup(agent);
    this.forgetOldest();
  }

  /** Maps iterate in insertion order, so the first settled entries are the oldest. */
  private forgetOldest(): void {
    let settled = 0;
    for (const candidate of this.agents.values()) if (isTerminal(candidate.status)) settled++;
    for (const [id, candidate] of this.agents) {
      if (settled <= SETTLED_RETENTION) break;
      if (!isTerminal(candidate.status)) continue;
      this.agents.delete(id);
      settled--;
    }
    for (const [key, group] of this.groups)
      if (group.members.every((id) => !this.agents.has(id))) this.groups.delete(key);
  }
}
