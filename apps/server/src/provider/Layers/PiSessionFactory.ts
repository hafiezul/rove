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
import * as RuntimePredicate from "effect/Predicate";

import {
  createAgentSessionFromServices,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionRuntimeDiagnostic,
  type AgentSessionServices,
  type Extension,
  type ExtensionRuntime,
  type InlineExtension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

import {
  PiExtensionLoadError,
  type PiCreateSessionInput,
  type PiSessionEventLike,
  type PiSessionLike,
  type PiSessionResumeOutcome,
} from "./PiAdapter.ts";

import { readMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { createPiRoveTools } from "./PiRoveTools.ts";

export { PiExtensionLoadError } from "./PiAdapter.ts";

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
  if (resolved.error !== undefined || resolved.model === undefined) {
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
  initialStartupErrors: ReadonlyArray<PiSessionEventLike> = [],
  modelFallbackMessage?: string | undefined,
  disposeRoveTools: () => Promise<void> = async () => {},
): Promise<PiSessionLike> {
  const listeners = new Set<(event: PiSessionEventLike) => void>();
  const startupErrors: PiSessionEventLike[] = [...initialStartupErrors];
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
        try {
          session.dispose();
          listeners.clear();
        } finally {
          await disposeRoveTools();
        }
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
    ...(modelFallbackMessage !== undefined ? { modelFallbackMessage } : undefined),
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
        await session.prompt(text, {
          ...options,
          source: "rpc",
        });
        // Commands and handled input can finish without emitting agent_settled.
        if (!agentStarted && session.isIdle) emit({ type: "agent_settled" });
      } finally {
        unsubscribe();
      }
    },
    followUp: (text) => session.followUp(text),
    abort: () => session.abort(),
    dispose,
    setModel: async (slug) => {
      await session.setModel(resolvePiModelForSession(modelRuntime, slug));
    },
    // SAFETY: The composer supplies Pi thinking levels; the SDK clamps to model capabilities.
    setThinkingLevel: (level) => session.setThinkingLevel(level as PiThinkingLevel),
    getModel: () => {
      const model = session.model;
      return model ? { id: model.id, provider: model.provider, input: model.input } : undefined;
    },
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

function isExtensionPathDisabled(
  extensionPath: string,
  disabledExtensions: ReadonlyArray<string>,
  cwd?: string,
): boolean {
  if (disabledExtensions.length === 0) return false;
  const currentCwd = cwd ?? process.cwd();
  const normalizedTarget = NodePath.resolve(currentCwd, extensionPath);
  let realTarget: string | undefined;
  try {
    realTarget = NodeFS.realpathSync(normalizedTarget);
  } catch {
    // Path might not exist on disk
  }

  for (const disabled of disabledExtensions) {
    if (disabled === extensionPath) return true;
    const normalizedDisabled = NodePath.resolve(currentCwd, disabled);
    if (normalizedTarget === normalizedDisabled) return true;
    if (realTarget !== undefined) {
      try {
        if (realTarget === NodeFS.realpathSync(normalizedDisabled)) {
          return true;
        }
      } catch {
        // Path might not exist
      }
    }
    if (NodePath.basename(extensionPath) === disabled) return true;
  }
  return false;
}

export interface PiDiscoveredExtension {
  readonly name: string;
  readonly path: string;
  readonly source: string;
  readonly scope: "user" | "project" | "temporary";
  readonly enabled: boolean;
  readonly tools: ReadonlyArray<string>;
  readonly commands: ReadonlyArray<string>;
  readonly error?: string | undefined;
}

interface DefaultResourceLoaderInternalAccess {
  loadFinalExtensionSet: (
    paths: string[],
    preTrust?: LoadExtensionsResult,
  ) => Promise<LoadExtensionsResult>;
  loadExtensionFactories: (
    runtime: ExtensionRuntime,
  ) => Promise<{ extensions: Extension[]; errors: Array<{ path: string; error: string }> }>;
  extensionFactories?: InlineExtension[] | undefined;
  packageManager: {
    resolve: () => Promise<{
      extensions: ReadonlyArray<{ path: string; metadata: { source?: string; scope?: string } }>;
    }>;
    resolveExtensionSources: (
      paths: ReadonlyArray<string>,
      opts: { temporary: boolean },
    ) => Promise<{
      extensions: ReadonlyArray<{ path: string; metadata: { source?: string; scope?: string } }>;
    }>;
  };
  additionalExtensionPaths: ReadonlyArray<string>;
  resourceMetadataByPath?: Map<string, { source?: string; scope?: string }> | undefined;
}

function getLoaderInternals(loader: DefaultResourceLoader): DefaultResourceLoaderInternalAccess {
  const // SAFETY: DefaultResourceLoader runtime instance contains unexported methods and state.
    internals = loader as never;
  return internals;
}

export class PiResourceLoader extends DefaultResourceLoader {
  readonly sessionCwd: string;
  private disabledExtensionsSet: ReadonlyArray<string>;

  constructor(
    options: ConstructorParameters<typeof DefaultResourceLoader>[0],
    disabledExtensions: ReadonlyArray<string> = [],
  ) {
    super(options);
    this.sessionCwd = options.cwd;
    this.disabledExtensionsSet = disabledExtensions;

    // Filter extension paths before loadFinalExtensionSet executes factories
    const internals = getLoaderInternals(this);
    const originalLoadFinal = internals.loadFinalExtensionSet.bind(this);
    internals.loadFinalExtensionSet = (paths: string[], preTrust?: LoadExtensionsResult) => {
      const activePaths = paths.filter(
        (path) => !isExtensionPathDisabled(path, this.disabledExtensionsSet, this.sessionCwd),
      );
      return originalLoadFinal(activePaths, preTrust);
    };

    const originalLoadFactories = internals.loadExtensionFactories.bind(this);
    internals.loadExtensionFactories = (runtime: ExtensionRuntime) => {
      const allFactories = internals.extensionFactories ?? [];
      const activeFactories = allFactories
        .map((factory, index) =>
          RuntimePredicate.isFunction(factory) ? { name: String(index + 1), factory } : factory,
        )
        .filter((factory) => {
          const name = factory.name;
          const path = `<inline:${name}>`;
          return (
            !isExtensionPathDisabled(path, this.disabledExtensionsSet, this.sessionCwd) &&
            !isExtensionPathDisabled(name, this.disabledExtensionsSet, this.sessionCwd)
          );
        });
      const saved = internals.extensionFactories;
      // Preserve SDK identities when filtering earlier unnamed factories.
      internals.extensionFactories = activeFactories;
      return originalLoadFactories(runtime).finally(() => {
        internals.extensionFactories = saved;
      });
    };
  }

  setDisabledExtensions(disabled: ReadonlyArray<string>): void {
    this.disabledExtensionsSet = disabled;
  }

  getDisabledExtensions(): ReadonlyArray<string> {
    return this.disabledExtensionsSet;
  }

  async getDiscoveredExtensions(): Promise<ReadonlyArray<PiDiscoveredExtension>> {
    const internals = getLoaderInternals(this);
    const packageManager = internals.packageManager;
    const additionalExtensionPaths = internals.additionalExtensionPaths ?? [];
    const resourceMetadataByPath = internals.resourceMetadataByPath;
    const extensionFactories = internals.extensionFactories ?? [];

    const resolvedPaths = await packageManager.resolve();
    const cliExtensionPaths = await packageManager.resolveExtensionSources(
      additionalExtensionPaths,
      { temporary: true },
    );
    const activeExtensions = this.getExtensions().extensions;
    const loadErrors = new Map(this.getExtensions().errors.map(({ path, error }) => [path, error]));

    const discovered = new Map<string, PiDiscoveredExtension>();

    const allResources = [...resolvedPaths.extensions, ...cliExtensionPaths.extensions];
    for (const r of allResources) {
      const canonical = NodePath.resolve(this.sessionCwd, r.path);
      if (discovered.has(canonical)) continue;

      const isDisabled = isExtensionPathDisabled(
        r.path,
        this.disabledExtensionsSet,
        this.sessionCwd,
      );
      const active = activeExtensions.find(
        (ext) =>
          ext.path === r.path || ext.resolvedPath === r.path || ext.resolvedPath === canonical,
      );

      const metadata = resourceMetadataByPath?.get(r.path) ?? r.metadata;
      const source = metadata?.source ?? "local";
      const // SAFETY: Pi package manager contracts restrict resource scopes to these literals.
        scope = (metadata?.scope ?? "user") as "user" | "project" | "temporary";
      const name =
        source.startsWith("npm:") || source.startsWith("git:") ? source : NodePath.basename(r.path);

      discovered.set(canonical, {
        name,
        path: r.path,
        source,
        scope,
        enabled: !isDisabled,
        tools: active ? [...active.tools.keys()] : [],
        commands: active ? [...active.commands.keys()] : [],
        ...(loadErrors.has(r.path) ? { error: loadErrors.get(r.path) } : undefined),
      });
    }

    for (const [index, input] of extensionFactories.entries()) {
      const isNamed = !RuntimePredicate.isFunction(input);
      const name = isNamed ? input.name : String(index + 1);
      const path = `<inline:${name}>`;
      if (discovered.has(path)) continue;

      const isDisabled =
        isExtensionPathDisabled(path, this.disabledExtensionsSet, this.sessionCwd) ||
        isExtensionPathDisabled(name, this.disabledExtensionsSet, this.sessionCwd);
      const active = activeExtensions.find((ext) => ext.path === path);

      discovered.set(path, {
        name,
        path,
        source: "inline",
        scope: "temporary",
        enabled: !isDisabled,
        tools: active ? [...active.tools.keys()] : [],
        commands: active ? [...active.commands.keys()] : [],
      });
    }

    return Array.from(discovered.values());
  }
}

export interface CreatePiSessionServicesOptions {
  readonly cwd: string;
  readonly agentDir?: string | undefined;
  readonly settingsManager?: SettingsManager | undefined;
  readonly modelRuntime?: ModelRuntime | undefined;
  readonly modelRuntimeSignal?: AbortSignal | undefined;
  readonly disabledExtensions?: ReadonlyArray<string> | undefined;
  readonly additionalExtensionPaths?: ReadonlyArray<string> | undefined;
  readonly noExtensions?: boolean | undefined;
}

export async function createPiSessionServices(
  options: CreatePiSessionServicesOptions,
): Promise<
  AgentSessionServices & { resourceLoader: PiResourceLoader; extensionProviderIds: Set<string> }
> {
  const cwd = NodePath.resolve(options.cwd);
  const agentDir = options.agentDir ? NodePath.resolve(options.agentDir) : getAgentDir();
  const modelRuntime =
    options.modelRuntime ??
    (await ModelRuntime.create({
      authPath: NodePath.join(agentDir, "auth.json"),
      modelsPath: NodePath.join(agentDir, "models.json"),
      ...(options.modelRuntimeSignal !== undefined
        ? { signal: options.modelRuntimeSignal }
        : undefined),
    }));
  const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
  const disabledExtensions = options.disabledExtensions ?? [];
  const appendSystemPrompt =
    disabledExtensions.length > 0 ? [disabledExtensionsPromptNote(disabledExtensions)] : undefined;

  const resourceLoader = new PiResourceLoader(
    {
      cwd,
      agentDir,
      settingsManager,
      noExtensions: options.noExtensions ?? false,
      ...(options.additionalExtensionPaths !== undefined
        ? { additionalExtensionPaths: [...options.additionalExtensionPaths] }
        : undefined),
      ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : undefined),
    },
    disabledExtensions,
  );

  await resourceLoader.reload();

  const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
  const extensionProviderIds = new Set<string>();
  const extensionsResult = resourceLoader.getExtensions();
  for (const { name, config, extensionPath } of extensionsResult.runtime
    .pendingProviderRegistrations) {
    try {
      modelRuntime.registerProvider(name, config);
      extensionProviderIds.add(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        type: "error",
        message: `Extension "${extensionPath}" error: ${message}`,
      });
    }
  }
  extensionsResult.runtime.pendingProviderRegistrations = [];
  for (const { provider, extensionPath } of extensionsResult.runtime
    .pendingNativeProviderRegistrations) {
    try {
      modelRuntime.registerNativeProvider(provider);
      extensionProviderIds.add(provider.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        type: "error",
        message: `Extension "${extensionPath}" error: ${message}`,
      });
    }
  }
  extensionsResult.runtime.pendingNativeProviderRegistrations = [];
  // A caller-provided runtime (the catalog host's) is already refreshed;
  // refreshing it here would only churn availability listeners.
  if (options.modelRuntime === undefined) {
    await modelRuntime.refresh({ allowNetwork: false });
  }

  return {
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    diagnostics,
    extensionProviderIds,
  };
}

