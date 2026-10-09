// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessUserId,
} from "@rove-code/shared/hostProcess";

const MemoryMiB = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 128, maximum: 1_048_576 }),
);

export const PROVIDER_BUDGET_POOL = "rove-provider-workloads.slice";

const decodeMemoryMiB = Schema.decodeUnknownSync(MemoryMiB);
const decodeTimeoutSeconds = Schema.decodeUnknownSync(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 86_400 })),
);

export function parseProcessBudgetTimeout(value: string) {
  return decodeTimeoutSeconds(value);
}

export function parseProcessBudgetMiB(value: string) {
  return decodeMemoryMiB(value);
}

export class ProcessBudgetError extends Schema.TaggedError<ProcessBudgetError>()(
  "ProcessBudgetError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

function execute(command: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error)
        reject(new Error(`${command} failed: ${stderr.trim() || error.message}`, { cause: error }));
      else resolve(stdout.trim());
    });
  });
}

// Serialize setup across environments, not just across instances in this server.
// Once configured, a shared pool cannot silently change an existing worker's budget.
const SETUP_POOL = `
set -eu
pool="$1"
bytes="$2"
systemctl --user start "$pool"
current=$(systemctl --user show "$pool" --property=MemoryMax --value)
if [ "$current" = infinity ]; then
  systemctl --user set-property --runtime "$pool" "MemoryMax=$bytes" MemorySwapMax=0 CPUQuota=200%
elif [ "$current" != "$bytes" ]; then
  echo "Workload pool already has a different memory budget ($current bytes). Stop guarded workloads before reconfiguring the pool." >&2
  exit 1
fi
swap=$(systemctl --user show "$pool" --property=MemorySwapMax --value)
cpu=$(systemctl --user show "$pool" --property=CPUQuotaPerSecUSec --value)
if [ "$swap" != 0 ] || [ "$cpu" != 2s ]; then
  echo "Workload pool must have MemorySwapMax=0 and CPUQuota=200%." >&2
  exit 1
fi
`;

/**
 * A Linux user-systemd scope preserves PID, stdio and inherited IPC descriptors.
 * All guarded instances share one memory/CPU budget; the server stays outside it.
 * Unsupported hosts fail closed rather than silently launching an unguarded worker.
 */
export const prepareBudgetedProcess = Effect.fn("prepareBudgetedProcess")(function* (
  command: string,
  args: ReadonlyArray<string>,
  memoryMiB: number,
  pool = PROVIDER_BUDGET_POOL,
  timeoutSeconds?: number,
) {
  const platform = yield* HostProcessPlatform;
  const uid = yield* HostProcessUserId;
  const environment = yield* HostProcessEnvironment;
  if (platform !== "linux" || uid === undefined) {
    return yield* new ProcessBudgetError({
      detail: "Process budgets require Linux with a systemd user manager.",
    });
  }
  const bytes = yield* Effect.try({
    try: () => parseProcessBudgetMiB(String(memoryMiB)) * 1024 * 1024,
    catch: (cause) => new ProcessBudgetError({ detail: "Invalid process memory budget.", cause }),
  });
  const deadline = yield* Effect.try({
    try: () =>
      timeoutSeconds === undefined
        ? []
        : [`--property=RuntimeMaxSec=${parseProcessBudgetTimeout(String(timeoutSeconds))}`],
    catch: (cause) => new ProcessBudgetError({ detail: "Invalid process deadline.", cause }),
  });
  const runtimeDirectory = environment.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  yield* Effect.tryPromise({
    try: () =>
      execute("flock", [
        "--exclusive",
        "--close",
        NodePath.join(runtimeDirectory, `${pool}.lock`),
        "sh",
        "-c",
        SETUP_POOL,
        "rove-process-budget",
        pool,
        String(bytes),
      ]),
    catch: (cause) =>
      new ProcessBudgetError({ detail: `Workload pool setup failed: ${String(cause)}`, cause }),
  });
  const unit = `rove-budget-${NodeCrypto.randomUUID()}.scope`;
  let cleanupTask: Promise<void> | undefined;
  const stopScope = async () => {
    try {
      await execute("systemctl", ["--user", "stop", unit]);
    } catch (cause) {
      // The scope can be collected before our stop reaches the manager.
      const state = await execute("systemctl", [
        "--user",
        "show",
        unit,
        "--property=ActiveState",
        "--value",
      ]);
      if (state !== "inactive") throw cause;
    }
  };
  return {
    command: "systemd-run",
    args: [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--slice=${pool}`,
      `--unit=${unit}`,
      "--property=TimeoutStopSec=5s",
      ...deadline,
      "--",
      command,
      ...args,
    ],
    unit,
    // A worker can exit while leaving background tool descendants behind.
    // Stop only our named scope, never a process selected by name or path.
    cleanup() {
      return (cleanupTask ??= stopScope());
    },
  };
});
