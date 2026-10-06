import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipeline } from "./Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

const testLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "rove-rewind-history-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(testLayer)("rewind history", (it) => {
  it.effect("preserves uncheckpointed history in persisted and replayed snapshots", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const store = yield* OrchestrationEventStore;
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("rewind-thread");
      const projectId = ProjectId.make("rewind-project");
      const createdAt = "2026-04-01T00:00:00.000Z";
      let model = createEmptyReadModel(createdAt);
      let sequence = 0;
      const append = Effect.fnUntraced(function* (event: Parameters<typeof store.append>[0]) {
        const persisted = yield* store.append(event);
        yield* pipeline.projectEvent(persisted);
        model = yield* projectEvent(model, persisted);
      });
      const fields = () => ({
        eventId: EventId.make(`rewind-event-${++sequence}`),
        aggregateKind: "thread" as const,
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.make(`rewind-command-${sequence}`),
        causationEventId: null,
        correlationId: null,
        metadata: {},
      });
      yield* append({
        ...fields(),
        type: "project.created",
        aggregateKind: "project",
        aggregateId: projectId,
        payload: {
          projectId,
          title: "Rewind",
          workspaceRoot: process.cwd(),
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* append({
        ...fields(),
        type: "thread.created",
        payload: {
          threadId,
          projectId,
          title: "Rewind",
          modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "test-model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });
      const messages = [
        { id: "interrupted-user", role: "user", turnId: null },
        { id: "interrupted-answer", role: "assistant", turnId: "interrupted-turn" },
        { id: "kept-user", role: "user", turnId: null },
        { id: "steering-user", role: "user", turnId: null },
        { id: "kept-answer", role: "assistant", turnId: "kept-turn" },
        { id: "uncheckpointed-user", role: "user", turnId: null },
        { id: "selected-user", role: "user", turnId: null },
        { id: "removed-answer", role: "assistant", turnId: "removed-turn" },
      ] as const;
      const turnsByPrompt = new Map<string, string>([
        ["interrupted-user", "interrupted-turn"],
        ["kept-user", "kept-turn"],
        ["selected-user", "removed-turn"],
      ]);
      for (const [index, message] of messages.entries()) {
        const at = `2026-04-01T01:00:0${index}.000Z`;
        yield* append({
          ...fields(),
          type: "thread.message-sent",
          occurredAt: at,
          payload: {
            threadId,
            messageId: MessageId.make(message.id),
            role: message.role,
            text: message.id,
            turnId: message.turnId === null ? null : TurnId.make(message.turnId),
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        });
        const startedTurnId = turnsByPrompt.get(message.id);
        if (startedTurnId !== undefined) {
          yield* append({
            ...fields(),
            type: "thread.turn-start-requested",
            occurredAt: at,
            payload: {
              threadId,
              messageId: MessageId.make(message.id),
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: at,
            },
          });
          yield* append({
            ...fields(),
            type: "thread.session-set",
            occurredAt: at,
            payload: {
              threadId,
              session: {
                threadId,
                status: "running",
                providerName: "pi",
                runtimeMode: "full-access",
                activeTurnId: TurnId.make(startedTurnId),
                lastError: null,
                updatedAt: at,
              },
            },
          });
        }
      }
      for (const [turnId, assistantId, count, at] of [
        ["kept-turn", "kept-answer", 1, "2026-04-01T01:00:04.000Z"],
        ["removed-turn", "removed-answer", 2, "2026-04-01T01:00:07.000Z"],
      ] as const) {
        yield* append({
          ...fields(),
          type: "thread.turn-diff-completed",
          occurredAt: at,
          payload: {
            threadId,
            turnId: TurnId.make(turnId),
            checkpointTurnCount: count,
            checkpointRef: CheckpointRef.make(`ref-${count}`),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make(assistantId),
            completedAt: at,
          },
        });
      }
      yield* append({
        ...fields(),
        type: "thread.activity-appended",
        payload: {
          threadId,
          activity: {
            id: EventId.make("interrupted-work"),
            turnId: TurnId.make("interrupted-turn"),
            tone: "info",
            kind: "tool.completed",
            summary: "Earlier work",
            payload: {},
            createdAt: "2026-04-01T01:00:01.000Z",
          },
        },
      });
      yield* append({
        ...fields(),
        type: "thread.reverted",
        payload: {
          threadId,
          turnCount: 1,
          messageBoundary: {
            messageId: MessageId.make("selected-user"),
            createdAt: "2026-04-01T01:00:06.000Z",
          },
        },
      });
      const persisted = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
      const replayed = model.threads.find((thread) => thread.id === threadId);
      const expected = messages.slice(0, 6).map((message) => MessageId.make(message.id));
      assert.deepEqual(
        persisted.messages.map((message) => message.id),
        expected,
      );
      assert.deepEqual(
        replayed?.messages.map((message) => message.id),
        expected,
      );
      assert.deepEqual(
        persisted.activities.map((activity) => activity.id),
        ["interrupted-work"],
      );
      assert.deepEqual(
        replayed?.activities.map((activity) => activity.id),
        ["interrupted-work"],
      );
      const recent = Option.getOrThrow(
        yield* query.getThreadDetailSnapshot(threadId, { turnLimit: 1 }),
      );
      assert.isTrue(recent.page?.hasMore);
      const beforeCursor = recent.page?.beforeCursor;
      assert.isString(beforeCursor);
      if (beforeCursor === undefined || beforeCursor === null)
        throw new Error("Older history cursor is missing.");
      const older = Option.getOrThrow(
        yield* query.getThreadDetailSnapshot(threadId, { turnLimit: 1, beforeCursor }),
      );
      assert.deepEqual(
        [...older.thread.messages, ...recent.thread.messages].map((message) => message.id),
        expected,
      );
      const turns = yield* sql<{
        turnId: string;
      }>`SELECT turn_id AS "turnId" FROM projection_turns WHERE thread_id = ${threadId} ORDER BY turn_id`;
      assert.deepEqual(
        turns.map((turn) => turn.turnId),
        ["interrupted-turn", "kept-turn"],
      );
    }),
  );
});
