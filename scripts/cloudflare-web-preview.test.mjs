import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import { afterEach, it, vi } from "vite-plus/test";

import {
  cloudflarePreviewRequest,
  previewDeployment,
  previewWorkerName,
} from "./cloudflare-web-preview.mjs";
import { hostedBuildDefines } from "../apps/web/vite/hostedBuild.ts";

afterEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllEnvs());

it("builds an isolated static Worker configuration without production routes or bindings", () => {
  const deployment = previewDeployment(
    42,
    "rove-test",
    {
      name: "rove-web",
      compatibility_date: "2025-04-01",
      routes: [{ pattern: "rove.hafiezulzikry.com", custom_domain: true }],
      workers_dev: false,
      main: "production-server.js",
      vars: { SECRET: "production-only" },
      kv_namespaces: [{ binding: "PRODUCTION" }],
    },
    "/tmp/preview/dist",
  );
  NodeAssert.equal(deployment.origin, "https://rove-web-pr-42.rove-test.workers.dev");
  NodeAssert.equal(deployment.config.name, "rove-web-pr-42");
  NodeAssert.equal(deployment.config.assets.directory, NodePath.resolve("/tmp/preview/dist"));
  for (const key of ["routes", "main", "vars", "kv_namespaces"]) {
    NodeAssert.equal(key in deployment.config, false);
  }
  const defines = hostedBuildDefines(deployment.origin);
  NodeAssert.equal(JSON.parse(defines["import.meta.env.VITE_HOSTED_APP_URL"]), deployment.origin);
  NodeAssert.equal(JSON.parse(defines["import.meta.env.VITE_ROVE_RELAY_URL"]), "");
});

it("gives each PR a stable origin without sharing Workers", () => {
  const first = previewDeployment(1, "rove", {}, ".");
  NodeAssert.deepEqual(first, previewDeployment(1, "rove", {}, "."));
  NodeAssert.notEqual(first.origin, previewDeployment(2, "rove", {}, ".").origin);
});

for (const prNumber of [0, -1, "../rove-web", "1\nname=rove-web"]) {
  it(`rejects unsafe preview names ${prNumber}`, () => {
    NodeAssert.throws(() => previewWorkerName(prNumber));
  });
}

for (const subdomain of ["", "rove.example.com", "rove\nVITE_HTTP_URL=bad"]) {
  it(`rejects unsafe workers.dev subdomains ${subdomain}`, () => {
    NodeAssert.throws(() => previewDeployment(1, subdomain, {}, "."));
  });
}

it("treats deletion of an absent preview as complete", async () => {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-fixture");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token-fixture");
  vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
  NodeAssert.equal(
    await cloudflarePreviewRequest("workers/scripts/rove-web-pr-42", "DELETE"),
    undefined,
  );
});

it("does not mistake permission errors for a completed cleanup", async () => {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-fixture");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token-fixture");
  vi.stubGlobal("fetch", async () =>
    Response.json({ success: false, errors: [{ message: "Denied" }] }, { status: 403 }),
  );
  await NodeAssert.rejects(
    cloudflarePreviewRequest("workers/scripts/rove-web-pr-42", "DELETE"),
    /HTTP 403/,
  );
});
