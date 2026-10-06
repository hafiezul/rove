import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { LazyPiRuntime, type LazyPiRuntimeTarget } from "./PiRuntimeProcess.ts";

class FakeRuntime implements LazyPiRuntimeTarget {
  busy = 0;
  disposed = false;
  private readonly idleListeners = new Set<() => void>();
  get isIdle() {
    return !this.disposed && this.busy === 0;
  }
  onIdle(listener: () => void) {
    this.idleListeners.add(listener);
    return () => this.idleListeners.delete(listener);
  }
  onChange() {
    return () => {};
  }
  dispose() {
    this.disposed = true;
    return Promise.resolve();
  }
  start() {
    this.busy++;
  }
  finish() {
    this.busy--;
    if (this.isIdle) for (const listener of this.idleListeners) listener();
  }
}

const IDLE_MS = 60_000;

describe("LazyPiRuntime", () => {
  let created: FakeRuntime[];
  let lazy: LazyPiRuntime<FakeRuntime>;
  beforeEach(() => {
    vi.useFakeTimers();
    created = [];
    lazy = new LazyPiRuntime(async () => {
      const runtime = new FakeRuntime();
      created.push(runtime);
      return runtime;
    }, IDLE_MS);
  });
  afterEach(async () => {
    await lazy.dispose();
    vi.useRealTimers();
  });

  it("stops an idle runtime and starts a fresh one on the next use", async () => {
    const first = await lazy.get();
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(first.disposed).toBe(true);
    expect(lazy.isRunning).toBe(false);

    const second = await lazy.get();
    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
  });

  it("keeps a busy runtime and stops it a full idle window after the work ends", async () => {
    const runtime = await lazy.get();
    runtime.start();
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(runtime.disposed).toBe(false);

    runtime.finish();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(runtime.disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.disposed).toBe(true);
  });

  it("postpones the stop when the runtime is used again during the idle window", async () => {
    const runtime = await lazy.get();
    await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
    expect(await lazy.get()).toBe(runtime);
    await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
    expect(runtime.disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
    expect(runtime.disposed).toBe(true);
    expect(created).toHaveLength(1);
  });

  it("retries startup after a failed start", async () => {
    let attempts = 0;
    const flaky = new LazyPiRuntime(async () => {
      attempts++;
      if (attempts === 1) throw new Error("extension failed to load");
      return new FakeRuntime();
    }, IDLE_MS);
    await expect(flaky.get()).rejects.toThrow("extension failed to load");
    await expect(flaky.get()).resolves.toBeInstanceOf(FakeRuntime);
    await flaky.dispose();
  });
});
