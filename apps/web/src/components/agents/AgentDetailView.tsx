/**
 * One agent, opened from the Agents panel: what it was asked, what it is doing,
 * every step it took, and how it ended.
 *
 * The header and stats come from the Agents row, so they work for every
 * provider. Rows with `runHandles.hasTranscript` (agents Rove observed itself,
 * see ADR 0002) add the task, a step-by-step transcript, and the full result.
 *
 * Design notes:
 * - Opens in place of the list, with no transition: people flip between agents
 *   many times an hour, and the list keeps its scroll position underneath.
 * - Tool steps are one line each; output stays collapsed until asked for.
 * - While the agent runs, the transcript follows new steps unless the reader
 *   has scrolled up.
 */
import type { RuntimeSubagent } from "@rove-code/client-runtime/state/subagentRuntime";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
} from "@rove-code/client-runtime/state/subagentRuntime";
import type {
  EnvironmentId,
  OrchestrationAgentTranscriptEntry,
  ThreadId,
} from "@rove-code/contracts";
import { ArrowLeft, Check, ChevronRight, Copy, ExternalLink, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";

import {
  AgentElapsed,
  STATUS_VISUALS,
  StatusDot,
  agentActivityText,
  formatElapsedSeconds,
} from "./AgentStatus";

const LIVE_REFRESH_MS = 1_000;

function isLive(agent: RuntimeSubagent): boolean {
  return agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
}

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)}ms` : formatElapsedSeconds(ms / 1_000);
}

function SectionLabel({ children }: { children: string }) {
  return (
    <h3 className="mb-1.5 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

/** Long text clamps to a few lines; the reader can open the rest. */
function ClampedText({
  text,
  lines,
  className,
}: {
  text: string;
  lines: 3 | 6;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const long = text.length > (lines === 3 ? 240 : 600) || text.split("\n").length > lines;
  return (
    <div className="min-w-0">
      <p
        className={cn(
          "whitespace-pre-wrap break-words text-xs leading-relaxed",
          !open && long && (lines === 3 ? "line-clamp-3" : "line-clamp-6"),
          className,
        )}
      >
        {text}
      </p>
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="mt-0.5 cursor-pointer text-2xs text-muted-foreground hover:text-foreground"
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function ToolStep({
  entry,
}: {
  entry: Extract<OrchestrationAgentTranscriptEntry, { kind: "tool" }>;
}) {
  const [open, setOpen] = useState(false);
  const expandable = entry.output !== undefined && entry.output.length > 0;
  return (
    <li className="min-w-0">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={expandable ? open : undefined}
        className={cn(
          "grid w-full grid-cols-[0.75rem_auto_minmax(0,1fr)_auto] items-center gap-x-1.5 rounded-sm px-1 py-0.5 text-left font-mono text-2xs",
          expandable && "cursor-pointer hover:bg-muted/30",
        )}
      >
        <span className="flex items-center justify-center">
          {entry.status === "completed" ? (
            <Check aria-hidden className="size-3 text-success" />
          ) : entry.status === "failed" ? (
            <X aria-hidden className="size-3 text-destructive-foreground" />
          ) : (
            <span aria-hidden className="size-1.5 rounded-full bg-info" />
          )}
        </span>
        <span className="text-foreground">{entry.name}</span>
        <span className="truncate text-muted-foreground">{entry.target ?? ""}</span>
        <span className="flex items-center gap-1 tabular-nums text-muted-foreground/70">
          {entry.durationMs !== undefined ? formatDuration(entry.durationMs) : null}
          {expandable ? (
            <ChevronRight
              aria-hidden
              className={cn("size-3 transition-transform duration-150", open && "rotate-90")}
            />
          ) : null}
        </span>
        <span className="sr-only">{entry.status}</span>
      </button>
      {open && entry.output ? (
        <pre className="ml-5 mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border/50 bg-background/60 p-2 font-mono text-2xs leading-relaxed text-foreground/85">
          {entry.output}
        </pre>
      ) : null}
    </li>
  );
}

function TranscriptStep({ entry }: { entry: OrchestrationAgentTranscriptEntry }) {
  switch (entry.kind) {
    case "tool":
      return <ToolStep entry={entry} />;
    case "user":
      return (
        <li className="rounded-sm border-l-2 border-border pl-2">
          <span className="text-3xs uppercase tracking-wider text-muted-foreground">Follow-up</span>
          <ClampedText text={entry.text} lines={3} />
        </li>
      );
    case "task":
      return null;
    case "text":
      return (
        <li className="py-0.5">
          {entry.text ? <ClampedText text={entry.text} lines={6} /> : null}
          {entry.error ? (
            <p className="whitespace-pre-wrap break-words text-xs text-destructive-foreground">
              {entry.error}
            </p>
          ) : null}
        </li>
      );
  }
}

function CopyableValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-start gap-1">
        <span className="min-w-0 break-all font-mono">{value}</span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => void writeTextToClipboard(value)}
          className="shrink-0 cursor-pointer"
        >
          <Copy aria-hidden className="size-3" />
        </Button>
      </dd>
    </div>
  );
}

/** Re-reads a live transcript as its row updates; never more than once a second. */
function useAgentTranscript(
  agent: RuntimeSubagent,
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const enabled = agent.runHandles?.hasTranscript === true && environmentId && threadId;
  const atom = useMemo(
    () =>
      enabled
        ? orchestrationEnvironment.agentTranscript({
            environmentId,
            input: { threadId, taskId: agent.id },
          })
        : null,
    [enabled, environmentId, threadId, agent.id],
  );
  const query = useEnvironmentQuery(atom);
  const { refresh } = query;
  const lastRefresh = useRef(0);
  const live = isLive(agent);
  useEffect(() => {
    if (!atom) return;
    const wait = Math.max(0, lastRefresh.current + LIVE_REFRESH_MS - Date.now());
    const timer = setTimeout(() => {
      lastRefresh.current = Date.now();
      refresh();
    }, wait);
    return () => clearTimeout(timer);
    // A settle (live → false) triggers one last read for the final result.
  }, [atom, agent.updatedAt, live, refresh]);
  return query;
}

export function AgentDetailView({
  agent,
  environmentId,
  threadId,
  onBack,
}: {
  agent: RuntimeSubagent;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  onBack: () => void;
}) {
  const transcript = useAgentTranscript(agent, environmentId, threadId);
  const data = transcript.data;
  const live = isLive(agent);
  const visuals = STATUS_VISUALS[agent.status];
  const modelLabel = formatSubagentModelLabel(agent.model ?? data?.model ?? null, agent.effort);
  const usage = agent.usage;
  const task = data?.entries.find((entry) => entry.kind === "task");
  const steps = data?.entries.filter((entry) => entry.kind !== "task") ?? [];
  const lastText = [...steps]
    .toReversed()
    .find((entry) => entry.kind === "text" && entry.text !== undefined);
  // Full reply from the transcript; the row only carries its first line.
  const outcome = agent.error
    ? agent.error
    : !live
      ? lastText?.kind === "text" && lastText.text
        ? lastText.text
        : agent.result
      : null;
  // A settled agent's final reply moves to Result instead of repeating as a step.
  const visibleSteps =
    !live && !agent.error && outcome !== null && lastText !== undefined
      ? steps.filter((entry) => entry !== lastText)
      : steps;
  const role =
    agent.role?.trim().toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase()
      ? null
      : agent.role;

  // Focus lands on Back so Escape and Enter work without reaching for the mouse.
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => backRef.current?.focus({ preventScroll: true }), []);

  // Follow new steps while the agent runs, unless the reader scrolled away.
  const endRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const viewport = endRef.current?.closest<HTMLElement>("[data-slot=scroll-area-viewport]");
    if (!viewport) return;
    const onScroll = () => {
      following.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    if (!live || !following.current) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [live, steps.length]);

  const stats = [
    usage ? { label: "Tokens", value: formatSubagentTokenCount(usage.totalTokens) } : null,
    usage?.toolUses !== undefined ? { label: "Tools", value: String(usage.toolUses) } : null,
    data?.costUsd !== undefined
      ? {
          label: "Cost",
          value: `$${data.costUsd < 0.01 ? data.costUsd.toFixed(4) : data.costUsd.toFixed(2)}`,
        }
      : null,
    agent.activationCount > 1 ? { label: "Runs", value: String(agent.activationCount) } : null,
  ].filter((stat) => stat !== null);
  const breakdown = usage
    ? [
        usage.inputTokens !== undefined
          ? `in ${formatSubagentTokenCount(usage.inputTokens)}`
          : null,
        usage.outputTokens !== undefined
          ? `out ${formatSubagentTokenCount(usage.outputTokens)}`
          : null,
        usage.cachedInputTokens !== undefined
          ? `cache ${formatSubagentTokenCount(usage.cachedInputTokens)}`
          : null,
      ].filter((part) => part !== null)
    : [];
  const handles = agent.runHandles;
  const details = [
    data?.sessionFile ? { label: "Session file", value: data.sessionFile } : null,
    data?.command ? { label: "Command", value: data.command } : null,
    data?.cwd ? { label: "Working directory", value: data.cwd } : null,
    handles?.runId ? { label: "Run ID", value: handles.runId } : null,
    handles?.transcriptDir ? { label: "Transcript location", value: handles.transcriptDir } : null,
  ].filter((detail) => detail !== null);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onBack();
        }
      }}
    >
      <header className="border-b border-border/60 px-2 pb-2 pt-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Button
            ref={backRef}
            size="icon-xs"
            variant="ghost-muted"
            onClick={onBack}
            aria-label="Back to agents"
            className="shrink-0 cursor-pointer"
          >
            <ArrowLeft aria-hidden />
          </Button>
          <StatusDot status={agent.status} />
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{agent.title}</h2>
          <span className="shrink-0 font-mono text-2xs text-muted-foreground/80">
            <AgentElapsed agent={agent} />
          </span>
        </div>
        <p className="mt-0.5 truncate pl-8 font-mono text-2xs text-muted-foreground">
          {[role, visuals.label, modelLabel].filter(Boolean).join(" · ")}
        </p>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          {stats.length > 0 ? (
            <dl className="flex flex-wrap gap-x-5 gap-y-2">
              {stats.map((stat) => (
                <div key={stat.label}>
                  <dt className="text-3xs uppercase tracking-wider text-muted-foreground">
                    {stat.label}
                  </dt>
                  <dd className="font-mono text-sm tabular-nums">{stat.value}</dd>
                </div>
              ))}
              {breakdown.length > 0 ? (
                <div className="basis-full font-mono text-2xs tabular-nums text-muted-foreground">
                  {breakdown.join(" · ")}
                </div>
              ) : null}
            </dl>
          ) : null}

          {task?.kind === "task" ? (
            <section>
              <SectionLabel>Task</SectionLabel>
              <ClampedText text={task.text} lines={3} />
            </section>
          ) : null}

          {live ? (
            <section>
              <SectionLabel>Now</SectionLabel>
              <p className="truncate font-mono text-2xs text-info-foreground">
                {agentActivityText(agent) ?? "Working…"}
              </p>
            </section>
          ) : null}

          {visibleSteps.length > 0 ? (
            <section>
              <SectionLabel>Steps</SectionLabel>
              {data?.truncated ? (
                <p className="mb-1 text-2xs text-muted-foreground">
                  Earlier steps were trimmed to keep the transcript small.
                </p>
              ) : null}
              <ol className="flex flex-col gap-1">
                {visibleSteps.map((entry, index) => (
                  <TranscriptStep key={`${entry.at}:${index}`} entry={entry} />
                ))}
              </ol>
            </section>
          ) : agent.runHandles?.hasTranscript === true && data === null && !transcript.error ? (
            <p className="text-xs text-muted-foreground">Loading transcript…</p>
          ) : agent.recentActivity.length > 0 ? (
            <section>
              <SectionLabel>Recent activity</SectionLabel>
              <ol className="space-y-1.5 border-l border-border/60 pl-3">
                {agent.recentActivity.map((entry) => (
                  <li key={`${entry.at}:${entry.summary}`} className="min-w-0">
                    <p className="whitespace-pre-wrap break-words text-xs">{entry.summary}</p>
                  </li>
                ))}
              </ol>
            </section>
          ) : !outcome ? (
            <p className="text-xs text-muted-foreground">
              {agentActivityText(agent) ?? "No detailed activity was reported."}
            </p>
          ) : null}

          {outcome ? (
            <section>
              <SectionLabel>{agent.error ? "Error" : "Result"}</SectionLabel>
              {agent.error ? (
                <p className="whitespace-pre-wrap break-words text-xs text-destructive-foreground">
                  {outcome}
                </p>
              ) : (
                <div className="text-xs">
                  <ChatMarkdown text={outcome} cwd={undefined} />
                </div>
              )}
            </section>
          ) : null}

          {details.length > 0 || handles?.sessionUrl ? (
            <section>
              <SectionLabel>Run</SectionLabel>
              <dl className="space-y-2 text-2xs">
                {details.map((detail) => (
                  <CopyableValue key={detail.label} label={detail.label} value={detail.value} />
                ))}
                {handles?.sessionUrl ? (
                  <div>
                    <dt className="text-muted-foreground">Session</dt>
                    <dd>
                      <a
                        href={handles.sessionUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                      >
                        Open session
                        <ExternalLink aria-hidden className="size-3" />
                      </a>
                    </dd>
                  </div>
                ) : null}
              </dl>
            </section>
          ) : null}
          <div ref={endRef} />
        </div>
      </ScrollArea>
    </div>
  );
}
