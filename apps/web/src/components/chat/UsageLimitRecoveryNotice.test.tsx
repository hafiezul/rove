import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { CommandId, EnvironmentId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { useUsageLimitRecoveryBannerItem } from "./UsageLimitRecoveryNotice";

const selection = { instanceId: ProviderInstanceId.make("pi"), model: "openai-codex/gpt-5.4" };
const turnId = TurnId.make("limited");
const thread = {
  id: ThreadId.make("limited"),
  modelSelection: selection,
  archivedAt: null,
  settledOverride: null,
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
