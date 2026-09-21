// @effect-diagnostics nodeBuiltinImport:off - SEA sidecars must be loaded synchronously by Node.
import * as NodeModule from "node:module";

const require = NodeModule.createRequire(import.meta.url);

/** Load sidecar packages from a SEA, where file-backed ESM imports are unavailable. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- Generic bundler bridge; each generated facade retains its package's own export contract.
export function requireCliExternal(specifier: string): unknown {
  if (!specifier.startsWith("@earendil-works/")) return require(specifier);

  // Pi exposes import-only entry points. Node can require these synchronous ESM
  // modules, but needs the import export condition during resolution. Keep the
  // hook scoped to this synchronous load and leave other packages' conditions alone.
  const hooks = NodeModule.registerHooks({
    resolve(id, context, nextResolve) {
      return nextResolve(
        id,
        id.startsWith("@earendil-works/")
          ? { ...context, conditions: [...context.conditions, "import"] }
          : context,
      );
    },
  });
  try {
    return require(specifier);
  } finally {
    hooks.deregister();
  }
}
