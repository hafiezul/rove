import type { Json as SchemaJson } from "effect/Schema";
export function isCloudDebugEnabled(): boolean {
  // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
  return (
    (typeof __DEV__ !== "undefined" && __DEV__) ||
    (typeof globalThis !== "undefined" &&
      (globalThis as { __T3_CLOUD_DEBUG__?: boolean }).__T3_CLOUD_DEBUG__ === true)
  );
}

export function cloudDebugLog(event: string, data?: Record<string, SchemaJson>): void {
  if (!isCloudDebugEnabled()) {
    return;
  }
  if (data) {
    console.log(`[t3-cloud] ${event}`, data);
  } else {
    console.log(`[t3-cloud] ${event}`);
  }
}
