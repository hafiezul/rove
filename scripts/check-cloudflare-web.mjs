import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { buildRoveProjectFileJsonSchema } from "@rove-code/shared/roveProjectFile";

function checkProjectFileSchema(raw, expectedSchema) {
  NodeAssert.deepEqual(JSON.parse(raw), expectedSchema);
}

export function readBuiltProjectFileSchema(directory = defaultDirectory) {
  const schema = JSON.parse(
    NodeFS.readFileSync(NodePath.join(directory, "schema/rove.json"), "utf8"),
  );
  const canonical = buildRoveProjectFileJsonSchema();
  NodeAssert.equal(schema.$schema, canonical.$schema);
  NodeAssert.equal(schema.$id, canonical.$id);
  NodeAssert.equal(schema.type, "object");
  return schema;
}

const RETRYABLE_NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const DEPLOY_CHECK_ATTEMPTS = 6;

export async function checkDeployedProjectFileSchema(
  origin,
  expectedSchema = buildRoveProjectFileJsonSchema(),
) {
  const url = new URL("/schema/rove.json", origin);
  // A new custom domain can take time to resolve after Wrangler reports success.
  for (let attempt = 1; attempt <= DEPLOY_CHECK_ATTEMPTS; attempt++) {
    let failure;
    const signal = AbortSignal.timeout(10_000);
    try {
      const response = await fetch(url, { signal });
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        failure = new Error(`${url} returned HTTP ${response.status}`);
      } else {
        if (
          !response.ok ||
          !/application\/(?:schema\+)?json\b/i.test(response.headers.get("content-type") ?? "")
        ) {
          await response.body?.cancel();
          throw new Error(
            `${url} must return JSON Schema, received HTTP ${response.status} ${response.headers.get("content-type")}`,
          );
        }
        checkProjectFileSchema(await response.text(), expectedSchema);
        return;
      }
    } catch (error) {
      if (
        error.name !== "TimeoutError" &&
        !(signal.aborted && signal.reason?.name === "TimeoutError") &&
        !RETRYABLE_NETWORK_CODES.has(error.cause?.code)
      ) {
        throw error;
      }
      failure = error;
    }
    if (attempt === DEPLOY_CHECK_ATTEMPTS) throw failure;
    const retryDelay = Math.min(5_000 * 2 ** (attempt - 1), 30_000);
    console.warn(
      `Schema check attempt ${attempt}/${DEPLOY_CHECK_ATTEMPTS} failed: ${failure.cause?.code ?? failure.message}. Retrying in ${retryDelay / 1_000}s.`,
    );
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }
}

const defaultDirectory = NodeURL.fileURLToPath(new URL("../apps/web/dist", import.meta.url));
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 20_000;

export function checkCloudflareWeb(
  directory = defaultDirectory,
  expectedSchema = buildRoveProjectFileJsonSchema(),
) {
  if (!NodeFS.statSync(NodePath.join(directory, "index.html")).isFile()) {
    throw new Error("The hosted build must contain index.html.");
  }

  checkProjectFileSchema(
    NodeFS.readFileSync(NodePath.join(directory, "schema/rove.json"), "utf8"),
    expectedSchema,
  );

  const files = NodeFS.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(
    (entry) => entry.isFile(),
  );
  if (files.length > MAX_FILES) {
    throw new Error(`The hosted build exceeds Cloudflare's free limit of ${MAX_FILES} files.`);
  }

  let bytes = 0;
  for (const file of files) {
    const filename = NodePath.join(file.parentPath, file.name);
    if (file.name.endsWith(".map") || file.name.startsWith(".env")) {
      throw new Error(`Refusing to upload ${NodePath.relative(directory, filename)}.`);
    }
    const size = NodeFS.statSync(filename).size;
    if (size > MAX_FILE_BYTES) {
      throw new Error(
        `${NodePath.relative(directory, filename)} exceeds Cloudflare's 25 MiB asset limit.`,
      );
    }
    bytes += size;
  }

  return { files: files.length, bytes };
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--built-schema");
  const directory = args[0] === "--url" ? defaultDirectory : (args[0] ?? defaultDirectory);
  const expectedSchema = process.argv.includes("--built-schema")
    ? readBuiltProjectFileSchema(directory)
    : buildRoveProjectFileJsonSchema();
  if (args[0] === "--url") {
    await checkDeployedProjectFileSchema(args[1], expectedSchema);
    console.log("Deployed project file schema verified.");
  } else {
    const result = checkCloudflareWeb(directory, expectedSchema);
    console.log(`Cloudflare assets checked. ${result.files} files, ${result.bytes} bytes.`);
  }
}
