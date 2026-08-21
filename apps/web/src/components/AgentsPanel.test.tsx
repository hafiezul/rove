/**
 * The fleet rows are real controls: pointer cursor everywhere something is
 * clickable, and agent details open in the app's centered dialog rather than
 * a side sheet. Base UI portals never render under renderToStaticMarkup, so
 * the dialog/sheet primitives are stubbed with plain elements that keep their
 * data-slot markers — enough to assert which surface a component uses.
 */
import type { ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";

type OverlayProps = {
  children?: ReactNode;
  className?: string;
};

function makeSlotModule(prefix: "dialog" | "sheet") {
  const parts = [
    "Popup",
    "Header",
    "Title",
    "Description",
    "Panel",
    "Backdrop",
    "Viewport",
  ] as const;
  const Root = prefix === "dialog" ? "Dialog" : "Sheet";
  const module: Record<string, unknown> = {
    [Root]: ({ children }: OverlayProps) =>
      createElement("div", { "data-slot": `${prefix}-root` }, children),
  };
  for (const part of parts) {
    module[`${Root}${part}`] = ({
      children,
      className,
      ...rest
    }: OverlayProps & Record<string, unknown>) =>
      // The overlay primitives take layout props (side, showCloseButton) that
      // are meaningless on the stub; they are dropped, not spread.
      createElement(
        "div",
        { "data-slot": `${prefix}-${part.toLowerCase()}`, className, ...rest },
        children,
      );
  }
  return module;
}

vi.mock("~/components/ui/dialog", () => makeSlotModule("dialog"));
vi.mock("~/components/ui/sheet", () => makeSlotModule("sheet"));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: OverlayProps) =>
    createElement("div", { className }, children),
}));
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: {},
}));

import { AgentsPanel } from "./AgentsPanel";

function agent(overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return {
    id: "agent-1",
    kind: "subagent",
    title: "Explore auth flow",
    role: "explorer",
    model: "gpt-5",
    effort: "high",
    status: "completed",
    activationCount: 1,
    usage: { totalTokens: 1234 },
    progress: null,
    lastToolName: null,
    result: "Found the token refresh path",
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-08-21T00:00:00.000Z",
    startedAt: "2026-08-21T00:00:00.000Z",
    completedAt: "2026-08-21T00:01:00.000Z",
    updatedAt: "2026-08-21T00:01:00.000Z",
    ...overrides,
  };
}

function panelModel(overrides: Partial<AgentPanelModel> = {}): AgentPanelModel {
  return {
    workflows: [],
    directAgents: [],
    runningCount: 0,
    waitingCount: 0,
    idleCount: 0,
    settledCount: 0,
    totalTokens: 0,
    hasAgents: true,
    liveCount: 0,
    ...overrides,
  };
}

/** One live workflow (renders expanded) plus one settled one (collapsed). */
function renderPanel(): string {
  return renderToStaticMarkup(
    <AgentsPanel
      model={panelModel({
        workflows: [
          {
            workflow: agent({
              id: "wf-live",
              kind: "workflow",
              title: "Live run",
              status: "running",
              result: null,
            }),
            phases: [
              {
                index: 0,
                title: "Recon",
                members: [agent()],
                state: "running",
                activeCount: 1,
                settledCount: 0,
              },
            ],
            unphasedMembers: [],
          },
          {
            workflow: agent({
              id: "wf-done",
              kind: "workflow",
              title: "Old run",
              status: "completed",
              result: null,
            }),
            phases: [],
            unphasedMembers: [],
          },
        ],
        directAgents: [agent({ id: "agent-direct", title: "Solo spawn" })],
      })}
    />,
  );
}

describe("AgentsPanel clickable affordances", () => {
  it("renders agent rows as pointer-cursor buttons that announce the details action", () => {
    const html = renderPanel();
    expect(html).toContain('aria-label="Open details for Explore auth flow"');
    expect(html).toContain('aria-label="Open details for Solo spawn"');
    expect(html).toMatch(/aria-label="Open details for Explore auth flow"[^>]*cursor-pointer/);
  });

  it("keeps the expand/collapse controls pointer-cursor too", () => {
    const html = renderPanel();
    // Phase header (inside the expanded live run)…
    const expanded = html.match(/<button[^>]*aria-expanded="true"[^>]*>/);
    expect(expanded?.[0]).toContain("cursor-pointer");
    // …and collapsed workflow summary row.
    const collapsed = html.match(/<button[^>]*aria-expanded="false"[^>]*>/);
    expect(collapsed?.[0]).toContain("cursor-pointer");
  });

  it("opens agent details in the centered dialog, not a side sheet", () => {
    const html = renderPanel();
    expect(html).toContain('data-slot="dialog-popup"');
    expect(html).not.toContain("sheet-popup");
    expect(html).toContain("Explore auth flow");
  });

  it("carries the agent outcome into the details surface", () => {
    const html = renderPanel();
    expect(html).toContain("Found the token refresh path");
    expect(html).toContain("Result");
  });
});
