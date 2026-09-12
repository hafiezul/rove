import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";
import { testDouble } from "../testDouble";

import {
  buildModelOptions,
  normalizePiModelSelection,
  groupByProvider,
  resolveDefaultableModelSelection,
  resolveSelectableModelSelection,
} from "./modelOptions";

describe("mobile model options", () => {
  it("uses supported Pi defaults for display and dispatch without changing other providers", () => {
    const config = testDouble<ServerConfig>({
      providers: [
        {
          instanceId: "pi-work",
          driver: "pi",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
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
          ],
        },
      ],
    });
    const stale = {
      instanceId: ProviderInstanceId.make("pi-work"),
      model: "local/plain",
      options: [{ id: "thinkingLevel", value: "max" }],
    };
    expect(normalizePiModelSelection(config, stale).options).toEqual([
      { id: "thinkingLevel", value: "off" },
    ]);
    expect(
      normalizePiModelSelection(config, { ...stale, model: "missing" }).options,
    ).toBeUndefined();
    expect(normalizePiModelSelection(null, stale)).toBe(stale);
    const other = { ...stale, instanceId: ProviderInstanceId.make("codex") };
    expect(normalizePiModelSelection(config, other)).toBe(other);
    expect(buildModelOptions(config, stale)[0]?.selection).toEqual(
      normalizePiModelSelection(config, stale),
    );
  });

  it("groups models by provider and flags legacy entries", () => {
    const config = testDouble<ServerConfig>({
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    });

    expect(groupByProvider(buildModelOptions(config, null))).toMatchObject([
      {
        providerKey: "codex",
        providerLabel: "Codex",
        models: [
          { key: "codex:gpt-5.6-sol", label: "GPT-5.6 Sol", isLegacy: false },
          { key: "codex:gpt-5.4", label: "GPT-5.4", isLegacy: true },
        ],
      },
    ]);
  });

  it("normalizes a legacy fallback selection against current capabilities", () => {
    const config = testDouble<ServerConfig>({
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });

  it("rejects stored selections whose provider is not usable", () => {
    const config = testDouble<ServerConfig>({
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: false,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
      ],
    });

    const usable = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    };
    const disabled = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    };
    const removed = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.6-sol",
    };

    expect(resolveSelectableModelSelection(config, usable)).toBe(usable);
    expect(resolveSelectableModelSelection(config, disabled)).toBeNull();
    expect(resolveSelectableModelSelection(config, removed)).toBeNull();
    // No config (environment offline) — nothing to validate against.
    expect(resolveSelectableModelSelection(null, disabled)).toBe(disabled);
  });

  it("keeps legacy models out of implicit defaults", () => {
    const config = testDouble<ServerConfig>({
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: null },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    });

    const current = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" };
    const legacy = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

    expect(resolveDefaultableModelSelection(config, current)).toBe(current);
    // A legacy last-used selection falls through to the provider default.
    expect(resolveDefaultableModelSelection(config, legacy)).toBeNull();
    // Offline: nothing to validate against, selection passes through.
    expect(resolveDefaultableModelSelection(null, legacy)).toBe(legacy);
  });
});
