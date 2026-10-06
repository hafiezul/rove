import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@rove-code/contracts";

vi.mock("react-native", () => ({ View: "div", Pressable: "button" }));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "i" }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { setLimitRecovery: {}, snooze: {}, unsnooze: {} },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./ChatGptUsageLimitNotice", () => ({ ChatGptUsageLimitNotice: "aside" }));

import { UsageLimitRecoveryNotice } from "./UsageLimitRecoveryNotice";

const environmentId = EnvironmentId.make("synthetic");
const selection = { instanceId: ProviderInstanceId.make("pi"), model: "openai-codex/gpt-5.4" };
const resetAt = "2026-10-03T00:01:00.000Z";
const turnId = TurnId.make("limited");
const thread: OrchestrationThreadShell = {
  id: ThreadId.make("limited"),
  projectId: ProjectId.make("project"),
  title: "Limited",
  modelSelection: selection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  latestTurn: {
    turnId,
    state: "error",
    requestedAt: "2026-10-03T00:00:00.000Z",
    startedAt: null,
    completedAt: "2026-10-03T00:00:00.000Z",
    assistantMessageId: null,
  },
  limitRecovery: {
    requestId: CommandId.make("limit"),
    turnId,
    modelSelection: selection,
    resetAt,
    resumeAt: resetAt,
  },
};
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(() => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("expires the snooze action at reset while keeping cancellation available", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(thread.createdAt));
  await act(() => {
    renderer = create(<UsageLimitRecoveryNotice environmentId={environmentId} thread={thread} />);
  });
  expect(renderer!.root.findAllByType("button")[1]!.props.disabled).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60001);
  });
  expect(renderer!.root.findAllByType("button")[1]!.props.disabled).toBe(true);
  expect(renderer!.root.findAllByType("button")[0]!.props.disabled).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps Wake now available after reset until a later snooze expires", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(thread.createdAt));
  await act(() => {
    renderer = create(
      <UsageLimitRecoveryNotice
        environmentId={environmentId}
        thread={{ ...thread, snoozedUntil: "2026-10-03T00:02:00.000Z" }}
      />,
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60001);
  });
  expect(renderer!.root.findAllByType("button")[1]!.props.accessibilityLabel).toBe("Wake now");
  expect(renderer!.root.findAllByType("button")[1]!.props.disabled).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60001);
  });
  expect(renderer!.root.findAllByType("button")[1]!.props.accessibilityLabel).toBe(
    "Snooze until reset",
  );
  expect(renderer!.root.findAllByType("button")[1]!.props.disabled).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
