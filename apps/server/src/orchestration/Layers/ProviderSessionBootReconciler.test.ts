// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ProviderSessionBootReconcilerService } from "../Services/ProviderSessionBootReconciler.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import {
  ProviderSessionBootReconcilerLive,
  RESTART_INTERRUPTED_ACTIVITY_KIND,
} from "./ProviderSessionBootReconciler.ts";

const projectIdFor = (threadId: ThreadId) => ProjectId.make(`project-${threadId}`);
const ACTIVE_TURN_ID = TurnId.make("turn-interrupted-by-restart");
const CODEX = ProviderDriverKind.make("codex");
const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const SEEDED_AT = "2026-01-01T00:00:00.000Z";
const MODEL_SELECTION = { instanceId: CODEX_INSTANCE, model: "gpt-5-codex" } as const;

const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

const providerServiceStub: ProviderServiceShape = {
  startSession: () => unsupported(),
  sendTurn: () => unsupported(),
  interruptTurn: () => unsupported(),
  respondToRequest: () => unsupported(),
  respondToUserInput: () => unsupported(),
  stopSession: () => unsupported(),
  listSessions: () => Effect.succeed([]),
  getCapabilities: () =>
    Effect.succeed({ sessionModelSwitch: "in-session", conversationRollback: "supported" }),
  getInstanceInfo: (instanceId) =>
    Effect.succeed({
      instanceId,
      driverKind: CODEX,
      displayName: undefined,
      enabled: true,
      continuationIdentity: {
        driverKind: CODEX,
        continuationKey: `codex:instance:${instanceId}`,
      },
    }),
  canRollbackConversation: () => Effect.succeed(true),
  rollbackConversation: () => unsupported(),
  // The reconciler never reads live provider output; the seed drives the
  // ingestion worker directly.
  streamEvents: Stream.empty,
};

const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
const orchestrationLayer = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
);

const testLayer = it.layer(
  ProviderSessionBootReconcilerLive.pipe(
    Layer.provideMerge(ProviderRuntimeIngestionLive),
    Layer.provideMerge(directoryLayer),
    Layer.provideMerge(runtimeRepositoryLayer),
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(
      OrchestrationProjectionSnapshotQueryLive.pipe(
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
      ),
    ),
    Layer.provideMerge(ProjectionTurnRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory))),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(Layer.succeed(ProviderService, providerServiceStub)),
    Layer.provideMerge(ServerSettingsService.layerTest({})),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

/**
 * Rebuilds the state a killed server leaves behind: a thread whose projected
 * session and persisted runtime row both still claim a turn is running, with
 * no provider process behind either.
 */
