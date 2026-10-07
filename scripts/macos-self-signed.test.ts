// @effect-diagnostics nodeBuiltinImport:off - Shell integration tests control subprocess PATH and inspect temporary keychain files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { fromYaml } from "@rove-code/shared/schemaYaml";
import { afterEach, assert, it } from "vite-plus/test";

const fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
const directories: string[] = [];
const decodeStringArray = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

function runner() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-signing-test-"));
  directories.push(root);
  const envFile = NodePath.join(root, "github-env");
  const logFile = NodePath.join(root, "commands.jsonl");
  const executable = (name: string, body: string) =>
    NodeFS.writeFileSync(NodePath.join(root, name), `#!${process.execPath}\n${body}`, {
      mode: 0o700,
    });
  executable(
    "sudo",
    `
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.argv[2], process.argv.slice(3), { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  `,
  );
  executable(
    "security",
    `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(args) + '\\n');
    switch (args[0]) {
      case 'import':
        if (process.env.IMPORT_FAIL) process.exit(1);
        break;
      case 'find-certificate':
        console.log('-----BEGIN CERTIFICATE-----\\nfixture\\n-----END CERTIFICATE-----');
        break;
      case 'find-identity':
        console.log('  1) ' + (process.env.WRONG_IDENTITY ? '0'.repeat(40) : '${fingerprint}') + ' "Rove Code Release Signing"');
        break;
      case 'list-keychains':
        if (!args.includes('-s')) console.log('    "/tmp/existing keychain-db"');
        break;
    }
  `,
  );
  executable(
    "openssl",
    `
    console.log(process.argv[2] === 'rand' ? 'temporary-keychain-password' : 'sha1 Fingerprint=${fingerprint}');
  `,
  );
  executable(
    "vp",
    `
    const fs = require('node:fs');
    fs.mkdirSync('release', { recursive: true });
    if (!process.env.NO_ZIP) fs.writeFileSync('release/update.zip', 'fixture');
    fs.writeFileSync('build-args.json', JSON.stringify(process.argv.slice(2)));
  `,
  );
  executable(
    "ditto",
    `
    const fs = require('node:fs');
    const path = require('node:path');
    if (!process.env.EMPTY_ZIP) fs.mkdirSync(path.join(process.argv.at(-1), 'Rove Code.app'), { recursive: true });
  `,
  );
  executable(
    "codesign",
    `
    if (process.argv.includes('--verify')) {
      const requirement = process.argv[process.argv.indexOf('-R') + 1];
      if (!requirement?.startsWith('=')) {
        console.error('invalid requirement specification');
        process.exit(1);
      }
      process.exit(process.env.SIGNATURE_FAIL ? 1 : 0);
    }
    console.error(process.env.REQUIREMENT || 'designated => identifier "io.github.hafiezul.rove" and anchor H"${fingerprint}"');
  `,
  );
  const env = {
    ...process.env,
    PATH: `${root}${NodePath.delimiter}${process.env.PATH}`,
    RUNNER_TEMP: root,
    GITHUB_ENV: envFile,
    COMMAND_LOG: logFile,
    CSC_LINK: Buffer.from("private signing identity fixture").toString("base64"),
    CSC_KEY_PASSWORD: "export-password-fixture",
    CSC_NAME: "Rove Code Release Signing",
    ROVE_MACOS_SIGNING_CERT_SHA1: fingerprint,
  };
  return {
    root,
    envFile,
    logFile,
    runWorkflow(overrides: Record<string, string> = {}) {
      const steps = Schema.decodeSync(
        fromYaml(
          Schema.Struct({
            jobs: Schema.Struct({
              build: Schema.Struct({
                steps: Schema.Array(
                  Schema.Struct({
                    name: Schema.optional(Schema.String),
                    run: Schema.optional(Schema.String),
                  }),
                ),
              }),
            }),
          }),
        ),
      )(
        NodeFS.readFileSync(
          NodePath.resolve(import.meta.dirname, "../.github/workflows/release-desktop.yml"),
          "utf8",
        ),
      ).jobs.build.steps;
      const step = steps.find((candidate) => candidate.name === "Build desktop artifact");
      assert.isString(step?.run);
      const script = step!
        .run!.replaceAll("${{ inputs.platform }}", "mac")
        .replaceAll("${{ inputs.target }}", "dmg")
        .replaceAll("${{ inputs.arch }}", "arm64")
        .replaceAll("${{ inputs.version }}", "1.2.3-preview.1")
        .replaceAll("${{ inputs.release_channel }}", "preview");
      NodeFS.mkdirSync(NodePath.join(root, "scripts"));
      NodeFS.symlinkSync(
        NodePath.resolve(import.meta.dirname, "verify-macos-self-signed.sh"),
        NodePath.join(root, "scripts/verify-macos-self-signed.sh"),
      );
      NodeFS.mkdirSync(NodePath.join(root, "apps/desktop"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(root, "apps/desktop/package.json"),
        '{"productName":"Rove Code"}',
      );
      return NodeChildProcess.execFileSync("bash", ["-e", "-o", "pipefail"], {
        input: script,
        cwd: root,
        env: {
          ...env,
          ROVE_MACOS_SIGNING_MODE: "self-signed",
          CSC_KEYCHAIN: "fixture",
          GITHUB_STEP_SUMMARY: NodePath.join(root, "summary"),
          ...overrides,
        },
        encoding: "utf8",
        stdio: "pipe",
      });
    },
    run(script: "import" | "verify", overrides: Record<string, string> = {}) {
      return NodeChildProcess.execFileSync(
        "bash",
        [
          NodePath.resolve(import.meta.dirname, `${script}-macos-self-signed.sh`),
          ...(script === "verify" ? ["/tmp/Rove Code.app"] : []),
        ],
        { env: { ...env, ...overrides }, encoding: "utf8", stdio: "pipe" },
      );
    },
  };
}

