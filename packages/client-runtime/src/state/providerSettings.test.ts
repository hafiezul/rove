import {
  DEFAULT_SERVER_SETTINGS,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { readPiInstanceSettings, togglePiExtensionDisabled } from "./providerSettings.ts";

const decodePiConfig = Schema.decodeUnknownSync(PiSettings);

const NOISY = "/home/dev/.pi/agent/extensions/noisy.ts";
const DEFAULT_INSTANCE = ProviderInstanceId.make("pi");
const CUSTOM_INSTANCE = ProviderInstanceId.make("pi_work");

describe("readPiInstanceSettings", () => {
  it("falls back to the legacy providers.pi blob when no explicit entry exists", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        pi: { ...DEFAULT_SERVER_SETTINGS.providers.pi, disabledExtensions: [NOISY] },
      },
    };
    expect(readPiInstanceSettings(settings, DEFAULT_INSTANCE).disabledExtensions).toEqual([NOISY]);
  });

  it("prefers the explicit providerInstances entry", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        pi: { ...DEFAULT_SERVER_SETTINGS.providers.pi, disabledExtensions: ["legacy.ts"] },
      },
      providerInstances: {
        [DEFAULT_INSTANCE]: {
          driver: ProviderDriverKind.make("pi"),
          config: { disabledExtensions: ["explicit.ts"] },
        },
      },
    };
    expect(readPiInstanceSettings(settings, DEFAULT_INSTANCE).disabledExtensions).toEqual([
      "explicit.ts",
    ]);
  });

  it("still resolves the legacy blob for an unrelated instance id", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        pi: { ...DEFAULT_SERVER_SETTINGS.providers.pi, disabledExtensions: ["legacy.ts"] },
      },
    };
    expect(readPiInstanceSettings(settings, CUSTOM_INSTANCE).disabledExtensions).toEqual([
      "legacy.ts",
    ]);
  });
});

describe("togglePiExtensionDisabled", () => {
  it("writes the legacy blob for the default instance without an explicit entry", () => {
    const settings = { ...DEFAULT_SERVER_SETTINGS };
    const patch = togglePiExtensionDisabled({
      settings,
      instanceId: DEFAULT_INSTANCE,
      path: NOISY,
      disabled: true,
    });
    expect(patch.providers?.pi?.disabledExtensions).toEqual([NOISY]);
    expect(patch.providerInstances).toBeUndefined();

    const next = { ...settings, providers: { ...settings.providers, ...patch.providers } };
    expect(readPiInstanceSettings(next, DEFAULT_INSTANCE).disabledExtensions).toEqual([NOISY]);
  });

  it("re-enables by removing the path", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        pi: { ...DEFAULT_SERVER_SETTINGS.providers.pi, disabledExtensions: [NOISY] },
      },
    };
    const patch = togglePiExtensionDisabled({
      settings,
      instanceId: DEFAULT_INSTANCE,
      path: NOISY,
      disabled: false,
    });
    expect(patch.providers?.pi?.disabledExtensions).toEqual([]);
  });

  it("updates an explicit instance entry without dropping the envelope", () => {
    const instance = {
      driver: ProviderDriverKind.make("pi"),
      displayName: "Work Pi",
      enabled: true,
      config: { customModels: ["acme/plan"] },
    };
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [CUSTOM_INSTANCE]: instance },
    };
    const patch = togglePiExtensionDisabled({
      settings,
      instanceId: CUSTOM_INSTANCE,
      path: NOISY,
      disabled: true,
    });
    expect(patch.providers).toBeUndefined();
    const nextInstance = patch.providerInstances?.[CUSTOM_INSTANCE];
    expect(nextInstance?.displayName).toBe("Work Pi");
    expect(nextInstance?.enabled).toBe(true);
    const nextConfig = decodePiConfig(nextInstance?.config);
    expect(nextConfig.customModels).toEqual(["acme/plan"]);
    expect(nextConfig.disabledExtensions).toEqual([NOISY]);
  });
});
