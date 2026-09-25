import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const paths = [
  ".env.example",
  "README.md",
  "CONTRIBUTING.md",
  ".github/SECURITY.md",
  ".github/ISSUE_TEMPLATE",
  ".github/workflows/release.yml",
  "docs/user",
  "apps/marketing/src",
  "apps/web/src",
  "apps/mobile/src",
  "apps/mobile/app.config.ts",
  "packages/shared/src/cliRelease.ts",
  "packages/shared/src/connectAuth.ts",
  "apps/server/src/cli/triagePrompt.ts",
  "scripts/install.sh",
  "scripts/install.ps1",
];
const publicFiles = NodeChildProcess.execFileSync("git", ["ls-files", "-z", "--", ...paths], {
  cwd: root,
  maxBuffer: 8 * 1024 * 1024,
})
  .toString("utf8")
  .split("\0")
  .filter(
    (file) =>
      file &&
      NodeFS.existsSync(NodePath.join(root, file)) &&
      !/(?:\.test\.|\.spec\.|\.snap$)/.test(file),
  );

const rules = [
  {
    name: "upstream-download",
    pattern: /(?:rovecode\/rove|pingdotgg\/t3code\/(?:releases|issues|discussions|raw))/i,
  },
  {
    name: "upstream-service",
    pattern:
      /(?:https?:\/\/[^\s"'<>]*t3\.codes|(?:clerk|app|latest\.app|nightly\.app)\.t3\.codes)/i,
  },
  {
    name: "upstream-package",
    pattern: /\b(?:npx\s+t3|npm\s+(?:install|view)\s+t3|t3@(?:latest|nightly|preview))\b/i,
  },
  { name: "upstream-support", pattern: /(?:security@ping\.gg|@t3dotgg|discord\.gg\/jn4EGJjrvv)/i },
  {
    name: "visible-upstream-name",
    pattern: /(?:\bT3Wordmark\b|\bT3 Chat\b|\bT3 (?:needs|Server)\b|aria-label=["']T3["'])/i,
  },
];

const findings = [];
for (const file of publicFiles) {
  if (!/\.(?:astro|html|md|mjs|json|ps1|sh|ts|tsx|yml)$/.test(file) && file !== ".env.example")
    continue;
  const lines = NodeFS.readFileSync(NodePath.join(root, file), "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const rule of rules) {
      if (rule.pattern.test(line)) findings.push({ file, line: index + 1, rule: rule.name });
    }
  }
}

for (const finding of findings) {
  console.log(`${finding.file}:${finding.line} ${finding.rule}`);
}
console.log(
  `Release identity findings: ${findings.length} across ${new Set(findings.map((hit) => hit.file)).size} files`,
);
if (process.argv.includes("--check") && findings.length > 0) process.exitCode = 1;
