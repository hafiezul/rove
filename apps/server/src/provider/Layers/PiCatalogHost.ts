/**
 * PiCatalogHost — one long-lived extension runtime per Pi driver instance,
 * owned by the driver scope. It exists so the provider snapshot (and every
 * picker) lists extension-registered models without preparing a session per
 * thread.
 *
 * Pi splits cleanly along this line: `ModelRuntime` (auth, catalogs,
 * provider registrations) never depends on a working directory, while
 * `ResourceLoader` (project extensions, skills, trust) does. The host loads
 * global extensions only by running from the agent directory, where no
 * project resources exist. Thread sessions keep full per-thread loading for
 * tools, hooks, and project extensions.
 *
 * The host never prompts, so no inference ever runs here. Extension
 * background work (catalog refreshes, prewarming) runs once per instance
 * instead of once per prepared thread.
 *
 * @module provider/Layers/PiCatalogHost
 */
// @effect-diagnostics nodeBuiltinImport:off
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
  PiCatalogSnapshot,
  PiThinkingLevel,
  ServerProviderModel,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  createAgentSessionFromServices,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";
import { PI_THINKING_DESCRIPTOR_ID, PI_THINKING_LEVEL_LABELS } from "./PiProvider.ts";
import { createPiSessionServices, type PiResourceLoader } from "./PiSessionFactory.ts";

export interface PiCatalogHostOptions {
  readonly agentDir?: string | undefined;
  readonly additionalExtensionPaths?: ReadonlyArray<string> | undefined;
  readonly disabledExtensions?: ReadonlyArray<string> | undefined;
}

const MAX_WARNINGS = 50;

function pushWarning(warnings: Array<string>, warning: string): void {
  // Repeated refreshes would otherwise stack the same message.
  if (!warnings.includes(warning)) {
    warnings.push(warning);
    if (warnings.length > MAX_WARNINGS) warnings.splice(0, warnings.length - MAX_WARNINGS);
  }
}

export class PiCatalogHost {
  private readonly listeners = new Set<() => void>();
  private readonly warnings: Array<string> = [];
  private disposed = false;

  private readonly session: AgentSession;
  private readonly modelRuntime: ModelRuntime;
  private readonly resourceLoader: PiResourceLoader;
  private disabledExtensions: ReadonlyArray<string>;
  private readonly extensionProviderIds = new Set<string>();

  private constructor(
    session: AgentSession,
    modelRuntime: ModelRuntime,
    resourceLoader: PiResourceLoader,
    disabledExtensions: ReadonlyArray<string>,
  ) {
    this.session = session;
    this.modelRuntime = modelRuntime;
    this.resourceLoader = resourceLoader;
    this.disabledExtensions = disabledExtensions;
  }

