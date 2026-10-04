import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useRelativeTimeTick } from "./useRelativeTimeTick";

const store = vi.hoisted(() => ({
  subscribe: null as ((listener: () => void) => () => void) | null,
  getSnapshot: null as (() => number) | null,
}));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: (
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => number,
    ) => {
      store.subscribe = subscribe;
      store.getSnapshot = getSnapshot;
      return getSnapshot();
    },
  };
});

let page: EventTarget & { visibilityState: string };
const cleanups: Array<() => void> = [];

function subscribe(listener = vi.fn()) {
  useRelativeTimeTick();
  const cleanup = store.subscribe!(listener);
  cleanups.push(cleanup);
  return { listener, cleanup };
}

function setVisibility(visibilityState: string) {
  page.visibilityState = visibilityState;
  page.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", { setInterval, clearInterval });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("relative-time clock", () => {
  it("shares one timer and one timestamp across labels", () => {
    const first = subscribe();
    const second = subscribe();
    first.listener.mockClear();
    second.listener.mockClear();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(3_000);
    expect(first.listener).toHaveBeenCalledTimes(3);
    expect(second.listener).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot!()).toBe(Date.now());
    const snapshot = store.getSnapshot!();
    vi.setSystemTime(Date.now() + 100);
    expect(store.getSnapshot!()).toBe(snapshot);

    first.cleanup();
    vi.advanceTimersByTime(1_000);
    expect(first.listener).toHaveBeenCalledTimes(3);
    expect(second.listener).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(1);
    second.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops hidden timers and catches up immediately on return", () => {
    const { listener } = subscribe();
    listener.mockClear();
    const snapshot = store.getSnapshot!();
    setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(90_000);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot!()).toBe(snapshot);

    setVisibility("visible");
    expect(store.getSnapshot!()).toBe(Date.now());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    setVisibility("visible");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("starts hidden without a timer and resumes with a fresh snapshot", () => {
    setVisibility("hidden");
    const { listener } = subscribe();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(listener).not.toHaveBeenCalled();
    setVisibility("visible");
    expect(store.getSnapshot!()).toBe(Date.now());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("cleans up the final subscriber and survives a mount replay", () => {
    const first = subscribe();
    first.cleanup();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    setVisibility("hidden");
    setVisibility("visible");
    expect(vi.getTimerCount()).toBe(0);

    const second = subscribe();
    expect(store.getSnapshot!()).toBe(Date.now());
    expect(vi.getTimerCount()).toBe(1);
    second.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });
});
