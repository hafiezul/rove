import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const insertThread = (input: {
  readonly threadId: string;
  readonly latestTurnId: string | null;
  readonly hasActionableProposedPlan: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id,
        project_id,
        title,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        branch,
        worktree_path,
        latest_turn_id,
        created_at,
        updated_at,
        archived_at,
        pinned_at,
        latest_user_message_at,
        pending_approval_count,
        pending_user_input_count,
        has_actionable_proposed_plan,
        deleted_at
      )
      VALUES (
        ${input.threadId},
        'project-1',
        ${input.threadId},
        '{"instanceId":"codex","model":"gpt-5-codex"}',
        'full-access',
        'default',
        NULL,
        NULL,
        ${input.latestTurnId},
        '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z',
        NULL,
        NULL,
        NULL,
        0,
        0,
        ${input.hasActionableProposedPlan},
        NULL
      )
    `;
  });

const insertTurn = (input: {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly state: string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_turns (
        thread_id,
        turn_id,
        pending_message_id,
        source_proposed_plan_thread_id,
        source_proposed_plan_id,
        assistant_message_id,
        state,
        requested_at,
        started_at,
        completed_at,
        checkpoint_turn_count,
        checkpoint_ref,
        checkpoint_status,
        checkpoint_files_json
      )
      VALUES (
        ${input.threadId},
        ${input.turnId},
        NULL,
        NULL,
        NULL,
        NULL,
        ${input.state},
        ${input.requestedAt},
        ${input.requestedAt},
        ${input.completedAt},
        NULL,
        NULL,
        NULL,
        '[]'
      )
    `;
  });

