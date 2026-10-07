import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { parseUpdateManifest } from "./lib/update-manifest.ts";

export async function checkReleaseAssets(directory) {
  const manifests = NodeFS.readdirSync(directory).filter((name) =>
    /^(?:latest|nightly)(?:-[a-z0-9]+)*\.yml$/.test(name),
  );
  if (manifests.length === 0) throw new Error("No updater manifests were produced.");

  const verified = new Set();
  for (const name of manifests) {
    const filename = NodePath.join(directory, name);
    const manifest = parseUpdateManifest(NodeFS.readFileSync(filename, "utf8"), filename, name);
    for (const file of manifest.files) {
      if (!/^[a-zA-Z0-9._-]+$/.test(file.url) || file.url === "." || file.url === "..") {
        throw new Error(`${name} references a non-portable release filename: ${file.url}`);
      }
      const artifact = NodePath.join(directory, file.url);
      if (!NodeFS.existsSync(artifact)) {
        throw new Error(`${name} references a missing release asset: ${file.url}`);
      }
      if (NodeFS.statSync(artifact).size !== file.size) {
        throw new Error(`${name} has the wrong size for ${file.url}`);
      }
      const hash = NodeCrypto.createHash("sha512");
      for await (const chunk of NodeFS.createReadStream(artifact)) hash.update(chunk);
      if (hash.digest("base64") !== file.sha512) {
        throw new Error(`${name} has the wrong sha512 for ${file.url}`);
      }
      verified.add(file.url);
    }
  }
  return { manifests: manifests.length, files: verified.size };
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const result = await checkReleaseAssets(process.argv[2] ?? "release-assets");
  console.log(`Release assets verified. ${result.manifests} manifests, ${result.files} files.`);
}
