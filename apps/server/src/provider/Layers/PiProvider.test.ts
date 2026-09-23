import { PiSettings, type ServerProviderModel } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { VERSION } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  type PiDiscoveryClient,
  type PiProbeClient,
} from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const catalogModels: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "test/plain",
    name: "Plain",
    subProvider: "Test",
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
  {
    slug: "test/reasoning",
    name: "Reasoning",
    subProvider: "Test",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "thinkingLevel",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "low", label: "Low", isDefault: true },
            { id: "high", label: "High" },
            { id: "max", label: "Max" },
          ],
          currentValue: "low",
        },
      ],
    },
  },
];
const makeProbeClient = (overrides?: Partial<PiProbeClient>): PiProbeClient => ({
  getCatalogModels: async () => catalogModels,
  ...overrides,
});
const EMPTY_DISCOVERY: PiDiscoveryClient = {
  discover: async () => ({ skills: [], slashCommands: [] }),
};

it.effect("preserves catalog capabilities and defaults without adding tiers", () =>
  Effect.gen(function* () {
    let calls = 0;
    const snapshot = yield* checkPiProviderStatus(
      decodePiSettings({ thinkingLevel: "max" }),
      makeProbeClient({
        getCatalogModels: async (thinkingLevel) => {
          calls++;
          assert.strictEqual(thinkingLevel, "max");
          return catalogModels;
        },
      }),
      EMPTY_DISCOVERY,
    );
    assert.deepEqual(snapshot.models, catalogModels);
    assert.strictEqual(calls, 1);
    assert.strictEqual(snapshot.version, VERSION);
    assert.strictEqual(snapshot.status, "ready");
    assert.strictEqual(snapshot.auth.status, "authenticated");
    assert.strictEqual(snapshot.runtimeModeSelectable, false);
    assert.strictEqual(snapshot.reportsContextWindow, true);
  }),
);

it.effect("does not advertise reasoning for unknown custom models before discovery", () =>
  Effect.gen(function* () {
    const snapshot = yield* buildInitialPiProviderSnapshot(
      decodePiSettings({ customModels: ["unknown/model"], thinkingLevel: "max" }),
    );
    assert.strictEqual(snapshot.models[0]?.capabilities, null);
    assert.strictEqual(snapshot.version, VERSION);
    assert.strictEqual(snapshot.runtimeModeSelectable, false);
  }),
);

it.effect("forwards an unset override without replacing Pi defaults", () =>
  Effect.gen(function* () {
    yield* checkPiProviderStatus(
      decodePiSettings({}),
      makeProbeClient({
        getCatalogModels: async (level) => {
          assert.strictEqual(level, null);
          return catalogModels;
        },
      }),
      EMPTY_DISCOVERY,
    );
  }),
);

it.effect("does not probe disabled providers", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkPiProviderStatus(
      decodePiSettings({ enabled: false }),
      makeProbeClient({
        getCatalogModels: async () => {
          throw new Error("must not probe");
        },
      }),
      EMPTY_DISCOVERY,
    );
    assert.isFalse(snapshot.enabled);
    assert.deepEqual(snapshot.models, []);
  }),
);

it.effect("does not invent capabilities when the catalog is empty or fails", () =>
  Effect.gen(function* () {
    const empty = yield* checkPiProviderStatus(
      decodePiSettings({}),
      makeProbeClient({ getCatalogModels: async () => [] }),
      EMPTY_DISCOVERY,
    );
    assert.deepEqual(empty.models, []);
    assert.strictEqual(empty.auth.status, "unknown");
    assert.strictEqual(empty.status, "warning");
    const failed = yield* checkPiProviderStatus(
      decodePiSettings({}),
      makeProbeClient({
        getCatalogModels: async () => {
          throw new Error("catalog failed");
        },
      }),
      EMPTY_DISCOVERY,
    );
    assert.deepEqual(failed.models, []);
    assert.strictEqual(failed.status, "error");
  }),
);

it.effect("surfaces discovered skills and prompt templates", () =>
  Effect.gen(function* () {
    const discovery: PiDiscoveryClient = {
      discover: async () => ({
        skills: [
          {
            name: "diagnosing-bugs",
            path: "/skills/diagnosing-bugs/SKILL.md",
            scope: "user",
            enabled: true,
          },
        ],
        slashCommands: [
          { name: "review", description: "Review the current diff.", input: { hint: "[path]" } },
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
    assert.strictEqual(
      snapshot.slashCommands.find((command) => command.name === "review")?.input?.hint,
      "[path]",
    );
    assert.isTrue(snapshot.slashCommands.some((command) => command.name === "compact"));
  }),
);

it.effect("treats a discovery failure as empty pickers, not a snapshot failure", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkPiProviderStatus(decodePiSettings({}), makeProbeClient(), {
      discover: async () => {
        throw new Error("resource loader exploded");
      },
    });
    assert.strictEqual(snapshot.status, "ready");
    assert.deepEqual(snapshot.skills, []);
    assert.deepEqual(
      snapshot.slashCommands.map((command) => command.name),
      ["compact"],
    );
  }),
);
