import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

it("registers the Pi driver", () => {
  const pi = BUILT_IN_DRIVERS.find((driver) => driver.driverKind === "pi");

  assert.isDefined(pi);
  assert.strictEqual(pi?.metadata.displayName, "Pi");
  assert.strictEqual(pi?.metadata.supportsMultipleInstances, true);
  assert.strictEqual(pi?.defaultConfig().enabled, true);
  // Extensions are hard-disabled in v1.
  assert.strictEqual(pi?.defaultConfig().loadExtensions, false);
});

it("every built-in driver kind is unique", () => {
  const kinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);
  assert.strictEqual(new Set(kinds).size, kinds.length);
  assert.include(kinds, ProviderDriverKind.make("pi"));
});
