// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  PiSettings,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ChatImageAttachment,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  describePiToolCall,
  makePiAdapter,
  parsePiResumeCursor,
  resolvePiToolCallArgs,
  type PiCreateSessionInput,
  type PiImageContentLike,
  type PiSessionEntryLike,
  type PiSessionEventLike,
  type PiSessionLike,
  type PiSessionModelLike,
  type PiSessionStatsLike,
} from "./PiAdapter.ts";
import { PiExtensionLoadError } from "./PiSessionFactory.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const testLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "rove-pi-adapter-" }),
).pipe(
  // Throwaway base dir keeps adapter tests from deriving state dirs in the repo.
  Layer.provideMerge(NodeServices.layer),
);

class FakePiSession implements PiSessionLike {
  sessionId = "fake-pi-session-1";
  sessionFile?: string | undefined = undefined;
  /** When set, abort() emits agent_settled before resolving, like the real SDK. */
  emitSettledOnAbort = false;
  resumeOutcome: PiSessionLike["resumeOutcome"] = { resumed: false, reason: "no-cursor" };
  isStreaming = false;
  messages: ReadonlyArray<unknown> = [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
  ];
  entries: Array<PiSessionEntryLike> = [
    { id: "entry-1", parentId: undefined, type: "message", message: { role: "user" } },
    { id: "entry-2", parentId: "entry-1", type: "message", message: { role: "assistant" } },
    { id: "entry-3", parentId: "entry-2", type: "message", message: { role: "user" } },
    { id: "entry-4", parentId: "entry-3", type: "message", message: { role: "assistant" } },
  ];
  leafId = "entry-4";
  sessionStats: PiSessionStatsLike | undefined;
  autoCompactionEnabled = true;
  modelFallbackMessage: string | undefined = undefined;
  readonly promptCalls: Array<{
    text: string;
    options?: {
      readonly images?: ReadonlyArray<PiImageContentLike>;
      readonly streamingBehavior?: "steer" | "followUp";
      readonly preflightResult?: (success: boolean) => void;
    };
  }> = [];
  readonly forkCalls: Array<{ entryId: string }> = [];
  readonly setModelCalls: Array<{ model: string }> = [];
  readonly setThinkingLevelCalls: Array<{ level: string }> = [];
  forkedMessages: ReadonlyArray<unknown> | undefined;
  aborted = false;
  disposed = false;
  private listeners = new Set<(event: PiSessionEventLike) => void>();

  getEntries() {
    return this.entries;
  }
  getLeafId() {
    return this.leafId;
  }
  getBranch() {
    const entriesById = new Map(this.entries.map((entry) => [entry.id, entry]));
    const branch = [] as typeof this.entries;
    let entry = entriesById.get(this.leafId);
    while (entry !== undefined) {
      branch.unshift(entry);
      entry =
        entry.parentId === undefined || entry.parentId === null
          ? undefined
          : entriesById.get(entry.parentId);
    }
    return branch;
  }
  getSessionStats() {
    return this.sessionStats;
  }
  async fork(entryId: string): Promise<void> {
    this.forkCalls.push({ entryId });
    this.leafId = entryId;
    this.forkedMessages = this.messages;
  }

  setModel(model: string): Promise<void> {
    this.setModelCalls.push({ model });
    return Promise.resolve();
  }
  setThinkingLevel(level: string): void {
    this.setThinkingLevelCalls.push({ level });
  }
  /** Vision-capable by default; tests override to exercise capability rejections. */
  model: PiSessionModelLike | undefined = { id: "fake-vision-model", input: ["text", "image"] };
  getModel(): PiSessionModelLike | undefined {
    return this.model;
  }

  prompt(
    text: string,
    options?: PiSessionLike["prompt"] extends (text: string, options?: infer O) => Promise<void>
      ? O
      : never,
  ): Promise<void> {
    this.promptCalls.push({ text, ...(options !== undefined ? { options } : undefined) });
    options?.preflightResult?.(true);
    return Promise.resolve();
  }
  followUp(): Promise<void> {
    return Promise.resolve();
  }
  abort(): Promise<void> {
    this.aborted = true;
    if (this.emitSettledOnAbort) {
      this.emit({ type: "agent_settled" });
    }
    return Promise.resolve();
  }
  dispose(): void {
    this.disposed = true;
  }
  subscribe(listener: (event: PiSessionEventLike) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: PiSessionEventLike): void {
    for (const listener of this.listeners) listener(event);
  }
}

const threadId = ThreadId.make("thread-pi-1");

const makeAdapter = (fake: FakePiSession) =>
  makePiAdapter(decodePiSettings({}), {
    instanceId: ProviderInstanceId.make("pi"),
    createSession: () => Promise.resolve(fake),
  }).pipe(Effect.orDie);

const makeImageAttachment = (
  overrides?: Partial<Omit<ChatImageAttachment, "type">>,
): ChatImageAttachment => ({
  type: "image",
  id: "thread-pi-attachment-12345678-1234-1234-1234-123456789abc",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 4,
  ...overrides,
});

const writeAttachment = (
  attachmentsDir: string,
  attachment: ChatImageAttachment,
  bytes: Uint8Array,
) => {
  const attachmentPath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment));
  NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
  NodeFS.writeFileSync(attachmentPath, bytes);
  return attachmentPath;
};

/**
 * Collect streamEvents into a ref, then yield once on the live clock so the
 * forked consumer's deferred PubSub subscription attaches before any adapter
 * call publishes (Stream.fromPubSub subscribes when the stream starts).
 */
const collectEvents = (
  adapter: { streamEvents: Stream.Stream<ProviderRuntimeEvent> },
  eventsRef: Ref.Ref<ReadonlyArray<ProviderRuntimeEvent>>,
) =>
  Stream.runForEach(adapter.streamEvents, (event) =>
    Ref.update(eventsRef, (events) => [...events, event]),
  ).pipe(Effect.forkChild, Effect.andThen(Effect.sleep("1 millis")), TestClock.withLive);

/** Poll until the predicate matches or the deadline passes. */
const waitFor = (
  eventsRef: Ref.Ref<ReadonlyArray<ProviderRuntimeEvent>>,
  predicate: (events: ReadonlyArray<ProviderRuntimeEvent>) => boolean,
) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      const events = yield* Ref.get(eventsRef);
      if (predicate(events)) return events;
      yield* Effect.sleep("10 millis");
    }
    return yield* Ref.get(eventsRef);
  }).pipe(TestClock.withLive);

