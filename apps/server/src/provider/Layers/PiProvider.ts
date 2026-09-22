/**
 * PiProvider — snapshot and status probe for the Pi driver.
 *
 * Pi runs in-process via the SDK, so "installed" means the SDK loaded and a
 * model runtime could be created against the user's global config, and the
 * model list is the user's configured Pi catalog (settings/auth/models.json).
 * There is no binary to probe and no per-instance version: the Pi version is
 * the pinned dependency Rove Code ships.
 *
 * @module provider/Layers/PiProvider
 */
import {
  PI_THINKING_LEVELS,
  type PiSettings,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { VERSION as PI_SDK_VERSION } from "@earendil-works/pi-coding-agent";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  // Pi has no tool-approval model; threads run full-access.
  showInteractionModeToggle: false,
  runtimeModeSelectable: false,
  // set_model works on a live session.
  requiresNewThreadForModelChange: false,
} as const;

interface PiDiscoveryResult {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

const EMPTY_PI_DISCOVERY: PiDiscoveryResult = {
  skills: [],
  slashCommands: [],
};

/**
 * Option descriptor id the composer dispatches for Pi's per-thread thinking
 * level. The adapter reads it back out of `modelSelection.options` under the
 * same id and applies it via `session.setThinkingLevel`.
 */
export const PI_THINKING_DESCRIPTOR_ID = "thinkingLevel";

export const PI_THINKING_LEVEL_LABELS = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
} satisfies Record<(typeof PI_THINKING_LEVELS)[number], string>;

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
        capabilities: null,
      })),
      probe: {
        installed: false,
        version: PI_SDK_VERSION,
        status: "warning",
        auth: { status: "unknown" },
        message: piSettings.enabled
          ? "Probing the Pi SDK…"
          : "Pi is disabled in Rove Code settings.",
      },
    });
  });
}

export interface PiProbeClient {
  getCatalogModels(
    thinkingLevel: PiSettings["thinkingLevel"],
  ): Promise<ReadonlyArray<ServerProviderModel>>;
}

/**
 * Discovers the Pi resources the composer pickers render: skills for `$`,
 * prompt templates for `/`. Backed by the SDK's `DefaultResourceLoader` in
 * the driver (same loader sessions use, so the pickers match what the agent
 * sees); injected here so the probe stays testable.
 */
export interface PiDiscoveryClient {
  discover(input: { cwd: string | undefined }): Promise<{
    skills: ReadonlyArray<ServerProviderSkill>;
    slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  }>;
}

export function checkPiProviderStatus(
  piSettings: PiSettings,
  probeClient: PiProbeClient,
  discoveryClient?: PiDiscoveryClient,
) {
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
          version: PI_SDK_VERSION,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in Rove Code settings.",
        },
      });
    }

    const probed = yield* Effect.promise(async () => {
      try {
        const models = await probeClient.getCatalogModels(piSettings.thinkingLevel);
        return { ok: true as const, models };
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
          version: PI_SDK_VERSION,
          status: "error",
          auth: { status: "unknown" },
          message: `Pi SDK failed to load: ${detail}`,
        },
      });
    }

    const models = probed.models;

    // Discovery is best-effort: a broken skill/prompt file or loader error
    // must not degrade the provider snapshot — empty pickers instead.
    const discovered = yield* Effect.tryPromise({
      try: () =>
        discoveryClient !== undefined
          ? discoveryClient.discover({ cwd: undefined })
          : Promise.resolve({ skills: [], slashCommands: [] }),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => EMPTY_PI_DISCOVERY));

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      slashCommands: [
        { name: "compact", description: "Compact the conversation context" },
        ...discovered.slashCommands.filter((command) => command.name !== "compact"),
      ],
      skills: discovered.skills,
      probe: {
        installed: true,
        version: PI_SDK_VERSION,
        status: models.length > 0 ? "ready" : "warning",
        auth: { status: models.length > 0 ? "authenticated" : "unknown" },
        ...(models.length === 0
          ? { message: "Pi SDK loaded but no models are configured in your Pi catalog." }
          : undefined),
      },
    });
  });
}
