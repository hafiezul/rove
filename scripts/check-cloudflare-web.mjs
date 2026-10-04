import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const defaultDirectory = NodeURL.fileURLToPath(new URL("../apps/web/dist", import.meta.url));
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 20_000;

export function checkCloudflareWeb(directory = defaultDirectory) {
  if (!NodeFS.statSync(NodePath.join(directory, "index.html")).isFile()) {
    throw new Error("The hosted build must contain index.html.");
  }

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
  const result = checkCloudflareWeb(process.argv[2]);
  console.log(`Cloudflare assets checked. ${result.files} files, ${result.bytes} bytes.`);
}