it.layer(testLayer)("PiAdapter", (it) => {
  it.effect("releases the startup lock after timeout and never installs a late session", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const disposed = yield* Deferred.make<void>();
      const late = new FakePiSession();
      late.dispose = () => {
        Deferred.doneUnsafe(disposed, Effect.void);
      };
      let resolve: (session: PiSessionLike) => void = () => {};
      const pending = new Promise<PiSessionLike>((done) => {
        resolve = done;
      });
      let calls = 0;
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        createSession: () => {
          if (++calls > 1) return Promise.resolve(new FakePiSession());
          Deferred.doneUnsafe(started, Effect.void);
          return pending;
        },
      });
      const startup = yield* adapter
        .startSession({ threadId, runtimeMode: "full-access" })
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      yield* TestClock.adjust(60_000);
      assert.strictEqual((yield* Fiber.join(startup))._tag, "Failure");
      assert.isFalse(yield* adapter.hasSession(threadId));
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      resolve(late);
      yield* Deferred.await(disposed);
      assert.strictEqual((yield* adapter.listSessions()).length, 1);
      yield* adapter.stopAll();
    }),
  );

  it.effect("publishes retry and compaction notices without settling the turn", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const completed = yield* Deferred.make<void>();
      const events: Array<ProviderRuntimeEvent> = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => {
          events.push(event);
          return event.type === "turn.completed"
            ? Deferred.succeed(completed, undefined)
            : Effect.void;
        }),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "hello" });
      fake.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000 });
      fake.emit({ type: "auto_retry_end", success: true });
      fake.emit({ type: "compaction_start" });
      fake.emit({ type: "compaction_end", aborted: true });
      fake.emit({ type: "compaction_start" });
      fake.emit({ type: "compaction_end", aborted: false, errorMessage: "quota exceeded" });
      fake.emit({ type: "agent_settled" });
      yield* Deferred.await(completed);
      const notices = events.filter((event) => event.type === "runtime.info");
      assert.deepStrictEqual(
        notices.map((event) => event.payload.message),
        [
          "Retrying (attempt 1)…",
          "Retry succeeded",
          "Compacting context…",
          "Compaction stopped",
          "Compacting context…",
          "Compaction failed",
        ],
      );
      assert.strictEqual(notices.at(-1)?.payload.detail, "quota exceeded");
      assert.isTrue(notices.every((event) => event.turnId === turn.turnId));
      assert.strictEqual(events.filter((event) => event.type === "turn.completed").length, 1);
    }),
  );

  it.effect("bounds burst tool progress and releases completed argument cache entries", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const toolDone = yield* Deferred.make<void>();
      const progressReceived = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const events: Array<ProviderRuntimeEvent> = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => {
          events.push(event);
          if (event.type === "item.completed") return Deferred.succeed(toolDone, undefined);
          if (event.type === "item.updated") return Deferred.succeed(progressReceived, undefined);
          if (event.type === "turn.completed") return Deferred.succeed(settled, undefined);
          return Effect.void;
        }),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "hello" });
      fake.messages = [
        { content: [{ type: "toolCall", id: "call", arguments: { command: "first" } }] },
      ];
      fake.emit({ type: "tool_execution_start", toolCallId: "call", toolName: "bash" });
      for (let i = 0; i < 1000; i++) {
        fake.emit({
          type: "tool_execution_update",
          toolCallId: "call",
          toolName: "bash",
          partialResult: {
            content: [
              { type: "text", text: "x".repeat(10_000) },
              { type: "text", text: "newest output" },
              { type: "image", data: "ignored" },
            ],
            details: { secret: "not forwarded" },
          },
        });
      }
      yield* Deferred.await(progressReceived);
      yield* TestClock.adjust(500);
      fake.emit({
        type: "tool_execution_update",
        toolCallId: "call",
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "x".repeat(10_000) + "later output" }] },
      });
      fake.emit({ type: "tool_execution_end", toolCallId: "call", toolName: "bash", result: {} });
      yield* Deferred.await(toolDone);
      fake.messages = [
        { content: [{ type: "toolCall", id: "call", arguments: { command: "second" } }] },
      ];
      fake.emit({ type: "tool_execution_start", toolCallId: "call", toolName: "bash" });
      fake.emit({ type: "agent_settled" });
      yield* Deferred.await(settled);
      const progress = events.filter((event) => event.type === "item.updated");
      assert.strictEqual(progress.length, 2);
      assert.strictEqual(progress[0]?.payload.detail, "x".repeat(1011) + "newest output");
      assert.strictEqual(progress[1]?.payload.detail, "x".repeat(1012) + "later output");
      assert.isUndefined(progress[0]?.payload.data);
      const starts = events.filter((event) => event.type === "item.started");
      assert.deepStrictEqual(
        starts.map((event) => event.payload.data),
        [{ command: "first" }, { command: "second" }],
      );
    }),
  );
  it.effect("publishes extension failures as warnings and completes handled commands", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const warning = yield* Deferred.make<ProviderRuntimeEvent>();
      const completion = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => {
          if (event.type === "runtime.warning") return Deferred.succeed(warning, event);
          if (event.type === "turn.completed") return Deferred.succeed(completion, event);
          return Effect.void;
        }),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "/broken" });
      fake.emit({
        type: "extension_error",
        extensionPath: "command:broken",
        error: "Command failed",
      });
      fake.emit({ type: "agent_settled" });
      const warningEvent = yield* Deferred.await(warning);
      assert.strictEqual(warningEvent.type, "runtime.warning");
      if (warningEvent.type === "runtime.warning")
        assert.include(warningEvent.payload.message, "Command failed");
      const completed = yield* Deferred.await(completion);
      assert.strictEqual(completed.turnId, turn.turnId);
      if (completed.type === "turn.completed")
        assert.strictEqual(completed.payload.state, "completed");
    }),
  );

  it.effect("fails a rejected prompt instead of leaving the turn running", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const completion = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.completed" ? Deferred.succeed(completion, event) : Effect.void,
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "hello" });
      fake.emit({ type: "prompt_error", error: "No model configured" });
      const completed = yield* Deferred.await(completion);
      assert.strictEqual(completed.turnId, turn.turnId);
      if (completed.type === "turn.completed") {
        assert.strictEqual(completed.payload.state, "failed");
        assert.strictEqual(completed.payload.errorMessage, "No model configured");
      }
    }),
  );

  for (const delivery of ["message_end", "agent_end"] as const) {
    it.effect(
      `completes repeated same-agent notifications via ${delivery} without replaying them`,
      () =>
        Effect.gen(function* () {
          const fake = new FakePiSession();
          const adapter = yield* makeAdapter(fake);
          const drained = yield* Deferred.make<void>();
          const completedTaskIds: string[] = [];
          let completedAfterReplay: string[] = [];
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) => {
              if (event.type === "task.completed") completedTaskIds.push(event.payload.taskId);
              if (event.type !== "runtime.warning") return Effect.void;
              if (event.payload.message.includes("replay marker")) {
                completedAfterReplay = [...completedTaskIds];
                return Effect.void;
              }
              return Deferred.succeed(drained, undefined);
            }),
            Effect.forkChild({ startImmediately: true }),
          );
          yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
          yield* adapter.sendTurn({ threadId, input: "Run two research tasks" });

          const first = {
            role: "custom",
            customType: "subagent-notify",
            content: "Background task completed: **researcher**",
            timestamp: 1,
          };
          const second = { ...first };
          const launch = (runId: string) =>
            fake.emit({
              type: "tool_execution_end",
              toolName: "subagent",
              toolCallId: runId,
              args: { agent: "researcher" },
              result: { details: { mode: "single", runId } },
            });
          launch("first-run");
          if (delivery === "message_end") fake.emit({ type: "message_end", message: first });
          fake.emit({ type: "agent_end", messages: [first] });
          launch("second-run");
          fake.emit({ type: "agent_end", messages: [first] });
          fake.emit({ type: "extension_error", error: "replay marker" });
          if (delivery === "message_end") fake.emit({ type: "message_end", message: second });
          fake.emit({ type: "agent_end", messages: [first, second] });
          fake.emit({ type: "agent_end", messages: [first, second] });
          fake.emit({ type: "extension_error", error: "drain marker" });
          yield* Deferred.await(drained);

          assert.deepStrictEqual(completedAfterReplay, ["first-run"]);
          assert.deepStrictEqual(completedTaskIds, ["first-run", "second-run"]);
        }),
    );
  }

  it.effect("stopAll waits for asynchronous extension shutdown", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      fake.dispose = async () => {
        await Promise.resolve();
        fake.disposed = true;
      };
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.stopAll();
      assert.isTrue(fake.disposed);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect(
    "driver teardown sequence: settlement timeout still ends with all sessions disposed",
    () =>
      Effect.gen(function* () {
        // Exercise the same shutdown operation the driver's finalizer calls.
        const fake = new FakePiSession();
        const adapter = yield* makeAdapter(fake);
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "streaming" });
        fake.emit({ type: "turn_start" });

        // The settle wait times out against the test clock, like a real
        // 30s timeout elapsing while the turn is still streaming.
        const shutdown = yield* adapter
          .shutdown()
          .pipe(Effect.uninterruptible, Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(60_000);
        yield* Fiber.join(shutdown);
        assert.isTrue(fake.disposed);
        assert.isFalse(yield* adapter.hasSession(threadId));
      }),
  );

  it.effect("shutdown disposes idle sessions, closes subscribers, and rejects new work", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const subscriber = yield* Stream.runDrain(adapter.streamEvents).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* adapter.shutdown();
      yield* Fiber.await(subscriber);
      assert.isTrue(fake.disposed);
      assert.isFalse(yield* adapter.hasSession(threadId));
      const start = yield* adapter
        .startSession({ threadId, runtimeMode: "full-access" })
        .pipe(Effect.result);
      const send = yield* adapter.sendTurn({ threadId, input: "too late" }).pipe(Effect.result);
      assert.strictEqual(start._tag, "Failure");
      assert.strictEqual(send._tag, "Failure");
      yield* adapter.shutdown();
    }),
  );

  it.effect("shutdown delivers active turn completion before closing the event stream", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const events = yield* Stream.runCollect(adapter.streamEvents).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const turn = yield* adapter.sendTurn({ threadId, input: "finish before replacement" });
      const shutdown = yield* adapter.shutdown().pipe(Effect.forkChild({ startImmediately: true }));
      fake.emit({ type: "agent_settled" });
      yield* Fiber.join(shutdown);
      const received = yield* Fiber.join(events);
      assert.isTrue(
        received.some((event) => event.type === "turn.completed" && event.turnId === turn.turnId),
      );
      assert.isTrue(fake.disposed);
    }),
  );

  it.effect("shutdown disposes sessions that finish starting after the adapter retires", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const started = yield* Deferred.make<void>();
      let finish!: (session: PiSessionLike) => void;
      const pending = new Promise<PiSessionLike>((resolve) => {
        finish = resolve;
      });
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        createSession: () => {
          Deferred.doneUnsafe(started, Effect.void);
          return pending;
        },
      });
      const startup = yield* adapter
        .startSession({ threadId, runtimeMode: "full-access" })
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      yield* adapter.shutdown();
      finish(fake);
      const result = yield* Fiber.join(startup);
      assert.strictEqual(result._tag, "Failure");
      assert.isTrue(fake.disposed);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("startSession creates a Pi session, emits started+ready, and lists it", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* collectEvents(adapter, eventsRef);

      const session = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      assert.strictEqual(session.threadId, threadId);
      assert.strictEqual(session.provider, "pi");
      assert.strictEqual(session.status, "ready");
      assert.deepStrictEqual(session.resumeCursor, { sessionId: fake.sessionId });
      assert.isTrue(yield* adapter.hasSession(threadId));
      assert.strictEqual((yield* adapter.listSessions()).length, 1);

      const events = yield* waitFor(eventsRef, (e) =>
        e.some((ev) => ev.type === "session.state.changed"),
      );
      const types = events.map((e) => e.type);
      assert.include(types, "session.started");
      assert.include(types, "session.state.changed");
    }),
  );

  it.effect("sendTurn reuses the active turn when steering into a running Pi session", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      const first = yield* adapter.sendTurn({ threadId, input: "hello pi" });
      assert.strictEqual(fake.promptCalls.length, 1);
      assert.strictEqual(fake.promptCalls[0]?.text, "hello pi");
      assert.strictEqual(first.threadId, threadId);

      fake.isStreaming = true;
      const second = yield* adapter.sendTurn({ threadId, input: "actually do this" });
      assert.strictEqual(second.turnId, first.turnId);
      assert.strictEqual(fake.promptCalls.length, 2);
      assert.strictEqual(fake.promptCalls[1]?.text, "actually do this");
      assert.strictEqual(fake.promptCalls[1]?.options?.streamingBehavior, "steer");
      assert.isFunction(fake.promptCalls[1]?.options?.preflightResult);
    }),
  );

  it.effect("rejects empty turns without reserving an active turn", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      for (const input of [undefined, "", "  "]) {
        const error = yield* adapter.sendTurn({ threadId, input }).pipe(Effect.flip);
        assert.include(error.detail, "require text input or image attachments");
      }
      assert.strictEqual(fake.promptCalls.length, 0);
      yield* adapter.sendTurn({ threadId, input: "hello" });
      assert.isUndefined(fake.promptCalls[0]?.options?.streamingBehavior);
    }),
  );

  it.effect("inlines image attachments into the Pi prompt", () => {
    const baseDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "rove-pi-adapter-attachments-"),
    );
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
      );
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const { attachmentsDir } = yield* ServerConfig;
      const attachment = makeImageAttachment({ mimeType: "IMAGE/PNG" });
      writeAttachment(attachmentsDir, attachment, Uint8Array.from([1, 2, 3, 4]));

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({
        threadId,
        input: "What's in this image?",
        attachments: [attachment],
      });

      assert.strictEqual(fake.promptCalls.length, 1);
      assert.strictEqual(fake.promptCalls[0]?.text, "What's in this image?");
      assert.deepEqual(fake.promptCalls[0]?.options?.images, [
        { type: "image", data: "AQIDBA==", mimeType: "image/png" },
      ]);
    }).pipe(Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)));
  });

  it.effect("carries image-only messages without relying on attachment path notes", () => {
    const baseDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "rove-pi-adapter-image-only-"),
    );
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
      );
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const { attachmentsDir } = yield* ServerConfig;
      const attachment = makeImageAttachment();
      writeAttachment(attachmentsDir, attachment, Uint8Array.from([9, 9]));

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, attachments: [attachment] });
      yield* adapter.sendTurn({ threadId, input: "  ", attachments: [attachment] });

      assert.strictEqual(fake.promptCalls.length, 2);
      assert.strictEqual(fake.promptCalls[0]?.text, "");
      assert.strictEqual(fake.promptCalls[1]?.text, "");
      assert.strictEqual(fake.promptCalls[1]?.options?.streamingBehavior, "steer");
      assert.deepEqual(fake.promptCalls[1]?.options?.images, [
        { type: "image", data: "CQk=", mimeType: "image/png" },
      ]);
      assert.deepEqual(fake.promptCalls[0]?.options?.images, [
        { type: "image", data: "CQk=", mimeType: "image/png" },
      ]);
    }).pipe(Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)));
  });

  it.effect("steers with images into a running Pi session", () => {
    const baseDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "rove-pi-adapter-steer-images-"),
    );
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
      );
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const { attachmentsDir } = yield* ServerConfig;
      const attachment = makeImageAttachment();
      writeAttachment(attachmentsDir, attachment, Uint8Array.from([1]));

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const first = yield* adapter.sendTurn({ threadId, input: "start" });
      fake.isStreaming = true;
      const second = yield* adapter.sendTurn({
        threadId,
        input: "look at this too",
        attachments: [attachment],
      });

      assert.strictEqual(second.turnId, first.turnId);
      assert.strictEqual(fake.promptCalls[1]?.options?.streamingBehavior, "steer");
      assert.deepEqual(fake.promptCalls[1]?.options?.images, [
        { type: "image", data: "AQ==", mimeType: "image/png" },
      ]);
    }).pipe(Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)));
  });

  it.effect("rejects image attachments when the session model has no image input", () => {
    const baseDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "rove-pi-adapter-no-vision-"),
    );
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
      );
      const fake = new FakePiSession();
      fake.model = { id: "fake-text-only", input: ["text"] };
      const adapter = yield* makeAdapter(fake);
      const { attachmentsDir } = yield* ServerConfig;
      const attachment = makeImageAttachment();
      writeAttachment(attachmentsDir, attachment, Uint8Array.from([1, 2, 3, 4]));

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const error = yield* adapter
        .sendTurn({ threadId, input: "describe this", attachments: [attachment] })
        .pipe(Effect.flip);
      assert.include(error.detail, "does not support image input");
      assert.strictEqual(fake.promptCalls.length, 0);

      // The rejected turn must not wedge the session: a plain turn still runs.
      yield* adapter.sendTurn({ threadId, input: "plain follow-up" });
      assert.strictEqual(fake.promptCalls.length, 1);
      assert.isUndefined(fake.promptCalls[0]?.options?.images);
      assert.isUndefined(fake.promptCalls[0]?.options?.streamingBehavior);

      const steeringError = yield* adapter
        .sendTurn({ threadId, attachments: [attachment] })
        .pipe(Effect.flip);
      assert.include(steeringError.detail, "does not support image input");
      yield* adapter.sendTurn({ threadId, input: "plain steering after rejection" });
      assert.strictEqual(fake.promptCalls[1]?.options?.streamingBehavior, "steer");
    }).pipe(Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)));
  });

  it.effect("rejects unsupported image mime types before prompting", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-pi-adapter-mime-"));
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
      );
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const { attachmentsDir } = yield* ServerConfig;
      const attachment = makeImageAttachment({
        name: "scan.heic",
        mimeType: "image/heic",
      });
      writeAttachment(attachmentsDir, attachment, Uint8Array.from([1, 2, 3, 4]));

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const error = yield* adapter
        .sendTurn({ threadId, input: "describe this", attachments: [attachment] })
        .pipe(Effect.flip);
      assert.include(error.detail, "Unsupported Pi image attachment type 'image/heic'");
      assert.strictEqual(fake.promptCalls.length, 0);
    }).pipe(Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)));
  });

  it.effect("rejects unreadable attachment files before prompting", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-pi-adapter-missing-"));
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
      );
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const attachment = makeImageAttachment();

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const error = yield* adapter
        .sendTurn({ threadId, input: "describe this", attachments: [attachment] })
        .pipe(Effect.flip);
      assert.include(error.detail, "Failed to read attachment file 'screenshot.png'");
      assert.strictEqual(fake.promptCalls.length, 0);
    }).pipe(Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)));
  });

  it.effect("sendTurn waits for preflight but not prompt settlement", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const preflight = yield* Deferred.make<(accepted: boolean) => void>();
      const accepted = yield* Deferred.make<void>();
      const settlement = Promise.withResolvers<void>();
      fake.prompt = (_text, options) => {
        const callback = options?.preflightResult;
        assert(callback !== undefined);
        Deferred.doneUnsafe(preflight, Effect.succeed(callback));
        return settlement.promise;
      };
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter
        .sendTurn({ threadId, input: "hello" })
        .pipe(
          Effect.andThen(Deferred.succeed(accepted, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
      const accept = yield* Deferred.await(preflight);
      assert.isFalse(yield* Deferred.isDone(accepted));
      accept(true);
      yield* Deferred.await(accepted);
      settlement.resolve();
    }),
  );

  it.effect("a rejected steering request preserves the active turn", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const first = yield* adapter.sendTurn({ threadId, input: "hello" });
      const prompt = fake.prompt.bind(fake);
      fake.prompt = (_text, options) => {
        options?.preflightResult?.(false);
        return Promise.reject(new Error("Compaction in progress"));
      };
      const rejected = yield* adapter.sendTurn({ threadId, input: "steer" }).pipe(Effect.exit);
      assert.strictEqual(rejected._tag, "Failure");
      fake.prompt = prompt;
      const next = yield* adapter.sendTurn({ threadId, input: "retry steering" });
      assert.strictEqual(next.turnId, first.turnId);
    }),
  );

  it.effect("a failed model switch releases a newly reserved turn", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      fake.setModel = () => Promise.reject(new Error("Unknown model"));
      const rejected = yield* adapter
        .sendTurn({
          threadId,
          input: "hello",
          modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "unknown/model" },
        })
        .pipe(Effect.exit);
      assert.strictEqual(rejected._tag, "Failure");
      yield* adapter.sendTurn({ threadId, input: "retry" });
      assert.isUndefined(fake.promptCalls[0]?.options?.streamingBehavior);
    }),
  );

  it.effect("startSession publishes the model fallback and reports the effective model", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      fake.model = { id: "claude-sonnet-5", provider: "anthropic", input: ["text"] };
      fake.modelFallbackMessage = "Could not restore model a/old. Using anthropic/claude-sonnet-5";
      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* collectEvents(adapter, eventsRef);
      const session = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      assert.strictEqual(session.model, "anthropic/claude-sonnet-5");
      yield* waitFor(eventsRef, (events) =>
        events.some((event) => event.type === "runtime.warning"),
      );
      const warning = (yield* Ref.get(eventsRef)).find((event) => event.type === "runtime.warning");
      assert.include(
        warning !== undefined && warning.type === "runtime.warning" ? warning.payload.message : "",
        "Could not restore model a/old",
      );
    }),
  );

  it.effect("a model without a provider id still reports its effective model", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      fake.model = { id: "bare-model", input: ["text"] };
      const adapter = yield* makeAdapter(fake);
      const session = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      assert.strictEqual(session.model, "bare-model");
    }),
  );

  it.effect("failed abort does not suppress subsequent settlement", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const completion = yield* Deferred.make<ProviderRuntimeEvent>();
      const barrier = yield* Deferred.make<void>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => {
          if (event.type === "turn.completed") return Deferred.succeed(completion, event);
          if (event.type === "runtime.warning") return Deferred.succeed(barrier, undefined);
          return Effect.void;
        }),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "hello" });
      fake.abort = () => Promise.reject(new Error("Abort failed"));
      const rejected = yield* adapter.interruptTurn(threadId).pipe(Effect.exit);
      assert.strictEqual(rejected._tag, "Failure");
      fake.emit({ type: "agent_settled" });
      fake.emit({ type: "extension_error", extensionPath: "test", error: "barrier" });
      yield* Deferred.await(barrier);
      assert.isTrue(yield* Deferred.isDone(completion));
      assert.strictEqual((yield* Deferred.await(completion)).turnId, turn.turnId);
    }),
  );

  it.effect("sendTurn surfaces a rejected prompt as a failed sendTurn", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      fake.prompt = () => Promise.reject(new Error("No model configured"));
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* collectEvents(adapter, eventsRef);
      const exit = yield* adapter.sendTurn({ threadId, input: "hello" }).pipe(Effect.exit);

      assert.strictEqual(exit._tag, "Failure");
      const events = yield* Ref.get(eventsRef);
      assert.isFalse(events.some((event) => event.type === "turn.completed"));
    }),
  );

  it.effect("sendTurn surfaces a synchronously throwing prompt as a failed sendTurn", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      fake.prompt = () => {
        throw new Error("sync preflight failure");
      };
      const exit = yield* adapter.sendTurn({ threadId, input: "hello" }).pipe(Effect.exit);

      assert.strictEqual(exit._tag, "Failure");
    }),
  );

  it.effect("startSession passes the thread's modelSelection through to session creation", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const createInputs: Array<{
        model: string | undefined;
        thinkingLevel: string | undefined;
      }> = [];
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: ProviderInstanceId.make("pi"),
        createSession: (input) => {
          createInputs.push({ model: input.model, thinkingLevel: input.thinkingLevel });
          return Promise.resolve(fake);
        },
      }).pipe(Effect.orDie);

      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "openai/gpt-5.2",
          options: [{ id: "thinkingLevel", value: "low" }],
        },
      });

      assert.deepStrictEqual(createInputs, [{ model: "openai/gpt-5.2", thinkingLevel: "low" }]);
    }),
  );

  it.effect("startSession falls back to instance settings without a modelSelection", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const createInputs: Array<{
        model: string | undefined;
        thinkingLevel: string | undefined;
      }> = [];
      const adapter = yield* makePiAdapter(
        decodePiSettings({ model: "anthropic/claude-sonnet-5", thinkingLevel: "high" }),
        {
          instanceId: ProviderInstanceId.make("pi"),
          createSession: (input) => {
            createInputs.push({ model: input.model, thinkingLevel: input.thinkingLevel });
            return Promise.resolve(fake);
          },
        },
      ).pipe(Effect.orDie);

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      assert.deepStrictEqual(createInputs, [
        { model: "anthropic/claude-sonnet-5", thinkingLevel: "high" },
      ]);
    }),
  );

  it.effect("sendTurn applies the composer's model and thinking level in-session", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      yield* adapter.sendTurn({
        threadId,
        input: "hello pi",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-sonnet-5",
          options: [{ id: "thinkingLevel", value: "high" }],
        },
      });

      assert.deepStrictEqual(fake.setModelCalls, [{ model: "anthropic/claude-sonnet-5" }]);
      assert.deepStrictEqual(fake.setThinkingLevelCalls, [{ level: "high" }]);
      assert.strictEqual(fake.promptCalls.length, 1);
    }),
  );

  it.effect("sendTurn translates a leading $skill token into Pi's /skill: form", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      yield* adapter.sendTurn({ threadId, input: "$diagnosing-bugs the thread list is slow" });
      assert.strictEqual(
        fake.promptCalls[0]?.text,
        "/skill:diagnosing-bugs the thread list is slow",
      );

      yield* adapter.sendTurn({ threadId, input: "$wont-fix" });
      assert.strictEqual(fake.promptCalls[1]?.text, "/skill:wont-fix");

      // A $ anywhere but the leading token stays literal.
      yield* adapter.sendTurn({ threadId, input: "costs $5 to run" });
      assert.strictEqual(fake.promptCalls[2]?.text, "costs $5 to run");
    }),
  );

  it.effect("sendTurn leaves the session untouched when no modelSelection is dispatched", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      yield* adapter.sendTurn({ threadId, input: "hello pi" });

      assert.strictEqual(fake.setModelCalls.length, 0);
      assert.strictEqual(fake.setThinkingLevelCalls.length, 0);
    }),
  );

  it.effect("streams assistant text deltas and turn completion from Pi events", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* collectEvents(adapter, eventsRef);

      const { turnId } = yield* adapter.sendTurn({ threadId, input: "write a haiku" });
      fake.emit({ type: "turn_start" });
      fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "old pond…" },
      });
      fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" },
      });
      fake.emit({ type: "agent_settled" });

      const events = yield* waitFor(eventsRef, (e) => e.some((ev) => ev.type === "turn.completed"));
      const deltas = events.filter((e) => e.type === "content.delta");
      assert.strictEqual(deltas.length, 2);
      assert.deepStrictEqual(deltas[0]?.payload, {
        streamKind: "assistant_text",
        delta: "old pond…",
        contentIndex: 0,
      });
      assert.deepStrictEqual(deltas[1]?.payload, {
        streamKind: "reasoning_text",
        delta: "hmm",
        contentIndex: 0,
      });
      assert.strictEqual(deltas[0]?.turnId, turnId);
      assert.strictEqual(events.find((e) => e.type === "turn.started")?.turnId, turnId);
      assert.strictEqual(events.find((e) => e.type === "turn.completed")?.turnId, turnId);
    }),
  );

  it.effect("preserves Pi assistant message boundaries around tool work", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* collectEvents(adapter, eventsRef);

      const { turnId } = yield* adapter.sendTurn({ threadId, input: "inspect then summarize" });
      fake.emit({ type: "turn_start" });
      fake.emit({ type: "message_start", message: { role: "assistant" } });
      fake.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "I will inspect the file first.",
        },
      });
      fake.emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse" } });
      fake.emit({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: {},
      });
      fake.emit({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: {},
        isError: false,
      });
      fake.emit({ type: "turn_start" });
      fake.emit({ type: "message_start", message: { role: "assistant" } });
      fake.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Changes:\\n- Updated the adapter.",
        },
      });
      fake.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      fake.emit({ type: "agent_settled" });

      const events = yield* waitFor(
        eventsRef,
        (received) =>
          received.filter(
            (event) =>
              event.type === "item.completed" && event.payload.itemType === "assistant_message",
          ).length === 2 && received.some((event) => event.type === "turn.completed"),
      );
      const assistantDeltas = events.filter(
        (event): event is Extract<(typeof events)[number], { type: "content.delta" }> =>
          event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      const assistantCompletions = events.filter(
        (event): event is Extract<(typeof events)[number], { type: "item.completed" }> =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );

      assert.strictEqual(assistantDeltas.length, 2);
      assert.strictEqual(assistantCompletions.length, 2);
      const firstItemId = assistantDeltas[0]?.itemId;
      const secondItemId = assistantDeltas[1]?.itemId;
      assert.notStrictEqual(firstItemId, undefined);
      assert.notStrictEqual(secondItemId, undefined);
      if (firstItemId === undefined || secondItemId === undefined) {
        return;
      }
      assert.notStrictEqual(String(firstItemId), String(secondItemId));
      assert.deepStrictEqual(
        assistantCompletions.map((event) => String(event.itemId)),
        [String(firstItemId), String(secondItemId)],
      );
      assert.isTrue(assistantDeltas.every((event) => event.turnId === turnId));
    }),
  );

  it.effect("opens a follow-up turn when Pi resumes after settling", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* collectEvents(adapter, eventsRef);

      const { turnId: firstTurnId } = yield* adapter.sendTurn({
        threadId,
        input: "run subagents",
      });
      fake.emit({ type: "turn_start" });
      fake.emit({ type: "message_start", message: { role: "assistant" } });
      fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Working." },
      });
      fake.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      fake.emit({ type: "agent_settled" });
      yield* waitFor(eventsRef, (e) => e.some((ev) => ev.type === "turn.completed"));

      // Background subagent completions wake the Pi loop without a new
      // prompt: the resumed work must surface as a follow-up turn, not
      // vanish after the first turn completed.
      fake.emit({ type: "turn_start" });
      fake.emit({ type: "message_start", message: { role: "assistant" } });
      fake.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "All three subagents completed.",
        },
      });
      fake.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      fake.emit({ type: "agent_settled" });

      const events = yield* waitFor(
        eventsRef,
        (e) => e.filter((ev) => ev.type === "turn.completed").length === 2,
      );
      const started = events.filter((e) => e.type === "turn.started");
      const completed = events.filter((e) => e.type === "turn.completed");
      // One turn.started for the initial turn plus one per internal
      // turn_start; the follow-up turn mints a distinct id.
      const followUpStarts = started.filter((e) => e.turnId !== firstTurnId);
      assert.isAtLeast(followUpStarts.length, 1);
      const followUpTurnId = followUpStarts[0]?.turnId;
      assert.notStrictEqual(followUpTurnId, undefined);
      assert.strictEqual(completed[0]?.turnId, firstTurnId);
      assert.strictEqual(completed[1]?.turnId, followUpTurnId);
      const followUpDeltas = events.filter(
        (e) => e.type === "content.delta" && e.turnId === followUpTurnId,
      );
      assert.isAtLeast(followUpDeltas.length, 1);
      const followUpCompletions = events.filter(
        (e) =>
          e.type === "item.completed" &&
          e.payload.itemType === "assistant_message" &&
          e.turnId === followUpTurnId,
      );
      assert.strictEqual(followUpCompletions.length, 1);
    }),
  );

  it.effect("attaches late tool events to a follow-up turn", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* collectEvents(adapter, eventsRef);

      const { turnId: firstTurnId } = yield* adapter.sendTurn({
        threadId,
        input: "run subagents",
      });
      fake.emit({ type: "turn_start" });
      fake.emit({ type: "agent_settled" });
      yield* waitFor(eventsRef, (e) => e.some((ev) => ev.type === "turn.completed"));

      fake.emit({
        type: "tool_execution_start",
        toolCallId: "late-tool-1",
        toolName: "bash",
        args: {},
      });
      fake.emit({
        type: "tool_execution_end",
        toolCallId: "late-tool-1",
        toolName: "bash",
        result: {},
        isError: false,
      });
      fake.emit({ type: "agent_settled" });

      const events = yield* waitFor(
        eventsRef,
        (e) => e.filter((ev) => ev.type === "turn.completed").length === 2,
      );
      const toolStarted = events.find(
        (e) => e.type === "item.started" && e.itemId === "late-tool-1",
      );
      const toolCompleted = events.find(
        (e) => e.type === "item.completed" && e.itemId === "late-tool-1",
      );
      assert.notStrictEqual(toolStarted?.turnId, undefined);
      assert.notStrictEqual(toolStarted?.turnId, firstTurnId);
      assert.strictEqual(toolCompleted?.turnId, toolStarted?.turnId);
    }),
  );

  it.effect("enriches Pi tool rows with resolved call arguments", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      fake.messages = [
        { role: "user", content: "run tests" },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-bash-1",
              name: "bash",
              arguments: `{"command":"pnpm test"}`,
            },
          ],
        },
      ];
      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* collectEvents(adapter, eventsRef);

      yield* adapter.sendTurn({ threadId, input: "run tests" });
      fake.emit({ type: "turn_start" });
      fake.emit({ type: "tool_execution_start", toolCallId: "tool-bash-1", toolName: "bash" });
      fake.emit({
        type: "tool_execution_end",
        toolCallId: "tool-bash-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "ok" }] },
        isError: false,
      });

      const events = yield* waitFor(eventsRef, (e) => e.some((ev) => ev.type === "item.completed"));
      const started = events.find((e) => e.type === "item.started");
      const completed = events.find((e) => e.type === "item.completed");
      assert.strictEqual(started?.type, "item.started");
      if (started?.type !== "item.started") return;
      assert.deepStrictEqual(started.payload.data, { command: "pnpm test" });
      assert.strictEqual(completed?.type, "item.completed");
      if (completed?.type !== "item.completed") return;
      assert.deepStrictEqual(completed.payload.data, {
        content: [{ type: "text", text: "ok" }],
        command: "pnpm test",
      });
    }),
  );

  it.effect("attaches the active turn to extension warnings", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* collectEvents(adapter, eventsRef);

      const { turnId } = yield* adapter.sendTurn({ threadId, input: "/broken" });
      fake.emit({
        type: "extension_error",
        extensionPath: "command:broken",
        error: "Auto-drain failed: 1 complete, 3 failed",
      });
      fake.emit({ type: "agent_settled" });

      const events = yield* waitFor(eventsRef, (e) =>
        e.some((ev) => ev.type === "runtime.warning"),
      );
      const warning = events.find((e) => e.type === "runtime.warning");
      assert.strictEqual(warning?.turnId, turnId);
    }),
  );

  it.effect("emits Pi context and current-branch processed usage after an assistant settles", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      fake.entries = [
        { id: "entry-1", parentId: undefined, type: "message", message: { role: "user" } },
        {
          id: "entry-2",
          parentId: "entry-1",
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 40 },
          },
        },
        {
          id: "entry-3",
          parentId: "entry-2",
          type: "message",
          message: { role: "toolResult", usage: { input: 3, output: 2, cacheRead: 1 } },
        },
        {
          id: "entry-4",
          parentId: "entry-3",
          type: "compaction",
          usage: { input: 7, output: 5 },
        },
      ];
      fake.leafId = "entry-4";
      fake.sessionStats = {
        assistantMessages: 1,
        contextUsage: { tokens: 1_000, contextWindow: 400_000, percent: 0.25 },
      };

      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* collectEvents(adapter, eventsRef);

      const { turnId } = yield* adapter.sendTurn({ threadId, input: "continue" });
      fake.emit({ type: "agent_settled" });

      const events = yield* waitFor(eventsRef, (received) =>
        received.some((event) => event.type === "thread.token-usage.updated"),
      );
      const usageEvent = events.find((event) => event.type === "thread.token-usage.updated");
      assert.strictEqual(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type !== "thread.token-usage.updated") {
        return;
      }
      assert.strictEqual(usageEvent.turnId, turnId);
      assert.deepStrictEqual(usageEvent.payload.usage, {
        usedTokens: 1_000,
        maxTokens: 400_000,
        totalProcessedTokens: 208,
        totalProcessedTokensScope: "activeBranch",
        compactsAutomatically: true,
      });
    }),
  );

  it.effect("publishes available context usage as soon as a persisted Pi session resumes", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      fake.resumeOutcome = { resumed: true, sessionFile: "fake-file" };
      fake.sessionStats = {
        assistantMessages: 2,
        contextUsage: { tokens: 24_000, contextWindow: 400_000, percent: 6 },
      };

      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* collectEvents(adapter, eventsRef);
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { sessionId: "persisted-pi-session" },
      });

      const events = yield* waitFor(eventsRef, (received) =>
        received.some((event) => event.type === "thread.token-usage.updated"),
      );
      const usageEvent = events.find((event) => event.type === "thread.token-usage.updated");
      assert.strictEqual(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type !== "thread.token-usage.updated") {
        return;
      }
      assert.deepStrictEqual(usageEvent.payload.usage, {
        usedTokens: 24_000,
        maxTokens: 400_000,
        compactsAutomatically: true,
      });
    }),
  );

  it.effect("clears stale Pi context usage when a resumed session has no usable metadata", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      fake.resumeOutcome = { resumed: true, sessionFile: "fake-file" };
      fake.sessionStats = undefined;

      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* collectEvents(adapter, eventsRef);
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { sessionId: "persisted-pi-session" },
      });

      const events = yield* waitFor(eventsRef, (received) =>
        received.some((event) => event.type === "thread.token-usage.updated"),
      );
      const usageEvent = events.find((event) => event.type === "thread.token-usage.updated");
      assert.strictEqual(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type !== "thread.token-usage.updated") {
        return;
      }
      assert.deepStrictEqual(usageEvent.payload.usage, { contextUsageState: "unavailable" });
    }),
  );

  it.effect("replaces context usage with an honest unknown state after Pi compacts", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      fake.sessionStats = {
        assistantMessages: 2,
        contextUsage: { tokens: 24_000, contextWindow: 400_000, percent: 6 },
      };
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* collectEvents(adapter, eventsRef);
      fake.sessionStats = {
        assistantMessages: 2,
        contextUsage: { tokens: null, contextWindow: 400_000, percent: null },
      };
      fake.emit({ type: "compaction_end", aborted: false });

      const events = yield* waitFor(eventsRef, (received) =>
        received.some((event) => event.type === "thread.token-usage.updated"),
      );
      const usageEvent = events.find((event) => event.type === "thread.token-usage.updated");
      assert.strictEqual(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type !== "thread.token-usage.updated") {
        return;
      }
      assert.deepStrictEqual(usageEvent.payload.usage, {
        contextUsageState: "unknown",
        contextUsageUnknownReason: "compacted",
        maxTokens: 400_000,
        compactsAutomatically: true,
      });
    }),
  );

  it.effect("updates the Pi context window immediately after a model switch", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      fake.sessionStats = {
        assistantMessages: 2,
        contextUsage: { tokens: 24_000, contextWindow: 400_000, percent: 6 },
      };
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* collectEvents(adapter, eventsRef);
      fake.sessionStats = {
        assistantMessages: 2,
        contextUsage: { tokens: 24_000, contextWindow: 200_000, percent: 12 },
      };
      const { turnId } = yield* adapter.sendTurn({
        threadId,
        input: "switch models",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-sonnet-5",
        },
      });

      const events = yield* waitFor(eventsRef, (received) =>
        received.some((event) => event.type === "thread.token-usage.updated"),
      );
      const usageEvent = events.find((event) => event.type === "thread.token-usage.updated");
      assert.strictEqual(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type !== "thread.token-usage.updated") {
        return;
      }
      assert.strictEqual(usageEvent.turnId, turnId);
      assert.deepStrictEqual(usageEvent.payload.usage, {
        usedTokens: 24_000,
        maxTokens: 200_000,
        compactsAutomatically: true,
      });
    }),
  );

  it.effect("recalculates Pi processed usage from the active branch after a fork", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      fake.entries = [
        { id: "entry-1", parentId: undefined, type: "message", message: { role: "user" } },
        {
          id: "entry-2",
          parentId: "entry-1",
          type: "message",
          message: { role: "assistant", usage: { input: 100, output: 20 } },
        },
        { id: "entry-3", parentId: "entry-2", type: "message", message: { role: "user" } },
        {
          id: "entry-4",
          parentId: "entry-3",
          type: "message",
          message: { role: "assistant", usage: { input: 300, output: 40 } },
        },
      ];
      fake.leafId = "entry-4";
      fake.sessionStats = {
        assistantMessages: 2,
        contextUsage: { tokens: 120, contextWindow: 400_000, percent: 0.03 },
      };
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* collectEvents(adapter, eventsRef);
      yield* adapter.sendTurn({ threadId, input: "undo the active turn" });
      yield* adapter.rollbackThread(threadId, 1);

      const events = yield* waitFor(eventsRef, (received) =>
        received.some((event) => event.type === "thread.token-usage.updated"),
      );
      const usageEvent = events.find((event) => event.type === "thread.token-usage.updated");
      assert.strictEqual(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type !== "thread.token-usage.updated") {
        return;
      }
      assert.deepStrictEqual(fake.forkCalls, [{ entryId: "entry-2" }]);
      assert.isUndefined(usageEvent.turnId);
      assert.deepStrictEqual(usageEvent.payload.usage, {
        usedTokens: 120,
        maxTokens: 400_000,
        totalProcessedTokens: 120,
        totalProcessedTokensScope: "activeBranch",
        compactsAutomatically: true,
      });
    }),
  );

  it.effect("surfaces Pi assistant errors as failed turns", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* collectEvents(adapter, eventsRef);

      const { turnId } = yield* adapter.sendTurn({ threadId, input: "hello pi" });
      fake.emit({ type: "turn_start" });
      fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "OAuth auth derivation failed for openai-codex",
        },
      });
      // Non-retryable errors (auth, context overflow) get willRetry: false.
      fake.emit({ type: "agent_end", willRetry: false });
      fake.emit({ type: "agent_settled" });

      const events = yield* waitFor(eventsRef, (e) => e.some((ev) => ev.type === "turn.completed"));
      const completed = events.filter((event) => event.type === "turn.completed");
      assert.strictEqual(completed.length, 1);
      assert.strictEqual(completed[0]?.turnId, turnId);
      assert.deepStrictEqual(completed[0]?.payload, {
        state: "failed",
        errorMessage: "OAuth auth derivation failed for openai-codex",
      });
    }),
  );

  it.effect("defers turn failure when Pi auto-retries a transient error", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* collectEvents(adapter, eventsRef);

      const { turnId } = yield* adapter.sendTurn({ threadId, input: "hello pi" });
      fake.emit({ type: "turn_start" });
      // Transient error — Pi will auto-retry.
      fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "502: Service temporarily unavailable",
        },
      });
      fake.emit({ type: "agent_end", willRetry: true });
      fake.emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 5000,
        errorMessage: "502: Service temporarily unavailable",
      });

      // The turn must NOT be marked failed — Pi is retrying.
      const eventsAfterRetryStart = yield* Ref.get(eventsRef);
      assert.isFalse(
        eventsAfterRetryStart.some((e) => e.type === "turn.completed"),
        "turn.completed must not fire while Pi is auto-retrying",
      );

      // Retry succeeds — a fresh turn_start and clean completion.
      fake.emit({ type: "turn_start" });
      fake.emit({ type: "agent_settled" });

      const events = yield* waitFor(eventsRef, (e) => e.some((ev) => ev.type === "turn.completed"));
      const completed = events.filter((event) => event.type === "turn.completed");
      assert.strictEqual(completed.length, 1);
      assert.strictEqual(completed[0]?.turnId, turnId);
      assert.deepStrictEqual(completed[0]?.payload, { state: "completed" });
    }),
  );

  it.effect("emits turn failure only after retry budget is exhausted", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* collectEvents(adapter, eventsRef);

      const { turnId } = yield* adapter.sendTurn({ threadId, input: "hello pi" });
      fake.emit({ type: "turn_start" });
      // First attempt fails — Pi will retry.
      fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "502: Service temporarily unavailable",
        },
      });
      fake.emit({ type: "agent_end", willRetry: true });
      fake.emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 1,
        delayMs: 1000,
        errorMessage: "502: Service temporarily unavailable",
      });

      // No failure yet — still retrying.
      const eventsAfterFirstError = yield* Ref.get(eventsRef);
      assert.isFalse(
        eventsAfterFirstError.some((e) => e.type === "turn.completed"),
        "turn.completed must not fire while Pi is auto-retrying",
      );

      // Retry also fails — budget exhausted.
      fake.emit({ type: "turn_start" });
      fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "502: Service temporarily unavailable",
        },
      });
      fake.emit({ type: "agent_end", willRetry: false });
      fake.emit({
        type: "auto_retry_end",
        success: false,
        attempt: 1,
        finalError: "502: Service temporarily unavailable",
      });

      const events = yield* waitFor(eventsRef, (e) => e.some((ev) => ev.type === "turn.completed"));
      const completed = events.filter((event) => event.type === "turn.completed");
      assert.strictEqual(completed.length, 1);
      assert.strictEqual(completed[0]?.turnId, turnId);
      assert.deepStrictEqual(completed[0]?.payload, {
        state: "failed",
        errorMessage: "502: Service temporarily unavailable",
      });
    }),
  );

  it.effect("maps tool execution to item lifecycle events", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* collectEvents(adapter, eventsRef);

      yield* adapter.sendTurn({ threadId, input: "list files" });
      fake.emit({
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "ls",
        args: { path: "." },
      });
      fake.emit({
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "ls",
        result: "ok",
        isError: false,
      });

      const events = yield* waitFor(eventsRef, (e) => e.some((ev) => ev.type === "item.completed"));
      assert.strictEqual(events.find((e) => e.type === "item.started")?.itemId, "tc-1");
      assert.strictEqual(events.find((e) => e.type === "item.completed")?.itemId, "tc-1");
    }),
  );

  it.effect("interruptTurn settles an aborted turn exactly once when settlement races abort", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      fake.emitSettledOnAbort = true;
      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* collectEvents(adapter, eventsRef);

      const { turnId } = yield* adapter.sendTurn({ threadId, input: "long task" });
      yield* adapter.interruptTurn(threadId, turnId);
      const events = yield* waitFor(eventsRef, (e) =>
        e.some((ev) => ev.type === "turn.aborted" || ev.type === "turn.completed"),
      );
      const terminals = events.filter(
        (e) => e.type === "turn.completed" || e.type === "turn.aborted",
      );
      assert.strictEqual(terminals.length, 1);
      assert.strictEqual(terminals[0]?.type, "turn.aborted");
      assert.strictEqual(terminals[0]?.turnId, turnId);
    }),
  );

  it.effect("interruptTurn ignores a stale turn id", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* collectEvents(adapter, eventsRef);

      const { turnId } = yield* adapter.sendTurn({ threadId, input: "long task" });
      yield* adapter.interruptTurn(threadId, TurnId.make("00000000-0000-0000-0000-000000000000"));
      yield* TestClock.withLive(Effect.sleep("20 millis"));
      assert.isFalse(fake.aborted);
      const events = yield* Ref.get(eventsRef);
      assert.isFalse(events.some((e) => e.type === "turn.aborted"));
      assert.isTrue(yield* adapter.hasSession(threadId));
      assert.isDefined(turnId);
    }),
  );

  it.effect("interruptTurn aborts the session and emits turn.aborted", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* collectEvents(adapter, eventsRef);

      const { turnId } = yield* adapter.sendTurn({ threadId, input: "long task" });
      yield* adapter.interruptTurn(threadId, turnId);

      assert.isTrue(fake.aborted);
      const events = yield* waitFor(eventsRef, (e) => e.some((ev) => ev.type === "turn.aborted"));
      assert.strictEqual(events.find((e) => e.type === "turn.aborted")?.turnId, turnId);
    }),
  );

  it.effect("stopSession disposes the Pi session and forgets it", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      yield* adapter.stopSession(threadId);

      assert.isTrue(fake.disposed);
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.strictEqual((yield* adapter.listSessions()).length, 0);
    }),
  );

  it.effect("startSession resumes from a persisted Pi session id in resumeCursor", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const createCalls: Array<{ resumeSessionId: string | undefined }> = [];
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        createSession: (input) => {
          createCalls.push({ resumeSessionId: input.resumeSessionId });
          return Promise.resolve(fake);
        },
      }).pipe(Effect.orDie);

      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { sessionId: "pi-session-xyz" },
      });

      assert.deepStrictEqual(createCalls, [{ resumeSessionId: "pi-session-xyz" }]);
    }),
  );

  it.effect("keeps recovery failures actionable and does not register a replacement session", () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        createSession: () =>
          Promise.reject(
            new Error(
              "Session storage is unreadable. Restore access and retry, or create a new thread to start fresh.",
            ),
          ),
      });
      const error = yield* adapter
        .startSession({
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { sessionId: "gone-pi-session" },
        })
        .pipe(Effect.flip);
      assert.include(error.message, "unreadable");
      assert.include(error.message, "create a new thread");
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.deepStrictEqual(yield* adapter.listSessions(), []);
    }),
  );

  it.effect("forwards and preserves the durable locator through startup and turns", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const sessionFile = "/saved/pi/session.jsonl";
      const cursor = { sessionId: fake.sessionId, sessionFile };
      const calls: PiCreateSessionInput[] = [];
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        createSession: (input) => {
          calls.push(input);
          return Promise.resolve(Object.assign(fake, { sessionFile }));
        },
      });
      const session = yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        resumeCursor: cursor,
      });
      assert.strictEqual(calls[0]?.resumeSessionFile, sessionFile);
      assert.deepStrictEqual(session.resumeCursor, cursor);
      const turn = yield* adapter.sendTurn({ threadId, input: "Continue" });
      assert.deepStrictEqual(turn.resumeCursor, cursor);
      assert.deepStrictEqual((yield* adapter.listSessions())[0]?.resumeCursor, cursor);
      yield* adapter.stopAll();
    }),
  );

  it.effect("rejects malformed cursors before calling the factory", () =>
    Effect.gen(function* () {
      let calls = 0;
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        createSession: () => {
          calls++;
          return Promise.resolve(new FakePiSession());
        },
      });
      const error = yield* adapter
        .startSession({ threadId, runtimeMode: "full-access", resumeCursor: {} })
        .pipe(Effect.flip);
      assert.include(error.message, "Invalid Pi resume cursor");
      assert.strictEqual(calls, 0);
    }),
  );

  it.effect("startSession forwards the settings' disabled extensions to the session", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const createCalls: Array<PiCreateSessionInput> = [];
      const adapter = yield* makePiAdapter(
        decodePiSettings({ disabledExtensions: ["/home/dev/.pi/agent/extensions/noisy.ts"] }),
        {
          createSession: (input) => {
            createCalls.push(input);
            return Promise.resolve(fake);
          },
        },
      ).pipe(Effect.orDie);

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      assert.lengthOf(createCalls, 1);
      assert.strictEqual(createCalls[0]?.threadId, threadId);
      assert.deepStrictEqual(createCalls[0]?.disabledExtensions, [
        "/home/dev/.pi/agent/extensions/noisy.ts",
      ]);
    }),
  );

  it.effect("startSession recovers by retrying without failing extensions", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const createCalls: Array<PiCreateSessionInput> = [];
      let callCount = 0;
      const adapter = yield* makePiAdapter(decodePiSettings({ disabledExtensions: [] }), {
        createSession: (input) => {
          createCalls.push(input);
          callCount++;
          if (callCount === 1) {
            return Promise.reject(
              new PiExtensionLoadError("Extension load failure", [
                "/home/dev/.pi/agent/extensions/broken.ts",
              ]),
            );
          }
          return Promise.resolve(fake);
        },
      }).pipe(Effect.orDie);

      const session = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      assert.strictEqual(session.status, "ready");
      assert.lengthOf(createCalls, 2);
      assert.deepStrictEqual(
        createCalls.map((call) => call.threadId),
        [threadId, threadId],
      );
      assert.deepStrictEqual(createCalls[1]?.disabledExtensions, [
        "/home/dev/.pi/agent/extensions/broken.ts",
      ]);
    }),
  );

  it.effect(
    "startSession reports recovered extension failures as a warning and records the actual disabled set",
    () =>
      Effect.gen(function* () {
        const fake = new FakePiSession();
        const createCalls: Array<PiCreateSessionInput> = [];
        let callCount = 0;
        const adapter = yield* makePiAdapter(
          decodePiSettings({ disabledExtensions: ["/home/dev/.pi/agent/extensions/noisy.ts"] }),
          {
            createSession: (input) => {
              createCalls.push(input);
              callCount++;
              if (callCount === 1) {
                return Promise.reject(
                  new PiExtensionLoadError("Extension load failure", [
                    "/home/dev/.pi/agent/extensions/broken.ts",
                  ]),
                );
              }
              return Promise.resolve(fake);
            },
          },
        ).pipe(Effect.orDie);

        const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
        yield* collectEvents(adapter, eventsRef);
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

        // The retry must not be silent: the thread sees which extension was skipped.
        const events = yield* Ref.get(eventsRef);
        const warning = events.find((event) => event.type === "runtime.warning");
        assert.isDefined(warning);
        if (warning?.type === "runtime.warning") {
          assert.include(warning.payload.message, "/home/dev/.pi/agent/extensions/broken.ts");
        }

        // The recorded disabled set includes the recovered failure, so the next
        // turn must not reload the session hunting for a settings change.
        yield* adapter.sendTurn({ threadId, input: "hello" });
        assert.lengthOf(createCalls, 2);
        yield* adapter.stopAll();
      }),
  );

  it.effect("startSession does not drop buffered startup events replayed during subscribe", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      // The real factory replays startup extension errors synchronously the
      // first time subscribe runs; a context registered after subscribing
      // would fail the membership guard and silently drop them.
      const buffered: PiSessionEventLike[] = [
        {
          type: "extension_error",
          extensionPath: "/home/dev/.pi/agent/extensions/flaky.ts",
          error: "threw during startup",
        },
      ];
      const originalSubscribe = fake.subscribe.bind(fake);
      fake.subscribe = (listener) => {
        const unsubscribe = originalSubscribe(listener);
        for (const event of buffered) listener(event);
        return unsubscribe;
      };
      const adapter = yield* makeAdapter(fake);

      const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* collectEvents(adapter, eventsRef);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      const events = yield* waitFor(eventsRef, (current) =>
        current.some((event) => event.type === "runtime.warning"),
      );
      const warning = events.find((event) => event.type === "runtime.warning");
      assert.isDefined(warning);
      if (warning?.type === "runtime.warning") {
        assert.include(warning.payload.message, "/home/dev/.pi/agent/extensions/flaky.ts");
      }
      yield* adapter.stopAll();
    }),
  );

  it.effect(
    "waitForActiveTurnsToSettle waits for active turn to settle rather than disrupting streams",
    () =>
      Effect.gen(function* () {
        const fake = new FakePiSession();
        const adapter = yield* makeAdapter(fake);
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        const eventsRef = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
        yield* collectEvents(adapter, eventsRef);

        // No active turns: resolves immediately
        const settleNoTurns = adapter.waitForActiveTurnsToSettle
          ? adapter.waitForActiveTurnsToSettle(1000)
          : Effect.void;
        yield* settleNoTurns;

        // Send turn: active turn in progress
        yield* adapter.sendTurn({ threadId, input: "streaming" });
        fake.emit({ type: "turn_start" });

        const subscribed = yield* Deferred.make<void>();
        const subscribe = fake.subscribe.bind(fake);
        let unsubscribed = false;
        fake.subscribe = (listener) => {
          const unsubscribe = subscribe(listener);
          Deferred.doneUnsafe(subscribed, Effect.void);
          return () => {
            unsubscribed = true;
            unsubscribe();
          };
        };

        // Fork waiting fiber
        const settleTurn = adapter.waitForActiveTurnsToSettle
          ? adapter.waitForActiveTurnsToSettle(5000)
          : Effect.void;
        const settleFiber = yield* settleTurn.pipe(Effect.forkScoped);

        yield* Deferred.await(subscribed);
        // Pi may not be streaming while waiting to retry. That is not completion.
        fake.isStreaming = false;
        fake.emit({ type: "auto_retry_start", attempt: 1 });
        assert.isFalse(unsubscribed);

        // Settle turn
        fake.emit({ type: "agent_settled" });
        yield* Fiber.join(settleFiber);
        assert.isTrue(unsubscribed);
      }),
  );

  it.effect("re-creates idle session cleanly when disabledExtensions changed between turns", () =>
    Effect.gen(function* () {
      const fake1 = new FakePiSession();
      fake1.sessionId = "session-1";
      fake1.sessionFile = "/tmp/session-1.jsonl";
      const fake2 = new FakePiSession();
      fake2.sessionId = "session-2";
      fake2.sessionFile = "/tmp/session-1.jsonl";

      const createCalls: Array<PiCreateSessionInput> = [];
      const currentDisabledRef = yield* Ref.make<ReadonlyArray<string>>([]);
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        getSettings: Ref.get(currentDisabledRef).pipe(
          Effect.map((disabledExtensions) => ({ ...decodePiSettings({}), disabledExtensions })),
        ),
        createSession: (input) => {
          createCalls.push(input);
          return Promise.resolve(createCalls.length === 1 ? fake1 : fake2);
        },
      }).pipe(Effect.orDie);

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      assert.lengthOf(createCalls, 1);

      // First turn runs and completes
      yield* adapter.sendTurn({ threadId, input: "first turn" });
      fake1.emit({ type: "agent_settled" });

      // Settings change disabledExtensions while session is idle
      yield* Ref.set(currentDisabledRef, ["/path/to/disabled.ts"]);

      // Second turn sends: session re-creates cleanly at cursor with updated disabledExtensions
      yield* adapter.sendTurn({ threadId, input: "second turn" });
      assert.lengthOf(createCalls, 2);
      assert.deepStrictEqual(
        createCalls.map((call) => call.threadId),
        [threadId, threadId],
      );
      assert.strictEqual(createCalls[1]?.resumeSessionId, "session-1");
      assert.deepStrictEqual(createCalls[1]?.disabledExtensions, ["/path/to/disabled.ts"]);
    }),
  );

  it.effect("readThread returns the Pi session messages", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      const snapshot = yield* adapter.readThread(threadId);

      assert.strictEqual(snapshot.threadId, threadId);
      assert.strictEqual(snapshot.turns.length, 1);
      assert.deepStrictEqual(snapshot.turns[0]?.items, [...fake.messages]);
    }),
  );

  it.effect("rollbackThread forks the Pi session N turns back (fork-as-rollback)", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      const snapshot = yield* adapter.rollbackThread(threadId, 1);

      // 1 turn back from leaf entry-4 forks at entry-2 (the end of turn 1),
      // dropping turn 2 (user entry-3 + assistant entry-4).
      assert.deepStrictEqual(fake.forkCalls, [{ entryId: "entry-2" }]);
      assert.strictEqual(snapshot.threadId, threadId);
    }),
  );
});

