// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { stageRuntimePackageFixture } from "../../../../../scripts/lib/runtime-package-fixture.ts";

it("boots foreground and background Pi runtimes from a relocated Rove installation", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-extension-bundle-test-"));
  const serverRoot = NodePath.resolve(import.meta.dirname, "../../..");
  const distDir = NodePath.join(root, "dist");
  const project = NodePath.join(root, "project");
  const externalRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-external-package-"));
  const extensions = NodePath.join(project, ".pi", "extensions");
  NodeFS.mkdirSync(extensions, { recursive: true });
  NodeFS.copyFileSync(
    new URL("./fixtures/pi-extension.ts", import.meta.url),
    NodePath.join(extensions, "fixture.ts"),
  );
  NodeFS.copyFileSync(
    new URL("./fixtures/pi-runtime-probe.ts", import.meta.url),
    NodePath.join(extensions, "runtime-probe.ts"),
  );
  const externalExtension = NodePath.join(externalRoot, "index.mjs");
  NodeFS.copyFileSync(
    new URL("./fixtures/pi-host-sdk-probe.mjs", import.meta.url),
    externalExtension,
  );
  const agentDir = NodePath.join(root, "agent");
  NodeFS.mkdirSync(agentDir);
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "settings.json"),
    JSON.stringify({ extensions: [externalExtension] }),
  );
  try {
    stageRuntimePackageFixture(
      NodePath.join(serverRoot, "node_modules/@earendil-works/pi-coding-agent"),
      root,
    );
    // Separate roots (scripts/ and src/) would preserve those directories in a
    // multi-entry build. Production's entries all live in src/ and are siblings.
    for (const entry of ["scripts/pi-extensions-bundle-smoke.ts", "src/pi-runtime-worker.ts"]) {
      const packed = NodeChildProcess.spawnSync(
        "vp",
        ["pack", entry, "--out-dir", distDir, "--no-clean"],
        { cwd: serverRoot, encoding: "utf8", timeout: 90000 },
      );
      assert.strictEqual(packed.status, 0, packed.stderr || packed.stdout);
    }
    const executed = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(distDir, "pi-extensions-bundle-smoke.mjs"), project],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30000,
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          NODE_PATH: "",
          PI_PACKAGE_DIR: "",
          PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: "",
          PI_CODING_AGENT_DIR: NodePath.join(root, "agent"),
          PI_CODING_AGENT_SESSION_DIR: NodePath.join(root, "sessions"),
          PI_OFFLINE: "1",
        },
      },
    );
    assert.strictEqual(executed.status, 0, executed.stderr || executed.stdout);
    assert.include(executed.stdout, "bundled Pi extensions smoke test passed");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(externalRoot, { recursive: true, force: true });
  }
}, 120000);