  static async create(options: PiCatalogHostOptions = {}): Promise<PiCatalogHost> {
    const agentDir = options.agentDir ?? getAgentDir();
    // Neutral working directory: project extension, skill, and settings
    // discovery all derive from cwd, so running from the agent directory
    // means only global resources load. Project extensions stay invisible
    // here and keep working inside their own threads.
    const settingsManager = SettingsManager.create(agentDir, agentDir);
    const disabledExtensions = options.disabledExtensions ?? [];
    const services = await createPiSessionServices({
      cwd: agentDir,
      agentDir,
      settingsManager,
      disabledExtensions,
      additionalExtensionPaths: options.additionalExtensionPaths,
    });
    // Extension load failures degrade the catalog, they must not prevent
    // the provider from starting.
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(),
    });
    const host = new PiCatalogHost(
      session,
      services.modelRuntime,
      services.resourceLoader,
      disabledExtensions,
    );
    for (const { path, error } of services.resourceLoader.getExtensions().errors) {
      pushWarning(host.warnings, `${path}: ${error}`);
    }
    for (const diagnostic of services.diagnostics) {
      if (diagnostic.type === "error") {
        pushWarning(host.warnings, diagnostic.message);
      }
    }
    for (const id of services.extensionProviderIds) host.extensionProviderIds.add(id);
    const notify = () => host.emit();
    const registerProvider = host.modelRuntime.registerProvider.bind(host.modelRuntime);
    host.modelRuntime.registerProvider = (...args) => {
      registerProvider(...args);
      host.extensionProviderIds.add(args[0]);
      notify();
    };
    const registerNativeProvider = host.modelRuntime.registerNativeProvider.bind(host.modelRuntime);
    host.modelRuntime.registerNativeProvider = (...args) => {
      registerNativeProvider(...args);
      host.extensionProviderIds.add(args[0].id);
      notify();
    };
    const unregisterProvider = host.modelRuntime.unregisterProvider.bind(host.modelRuntime);
    host.modelRuntime.unregisterProvider = (...args) => {
      unregisterProvider(...args);
      host.extensionProviderIds.delete(args[0]);
      notify();
    };
    const refresh = host.modelRuntime.refresh.bind(host.modelRuntime);
    host.modelRuntime.refresh = (async (...args: Parameters<typeof refresh>) => {
      const result = await refresh(...args);
      notify();
      return result;
    }) as typeof refresh;
    try {
      await session.bindExtensions({
        mode: "print",
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          newSession: unsupportedCatalogSessionControl,
          fork: unsupportedCatalogSessionControl,
          navigateTree: unsupportedCatalogSessionControl,
          switchSession: unsupportedCatalogSessionControl,
          reload: unsupportedCatalogSessionControl,
        },
        onError: (error) => {
          pushWarning(host.warnings, `${error.extensionPath}: ${error.error}`);
          notify();
        },
      });
    } catch (error) {
      await host.dispose();
      throw error;
    }
    return host;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Change notifications for provider registrations, refreshes, and errors. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The runtime carrying extension-registered providers. Auxiliary Pi sessions
   * (text generation) run their own loaders without extensions, so they must
   * resolve models against this shared runtime instead of a fresh one.
   */
  getModelRuntime(): ModelRuntime {
    return this.modelRuntime;
  }

  /** Snapshot-shaped models with per-model reasoning capabilities. */
  async getCatalogModels(
    thinkingLevel?: PiThinkingLevel | null,
  ): Promise<ReadonlyArray<ServerProviderModel>> {
    const available = await this.modelRuntime.getAvailable();
    const providerNames = new Map(
      this.modelRuntime.getProviders().map((provider) => [String(provider.id), provider.name]),
    );
    const settings = this.session.settingsManager;
    return available.map((model) => {
      const levels = getSupportedThinkingLevels(model);
      const defaultLevel = clampThinkingLevel(
        model,
        thinkingLevel ??
          settings.getModelThinkingLevel(model.provider, model.id) ??
          settings.getDefaultThinkingLevel() ??
          "medium",
      );
      const subProvider = (
        providerNames.get(String(model.provider)) ?? String(model.provider)
      ).trim();
      return {
        slug: `${model.provider}/${model.id}`,
        name: model.name,
        ...(subProvider ? { subProvider } : undefined),
        isCustom: false,
        ...(this.session.model?.provider === model.provider && this.session.model.id === model.id
          ? { isDefault: true }
          : undefined),
        capabilities: createModelCapabilities({
          optionDescriptors:
            levels.length === 0
              ? []
              : [
                  buildSelectOptionDescriptor({
                    id: PI_THINKING_DESCRIPTOR_ID,
                    label: "Reasoning",
                    options: levels.map((level) => ({
                      value: level,
                      label: PI_THINKING_LEVEL_LABELS[level],
                      ...(level === defaultLevel ? { isDefault: true } : undefined),
                    })),
                  }),
                ],
        }),
      };
    });
  }

  /**
   * Slash commands registered by the loaded global extensions. The provider
   * snapshot merges these into the composer's `/` menu alongside prompt
   * templates, so the picker describes what a session actually accepts.
   */
  getExtensionSlashCommands(): ReadonlyArray<ServerProviderSlashCommand> {
    return this.session.extensionRunner.getRegisteredCommands().map((command) => ({
      name: command.invocationName,
      ...(command.description !== undefined && command.description.trim().length > 0
        ? { description: command.description }
        : undefined),
    }));
  }

  async getCatalog(): Promise<PiCatalogSnapshot> {
    const discovered = await this.resourceLoader.getDiscoveredExtensions();
    return {
      extensions: discovered.map((extension) => ({
        name: extension.name,
        path: extension.path,
        source: extension.source,
        scope: extension.scope,
        tools: [...extension.tools],
        commands: [...extension.commands],
      })),
      modelProviders: this.modelRuntime
        .getProviders()
        .filter((provider) =>
          this.modelRuntime.getRegisteredProviderIds().includes(String(provider.id)),
        )
        .map((provider) => ({
          id: String(provider.id),
          name: provider.name,
          authenticated: this.modelRuntime.hasConfiguredAuth(String(provider.id)),
          modelCount: this.modelRuntime.getModels(String(provider.id)).length,
        })),
      warnings: [...this.warnings],
    };
  }

  async setDisabledExtensions(disabledExtensions: ReadonlyArray<string>): Promise<void> {
    this.disabledExtensions = [...disabledExtensions];
    this.resourceLoader.setDisabledExtensions(this.disabledExtensions);
    await this.refreshCatalog();
  }

  /**
   * Network catalog refresh on the shared runtime, then the fresh
   * inventory. Explicit user action only; background paths never call this.
   */
  async refreshCatalog(): Promise<PiCatalogSnapshot> {
    // Re-scan extension files so newly installed or removed extensions show
    // up; the runner rebinds with the fresh set, which re-registers any
    // extension providers.
    try {
      // Remove prior contributions, including providers registered by session_start
      // hooks. Rebinding the runner also retires old hooks and activates new ones.
      for (const id of this.extensionProviderIds) this.modelRuntime.unregisterProvider(id);
      await this.session.reload({});
      for (const { path, error } of this.resourceLoader.getExtensions().errors) {
        pushWarning(this.warnings, `${path}: ${error}`);
      }
    } catch (error) {
      pushWarning(
        this.warnings,
        `Catalog reload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const result = await this.modelRuntime.refresh({
      allowNetwork: true,
      force: true,
      signal: AbortSignal.timeout(15_000),
    });
    for (const [provider, error] of result.errors) {
      pushWarning(this.warnings, `${provider}: ${String(error)}`);
    }
    if (result.aborted) {
      pushWarning(
        this.warnings,
        "Pi model refresh timed out. Keeping the last available catalogue.",
      );
    }
    this.emit();
    return this.getCatalog();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.listeners.clear();
    try {
      await this.session.abort();
      await this.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      this.session.dispose();
    }
  }
}

async function unsupportedCatalogSessionControl(): Promise<never> {
  throw new Error("The Pi catalog host never runs prompts or session controls.");
}
