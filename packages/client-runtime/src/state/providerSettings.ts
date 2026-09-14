/**
 * Pi provider instance settings helpers shared by the web and mobile
 * clients. Reads the Pi config blob a Pi instance currently runs with and
 * builds settings patches for the per-extension disable toggles in the
 * Pi provider catalog panel.
 *
 * The config blob lives in `settings.providerInstances[id].config` for
 * explicit entries, or in the legacy `settings.providers.pi` blob when the
 * default Pi instance has no explicit entry yet. Both shapes decode through
 * the same `PiSettings` schema, and every field has a default, so reading
 * never throws for well-formed settings.
 *
 * @module state/providerSettings
 */
import type { ProviderInstanceId, UnifiedSettings } from "@t3tools/contracts";
import { PiSettings } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const PI_DRIVER = "pi";

const decodePiSettings = Schema.decodeSync(PiSettings);
const decodePiSettingsUnknown = Schema.decodeUnknownOption(PiSettings);

function decodePiInstanceSettings(config: unknown): PiSettings {
  const decodedOption = decodePiSettingsUnknown(config);
  return Option.isSome(decodedOption) ? decodedOption.value : decodePiSettings({});
}

/**
 * The Pi config a Pi instance currently runs with. Explicit
 * `providerInstances` entries win over the legacy `providers.pi` blob,
 * matching the server registry's hydration order.
 */
export function readPiInstanceSettings(
  settings: Pick<UnifiedSettings, "providers" | "providerInstances">,
  instanceId: ProviderInstanceId,
): PiSettings {
  const instance = settings.providerInstances[instanceId];
  if (instance !== undefined && String(instance.driver) === PI_DRIVER) {
    return decodePiInstanceSettings(instance.config);
  }
  return decodePiInstanceSettings(settings.providers.pi);
}

type ProviderSettingsPatch = Partial<Pick<UnifiedSettings, "providers" | "providerInstances">>;
type ProviderSettingsPatchMutable = {
  -readonly [K in keyof ProviderSettingsPatch]?: ProviderSettingsPatch[K];
};

/**
 * Patch for enabling/disabling one extension on a Pi instance. Writes the
 * explicit instance entry when one exists and mirrors into the legacy
 * `providers.pi` blob for the default instance (`pi`), so both sources of
 * truth stay consistent. Server hot-reloads the provider instance from the
 * patch, so the next turn's session picks up the change.
 */
export function togglePiExtensionDisabled(input: {
  readonly settings: Pick<UnifiedSettings, "providers" | "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  /** Extension path as listed by the Pi catalog. */
  readonly path: string;
  readonly disabled: boolean;
}): Partial<UnifiedSettings> {
  const currentDisabled = readPiInstanceSettings(
    input.settings,
    input.instanceId,
  ).disabledExtensions;
  const nextDisabled = input.disabled
    ? [...new Set([...currentDisabled, input.path])]
    : currentDisabled.filter((path) => path !== input.path);

  const patch: ProviderSettingsPatchMutable = {};
  const instance = input.settings.providerInstances[input.instanceId];
  if (instance !== undefined && String(instance.driver) === PI_DRIVER) {
    patch.providerInstances = {
      ...input.settings.providerInstances,
      [input.instanceId]: {
        ...instance,
        config: { ...decodePiInstanceSettings(instance.config), disabledExtensions: nextDisabled },
      },
    };
  }
  if (String(input.instanceId) === PI_DRIVER) {
    patch.providers = {
      ...input.settings.providers,
      pi: { ...input.settings.providers.pi, disabledExtensions: nextDisabled },
    };
  }
  return patch;
}