const seedInterruptedSession = Effect.fn("seedInterruptedSession")(function* (input: {
  readonly threadId: ThreadId;
  readonly activeTurnId?: TurnId | null;
}) {
  const threadId = input.threadId;
  const activeTurnId = input.activeTurnId === undefined ? ACTIVE_TURN_ID : input.activeTurnId;
  const engine = yield* OrchestrationEngineService;
  const directory = yield* ProviderSessionDirectory;
  const ingestion = yield* ProviderRuntimeIngestionService;

  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-project-create-${threadId}`),
    projectId: projectIdFor(threadId),
    title: "Project",
    workspaceRoot: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-boot-reconcile-")),
    defaultModelSelection: MODEL_SELECTION,
    createdAt: SEEDED_AT,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`cmd-thread-create-${threadId}`),
    threadId: threadId,
    projectId: projectIdFor(threadId),
    title: "Thread",
    modelSelection: MODEL_SELECTION,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: null,
    createdAt: SEEDED_AT,
  });

  if (activeTurnId === null) {
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`cmd-session-seed-${threadId}`),
      threadId,
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        providerInstanceId: CODEX_INSTANCE,
        runtimeMode: "approval-required",
        activeTurnId: null,
        updatedAt: SEEDED_AT,
        lastError: null,
      },
      createdAt: SEEDED_AT,
    });
  } else {
    // Drive the running turn through the real ingestion path so the turn
    // projection matches what a killed server would have left behind.
    yield* ingestion.ingestSynthetic({
      type: "turn.started",
      eventId: EventId.make(`evt-seed-turn-started-${threadId}`),
      provider: CODEX,
      providerInstanceId: CODEX_INSTANCE,
      threadId,
      turnId: activeTurnId,
      createdAt: SEEDED_AT,
      payload: {},
    });
    yield* ingestion.drain;
  }

  yield* directory.upsert({
    threadId,
    provider: CODEX,
    providerInstanceId: CODEX_INSTANCE,
    adapterKey: "codex",
    runtimeMode: "approval-required",
    status: "running",
    resumeCursor: { opaque: "resume-before-restart" },
  });
});

const reconcile = Effect.gen(function* () {
  const reconciler = yield* ProviderSessionBootReconcilerService;
  yield* reconciler.reconcile();
});

const getThreadShell = Effect.fn("getThreadShell")(function* (threadId: ThreadId) {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const shell = yield* snapshotQuery.getThreadShellById(threadId);
  return Option.getOrUndefined(shell);
});

const getThread = Effect.fn("getThread")(function* (threadId: ThreadId) {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const snapshot = yield* snapshotQuery.getSnapshot();
  return snapshot.threads.find((entry) => entry.id === threadId);
});

testLayer("ProviderSessionBootReconciler", (it) => {
  it.effect("interrupts a turn left running by a killed server", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-interrupted");
      yield* seedInterruptedSession({ threadId });

      yield* reconcile;

      const thread = yield* getThread(threadId);
      assert.equal(thread?.session?.status, "stopped");
      assert.equal(thread?.session?.activeTurnId, null);

      const turnRepository = yield* ProjectionTurnRepository;
      const turns = yield* turnRepository.listByThreadId({ threadId });
      assert.equal(turns.find((turn) => turn.turnId === ACTIVE_TURN_ID)?.state, "interrupted");
    }),
  );

  it.effect("records why the turn ended so the thread can be resumed", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-restart-notice");
      yield* seedInterruptedSession({ threadId });

      yield* reconcile;

      const thread = yield* getThread(threadId);
      const restartActivity = thread?.activities.find(
        (activity) => activity.kind === RESTART_INTERRUPTED_ACTIVITY_KIND,
      );
      assert.notEqual(restartActivity, undefined);
      assert.equal(restartActivity?.turnId, ACTIVE_TURN_ID);
    }),
  );

  it.effect("stops sessions with no active turn so they are not treated as live", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-no-active-turn");
      yield* seedInterruptedSession({ threadId, activeTurnId: null });

      yield* reconcile;

      const thread = yield* getThread(threadId);
      assert.equal(thread?.session?.status, "stopped");
      assert.equal(
        thread?.activities.some((activity) => activity.kind === RESTART_INTERRUPTED_ACTIVITY_KIND),
        false,
      );
    }),
  );

  it.effect("retires user-input prompts left open by a killed server", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-open-user-input");
      yield* seedInterruptedSession({ threadId });

      const ingestion = yield* ProviderRuntimeIngestionService;
      yield* ingestion.ingestSynthetic({
        type: "user-input.requested",
        eventId: EventId.make(`evt-seed-user-input-${threadId}`),
        provider: CODEX,
        providerInstanceId: CODEX_INSTANCE,
        threadId,
        turnId: ACTIVE_TURN_ID,
        requestId: RuntimeRequestId.make("dialog-open-at-restart"),
        createdAt: SEEDED_AT,
        payload: {
          questions: [
            {
              id: "dialog-open-at-restart",
              header: "Choose",
              question: "Which environment?",
              options: [{ label: "Staging", description: "Staging" }],
              multiSelect: false,
            },
          ],
        },
      });
      yield* ingestion.drain;

      const beforeShell = yield* getThreadShell(threadId);
      assert.equal(beforeShell?.hasPendingUserInput, true);

      // The reconciler stamps its repair from the Effect clock, which
      // `it.effect` pins to the epoch. Advance past the seeded prompt so
      // replay order matches production, where the repair always follows
      // the prompt it retires.
      yield* TestClock.setTime(Date.parse(SEEDED_AT) + 1000);

      yield* reconcile;

      const shell = yield* getThreadShell(threadId);
      assert.equal(shell?.hasPendingUserInput, false);
    }),
  );

  it.effect("retires approval prompts left open by a killed server", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-open-approval");
      yield* seedInterruptedSession({ threadId });

      const ingestion = yield* ProviderRuntimeIngestionService;
      yield* ingestion.ingestSynthetic({
        type: "request.opened",
        eventId: EventId.make(`evt-seed-approval-${threadId}`),
        provider: CODEX,
        providerInstanceId: CODEX_INSTANCE,
        threadId,
        turnId: ACTIVE_TURN_ID,
        requestId: RuntimeRequestId.make("approval-open-at-restart"),
        createdAt: SEEDED_AT,
        payload: { requestType: "exec_command_approval" },
      });
      yield* ingestion.drain;

      const beforeShell = yield* getThreadShell(threadId);
      assert.equal(beforeShell?.hasPendingApprovals, true);

      yield* TestClock.setTime(Date.parse(SEEDED_AT) + 1000);

      yield* reconcile;

      const shell = yield* getThreadShell(threadId);
      assert.equal(shell?.hasPendingApprovals, false);
    }),
  );

  it.effect("leaves prompts answered before the restart untouched", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-answered-prompt");
      yield* seedInterruptedSession({ threadId });

      const ingestion = yield* ProviderRuntimeIngestionService;
      yield* ingestion.ingestSynthetic({
        type: "user-input.requested",
        eventId: EventId.make(`evt-seed-answered-request-${threadId}`),
        provider: CODEX,
        providerInstanceId: CODEX_INSTANCE,
        threadId,
        turnId: ACTIVE_TURN_ID,
        requestId: RuntimeRequestId.make("dialog-already-answered"),
        createdAt: SEEDED_AT,
        payload: {
          questions: [
            {
              id: "dialog-already-answered",
              header: "Choose",
              question: "Which environment?",
              options: [{ label: "Staging", description: "Staging" }],
              multiSelect: false,
            },
          ],
        },
      });
      yield* ingestion.ingestSynthetic({
        type: "user-input.resolved",
        eventId: EventId.make(`evt-seed-answered-resolved-${threadId}`),
        provider: CODEX,
        providerInstanceId: CODEX_INSTANCE,
        threadId,
        turnId: ACTIVE_TURN_ID,
        requestId: RuntimeRequestId.make("dialog-already-answered"),
        createdAt: SEEDED_AT,
        payload: { answers: { "dialog-already-answered": "Staging" } },
      });
      yield* ingestion.drain;

      yield* TestClock.setTime(Date.parse(SEEDED_AT) + 1000);

      yield* reconcile;

      const thread = yield* getThread(threadId);
      assert.equal(
        thread?.activities.some(
          (activity) => activity.kind === "provider.user-input.respond.failed",
        ),
        false,
      );
    }),
  );

  it.effect("marks reconciled runtime bindings stopped so they are not swept again", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-binding-stopped");
      yield* seedInterruptedSession({ threadId });

      yield* reconcile;

      const directory = yield* ProviderSessionDirectory;
      const bindings = yield* directory.listBindings();
      assert.equal(bindings.find((binding) => binding.threadId === threadId)?.status, "stopped");
    }),
  );
});
