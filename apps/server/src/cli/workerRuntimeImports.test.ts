// @effect-diagnostics nodeBuiltinImport:off - Import isolation must exercise a fresh CLI process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";

const entry = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));
const rejectWorkerImports = String.raw`
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      /\/(?:piRuntimeWorker|claudeHistoryWorker)\.ts$/.test(specifier) ||
      specifier === "@earendil-works/pi-coding-agent"
    ) {
      throw new Error("Unused worker implementation loaded by the CLI");
    }
    return nextResolve(specifier, context);
  }
});
`;

it.each(["--help", "--version"])(
  "runs %s without loading worker implementations or the Pi SDK",
  (flag) => {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      ["--import", `data:text/javascript,${encodeURIComponent(rejectWorkerImports)}`, entry, flag],
      { encoding: "utf8", timeout: 30_000 },
    );

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.isNotEmpty(result.stdout);
  },
);

it("reads an absent Claude session through the hidden history command", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-cli-history-"));
  try {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        entry,
        "__claude-history",
        "getSessionMessages",
        "00000000-0000-0000-0000-000000000000",
        JSON.stringify({ dir: directory }),
      ],
      { encoding: "utf8", timeout: 30_000 },
    );

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(result.stdout.trim(), "[]");
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("executes the Pi worker only when its hidden command is selected", () => {
  const result = NodeChildProcess.spawnSync(process.execPath, [entry, "__pi-runtime"], {
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.strictEqual(result.status, 1, result.stderr || result.stdout);
  assert.include(result.stderr + result.stdout, "Pi runtime requires a parent IPC channel.");
});
