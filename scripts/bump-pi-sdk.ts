#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Build-time script using Node builtins directly.
// Bump @earendil-works/pi-ai and @earendil-works/pi-coding-agent to the latest
// published version (both packages move in lockstep), refresh the lockfile,
// sync the license source URL, and open a PR. Human merges when CI is green:
// Pi is 0.x, so a minor can change SDK payload shapes and need adapter edits.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const PACKAGE_JSON = "apps/server/package.json";
const LICENSES_CONFIG = "third-party-licenses.config.json";
const PINS = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"];

const run = (command, args, options) =>
  NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  }).trim();

const latest = run("npm", ["view", "@earendil-works/pi-coding-agent", "dist-tags.latest"]);

const packageJson = JSON.parse(NodeFS.readFileSync(PACKAGE_JSON, "utf8"));
const current = packageJson.dependencies?.["@earendil-works/pi-coding-agent"];
const pinned = current?.replace(/^[^\d]*/, "");

if (pinned === latest) {
  console.log(`Pi SDK already at latest (${latest}); nothing to do.`);
  process.exit(0);
}

console.log(`Bumping Pi SDK ${pinned ?? current} -> ${latest}`);
for (const name of PINS) {
  packageJson.dependencies[name] = `^${latest}`;
}
NodeFS.writeFileSync(PACKAGE_JSON, `${JSON.stringify(packageJson, null, 2)}\n`);

// The earendil-works license override points at a versioned LICENSE URL.
const licenses = JSON.parse(NodeFS.readFileSync(LICENSES_CONFIG, "utf8"));
for (const override of licenses.packageOverrides ?? []) {
  if (override.repositoryUrl === "https://github.com/earendil-works/pi" && override.sourceUrl) {
    override.sourceUrl = override.sourceUrl.replace(/\/blob\/v[^/]+\//, `/blob/v${latest}/`);
  }
}
NodeFS.writeFileSync(LICENSES_CONFIG, `${JSON.stringify(licenses, null, 2)}\n`);

run("vp", ["i"]);
// Regenerates NOTICE files under version control; stage whatever it touches.
run("node", ["scripts/sync-third-party-license-notices.ts"]);

if (!run("git", ["status", "--porcelain"])) {
  console.log("No changes after install and license sync; nothing to do.");
  process.exit(0);
}

const branch = `chore/pi-sdk-${latest}`;
run("git", ["checkout", "-b", branch]);
run("git", ["add", PACKAGE_JSON, "pnpm-lock.yaml", LICENSES_CONFIG]);
// licenses:sync writes generated outputs (e.g. third-party notices) that are
// also committed, so stage the remainder of the working tree it produced.
if (run("git", ["status", "--porcelain"])) run("git", ["add", "-A"]);
run("git", ["commit", "-m", `chore(pi): bump Pi SDK to ${latest}`]);
run("git", ["push", "-u", "origin", branch]);
run("gh", [
  "pr",
  "create",
  "--title",
  `chore(pi): bump Pi SDK to ${latest}`,
  "--body",
  [
    `Automated Pi SDK bump ${pinned ?? current} → ${latest}.`,
    "",
    "Pi is 0.x, so a minor can change SDK payload shapes. Merge only when CI is green;",
    "if typecheck or Pi adapter tests fail, the bump needs adapter edits in the same PR.",
    "",
    "Includes lockfile refresh and third-party license sync. Generated with Rove Code.",
  ].join("\n"),
]);
console.log(`Opened PR for Pi SDK ${latest}.`);
