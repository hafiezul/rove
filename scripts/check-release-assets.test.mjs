import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, it } from "@effect/vitest";

import { checkReleaseAssets } from "./check-release-assets.mjs";

let directory;
const contents = "signed update fixture";
const sha512 = NodeCrypto.createHash("sha512").update(contents).digest("base64");
beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-release-assets-"));
});
afterEach(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

function manifest(name, urls, blockMapSize) {
  NodeFS.writeFileSync(
    NodePath.join(directory, name),
    `version: 1.2.3\nfiles:\n${urls.map((url) => `  - url: ${url}\n    sha512: ${sha512}\n    size: ${contents.length}\n${blockMapSize === undefined ? "" : `    blockMapSize: ${blockMapSize}\n`}`).join("")}releaseDate: '2026-10-07T06:00:00Z'\n`,
  );
}

it("verifies every architecture in merged manifests without treating builder config as a feed", async () => {
  const urls = ["Rove-Code-1.2.3-x64.exe", "Rove-Code-1.2.3-arm64.exe"];
  for (const url of urls) NodeFS.writeFileSync(NodePath.join(directory, url), contents);
  manifest("nightly.yml", urls);
  NodeFS.writeFileSync(NodePath.join(directory, "builder-debug.yml"), "configuration");
  NodeAssert.deepEqual(await checkReleaseAssets(directory), { manifests: 1, files: 2 });
});

it("verifies AppImage manifests with embedded block map metadata", async () => {
  const url = "Rove-Code-1.2.3-arm64.AppImage";
  NodeFS.writeFileSync(NodePath.join(directory, url), contents);
  manifest("nightly-linux-arm64.yml", [url], 196282);
  NodeAssert.deepEqual(await checkReleaseAssets(directory), { manifests: 1, files: 1 });

  NodeFS.writeFileSync(NodePath.join(directory, url), contents.toUpperCase());
  await NodeAssert.rejects(checkReleaseAssets(directory), /wrong sha512/);
});

it("rejects the published space-to-dot mismatch instead of accepting a green upload", async () => {
  manifest("nightly-mac.yml", ["Rove-Code-1.2.3-arm64.zip"]);
  NodeFS.writeFileSync(NodePath.join(directory, "Rove.Code-1.2.3-arm64.zip"), contents);
  await NodeAssert.rejects(checkReleaseAssets(directory), /missing release asset/);
});

for (const url of ["Rove Code.exe", "../outside.exe", "https://example.com/update.exe"]) {
  it(`rejects non-portable asset reference ${url}`, async () => {
    manifest("latest.yml", [url]);
    await NodeAssert.rejects(checkReleaseAssets(directory), /non-portable release filename/);
  });
}

it("rejects an asset whose bytes changed after the manifest was generated", async () => {
  const url = "Rove-Code-1.2.3-x64.exe";
  manifest("latest.yml", [url]);
  NodeFS.writeFileSync(NodePath.join(directory, url), contents.toUpperCase());
  await NodeAssert.rejects(checkReleaseAssets(directory), /wrong sha512/);
});

it("rejects incomplete uploads and incorrect sizes", async () => {
  const url = "Rove-Code-1.2.3-x86_64.AppImage";
  manifest("latest-linux.yml", [url], 196282);
  NodeFS.writeFileSync(NodePath.join(directory, url), "truncated");
  await NodeAssert.rejects(checkReleaseAssets(directory), /wrong size/);
});

it("rejects release output without update metadata", async () => {
  await NodeAssert.rejects(checkReleaseAssets(directory), /No updater manifests/);
});
