// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { afterEach, beforeEach, describe, vi } from "vite-plus/test";

import { PiCatalogHost } from "./PiCatalogHost.ts";

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
    const models = await host.listModels();
    assert.isTrue(models.some((model) => model.provider === "rove-extension-test"));
    const catalogModels = await host.getCatalogModels();
    const fixture = catalogModels.find((model) => model.slug === "rove-extension-test/fixture");
    assert.isDefined(fixture);
    assert.strictEqual(fixture?.subProvider, "rove-extension-test");
    assert.strictEqual(await host.defaultModelProvider(), "rove-extension-test");
  });

  it("reports loaded extensions, providers, and load failures as warnings", async () => {
    const brokenPath = NodePath.join(root, "broken.ts");
    NodeFS.writeFileSync(
      brokenPath,
      'export default () => { throw new Error("catalog load failed"); };',
    );
    const host = await create({ additionalExtensionPaths: [fixturePath, brokenPath] });
    const catalog = await host.getCatalog();
    assert.strictEqual(catalog.extensions.length, 1);
    assert.strictEqual(catalog.extensions[0]?.tools.includes("fixture_tool"), true);
    assert.isTrue(catalog.modelProviders.some((provider) => provider.id === "rove-extension-test"));
    assert.isTrue(catalog.warnings.some((warning) => warning.includes("catalog load failed")));
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
});
