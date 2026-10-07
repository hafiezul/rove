import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@rove-code/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./056_StandaloneThreads.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("056_StandaloneThreads", (it) => {
  it.effect("preserves existing threads and indexes while allowing standalone ownership", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      const indexes =
        yield* sql`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'projection_threads' ORDER BY name`;
      const now = "2026-01-01T00:00:00.000Z";
      yield* sql`INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at, pinned_at
      ) VALUES ('existing', 'project-1', 'Existing thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}, ${now})`;
      const before = yield* sql`SELECT * FROM projection_threads`;
      yield* runMigrations({ toMigrationInclusive: 56 });
      assert.deepEqual(
        yield* sql`SELECT * FROM projection_threads`,
        before.map((row) => ({ ...row, workspace_path: null })),
      );
      assert.deepEqual(
        yield* sql`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'projection_threads' ORDER BY name`,
        indexes,
      );
      yield* sql`INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at, workspace_path
      ) VALUES ('standalone', NULL, 'Standalone thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}, '/rove/workspaces/standalone')`;
      yield* migration;
      const [standalone] =
        yield* sql`SELECT project_id, workspace_path FROM projection_threads WHERE thread_id = 'standalone'`;
      assert.deepEqual(standalone, {
        project_id: null,
        workspace_path: "/rove/workspaces/standalone",
      });
      assert.deepEqual(yield* sql`SELECT * FROM projection_projects`, []);
    }),
  );
});
