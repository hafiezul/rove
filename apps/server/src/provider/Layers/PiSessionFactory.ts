/**
 * PiSessionFactory — builds the real in-process Pi sessions for `PiAdapter`.
 *
 * Wires `@earendil-works/pi-coding-agent` per the settled provider design:
 *   - Headless extensions: tools, commands, and hooks load through the SDK.
 *     Terminal UI is unavailable.
 *   - Always-trust: project-local resources are trusted, matching Rove Code's
 *     full-access stance and avoiding silent divergence from terminal `pi`.
 *   - Resume: the cursor holds the session id and absolute file path.
 *     ID-only cursors from older versions use cwd-based lookup.
 *   - Fork-as-rollback: exposed via `session.navigateTree` (same-file fork)
 *     through the `PiSessionLike.fork` shim the adapter calls.
 *
 * Kept separate from the adapter so the adapter stays testable against a fake
 * `PiSessionLike` and this file holds the only direct SDK dependency.
 *
 * @module provider/Layers/PiSessionFactory
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

import type {
  PiCreateSessionInput,
  PiSessionEventLike,
  PiSessionLike,
  PiSessionResumeOutcome,
} from "./PiAdapter.ts";

/**
 * Adapt an SDK `AgentSession` to the narrow `PiSessionLike` surface the
 * adapter consumes. Two non-mechanical pieces:
 *   - `fork`: the adapter's rollback contract is "fork at this entry and make
 *     it live", which maps to `navigateTree(entryId)` on the same session
 *     file.
 *   - `setModel`: the adapter passes composer slugs (`provider/model-id`), so
 *     we resolve them against the session's model runtime before calling the
 *     SDK's typed `setModel`. An unresolvable slug throws, which the adapter
 *     surfaces as a sendTurn preflight error rather than silently prompting
 *     with the previous model.
 */
/** Resolve a composer slug to the SDK model required by an in-session switch. */
export function resolvePiModelForSession(modelRuntime: ModelRuntime, slug: string) {
  const resolved = resolveCliModel({ cliModel: slug, modelRuntime });
  if (resolved.model === undefined) {
    throw new Error(resolved.error ?? `Unknown Pi model "${slug}".`);
  }
  return resolved.model;
}

/**
 * System-prompt note telling the model which Pi extensions Rove blocks in
 * this session. The model otherwise answers "which extensions are loaded"
 * from Pi's settings.json filters and reports extensions that are not
 * actually bound in the session.
 */
function disabledExtensionsPromptNote(disabled: ReadonlyArray<string>): string {
  return [
    "Rove Code disables these Pi extensions for this session, so they are NOT loaded:",
    ...disabled.map((path) => `- ${path}`),
    "Every other extension from the user's Pi configuration is loaded normally.",
  ].join("\n");
}

async function toPiSessionLike(
  session: AgentSession,
  modelRuntime: ModelRuntime,
  resumeOutcome?: PiSessionResumeOutcome,
): Promise<PiSessionLike> {
  const listeners = new Set<(event: PiSessionEventLike) => void>();
  const startupErrors: PiSessionEventLike[] = [];
  const emit = (event: PiSessionEventLike) => {
    for (const listener of listeners) listener(event);
  };
  let disposal: Promise<void> | undefined;
  const dispose = () =>
    (disposal ??= (async () => {
      try {
        await session.abort();
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        session.dispose();
        listeners.clear();
      }
    })());

  const unsupportedSessionControl = async (): Promise<never> => {
    throw new Error(
      "Pi extension session replacement and reload are not supported in Rove. Use Rove's thread controls.",
    );
  };
  try {
    await session.bindExtensions({
      mode: "print",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: unsupportedSessionControl,
        fork: unsupportedSessionControl,
        navigateTree: unsupportedSessionControl,
        switchSession: unsupportedSessionControl,
        reload: unsupportedSessionControl,
      },
      onError: (error) => {
        const event = { type: "extension_error", ...error };
        if (listeners.size === 0) {
          startupErrors.push(event);
          if (startupErrors.length > 50) startupErrors.shift();
        } else emit(event);
      },
    });
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    get sessionId() {
      return session.sessionId;
    },
    get sessionFile() {
      return session.sessionFile;
    },
    ...(resumeOutcome !== undefined ? { resumeOutcome } : undefined),
    get isStreaming() {
      return session.isStreaming;
    },
    get messages() {
      // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
      return session.messages as ReadonlyArray<unknown>;
    },
    get autoCompactionEnabled() {
      return session.autoCompactionEnabled;
    },
    prompt: async (text, options) => {
      let agentStarted = false;
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_start") agentStarted = true;
      });
      try {
        await session.prompt(text, { ...options, source: "rpc" });
        // Commands and handled input can finish without emitting agent_settled.
        if (!agentStarted && session.isIdle) emit({ type: "agent_settled" });
      } catch (error) {
        emit({
          type: "prompt_error",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        unsubscribe();
      }
    },
    steer: (text) => session.steer(text),
    followUp: (text) => session.followUp(text),
    abort: () => session.abort(),
    dispose,
    setModel: async (slug) => {
      await session.setModel(resolvePiModelForSession(modelRuntime, slug));
    },
    // SAFETY: The composer supplies Pi thinking levels; the SDK clamps to model capabilities.
    setThinkingLevel: (level) => session.setThinkingLevel(level as PiThinkingLevel),
    subscribe: (listener) => {
      listeners.add(listener);
      // SAFETY: The adapter reads only the SDK event's JSON-compatible fields.
      const unsubscribe = session.subscribe((event) => listener(event as never));
      for (const event of startupErrors.splice(0)) listener(event);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    },
    getEntries: () => session.sessionManager.getEntries(),
    getBranch: () => session.sessionManager.getBranch(),
    getSessionStats: () => session.getSessionStats(),
    getLeafId: () => session.sessionManager.getLeafId() ?? undefined,
    fork: async (entryId) => {
      const result = await session.navigateTree(entryId);
      if (result.cancelled) {
        throw new Error("Pi session tree navigation was cancelled.");
      }
    },
  };
}

