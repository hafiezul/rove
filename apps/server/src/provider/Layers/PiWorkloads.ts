// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off - Shell deadlines must survive a stalled SDK.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HostProcessEnvironment } from "@rove-code/shared/hostProcess";
import {
  createBashToolDefinition,
  getShellConfig,
  type BashOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  executeProcessControl,
  makeManagedProcess,
  parseProcessBudgetTimeout,
  prepareBudgetedProcess,
} from "../../diagnostics/ProcessBudget.ts";

import type { PiWorkloadConfig } from "../../diagnostics/PiWorkloadPolicy.ts";

const StartInput = Schema.Struct({ command: Schema.String });
const ShellInput = Schema.Struct({
  command: Schema.String,
  timeout: Schema.optionalKey(Schema.Number),
});
const StopInput = Schema.Struct({ id: Schema.String });
const emptyInput = { type: "object", properties: {}, additionalProperties: false } as const;
const commandInput = {
  type: "object",
  properties: { command: { type: "string" } },
  required: ["command"],
} as const;
const idInput = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
} as const;

type Lease = { release(): Promise<void> };
type Job = {
  id: string;
  owner: string;
  unit: string;
  command: string;
  output: string;
  exitCode: number | undefined;
  done?: Promise<unknown>;
  stop(): Promise<void>;
};

/**
 * One foreground shell and one managed service per OS user, across Pi instances and servers.
 * OS-owned locks, not JS semaphores: backgrounding in a shell cannot evade the lease.
 * Foreground and service pools reserve 2/3 and 1/3 of the total, so one cannot OOM the other.
 */
export class PiWorkloads {
  private readonly lifetime = new AbortController();
  private readonly jobs = new Map<string, Job>();
  private readonly running = new Set<Promise<unknown>>();
  private readonly pool: string;
  private readonly foregroundMemory: number;
  private readonly backgroundMemory: number;
  private readonly runtimeDirectory: string;
  private readonly config: PiWorkloadConfig;

