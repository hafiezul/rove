// @effect-diagnostics nodeBuiltinImport:off
import * as OS from "node:os";
import { executeProcessControl, parseProcessBudgetMiB } from "./ProcessBudget.ts";

export interface PiWorkloadConfig {
  readonly memoryMiB: number;
  readonly ownerUnit: string;
  /** Isolated integration tests use a separate pool. Production shares one OS-user pool. */
  readonly pool?: string;
}

/** Explicit settings fail closed. Auto only enables on small, systemd-capable Linux hosts. */
export async function resolvePiWorkloadMemory(
  mode: "auto" | "on" | "off",
  configured: string,
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
  totalMemory = OS.totalmem(),
): Promise<number | undefined> {
  const override = environment.ROVE_PI_MEMORY_BUDGET_MIB;
  if (mode === "off" && override === undefined) return undefined;
  const explicit = override !== undefined || mode === "on";
  if (!explicit && (platform !== "linux" || totalMemory > 8 * 1024 ** 3)) return undefined;
  if (platform !== "linux")
    throw new Error("Pi workload protection requires Linux with user systemd.");
  try {
    await executeProcessControl("systemctl", ["--user", "show-environment"]);
    await executeProcessControl("flock", ["--version"]);
  } catch (error) {
    if (explicit) throw error;
    return undefined;
  }
  const memory = parseProcessBudgetMiB(override ?? configured);
  if (memory < 384) throw new Error("Pi workload protection needs at least 384 MiB.");
  // Auto must leave room for the OS and control plane even on a 1–2 GiB host.
  // Explicit policies/overrides retain the user's requested limit.
  if (!explicit) {
    const available = Math.floor(totalMemory / 1024 ** 2 / 2);
    return available < 384 ? undefined : Math.min(memory, available);
  }
  return memory;
}
