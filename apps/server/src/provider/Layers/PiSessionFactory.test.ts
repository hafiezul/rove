// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { resolvePiSessionFileForTest } from "./PiSessionFactory.ts";

it("resolveSessionFile finds the persisted file for a session id", () => {
  const cwd = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-factory-test-")),
  );
  const sessionDir = SessionManager.create(cwd).getSessionDir();
  const sessionId = "01a00000-1111-2222-3333-444455556666";

  // resolveSessionFile only depends on the `<timestamp>_<id>.jsonl` naming
  // contract, so create that file directly rather than racing the SDK's
  // deferred write/flush.
  const fileName = `2026-08-16T00-00-00-000Z_${sessionId}.jsonl`;
  NodeFS.writeFileSync(NodePath.join(sessionDir, fileName), "{}\n");

  try {
    const resolved = resolvePiSessionFileForTest(cwd, sessionId);
    assert.isDefined(resolved);
    assert.isTrue(resolved!.endsWith(`_${sessionId}.jsonl`));
    assert.strictEqual(NodePath.dirname(resolved!), sessionDir);
    assert.isTrue(NodeFS.existsSync(resolved!));
  } finally {
    // Clean up the session dir we created in the global Pi sessions root.
    NodeFS.rmSync(sessionDir, { recursive: true, force: true });
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

it("resolveSessionFile returns undefined for an unknown session id", () => {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-factory-test-"));
  const sessionDir = SessionManager.create(cwd).getSessionDir();
  try {
    const resolved = resolvePiSessionFileForTest(cwd, "00000000-0000-0000-0000-000000000000");
    assert.isUndefined(resolved);
  } finally {
    NodeFS.rmSync(sessionDir, { recursive: true, force: true });
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});
