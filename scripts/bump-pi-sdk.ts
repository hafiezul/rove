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
const CODING_AGENT_PIN = "@earendil-works/pi-coding-agent";
const PI_LICENSE_REPOSITORY = "https://github.com/earendil-works/pi";

interface ServerPackageJson {
  dependencies?: Record<string, string> | undefined;
  [key: string]: unknown;
}

interface PiLicenseOverride {
  repositoryUrl?: string | undefined;
  sourceUrl?: string | undefined;
  [key: string]: unknown;
}

interface ThirdPartyLicensesFile {
  packageOverrides?: Array<PiLicenseOverride> | undefined;
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonFile = (path: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`Expected a JSON object in ${path}.`);
  return parsed;
};

const readStringMap = (value: unknown): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Expected dependencies to be an object.");
  const entries = Object.entries(value).map(([key, entry]) => {
    if (typeof entry !== "string") throw new Error(`Expected "${key}" to be a string.`);
    return [key, entry] as const;
  });
  return Object.fromEntries(entries);
};

const readLicenseOverride = (value: unknown, context: string): PiLicenseOverride => {
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  // Spread first: overrides carry generatedNotice/noticeFile/license fields
  // the bump must not strip; only sourceUrl is rewritten.
  const { repositoryUrl, sourceUrl } = value;
  if (repositoryUrl !== undefined && typeof repositoryUrl !== "string") {
    throw new Error(`${context} has a non-string repositoryUrl.`);
  }
  if (sourceUrl !== undefined && typeof sourceUrl !== "string") {
    throw new Error(`${context} has a non-string sourceUrl.`);
  }
  return { ...value, repositoryUrl, sourceUrl };
};

const readLicenseOverrides = (value: unknown): Array<PiLicenseOverride> | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Expected packageOverrides to be an array.");
  return value.map((entry, index) =>
    readLicenseOverride(entry, `packageOverrides[${String(index)}]`),
  );
};

const CONFIG_READERS = {
  // Spread first so unrelated top-level fields (name, scripts, customNotices,
  // …) survive the round-trip; only the bumped fields are replaced.
  packageJson: (path: string): ServerPackageJson => {
    const parsed = readJsonFile(path);
    return { ...parsed, dependencies: readStringMap(parsed.dependencies) };
  },
  licenses: (path: string): ThirdPartyLicensesFile => {
    const parsed = readJsonFile(path);
    return { ...parsed, packageOverrides: readLicenseOverrides(parsed.packageOverrides) };
  },
};

type PiSdkBumpPlan =
  | { readonly action: "up-to-date"; readonly version: string }
  | { readonly action: "bump"; readonly from: string; readonly to: string };

export const planPiSdkBump = (input: {
  readonly latest: string;
  readonly packageJson: ServerPackageJson;
}): PiSdkBumpPlan => {
  const current = input.packageJson.dependencies?.[CODING_AGENT_PIN];
  const pinned = current?.replace(/^[^\d]*/, "");
  if (pinned === input.latest) return { action: "up-to-date", version: input.latest };
  return { action: "bump", from: pinned ?? current ?? "unknown", to: input.latest };
};

export const piSdkBranch = (version: string): string => `chore/pi-sdk-${version}`;

type PiSdkBranchPlan =
  | { readonly action: "reuse"; readonly branch: string }
  | { readonly action: "create"; readonly branch: string };

export const planPiSdkBranch = (input: {
  readonly currentBranch: string;
  readonly targetBranch: string;
}): PiSdkBranchPlan =>
  input.currentBranch === input.targetBranch
    ? { action: "reuse", branch: input.targetBranch }
    : { action: "create", branch: input.targetBranch };

interface PiSdkBumpResult {
  readonly packageJson: ServerPackageJson;
  readonly licenses: ThirdPartyLicensesFile;
}

