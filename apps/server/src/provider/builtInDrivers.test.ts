import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@rove-code/contracts";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

it("registers the Pi driver", () => {
  const pi = BUILT_IN_DRIVERS.find((driver) => driver.driverKind === "pi");

  assert.isDefined(pi);
  assert.strictEqual(pi?.metadata.displayName, "Pi");
  assert.strictEqual(pi?.metadata.supportsMultipleInstances, true);
  assert.strictEqual(pi?.defaultConfig().enabled, true);
  // Extensions follow the user's Pi config; nothing is disabled by default.
  assert.deepEqual(pi?.defaultConfig().disabledExtensions, []);
});

it("registers Pi Durable separately and leaves it opt-in", () => {
  const durable = BUILT_IN_DRIVERS.find((driver) => driver.driverKind === "piDurable");
  assert.isDefined(durable);
  assert.strictEqual(durable?.metadata.displayName, "Pi Durable");
  assert.strictEqual(durable?.defaultConfig().enabled, false);
});

it("every built-in driver kind is unique", () => {
  const kinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);
  assert.strictEqual(new Set(kinds).size, kinds.length);
  assert.include(kinds, ProviderDriverKind.make("pi"));
});
