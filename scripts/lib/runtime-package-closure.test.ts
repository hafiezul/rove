// @effect-diagnostics nodeBuiltinImport:off - Packaging helpers stage real package trees before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { resolveRuntimePackage, runtimePackageClosure } from "./runtime-package-closure.ts";
import { stageRuntimePackageFixture } from "./runtime-package-fixture.ts";

let root: string;
beforeEach(() => {
  root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-closure-")),
  );
});
afterEach(() => NodeFS.rmSync(root, { recursive: true, force: true }));

interface FixtureManifest {
  readonly name: string;
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  readonly exports?: unknown;
}

function manifest(directory: string, value: FixtureManifest) {
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(directory, "package.json"), JSON.stringify(value));
}

describe("runtime package closure", () => {
  it("resolves hoisted dependencies despite package export restrictions", () => {
    const sdk = NodePath.join(root, "node_modules/sdk");
    const peer = NodePath.join(root, "node_modules/peer");
    manifest(sdk, { name: "sdk", dependencies: { peer: "1" } });
    manifest(peer, { name: "peer", exports: { ".": "./index.js" } });
    expect(resolveRuntimePackage("peer", sdk)).toBe(peer);
    expect([...runtimePackageClosure(sdk).keys()]).toEqual([sdk, peer]);
  });

  it("preserves multiple versions and terminates dependency cycles", () => {
    const sdk = NodePath.join(root, "sdk");
    const a = NodePath.join(sdk, "node_modules/a");
    const b = NodePath.join(sdk, "node_modules/b");
    const nested = NodePath.join(b, "node_modules/a");
    manifest(sdk, { name: "sdk", dependencies: { a: "1", b: "1" } });
    manifest(a, { name: "a", version: "1", dependencies: { b: "1" } });
    manifest(b, { name: "b", dependencies: { a: "2" } });
    manifest(nested, { name: "a", version: "2" });
    const packages = runtimePackageClosure(sdk);
    expect(packages.size).toBe(4);
    expect(packages.get(b)?.dependencies.get("a")).toBe(nested);
    expect(packages.get(a)?.dependencies.get("b")).toBe(b);
    const copy = stageRuntimePackageFixture(sdk, NodePath.join(root, "copy"));
    NodeFS.rmSync(sdk, { recursive: true });
    expect(runtimePackageClosure(copy).size).toBe(4);
  });

  it("retains absent optional platform packages without requiring them on the build host", () => {
    manifest(root, {
      name: "sdk",
      optionalDependencies: { "platform-binary": "1" },
      peerDependencies: { "optional-peer": "1" },
      peerDependenciesMeta: { "optional-peer": { optional: true } },
    });
    expect([...runtimePackageClosure(root).get(root)!.dependencies]).toEqual([
      ["optional-peer", undefined],
      ["platform-binary", undefined],
    ]);
  });

  it("rejects missing required dependencies rather than shipping an incomplete runtime", () => {
    manifest(root, { name: "sdk", dependencies: { "missing-runtime": "1" } });
    expect(() => runtimePackageClosure(root)).toThrow("sdk -> missing-runtime");
  });
});