export const applyPiSdkBump = (input: {
  readonly packageJson: ServerPackageJson;
  readonly licenses: ThirdPartyLicensesFile;
  readonly latest: string;
}): PiSdkBumpResult => {
  const nextPackageJson: ServerPackageJson = {
    ...input.packageJson,
    dependencies: { ...input.packageJson.dependencies },
  };
  for (const name of PINS) {
    if (nextPackageJson.dependencies) nextPackageJson.dependencies[name] = `^${input.latest}`;
  }
  const nextLicenses: ThirdPartyLicensesFile = {
    ...input.licenses,
    packageOverrides: input.licenses.packageOverrides?.map((override) =>
      override.repositoryUrl === PI_LICENSE_REPOSITORY && override.sourceUrl
        ? {
            ...override,
            sourceUrl: override.sourceUrl.replace(/\/blob\/v[^/]+\//, `/blob/v${input.latest}/`),
          }
        : override,
    ),
  };
  return { packageJson: nextPackageJson, licenses: nextLicenses };
};

const run = (command: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

// spawnSync (no throw) for probes where a non-zero exit is an expected answer,
// e.g. `gh pr list` finds no open PR, or `gh` has no auth in a local harness.
const runOptional = (command: string, args: ReadonlyArray<string>): string =>
  String(NodeChildProcess.spawnSync(command, args, { encoding: "utf8" }).stdout ?? "").trim();

// Head-branch lookup, so a rerun while the bump PR is open (possibly with
// human adapter edits) skips instead of force-pushing over that work.
const openPrForBranch = (branch: string): string =>
  runOptional("gh", [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[].number",
  ]);

const log = (message: string): void => {
  NodeFS.writeFileSync(1, `${message}\n`);
};

const main = (): void => {
  const latest = run("npm", ["view", CODING_AGENT_PIN, "dist-tags.latest"]);
  const packageJson = CONFIG_READERS.packageJson(PACKAGE_JSON);
  const plan = planPiSdkBump({ latest, packageJson });

  if (plan.action === "up-to-date") {
    log(`Pi SDK already at latest (${plan.version}); nothing to do.`);
    return;
  }

  log(`Bumping Pi SDK ${plan.from} -> ${plan.to}`);
  const licenses = CONFIG_READERS.licenses(LICENSES_CONFIG);
  const next = applyPiSdkBump({ packageJson, licenses, latest: plan.to });
  NodeFS.writeFileSync(PACKAGE_JSON, `${JSON.stringify(next.packageJson, null, 2)}\n`);
  NodeFS.writeFileSync(LICENSES_CONFIG, `${JSON.stringify(next.licenses, null, 2)}\n`);

  // The manifest just changed, so a frozen install refuses to run here. Regenerate
  // the lockfile instead; CI verifies the result on the opened PR.
  run("vp", ["install", "--lockfile-only", "--ignore-scripts"]);
  // Refresh the SPDX cache for any new generated notices.
  run("node", ["scripts/sync-third-party-license-notices.ts"]);

  if (!run("git", ["status", "--porcelain"])) {
    log("No changes after install and license sync; nothing to do.");
    return;
  }

  const branch = piSdkBranch(plan.to);
  // A rerun must not clobber a bump branch a human may have edited, so
  // check for an open PR before rewriting any history. `gh` probing
  // failures (auth/network) return empty and fall through to the push path.
  const existingPr = openPrForBranch(branch);
  if (existingPr) {
    log(`PR #${existingPr} is already open for Pi SDK ${plan.to}; leaving it alone.`);
    return;
  }
  const remoteBranchOid =
    run("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]).split(/\s+/, 1)[0] ?? "";
  const branchPlan = planPiSdkBranch({
    currentBranch: run("git", ["branch", "--show-current"]),
    targetBranch: branch,
  });
  if (branchPlan.action === "create") {
    // -B (not -b) so a rerun after a partial failure resets the stale branch
    // instead of dying with "branch already exists".
    run("git", ["checkout", "-B", branch]);
  }
  // Only the manifest inputs are written above (`vp install --lockfile-only`
  // refreshes the lockfile in place), so stage exactly those known files.
  // `git add` skips lockfile paths missing from the index; the empty-commit
  // guard below handles the case where nothing changed.
  const candidates = [PACKAGE_JSON, "pnpm-lock.yaml", LICENSES_CONFIG];
  for (const file of candidates) {
    try {
      run("git", ["add", "--", file]);
    } catch {
      // Missing from the working tree or index (e.g. a fixture repo without
      // a lockfile): leave it out of the commit rather than failing.
    }
  }
  // `git diff --cached --quiet` exits 1 when staged changes exist, so a
  // throwing `run` cannot probe it. spawnSync reports the answer via status.
  const staged = NodeChildProcess.spawnSync("git", ["diff", "--cached", "--quiet"], {
    stdio: "ignore",
  });
  if (staged.status === 0) {
    log("No changes after install and license sync; nothing to do.");
    return;
  }
  // licenses:sync only writes the gitignored SPDX cache under .generated/, so the
  // three tracked files above are the whole commit; no `git add -A` here.
  run("git", ["commit", "-m", `chore(pi): bump Pi SDK to ${plan.to}`]);
  run("git", [
    "push",
    `--force-with-lease=refs/heads/${branch}:${remoteBranchOid}`,
    "-u",
    "origin",
    branch,
  ]);
  run("gh", [
    "pr",
    "create",
    "--title",
    `chore(pi): bump Pi SDK to ${plan.to}`,
    "--body",
    [
      `Automated Pi SDK bump ${plan.from} → ${plan.to}.`,
      "",
      "Pi is 0.x, so a minor can change SDK payload shapes. Merge only when CI is green;",
      "if typecheck or Pi adapter tests fail, the bump needs adapter edits in the same PR.",
      "",
      "Includes lockfile refresh and third-party license sync. Generated with Rove Code.",
    ].join("\n"),
  ]);
  log(`Opened PR for Pi SDK ${plan.to}.`);
};

if (import.meta.main) main();
