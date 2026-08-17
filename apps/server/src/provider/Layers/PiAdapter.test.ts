// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  PiSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { makePiAdapter, type PiSessionEventLike, type PiSessionLike } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const testLayer = Layer.mergeAll(NodeServices.layer);

class FakePiSession implements PiSessionLike {
  readonly sessionId = "fake-pi-session-1";
  isStreaming = false;
  messages: ReadonlyArray<unknown> = [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
  ];
  readonly promptCalls: Array<{ text: string }> = [];
  readonly steerCalls: Array<{ text: string }> = [];
  readonly forkCalls: Array<{ entryId: string }> = [];
  readonly setModelCalls: Array<{ model: string }> = [];
  readonly setThinkingLevelCalls: Array<{ level: string }> = [];
  forkedMessages: ReadonlyArray<unknown> | undefined;
  aborted = false;
  disposed = false;
  private listeners = new Set<(event: PiSessionEventLike) => void>();

  getEntries() {
    // branch: user(1) → assistant(2) → user(3) → assistant(4); leaf is 4
    return [
      { id: "entry-1", parentId: undefined, message: { role: "user" } },
      { id: "entry-2", parentId: "entry-1", message: { role: "assistant" } },
      { id: "entry-3", parentId: "entry-2", message: { role: "user" } },
      { id: "entry-4", parentId: "entry-3", message: { role: "assistant" } },
    ];
  }
  getLeafId() {
    return "entry-4";
  }
  fork(entryId: string): void {
    this.forkCalls.push({ entryId });
    this.forkedMessages = this.messages;
  }

  setModel(model: string): Promise<void> {
    this.setModelCalls.push({ model });
    return Promise.resolve();
  }
  setThinkingLevel(level: string): void {
    this.setThinkingLevelCalls.push({ level });
  }

  prompt(text: string): Promise<void> {
    this.promptCalls.push({ text });
    return Promise.resolve();
  }
  steer(text: string): Promise<void> {
    this.steerCalls.push({ text });
    return Promise.resolve();
  }
  followUp(): Promise<void> {
    return Promise.resolve();
  }
  abort(): Promise<void> {
    this.aborted = true;
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

  it.effect("sendTurn prompts when idle and steers while streaming", () =>
    Effect.gen(function* () {
      const fake = new FakePiSession();
      const adapter = yield* makeAdapter(fake);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      const first = yield* adapter.sendTurn({ threadId, input: "hello pi" });
      assert.strictEqual(fake.promptCalls.length, 1);
      assert.strictEqual(fake.promptCalls[0]?.text, "hello pi");
      assert.strictEqual(first.threadId, threadId);

      fake.isStreaming = true;
      yield* adapter.sendTurn({ threadId, input: "actually do this" });
      assert.strictEqual(fake.steerCalls.length, 1);
      assert.strictEqual(fake.steerCalls[0]?.text, "actually do this");
      assert.strictEqual(fake.promptCalls.length, 1);
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
      const createCalls: Array<{ resumeSessionFile: string | undefined }> = [];
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        createSession: (input) => {
          createCalls.push({ resumeSessionFile: input.resumeSessionFile });
          return Promise.resolve(fake);
        },
      }).pipe(Effect.orDie);

      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { sessionId: "pi-session-xyz" },
      });

      assert.deepStrictEqual(createCalls, [{ resumeSessionFile: "pi-session-xyz" }]);
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
