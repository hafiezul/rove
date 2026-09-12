import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigBoolean,
  readProviderConfigString,
  resolvePiThinkingSetting,
  ProviderSettingsForm,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  const piModels: ReadonlyArray<ServerProviderModel> = [
    {
      slug: "local/reasoning",
      name: "Reasoning",
      isCustom: false,
      isDefault: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "thinkingLevel",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low", isDefault: true },
              { id: "max", label: "Max" },
            ],
            currentValue: "low",
          },
        ],
      },
    },
    {
      slug: "local/plain",
      name: "Plain",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "thinkingLevel",
            label: "Reasoning",
            type: "select",
            options: [{ id: "off", label: "Off", isDefault: true }],
            currentValue: "off",
          },
        ],
      },
    },
  ];

  it("limits Pi settings to the selected model and distinguishes a stale override", () => {
    const current = resolvePiThinkingSetting(
      { model: "local/reasoning", thinkingLevel: "max" },
      piModels,
    );
    expect(current.options.map((option) => option.id)).toEqual(["low", "max"]);
    expect(current.unavailable).toBe(false);
    const changed = resolvePiThinkingSetting(
      { model: "local/plain", thinkingLevel: "max" },
      piModels,
    );
    expect(changed.options.map((option) => option.id)).toEqual(["off"]);
    expect(changed.unavailable).toBe(true);
    expect(changed.selected).toBe("max");
  });

  it("uses the catalog default model but never guesses for unknown or pending models", () => {
    expect(resolvePiThinkingSetting({}, piModels).options.map((option) => option.id)).toEqual([
      "low",
      "max",
    ]);
    expect(resolvePiThinkingSetting({ model: "missing" }, piModels).options).toEqual([]);
    expect(resolvePiThinkingSetting({}, []).options).toEqual([]);
  });

  it("allows clearing an unsupported Pi setting without discarding other config", () => {
    const pi = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("pi")]!;
    const field = deriveProviderSettingsFields(pi).find((field) => field.key === "thinkingLevel")!;
    const next = nextProviderConfigWithFieldValue(
      { model: "local/plain", thinkingLevel: "max" },
      field,
      "",
    );
    expect(next).toEqual({ model: "local/plain" });
    expect(resolvePiThinkingSetting(next, piModels).selected).toBe("");
  });

  it("renders Pi thinking as a labeled selector in both Settings entry points", () => {
    const definition = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("pi")]!;
    for (const variant of ["card", "dialog"] as const) {
      const markup = renderToStaticMarkup(
        createElement(ProviderSettingsForm, {
          definition,
          models: piModels,
          value: { model: "local/plain", thinkingLevel: "max" },
          idPrefix: "pi-settings",
          variant,
          onChange: () => {},
        }),
      );
      expect(markup).toContain("max (unavailable)");
      expect(markup).toContain('role="combobox"');
      expect(markup).not.toMatch(/<input[^>]*id="pi-settings-thinkingLevel"/);
    }
    const unset = renderToStaticMarkup(
      createElement(ProviderSettingsForm, {
        definition,
        value: {},
        idPrefix: "pi-settings",
        variant: "dialog",
        onChange: () => {},
      }),
    );
    expect(unset).toContain("Use Pi default");
  });

  it("derives visible provider config fields from the client definition schema", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];

    expect(codex).toBeDefined();
    expect(deriveProviderSettingsFields(codex!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
      "launchArgs",
    ]);
  });

  it("sources labels and descriptions from schema annotations", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverPassword = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverPassword",
    );

    expect(serverPassword).toMatchObject({
      label: "Server password",
      description: "Stored in plain text on disk.",
      control: "password",
    });
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("reads non-string config values as blank strings", () => {
    expect(readProviderConfigString({ binaryPath: 123 }, "binaryPath")).toBe("");
  });

  it("omits false boolean fields when clearWhenEmpty is omit", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: true },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: false,
      },
      false,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits true boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: false },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      true,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("preserves false boolean fields when clearWhenEmpty is persist", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "persist",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("reads non-boolean config values as false booleans", () => {
    expect(readProviderConfigBoolean({ experimental: "true" }, "experimental")).toBe(false);
  });

  it("reads missing boolean config values from the supplied default", () => {
    expect(readProviderConfigBoolean({}, "experimental", true)).toBe(true);
  });
});
