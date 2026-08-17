/**
 * PiSessionFactory — builds the real in-process Pi sessions for `PiAdapter`.
 *
 * Wires `@earendil-works/pi-coding-agent` per the settled provider design:
 *   - Sterile Pi: global config (auth, models, skills, prompt templates) is
 *     loaded, extensions are not (DefaultResourceLoader with noExtensions).
 *   - Always-trust: project-local resources are trusted, matching Rove's
 *     full-access stance and avoiding silent divergence from terminal `pi`.
 *   - Resume: a thread's `resumeCursor` holds the Pi session id; we re-adopt
 *     it with `SessionManager.open` on the session file that id maps to.
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
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

import type { PiCreateSessionInput, PiSessionLike } from "./PiAdapter.ts";

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

function toPiSessionLike(session: AgentSession, modelRuntime: ModelRuntime): PiSessionLike {
  return {
    get sessionId() {
      return session.sessionId;
    },
    get isStreaming() {
      return session.isStreaming;
    },
    get messages() {
      return session.messages as ReadonlyArray<unknown>;
    },
    get autoCompactionEnabled() {
      return session.autoCompactionEnabled;
    },
    prompt: (text, options) => session.prompt(text, options),
    steer: (text) => session.steer(text),
    followUp: (text) => session.followUp(text),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
    setModel: async (slug) => {
      await session.setModel(resolvePiModelForSession(modelRuntime, slug));
    },
    setThinkingLevel: (level) => session.setThinkingLevel(level as PiThinkingLevel),
    subscribe: (listener) => session.subscribe((event) => listener(event as never)),
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

/**
 * Resolve the on-disk session file for a persisted Pi session id so a resumed
 * thread re-adopts its conversation. Pi names session files
 * `<fileTimestamp>_<sessionId>.jsonl` in the cwd-derived session dir, so the
 * id maps to the single file ending in `_<sessionId>.jsonl`. Returns
 * undefined when no such file exists (e.g. an in-memory session that was
 * never persisted), in which case the caller starts a fresh session.
 */
export function resolvePiSessionFileForTest(cwd: string, sessionId: string): string | undefined {
  const sessionDir = SessionManager.create(cwd).getSessionDir();
  let entries: string[];
  try {
    entries = NodeFS.readdirSync(sessionDir);
  } catch {
    return undefined;
  }
  const suffix = `_${sessionId}.jsonl`;
  const match = entries.find((entry) => entry.endsWith(suffix));
  return match === undefined ? undefined : NodePath.join(sessionDir, match);
}

export async function createPiSession(input: PiCreateSessionInput): Promise<PiSessionLike> {
  const cwd = input.cwd;
  const agentDir = getAgentDir();

  // Sterile Pi: load the user's global resources but never extensions. Skills
  // and prompt templates stay on (they are prompt content, harmless headless);
  // themes are irrelevant without a UI but cheap to leave on.
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
  });

  const settingsManager = SettingsManager.create(cwd, agentDir);
  // Always-trust: Rove threads are user-initiated work, and silently ignoring
  // project resources would diverge the thread from terminal `pi` behaviour.
  settingsManager.setDefaultProjectTrust("always");

  const resumeFile =
    input.resumeSessionFile !== undefined
      ? resolvePiSessionFileForTest(cwd, input.resumeSessionFile)
      : undefined;
  const sessionManager =
    resumeFile !== undefined ? SessionManager.open(resumeFile) : SessionManager.create(cwd);

  // Resolve the model/thinking override against the user's catalog. Blank
  // (the default) means Pi's own default from settings wins — pass nothing.
  const modelRuntime = await ModelRuntime.create({});
  const resolved =
    input.model !== undefined
      ? resolveCliModel({
          cliModel: input.model,
          ...(input.thinkingLevel !== undefined
            ? { cliThinking: input.thinkingLevel as PiThinkingLevel }
            : {}),
          modelRuntime,
        })
      : undefined;

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager,
    settingsManager,
    resourceLoader,
    modelRuntime,
    ...(resolved?.model !== undefined ? { model: resolved.model } : {}),
    ...(resolved?.thinkingLevel !== undefined ? { thinkingLevel: resolved.thinkingLevel } : {}),
  });

  return toPiSessionLike(session, modelRuntime);
}