it("imports a reusable identity, scopes trust to code signing, and removes the private export", () => {
  const fixture = runner();
  const output = fixture.run("import");
  const exported = NodeFS.readFileSync(fixture.envFile, "utf8");
  assert.include(exported, `ROVE_CLI_MAC_SIGN_IDENTITY=${fingerprint}`);
  assert.include(exported, `ROVE_MACOS_SIGNING_CERT_SHA1=${fingerprint}`);
  assert.include(exported, "CSC_KEYCHAIN=");
  assert.notInclude(exported, "export-password-fixture");
  assert.notInclude(exported, "temporary-keychain-password");
  assert.notInclude(output, "export-password-fixture");
  const commands = NodeFS.readFileSync(fixture.logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => decodeStringArray(line));
  const trust = commands.find((args) => args[0] === "add-trusted-cert");
  assert.deepEqual(trust?.slice(1, 6), ["-d", "-r", "trustRoot", "-p", "codeSign"]);
  const searchList = commands.find((args) => args[0] === "list-keychains" && args.includes("-s"));
  assert.include(searchList ?? [], "/tmp/existing keychain-db");
  const signingDirectory = NodeFS.readdirSync(fixture.root).find((entry) =>
    entry.startsWith("rove-self-signed."),
  );
  assert.isDefined(signingDirectory);
  assert.notInclude(
    NodeFS.readdirSync(NodePath.join(fixture.root, signingDirectory!)),
    "identity.p12",
  );
});

it.each([{ IMPORT_FAIL: "1" }, { WRONG_IDENTITY: "1" }, { CSC_KEY_PASSWORD: "" }])(
  "does not export a signing identity when preparation fails with %j",
  (failure) => {
    const fixture = runner();
    assert.throws(() => fixture.run("import", failure));
    assert.notInclude(NodeFS.readdirSync(fixture.root), "github-env");
  },
);

it("accepts a certificate-pinned update requirement", () => {
  assert.include(runner().run("verify"), fingerprint);
});

it.each([
  `designated => identifier "io.github.hafiezul.rove" and anchor H"${fingerprint}" and anchor trusted`,
  `designated => cdhash H"${fingerprint}"`,
  'designated => identifier "io.github.hafiezul.rove" and anchor H"0000000000000000000000000000000000000000"',
])("rejects an unsuitable update requirement %s", (requirement) => {
  assert.throws(() => runner().run("verify", { REQUIREMENT: requirement }));
});

it("fails verification when codesign rejects the app", () => {
  assert.throws(() => runner().run("verify", { SIGNATURE_FAIL: "1" }));
});

it("verifies the app extracted from the actual update ZIP before accepting a release build", () => {
  const fixture = runner();
  assert.include(fixture.runWorkflow(), fingerprint);
  const args = decodeStringArray(
    NodeFS.readFileSync(NodePath.join(fixture.root, "build-args.json"), "utf8"),
  );
  assert.include(args, "--signed");
  assert.deepEqual(NodeFS.readdirSync(NodePath.join(fixture.root, "release")), ["update.zip"]);
  assert.include(
    NodeFS.readFileSync(NodePath.join(fixture.root, "summary"), "utf8"),
    "not notarized",
  );
});

it.each([
  { NO_ZIP: "1" },
  { EMPTY_ZIP: "1" },
  { SIGNATURE_FAIL: "1" },
  { CSC_KEYCHAIN: "" },
  { ROVE_MACOS_SIGNING_MODE: "adhoc" },
])("rejects an unusable self-signed release with %j", (failure) => {
  assert.throws(() => runner().runWorkflow(failure));
});
