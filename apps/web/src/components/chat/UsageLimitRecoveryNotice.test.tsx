import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@rove-code/contracts";
import { useUsageLimitRecoveryBannerItem } from "./UsageLimitRecoveryNotice";

vi.mock("../ui/button", () => ({ Button: "button" }));

const selection = { instanceId: ProviderInstanceId.make("pi"), model: "openai-codex/gpt-5.4" };
const turnId = TurnId.make("limited");
const thread = {
  id: ThreadId.make("limited"),
  modelSelection: selection,
  archivedAt: null,
  settledOverride: null,
  snoozedUntil: null,
  snoozedAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  latestUserMessageAt: null,
  session: null,
  latestTurn: {
    turnId,
    state: "error" as const,
    requestedAt: "2026-10-03T00:00:00.000Z",
    startedAt: null,
    completedAt: "2026-10-03T00:00:00.000Z",
    assistantMessageId: null,
  },
  limitRecovery: {
    requestId: CommandId.make("limit"),
    turnId,
    modelSelection: selection,
    resetAt: "2026-10-03T00:01:00.000Z",
    resumeAt: null,
  },
};
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(() => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("expires an unscheduled known-time notice without needing a server event", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-03T00:00:00.000Z"));
  function Notice() {
    const item = useUsageLimitRecoveryBannerItem(EnvironmentId.make("synthetic"), thread);
    return <span>{item?.title ?? "Normal usage-limit error"}</span>;
  }
  await act(() => {
    renderer = create(<Notice />);
  });
  expect(renderer!.root.findByType("span").children).toEqual(["Usage limit reached"]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60001);
  });
  expect(renderer!.root.findByType("span").children).toEqual(["Normal usage-limit error"]);
});

it("updates a scheduled notice when a later snooze expires without a server event", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-03T00:00:00.000Z"));
  let currentThread = {
    ...thread,
    snoozedUntil: null as string | null,
    limitRecovery: { ...thread.limitRecovery, resumeAt: thread.limitRecovery.resetAt },
  };
  function Notice() {
    const item = useUsageLimitRecoveryBannerItem(EnvironmentId.make("synthetic"), currentThread);
    return (
      <>
        <span>{item?.description}</span>
        {item?.actions}
      </>
    );
  }
  await act(() => {
    renderer = create(<Notice />);
  });
  const originalDescription = renderer!.root.findByType("span").children;
  await act(() => {
    currentThread = { ...currentThread, snoozedUntil: "2026-10-03T00:02:00.000Z" };
    renderer!.update(<Notice />);
  });
  expect(renderer!.root.findByType("span").children).not.toEqual(originalDescription);
  expect(renderer!.root.findAllByType("button")[1]!.children).toEqual(["Wake now"]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120001);
  });
  expect(renderer!.root.findAllByType("button")[1]!.children).toEqual(["Snooze until reset"]);
  expect(renderer!.root.findAllByType("button")[1]!.props.disabled).toBe(true);
  expect(renderer!.root.findAllByType("button")[0]!.children).toEqual(["Cancel"]);
  expect(vi.getTimerCount()).toBe(0);
});

it("waking a scheduled thread restores its reset-time notice without cancelling recovery", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-03T00:00:00.000Z"));
  let currentThread = {
    ...thread,
    snoozedUntil: null as string | null,
    limitRecovery: { ...thread.limitRecovery, resumeAt: thread.limitRecovery.resetAt },
  };
  function Notice() {
    const item = useUsageLimitRecoveryBannerItem(EnvironmentId.make("synthetic"), currentThread);
    return (
      <span>
        {item?.title}
        {item?.description}
      </span>
    );
  }
  await act(() => {
    renderer = create(<Notice />);
  });
  const originalNotice = renderer!.root.findByType("span").children;
  await act(() => {
    currentThread = { ...currentThread, snoozedUntil: "2026-10-03T00:02:00.000Z" };
    renderer!.update(<Notice />);
  });
  expect(renderer!.root.findByType("span").children).not.toEqual(originalNotice);
  await act(() => {
    currentThread = { ...currentThread, snoozedUntil: null };
    renderer!.update(<Notice />);
  });
  expect(renderer!.root.findByType("span").children).toEqual(originalNotice);
});
