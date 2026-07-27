import { expect, it } from "vite-plus/test";

import { PROVIDER_CLIENT_DEFINITIONS } from "../settings/providerDriverMeta";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

it("resolves an icon for every registered provider driver", () => {
  const missing = PROVIDER_CLIENT_DEFINITIONS.filter(
    (definition) => PROVIDER_ICON_BY_PROVIDER[definition.value] === undefined,
  ).map((definition) => definition.label);

  expect(missing).toEqual([]);
});
