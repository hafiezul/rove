import { PiSettings, ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ServerConfig } from "../../config.ts";
import { ProcessRunner } from "../../processRunner.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePiAdapter, makePiImageAttachmentLoader } from "../Layers/PiAdapter.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makePiSessionRuntime } from "./PiSessionRuntime.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { checkPiProviderStatus, discoverPiCatalog, makePendingPiProvider } from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const DRIVER_KIND = ProviderDriverKind.make("pi");

export type PiDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProcessRunner
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export function resolvePiSessionDirectory(input: {
  readonly stateDir: string;
  readonly instanceId: ProviderInstanceId;
  readonly join: (...paths: ReadonlyArray<string>) => string;
}): string {
  return input.join(input.stateDir, "pi-sessions", input.instanceId);
}

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft) => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Pi", supportsMultipleInstances: true },
  configSchema: PiSettings,
  defaultConfig: () => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processRunner = yield* ProcessRunner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const processEnv = mergeProviderInstanceEnvironment(environment);
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
      const sessionDirectory = resolvePiSessionDirectory({
        stateDir: serverConfig.stateDir,
        instanceId,
        join: path.join,
      });
      const skillNamesRef: { current: ReadonlyArray<string> } = { current: [] };
      const adapter = yield* makePiAdapter(effectiveConfig, {
        instanceId,
        sessionDirectory,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        loadImageAttachment: makePiImageAttachmentLoader({
          attachmentsDir: serverConfig.attachmentsDir,
          fileSystem,
        }),
        // Bound to the managed snapshot below, once both exist. The adapter
        // only reads skill names per sendTurn, so the late binding still
        // reflects every snapshot refresh.
        getSkillNames: () => Effect.succeed(skillNamesRef.current),
        makeRuntime: makePiSessionRuntime,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner));
      const textGeneration = yield* makePiTextGeneration(effectiveConfig, processEnv).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const checkProvider = checkPiProviderStatus(
        effectiveConfig,
        processEnv,
        discoverPiCatalog,
        serverConfig.cwd,
      ).pipe(
        Effect.provideService(ProcessRunner, processRunner),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        Effect.map(stampIdentity),
      );
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: "@earendil-works/pi-coding-agent",
        }),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingPiProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        refreshInterval: Duration.minutes(5),
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
      const trackSkillNames = (provider: {
        readonly skills: ReadonlyArray<{ readonly name: string }>;
      }) => {
        skillNamesRef.current = provider.skills.map((skill) => skill.name);
      };
      trackSkillNames(yield* snapshot.getSnapshot);
      yield* snapshot.streamChanges.pipe(
        Stream.runForEach((next) => Effect.sync(() => trackSkillNames(next))),
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
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
