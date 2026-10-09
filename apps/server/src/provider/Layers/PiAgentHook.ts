// @effect-diagnostics nodeBuiltinImport:off - Serialized into plain Node processes outside the Effect runtime.
// @effect-diagnostics globalTimers:off globalDate:off
/**
 * Rove's agent hook: the extension-agnostic half of subagent observability.
 *
 * Pi has no subagent API. Every subagent extension instead starts another
 * agent somewhere: a Pi CLI child, a detached runner that starts one later, an
 * agent CLI such as `claude`, or an agent in the same process. This hook is
 * loaded into the Pi runtime worker and, through `NODE_OPTIONS=--require`,
 * into every Node process started while a tool runs. It:
 *
 * - tags each process started during a tool call with that call's identity
 *   (`ROVE_AGENT_PARENT`), so descendants stay attributed after the call ends;
 * - adds itself as an extension (`-e <hook>`) to any Pi CLI it sees start, so
 *   the child reports its own model, prompt, tools, text, and usage;
 * - reports agent CLIs it sees start, reading their JSON output when present.
 *
 * Every report is one transcript entry. The writer appends it synchronously to
 * `<ROVE_AGENT_TRANSCRIPTS>/<threadId>/<agentId>.jsonl`, so the transcript
 * survives a crash or a lost channel, then sends it to the worker over
 * `ROVE_AGENT_CHANNEL` for live status. The worker turns entries into Agents
 * rows (see PiAgentObserver.ts).
 *
 * `roveAgentHook` is serialized with `Function.prototype.toString` into a
 * standalone CommonJS file, so it must not reference anything outside its own
 * body. See docs/adr/0002-pi-subagent-observation.md.
 *
 * @module provider/Layers/PiAgentHook
 */

/** Transcript entry kinds shared by the hook writers and the worker reader. */
export type PiAgentEntryKind =
  | "start"
  | "meta"
  | "task"
  | "user"
  | "text"
  | "tool"
  | "toolEnd"
  | "usage"
  | "busy"
  | "idle"
  | "exit";

export interface PiAgentParent {
  /** Rove thread id. */
  readonly th: string;
  /** Tool call that started the agent, when known. */
  readonly t?: string | undefined;
  /** Name of that tool. */
  readonly n?: string | undefined;
  /** Observed agent that started this one (nested agents). */
  readonly p?: string | undefined;
}

export interface PiAgentEntry {
  readonly v: 1;
  /** Agent id; also the Agents row's task id. */
  readonly a: string;
  /** Thread id. */
  readonly th: string;
  /** Writer pid and per-writer sequence, used to deduplicate replays. */
  readonly w: number;
  readonly q: number;
  readonly at: number;
  readonly k: PiAgentEntryKind;
  /** start: how the agent was found. */
  readonly src?: "pi" | "agent" | "cli" | "model";
  readonly parent?: PiAgentParent;
  readonly pid?: number;
  readonly cwd?: string;
  readonly cmd?: string;
  readonly label?: string;
  /** meta */
  readonly model?: string;
  readonly thinking?: string;
  readonly session?: string;
  readonly name?: string;
  /** task/user/text */
  readonly text?: string;
  /** text: assistant stop reason. */
  readonly stop?: string;
  readonly error?: string;
  /** tool/toolEnd */
  readonly id?: string;
  readonly target?: string;
  readonly isError?: boolean;
  readonly out?: string;
  /** usage: per message unless `cum` marks a cumulative report. */
  readonly in?: number;
  readonly outTok?: number;
  readonly cr?: number;
  readonly cw?: number;
  readonly cost?: number;
  readonly cum?: boolean;
  /** exit */
  readonly code?: number | null;
  readonly signal?: string | null;
  /** Entry text was cut to stay inside the transcript size cap. */
  readonly trunc?: boolean;
}

/** What the worker reads from `globalThis[Symbol.for("rove.agentHook.v1")]`. */
export interface PiAgentHookApi {
  readonly hookPath: string;
  run<T>(store: PiAgentStore, fn: () => T): T;
  store(): PiAgentStore | undefined;
  setSink(sink: (entry: PiAgentEntry) => void): void;
  emit(
    agentId: string,
    threadId: string,
    kind: PiAgentEntryKind,
    fields?: Partial<PiAgentEntry>,
  ): void;
  newId(): string;
  toolTarget(args: unknown): string | undefined;
  messageText(message: unknown): string;
}

