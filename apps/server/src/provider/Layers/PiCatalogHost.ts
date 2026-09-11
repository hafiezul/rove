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
import * as NodePath from "node:path";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { PiCatalogSnapshot, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";
import { PI_THINKING_DESCRIPTOR_ID, PI_THINKING_LEVEL_LABELS } from "./PiProvider.ts";

export interface PiCatalogHostOptions {
  readonly agentDir?: string | undefined;
  readonly additionalExtensionPaths?: ReadonlyArray<string> | undefined;
}

const MAX_WARNINGS = 50;

function pushWarning(warnings: Array<string>, warning: string): void {
  warnings.push(warning);
  if (warnings.length > MAX_WARNINGS) {
    warnings.splice(0, warnings.length - MAX_WARNINGS);
  }
}

export class PiCatalogHost {
  private readonly listeners = new Set<() => void>();
  private readonly warnings: Array<string> = [];
  private disposed = false;

  private readonly session: AgentSession;
  private readonly modelRuntime: ModelRuntime;

  private constructor(session: AgentSession, modelRuntime: ModelRuntime) {
    this.session = session;
    this.modelRuntime = modelRuntime;
  }

  static async create(options: PiCatalogHostOptions = {}): Promise<PiCatalogHost> {
    const agentDir = options.agentDir ?? getAgentDir();
    // Neutral working directory: project extension, skill, and settings
    // discovery all derive from cwd, so running from the agent directory
    // means only global resources load. Project extensions stay invisible
    // here and keep working inside their own threads.
    const settingsManager = SettingsManager.create(agentDir, agentDir);
    const services = await createAgentSessionServices({
      cwd: agentDir,
      agentDir,
      settingsManager,
      ...(options.additionalExtensionPaths !== undefined
        ? {
            resourceLoaderOptions: {
              additionalExtensionPaths: [...options.additionalExtensionPaths],
            },
          }
        : undefined),
    });
    // Extension load failures degrade the catalog, they must not prevent
    // the provider from starting.
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(),
    });
    const host = new PiCatalogHost(session, services.modelRuntime);
    for (const { path, error } of services.resourceLoader.getExtensions().errors) {
      pushWarning(host.warnings, `${path}: ${error}`);
    }
    for (const diagnostic of services.diagnostics) {
      if (diagnostic.type === "error") {
        pushWarning(host.warnings, diagnostic.message);
      }
    }
    const notify = () => host.emit();
    const registerProvider = host.modelRuntime.registerProvider.bind(host.modelRuntime);
    host.modelRuntime.registerProvider = (...args) => {
      registerProvider(...args);
      notify();
    };
    const registerNativeProvider = host.modelRuntime.registerNativeProvider.bind(host.modelRuntime);
    host.modelRuntime.registerNativeProvider = (...args) => {
      registerNativeProvider(...args);
      notify();
    };
    const unregisterProvider = host.modelRuntime.unregisterProvider.bind(host.modelRuntime);
    host.modelRuntime.unregisterProvider = (...args) => {
      unregisterProvider(...args);
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

  /** Models for the provider snapshot probe. Matches `PiProbeClient`. */
  async listModels(): Promise<
    ReadonlyArray<{ id: string; name: string; provider: string; providerName?: string }>
  > {
    const models = await this.modelRuntime.getAvailable();
    const providerNames = new Map(
      this.modelRuntime.getProviders().map((provider) => [String(provider.id), provider.name]),
    );
    return models.map((model) => {
      const providerId = String(model.provider);
      const providerName = providerNames.get(providerId);
      return {
        id: model.id,
        name: model.name,
        provider: providerId,
        ...(providerName !== undefined ? { providerName } : undefined),
      };
    });
  }

  async defaultModelProvider(): Promise<string | undefined> {
    const models = await this.modelRuntime.getAvailable();
    return models.length > 0 ? String(models[0]?.provider) : undefined;
  }

  /** Snapshot-shaped models with per-model reasoning capabilities. */
  async getCatalogModels(): Promise<ReadonlyArray<ServerProviderModel>> {
    const available = await this.modelRuntime.getAvailable();
    const providerNames = new Map(
      this.modelRuntime.getProviders().map((provider) => [String(provider.id), provider.name]),
    );
    return available.map((model) => ({
      slug: `${model.provider}/${model.id}`,
      name: model.name,
      subProvider: providerNames.get(String(model.provider)) ?? String(model.provider),
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          buildSelectOptionDescriptor({
            id: PI_THINKING_DESCRIPTOR_ID,
            label: "Reasoning",
            options: getSupportedThinkingLevels(model).map((level) => ({
              value: level,
              // SAFETY: Pi thinking levels are a subset of the provider label keys; unknown levels fall back to the raw value.
              label: (PI_THINKING_LEVEL_LABELS as Record<string, string>)[level] ?? level,
            })),
          }),
        ],
      }),
    }));
  }

  async getCatalog(): Promise<PiCatalogSnapshot> {
    const extensions = this.session.resourceLoader.getExtensions().extensions;
    return {
      extensions: extensions.map((extension) => ({
        name:
          extension.sourceInfo.source.startsWith("npm:") ||
          extension.sourceInfo.source.startsWith("git:")
            ? extension.sourceInfo.source
            : NodePath.basename(extension.path),
        path: extension.path,
        source: extension.sourceInfo.source,
        scope: extension.sourceInfo.scope,
        tools: [...extension.tools.keys()],
        commands: [...extension.commands.keys()],
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

  /**
   * Network catalog refresh on the shared runtime, then the fresh
   * inventory. Explicit user action only; background paths never call this.
   */
  async refreshCatalog(): Promise<PiCatalogSnapshot> {
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
