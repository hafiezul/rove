/**
 * PiProvider — snapshot surface tests: model capabilities (thinking-level
 * descriptor), skills, and slash commands the composer pickers render from.
 *
 * The probe client is faked; resource discovery is faked via the injected
 * discovery client so no global Pi config is touched.
 */
import { PiSettings } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  PI_THINKING_DESCRIPTOR_ID,
  type PiDiscoveryClient,
  type PiProbeClient,
} from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

const makeProbeClient = (overrides?: Partial<PiProbeClient>): PiProbeClient => ({
  listModels: async () => [
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      provider: "anthropic",
      providerName: "Anthropic",
    },
    { id: "gpt-5.2", name: "GPT-5.2", provider: "openai" },
    // Same model name on two providers — the picker disambiguates via
    // the subProvider label.
    {
      id: "alpha-free",
      name: "Alpha Free",
      provider: "opencode",
      providerName: "OpenCode Zen",
    },
    {
      id: "alpha-free",
      name: "Alpha Free",
      provider: "opencode-go",
      providerName: "OpenCode Go",
    },
  ],
  defaultModelProvider: async () => "anthropic",
  ...overrides,
});

const EMPTY_DISCOVERY: PiDiscoveryClient = {
  discover: async () => ({ skills: [], slashCommands: [] }),
};

it.effect("does not offer runtime modes Pi cannot enforce", () =>
  Effect.gen(function* () {
    const initialSnapshot = yield* buildInitialPiProviderSnapshot(decodePiSettings({}));
    assert.strictEqual(initialSnapshot.runtimeModeSelectable, false);

    const snapshot = yield* checkPiProviderStatus(
      decodePiSettings({}),
      makeProbeClient(),
      EMPTY_DISCOVERY,
    );

    assert.strictEqual(snapshot.runtimeModeSelectable, false);
  }),
);

it.effect("surfaces a thinking-level option descriptor on every probed model", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkPiProviderStatus(
      decodePiSettings({}),
      makeProbeClient(),
      EMPTY_DISCOVERY,
    );

    assert.isTrue(snapshot.models.length > 0);
    for (const model of snapshot.models) {
      const descriptor = model.capabilities?.optionDescriptors?.find(
        (candidate) => candidate.id === PI_THINKING_DESCRIPTOR_ID,
      );
      assert.isDefined(descriptor, `model ${model.slug} has no thinking descriptor`);
      assert.strictEqual(descriptor!.type, "select");
      if (descriptor!.type === "select") {
        assert.deepEqual(
          descriptor!.options.map((option) => option.id),
          ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        );
      }
    }
  }),
);

it.effect("defaults the thinking descriptor to the instance thinkingLevel setting", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkPiProviderStatus(
      decodePiSettings({ thinkingLevel: "high" }),
      makeProbeClient(),
      EMPTY_DISCOVERY,
    );

    const descriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.find(
      (candidate) => candidate.id === PI_THINKING_DESCRIPTOR_ID,
    );
    assert.strictEqual(descriptor?.type, "select");
    if (descriptor?.type === "select") {
      assert.strictEqual(descriptor.currentValue, "high");
    }
  }),
);

it.effect("labels each model with its Pi provider so duplicate names stay distinguishable", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkPiProviderStatus(
      decodePiSettings({}),
      makeProbeClient(),
      EMPTY_DISCOVERY,
    );

    const bySlug = new Map(snapshot.models.map((model) => [model.slug, model]));
    assert.strictEqual(bySlug.get("opencode/alpha-free")?.subProvider, "OpenCode Zen");
    assert.strictEqual(bySlug.get("opencode-go/alpha-free")?.subProvider, "OpenCode Go");
    // No registered display name falls back to the provider id.
    assert.strictEqual(bySlug.get("openai/gpt-5.2")?.subProvider, "openai");
  }),
);

it.effect("surfaces discovered skills and prompt templates for the composer pickers", () =>
  Effect.gen(function* () {
    const discovery: PiDiscoveryClient = {
      discover: async () => ({
        skills: [
          {
            name: "diagnosing-bugs",
            description: "Diagnosis loop for hard bugs.",
            path: "/home/user/.pi/agent/skills/diagnosing-bugs/SKILL.md",
            scope: "user",
            enabled: true,
          },
        ],
        slashCommands: [
          {
            name: "review",
            description: "Review the current diff.",
            input: { hint: "[path]" },
          },
        ],
      }),
    };

    const snapshot = yield* checkPiProviderStatus(
      decodePiSettings({}),
      makeProbeClient(),
      discovery,
    );

    assert.deepEqual(
      snapshot.skills.map((skill) => skill.name),
      ["diagnosing-bugs"],
    );
    assert.strictEqual(snapshot.skills[0]?.scope, "user");
    assert.deepEqual(
      snapshot.slashCommands.map((command) => command.name),
      ["review"],
    );
    assert.strictEqual(snapshot.slashCommands[0]?.input?.hint, "[path]");
  }),
);

it.effect("treats a discovery failure as empty pickers, not a snapshot failure", () =>
  Effect.gen(function* () {
    const discovery: PiDiscoveryClient = {
      discover: async () => {
        throw new Error("resource loader exploded");
      },
    };

    const snapshot = yield* checkPiProviderStatus(
      decodePiSettings({}),
      makeProbeClient(),
      discovery,
    );

    assert.strictEqual(snapshot.status, "ready");
    assert.deepEqual(snapshot.skills, []);
    assert.deepEqual(snapshot.slashCommands, []);
  }),
);
