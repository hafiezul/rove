// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import { resolvePiModelForSession, resolvePiSessionFileForTest } from "./PiSessionFactory.ts";

it("resolves a valid custom model for an in-session switch", async () => {
  const agentDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-factory-model-test-"));
  const modelsPath = NodePath.join(agentDir, "models.json");
  NodeFS.writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        "rootsys.cloud": {
          baseUrl: "https://example.test/v1",
          apiKey: "test-key",
          api: "openai-completions",
          models: [
            {
              id: "kimi-k3",
              name: "Kimi K3",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 8_192,
            },
          ],
        },
      },
    }),
  );

  try {
    const modelRuntime = await ModelRuntime.create({
      modelsPath,
      authPath: NodePath.join(agentDir, "auth.json"),
      allowModelNetwork: false,
    });

    const model = resolvePiModelForSession(modelRuntime, "rootsys.cloud/kimi-k3");

    assert.strictEqual(model.provider, "rootsys.cloud");
    assert.strictEqual(model.id, "kimi-k3");
  } finally {
    NodeFS.rmSync(agentDir, { recursive: true, force: true });
  }
});

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
