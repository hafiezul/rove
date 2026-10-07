import { assert, describe, it } from "@effect/vitest";

import {
  mergeUpdateManifests,
  parseUpdateManifest,
  serializeUpdateManifest,
} from "./update-manifest.ts";

const rawManifest = `version: 1.2.3
files:
  - url: Rove-Code-1.2.3-arm64.AppImage
    sha512: arm64sha
    size: 125621344
    blockMapSize: 196282
  - url: Rove-Code-1.2.3-x86_64.AppImage
    sha512: x64sha
    size: 132000112
path: Rove-Code-1.2.3-arm64.AppImage
sha512: arm64sha
releaseDate: '2026-10-07T06:00:00Z'
`;

function parse(raw = rawManifest) {
  return parseUpdateManifest(raw, "nightly-linux-arm64.yml", "linux");
}

describe("update-manifest block map metadata", () => {
  it("preserves optional per-file block map sizes through serialization", () => {
    const manifest = parse();
    assert.deepStrictEqual(manifest.files, [
      {
        url: "Rove-Code-1.2.3-arm64.AppImage",
        sha512: "arm64sha",
        size: 125621344,
        blockMapSize: 196282,
      },
      {
        url: "Rove-Code-1.2.3-x86_64.AppImage",
        sha512: "x64sha",
        size: 132000112,
      },
    ]);
    assert.deepStrictEqual(
      parse(serializeUpdateManifest(manifest, { platformLabel: "linux" })),
      manifest,
    );
  });

  it("preserves a zero block map size", () => {
    const manifest = parse(rawManifest.replace("blockMapSize: 196282", "blockMapSize: 0"));
    assert.deepStrictEqual(
      parse(serializeUpdateManifest(manifest, { platformLabel: "linux" })),
      manifest,
    );
  });

  it("merges matching entries and rejects conflicting block map sizes", () => {
    const manifest = parse();
    assert.deepStrictEqual(mergeUpdateManifests(manifest, parse(), "linux"), manifest);
    assert.throws(
      () =>
        mergeUpdateManifests(
          manifest,
          parse(rawManifest.replace("blockMapSize: 196282", "blockMapSize: 196283")),
          "linux",
        ),
      /conflicting file entry/,
    );
  });

  it("rejects a block map size without a file entry", () => {
    assert.throws(() => parse("files:\n    blockMapSize: 196282\n"), /without a file entry/);
  });

  for (const value of ["-1", "1.5", "invalid"]) {
    it(`rejects an invalid block map size: ${value}`, () => {
      assert.throws(
        () => parse(rawManifest.replace("blockMapSize: 196282", `blockMapSize: ${value}`)),
        /unsupported line/,
      );
    });
  }
});
