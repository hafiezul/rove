/**
 * PiDriver — `ProviderDriver` for the SDK runtime in an isolated instance process.
 *
 * See docs/adr/0001-pi-provider-uses-sdk-in-process.md. The driver's `create()`
 * bundles `snapshot` / `adapter` / `textGeneration` closures over the decoded
 * `PiSettings`. Sessions are built by `createPiSession` with headless extensions
 * and trusted project resources; the snapshot probe enumerates the user's Pi model
 * catalog through a `ModelRuntime`.
 *
 * @module provider/Drivers/PiDriver
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  PiCatalogError,
  PiSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type { ServerSettings } from "@t3tools/contracts";

import { acquirePiResource, disposePiResource } from "../Layers/PiLifecycle.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import { PiRuntimeProcess } from "../Layers/PiRuntimeProcess.ts";
import { HostProcessIsExecutable } from "@t3tools/shared/hostProcess";
import { registerPiBundledOAuthFlows } from "./PiOAuth.ts";
import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  type PiDiscoveryClient,
  type PiProbeClient,
} from "../Layers/PiProvider.ts";
import { ProviderDriverError } from "../Errors.ts";
import { type ProviderDriver, type ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

registerPiBundledOAuthFlows();

const decodePiSettings = Schema.decodeSync(PiSettings);
const decodePiSettingsOption = Schema.decodeUnknownOption(PiSettings);

const DRIVER_KIND = ProviderDriverKind.make("pi");
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "@earendil-works/pi-coding-agent",
});

/**
 * Discovery client backed by the SDK's `DefaultResourceLoader` — the same
 * loader sessions use, but without executing extensions during probes. Slash
 * commands come from two sources: prompt templates from the loader, and
 * commands registered by the instance's loaded global extensions (the catalog
 * host is the only place extensions load outside a thread). The loader runs
 * from the agent directory by default — the same neutral working directory the
 * catalog host uses — so the instance-global snapshot describes user-scope
 * resources only and never leaks the server process's cwd into the pickers.
 * Project resources are thread-scoped and keep living in their own sessions.
 */
export const makeSdkDiscoveryClient = (
  getExtensionCommands?: () =>
    | ReadonlyArray<ServerProviderSlashCommand>
    | Promise<ReadonlyArray<ServerProviderSlashCommand>>,
  agentDir?: string,
): PiDiscoveryClient => ({
  discover: async ({ cwd }) => {
    const { DefaultResourceLoader, getAgentDir, SettingsManager } =
      await import("@earendil-works/pi-coding-agent");
    const resolvedAgentDir = agentDir ? NodePath.resolve(expandHomePath(agentDir)) : getAgentDir();
    const settingsManager = SettingsManager.create(cwd ?? resolvedAgentDir, resolvedAgentDir);
    if (cwd !== undefined) settingsManager.setProjectTrusted(true);
    const loader = new DefaultResourceLoader({
      cwd: cwd ?? resolvedAgentDir,
      agentDir: resolvedAgentDir,
      settingsManager,
      noExtensions: true,
    });
    // Resources populate lazily: getSkills()/getPrompts() return empty until
    // reload() has scanned the configured roots.
    await loader.reload();
    const [{ skills }, { prompts }] = [loader.getSkills(), loader.getPrompts()];
    // Extension commands win name collisions, mirroring the session's own
    // command resolution order (extension commands come first).
    let extensionCommands: ReadonlyArray<ServerProviderSlashCommand> = [];
    try {
      extensionCommands = (await getExtensionCommands?.()) ?? [];
    } catch {
      // Discovery is best-effort; a catalog host hiccup must not drop templates.
    }
    const slashCommandsByName = new Map<string, ServerProviderSlashCommand>();
    for (const command of [
      ...extensionCommands,
      ...prompts.map((prompt) => ({
        name: prompt.name,
        ...(prompt.description.trim().length > 0 ? { description: prompt.description } : undefined),
        ...(prompt.argumentHint !== undefined && prompt.argumentHint.trim().length > 0
          ? { input: { hint: prompt.argumentHint } }
          : undefined),
      })),
    ]) {
      if (!slashCommandsByName.has(command.name)) slashCommandsByName.set(command.name, command);
    }
    return {
      skills: skills.map((skill) => ({
        name: skill.name,
        ...(skill.description.trim().length > 0 ? { description: skill.description } : undefined),
        path: skill.filePath,
        // "temporary" (e.g. in-memory extension resources) maps to "user":
        // it is not project content, and the composer only renders the label.
        scope: skill.sourceInfo.scope === "project" ? "project" : "user",
        enabled: true,
      })),
      slashCommands: [...slashCommandsByName.values()],
    };
  },
});

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : undefined),
    ...(input.accentColor ? { accentColor: input.accentColor } : undefined),
    continuation: { groupKey: input.continuationGroupKey },
  });

