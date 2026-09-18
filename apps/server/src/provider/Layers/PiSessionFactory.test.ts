// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { PiSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";

import {
  createPiSession,
  resolvePiModelForSession,
  resolvePiSessionResume,
} from "./PiSessionFactory.ts";
import {
  makePiAdapter,
  parsePiResumeCursor,
  type PiSessionEventLike,
  type PiSessionLike,
} from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

describe("headless Pi extensions", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  const sessions: PiSessionLike[] = [];

  beforeEach(() => {
    root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-pi-extensions-")),
    );
    cwd = NodePath.join(root, "project");
    agentDir = NodePath.join(root, "agent");
    NodeFS.mkdirSync(NodePath.join(cwd, ".pi", "extensions"), { recursive: true });
    NodeFS.mkdirSync(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_OFFLINE", "1");
    NodeFS.copyFileSync(
      new URL("./fixtures/pi-extension.ts", import.meta.url),
      NodePath.join(cwd, ".pi", "extensions", "fixture.ts"),
    );
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.dispose();
    vi.unstubAllEnvs();
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  const create = async (extensions = true) => {
    const session = await createPiSession(
      {
        cwd,
        model: extensions ? "rove-extension-test/fixture" : undefined,
        thinkingLevel: undefined,
        resumeSessionId: undefined,
      },
      { extensions },
    );
    sessions.push(session);
    return session;
  };
  const log = () => NodeFS.readFileSync(NodePath.join(cwd, "extension.log"), "utf8");

  it("loads project hooks, commands, tools, and provider models without changing global trust", async () => {
    const settingsPath = NodePath.join(agentDir, "settings.json");
    NodeFS.writeFileSync(settingsPath, '{"defaultProjectTrust":"never"}');
    const session = await create();
    const events: PiSessionEventLike[] = [];
    session.subscribe((event) => events.push(event));
    assert.strictEqual(log(), "start:false:print\n");
    await session.prompt("/count");
    await session.prompt("handled");
    assert.include(log(), "command:1:false\ninput:rpc\n");
    assert.strictEqual(events.filter((event) => event.type === "agent_settled").length, 2);

    await session.prompt("Call the fixture tool");
    const result = events.find((event) => event.type === "tool_execution_end");
    assert.strictEqual(result?.toolName, "fixture_tool");
    assert.strictEqual(result?.isError, false);
    assert.include(JSON.stringify(result?.result), "extension tool worked");
    assert.strictEqual(events.filter((event) => event.type === "agent_settled").length, 3);
    assert.strictEqual(
      NodeFS.readFileSync(settingsPath, "utf8"),
      '{"defaultProjectTrust":"never"}',
    );

    await Promise.all([session.dispose(), session.dispose()]);
    assert.strictEqual(log().split("shutdown\n").length - 1, 1);
  });

  it("preserves notification message identity through SDK transcript replay", async () => {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "notify.ts"),
      `export default function (pi) {
        pi.on("before_agent_start", () => ({
          message: {
            customType: "subagent-notify",
            content: "Background task completed: **researcher**",
            display: false,
          },
        }));
      }`,
    );
    const session = await create();
    const notifications: unknown[] = [];
    const transcripts: unknown[][] = [];
    const isNotification = Schema.is(
      Schema.Struct({
        customType: Schema.Literal("subagent-notify"),
      }),
    );
    session.subscribe((event) => {
      if (event.type === "message_end" && isNotification(event.message)) {
        notifications.push(event.message);
      }
      if (event.type === "agent_end" && Array.isArray(event.messages)) {
        transcripts.push(event.messages);
      }
    });

    await session.prompt("First research task");
    await session.prompt("Second research task");

    assert.strictEqual(notifications.length, 2);
    assert.notStrictEqual(notifications[0], notifications[1]);
    assert.strictEqual(transcripts.length, 2);
    assert.isTrue(transcripts[0]?.includes(notifications[0]));
    assert.isTrue(transcripts[1]?.includes(notifications[1]));
  });

  it.effect("completes a real extension command through the Rove adapter", () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        createSession: createPiSession,
      });
      yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.orDie));
      const completion = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.completed" ? Deferred.succeed(completion, event) : Effect.void,
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      const threadId = ThreadId.make("pi-extension-integration");
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "/count" });
      const completed = yield* Deferred.await(completion);
      assert.strictEqual(completed.turnId, turn.turnId);
      assert.strictEqual(completed.type, "turn.completed");
      if (completed.type === "turn.completed")
        assert.strictEqual(completed.payload.state, "completed");
      assert.include(log(), "command:1:false\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("recovers the same conversation after a missing-file failure and restoration", () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter(
        decodePiSettings({ model: "rove-extension-test/fixture" }),
        { createSession: createPiSession },
      );
      yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.orDie));
      const completion = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.completed" ? Deferred.succeed(completion, event) : Effect.void,
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      const threadId = ThreadId.make("pi-recovery-integration");
      const session = yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "Remember this conversation" });
      const completed = yield* Deferred.await(completion);
      assert.strictEqual(completed.type, "turn.completed");
      if (completed.type === "turn.completed")
        assert.strictEqual(completed.payload.state, "completed");
      const before = yield* adapter.readThread(threadId);
      yield* adapter.stopSession(threadId);
      const cursor = parsePiResumeCursor(session.resumeCursor)!;
      const path = cursor.sessionFile!;
      const history = NodeFS.readFileSync(path, "utf8");
      NodeFS.unlinkSync(path);
      const error = yield* adapter
        .startSession({ threadId, cwd, runtimeMode: "full-access", resumeCursor: cursor })
        .pipe(Effect.flip);
      assert.include(error.message, "missing");
      assert.include(error.message, "create a new thread");
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.isFalse(NodeFS.existsSync(path));
      NodeFS.writeFileSync(path, history);
      const recovered = yield* adapter.startSession({
        threadId,
        cwd,
        runtimeMode: "full-access",
        resumeCursor: cursor,
      });
      assert.deepStrictEqual(recovered.resumeCursor, cursor);
      const after = yield* adapter.readThread(threadId);
      const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
      assert.strictEqual(yield* encodeJson(after.turns), yield* encodeJson(before.turns));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("loads a local Pi package configured in project settings", async () => {
    const packageDir = NodePath.join(root, "package");
    NodeFS.mkdirSync(packageDir);
    NodeFS.renameSync(
      NodePath.join(cwd, ".pi", "extensions", "fixture.ts"),
      NodePath.join(packageDir, "fixture.ts"),
    );
    NodeFS.writeFileSync(
      NodePath.join(packageDir, "package.json"),
      JSON.stringify({ name: "fixture-package", pi: { extensions: ["fixture.ts"] } }),
    );
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "settings.json"),
      JSON.stringify({ packages: [packageDir] }),
    );
    const session = await create();
    await session.prompt("/count");
    assert.include(log(), "command:1:false\n");
  });

  it("skips extensions listed in disabledExtensions and tells the model about it", async () => {
    const fixturePath = NodePath.join(cwd, ".pi", "extensions", "fixture.ts");
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "spy.ts"),
      `import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
export default function (pi) {
  pi.on("before_agent_start", (event, ctx) => {
    NodeFS.appendFileSync(
      NodePath.join(ctx.cwd, "disabled-note-probe.log"),
      event.systemPrompt.includes("Rove Code disables") ? "note:present" : "note:absent",
    );
  });
}`,
    );
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "dummy.ts"),
      "export default () => {};",
    );

    // A session that blocks the fixture never runs it.
    const disabledSession = await createPiSession({
      cwd,
      model: undefined,
      thinkingLevel: undefined,
      resumeSessionId: undefined,
      disabledExtensions: [fixturePath],
    });
    sessions.push(disabledSession);
    assert.isFalse(NodeFS.existsSync(NodePath.join(cwd, "extension.log")));

    // A session keeping the fixture but blocking another extension still
    // tells the model, in its system prompt, which extension Rove removed.
    const noteSession = await createPiSession({
      cwd,
      model: "rove-extension-test/fixture",
      thinkingLevel: undefined,
      resumeSessionId: undefined,
      disabledExtensions: [NodePath.join(cwd, ".pi", "extensions", "dummy.ts")],
    });
    sessions.push(noteSession);
    await noteSession.prompt("anything at all");
    assert.include(log(), "start:false:print\n");
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(cwd, "disabled-note-probe.log"), "utf8"),
      "note:present",
    );

    // An untouched discovery set keeps loading the same extension.
    const enabledSession = await create();
    await enabledSession.prompt("handled");
    assert.include(log(), "start:false:print\ninput:rpc\n");
  });

  it("loads global extensions and keeps each session's extension state separate", async () => {
    NodeFS.mkdirSync(NodePath.join(agentDir, "extensions"));
    NodeFS.renameSync(
      NodePath.join(cwd, ".pi", "extensions", "fixture.ts"),
      NodePath.join(agentDir, "extensions", "fixture.ts"),
    );
    const first = await create();
    const second = await create();
    await first.prompt("/count");
    await first.prompt("/count");
    await second.prompt("/count");
    assert.strictEqual(
      log(),
      "start:false:print\nstart:false:print\ncommand:1:false\ncommand:2:false\ncommand:1:false\n",
    );
  });

  it("reports extension errors and settles failed commands without an agent run", async () => {
    const session = await create();
    const events: PiSessionEventLike[] = [];
    session.subscribe((event) => events.push(event));
    await session.prompt("/broken");
    assert.isTrue(
      events.some(
        (event) => event.type === "extension_error" && event.error === "fixture command failed",
      ),
    );
    assert.strictEqual(events.at(-1)?.type, "agent_settled");
  });

  it("retains startup errors until the adapter subscribes", async () => {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "startup-error.ts"),
      'export default pi => { pi.on("session_start", () => { throw new Error("startup hook failed"); }); };',
    );
    const session = await create();
    const events: PiSessionEventLike[] = [];
    session.subscribe((event) => events.push(event));
    assert.isTrue(
      events.some(
        (event) => event.type === "extension_error" && event.error === "startup hook failed",
      ),
    );
  });

  it("rejects extension session replacement without changing Rove's session identity", async () => {
    const session = await create();
    const sessionId = session.sessionId;
    const events: PiSessionEventLike[] = [];
    session.subscribe((event) => events.push(event));
    await session.prompt("/replace-session");
    assert.strictEqual(session.sessionId, sessionId);
    assert.isTrue(
      events.some(
        (event) =>
          event.type === "extension_error" && String(event.error).includes("not supported in Rove"),
      ),
    );
    assert.strictEqual(events.at(-1)?.type, "agent_settled");
  });

  it("rejects broken extension loads instead of silently omitting them", async () => {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "broken.ts"),
      'export default () => { throw new Error("fixture load failed"); };',
    );
    await expect(create()).rejects.toThrow("fixture load failed");
  });

  it("persists a fresh session before its first prompt so startup cursors survive restart", async () => {
    const fresh = await create();
    assert.isDefined(fresh.sessionFile);
    assert.isTrue(NodeFS.existsSync(fresh.sessionFile!));
    await fresh.dispose();
    const resumed = await createPiSession({
      cwd,
      model: "rove-extension-test/fixture",
      thinkingLevel: undefined,
      resumeSessionId: fresh.sessionId,
    });
    sessions.push(resumed);
    assert.strictEqual(resumed.sessionId, fresh.sessionId);
    assert.strictEqual(resumed.resumeOutcome?.resumed, true);
    await resumed.prompt("First prompt after restart");
    assert.isAbove(resumed.messages.length, 0);
  });

  it("recovers history by its durable locator after cwd and session storage settings change", async () => {
    const fresh = await create();
    await fresh.prompt("Remember this conversation");
    const messages = [...fresh.messages];
    await fresh.dispose();
    const movedCwd = NodePath.join(root, "moved-project");
    NodeFS.renameSync(cwd, movedCwd);
    const movedAgentDir = NodePath.join(root, "other-agent");
    NodeFS.mkdirSync(movedAgentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", movedAgentDir);
    const resumed = await createPiSession({
      cwd: movedCwd,
      model: "rove-extension-test/fixture",
      thinkingLevel: undefined,
      resumeSessionId: fresh.sessionId,
      resumeSessionFile: fresh.sessionFile,
    });
    sessions.push(resumed);
    assert.strictEqual(resumed.sessionId, fresh.sessionId);
    assert.strictEqual(JSON.stringify(resumed.messages), JSON.stringify(messages));
    assert.strictEqual(resumed.sessionFile, fresh.sessionFile);
    await resumed.prompt("Continue after moving");
    assert.isAbove(resumed.messages.length, messages.length);
    await resumed.prompt("handled");
    assert.include(
      NodeFS.readFileSync(NodePath.join(movedCwd, "extension.log"), "utf8"),
      "input:rpc",
    );
  });

  it("rejects empty, malformed, mismatched, and missing session files without replacing them", async () => {
    const fresh = await create();
    const path = fresh.sessionFile!;
    await fresh.dispose();
    const header = NodeFS.readFileSync(path, "utf8");
    for (const content of ["", "not JSON\n", header.replace(fresh.sessionId, "another-session")]) {
      NodeFS.writeFileSync(path, content);
      await expect(
        createPiSession({
          cwd,
          model: undefined,
          thinkingLevel: undefined,
          resumeSessionId: fresh.sessionId,
          resumeSessionFile: path,
        }),
      ).rejects.toThrow();
      assert.strictEqual(NodeFS.readFileSync(path, "utf8"), content);
    }
    NodeFS.unlinkSync(path);
    await expect(
      createPiSession({
        cwd,
        model: undefined,
        thinkingLevel: undefined,
        resumeSessionId: fresh.sessionId,
        resumeSessionFile: path,
      }),
    ).rejects.toThrow("missing");
    assert.isFalse(NodeFS.existsSync(path));
  });

  it.skipIf(process.getuid?.() === 0)(
    "distinguishes unreadable session storage from missing history",
    async () => {
      const fresh = await create();
      await fresh.dispose();
      NodeFS.chmodSync(fresh.sessionFile!, 0);
      try {
        await expect(
          createPiSession({
            cwd,
            model: undefined,
            thinkingLevel: undefined,
            resumeSessionId: fresh.sessionId,
            resumeSessionFile: fresh.sessionFile,
          }),
        ).rejects.toThrow("unreadable");
      } finally {
        NodeFS.chmodSync(fresh.sessionFile!, 0o600);
      }
    },
  );

  it("keeps extensions disabled for auxiliary text generation", async () => {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "extensions", "broken.ts"),
      'export default () => { throw new Error("must not load"); };',
    );
    await create(false);
    assert.isFalse(NodeFS.existsSync(NodePath.join(cwd, "extension.log")));
  });
});

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

