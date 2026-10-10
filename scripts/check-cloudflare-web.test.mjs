import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, it, vi } from "@effect/vitest";

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

function mockDeploymentFetch() {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function schemaResponse(schema = buildRoveProjectFileJsonSchema()) {
  return new Response(JSON.stringify(schema), {
    headers: { "content-type": "application/json" },
  });
}

for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT"]) {
  it(`retries ${code} after deployment and verifies the recovered response`, async () => {
    const fetchMock = mockDeploymentFetch();
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: { code } }))
      .mockResolvedValueOnce(schemaResponse());
    const check = checkDeployedProjectFileSchema("https://nightly.example.com");
    await vi.advanceTimersByTimeAsync(4_999);
    NodeAssert.equal(fetchMock.mock.calls.length, 1);
    await vi.advanceTimersByTimeAsync(1);
    await check;
    NodeAssert.equal(fetchMock.mock.calls.length, 2);
  });
}

for (const status of [429, 503, 522]) {
  it(`retries transient HTTP ${status}`, async () => {
    const fetchMock = mockDeploymentFetch();
    fetchMock
      .mockResolvedValueOnce(new Response("unavailable", { status }))
      .mockResolvedValueOnce(schemaResponse());
    const check = checkDeployedProjectFileSchema("https://nightly.example.com");
    await vi.advanceTimersByTimeAsync(5_000);
    await check;
    NodeAssert.equal(fetchMock.mock.calls.length, 2);
  });
}

it("retries a request timeout", async () => {
  const fetchMock = mockDeploymentFetch();
  fetchMock
    .mockRejectedValueOnce(new DOMException("Request timed out", "TimeoutError"))
    .mockResolvedValueOnce(schemaResponse());
  const check = checkDeployedProjectFileSchema("https://nightly.example.com");
  await vi.advanceTimersByTimeAsync(5_000);
  await check;
  NodeAssert.equal(fetchMock.mock.calls.length, 2);
  NodeAssert.ok(fetchMock.mock.calls[0][1].signal instanceof AbortSignal);
});

it("retries when the request times out while reading the response body", async () => {
  const fetchMock = mockDeploymentFetch();
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(controller.signal);
  fetchMock
    .mockImplementationOnce(async () => {
      const response = schemaResponse();
      vi.spyOn(response, "text").mockImplementation(async () => {
        controller.abort(new DOMException("Request timed out", "TimeoutError"));
        throw new DOMException("The operation was aborted", "AbortError");
      });
      return response;
    })
    .mockResolvedValueOnce(schemaResponse());
  const check = checkDeployedProjectFileSchema("https://nightly.example.com");
  await vi.advanceTimersByTimeAsync(5_000);
  await check;
  NodeAssert.equal(fetchMock.mock.calls.length, 2);
});

for (const failure of [
  new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }),
  new Response("unavailable", { status: 503 }),
]) {
  it(`stops retrying persistent ${failure instanceof Response ? "HTTP" : "DNS"} failures`, async () => {
    const fetchMock = mockDeploymentFetch();
    if (failure instanceof Response) {
      fetchMock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
    } else {
      fetchMock.mockRejectedValue(failure);
    }
    const rejected = NodeAssert.rejects(
      checkDeployedProjectFileSchema("https://nightly.example.com"),
      failure instanceof Response ? /HTTP 503/ : /fetch failed/,
    );
    await vi.advanceTimersByTimeAsync(95_000);
    await rejected;
    NodeAssert.equal(fetchMock.mock.calls.length, 6);
  });
}

for (const response of [
  new Response("not found", { status: 404 }),
  new Response("<html></html>", { headers: { "content-type": "text/html" } }),
  new Response("invalid JSON", { headers: { "content-type": "application/json" } }),
  schemaResponse({ type: "object" }),
]) {
  it(`does not retry invalid schema responses (${response.status}, ${response.headers.get("content-type")})`, async () => {
    const fetchMock = mockDeploymentFetch();
    fetchMock.mockResolvedValueOnce(response);
    await NodeAssert.rejects(checkDeployedProjectFileSchema("https://nightly.example.com"));
    NodeAssert.equal(fetchMock.mock.calls.length, 1);
    NodeAssert.equal(console.warn.mock.calls.length, 0);
  });
}

it("does not retry non-transient network errors", async () => {
  const fetchMock = mockDeploymentFetch();
  const error = new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } });
  fetchMock.mockRejectedValue(error);
  await NodeAssert.rejects(checkDeployedProjectFileSchema("https://nightly.example.com"), error);
  NodeAssert.equal(fetchMock.mock.calls.length, 1);
});

it("still rejects an incorrect schema after DNS recovers", async () => {
  const fetchMock = mockDeploymentFetch();
  fetchMock
    .mockRejectedValueOnce(new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }))
    .mockResolvedValueOnce(schemaResponse({ type: "object" }));
  const rejected = NodeAssert.rejects(
    checkDeployedProjectFileSchema("https://nightly.example.com"),
  );
  await vi.advanceTimersByTimeAsync(5_000);
  await rejected;
  NodeAssert.equal(fetchMock.mock.calls.length, 2);
});

it("rejects an asset larger than 25 MiB", () => {
  const filename = NodePath.join(directory, "oversized.wasm");
  NodeFS.writeFileSync(filename, "");
  NodeFS.truncateSync(filename, 25 * 1024 * 1024 + 1);
  NodeAssert.throws(() => checkCloudflareWeb(directory), /25 MiB asset limit/);
});
