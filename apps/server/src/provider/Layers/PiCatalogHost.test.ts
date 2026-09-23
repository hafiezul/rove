// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { PiSettings, type PiThinkingLevel, type ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  getProviderOptionDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
} from "@t3tools/shared/model";
import { checkPiProviderStatus } from "./PiProvider.ts";
import { afterEach, beforeEach, describe, vi } from "vite-plus/test";

import { PiCatalogHost } from "./PiCatalogHost.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

describe("Pi catalog host", () => {
  let root: string;
  let agentDir: string;
  let fixturePath: string;
  const hosts: PiCatalogHost[] = [];

  beforeEach(() => {
    root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-pi-catalog-")),
    );
    agentDir = NodePath.join(root, "agent");
    NodeFS.mkdirSync(agentDir, { recursive: true });
    fixturePath = NodePath.join(root, "fixture.ts");
    NodeFS.copyFileSync(new URL("./fixtures/pi-extension.ts", import.meta.url), fixturePath);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", NodePath.join(root, "sessions"));
    vi.stubEnv("PI_OFFLINE", "1");
  });

  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.dispose();
    vi.unstubAllEnvs();
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  const create = async (options?: { additionalExtensionPaths?: ReadonlyArray<string> }) => {
    const host = await PiCatalogHost.create({ agentDir, ...options });
    hosts.push(host);
    return host;
  };

  it("lists extension models for the provider snapshot", async () => {
    const host = await create({ additionalExtensionPaths: [fixturePath] });
    const catalogModels = await host.getCatalogModels();
    const fixture = catalogModels.find((model) => model.slug === "rove-extension-test/fixture");
    assert.isDefined(fixture);
    assert.strictEqual(fixture?.subProvider, "rove-extension-test");
    const thinking = fixture?.capabilities?.optionDescriptors?.find(
      (candidate) => candidate.id === "thinkingLevel",
    );
    assert.strictEqual(thinking?.type, "select");
    if (thinking?.type === "select") {
      assert.deepEqual(
        thinking.options.map((option) => option.id),
        ["off"],
      );
    }
    assert.strictEqual(thinking?.currentValue, "off");
  });

  it("invalidates its SDK session even when a catalog extension hangs on shutdown", async () => {
    const extensionPath = NodePath.join(root, "stuck-shutdown.ts");
    NodeFS.writeFileSync(
      extensionPath,
      `
      export default function(pi) {
        pi.on("session_shutdown", async () => { await new Promise(() => {}); });
      }
    `,
    );
    const host = await create({ additionalExtensionPaths: [extensionPath] });
    vi.useFakeTimers();
    try {
      const disposal = host.dispose();
      await vi.advanceTimersByTimeAsync(5_000);
      await disposal;
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists slash commands registered by loaded extensions", async () => {
    const host = await create({ additionalExtensionPaths: [fixturePath] });
    const commands = host.getExtensionSlashCommands();
    assert.deepEqual(commands.map((command) => command.name).sort(), [
      "broken",
      "count",
      "replace-session",
    ]);
  });

  function thinkingDescriptor(models: ReadonlyArray<ServerProviderModel>, id: string) {
    const descriptor = models.find((model) => model.slug === `local/${id}`)?.capabilities
      ?.optionDescriptors?.[0];
    if (descriptor?.type !== "select") throw new Error(`Missing reasoning for ${id}`);
    return descriptor;
  }

  function writeModels() {
    NodeFS.writeFileSync(
      NodePath.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: "https://example.invalid",
            api: "openai-completions",
            apiKey: "test-key",
            models: [
              { id: "plain", reasoning: false },
              { id: "standard", reasoning: true },
              {
                id: "sparse",
                reasoning: true,
                thinkingLevelMap: {
                  off: null,
                  minimal: null,
                  low: "low",
                  medium: null,
                  high: "high",
                  xhigh: null,
                  max: "max",
                },
              },
              {
                id: "empty",
                reasoning: true,
                thinkingLevelMap: {
                  off: null,
                  minimal: null,
                  low: null,
                  medium: null,
                  high: null,
                  xhigh: null,
                  max: null,
                },
              },
            ],
          },
        },
      }),
    );
  }

  it("uses Pi metadata including holes, extended levels, and non-reasoning models", async () => {
    writeModels();
    const host = await create();
    const models = await host.getCatalogModels();
    assert.deepEqual(
      thinkingDescriptor(models, "plain").options.map((option) => option.id),
      ["off"],
    );
    assert.deepEqual(
      thinkingDescriptor(models, "standard").options.map((option) => option.id),
      ["off", "minimal", "low", "medium", "high"],
    );
    assert.deepEqual(
      thinkingDescriptor(models, "sparse").options.map((option) => option.id),
      ["low", "high", "max"],
    );
    assert.strictEqual(thinkingDescriptor(models, "standard").currentValue, "medium");
    assert.strictEqual(thinkingDescriptor(models, "sparse").currentValue, "high");
    assert.deepEqual(
      models.find((model) => model.slug === "local/empty")?.capabilities?.optionDescriptors,
      [],
    );
  });

  it.effect(
    "resolves instance, per-model, and global defaults without network requests or settings writes",
    () =>
      Effect.gen(function* () {
        writeModels();
        const settingsPath = NodePath.join(agentDir, "settings.json");
        NodeFS.writeFileSync(
          settingsPath,
          `{
            "defaultThinkingLevel": "low",
            "modelThinkingLevels": { "local/standard": "high" }
          }`,
        );
        const host = yield* Effect.promise(() => create());
        const settingsBefore = NodeFS.readFileSync(settingsPath, "utf8");
        const fetch = vi
          .spyOn(globalThis, "fetch")
          .mockRejectedValue(new Error("unexpected network request"));
        try {
          const models = yield* Effect.promise(() => host.getCatalogModels(null));
          assert.strictEqual(thinkingDescriptor(models, "standard").currentValue, "high");
          assert.strictEqual(thinkingDescriptor(models, "sparse").currentValue, "low");
          for (const level of ["off", "medium", "xhigh", "max"] satisfies PiThinkingLevel[]) {
            const snapshot = yield* checkPiProviderStatus(
              decodePiSettings({ thinkingLevel: level }),
              host,
            );
            for (const model of snapshot.models) {
              for (const descriptor of model.capabilities?.optionDescriptors ?? []) {
                if (descriptor.type !== "select") continue;
                assert.isTrue(
                  descriptor.options.some((option) => option.id === descriptor.currentValue),
                );
                assert.strictEqual(
                  descriptor.options.filter((option) => option.isDefault).length,
                  1,
                );
              }
            }
          }
          const maxModels = yield* Effect.promise(() => host.getCatalogModels("max"));
          const offModels = yield* Effect.promise(() => host.getCatalogModels("off"));
          assert.strictEqual(thinkingDescriptor(maxModels, "standard").currentValue, "high");
          assert.strictEqual(thinkingDescriptor(offModels, "sparse").currentValue, "low");
          assert.strictEqual(fetch.mock.calls.length, 0);
          assert.strictEqual(NodeFS.readFileSync(settingsPath, "utf8"), settingsBefore);
        } finally {
          fetch.mockRestore();
        }
      }),
  );

  it("drops unsupported stored tiers when switching models and restores supported choices", async () => {
    writeModels();
    const host = await create();
    const models = await host.getCatalogModels();
    const stored = [{ id: "thinkingLevel", value: "max" }];
    for (const [id, expected] of [
      ["sparse", "max"],
      ["plain", "off"],
      ["standard", "medium"],
      ["sparse", "max"],
    ] as const) {
      const model = models.find((model) => model.slug === `local/${id}`);
      assert.isNotNull(model?.capabilities);
      const descriptors = getProviderOptionDescriptors({
        caps: model!.capabilities!,
        selections: stored,
      });
      assert.deepEqual(buildProviderOptionSelectionsFromDescriptors(descriptors), [
        { id: "thinkingLevel", value: expected },
      ]);
    }
  });

  it("reports loaded extensions, providers, and load failures as warnings", async () => {
    const brokenPath = NodePath.join(root, "broken.ts");
    NodeFS.writeFileSync(
      brokenPath,
      'export default () => { throw new Error("catalog load failed"); };',
    );
    const host = await create({ additionalExtensionPaths: [fixturePath, brokenPath] });
    const catalog = await host.getCatalog();
    // Discovered inventory retains both extensions so broken ones can be managed/disabled.
    assert.strictEqual(catalog.extensions.length, 2);
    const loaded = catalog.extensions.find((ext) => ext.path === fixturePath);
    assert.isDefined(loaded);
    assert.strictEqual(loaded?.tools.includes("fixture_tool"), true);
    const broken = catalog.extensions.find((ext) => ext.path === brokenPath);
    assert.isDefined(broken);
    assert.deepStrictEqual(broken?.tools, []);
    assert.isTrue(catalog.modelProviders.some((provider) => provider.id === "rove-extension-test"));
    assert.isTrue(catalog.warnings.some((warning) => warning.includes("catalog load failed")));
  });

  it("rescans extension files on refresh", async () => {
    const host = await create({ additionalExtensionPaths: [fixturePath] });
    NodeFS.mkdirSync(NodePath.join(agentDir, "extensions"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(agentDir, "extensions", "late.ts"),
      `export default function (pi) { pi.registerTool({ name: "late_tool", description: "added after start", parameters: {}, execute: async () => ({ content: ["ok"], display: "ok" }) }); }`,
    );
    const catalog = await host.refreshCatalog();
    assert.isTrue(
      catalog.extensions.some((extension) => extension.tools.includes("late_tool")),
      "refresh should pick up the newly installed extension",
    );
    // Refreshing twice must not stack duplicate warnings or entries.
    const again = await host.refreshCatalog();
    assert.strictEqual(
      again.extensions.filter((extension) => extension.tools.includes("late_tool")).length,
      1,
    );
  });

  it("ignores project extensions structurally", async () => {
    const project = NodePath.join(root, "project");
    NodeFS.mkdirSync(NodePath.join(project, ".pi", "extensions"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(project, ".pi", "extensions", "marker.ts"),
      'export default () => { throw new Error("project extension must not load in the host"); };',
    );
    const host = await create({ additionalExtensionPaths: [fixturePath] });
    const catalog = await host.getCatalog();
    assert.isTrue(catalog.extensions.every((extension) => extension.path !== "marker"));
    assert.isTrue(catalog.warnings.every((warning) => !warning.includes("must not load")));
  });

  it("notifies on provider registration and refreshes offline", async () => {
    const host = await create({ additionalExtensionPaths: [fixturePath] });
    let notifications = 0;
    const unsubscribe = host.onChange(() => {
      notifications++;
    });
    try {
      const catalog = await host.refreshCatalog();
      assert.strictEqual(catalog.extensions.length, 1);
      assert.isAtLeast(notifications, 1);
    } finally {
      unsubscribe();
    }
  });

  it("filters disabled extensions before factory execution and excludes their models from the catalog", async () => {
    const logPath = NodePath.join(root, "factory-side-effect.log");
    const customExtPath = NodePath.join(root, "custom-ext.ts");
    NodeFS.writeFileSync(
      customExtPath,
      `import * as NodeFS from "node:fs";
export default function (pi) {
  NodeFS.writeFileSync("${logPath}", "custom factory executed");
  pi.registerProvider("custom-ext-provider", {
    baseUrl: "https://example.invalid",
    apiKey: "test",
    api: "openai-completions",
    models: [{ id: "custom-model", name: "Custom Model", reasoning: false }],
  });
  pi.on("session_start", () => pi.registerProvider("hook-provider", {
    baseUrl: "https://example.invalid",
    apiKey: "test",
    api: "openai-completions",
    models: [{ id: "hook-model", name: "Hook Model", reasoning: false }],
  }));
}`,
    );

    // Host created with customExtPath disabled:
    const host = await PiCatalogHost.create({
      agentDir,
      additionalExtensionPaths: [fixturePath, customExtPath],
      disabledExtensions: [customExtPath],
    });
    hosts.push(host);

    // Factory should NOT have executed!
    assert.isFalse(NodeFS.existsSync(logPath), "disabled extension factory must not execute");

    // Models from disabled extension must NOT be advertised:
    const models = await host.getCatalogModels();
    assert.isFalse(
      models.some((model) => model.slug === "custom-ext-provider/custom-model"),
      "disabled extension models must not be advertised in catalog models",
    );

    // Discovered inventory still includes the disabled extension:
    const catalog = await host.getCatalog();
    const customInCatalog = catalog.extensions.find((ext) => ext.path === customExtPath);
    assert.isDefined(customInCatalog, "disabled extension must remain in discovered catalog");
    assert.deepStrictEqual(customInCatalog?.tools, []);
    assert.isFalse(catalog.modelProviders.some((p) => p.id === "custom-ext-provider"));

    // Enabling it via setDisabledExtensions activates it and executes the factory:
    await host.setDisabledExtensions([]);
    assert.isTrue(NodeFS.existsSync(logPath), "factory executes once extension is enabled");
    const enabledModels = await host.getCatalogModels();
    assert.isTrue(
      enabledModels.some((model) => model.slug === "custom-ext-provider/custom-model"),
      "models are advertised once extension is enabled",
    );

    assert.isTrue(enabledModels.some((model) => model.slug === "hook-provider/hook-model"));

    await host.setDisabledExtensions([customExtPath]);
    assert.isFalse(
      (await host.getCatalogModels()).some(
        (model) => model.slug === "custom-ext-provider/custom-model",
      ),
    );
    assert.isFalse(
      (await host.getCatalog()).modelProviders.some(
        (provider) => provider.id === "custom-ext-provider" || provider.id === "hook-provider",
      ),
    );
  });
});
