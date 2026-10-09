#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import {
  parseProcessBudgetMiB,
  parseProcessBudgetTimeout,
  prepareBudgetedProcess,
} from "../src/diagnostics/ProcessBudget.ts";

async function main() {
  const separator = process.argv.indexOf("--", 2);
  if (separator === -1 || !process.argv[separator + 1]) {
    throw new Error(
      "Usage: node apps/server/scripts/guarded-run.ts [--memory-mib 2048] [--timeout-seconds 120] -- <command> [args...]",
    );
  }
  const { values } = NodeUtil.parseArgs({
    args: process.argv.slice(2, separator),
    options: {
      "memory-mib": { type: "string", default: "2048" },
      "timeout-seconds": { type: "string", default: "120" },
    },
  });
  const memoryMiB = parseProcessBudgetMiB(values["memory-mib"] ?? "2048");
  const timeoutSeconds = parseProcessBudgetTimeout(values["timeout-seconds"] ?? "120");
  const [command, ...args] = process.argv.slice(separator + 1);
  if (!command) throw new Error("A command is required.");
  const budget = await Effect.runPromise(
    prepareBudgetedProcess(command, args, memoryMiB, undefined, timeoutSeconds),
  );
  const child = NodeChildProcess.spawn(budget.command, budget.args, { stdio: "inherit" });
  let cancellationCode: number | undefined;
  const cancel = (signal: "SIGINT" | "SIGTERM", code: number) => {
    cancellationCode ??= code;
    child.kill(signal);
    void budget.cleanup().catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  const interrupt = () => cancel("SIGINT", 130);
  const terminate = () => cancel("SIGTERM", 143);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        resolve(code ?? (signal ? 128 + (NodeOS.constants.signals[signal] ?? 1) : 1)),
      );
    });
    if (code !== 0) {
      process.stderr.write(
        `Guarded command exited with ${code}. Workloads share ${memoryMiB} MiB RAM, no swap, and two CPU cores; command deadline ${timeoutSeconds}s. Check for a deadline or contained OOM before retrying.\n`,
      );
    }
    process.exitCode = cancellationCode ?? code;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    await budget.cleanup();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
