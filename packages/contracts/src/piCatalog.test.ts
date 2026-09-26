import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { PiCatalogSnapshot } from "./piCatalog.ts";

const decodeCatalog = Schema.decodeUnknownSync(PiCatalogSnapshot);
const catalog = { extensions: [], modelProviders: [], warnings: [] };

describe("Pi catalog compatibility notices", () => {
  it("accepts catalogs from older servers without compatibility notices", () => {
    expect(decodeCatalog(catalog)).toEqual(catalog);
  });

  it("keeps compatibility notices distinct from load and runtime warnings", () => {
    expect(
      decodeCatalog({
        ...catalog,
        warnings: ["An extension failed to load"],
        compatibilityWarnings: ["A Pi extension requested terminal-only controls"],
      }),
    ).toEqual({
      ...catalog,
      warnings: ["An extension failed to load"],
      compatibilityWarnings: ["A Pi extension requested terminal-only controls"],
    });
  });
});
