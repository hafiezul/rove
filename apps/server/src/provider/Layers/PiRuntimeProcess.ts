// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off - Parent-owned deadlines must also terminate a blocked SDK process.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeSea from "node:sea";
import type { PiCatalogHostOptions } from "./PiCatalogHost.ts";
import {
  PiExtensionLoadError,
  type PiCreateSessionInput,
  type PiSessionEventLike,
  type PiSessionLike,
} from "./PiAdapter.ts";
import { readMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import type {
  PiRuntimeCalls,
  PiRuntimeMessage,
  PiSessionState,
  PiSessionUpdate,
} from "./PiRuntimeProtocol.ts";

/** One bundled-SDK process per instance. Never shares process.env with the server. */
export class PiRuntimeProcess {
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      preflight?: ((success: boolean) => void) | undefined;
      clearDeadline: () => void;
    }
  >();
  private readonly sessions = new Map<number, RemotePiSession>();
  private readonly listeners = new Set<() => void>();
  private nextId = 0;
  private failure: Error | undefined;
  private disposal: Promise<void> | undefined;
  private readonly exited: Promise<void>;

  private readonly child: NodeChildProcess.ChildProcess;

  private constructor(child: NodeChildProcess.ChildProcess) {
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.fail(
          new Error(
            `Pi instance process exited (${signal ?? code}). Disable and re-enable this Pi instance to continue.`,
          ),
        );
        resolve();
      });
      child.once("error", (error) => {
        this.fail(error);
        resolve();
      });
    });
    child.on("disconnect", () =>
      this.fail(
        new Error(
          "Pi instance process disconnected. Disable and re-enable this Pi instance to continue.",
        ),
      ),
    );
    // This private channel connects two copies of the same bundled protocol.
    child.on("message", (message: PiRuntimeMessage) => this.receive(message));
  }

  static async create(
    options: PiCatalogHostOptions & { agentDir: string },
    executable = NodeSea.isSea(),
  ): Promise<PiRuntimeProcess> {
    const entry = NodeURL.fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts") ? "../../pi-runtime-worker.ts" : "./pi-runtime-worker.mjs",
        import.meta.url,
      ),
    );
    const child = NodeChildProcess.spawn(
      process.execPath,
      executable ? ["__pi-runtime"] : [entry],
      {
        env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        serialization: "advanced",
        windowsHide: true,
      },
    );
    const runtime = new PiRuntimeProcess(child);
    try {
      await runtime.request("initialize", [options]);
      return runtime;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  private receive(message: PiRuntimeMessage): void {
    switch (message.type) {
      case "reply": {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        pending.clearDeadline();
        if (message.error) {
          pending.reject(
            message.error.failedExtensionPaths
              ? new PiExtensionLoadError(message.error.message, message.error.failedExtensionPaths)
              : new Error(message.error.message),
          );
        } else pending.resolve(message.result);
        break;
      }
      case "state":
        this.sessions.get(message.key)?.update(message.update);
        break;
      case "event":
        this.sessions.get(message.key)?.emit(message.event);
        break;
      case "preflight": {
        const pending = this.pending.get(message.id);
        pending?.clearDeadline();
        pending?.preflight?.(message.success);
        break;
      }
      case "catalogChanged":
        for (const listener of this.listeners) listener();
        break;
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      pending.clearDeadline();
      pending.reject(error);
    }
    this.pending.clear();
    for (const session of this.sessions.values()) session.fail(error);
    for (const listener of this.listeners) listener();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }

  request<K extends keyof PiRuntimeCalls>(
    method: K,
    args: PiRuntimeCalls[K]["args"],
    preflight?: (success: boolean) => void,
  ): Promise<PiRuntimeCalls[K]["result"]> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      // Prompts are unbounded after acceptance. Everything before that point,
      // including extension loading and model selection, remains parent-bounded.
      const timeout =
        method === "shutdown"
          ? undefined
          : method === "dispose" || method === "abort"
            ? 4_000
            : 60_000;
      const timer =
        timeout === undefined
          ? undefined
          : setTimeout(() => {
              this.fail(
                new Error(
                  `Pi instance ${method} timed out. Disable and re-enable this Pi instance to continue.`,
                ),
              );
            }, timeout);
      timer?.unref();
      this.pending.set(id, {
        // SAFETY: Each method's result is produced by the matching child handler.
        resolve: (value) => resolve(value as PiRuntimeCalls[K]["result"]),
        reject,
        preflight,
        clearDeadline: () => clearTimeout(timer),
      });
      try {
        this.child.send({ id, method, args }, (error) => {
          if (error) this.fail(error);
        });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async createSession(input: PiCreateSessionInput, textGeneration = false): Promise<PiSessionLike> {
    const key = ++this.nextId;
    const session = new RemotePiSession(this, key);
    this.sessions.set(key, session);
    try {
      await this.request("createSession", [
        key,
        input,
        textGeneration,
        input.threadId === undefined ? undefined : readMcpProviderSession(input.threadId),
      ]);
      return session;
    } catch (error) {
      this.sessions.delete(key);
      throw error;
    }
  }

  forgetSession(key: number): void {
    this.sessions.delete(key);
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  getCatalogModels(...args: PiRuntimeCalls["getCatalogModels"]["args"]) {
    return this.request("getCatalogModels", args);
  }
  getExtensionSlashCommands() {
    return this.request("getExtensionSlashCommands", []);
  }
  getCatalog() {
    return this.request("getCatalog", []);
  }
  refreshCatalog() {
    return this.request("refreshCatalog", []);
  }

  dispose(): Promise<void> {
    return (this.disposal ??= this.close());
  }
  private async close(): Promise<void> {
    this.listeners.clear();
    // Only terminate the process we spawned. A stuck extension cannot hold the server's scope open.
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 4_000);
    timer.unref();
    try {
      if (!this.failure) await this.request("shutdown", []).catch(() => {});
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
      await this.exited;
    } finally {
      clearTimeout(timer);
      this.fail(new Error("Pi instance disposed."));
      this.sessions.clear();
    }
  }
}

class RemotePiSession implements PiSessionLike {
  private state: Partial<PiSessionState> = {};
  messages: ReadonlyArray<unknown> = [];
  private entries: ReturnType<NonNullable<PiSessionLike["getEntries"]>> = [];
  private branch: ReturnType<NonNullable<PiSessionLike["getBranch"]>> = [];
  private readonly listeners = new Set<(event: PiSessionEventLike) => void>();
  private readonly startupEvents: PiSessionEventLike[] = [];
  private readonly pendingQuestions = new Set<string>();
  private disposal: Promise<void> | undefined;

  private readonly runtime: PiRuntimeProcess;
  private readonly key: number;
  constructor(runtime: PiRuntimeProcess, key: number) {
    this.runtime = runtime;
    this.key = key;
  }
  update(update: PiSessionUpdate): void {
    Object.assign(this.state, update.state);
    if (update.messages)
      this.messages = [...this.messages.slice(0, update.messages.from), ...update.messages.items];
    if (update.entries)
      this.entries = [...this.entries.slice(0, update.entries.from), ...update.entries.items];
    if (update.branch)
      this.branch = [...this.branch.slice(0, update.branch.from), ...update.branch.items];
  }
  emit(event: PiSessionEventLike): void {
    if (event.type === "rove_ui_request") this.pendingQuestions.add(String(event.requestId));
    if (event.type === "rove_ui_resolved") this.pendingQuestions.delete(String(event.requestId));
    if (this.listeners.size === 0) {
      this.startupEvents.push(event);
      if (this.startupEvents.length > 50) this.startupEvents.shift();
    } else for (const listener of this.listeners) listener(event);
  }
  fail(error: Error): void {
    this.state.isStreaming = false;
    this.state.isPreparingPrompt = false;
    this.state.hasPendingUserInput = false;
    for (const requestId of this.pendingQuestions) {
      this.emit({ type: "rove_ui_resolved", requestId, answers: {} });
    }
    this.emit({ type: "rove_ui_status", statuses: [] });
    this.emit({ type: "prompt_error", error: error.message });
  }
  get sessionId() {
    return this.state.sessionId ?? "";
  }
  get sessionFile() {
    return this.state.sessionFile;
  }
  get resumeOutcome() {
    return this.state.resumeOutcome;
  }
  get modelFallbackMessage() {
    return this.state.modelFallbackMessage;
  }
  get isStreaming() {
    return this.state.isStreaming ?? false;
  }
  get hasPendingUserInput() {
    return this.state.hasPendingUserInput ?? false;
  }
  get isPreparingPrompt() {
    return this.state.isPreparingPrompt ?? false;
  }
  get autoCompactionEnabled() {
    return this.state.autoCompactionEnabled;
  }
  getThinkingLevel() {
    return this.state.thinkingLevel ?? "off";
  }
  getModel() {
    return this.state.model;
  }
  getEntries() {
    return this.entries;
  }
  getBranch() {
    return this.branch;
  }
  getSessionStats() {
    return this.state.stats;
  }
  getLeafId() {
    return this.state.leafId;
  }
  subscribe(listener: (event: PiSessionEventLike) => void) {
    this.listeners.add(listener);
    for (const event of this.startupEvents.splice(0)) listener(event);
    return () => {
      this.listeners.delete(listener);
    };
  }
  prompt(text: string, options: Parameters<PiSessionLike["prompt"]>[1] = {}) {
    const { preflightResult, ...wireOptions } = options;
    this.state.isPreparingPrompt = true;
    return this.runtime
      .request("prompt", [this.key, text, wireOptions], preflightResult)
      .finally(() => {
        this.state.isPreparingPrompt = false;
      });
  }
  followUp(text: string) {
    return this.runtime.request("followUp", [this.key, text]);
  }
  compact() {
    return this.runtime.request("compact", [this.key]);
  }
  abort() {
    return this.runtime.request("abort", [this.key]);
  }
  setModel(model: string) {
    return this.runtime.request("setModel", [this.key, model]);
  }
  setThinkingLevel(level: string) {
    return this.runtime.request("setThinkingLevel", [this.key, level]);
  }
  respondToUserInput(...args: Parameters<NonNullable<PiSessionLike["respondToUserInput"]>>) {
    return this.runtime.request("respondToUserInput", [this.key, ...args]);
  }
  fork(entryId: string | null) {
    return this.runtime.request("fork", [this.key, entryId]);
  }
  dispose(): Promise<void> {
    return (this.disposal ??= this.runtime
      .request("dispose", [this.key])
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.runtime.forgetSession(this.key);
        this.listeners.clear();
        this.startupEvents.length = 0;
      }));
  }
}
