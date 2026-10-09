// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
// Durable pins a newer pi-ai independently; do not upgrade the existing Pi harness.
import { createModels, type Models } from "pi-durable-ai/models";
import durablePackage from "@earendil-works/pi-durable/package.json" with { type: "json" };
import { PiDurableSettings, TextGenerationError, type ServerProvider } from "@rove-code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePiDurableAdapter, PI_DURABLE_DRIVER } from "../Layers/PiDurableAdapter.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export type PiDurableDriverEnv = ServerConfig;
const decodeSettings = Schema.decodeSync(PiDurableSettings);
const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
  provider: PI_DURABLE_DRIVER,
  packageName: "@earendil-works/pi-durable",
});

/** Inject a Models collection for offline tests; production uses only built-in API-key auth. */
export function makePiDurableDriver(
  modelsForTest?: Models,
): ProviderDriver<PiDurableSettings, PiDurableDriverEnv> {
  return {
    driverKind: PI_DURABLE_DRIVER,
    metadata: { displayName: "Pi Durable", supportsMultipleInstances: true },
    configSchema: PiDurableSettings,
    defaultConfig: () => decodeSettings({}),
    create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
      Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig;
        const processEnv = mergeProviderInstanceEnvironment(environment);
        const models =
          modelsForTest ??
          (enabled
            ? yield* Effect.tryPromise({
                try: async () => {
                  const { builtinModels } = await import("pi-durable-ai/providers/all");
                  return builtinModels({
                    authContext: {
                      env: async (name) => processEnv[name],
                      fileExists: async (path) => {
                        try {
                          await NodeFSP.access(
                            path.startsWith("~/")
                              ? NodePath.join(processEnv.HOME ?? "", path.slice(2))
                              : path,
                          );
                          return true;
                        } catch {
                          return false;
                        }
                      },
                    },
                  });
                },
                catch: (cause) =>
                  new ProviderDriverError({
                    driver: PI_DURABLE_DRIVER,
                    instanceId,
                    detail: "Failed to load Pi Durable models.",
                    cause,
                  }),
              })
            : createModels());
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind: PI_DURABLE_DRIVER,
          instanceId,
        });
        const adapter = yield* makePiDurableAdapter({
          instanceId,
          directory: NodePath.join(stateDir, "pi-durable", instanceId),
          models,
          config,
          enabled,
          environment: processEnv,
        });
        const changes = yield* PubSub.unbounded<ServerProvider>();
        yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
        const getSnapshot = Effect.tryPromise({
          try: async (): Promise<ServerProvider> => {
            // Availability checks inspect configuration, never generate or refresh OAuth tokens.
            const available = enabled ? await models.getAvailable() : [];
            const invalidDefault =
              !!config.model &&
              !available.some((model) => `${model.provider}/${model.id}` === config.model);
            return {
              instanceId,
              driver: PI_DURABLE_DRIVER,
              displayName: displayName ?? "Pi Durable",
              ...(accentColor ? { accentColor } : undefined),
              badgeLabel: "Experimental",
              continuation: { groupKey: continuationIdentity.continuationKey },
              enabled,
              installed: true,
              availability: "available",
              version: durablePackage.version,
              checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
              status: !enabled
                ? "disabled"
                : available.length && !invalidDefault
                  ? "ready"
                  : "warning",
              auth: {
                status: available.length ? "authenticated" : "unauthenticated",
                type: "api_key",
              },
              message: !enabled
                ? "Pi Durable is disabled."
                : invalidDefault
                  ? "The default model is unavailable. Choose an available model or configure its API key."
                  : available.length
                    ? "Experimental. Pending work resumes on the next message. Pi CLI extensions are not loaded."
                    : "Configure API keys in this instance's environment, then refresh.",
              runtimeModeSelectable: false,
              showInteractionModeToggle: false,
              supportsConversationRollback: false,
              supportsTextGeneration: false,
              setup: { canAuthenticate: false, canInstall: false },
              models: available.map((model) => ({
                slug: `${model.provider}/${model.id}`,
                name: model.name,
                subProvider: model.provider,
                isCustom: false,
                isDefault: `${model.provider}/${model.id}` === config.model,
                capabilities: null,
              })),
              slashCommands: [],
              skills: [],
            };
          },
          catch: () => undefined,
        }).pipe(
          Effect.orElseSucceed((): ServerProvider => ({
            instanceId,
            driver: PI_DURABLE_DRIVER,
            displayName: displayName ?? "Pi Durable",
            badgeLabel: "Experimental",
            enabled,
            installed: true,
            version: durablePackage.version,
            checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
            status: "error",
            auth: { status: "unknown" },
            message: "Failed to inspect Pi Durable API-key configuration.",
            runtimeModeSelectable: false,
            showInteractionModeToggle: false,
            models: [],
            skills: [],
            slashCommands: [],
            supportsTextGeneration: false,
            supportsConversationRollback: false,
          })),
        );
        const unavailable = (operation: TextGenerationError["operation"]) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Pi Durable helper text generation is not supported yet.",
            }),
          );
        return {
          instanceId,
          driverKind: PI_DURABLE_DRIVER,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          adapter,
          snapshot: {
            resolveMaintenance: () => Effect.succeed(maintenance),
            getSnapshot,
            refresh: getSnapshot.pipe(Effect.tap((snapshot) => PubSub.publish(changes, snapshot))),
            streamChanges: Stream.fromPubSub(changes),
            applyUsageLimits: () => Effect.void,
          },
          textGeneration: {
            generateCommitMessage: () => unavailable("generateCommitMessage"),
            generatePrContent: () => unavailable("generatePrContent"),
            generateBranchName: () => unavailable("generateBranchName"),
            generateThreadTitle: () => unavailable("generateThreadTitle"),
          },
        };
      }),
  };
}

export const PiDurableDriver = makePiDurableDriver();