  private constructor(config: PiWorkloadConfig) {
    this.config = config;
    this.pool = config.pool ?? "rove-command-workloads.slice";
    this.backgroundMemory = Math.floor(config.memoryMiB / 3);
    this.foregroundMemory = config.memoryMiB - this.backgroundMemory;
    this.runtimeDirectory = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid!()}`;
  }

  static async create(config: PiWorkloadConfig) {
    const workloads = new PiWorkloads(config);
    // Configure the aggregate ceiling before children; each restart reconstructs the policy.
    await Effect.runPromise(
      prepareBudgetedProcess("/bin/true", [], config.memoryMiB, workloads.pool),
    );
    return workloads;
  }

  private async acquireLease(
    kind: "foreground" | "background",
    signal: AbortSignal,
  ): Promise<Lease> {
    signal.throwIfAborted();
    const lock = NodePath.join(this.runtimeDirectory, `${this.pool}.${kind}.lock`);
    const holder = NodeChildProcess.spawn(
      "flock",
      [
        "--exclusive",
        ...(kind === "background" ? ["--nonblock"] : []),
        "--close",
        lock,
        "sh",
        "-c",
        "printf 'ready\\n'; read -r release",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const exited = new Promise<void>((resolve) => {
      holder.once("exit", () => resolve());
      holder.once("error", () => resolve());
    });
    const abort = () => {
      holder.stdin.destroy();
      holder.kill("SIGTERM");
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      await new Promise<void>((resolve, reject) => {
        holder.once("error", reject);
        holder.stdout.once("data", () => resolve());
        holder.once("exit", () =>
          reject(
            new Error(
              signal.aborted
                ? "Command aborted while queued."
                : "The host's background service slot is occupied. Stop it before starting another service.",
            ),
          ),
        );
      });
      signal.throwIfAborted();
    } catch (error) {
      abort();
      await exited;
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
    let release: Promise<void> | undefined;
    return {
      release: () =>
        (release ??= (async () => {
          holder.stdin.end("release\n");
          await exited;
        })()),
    };
  }

  private async launch(
    command: string,
    cwd: string,
    kind: "foreground" | "background",
    options: Parameters<BashOperations["exec"]>[2],
    owner: string,
  ) {
    const deadline =
      kind === "foreground"
        ? parseProcessBudgetTimeout(String(Math.ceil(options.timeout ?? 600)))
        : undefined;
    const timeout = deadline === undefined ? undefined : AbortSignal.timeout(deadline * 1000);
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(options.signal ? [options.signal] : []),
      ...(timeout ? [timeout] : []),
    ]);
    if (kind === "foreground")
      options.onData(
        Buffer.from("[Rove: queued for the host's shell slot; heavy commands run sequentially.]\n"),
      );
    const lease = await this.acquireLease(kind, signal);
    let budget: ReturnType<typeof makeManagedProcess> | undefined;
    // The scope's exit, including its orphan descendants, is awaited before releasing the OS lease.
    try {
      signal.throwIfAborted();
      const shell = getShellConfig();
      budget = await Effect.runPromise(
        prepareBudgetedProcess(
          shell.shell,
          [...shell.args, command],
          kind === "foreground" ? this.foregroundMemory : this.backgroundMemory,
          this.pool.replace(/\.slice$/, `-${kind}.slice`),
          deadline,
          {
            collect: false,
            properties: [
              `BindsTo=${this.config.ownerUnit}`,
              `After=${this.config.ownerUnit}`,
              "OOMPolicy=kill",
            ],
          },
        ).pipe(Effect.provideService(HostProcessEnvironment, process.env)),
      );
      signal.throwIfAborted();
      const ownedBudget = budget;
      const child = NodeChildProcess.spawn(budget.command, budget.args, {
        cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const id = NodeCrypto.randomUUID();
      let cleanup: Promise<void> | undefined;
      const stop = () => (cleanup ??= ownedBudget.cleanup());
      const job: Job = {
        id,
        owner,
        unit: budget.unit,
        command,
        output: "",
        exitCode: undefined,
        stop,
      };
      const data = (chunk: Buffer) => {
        job.output = (job.output + chunk.toString()).slice(-16_384);
        options.onData(chunk);
      };
      child.stdout.on("data", data);
      child.stderr.on("data", data);
      const abort = () => {
        void stop().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const completed = (async () => {
        try {
          const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve, reject) => {
              child.once("error", reject);
              child.once("exit", (code, signal) => resolve({ code, signal }));
            },
          );
          const result = await executeProcessControl("systemctl", [
            "--user",
            "show",
            ownedBudget.unit,
            "--property=Result",
            "--value",
          ]).catch(() => "");
          let exitCode =
            exit.code ?? (exit.signal ? 128 + (NodeOS.constants.signals[exit.signal] ?? 1) : 1);
          if (result === "oom-kill") {
            exitCode = 137;
            data(
              Buffer.from(
                `\n[Rove: command exceeded its ${kind === "foreground" ? this.foregroundMemory : this.backgroundMemory} MiB memory budget. Pi remains connected. Reduce the workload; do not blindly retry.]\n`,
              ),
            );
          } else if (timeout?.aborted) {
            exitCode = 124;
            data(Buffer.from(`\n[Rove: command deadline ${deadline}s exceeded.]\n`));
          }
          job.exitCode = exitCode;
          return { exitCode };
        } finally {
          signal.removeEventListener("abort", abort);
          await stop();
          child.stdout.destroy();
          child.stderr.destroy();
          await lease.release();
        }
      })();
      job.done = completed;
      this.running.add(completed);
      void completed.finally(() => this.running.delete(completed)).catch(() => {});
      if (kind === "background") {
        this.jobs.set(id, job);
        // Bound completed-service history, never discard a live service's handle.
        for (const [oldId, old] of this.jobs)
          if (this.jobs.size > 32 && old.exitCode !== undefined) this.jobs.delete(oldId);
        return { id, unit: job.unit };
      }
      return await completed;
    } catch (error) {
      await budget?.cleanup();
      await lease.release();
      throw error;
    }
  }

  async exec(command: string, cwd: string, options: Parameters<BashOperations["exec"]>[2]) {
    const result = await this.launch(command, cwd, "foreground", options, "foreground");
    if (!("exitCode" in result)) throw new Error("Missing shell exit result.");
    return result;
  }

  async start(command: string, cwd: string, owner: string, signal?: AbortSignal) {
    return this.launch(
      command,
      cwd,
      "background",
      { onData: () => {}, ...(signal ? { signal } : {}) },
      owner,
    );
  }

  list(owner: string) {
    return [...this.jobs.values()]
      .filter((job) => job.owner === owner)
      .map(({ id, command, output, exitCode }) => ({ id, command, output, exitCode }));
  }

  async stop(id: string, owner: string) {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw new Error("Unknown background service for this thread.");
    await job.stop();
    await job.done;
  }

  async disposeOwner(owner: string) {
    await Promise.all(
      [...this.jobs.values()]
        .filter((job) => job.owner === owner)
        .map(async (job) => {
          await job.stop();
          await job.done;
        }),
    );
  }

  async dispose() {
    this.lifetime.abort();
    await Promise.allSettled(this.running);
  }

  tools(cwd: string, owner: string): ToolDefinition[] {
    const bash = createBashToolDefinition(cwd, { operations: { exec: this.exec.bind(this) } });
    const text = (value: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      details: {},
    });
    return [
      {
        name: bash.name,
        label: bash.label,
        parameters: bash.parameters,
        description: `${bash.description} Rove serializes shell calls across the host and isolates each command's memory. Background descendants are stopped when the command returns. Use workload_start for a dev server, not shell '&' or nohup.`,
        ...(bash.promptSnippet ? { promptSnippet: bash.promptSnippet } : {}),
        ...(bash.promptGuidelines ? { promptGuidelines: bash.promptGuidelines } : {}),
        execute: (id, input, signal, onUpdate, ctx) =>
          bash.execute(id, Schema.decodeUnknownSync(ShellInput)(input), signal, onUpdate, ctx),
      },
      {
        name: "workload_start",
        label: "Start background service",
        description:
          "Start one managed background service (e.g. a dev server), separate from the host's foreground shell queue. It has a reserved memory budget, remains owned by this thread, and stops when its session/runtime ends. Run the service in the foreground inside command; do not use '&' or nohup. Returns an id; use workload_list for output and workload_stop to stop it. Only one background service can run per OS user.",
        parameters: commandInput,
        execute: async (_id, input, signal) =>
          text(
            await this.start(
              Schema.decodeUnknownSync(StartInput)(input).command,
              cwd,
              owner,
              signal,
            ),
          ),
      },
      {
        name: "workload_list",
        label: "Background services",
        description:
          "Read this thread's managed background services, exit codes and bounded output without starting a shell or waiting for the foreground slot.",
        parameters: emptyInput,
        execute: async () => text(this.list(owner)),
      },
      {
        name: "workload_stop",
        label: "Stop background service",
        description:
          "Stop a managed background service and all of its descendants; release the host's background slot.",
        parameters: idInput,
        execute: async (_id, input) => {
          await this.stop(Schema.decodeUnknownSync(StopInput)(input).id, owner);
          return text({ stopped: true });
        },
      },
    ];
  }
}