layer("034_BackfillProjectionThreadLatestTurn", (it) => {
  it.effect("recovers latest turn pointers lost when sessions settled uncheckpointed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });

      // Lost its pointer when the session settled without a Git checkpoint.
      yield* insertThread({
        threadId: "thread-orphaned",
        latestTurnId: null,
        hasActionableProposedPlan: 0,
      });
      yield* insertTurn({
        threadId: "thread-orphaned",
        turnId: "turn-orphaned-old",
        state: "completed",
        requestedAt: "2026-07-01T00:01:00.000Z",
        completedAt: "2026-07-01T00:01:30.000Z",
      });
      yield* insertTurn({
        threadId: "thread-orphaned",
        turnId: "turn-orphaned-new",
        state: "completed",
        requestedAt: "2026-07-01T00:05:00.000Z",
        completedAt: "2026-07-01T00:05:30.000Z",
      });

      // Already points somewhere — a later turn must not steal the pointer.
      yield* insertThread({
        threadId: "thread-pointed",
        latestTurnId: "turn-pointed-kept",
        hasActionableProposedPlan: 0,
      });
      yield* insertTurn({
        threadId: "thread-pointed",
        turnId: "turn-pointed-kept",
        state: "completed",
        requestedAt: "2026-07-01T00:01:00.000Z",
        completedAt: "2026-07-01T00:01:30.000Z",
      });
      yield* insertTurn({
        threadId: "thread-pointed",
        turnId: "turn-pointed-later",
        state: "completed",
        requestedAt: "2026-07-01T00:09:00.000Z",
        completedAt: "2026-07-01T00:09:30.000Z",
      });

      // Only a pending turn-start row, which carries no addressable turn id.
      yield* insertThread({
        threadId: "thread-pending-only",
        latestTurnId: null,
        hasActionableProposedPlan: 0,
      });
      yield* insertTurn({
        threadId: "thread-pending-only",
        turnId: null,
        state: "pending",
        requestedAt: "2026-07-01T00:02:00.000Z",
        completedAt: null,
      });

      yield* insertThread({
        threadId: "thread-no-turns",
        latestTurnId: null,
        hasActionableProposedPlan: 0,
      });

      // A turn that never completed is still the thread's latest one — turns are
      // ordered by when they were requested, so a later running turn beats an
      // earlier turn that happens to carry a newer completion timestamp.
      yield* insertThread({
        threadId: "thread-running",
        latestTurnId: null,
        hasActionableProposedPlan: 0,
      });
      yield* insertTurn({
        threadId: "thread-running",
        turnId: "turn-running-earlier-completed",
        state: "completed",
        requestedAt: "2026-07-01T00:01:00.000Z",
        completedAt: "2026-07-01T00:10:00.000Z",
      });
      yield* insertTurn({
        threadId: "thread-running",
        turnId: "turn-running",
        state: "running",
        requestedAt: "2026-07-01T00:04:00.000Z",
        completedAt: null,
      });

      // Identical timestamps: the most recently inserted row wins.
      yield* insertThread({
        threadId: "thread-tied",
        latestTurnId: null,
        hasActionableProposedPlan: 0,
      });
      yield* insertTurn({
        threadId: "thread-tied",
        turnId: "turn-tied-first",
        state: "completed",
        requestedAt: "2026-07-01T00:03:00.000Z",
        completedAt: "2026-07-01T00:03:30.000Z",
      });
      yield* insertTurn({
        threadId: "thread-tied",
        turnId: "turn-tied-second",
        state: "completed",
        requestedAt: "2026-07-01T00:03:00.000Z",
        completedAt: "2026-07-01T00:03:30.000Z",
      });

      yield* insertThread({
        threadId: "thread-plan",
        latestTurnId: null,
        hasActionableProposedPlan: 0,
      });
      yield* insertTurn({
        threadId: "thread-plan",
        turnId: "turn-plan-old",
        state: "completed",
        requestedAt: "2026-07-01T00:01:00.000Z",
        completedAt: "2026-07-01T00:01:30.000Z",
      });
      yield* insertTurn({
        threadId: "thread-plan",
        turnId: "turn-plan-latest",
        state: "completed",
        requestedAt: "2026-07-01T00:02:00.000Z",
        completedAt: "2026-07-01T00:02:30.000Z",
      });

      // Without a pointer the flag falls back to the newest plan overall, which
      // is implemented. The recovered pointer selects the latest turn's plan,
      // which is still actionable.
      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          created_at,
          updated_at,
          implemented_at,
          implementation_thread_id
        )
        VALUES
          (
            'plan-latest-turn',
            'thread-plan',
            'turn-plan-latest',
            '# Plan',
            '2026-07-01T00:02:10.000Z',
            '2026-07-01T00:02:10.000Z',
            NULL,
            NULL
          ),
          (
            'plan-old-turn',
            'thread-plan',
            'turn-plan-old',
            '# Older plan, edited later',
            '2026-07-01T00:01:10.000Z',
            '2026-07-01T00:03:00.000Z',
            '2026-07-01T00:03:00.000Z',
            'thread-implementation'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly latestTurnId: string | null;
        readonly hasActionableProposedPlan: number;
      }>`
        SELECT
          thread_id AS "threadId",
          latest_turn_id AS "latestTurnId",
          has_actionable_proposed_plan AS "hasActionableProposedPlan"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(rows, [
        { threadId: "thread-no-turns", latestTurnId: null, hasActionableProposedPlan: 0 },
        {
          threadId: "thread-orphaned",
          latestTurnId: "turn-orphaned-new",
          hasActionableProposedPlan: 0,
        },
        { threadId: "thread-pending-only", latestTurnId: null, hasActionableProposedPlan: 0 },
        { threadId: "thread-plan", latestTurnId: "turn-plan-latest", hasActionableProposedPlan: 1 },
        {
          threadId: "thread-pointed",
          latestTurnId: "turn-pointed-kept",
          hasActionableProposedPlan: 0,
        },
        { threadId: "thread-running", latestTurnId: "turn-running", hasActionableProposedPlan: 0 },
        { threadId: "thread-tied", latestTurnId: "turn-tied-second", hasActionableProposedPlan: 0 },
      ]);
    }),
  );
});