describe("parsePiResumeCursor", () => {
  it("decodes legacy and durable cursors but rejects malformed saved state", () => {
    assert.deepStrictEqual(parsePiResumeCursor({ sessionId: "pi-session-xyz" }), {
      sessionId: "pi-session-xyz",
    });
    assert.strictEqual(parsePiResumeCursor(undefined), undefined);
    assert.strictEqual(parsePiResumeCursor(null), undefined);
    assert.deepStrictEqual(
      parsePiResumeCursor({ sessionId: "pi-session-xyz", sessionFile: "/saved/session.jsonl" }),
      {
        sessionId: "pi-session-xyz",
        sessionFile: "/saved/session.jsonl",
      },
    );
    for (const cursor of [
      "pi-session-xyz",
      {},
      { sessionId: "  " },
      { sessionId: "pi-session-xyz", sessionFile: 12 },
    ]) {
      assert.throws(() => parsePiResumeCursor(cursor), "Invalid Pi resume cursor");
    }
  });
});

describe("pi tool-call arguments", () => {
  it("resolves tool-call arguments from session messages", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "bash", arguments: `{"command":"pnpm test"}` },
          { type: "toolCall", id: "call_2", name: "read", arguments: { path: "src/a.ts" } },
        ],
      },
    ];
    assert.deepStrictEqual(resolvePiToolCallArgs(messages, "call_1"), { command: "pnpm test" });
    assert.deepStrictEqual(resolvePiToolCallArgs(messages, "call_2"), { path: "src/a.ts" });
    assert.strictEqual(resolvePiToolCallArgs(messages, "call_9"), undefined);
    assert.strictEqual(resolvePiToolCallArgs(messages, ""), undefined);
    assert.strictEqual(
      resolvePiToolCallArgs(
        [{ role: "assistant", content: [{ type: "toolCall", id: "x", arguments: "not-json" }] }],
        "x",
      ),
      undefined,
    );
  });

  it("shapes tool args into timeline fields", () => {
    assert.deepStrictEqual(describePiToolCall("bash", { command: "pnpm test" }), {
      data: { command: "pnpm test" },
    });
    assert.deepStrictEqual(describePiToolCall("read", { path: "src/a.ts" }), {
      data: { path: "src/a.ts" },
    });
    assert.deepStrictEqual(describePiToolCall("edit", { path: "src/a.ts" }), {
      data: { path: "src/a.ts" },
    });
    assert.deepStrictEqual(describePiToolCall("grep", { pattern: "TODO", path: "src" }), {
      detail: `"TODO" in src`,
      data: { path: "src" },
    });
    assert.deepStrictEqual(
      describePiToolCall("subagent", { agent: "delegate", task: "Report shell/OS/date" }),
      { title: "Subagent delegate", detail: "Report shell/OS/date" },
    );
    assert.deepStrictEqual(describePiToolCall("bash", undefined), {});
    assert.deepStrictEqual(describePiToolCall("bash", {}), {});
  });
});