/** Async context for work running on behalf of a thread. */
export interface PiAgentStore {
  readonly th: string;
  /** "loop" while an agent streams; "tool" while one of its tools runs. */
  readonly phase: "loop" | "tool";
  readonly t?: string | undefined;
  readonly n?: string | undefined;
  /** Observed agent that owns this context (in-process agents). */
  readonly p?: string | undefined;
}

export const PI_AGENT_HOOK_GLOBAL = "rove.agentHook.v1";
export const PI_AGENT_ENV = {
  channel: "ROVE_AGENT_CHANNEL",
  transcripts: "ROVE_AGENT_TRANSCRIPTS",
  hook: "ROVE_AGENT_HOOK",
  parent: "ROVE_AGENT_PARENT",
  id: "ROVE_AGENT_ID",
} as const;

/**
 * The hook body. Runs once per process; later loads (for example Pi loading it
 * as an `-e` extension after `NODE_OPTIONS` already required it) reuse the
 * installed instance.
 */
export function roveAgentHook(
  hookModule: { exports: unknown },
  load: (id: string) => unknown,
  hookPath: string,
): void {
  type AnyRecord = Record<string, any>;
  const globalKey = Symbol.for("rove.agentHook.v1");
  const shared = globalThis as unknown as Record<PropertyKey, any>;
  if (shared[globalKey]) {
    // A later load (Pi's `-e`, or the single executable after rewriting argv) may
    // see this process's real entry point for the first time.
    shared[globalKey].adoptPiProcess?.();
    hookModule.exports = shared[globalKey].extension;
    return;
  }

  const childProcess = load("node:child_process") as AnyRecord;
  const asyncHooks = load("node:async_hooks") as typeof import("node:async_hooks");
  const fs = load("node:fs") as typeof import("node:fs");
  const path = load("node:path") as typeof import("node:path");
  const crypto = load("node:crypto") as typeof import("node:crypto");
  const net = load("node:net") as typeof import("node:net");
  const nodeModule = load("node:module") as { syncBuiltinESMExports?: () => void };

  const env = process.env;
  const channel = env.ROVE_AGENT_CHANNEL;
  const transcriptsRoot = env.ROVE_AGENT_TRANSCRIPTS;
  const assignedId = env.ROVE_AGENT_ID;
  // Descendants of an observed agent must mint their own ids.
  delete env.ROVE_AGENT_ID;
  const parseParent = (raw: string | undefined): PiAgentParent | undefined => {
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as AnyRecord;
      return typeof value?.th === "string" && value.th.length > 0
        ? {
            th: value.th,
            ...(typeof value.t === "string" ? { t: value.t } : {}),
            ...(typeof value.n === "string" ? { n: value.n } : {}),
            ...(typeof value.p === "string" ? { p: value.p } : {}),
          }
        : undefined;
    } catch {
      return undefined;
    }
  };
  const inheritedParent = parseParent(env.ROVE_AGENT_PARENT);
  const storage = new asyncHooks.AsyncLocalStorage<PiAgentStore>();
  let sink: ((entry: PiAgentEntry) => void) | undefined;
  let selfAgent: { id: string; parent: PiAgentParent } | undefined;
  let sequence = 0;

  const TEXT_LIMIT = 16_384;
  const OUTPUT_LIMIT = 4_096;
  const TRANSCRIPT_SOFT_CAP = 8 * 1024 * 1024;
  const TRANSCRIPT_HARD_CAP = 16 * 1024 * 1024;
  const AGENT_CLIS = new Set([
    "claude",
    "codex",
    "cursor-agent",
    "gemini",
    "opencode",
    "qwen",
    "amp",
    "droid",
    "goose",
    "aider",
    "crush",
    "kimi",
    "grok",
    "copilot",
    "kiro-cli",
    "auggie",
  ]);
  const PI_SUBCOMMANDS = new Set([
    "install",
    "remove",
    "uninstall",
    "update",
    "list",
    "config",
    "login",
    "logout",
  ]);

  const bounded = (value: string, limit: number) =>
    value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
  const safeSegment = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  const newId = () => crypto.randomUUID();

  // --- transcript + channel ---------------------------------------------------
  const transcriptBytes = new Map<string, number>();
  const madeDirs = new Set<string>();
  const writeTranscript = (entry: PiAgentEntry): PiAgentEntry => {
    if (!transcriptsRoot) return entry;
    try {
      const dir = path.join(transcriptsRoot, safeSegment(entry.th));
      if (!madeDirs.has(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        madeDirs.add(dir);
      }
      const file = path.join(dir, `${safeSegment(entry.a)}.jsonl`);
      let size = transcriptBytes.get(file);
      if (size === undefined) {
        try {
          size = fs.statSync(file).size;
        } catch {
          size = 0;
        }
      }
      let written: PiAgentEntry = entry;
      if (size > TRANSCRIPT_HARD_CAP && entry.k !== "exit") return entry;
      if (size > TRANSCRIPT_SOFT_CAP && (entry.text !== undefined || entry.out !== undefined)) {
        const { text: _text, out: _out, ...rest } = entry;
        written = { ...rest, trunc: true };
      }
      const line = `${JSON.stringify(written)}\n`;
      fs.appendFileSync(file, line);
      transcriptBytes.set(file, size + Buffer.byteLength(line));
      return written;
    } catch {
      return entry;
    }
  };

  let socket: import("node:net").Socket | undefined;
  let socketReady = false;
  let socketFailed = false;
  const pending: string[] = [];
  const sendToChannel = (entry: PiAgentEntry) => {
    if (!channel || socketFailed) return;
    const line = `${JSON.stringify(entry)}\n`;
    if (socketReady && socket) {
      socket.write(line);
      return;
    }
    if (pending.length < 2_000) pending.push(line);
    if (socket) return;
    try {
      socket = net.createConnection(channel);
      socket.unref();
      socket.on("connect", () => {
        socketReady = true;
        for (const queued of pending.splice(0)) socket?.write(queued);
      });
      socket.on("error", () => {
        socketFailed = true;
        pending.length = 0;
      });
    } catch {
      socketFailed = true;
    }
  };

  const emit = (
    agentId: string,
    threadId: string,
    kind: PiAgentEntryKind,
    fields: Partial<PiAgentEntry> = {},
  ) => {
    const entry: PiAgentEntry = {
      ...fields,
      v: 1,
      a: agentId,
      th: threadId,
      w: process.pid,
      q: ++sequence,
      at: Date.now(),
      k: kind,
    };
    const written = writeTranscript(entry);
    try {
      if (sink) sink(written);
      else sendToChannel(written);
    } catch {
      // Observability must never break the observed process.
    }
  };

  // --- shared helpers -----------------------------------------------------------
  const TARGET_KEYS = [
    "path",
    "file_path",
    "filePath",
    "file",
    "command",
    "cmd",
    "pattern",
    "query",
    "url",
    "task",
    "prompt",
    "description",
    "name",
  ];
  const toolTarget = (args: unknown): string | undefined => {
    if (typeof args === "string") return bounded(args.trim(), 160) || undefined;
    if (!args || typeof args !== "object") return undefined;
    const record = args as AnyRecord;
    for (const key of TARGET_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0)
        return bounded(value.trim().split("\n")[0] ?? "", 160);
    }
    return undefined;
  };
  const messageText = (message: unknown): string => {
    const content = (message as AnyRecord | undefined)?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part: AnyRecord) =>
        part?.type === "text" && typeof part.text === "string" ? part.text : "",
      )
      .filter((text: string) => text.length > 0)
      .join("\n");
  };
  const usageFields = (usage: unknown): Partial<PiAgentEntry> | undefined => {
    if (!usage || typeof usage !== "object") return undefined;
    const record = usage as AnyRecord;
    const num = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    const input = num(record.input) ?? num(record.input_tokens) ?? num(record.inputTokens);
    const output = num(record.output) ?? num(record.output_tokens) ?? num(record.outputTokens);
    const cacheRead =
      num(record.cacheRead) ??
      num(record.cache_read_input_tokens) ??
      num(record.cached_input_tokens) ??
      num(record.cachedInputTokens);
    const cacheWrite = num(record.cacheWrite) ?? num(record.cache_creation_input_tokens);
    const costValue = record.cost;
    const cost =
      num(costValue) ?? num(costValue?.total) ?? num(record.total_cost_usd) ?? num(record.costUsd);
    if (input === undefined && output === undefined) return undefined;
    return {
      ...(input !== undefined ? { in: input } : {}),
      ...(output !== undefined ? { outTok: output } : {}),
      ...(cacheRead !== undefined ? { cr: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cw: cacheWrite } : {}),
      ...(cost !== undefined ? { cost } : {}),
    };
  };
  const toolResultText = (result: unknown): string | undefined => {
    if (result === undefined || result === null) return undefined;
    const text = typeof result === "string" ? result : messageText(result);
    return text.length > 0 ? bounded(text, OUTPUT_LIMIT) : undefined;
  };

  // --- Pi CLI detection ---------------------------------------------------------
  const piCliCache = new Map<string, boolean>();
  const isPiCli = (candidate: unknown): boolean => {
    if (typeof candidate !== "string" || candidate.length === 0) return false;
    const cached = piCliCache.get(candidate);
    if (cached !== undefined) return cached;
    let result = false;
    try {
      if (env.ROVE_PI_CLI_ENTRY && candidate === env.ROVE_PI_CLI_ENTRY) result = true;
      else {
        let dir = path.dirname(fs.realpathSync(candidate));
        for (let depth = 0; depth < 4 && !result; depth++) {
          try {
            const manifest = JSON.parse(
              fs.readFileSync(path.join(dir, "package.json"), "utf8"),
            ) as AnyRecord;
            if (typeof manifest.name === "string") {
              result = /(^|\/)pi-coding-agent$/.test(manifest.name);
              break;
            }
          } catch {
            // Keep walking up.
          }
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      }
    } catch {
      result = false;
    }
    piCliCache.set(candidate, result);
    return result;
  };
  const commandName = (command: unknown) =>
    typeof command === "string"
      ? path
          .basename(command)
          .toLowerCase()
          .replace(/\.(exe|cmd|bat|ps1)$/, "")
      : "";
  const isNodeLike = (command: unknown) => {
    if (typeof command !== "string") return false;
    if (command === process.execPath) return true;
    return /^(node|nodejs|electron|bun)$/.test(commandName(command));
  };
  /** Agent CLI named at the start of any segment of a shell command line. */
  const shellAgentCli = (line: string): string | undefined => {
    for (const segment of line.split(/&&|\|\||[;|&\n]/)) {
      const tokens = segment.trim().split(/\s+/);
      let index = 0;
      while (
        index < tokens.length &&
        (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "") ||
          ["exec", "env", "command", "nohup", "time", "npx", "bunx", "pnpx"].includes(
            tokens[index] ?? "",
          ))
      )
        index++;
      const name = commandName((tokens[index] ?? "").replace(/^['"]|['"]$/g, ""));
      if (AGENT_CLIS.has(name) || name === "pi") return name;
    }
    return undefined;
  };

  // --- attribution --------------------------------------------------------------
  const currentParent = (): PiAgentParent | undefined => {
    const store = storage.getStore();
    if (store) return { th: store.th, t: store.t, n: store.n, p: store.p };
    if (selfAgent) return { th: selfAgent.parent.th, p: selfAgent.id };
    return inheritedParent;
  };
  const nodeOptionsWithHook = (existing: string | undefined) => {
    if (existing?.includes(hookPath)) return existing;
    try {
      fs.accessSync(hookPath);
    } catch {
      // A missing hook file must never stop Node from starting.
      return existing;
    }
    const flag = `--require ${JSON.stringify(hookPath)}`;
    return existing && existing.trim().length > 0 ? `${existing} ${flag}` : flag;
  };
  const childEnv = (
    base: AnyRecord | undefined,
    parent: PiAgentParent,
    agentId: string | undefined,
  ) => {
    const next: AnyRecord = { ...(base ?? env) };
    delete next.ROVE_AGENT_ID;
    if (channel) next.ROVE_AGENT_CHANNEL = channel;
    if (transcriptsRoot) next.ROVE_AGENT_TRANSCRIPTS = transcriptsRoot;
    next.ROVE_AGENT_HOOK = hookPath;
    if (env.ROVE_PI_CLI_ENTRY) next.ROVE_PI_CLI_ENTRY = env.ROVE_PI_CLI_ENTRY;
    next.ROVE_AGENT_PARENT = JSON.stringify(parent);
    if (agentId) next.ROVE_AGENT_ID = agentId;
    const nodeOptions = nodeOptionsWithHook(next.NODE_OPTIONS);
    if (nodeOptions) next.NODE_OPTIONS = nodeOptions;
    return next;
  };

  // --- agent CLI output ---------------------------------------------------------
  /** Tolerant reader for JSON-lines agent output; plain text keeps the last line. */
  const watchCliOutput = (agentId: string, threadId: string, child: AnyRecord) => {
    const stream = child?.stdout;
    if (!stream || typeof stream.push !== "function") return { lastLine: () => undefined };
    let buffer = "";
    let lastLine: string | undefined;
    let sawJson = false;
    const visit = (value: unknown, depth: number) => {
      if (!value || typeof value !== "object" || depth > 6) return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
        return;
      }
      const record = value as AnyRecord;
      const type = typeof record.type === "string" ? record.type : "";
      if (/tool_use|tool_call|function_call/.test(type) && typeof record.name === "string") {
        const target = toolTarget(record.input ?? record.arguments);
        emit(agentId, threadId, "tool", {
          id: typeof record.id === "string" ? record.id : newId(),
          name: record.name,
          ...(target ? { target } : {}),
        });
      } else if (/tool_result/.test(type) && typeof record.tool_use_id === "string") {
        const out = toolResultText(record.content);
        emit(agentId, threadId, "toolEnd", {
          id: record.tool_use_id,
          ...(record.is_error === true ? { isError: true } : {}),
          ...(out ? { out } : {}),
        });
      } else if (/command_execution/.test(type) && typeof record.command === "string") {
        emit(agentId, threadId, "tool", {
          id: typeof record.id === "string" ? record.id : newId(),
          name: "command",
          target: bounded(record.command, 160),
        });
      } else if (type === "result" && typeof record.result === "string") {
        emit(agentId, threadId, "text", { text: bounded(record.result, TEXT_LIMIT) });
      } else if (
        (type === "text" || /agent_message|assistant_message/.test(type)) &&
        typeof record.text === "string" &&
        record.text.trim().length > 0
      ) {
        emit(agentId, threadId, "text", { text: bounded(record.text, TEXT_LIMIT) });
      }
      const usage = usageFields(record.usage);
      if (usage && depth <= 2) emit(agentId, threadId, "usage", { ...usage, cum: true });
      for (const [key, nested] of Object.entries(record)) {
        if (key === "usage" || typeof nested !== "object") continue;
        visit(nested, depth + 1);
      }
    };
    const originalPush = stream.push;
    stream.push = function (this: unknown, chunk: unknown, ...rest: unknown[]) {
      try {
        if (chunk !== null && chunk !== undefined) {
          buffer += typeof chunk === "string" ? chunk : String(chunk);
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line.length > 0) {
              if (line.startsWith("{")) {
                try {
                  visit(JSON.parse(line), 0);
                  sawJson = true;
                } catch {
                  lastLine = line;
                }
              } else lastLine = line;
            }
            newline = buffer.indexOf("\n");
          }
          if (buffer.length > 1_000_000) buffer = buffer.slice(-100_000);
        }
      } catch {
        // Never interfere with the consumer.
      }
      return originalPush.call(this, chunk, ...rest);
    };
    return {
      lastLine: () => (sawJson ? undefined : (lastLine ?? (buffer.trim() || undefined))),
    };
  };

  // --- child_process interception ----------------------------------------------
  const wrappedMarker = Symbol.for("rove.agentHook.wrapped");
  const SHELL_ONLY = new Set(["exec", "execSync"]);
  const SYNC = new Set(["spawnSync", "execFileSync", "execSync"]);
  const prepare = (method: string, argv: unknown[], parent: PiAgentParent) => {
    const next = argv.slice();
    const shellOnly = SHELL_ONLY.has(method);
    const command = next[0];
    let args: unknown[] | undefined;
    let optionsIndex: number;
    if (shellOnly) {
      optionsIndex = 1;
    } else if (Array.isArray(next[1])) {
      args = (next[1] as unknown[]).slice();
      next[1] = args;
      optionsIndex = 2;
    } else if ((next[1] === undefined || next[1] === null) && next.length > 2) {
      // `spawn(command, undefined, options)`: keep the args slot.
      optionsIndex = 2;
    } else {
      optionsIndex = 1;
    }
    const rawOptions = next[optionsIndex];
    const hasOptions =
      rawOptions !== null && typeof rawOptions === "object" && !Array.isArray(rawOptions);
    const options: AnyRecord = hasOptions ? { ...(rawOptions as AnyRecord) } : {};
    const shellLine =
      shellOnly && typeof command === "string"
        ? command
        : options.shell && typeof command === "string"
          ? [command, ...(args ?? [])].join(" ")
          : undefined;

    // Pi CLI started directly: add the hook as an extension and own its id.
    let piAgentId: string | undefined;
    const nonFlagIndex = args ? args.findIndex((arg) => !String(arg).startsWith("-")) : -1;
    const piEntryIndex =
      method === "fork"
        ? isPiCli(command)
          ? -1
          : -2
        : isNodeLike(command) && args && nonFlagIndex >= 0 && isPiCli(args[nonFlagIndex])
          ? nonFlagIndex
          : commandName(command) === "pi" && !shellLine
            ? -1
            : -2;
    if (piEntryIndex !== -2 && !PI_SUBCOMMANDS.has(String(args?.[piEntryIndex + 1] ?? ""))) {
      piAgentId = newId();
      if (!args) {
        args = [];
        if (optionsIndex === 2) next[1] = args;
        else {
          next.splice(1, 0, args);
          optionsIndex = 2;
        }
      }
      if (!args.includes(hookPath)) args.splice(piEntryIndex + 1, 0, "-e", hookPath);
    }

    // Other agent CLIs are reported by the spawner, from the outside.
    let cliName: string | undefined;
    if (!piAgentId) {
      const direct = commandName(command);
      cliName = AGENT_CLIS.has(direct) ? direct : shellLine ? shellAgentCli(shellLine) : undefined;
      if (cliName === "pi") cliName = undefined;
    }
    const cliAgentId = cliName ? newId() : undefined;

    options.env = childEnv(options.env, parent, piAgentId);
    const slot = next[optionsIndex];
    if (hasOptions || ((slot === undefined || slot === null) && optionsIndex < next.length))
      next[optionsIndex] = options;
    // Insert before a trailing callback (execFile/exec) or at the end.
    else next.splice(optionsIndex, 0, options);

    const commandLine = bounded(
      shellLine ??
        [typeof command === "string" ? path.basename(command) : String(command), ...(args ?? [])]
          .map((part) => String(part))
          .join(" "),
      400,
    );
    const cwd = typeof options.cwd === "string" ? options.cwd : process.cwd();
    const after = (child: AnyRecord) => {
      if (cliAgentId && cliName) {
        emit(cliAgentId, parent.th, "start", {
          src: "cli",
          parent,
          label: cliName,
          cmd: commandLine,
          cwd,
          ...(typeof child?.pid === "number" ? { pid: child.pid } : {}),
        });
      }
      const agentId = piAgentId ?? cliAgentId;
      if (!agentId) return;
      if (SYNC.has(method)) {
        const status = child as AnyRecord | Buffer | string;
        const code = status && typeof status === "object" && "status" in status ? status.status : 0;
        emit(agentId, parent.th, "exit", { code: typeof code === "number" ? code : null });
        return;
      }
      const output = cliAgentId ? watchCliOutput(cliAgentId, parent.th, child) : undefined;
      child?.once?.("exit", (code: number | null, signal: string | null) => {
        const last = output?.lastLine();
        if (cliAgentId && last)
          emit(cliAgentId, parent.th, "text", { text: bounded(last, TEXT_LIMIT) });
        emit(agentId, parent.th, "exit", { code, signal });
      });
      child?.once?.("error", (error: Error) => {
        emit(agentId, parent.th, "exit", {
          code: null,
          error: bounded(String(error?.message ?? error), 500),
        });
      });
    };
    return { argv: next, after };
  };

  for (const method of [
    "spawn",
    "fork",
    "execFile",
    "exec",
    "spawnSync",
    "execFileSync",
    "execSync",
  ]) {
    const original = childProcess[method];
    if (typeof original !== "function" || original[wrappedMarker]) continue;
    const wrapped = function (this: unknown, ...argv: unknown[]) {
      const parent = currentParent();
      if (!parent) return original.apply(this, argv);
      let plan: ReturnType<typeof prepare>;
      try {
        plan = prepare(method, argv, parent);
      } catch {
        return original.apply(this, argv);
      }
      const child = original.apply(this, plan.argv);
      try {
        plan.after(child);
      } catch {
        // Never interfere with the caller.
      }
      return child;
    };
    for (const key of Reflect.ownKeys(original)) {
      if (key === "length" || key === "name" || key === "prototype") continue;
      try {
        Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(original, key)!);
      } catch {
        // Non-configurable properties are irrelevant to callers.
      }
    }
    (wrapped as unknown as Record<PropertyKey, unknown>)[wrappedMarker] = true;
    // Node's own promisified exec/execFile call the unwrapped function.
    if (method === "exec" || method === "execFile") {
      const promisified = (...argv: unknown[]) => {
        let child: unknown;
        const promise = new Promise((resolve, reject) => {
          child = wrapped(...argv, (error: AnyRecord | null, stdout: unknown, stderr: unknown) => {
            if (error) {
              error.stdout = stdout;
              error.stderr = stderr;
              reject(error);
            } else resolve({ stdout, stderr });
          });
        }) as Promise<unknown> & { child?: unknown };
        promise.child = child;
        return promise;
      };
      try {
        Object.defineProperty(wrapped, Symbol.for("nodejs.util.promisify.custom"), {
          value: promisified,
          configurable: true,
        });
      } catch {
        // Keep the copied original.
      }
    }
    childProcess[method] = wrapped;
  }
  try {
    nodeModule.syncBuiltinESMExports?.();
  } catch {
    // Older runtimes keep CommonJS-only interception.
  }

  // --- Pi CLI child: become an observed agent -------------------------------------
  const adoptPiProcess = () => {
    const argvEntry = process.argv[1];
    if (
      inheritedParent &&
      argvEntry &&
      isPiCli(argvEntry) &&
      !process.argv.includes(hookPath) &&
      !PI_SUBCOMMANDS.has(process.argv[2] ?? "")
    ) {
      process.argv.splice(2, 0, "-e", hookPath);
    }
  };
  adoptPiProcess();

  const modelId = (model: AnyRecord | undefined) =>
    model && typeof model.id === "string"
      ? typeof model.provider === "string"
        ? `${model.provider}/${model.id}`
        : model.id
      : undefined;

  /** Maps agent events (Pi extension events share their shape) to transcript entries. */
  const agentEventReporter = (
    report: (kind: PiAgentEntryKind, fields?: Partial<PiAgentEntry>) => void,
  ) => {
    let sawTask = false;
    return (event: AnyRecord) => {
      switch (event?.type) {
        case "agent_start":
          report("busy");
          return;
        case "agent_end":
          report("idle");
          return;
        case "message_end": {
          const message = event.message as AnyRecord | undefined;
          const text = messageText(message).trim();
          if (message?.role === "user") {
            if (text) report(sawTask ? "user" : "task", { text: bounded(text, TEXT_LIMIT) });
            sawTask = true;
          } else if (message?.role === "assistant") {
            const usage = usageFields(message.usage);
            report("text", {
              ...(text ? { text: bounded(text, TEXT_LIMIT) } : {}),
              ...(typeof message.stopReason === "string" ? { stop: message.stopReason } : {}),
              ...(typeof message.errorMessage === "string"
                ? { error: bounded(message.errorMessage, 1_000) }
                : {}),
              ...(typeof message.provider === "string" && typeof message.model === "string"
                ? { model: `${message.provider}/${message.model}` }
                : {}),
            });
            if (usage) report("usage", usage);
          }
          return;
        }
        case "tool_execution_start": {
          const target = toolTarget(event.args);
          report("tool", {
            id: String(event.toolCallId ?? newId()),
            name: String(event.toolName ?? "tool"),
            ...(target ? { target } : {}),
          });
          return;
        }
        case "tool_execution_end": {
          const out = toolResultText(event.result);
          report("toolEnd", {
            id: String(event.toolCallId ?? ""),
            ...(event.isError === true ? { isError: true } : {}),
            ...(out ? { out } : {}),
          });
          return;
        }
      }
    };
  };

  /**
   * SDK role: a marked Node process that drives Pi's SDK itself (a background
   * runner, a script) reports each agent run. The process's first agent takes
   * the id its spawner assigned, and later processes it starts nest under it.
   */
  const observedAgents = new WeakSet<object>();
  const observeSdkAgent = (agent: AnyRecord) => {
    if (!inheritedParent || observedAgents.has(agent)) return;
    observedAgents.add(agent);
    const store = storage.getStore();
    const parent: PiAgentParent = store
      ? { th: store.th, t: store.t, n: store.n, p: store.p }
      : selfAgent
        ? { th: selfAgent.parent.th, p: selfAgent.id }
        : inheritedParent;
    const id = !selfAgent && assignedId ? assignedId : newId();
    if (!selfAgent) selfAgent = { id, parent };
    const report = (kind: PiAgentEntryKind, fields?: Partial<PiAgentEntry>) =>
      emit(id, parent.th, kind, fields);
    report("start", { src: "agent", parent, pid: process.pid, cwd: process.cwd() });
    const model = modelId(agent.state?.model);
    const thinking = agent.state?.thinkingLevel;
    if (model || typeof thinking === "string")
      report("meta", {
        ...(model ? { model } : {}),
        ...(typeof thinking === "string" ? { thinking } : {}),
      });
    const forward = agentEventReporter(report);
    agent.subscribe?.((event: AnyRecord) => {
      try {
        forward(event);
      } catch {
        // Never interfere with the agent.
      }
    });
  };
  const agentClassMarker = Symbol.for("rove.agentHook.agentClass");
  const adoptAgentClass = (AgentClass: AnyRecord | undefined) => {
    const proto = AgentClass?.prototype as Record<PropertyKey, any> | undefined;
    if (!proto || proto[agentClassMarker] || typeof proto.runWithLifecycle !== "function") return;
    proto[agentClassMarker] = true;
    const original = proto.runWithLifecycle;
    proto.runWithLifecycle = function (this: AnyRecord, ...args: unknown[]) {
      try {
        observeSdkAgent(this);
      } catch {
        // Never interfere with the agent.
      }
      return original.apply(this, args);
    };
  };
  // Only marked processes that are not the Pi CLI itself: a Pi CLI child reports
  // through the extension role, and the worker observes its own agents.
  if (
    inheritedParent &&
    !isPiCli(process.argv[1]) &&
    typeof (nodeModule as AnyRecord).registerHooks === "function"
  ) {
    try {
      (nodeModule as AnyRecord).registerHooks({
        load(
          url: string,
          context: unknown,
          nextLoad: (url: string, context: unknown) => AnyRecord,
        ) {
          const result = nextLoad(url, context);
          if (!/[\\/]pi-agent-core[\\/]dist[\\/]agent\.js$/.test(url) || result?.source == null)
            return result;
          const source =
            typeof result.source === "string"
              ? result.source
              : Buffer.from(result.source).toString("utf8");
          return {
            ...result,
            source: `${source}\n;globalThis[Symbol.for("rove.agentHook.v1")]?.adoptAgentClass?.(Agent);\n`,
          };
        },
      });
    } catch {
      // Older runtimes cannot observe SDK-driven agents.
    }
  }

  /** Extension role: the child Pi reports itself through public extension events. */
  const extension = (pi: AnyRecord) => {
    if (!inheritedParent || selfAgent || typeof pi?.on !== "function") return;
    const agent = { id: assignedId ?? newId(), parent: inheritedParent };
    selfAgent = agent;
    const report = (kind: PiAgentEntryKind, fields?: Partial<PiAgentEntry>) =>
      emit(agent.id, agent.parent.th, kind, fields);
    report("start", { src: "pi", parent: agent.parent, pid: process.pid, cwd: process.cwd() });
    pi.on("session_start", (_event: unknown, ctx: AnyRecord) => {
      const model = modelId(ctx?.model);
      let session: string | undefined;
      let name: string | undefined;
      try {
        session = ctx?.sessionManager?.getSessionFile?.() ?? undefined;
        name = ctx?.sessionManager?.getSessionName?.() ?? undefined;
      } catch {
        // Optional metadata.
      }
      report("meta", {
        ...(model ? { model } : {}),
        ...(typeof session === "string" ? { session } : {}),
        ...(typeof name === "string" && name.trim() ? { name: bounded(name.trim(), 200) } : {}),
      });
    });
    pi.on("model_select", (event: AnyRecord) => {
      const model = modelId(event?.model);
      if (model) report("meta", { model });
    });
    pi.on("thinking_level_select", (event: AnyRecord) => {
      if (typeof event?.level === "string") report("meta", { thinking: event.level });
    });
    const forward = agentEventReporter(report);
    for (const name of [
      "agent_start",
      "agent_end",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
    ])
      pi.on(name, (event: AnyRecord) => forward({ ...event, type: name }));
  };

  const api: PiAgentHookApi & {
    extension: typeof extension;
    adoptPiProcess: typeof adoptPiProcess;
    adoptAgentClass: typeof adoptAgentClass;
  } = {
    hookPath,
    run: (store, fn) => storage.run(store, fn),
    store: () => storage.getStore(),
    setSink: (next) => {
      sink = next;
    },
    emit,
    newId,
    toolTarget,
    messageText,
    extension,
    adoptPiProcess,
    adoptAgentClass,
  };
  shared[globalKey] = api;
  hookModule.exports = extension;
}

/** Standalone CommonJS source of the hook, written to disk by the worker. */
export const PI_AGENT_HOOK_SOURCE = `"use strict";\n(${roveAgentHook.toString()})(module, require, __filename);\n`;
