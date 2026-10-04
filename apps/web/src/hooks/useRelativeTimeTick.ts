import { useSyncExternalStore } from "react";

let nowMs = Date.now();
let timerId: number | null = null;
const listeners = new Set<() => void>();

function tick() {
  const next = Date.now();
  if (next === nowMs) return;
  nowMs = next;
  for (const listener of listeners) listener();
}

function syncTimer() {
  if (timerId !== null) window.clearInterval(timerId);
  timerId = null;
  if (document.visibilityState === "hidden") return;
  tick();
  timerId = window.setInterval(tick, 1_000);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", syncTimer);
    syncTimer();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size !== 0) return;
    if (timerId !== null) window.clearInterval(timerId);
    timerId = null;
    document.removeEventListener("visibilitychange", syncTimer);
  };
}

function getSnapshot() {
  return nowMs;
}

/** Settings labels share one clock while the page is visible and any label is mounted. */
export function useRelativeTimeTick() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