describe("Pi session recovery", () => {
  let storageRoot: string;
  beforeEach(() => {
    storageRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-recovery-storage-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", storageRoot);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    NodeFS.rmSync(storageRoot, { recursive: true, force: true });
  });

  it("resolvePiSessionResume finds the persisted file for a session id", () => {
    const cwd = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-factory-test-")),
    );
    const sessionDir = SessionManager.create(cwd).getSessionDir();
    const sessionId = "01a00000-1111-2222-3333-444455556666";

    const fileName = `2026-08-16T00-00-00-000Z_${sessionId}.jsonl`;
    NodeFS.writeFileSync(NodePath.join(sessionDir, fileName), "{}\n");

    try {
      assert.deepStrictEqual(resolvePiSessionResume(cwd, sessionId), {
        resumed: true,
        sessionFile: NodePath.join(sessionDir, fileName),
      });
    } finally {
      NodeFS.rmSync(sessionDir, { recursive: true, force: true });
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resolvePiSessionResume reports a missing file instead of masking a fresh session", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-factory-test-"));
    const sessionDir = SessionManager.create(cwd).getSessionDir();
    try {
      assert.throws(
        () => resolvePiSessionResume(cwd, "00000000-0000-0000-0000-000000000000"),
        "missing",
      );
      assert.strictEqual(resolvePiSessionResume(cwd, undefined).resumed, false);
    } finally {
      NodeFS.rmSync(sessionDir, { recursive: true, force: true });
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous legacy IDs rather than choosing arbitrary history", () => {
    const sessionId = "01a00000-1111-2222-3333-444455556666";
    const sessionDir = SessionManager.create(storageRoot).getSessionDir();
    NodeFS.writeFileSync(NodePath.join(sessionDir, `first_${sessionId}.jsonl`), "{}\n");
    NodeFS.writeFileSync(NodePath.join(sessionDir, `second_${sessionId}.jsonl`), "{}\n");
    assert.throws(() => resolvePiSessionResume(storageRoot, sessionId), "Multiple session files");
  });

  it("does not classify directory read errors as missing history", () => {
    const sessionDir = SessionManager.create(storageRoot).getSessionDir();
    NodeFS.rmdirSync(sessionDir);
    NodeFS.writeFileSync(sessionDir, "not a directory");
    assert.throws(() => resolvePiSessionResume(storageRoot, "saved-session"), "unreadable");
  });

  it("createPiSession rejects a missed resume and resumes a live session", async () => {
    const tmp = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-pi-resume-")),
    );
    const resumeCwd = NodePath.join(tmp, "project");
    const resumeAgentDir = NodePath.join(tmp, "agent");
    NodeFS.mkdirSync(NodePath.join(resumeCwd, ".pi", "extensions"), { recursive: true });
    NodeFS.mkdirSync(resumeAgentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", resumeAgentDir);
    vi.stubEnv("PI_OFFLINE", "1");
    const owned: PiSessionLike[] = [];
    try {
      const missingId = "00000000-0000-0000-0000-000000000000";
      await expect(
        createPiSession({
          cwd: resumeCwd,
          model: undefined,
          thinkingLevel: undefined,
          resumeSessionId: missingId,
        }),
      ).rejects.toThrow("missing");

      const liveId = "11a00000-1111-2222-3333-444455556666";
      const liveDir = SessionManager.create(resumeCwd).getSessionDir();
      const liveFile = NodePath.join(liveDir, `2026-08-16T00-00-00-000Z_${liveId}.jsonl`);
      NodeFS.writeFileSync(
        liveFile,
        `${JSON.stringify({ type: "session", version: 3, id: liveId, timestamp: "2026-08-16T00:00:00.000Z", cwd: resumeCwd })}\n`,
      );

      const resumed = await createPiSession({
        cwd: resumeCwd,
        model: undefined,
        thinkingLevel: undefined,
        resumeSessionId: liveId,
      });
      owned.push(resumed);
      assert.strictEqual(resumed.resumeOutcome?.resumed, true);
      assert.strictEqual(resumed.sessionId, liveId);
    } finally {
      for (const session of owned.splice(0)) await session.dispose();
      NodeFS.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
