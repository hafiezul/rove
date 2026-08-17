import type { Json as SchemaJson } from "effect/Schema"; /**
 * Debug logging for the mobile terminal pipeline. Prefix: `[t3-terminal]`.
 *
 * Enabled when `__DEV__` is true, or set `globalThis.__T3_TERMINAL_DEBUG__ = true` in a JS
 * debugger / Metro console to trace release/TestFlight builds.
 */
export function isTerminalDebugEnabled(): boolean {
  // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
  return (
    (typeof __DEV__ !== "undefined" && __DEV__) ||
    (typeof globalThis !== "undefined" &&
      (globalThis as { __T3_TERMINAL_DEBUG__?: boolean }).__T3_TERMINAL_DEBUG__ === true)
  );
}

export function terminalDebugLog(message: string, data?: Record<string, SchemaJson>): void {
  if (!isTerminalDebugEnabled()) {
    return;
  }
  if (data !== undefined) {
    console.log(`[t3-terminal] ${message}`, data);
  } else {
    console.log(`[t3-terminal] ${message}`);
  }
}
