/**
 * PiProvider — snapshot and status probe for the Pi driver.
 *
 * Pi runs in-process via the SDK, so "installed" means the SDK loaded and a
 * model runtime could be created against the user's global config, and the
 * model list is the user's configured Pi catalog (settings/auth/models.json).
 * There is no binary to probe and no per-instance version: the Pi version is
 * the pinned dependency Rove ships.
 *
 * @module provider/Layers/PiProvider
 */
import {
  type ModelCapabilities,
  type PiSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  // Pi has no tool-approval model; threads run full-access.
  showInteractionModeToggle: false,
  // set_model works on a live session.
  requiresNewThreadForModelChange: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) => {
    const checkedAt = DateTime.formatIso(now);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: piSettings.customModels.map((slug) => ({
        slug,
        name: slug,
        isCustom: true,
        capabilities: EMPTY_CAPABILITIES,
      })),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: piSettings.enabled ? "Probing the Pi SDK…" : "Pi is disabled in T3 Code settings.",
      },
    });
  });
}

export interface PiProbeClient {
  /** Models available in the user's Pi catalog. */
  listModels(): Promise<ReadonlyArray<{ id: string; name: string; provider: string }>>;
  /** Provider display name, used for auth status text. */
  defaultModelProvider(): Promise<string | undefined>;
}

export function checkPiProviderStatus(
  piSettings: PiSettings,
  probeClient: PiProbeClient,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);

    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }

    const probed = yield* Effect.promise(async () => {
      try {
        const models = await probeClient.listModels();
        const provider = await probeClient.defaultModelProvider();
        return { ok: true as const, models, provider };
      } catch (error) {
        return { ok: false as const, error };
      }
    });

    if (!probed.ok) {
      const detail = probed.error instanceof Error ? probed.error.message : String(probed.error);
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: [],
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: `Pi SDK failed to load: ${detail}`,
        },
      });
    }

    const models: ServerProviderModel[] = probed.models.map(
      (model: { id: string; name: string; provider: string }) => ({
        slug: `${model.provider}/${model.id}`,
        name: model.name,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      }),
    );

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: models.length > 0 ? "ready" : "warning",
        auth: { status: probed.provider !== undefined ? "authenticated" : "unknown" },
        ...(models.length === 0
          ? { message: "Pi SDK loaded but no models are configured in your Pi catalog." }
          : {}),
      },
    });
  });
}
