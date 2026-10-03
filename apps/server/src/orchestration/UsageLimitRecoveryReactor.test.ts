import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { ServerSettingsService, layerTest as settingsTest } from "../serverSettings.ts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import { describe } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { usageLimitFromError } from "../provider/usageLimitError.ts";
import { isAutoSettlementCandidate } from "./ThreadSettlementPolicy.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import { UsageLimitChecks } from "../provider/UsageLimitChecks.ts";
import type { UsageLimitStatus } from "../provider/usageLimitStatus.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";
import { make, layer as recoveryReactor } from "./UsageLimitRecoveryReactor.ts";

const coreLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "rove-limit-recovery-" })),
  Layer.provideMerge(NodeServices.layer),
);
const withChecks = (
  check: (modelSelection: typeof selection, observedAt: string) => Effect.Effect<UsageLimitStatus>,
) =>
  coreLayer.pipe(
    Layer.provide(Layer.succeed(UsageLimitChecks, { enabled: Effect.succeed(true), check })),
  );
const layer = withChecks(() => Effect.succeed({ type: "available" }));
const now = "1970-01-01T00:00:00.000Z";
const threadId = ThreadId.make("limited-thread");
const turnId = TurnId.make("limited-turn");
const projectId = ProjectId.make("limited-project");
const selection = { instanceId: ProviderInstanceId.make("pi"), model: "openai-codex/gpt-5.4" };
const seed = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("project"),
    projectId,
    title: "Synthetic recovery",
    workspaceRoot: "/tmp/rove-synthetic-limit",
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("thread"),
    threadId,
    projectId,
    title: "Limited",
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make("start"),
    threadId,
    message: {
      messageId: MessageId.make("question"),
      role: "user",
      text: "Synthetic work",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make("running"),
    threadId,
    session: {
      threadId,
      status: "running",
      providerName: "pi",
      providerInstanceId: selection.instanceId,
      runtimeMode: "full-access",
      activeTurnId: turnId,
      lastError: null,
      updatedAt: now,
    },
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make("failed"),
    threadId,
    session: {
      threadId,
      status: "error",
      providerName: "pi",
      providerInstanceId: selection.instanceId,
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: "You have hit your ChatGPT usage limit (plus plan). Try again in ~2 min.",
      updatedAt: now,
    },
    createdAt: now,
  });
  return engine;
});
const record = (resetAt: string | null = "1970-01-01T00:03:00.000Z") =>
  Effect.gen(function* () {
    const engine = yield* seed;
    yield* engine.dispatch({
      type: "thread.limit-recovery.record",
      commandId: CommandId.make("recovery"),
      threadId,
      turnId,
      modelSelection: selection,
      limit: { resetAt },
      autoResume: true,
      createdAt: now,
    });
    return engine;
  });

