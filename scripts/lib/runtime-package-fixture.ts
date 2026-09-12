// @effect-diagnostics nodeBuiltinImport:off - Packaging helpers stage real package trees before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { runtimePackageClosure } from "./runtime-package-closure.ts";

/** Copy a runtime into a sandbox without links back to the developer's installation. */
export function stageRuntimePackageFixture(source: string, target: string) {
  const root = NodeFS.realpathSync(source);
  const packages = runtimePackageClosure(root);
  const destinations = new Map(
    [...packages.keys()].map((directory, index) => [
      directory,
      NodePath.join(target, ".runtime", String(index)),
    ]),
  );
  for (const [directory, manifest] of packages) {
    const destination = destinations.get(directory)!;
    NodeFS.cpSync(directory, destination, {
      recursive: true,
      filter: (path) =>
        !["node_modules", "docs", "examples", "test", "tests"].includes(NodePath.basename(path)) &&
        !/\.(?:map|md|d\.ts)$/.test(path),
    });
    for (const [name, dependency] of manifest.dependencies) {
      if (dependency === undefined) continue;
      const link = NodePath.join(destination, "node_modules", name);
      NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
      NodeFS.symlinkSync(destinations.get(dependency)!, link, "junction");
    }
  }
  for (const [directory, { name }] of packages) {
    const link = NodePath.join(target, "node_modules", name);
    if (NodeFS.existsSync(link)) continue;
    NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
    NodeFS.symlinkSync(destinations.get(directory)!, link, "junction");
  }
  return destinations.get(root)!;
}
