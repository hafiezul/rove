#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const upstreamPublicIdentity =
  /t3\.codes|T3 Tools|@t3dotgg|\bnpx\s+t3(?:@|\b)|\bpingdotgg\b|d763fcb8-d37c-41ea-a773-b54a0ab4a454|ARK85ZXQ4Z|\b6787819824\b/i;

const surfaces = [
  {
    name: "marketing",
    readiness: "ROVE_MARKETING_RELEASE_READY",
    paths: ["apps/marketing/src", "apps/marketing/astro.config.mjs", "apps/marketing/vercel.ts"],
  },
  {
    name: "hosted web",
    readiness: "ROVE_HOSTED_RELEASE_READY",
    paths: ["apps/web/vercel.ts"],
  },
  {
    name: "mobile stores",
    readiness: "ROVE_MOBILE_STORES_READY",
    paths: [
      "apps/mobile/app.config.ts",
      "apps/mobile/eas.json",
      "apps/mobile/src/features/settings/lib/legal-document-url.ts",
    ],
  },
];

function sourceFiles(root, entry) {
  const absolute = NodePath.join(root, entry);
  if (!NodeFS.statSync(absolute).isDirectory()) return [entry];
  return NodeFS.readdirSync(absolute, { withFileTypes: true }).flatMap((child) =>
    child.isDirectory()
      ? sourceFiles(root, NodePath.join(entry, child.name))
      : /\.(?:astro|mjs|ts|tsx)$/.test(child.name)
        ? [NodePath.join(entry, child.name)]
        : [],
  );
}

export function findUpstreamPublicIdentity(source) {
  return source
    .split(/\r?\n/)
    .flatMap((line, index) =>
      upstreamPublicIdentity.test(line) ? [{ line: index + 1, text: line.trim() }] : [],
    );
}

export function checkReleaseIdentity(root = repoRoot, env = process.env) {
  const blocked = [];
  for (const surface of surfaces) {
    const findings = surface.paths.flatMap((entry) =>
      sourceFiles(root, entry).flatMap((file) =>
        findUpstreamPublicIdentity(NodeFS.readFileSync(NodePath.join(root, file), "utf8")).map(
          (finding) => ({
            file: NodePath.relative(root, NodePath.join(root, file)),
            ...finding,
          }),
        ),
      ),
    );
    if (findings.length === 0) continue;
    const enabled = env[surface.readiness] === "true";
    console.log(`${surface.name} (${enabled ? "BLOCKED" : `gated by ${surface.readiness}`}):`);
    for (const finding of findings) {
      console.log(`  ${finding.file}:${finding.line}: ${finding.text}`);
    }
    if (enabled) blocked.push(surface.name);
  }
  if (blocked.length > 0) {
    console.error(
      `Refusing publication for: ${blocked.join(", ")}. Replace or remove upstream claims first.`,
    );
  }
  return blocked.length === 0;
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  process.exitCode = checkReleaseIdentity() ? 0 : 1;
}