describe("durable usage-limit recovery without provider requests", () => {
  it.effect("a stop before limit evidence arrives prevents a late automatic schedule", () =>
    Effect.gen(function* () {
      const engine = yield* seed;
      yield* engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("stop-before-evidence"),
        threadId,
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.limit-recovery.record",
        commandId: CommandId.make("late-evidence"),
        threadId,
        turnId,
        modelSelection: selection,
        limit: { resetAt: "1970-01-01T00:03:00.000Z" },
        autoResume: true,
        createdAt: now,
      });
      yield* TestClock.adjust("1 day");
      const sweep = yield* make;
      yield* sweep();
      const snapshots = yield* ProjectionSnapshotQuery;
      const thread = (yield* snapshots.getSnapshot()).threads[0]!;
      expect(thread.limitRecovery?.resetAt).toBe("1970-01-01T00:03:00.000Z");
      expect(thread.limitRecovery?.resumeAt).toBeNull();
      expect(thread.messages).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("unknown reset errors permit an ordinary manual retry without recovery controls", () =>
    Effect.gen(function* () {
      const engine = yield* record(null);
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("unknown-manual"),
        threadId,
        message: {
          messageId: MessageId.make("unknown-manual"),
          role: "user",
          text: "Retry manually",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now,
      });
      const snapshots = yield* ProjectionSnapshotQuery;
      expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(2);
    }).pipe(
      Effect.provide(
        withChecks(() => Effect.die("Unknown resets have no automatic recovery to check")),
      ),
    ),
  );

  it.effect("a late report of the stopped failure cannot re-arm recovery", () =>
    Effect.gen(function* () {
      const engine = yield* record();
      yield* engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("stop-before-late-report"),
        threadId,
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.limit-recovery.record",
        commandId: CommandId.make("late-failure-after-stop"),
        threadId,
        turnId,
        modelSelection: selection,
        limit: { resetAt: "1970-01-01T00:03:00.000Z" },
        autoResume: true,
        createdAt: now,
      });
      yield* TestClock.adjust("1 day");
      const sweep = yield* make;
      yield* sweep();
      const snapshots = yield* ProjectionSnapshotQuery;
      expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(1);
      expect((yield* snapshots.getSnapshot()).threads[0]?.limitRecovery?.resumeAt).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each(["permissions", "interaction", "workspace"] as const)(
    "a %s change cannot bypass a same-model quota check",
    (change) =>
      Effect.gen(function* () {
        const engine = yield* record();
        if (change === "permissions")
          yield* engine.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make(change),
            threadId,
            runtimeMode: "approval-required",
            createdAt: now,
          });
        if (change === "interaction")
          yield* engine.dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make(change),
            threadId,
            interactionMode: "plan",
            createdAt: now,
          });
        if (change === "workspace")
          yield* engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(change),
            threadId,
            branch: "new-work",
          });
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("retry-after-context-change"),
            threadId,
            message: {
              messageId: MessageId.make("retry-after-context-change"),
              role: "user",
              text: "Must not bypass quota",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          })
          .pipe(Effect.flip);
        const snapshots = yield* ProjectionSnapshotQuery;
        expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(1);
      }).pipe(
        Effect.provide(
          withChecks(() =>
            Effect.succeed({ type: "limited", resetAt: "1970-01-01T00:10:00.000Z" }),
          ),
        ),
      ),
  );

  it.effect.each([false, true])(
    "cancels existing schedules when the setting is disabled, including manual=%s",
    (manual) =>
      Effect.gen(function* () {
        const engine = yield* record();
        if (manual)
          yield* engine.dispatch({
            type: "thread.limit-recovery.set",
            commandId: CommandId.make("manual-arm"),
            threadId,
            requestId: CommandId.make("recovery"),
            resumeAt: "1970-01-01T00:03:00.000Z",
          });
        const settings = yield* ServerSettingsService;
        const changes = yield* PubSub.unbounded<ServerSettings>();
        const events = yield* engine.subscribeDomainEvents;
        const cancelled = yield* events.pipe(
          Stream.filter(
            (event) =>
              event.type === "thread.meta-updated" &&
              event.payload.limitRecovery?.resumeAt === null,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Layer.build(recoveryReactor).pipe(
          Effect.provideService(ServerSettingsService, {
            ...settings,
            subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
          }),
        );
        const disabled = yield* settings.updateSettings({ autoResumeLimitedThreads: false });
        yield* PubSub.publish(changes, disabled);
        yield* Fiber.join(cancelled);
        yield* TestClock.adjust("4 minutes");
        const snapshots = yield* ProjectionSnapshotQuery;
        const thread = (yield* snapshots.getSnapshot()).threads[0]!;
        expect(thread.limitRecovery?.resumeAt).toBeNull();
        expect(thread.messages).toHaveLength(1);
      }).pipe(
        Effect.provide(Layer.mergeAll(layer, settingsTest({ autoResumeLimitedThreads: true }))),
      ),
  );

  it.effect(
    "a cancellation during a quota request prevents its late result from starting a turn",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          const engine = yield* record();
          yield* TestClock.adjust("3 minutes");
          const sweep = yield* make;
          const running = yield* sweep().pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          yield* engine.dispatch({
            type: "thread.limit-recovery.set",
            commandId: CommandId.make("cancel-during-check"),
            threadId,
            requestId: CommandId.make("recovery"),
            resumeAt: null,
          });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(running);
          const snapshots = yield* ProjectionSnapshotQuery;
          expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(1);
          expect((yield* snapshots.getSnapshot()).threads[0]?.limitRecovery?.resumeAt).toBeNull();
        }).pipe(
          Effect.provide(
            withChecks(() =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ type: "available" as const }),
              ),
            ),
          ),
        );
      }),
  );

  it.effect("changing model options does not bypass the same model's fresh quota check", () =>
    Effect.gen(function* () {
      const engine = yield* record();
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("options-change"),
        threadId,
        modelSelection: { ...selection, options: [{ id: "thinkingLevel", value: "high" }] },
      });
      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("options-retry"),
          threadId,
          message: {
            messageId: MessageId.make("options-retry"),
            role: "user",
            text: "Must not bypass quota",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        })
        .pipe(Effect.flip);
      const snapshots = yield* ProjectionSnapshotQuery;
      expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(1);
    }).pipe(
      Effect.provide(
        withChecks(() => Effect.succeed({ type: "limited", resetAt: "1970-01-01T00:10:00.000Z" })),
      ),
    ),
  );

  it.effect("allows a manual retry before the old reset when fresh quota is available", () =>
    Effect.gen(function* () {
      const engine = yield* record();
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("early-reset"),
        threadId,
        message: {
          messageId: MessageId.make("early-reset"),
          role: "user",
          text: "Retry after the provider reset",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now,
      });
      const snapshots = yield* ProjectionSnapshotQuery;
      const thread = (yield* snapshots.getSnapshot()).threads[0]!;
      expect(thread.messages).toHaveLength(2);
      expect(thread.limitRecovery).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each(["limited", "unavailable"] as const)(
    "does not accept a manual prompt when the fresh check is %s",
    (status) =>
      Effect.gen(function* () {
        const engine = yield* record();
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("blocked-retry"),
            threadId,
            message: {
              messageId: MessageId.make("blocked-retry"),
              role: "user",
              text: "Must stay in the draft",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          })
          .pipe(Effect.flip);
        const snapshots = yield* ProjectionSnapshotQuery;
        const thread = (yield* snapshots.getSnapshot()).threads[0]!;
        expect(thread.messages).toHaveLength(1);
        expect(thread.session?.lastError).toContain("Your prompt was not sent");
        expect(thread.limitRecovery?.resetAt).toBe(
          status === "limited" ? "1970-01-01T00:10:00.000Z" : null,
        );
      }).pipe(
        Effect.provide(
          withChecks(() =>
            Effect.succeed(
              status === "limited"
                ? { type: "limited", resetAt: "1970-01-01T00:10:00.000Z" }
                : { type: "unavailable" },
            ),
          ),
        ),
      ),
  );

  it.effect("skips the old quota check when sending with a different model", () =>
    Effect.gen(function* () {
      const engine = yield* record();
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("different-model"),
        threadId,
        modelSelection: { ...selection, model: "anthropic/claude-sonnet-4-6" },
        message: {
          messageId: MessageId.make("different-model"),
          role: "user",
          text: "Continue with the new model",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now,
      });
      const snapshots = yield* ProjectionSnapshotQuery;
      expect((yield* snapshots.getSnapshot()).threads[0]?.limitRecovery).toBeNull();
    }).pipe(
      Effect.provide(withChecks(() => Effect.die("The old model's quota must not be checked"))),
    ),
  );

  it.effect("bounds automatic quota rechecks and leaves no prompt when still limited", () =>
    Effect.gen(function* () {
      yield* record();
      const sweep = yield* make;
      const snapshots = yield* ProjectionSnapshotQuery;
      for (let attempt = 1; attempt <= 3; attempt++) {
        yield* TestClock.adjust("3 minutes");
        yield* sweep();
        const thread = (yield* snapshots.getSnapshot()).threads[0]!;
        expect(thread.messages).toHaveLength(1);
        expect(thread.limitRecovery?.attempts).toBe(attempt);
        expect(thread.limitRecovery?.resumeAt === null).toBe(attempt === 3);
      }
      yield* TestClock.adjust("1 day");
      yield* sweep();
      expect((yield* snapshots.getSnapshot()).threads[0]?.limitRecovery?.attempts).toBe(3);
    }).pipe(
      Effect.provide(
        withChecks((_model, observedAt) =>
          Effect.succeed({
            type: "limited",
            resetAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(observedAt) + 180000)),
          }),
        ),
      ),
    ),
  );

  it.effect("preserves the attempt bound across newly failed automatic turns", () =>
    Effect.gen(function* () {
      const engine = yield* record();
      const sweep = yield* make;
      const snapshots = yield* ProjectionSnapshotQuery;
      for (let attempt = 1; attempt <= 3; attempt++) {
        yield* TestClock.adjust("3 minutes");
        yield* sweep();
        const nextTurn = TurnId.make(`retry-${attempt}`);
        const at = `1970-01-01T00:${String(attempt * 3).padStart(2, "0")}:00.000Z`;
        const session = {
          threadId,
          providerName: "pi",
          providerInstanceId: selection.instanceId,
          runtimeMode: "full-access" as const,
          lastError: "Usage limit reached",
          updatedAt: at,
        };
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`running-${attempt}`),
          threadId,
          session: { ...session, status: "running", activeTurnId: nextTurn },
          createdAt: at,
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`failed-${attempt}`),
          threadId,
          session: { ...session, status: "error", activeTurnId: null },
          createdAt: at,
        });
        yield* engine.dispatch({
          type: "thread.limit-recovery.record",
          commandId: CommandId.make(`recovery-${attempt}`),
          threadId,
          turnId: nextTurn,
          modelSelection: selection,
          limit: { resetAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(at) + 180000)) },
          autoResume: true,
          createdAt: at,
        });
        const thread = (yield* snapshots.getSnapshot()).threads[0]!;
        expect(thread.limitRecovery?.attempts).toBe(attempt);
        expect(thread.limitRecovery?.resumeAt === null).toBe(attempt === 3);
      }
      yield* TestClock.adjust("1 day");
      yield* sweep();
      expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(4);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("resumes Pi SDK limit evidence once, only after reset", () =>
    Effect.gen(function* () {
      const error = "You have hit your ChatGPT usage limit (plus plan). Try again in ~2 min.";
      const engine = yield* record(usageLimitFromError(error, now)!.resetAt);
      const snapshots = yield* ProjectionSnapshotQuery;
      const sweep = yield* make;
      yield* sweep();
      expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(1);
      const shell = Option.getOrThrow(yield* snapshots.getThreadShellById(threadId));
      expect(shell.limitRecovery?.resumeAt).toBe("1970-01-01T00:03:00.000Z");
      expect((yield* snapshots.getCommandReadModel()).threads[0]?.limitRecovery).toEqual(
        shell.limitRecovery,
      );
      yield* TestClock.adjust("3 minutes");
      yield* sweep();
      yield* sweep();
      const thread = (yield* snapshots.getSnapshot()).threads[0]!;
      expect(thread.messages.map((message) => message.text)).toEqual([
        "Synthetic work",
        "Continue where you left off.",
      ]);
      expect(thread.limitRecovery?.resumeAt).toBeNull();
      expect(thread.limitRecovery?.attempts).toBe(1);
      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("stale-continuation"),
          threadId,
          limitRecoveryRequestId: CommandId.make("recovery"),
          message: {
            messageId: MessageId.make("stale-message"),
            role: "user",
            text: "Must not run",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: "1970-01-01T00:03:00.000Z",
        })
        .pipe(Effect.flip);
      expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("stagger-resumes threads sharing a provider instance", () =>
    Effect.gen(function* () {
      const engine = yield* record();
      const second = ThreadId.make("second-limited-thread");
      const secondTurn = TurnId.make("second-turn");
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("second-create"),
        threadId: second,
        projectId,
        title: "Second limited thread",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("second-running"),
        threadId: second,
        session: {
          threadId: second,
          providerName: "pi",
          providerInstanceId: selection.instanceId,
          status: "running",
          activeTurnId: secondTurn,
          runtimeMode: "full-access",
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("second-failed"),
        threadId: second,
        session: {
          threadId: second,
          providerName: "pi",
          providerInstanceId: selection.instanceId,
          status: "error",
          activeTurnId: null,
          runtimeMode: "full-access",
          lastError: "Usage limit reached",
          updatedAt: now,
        },
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.limit-recovery.record",
        commandId: CommandId.make("second-recovery"),
        threadId: second,
        turnId: secondTurn,
        modelSelection: selection,
        limit: { resetAt: "1970-01-01T00:03:00.000Z" },
        autoResume: true,
        createdAt: now,
      });
      yield* TestClock.adjust("3 minutes");
      const sweep = yield* make;
      const snapshots = yield* ProjectionSnapshotQuery;
      yield* sweep();
      const firstPass = yield* snapshots.getSnapshot();
      expect(
        firstPass.threads
          .flatMap((thread) => thread.messages)
          .filter((message) => message.text === "Continue where you left off."),
      ).toHaveLength(1);
      yield* sweep();
      const secondPass = yield* snapshots.getSnapshot();
      expect(
        secondPass.threads.every(
          (thread) =>
            thread.messages.filter((message) => message.text === "Continue where you left off.")
              .length === 1,
        ),
      ).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("preserves cancellation when the same failure is reported again", () =>
    Effect.gen(function* () {
      const engine = yield* record();
      yield* engine.dispatch({
        type: "thread.limit-recovery.set",
        commandId: CommandId.make("cancel"),
        threadId,
        requestId: CommandId.make("recovery"),
        resumeAt: null,
      });
      yield* engine.dispatch({
        type: "thread.limit-recovery.record",
        commandId: CommandId.make("repeat-failure"),
        threadId,
        turnId,
        modelSelection: selection,
        limit: { resetAt: "1970-01-01T00:03:00.000Z" },
        autoResume: true,
        createdAt: now,
      });
      yield* TestClock.adjust("1 day");
      const sweep = yield* make;
      yield* sweep();
      const snapshots = yield* ProjectionSnapshotQuery;
      expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(1);
      expect((yield* snapshots.getSnapshot()).threads[0]?.limitRecovery?.resumeAt).toBeNull();
    }).pipe(Effect.provide(layer)),
  );
  it.effect("rejects scheduling unknown reset times", () =>
    Effect.gen(function* () {
      const engine = yield* record(null);
      const sweep = yield* make;
      yield* sweep();
      yield* engine
        .dispatch({
          type: "thread.limit-recovery.set",
          commandId: CommandId.make("choose-time"),
          threadId,
          requestId: CommandId.make("recovery"),
          resumeAt: "1970-01-08T00:00:00.000Z",
        })
        .pipe(Effect.flip);
      yield* TestClock.adjust("7 days");
      yield* sweep();
      const snapshots = yield* ProjectionSnapshotQuery;
      expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("waits for a pending approval and retries after its resolution", () =>
    Effect.gen(function* () {
      const engine = yield* record();
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("approval"),
        threadId,
        activity: {
          id: EventId.make("approval"),
          kind: "approval.requested",
          tone: "approval",
          summary: "Synthetic approval",
          payload: { requestId: "synthetic-approval" },
          turnId,
          createdAt: now,
        },
        createdAt: now,
      });
      yield* TestClock.adjust("3 minutes");
      const sweep = yield* make;
      yield* sweep();
      const snapshots = yield* ProjectionSnapshotQuery;
      expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(1);
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("resolved"),
        threadId,
        activity: {
          id: EventId.make("resolved"),
          kind: "approval.resolved",
          tone: "info",
          summary: "Synthetic approval resolved",
          payload: { requestId: "synthetic-approval" },
          turnId,
          createdAt: "1970-01-01T00:03:00.000Z",
        },
        createdAt: "1970-01-01T00:03:00.000Z",
      });
      yield* sweep();
      expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("defers a scheduled continuation until a later snooze expires", () =>
    Effect.gen(function* () {
      const engine = yield* record();
      yield* engine.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze"),
        threadId,
        snoozedUntil: "1970-01-02T00:00:00.000Z",
      });
      yield* TestClock.adjust("3 minutes");
      const sweep = yield* make;
      yield* sweep();
      const snapshots = yield* ProjectionSnapshotQuery;
      expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(1);
      yield* TestClock.adjust("1 day");
      yield* sweep();
      expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("cancelling recovery preserves snooze and waking does not re-arm recovery", () =>
    Effect.gen(function* () {
      const engine = yield* record();
      yield* engine.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze-before-cancel"),
        threadId,
        snoozedUntil: "1970-01-01T00:03:00.000Z",
      });
      yield* TestClock.adjust("1 minute");
      yield* engine.dispatch({
        type: "thread.limit-recovery.set",
        commandId: CommandId.make("cancel-while-snoozed"),
        threadId,
        requestId: CommandId.make("recovery"),
        resumeAt: null,
      });
      const snapshots = yield* ProjectionSnapshotQuery;
      const cancelled = (yield* snapshots.getSnapshot()).threads[0]!;
      expect(cancelled.limitRecovery?.resumeAt).toBeNull();
      expect(cancelled.snoozedUntil).toBe("1970-01-01T00:03:00.000Z");
      const cancelledShell = Option.getOrThrow(yield* snapshots.getThreadShellById(threadId));
      expect(isAutoSettlementCandidate(cancelledShell, "1970-01-01T00:01:00.000Z")).toBe(false);
      yield* engine.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("wake-after-cancel"),
        threadId,
        reason: "user",
      });
      yield* TestClock.adjust("3 minutes");
      const sweep = yield* make;
      yield* sweep();
      const awake = (yield* snapshots.getSnapshot()).threads[0]!;
      expect(awake.snoozedUntil).toBeNull();
      expect(awake.limitRecovery?.resumeAt).toBeNull();
      expect(awake.messages).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("waking a limited thread preserves recovery and still waits for reset", () =>
    Effect.gen(function* () {
      const engine = yield* record();
      yield* engine.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze-before-wake"),
        threadId,
        snoozedUntil: "1970-01-02T00:00:00.000Z",
      });
      yield* TestClock.adjust("1 minute");
      yield* engine.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("wake-before-reset"),
        threadId,
        reason: "user",
      });
      const snapshots = yield* ProjectionSnapshotQuery;
      const awake = (yield* snapshots.getSnapshot()).threads[0]!;
      expect(awake.snoozedUntil).toBeNull();
      expect(awake.limitRecovery?.requestId).toBe(CommandId.make("recovery"));
      expect(awake.limitRecovery?.resumeAt).toBe("1970-01-01T00:03:00.000Z");
      const sweep = yield* make;
      yield* sweep();
      expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(1);
      yield* TestClock.adjust("2 minutes");
      yield* sweep();
      yield* sweep();
      expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each(["available", "limited", "unavailable"] as const)(
    "a quota check finishing %s after snooze cannot send a prompt or wake the thread",
    (status) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          const engine = yield* record();
          yield* TestClock.adjust("3 minutes");
          const sweep = yield* make;
          const running = yield* sweep().pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          yield* engine.dispatch({
            type: "thread.snooze",
            commandId: CommandId.make("snooze-during-quota-check"),
            threadId,
            snoozedUntil: "1970-01-01T00:10:00.000Z",
          });
          yield* TestClock.adjust("1 second");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(running);
          const snapshots = yield* ProjectionSnapshotQuery;
          const snoozed = (yield* snapshots.getSnapshot()).threads[0]!;
          expect(snoozed.messages).toHaveLength(1);
          expect(snoozed.snoozedUntil).toBe("1970-01-01T00:10:00.000Z");
          const snoozedShell = Option.getOrThrow(yield* snapshots.getThreadShellById(threadId));
          expect(isAutoSettlementCandidate(snoozedShell, "1970-01-01T00:03:01.000Z")).toBe(false);
          if (status !== "unavailable") {
            yield* TestClock.adjust("7 minutes");
            yield* sweep();
            yield* sweep();
            expect((yield* snapshots.getSnapshot()).threads[0]?.messages).toHaveLength(2);
          }
        }).pipe(
          Effect.provide(
            withChecks((_model, observedAt) =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(
                  status === "limited" && Date.parse(observedAt) < 600000
                    ? { type: "limited" as const, resetAt: "1970-01-01T00:05:00.000Z" }
                    : status === "unavailable"
                      ? { type: "unavailable" as const }
                      : { type: "available" as const },
                ),
              ),
            ),
          ),
        );
      }),
  );

  it.effect("rejects stale configuration and invalid retry times", () =>
    Effect.gen(function* () {
      const engine = yield* record();
      yield* engine
        .dispatch({
          type: "thread.limit-recovery.set",
          commandId: CommandId.make("past"),
          threadId,
          requestId: CommandId.make("recovery"),
          resumeAt: "1969-12-31T00:00:00.000Z",
        })
        .pipe(Effect.flip);
      yield* engine
        .dispatch({
          type: "thread.limit-recovery.set",
          commandId: CommandId.make("invalid"),
          threadId,
          requestId: CommandId.make("recovery"),
          resumeAt: "invalid",
        })
        .pipe(Effect.flip);
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("new-provider"),
        threadId,
        modelSelection: { instanceId: ProviderInstanceId.make("other"), model: "other" },
      });
      yield* engine
        .dispatch({
          type: "thread.limit-recovery.record",
          commandId: CommandId.make("stale-record"),
          threadId,
          turnId,
          modelSelection: selection,
          limit: { resetAt: "1970-01-01T00:03:00.000Z" },
          autoResume: true,
          createdAt: now,
        })
        .pipe(Effect.flip);
      const snapshots = yield* ProjectionSnapshotQuery;
      expect((yield* snapshots.getSnapshot()).threads[0]?.limitRecovery).toBeNull();
    }).pipe(Effect.provide(layer)),
  );
  it.effect.each(["archive", "settle", "message", "provider-change", "stop", "interrupt"] as const)(
    "cancels recovery after %s",
    (action) =>
      Effect.gen(function* () {
        const engine = yield* record();
        if (action === "stop")
          yield* engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make(action),
            threadId,
            createdAt: now,
          });
        if (action === "interrupt")
          yield* engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make(action),
            threadId,
            createdAt: now,
          });
        if (action === "archive")
          yield* engine.dispatch({
            type: "thread.archive",
            commandId: CommandId.make(action),
            threadId,
          });
        if (action === "settle")
          yield* engine.dispatch({
            type: "thread.settle",
            commandId: CommandId.make(action),
            threadId,
          });
        if (action === "provider-change")
          yield* engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(action),
            threadId,
            modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
          });
        if (action === "message")
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(action),
            threadId,
            message: {
              messageId: MessageId.make(action),
              role: "user",
              text: "New work",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          });
        yield* TestClock.adjust("1 day");
        const sweep = yield* make;
        yield* sweep();
        const snapshots = yield* ProjectionSnapshotQuery;
        const thread = (yield* snapshots.getSnapshot()).threads[0]!;
        if (action === "stop" || action === "interrupt")
          expect(thread.limitRecovery?.resumeAt).toBeNull();
        else expect(thread.limitRecovery).toBeNull();
        expect(thread.messages).toHaveLength(action === "message" ? 2 : 1);
      }).pipe(Effect.provide(layer)),
  );
});
