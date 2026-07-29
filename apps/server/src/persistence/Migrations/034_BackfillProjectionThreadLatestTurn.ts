/**
 * Recovers `projection_threads.latest_turn_id` for threads that lost it.
 *
 * The thread projection used to clear the pointer whenever a session settled,
 * and only `thread.turn-diff-completed` — a Git-only checkpoint event — put it
 * back. Threads in plain folders were therefore left pointing at no turn, which
 * hid their completed turn from the shell and from everything derived from it.
 * The projection now preserves the pointer; this repairs the rows written
 * before it did.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Pending turn-start rows carry a NULL turn_id and are not addressable, so
  // only concrete turns are eligible. Threads with none keep their NULL pointer.
  yield* sql`
    UPDATE projection_threads
    SET latest_turn_id = (
      SELECT turns.turn_id
      FROM projection_turns AS turns
      WHERE turns.thread_id = projection_threads.thread_id
        AND turns.turn_id IS NOT NULL
      ORDER BY turns.requested_at DESC, turns.row_id DESC
      LIMIT 1
    )
    WHERE latest_turn_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM projection_turns AS turns
        WHERE turns.thread_id = projection_threads.thread_id
          AND turns.turn_id IS NOT NULL
      )
  `;

  // has_actionable_proposed_plan is derived from latest_turn_id, so a recovered
  // pointer can change it. Recomputing is a no-op for every thread the backfill
  // above left alone.
  yield* sql`
    UPDATE projection_threads
    SET has_actionable_proposed_plan = CASE
      WHEN projection_threads.latest_turn_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM projection_thread_proposed_plans AS latest_turn_plan_exists
          WHERE latest_turn_plan_exists.thread_id = projection_threads.thread_id
            AND latest_turn_plan_exists.turn_id = projection_threads.latest_turn_id
        )
        THEN CASE
          WHEN (
            SELECT latest_turn_plan.implemented_at
            FROM projection_thread_proposed_plans AS latest_turn_plan
            WHERE latest_turn_plan.thread_id = projection_threads.thread_id
              AND latest_turn_plan.turn_id = projection_threads.latest_turn_id
            ORDER BY latest_turn_plan.updated_at DESC, latest_turn_plan.plan_id DESC
            LIMIT 1
          ) IS NULL
            THEN 1
            ELSE 0
          END
      ELSE CASE
        WHEN (
          SELECT latest_plan.implemented_at
          FROM projection_thread_proposed_plans AS latest_plan
          WHERE latest_plan.thread_id = projection_threads.thread_id
          ORDER BY latest_plan.updated_at DESC, latest_plan.plan_id DESC
          LIMIT 1
        ) IS NULL
          THEN 1
          ELSE 0
        END
      END
    WHERE EXISTS (
      SELECT 1
      FROM projection_thread_proposed_plans AS any_plan
      WHERE any_plan.thread_id = projection_threads.thread_id
    )
  `;
});
