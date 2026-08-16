/**
 * PiDriver — `ProviderDriver` for the Pi runtime (in-process via the SDK).
 *
 * See docs/adr/0001-pi-provider-uses-sdk-in-process.md. The driver's `create()`
 * bundles `snapshot` / `adapter` / `textGeneration` closures over the decoded
 * `PiSettings`. Sessions are built by `createPiSession` (sterile Pi, global
 * config, always-trust); the snapshot probe enumerates the user's Pi model
 * catalog through a `ModelRuntime`.
 *
 * @module provider/Drivers/PiDriver
 */
import { PiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import { createPiSession } from "../Layers/PiSessionFactory.ts";
import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  type PiDiscoveryClient,
  type PiProbeClient,
} from "../Layers/PiProvider.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const decodePiSettings = Schema.decodeSync(PiSettings);

const DRIVER_KIND = ProviderDriverKind.make("pi");
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: "@earendil-works/pi-coding-agent",
  }),
);

/**
 * Probe client backed by the real SDK model catalog. `ModelRuntime.create`
 * resolves the user's auth + models.json against the global agent dir, so the
 * model list is exactly what terminal `pi` would offer.
 */
const makeSdkProbeClient = (): PiProbeClient => ({
  listModels: async () => {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create({});
    const models = await runtime.getAvailable();
    return models.map((model) => ({
      id: model.id,
      name: model.name,
      provider: String(model.provider),
    }));
  },
  defaultModelProvider: async () => {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create({});
    const models = await runtime.getAvailable();
    return models.length > 0 ? String(models[0]?.provider) : undefined;
  },
});

/**
 * Discovery client backed by the SDK's `DefaultResourceLoader` — the same
 * loader sterile Pi sessions use (global config, no extensions), so the `$`
 * and `/` pickers list exactly what the agent can invoke. Skills map 1:1;
 * prompt templates become slash commands with the template's argument hint.
 */
const makeSdkDiscoveryClient = (): PiDiscoveryClient => ({
  discover: async ({ cwd }) => {
    const { DefaultResourceLoader, getAgentDir } = await import("@earendil-works/pi-coding-agent");
    const loader = new DefaultResourceLoader({
      cwd: cwd ?? process.cwd(),
      agentDir: getAgentDir(),
      noExtensions: true,
    });
    // Resources populate lazily: getSkills()/getPrompts() return empty until
    // reload() has scanned the configured roots.
    await loader.reload();
    const [{ skills }, { prompts }] = [loader.getSkills(), loader.getPrompts()];
    return {
      skills: skills.map((skill) => ({
        name: skill.name,
        ...(skill.description.trim().length > 0 ? { description: skill.description } : {}),
        path: skill.filePath,
        // "temporary" (e.g. in-memory extension resources) maps to "user":
        // it is not project content, and the composer only renders the label.
        scope: skill.sourceInfo.scope === "project" ? "project" : "user",
        enabled: true,
      })),
      slashCommands: prompts.map((prompt) => ({
        name: prompt.name,
        ...(prompt.description.trim().length > 0 ? { description: prompt.description } : {}),
        ...(prompt.argumentHint !== undefined && prompt.argumentHint.trim().length > 0
          ? { input: { hint: prompt.argumentHint } }
          : {}),
      })),
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
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export type PiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
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
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        env: process.env,
      });

      const adapter = yield* makePiAdapter(effectiveConfig, {
        instanceId,
        createSession: createPiSession,
      });
      const textGeneration = yield* makePiTextGeneration(effectiveConfig, {
        createSession: ({ cwd }) =>
          createPiSession({
            cwd,
            model: undefined,
            thinkingLevel: undefined,
            resumeSessionFile: undefined,
          }),
      });

      const probeClient = makeSdkProbeClient();
      const checkProvider = checkPiProviderStatus(
        effectiveConfig,
        probeClient,
        makeSdkDiscoveryClient(),
      ).pipe(Effect.map(stampIdentity));

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({
        maintenanceCapabilities,
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

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
