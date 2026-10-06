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
import * as NodeOS from "node:os";
import {
  PiCatalogError,
  PiSettings,
  ProviderDriverKind,
  type ServerProvider,
} from "@rove-code/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type { ServerSettings } from "@rove-code/contracts";

import { acquirePiResource, disposePiResource } from "../Layers/PiLifecycle.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import { LazyPiRuntime, PiRuntimeProcess } from "../Layers/PiRuntimeProcess.ts";
import { PI_CONFIG_DIR } from "../PiSdkMetadata.ts";
import { HostProcessIsExecutable } from "@rove-code/shared/hostProcess";
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

const PI_RUNTIME_IDLE_MS = 60_000;
const DRIVER_KIND = ProviderDriverKind.make("pi");
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "@earendil-works/pi-coding-agent",
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
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      // Sessions, the catalog host, and discovery all share this directory, so
      // instances with different agent directories keep auth, models, sessions,
      // and extensions separate — and instances sharing one stay cross-continuable.
      const effectiveAgentDir = NodePath.resolve(
        expandHomePath(
          effectiveConfig.agentDir ||
            processEnv.PI_CODING_AGENT_DIR ||
            NodePath.join(NodeOS.homedir(), PI_CONFIG_DIR, "agent"),
        ),
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
      // The catalog host stops after PI_RUNTIME_IDLE_MS with no requests and no open
      // sessions, and restarts on the next Pi use.
      const executable = yield* HostProcessIsExecutable;
      const runtime = enabled
        ? new LazyPiRuntime(
            () =>
              PiRuntimeProcess.create(
                {
                  disabledExtensions: effectiveConfig.disabledExtensions,
                  agentDir: effectiveAgentDir,
                },
                executable,
                processEnv,
              ),
            PI_RUNTIME_IDLE_MS,
          )
        : undefined;
      // Start once now so extension load failures still fail the instance at creation.
      if (runtime !== undefined) {
        yield* Effect.acquireRelease(
          acquirePiResource(
            () => runtime.get(),
            () => runtime.dispose(),
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
          () => disposePiResource(() => runtime.dispose()),
        );
      }
      const getCatalogHost = (): Promise<PiRuntimeProcess> =>
        runtime === undefined
          ? Promise.reject(new Error("Pi is disabled in Rove Code settings."))
          : runtime.get();
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
          getCatalogHost().then((host) =>
            host.createSession({ ...input, agentDir: effectiveAgentDir }),
          ),
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
          getCatalogHost().then((host) =>
            host.createSession(
              {
                cwd,
                model,
                thinkingLevel,
                agentDir: effectiveAgentDir,
                resumeSessionId: undefined,
              },
              // Tool-free helper sessions share the catalog's model implementations inside the child.
              true,
            ),
          ),
      });

      const probeClient: PiProbeClient = {
        getCatalogModels: (thinkingLevel) =>
          getCatalogHost().then((host) => host.getCatalogModels(thinkingLevel)),
      };
      const discoveryClient: PiDiscoveryClient = {
        discover: (input) => getCatalogHost().then((host) => host.discover(input)),
      };
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
        // Interval checks would restart a stopped runtime every few minutes. Manual
        // refreshes, settings changes, and catalog pushes still check.
        refreshOnInterval: () => runtime?.isRunning ?? false,
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
      if (runtime !== undefined) {
        const catalogChanges = yield* Queue.unbounded<void>();
        const unsubscribeCatalog = runtime.onChange(() => {
          Queue.offerUnsafe(catalogChanges, undefined);
        });
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribeCatalog));
        yield* Queue.take(catalogChanges).pipe(
          Effect.flatMap(() => snapshot.refresh.pipe(Effect.asVoid)),
          Effect.forever,
          Effect.forkScoped,
        );
      }

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        checkUsageLimit: (model, observedAt) =>
          Effect.tryPromise(() =>
            getCatalogHost().then((host) => host.getUsageLimit(model, observedAt)),
          ).pipe(Effect.orElseSucceed(() => ({ type: "unavailable" as const }))),
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
              try: () => getCatalogHost().then((host) => host.getCatalog()),
              catch: (cause) =>
                new PiCatalogError({
                  message: cause instanceof Error ? cause.message : String(cause),
                }),
            }),
          refreshCatalog: () =>
            Effect.tryPromise({
              try: () => getCatalogHost().then((host) => host.refreshCatalog()),
              catch: (cause) =>
                new PiCatalogError({
                  message: cause instanceof Error ? cause.message : String(cause),
                }),
            }),
        },
      } satisfies ProviderInstance;
    }),
};