export type PiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Pi",
    supportsMultipleInstances: true,
  },
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      // Sessions, the catalog host, and discovery all share this directory, so
      // instances with different agent directories keep auth, models, sessions,
      // and extensions separate — and instances sharing one stay cross-continuable.
      const effectiveAgentDir = NodePath.resolve(
        effectiveConfig.agentDir ? expandHomePath(effectiveConfig.agentDir) : getAgentDir(),
      );
      const continuationIdentity = {
        driverKind: DRIVER_KIND,
        continuationKey: `pi:agent:${effectiveAgentDir}`,
      };
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });

      // One catalog host per instance: extension models enter the provider
      // snapshot here, so every picker lists them with no per-thread work.
      // Thread sessions keep full per-thread loading for tools and hooks.
      const executable = yield* HostProcessIsExecutable;
      const catalogHost = yield* Effect.acquireRelease(
        acquirePiResource(
          () =>
            PiRuntimeProcess.create(
              {
                disabledExtensions: effectiveConfig.disabledExtensions,
                agentDir: effectiveAgentDir,
              },
              executable,
            ),
          (host) => host.dispose(),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `Failed to load Pi extensions: ${cause.message}`,
                cause,
              }),
          ),
        ),
        (host) => disposePiResource(() => host.dispose()),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const readCurrentPiSettings = (settings: ServerSettings): PiSettings => {
        const instance = settings.providerInstances[instanceId];
        if (instance !== undefined && String(instance.driver) === DRIVER_KIND) {
          const decoded = decodePiSettingsOption(instance.config);
          if (Option.isSome(decoded)) return decoded.value;
        }
        const decoded = decodePiSettingsOption(settings.providers.pi);
        return Option.isSome(decoded) ? decoded.value : decodePiSettings({});
      };

      const adapter = yield* makePiAdapter(effectiveConfig, {
        instanceId,
        createSession: (input) =>
          catalogHost.createSession({ ...input, agentDir: effectiveAgentDir }),
        getSettings: serverSettings.getSettings.pipe(
          Effect.map(readCurrentPiSettings),
          Effect.orElseSucceed(() => effectiveConfig),
        ),
      });

      // Retire the adapter before replacement: stop accepting work, drain active
      // turns, dispose sessions, and terminate the old runtime event subscription.
      yield* Effect.addFinalizer(() => adapter.shutdown());
      const textGeneration = yield* makePiTextGeneration(effectiveConfig, {
        createSession: ({ cwd, model, thinkingLevel }) =>
          catalogHost.createSession(
            { cwd, model, thinkingLevel, agentDir: effectiveAgentDir, resumeSessionId: undefined },
            // Tool-free helper sessions share the catalog's model implementations inside the child.
            true,
          ),
      });

      const probeClient: PiProbeClient = {
        getCatalogModels: (thinkingLevel) => catalogHost.getCatalogModels(thinkingLevel),
      };
      const discoveryClient = makeSdkDiscoveryClient(
        () => catalogHost.getExtensionSlashCommands(),
        effectiveAgentDir,
      );
      const checkProvider = checkPiProviderStatus(
        effectiveConfig,
        probeClient,
        discoveryClient,
      ).pipe(Effect.map(stampIdentity));

      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialPiProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Pi snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      // Catalog registrations (including background refreshes) republish the
      // snapshot. The refresh semaphore serializes bursts; the health
      // interval backstops a missed push.
      const catalogChanges = yield* Queue.unbounded<void>();
      const unsubscribeCatalog = catalogHost.onChange(() => {
        Queue.offerUnsafe(catalogChanges, undefined);
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeCatalog));
      yield* Queue.take(catalogChanges).pipe(
        Effect.flatMap(() => snapshot.refresh.pipe(Effect.asVoid)),
        Effect.forever,
        Effect.forkScoped,
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd: (cwd) =>
          Effect.gen(function* () {
            const current = yield* snapshot.getSnapshot;
            if (!enabled) return current;
            const resources = yield* Effect.tryPromise({
              try: () => discoveryClient.discover({ cwd }),
              catch: (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: "Failed to discover project Pi resources.",
                  cause,
                }),
            });
            return {
              ...current,
              skills: resources.skills,
              slashCommands: [
                ...current.slashCommands.filter((command) => command.name === "compact"),
                ...resources.slashCommands.filter((command) => command.name !== "compact"),
              ],
            };
          }),
        adapter,
        textGeneration,
        piCatalog: {
          getCatalog: () =>
            Effect.tryPromise({
              try: () => catalogHost.getCatalog(),
              catch: (cause) =>
                new PiCatalogError({
                  message: cause instanceof Error ? cause.message : String(cause),
                }),
            }),
          refreshCatalog: () =>
            Effect.tryPromise({
              try: () => catalogHost.refreshCatalog(),
              catch: (cause) =>
                new PiCatalogError({
                  message: cause instanceof Error ? cause.message : String(cause),
                }),
            }),
        },
      } satisfies ProviderInstance;
    }),
};
