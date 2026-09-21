// @effect-diagnostics nodeBuiltinImport:off - Packaging helpers stage real package trees before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

const PackageManifest = Schema.Struct({
  name: Schema.String,
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependenciesMeta: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ optional: Schema.optional(Schema.Boolean) })),
  ),
});
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(PackageManifest));

/** Resolve manifests without requiring packages to export their package.json. */
export function resolveRuntimePackage(name: string, from: string): string | undefined {
  for (let current = from; ; current = NodePath.dirname(current)) {
    const directory = NodePath.join(current, "node_modules", name);
    if (NodeFS.existsSync(NodePath.join(directory, "package.json"))) {
      return NodeFS.realpathSync(directory);
    }
    if (current === NodePath.dirname(current)) break;
  }
  return undefined;
}

/** Real package directories preserve separate versions in pnpm's dependency graph. */
export function runtimePackageClosure(root: string) {
  const packages = new Map<
    string,
    { name: string; dependencies: Map<string, string | undefined> }
  >();
  // Filtered installs (lint-only task graphs, CI partial setups) load this
  // module through the universal vite config without the workspace's
  // dependencies installed. Nothing can be bundled in that state anyway, so
  // report an empty closure instead of failing config resolution. A present
  // root still enforces its full dependency closure below.
  if (!NodeFS.existsSync(NodePath.join(root, "package.json"))) {
    return packages;
  }
  const pending = [NodeFS.realpathSync(root)];
  for (const directory of pending) {
    if (packages.has(directory)) continue;
    const manifest = decodeManifest(
      NodeFS.readFileSync(NodePath.join(directory, "package.json"), "utf8"),
    );
    const dependencies = new Map<string, string | undefined>();
    packages.set(directory, { name: manifest.name, dependencies });
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    })) {
      const target = resolveRuntimePackage(name, directory);
      const optional =
        manifest.optionalDependencies?.[name] !== undefined ||
        manifest.peerDependenciesMeta?.[name]?.optional === true;
      if (target === undefined && !optional) {
        throw new Error(`Missing runtime dependency ${manifest.name} -> ${name}. Run vp i.`);
      }
      dependencies.set(name, target);
      if (target !== undefined) pending.push(target);
    }
  }
  return packages;
}
