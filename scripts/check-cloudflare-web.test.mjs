import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { checkCloudflareWeb } from "./check-cloudflare-web.mjs";

let directory;
NodeTest.beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-cloudflare-web-"));
  NodeFS.writeFileSync(NodePath.join(directory, "index.html"), "<html></html>");
});
NodeTest.afterEach(() => {
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

NodeTest.test("checks nested assets against the free-tier limits", () => {
  NodeFS.mkdirSync(NodePath.join(directory, "assets"));
  NodeFS.writeFileSync(NodePath.join(directory, "assets", "app.js"), "export {};");
  NodeAssert.deepEqual(checkCloudflareWeb(directory), { files: 2, bytes: 23 });
});

NodeTest.test("rejects an output directory without the SPA entry point", () => {
  NodeFS.unlinkSync(NodePath.join(directory, "index.html"));
  NodeAssert.throws(() => checkCloudflareWeb(directory));
});

for (const filename of ["app.js.map", ".env.local"]) {
  NodeTest.test(`rejects ${filename} in deployable assets`, () => {
    NodeFS.writeFileSync(NodePath.join(directory, filename), "private");
    NodeAssert.throws(() => checkCloudflareWeb(directory), /Refusing to upload/);
  });
}

NodeTest.test("accepts an asset exactly 25 MiB in size", () => {
  const filename = NodePath.join(directory, "terminal.wasm");
  NodeFS.writeFileSync(filename, "");
  NodeFS.truncateSync(filename, 25 * 1024 * 1024);
  NodeAssert.equal(checkCloudflareWeb(directory).files, 2);
});

NodeTest.test("rejects an asset larger than 25 MiB", () => {
  const filename = NodePath.join(directory, "oversized.wasm");
  NodeFS.writeFileSync(filename, "");
  NodeFS.truncateSync(filename, 25 * 1024 * 1024 + 1);
  NodeAssert.throws(() => checkCloudflareWeb(directory), /25 MiB asset limit/);
});