// Exported from ./PiAdapter.ts and re-exported above

export async function createPiSession(
  input: PiCreateSessionInput,
  options: {
    extensions?: boolean;
    retryWithoutFailedExtensions?: boolean;
    /**
     * Shared runtime (the catalog host's) to resolve models against. Sessions
     * running without extensions never register extension providers, so a
     * fresh runtime cannot resolve extension-registered models.
     */
    modelRuntime?: ModelRuntime;
  } = {},
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

  const disabledExtensions = [...(input.disabledExtensions ?? [])];
  const startupErrors: PiSessionEventLike[] = [];

  let services = await createPiSessionServices({
    cwd,
    agentDir,
    settingsManager,
    disabledExtensions,
    noExtensions: options.extensions === false,
    modelRuntime: options.modelRuntime,
  });

  const getErrors = (s: AgentSessionServices) => [
    ...s.resourceLoader
      .getExtensions()
      .errors.map(({ path, error }) => ({ path, error: `${path}: ${error}` })),
    ...s.diagnostics
      .filter((diagnostic) => diagnostic.type === "error")
      .map((diagnostic) => ({ path: "", error: diagnostic.message })),
  ];

  let errors = getErrors(services);

  if (errors.length > 0 && options.extensions !== false) {
    const failedPaths = [
      ...new Set(services.resourceLoader.getExtensions().errors.map(({ path }) => path)),
    ];
    if (options.retryWithoutFailedExtensions === true && failedPaths.length > 0) {
      const recoveredDisabled = [
        ...disabledExtensions,
        ...failedPaths.filter((p) => !isExtensionPathDisabled(p, disabledExtensions, cwd)),
      ];
      try {
        const recoveredServices = await createPiSessionServices({
          cwd,
          agentDir,
          settingsManager,
          disabledExtensions: recoveredDisabled,
          noExtensions: false,
          modelRuntime: options.modelRuntime,
        });
        for (const { path, error } of services.resourceLoader.getExtensions().errors) {
          startupErrors.push({
            type: "extension_error",
            extensionPath: path,
            error: `Failed to load Pi extension (${error}). Session retried without this extension.`,
          });
        }
        services = recoveredServices;
        errors = getErrors(services);
      } catch {
        // Recovery failed, fall through to throw below
      }
    }
    if (errors.length > 0) {
      throw new PiExtensionLoadError(
        `Failed to load Pi extensions:\n${errors.map((e) => e.error).join("\n")}`,
        failedPaths,
      );
    }
  }

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
  // An unresolvable requested model must fail the session — matching the
  // in-session switch path (`resolvePiModelForSession`) — instead of silently
  // prompting with a different model than the composer displays.
  if (resolved !== undefined && (resolved.error !== undefined || resolved.model === undefined)) {
    throw new Error(resolved.error ?? `Unknown Pi model "${input.model}".`);
  }
  // The requested reasoning selection wins over a `<model>:<level>` suffix in
  // the slug. `resolveCliModel` never applies `cliThinking` itself, so without
  // this pass-through the composer's level would be dropped at creation and
  // the session would run Pi's settings default instead.
  const // SAFETY: The composer supplies Pi thinking levels; the SDK clamps to model capabilities.
    requestedThinkingLevel = (input.thinkingLevel ?? resolved?.thinkingLevel) as
      | PiThinkingLevel
      | undefined;

  const roveTools = await createPiRoveTools(
    input.threadId === undefined ? undefined : readMcpProviderSession(input.threadId),
  );
  const { session, modelFallbackMessage: sdkModelFallbackMessage } =
    await createAgentSessionFromServices({
      services,
      sessionManager,
      customTools: roveTools.tools,
      ...(resolved?.model !== undefined ? { model: resolved.model } : undefined),
      ...(requestedThinkingLevel !== undefined
        ? { thinkingLevel: requestedThinkingLevel }
        : undefined),
    }).catch(async (error: unknown) => {
      await roveTools.dispose();
      throw error;
    });

  // Collect every way the effective model/reasoning selection differs from the
  // requested one: fuzzy-match warnings, the SDK's restore fallback, and
  // reasoning clamped to the model's capabilities. The adapter publishes the
  // combined message as a runtime warning so the thread shows the mismatch.
  const fallbackNotices = [resolved?.warning, sdkModelFallbackMessage];
  if (requestedThinkingLevel !== undefined && session.thinkingLevel !== requestedThinkingLevel) {
    const effectiveModel = session.model;
    fallbackNotices.push(
      `Reasoning level "${requestedThinkingLevel}" is not supported by ${
        effectiveModel ? `${effectiveModel.provider}/${effectiveModel.id}` : "this model"
      }; using "${session.thinkingLevel}".`,
    );
  }
  const modelFallbackMessage = fallbackNotices
    .filter((notice): notice is string => notice !== undefined && notice.trim().length > 0)
    .join(" ");

  return toPiSessionLike(
    session,
    modelRuntime,
    outcome,
    startupErrors,
    modelFallbackMessage.length > 0 ? modelFallbackMessage : undefined,
    roveTools.dispose,
  );
}