export function resolvePiSessionResume(
  cwd: string,
  sessionId: string | undefined,
  sessionFile?: string,
): PiSessionResumeOutcome {
  if (sessionId === undefined) return { resumed: false, reason: "no-cursor" };
  try {
    if (sessionFile === undefined) {
      const sessionDir = SessionManager.create(cwd).getSessionDir();
      const matches = NodeFS.readdirSync(sessionDir).filter((entry) =>
        entry.endsWith(`_${sessionId}.jsonl`),
      );
      if (matches.length === 0) throw new Error("Session history is missing.");
      if (matches.length > 1) throw new Error("Multiple session files match this identity.");
      sessionFile = NodePath.join(sessionDir, matches[0]!);
    }
    if (!NodePath.isAbsolute(sessionFile))
      throw new Error("Session file locator must be absolute.");
    const stat = NodeFS.statSync(sessionFile);
    // Pi initializes empty files with a new identity, which is not recovery.
    if (!stat.isFile() || stat.size === 0) throw new Error("Session history is empty or invalid.");
    NodeFS.accessSync(sessionFile, NodeFS.constants.R_OK);
    return { resumed: true, sessionFile };
  } catch (cause) {
    const detail =
      cause instanceof Error && "code" in cause
        ? cause.code === "ENOENT"
          ? "Session history is missing."
          : `Session storage is unreadable. ${cause.message}`
        : cause instanceof Error
          ? cause.message
          : String(cause);
    throw new Error(
      `Cannot recover Pi session '${sessionId}'. ${detail} Restore the session file or storage access and retry, or create a new thread to start fresh.`,
      { cause },
    );
  }
}

export async function createPiSession(
  input: PiCreateSessionInput,
  options: { extensions?: boolean } = {},
): Promise<PiSessionLike> {
  const cwd = input.cwd;
  const agentDir = getAgentDir();
  const outcome = resolvePiSessionResume(cwd, input.resumeSessionId, input.resumeSessionFile);
  const sessionManager = outcome.resumed
    ? SessionManager.open(outcome.sessionFile, undefined, cwd)
    : SessionManager.create(cwd);
  if (outcome.resumed && sessionManager.getSessionId() !== input.resumeSessionId) {
    throw new Error(
      "Pi session identity does not match the saved cursor. Restore the correct session file and retry, or create a new thread to start fresh.",
    );
  }
  if (!outcome.resumed) {
    // Pi defers persistence until an assistant response. Rove saves a cursor at startup.
    const sessionFile = sessionManager.getSessionFile()!;
    NodeFS.writeFileSync(sessionFile, `${JSON.stringify(sessionManager.getHeader())}\n`, {
      flag: "wx",
    });
    sessionManager.setSessionFile(sessionFile);
  }

  const settingsManager = SettingsManager.create(cwd, agentDir);
  // Trust applies only to this session, not the user's global Pi settings.
  settingsManager.setProjectTrusted(true);
  // Disabled extensions stay in the loader's discovery (the catalog panel
  // lists them so they can be re-enabled) but never execute in this session.
  const disabledExtensions = input.disabledExtensions ?? [];
  const resourceLoaderOptions =
    options.extensions === false
      ? { noExtensions: true }
      : disabledExtensions.length > 0
        ? {
            extensionsOverride: (base: LoadExtensionsResult): LoadExtensionsResult => ({
              ...base,
              extensions: base.extensions.filter(
                (extension) => !disabledExtensions.includes(extension.path),
              ),
            }),
            appendSystemPrompt: [disabledExtensionsPromptNote(disabledExtensions)],
          }
        : undefined;
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    ...(resourceLoaderOptions !== undefined ? { resourceLoaderOptions } : undefined),
  });
  const errors = [
    ...services.resourceLoader.getExtensions().errors.map(({ path, error }) => `${path}: ${error}`),
    ...services.diagnostics
      .filter((diagnostic) => diagnostic.type === "error")
      .map((diagnostic) => diagnostic.message),
  ];
  if (errors.length > 0) throw new Error(`Failed to load Pi extensions:\n${errors.join("\n")}`);

  // Resolve the model/thinking override against the user's catalog. Blank
  // (the default) means Pi's own default from settings wins — pass nothing.
  const { modelRuntime } = services;
  const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    resolved =
      input.model !== undefined
        ? resolveCliModel({
            cliModel: input.model,
            ...(input.thinkingLevel !== undefined
              ? { cliThinking: input.thinkingLevel as PiThinkingLevel }
              : undefined),
            modelRuntime,
          })
        : undefined;

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(resolved?.model !== undefined ? { model: resolved.model } : undefined),
    ...(resolved?.thinkingLevel !== undefined
      ? { thinkingLevel: resolved.thinkingLevel }
      : undefined),
  });

  return toPiSessionLike(session, modelRuntime, outcome);
}
