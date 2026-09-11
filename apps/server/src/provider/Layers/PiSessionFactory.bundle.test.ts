// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

it("runs extensions from a bundled server without Pi packages installed alongside it", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-extension-bundle-test-"));
  const serverRoot = NodePath.resolve(import.meta.dirname, "../../..");
  const distDir = NodePath.join(root, "dist");
  const project = NodePath.join(root, "project");
  const extensions = NodePath.join(project, ".pi", "extensions");
  NodeFS.mkdirSync(extensions, { recursive: true });
  NodeFS.copyFileSync(
    new URL("./fixtures/pi-extension.ts", import.meta.url),
    NodePath.join(extensions, "fixture.ts"),
  );
  try {
    const packed = NodeChildProcess.spawnSync(
      "vp",
      ["pack", "scripts/pi-extensions-bundle-smoke.ts", "--out-dir", distDir, "--clean"],
      {
        cwd: serverRoot,
        encoding: "utf8",
        timeout: 90000,
      },
    );
    assert.strictEqual(packed.status, 0, packed.stderr || packed.stdout);
    const executed = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(distDir, "pi-extensions-bundle-smoke.mjs"), project],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30000,
        env: {
          ...process.env,
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
  }
}, 120000);
