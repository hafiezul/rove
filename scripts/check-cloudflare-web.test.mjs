import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, it } from "@effect/vitest";

import { buildRoveProjectFileJsonSchema } from "@rove-code/shared/roveProjectFile";
import {
  checkCloudflareWeb,
  checkDeployedProjectFileSchema,
  readBuiltProjectFileSchema,
} from "./check-cloudflare-web.mjs";

let directory;
beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-cloudflare-web-"));
  NodeFS.writeFileSync(NodePath.join(directory, "index.html"), "<html></html>");
  NodeFS.mkdirSync(NodePath.join(directory, "schema"));
  NodeFS.writeFileSync(
    NodePath.join(directory, "schema/rove.json"),
    JSON.stringify(buildRoveProjectFileJsonSchema()),
  );
});
afterEach(() => {
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

it("checks nested assets against the free-tier limits", () => {
  NodeFS.mkdirSync(NodePath.join(directory, "assets"));
  NodeFS.writeFileSync(NodePath.join(directory, "assets", "app.js"), "export {};");
  const schemaBytes = NodeFS.statSync(NodePath.join(directory, "schema/rove.json")).size;
  NodeAssert.deepEqual(checkCloudflareWeb(directory), { files: 3, bytes: 23 + schemaBytes });
});

it("rejects a build that would serve the SPA fallback instead of the schema", () => {
  NodeFS.unlinkSync(NodePath.join(directory, "schema/rove.json"));
  NodeAssert.throws(() => checkCloudflareWeb(directory), /rove.json/);
});

for (const raw of ["<html></html>", '{"type":"object"}']) {
  it(`rejects incorrect schema content ${raw}`, () => {
    NodeFS.writeFileSync(NodePath.join(directory, "schema/rove.json"), raw);
    NodeAssert.throws(() => checkCloudflareWeb(directory));
  });
}

it("accepts a PR schema change without comparing it to the base branch", async () => {
  const previewSchema = { ...buildRoveProjectFileJsonSchema(), description: "A PR schema change." };
  NodeFS.writeFileSync(NodePath.join(directory, "schema/rove.json"), JSON.stringify(previewSchema));
  const builtSchema = readBuiltProjectFileSchema(directory);
  NodeAssert.throws(() => checkCloudflareWeb(directory));
  NodeAssert.equal(checkCloudflareWeb(directory, builtSchema).files, 2);

  const server = NodeHttp.createServer((request, response) => {
    response.setHeader("content-type", "application/schema+json");
    response.end(JSON.stringify(previewSchema));
  });
  server.listen(0, "127.0.0.1");
  await NodeEvents.once(server, "listening");
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    await checkDeployedProjectFileSchema(origin, builtSchema);
    previewSchema.description = "A stale deployment.";
    await NodeAssert.rejects(checkDeployedProjectFileSchema(origin, builtSchema));
  } finally {
    server.close();
    await NodeEvents.once(server, "close");
  }
});

for (const change of [
  { $id: "https://wrong.example/schema" },
  { $schema: "wrong" },
  { type: "string" },
]) {
  it(`rejects a preview schema with incorrect metadata ${JSON.stringify(change)}`, () => {
    NodeFS.writeFileSync(
      NodePath.join(directory, "schema/rove.json"),
      JSON.stringify({ ...buildRoveProjectFileJsonSchema(), ...change }),
    );
    NodeAssert.throws(() => readBuiltProjectFileSchema(directory));
  });
}

it("rejects an output directory without the SPA entry point", () => {
  NodeFS.unlinkSync(NodePath.join(directory, "index.html"));
  NodeAssert.throws(() => checkCloudflareWeb(directory));
});

for (const filename of ["app.js.map", ".env.local"]) {
  it(`rejects ${filename} in deployable assets`, () => {
    NodeFS.writeFileSync(NodePath.join(directory, filename), "private");
    NodeAssert.throws(() => checkCloudflareWeb(directory), /Refusing to upload/);
  });
}

it("accepts an asset exactly 25 MiB in size", () => {
  const filename = NodePath.join(directory, "terminal.wasm");
  NodeFS.writeFileSync(filename, "");
  NodeFS.truncateSync(filename, 25 * 1024 * 1024);
  NodeAssert.equal(checkCloudflareWeb(directory).files, 3);
});

for (const isSchema of [true, false]) {
  it(`checks the deployed response instead of trusting HTTP 200, schema=${isSchema}`, async () => {
    const server = NodeHttp.createServer((request, response) => {
      NodeAssert.equal(request.url, "/schema/rove.json");
      response.setHeader("content-type", isSchema ? "application/json" : "text/html");
      response.end(isSchema ? JSON.stringify(buildRoveProjectFileJsonSchema()) : "<html></html>");
    });
    server.listen(0, "127.0.0.1");
    await NodeEvents.once(server, "listening");
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (isSchema) await checkDeployedProjectFileSchema(origin);
      else
        await NodeAssert.rejects(checkDeployedProjectFileSchema(origin), /must return JSON Schema/);
    } finally {
      server.close();
      await NodeEvents.once(server, "close");
    }
  });
}

it("rejects an asset larger than 25 MiB", () => {
  const filename = NodePath.join(directory, "oversized.wasm");
  NodeFS.writeFileSync(filename, "");
  NodeFS.truncateSync(filename, 25 * 1024 * 1024 + 1);
  NodeAssert.throws(() => checkCloudflareWeb(directory), /25 MiB asset limit/);
});
