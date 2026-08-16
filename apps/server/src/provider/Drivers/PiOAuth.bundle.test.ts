// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

const serverRoot = NodePath.resolve(import.meta.dirname, "../../..");

it("resolves OpenAI Codex OAuth from the bundled Pi runtime", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-oauth-bundle-test-"));
  const distDir = NodePath.join(tempDir, "dist");
  NodeFS.writeFileSync(
    NodePath.join(tempDir, "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "test-access-token",
        refresh: "test-refresh-token",
        expires: 4_102_444_800_000,
        accountId: "test-account",
      },
    }),
  );

  try {
    const packed = NodeChildProcess.spawnSync(
      "vp",
      ["pack", "scripts/pi-oauth-bundle-smoke.ts", "--out-dir", distDir, "--clean"],
      { cwd: serverRoot, encoding: "utf8" },
    );
    assert.strictEqual(packed.status, 0, packed.stderr || packed.stdout);

    const executed = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(distDir, "pi-oauth-bundle-smoke.mjs")],
      {
        cwd: serverRoot,
        encoding: "utf8",
        env: { ...process.env, PI_CODING_AGENT_DIR: tempDir },
      },
    );
    assert.strictEqual(executed.status, 0, executed.stderr || executed.stdout);
    assert.match(executed.stdout, /bundled Pi OAuth smoke test passed/);
  } finally {
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }
});
