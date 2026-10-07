import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (columns.some((column) => column.name === "workspace_path")) return;
  const [table] = yield* sql<{ readonly sql: string }>`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projection_threads'
  `;
  const indexes = yield* sql<{ readonly sql: string }>`
    SELECT sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'projection_threads' AND sql IS NOT NULL
  `;
  if (table === undefined) return;

  yield* sql.unsafe(
    table.sql
      .replace(/\bprojection_threads\b/, "projection_threads_standalone")
      .replace(/project_id TEXT NOT NULL/i, "project_id TEXT"),
  );
  yield* sql`INSERT INTO projection_threads_standalone SELECT * FROM projection_threads`;
  yield* sql`DROP TABLE projection_threads`;
  yield* sql`ALTER TABLE projection_threads_standalone RENAME TO projection_threads`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN workspace_path TEXT`;
  for (const index of indexes) {
    yield* sql.unsafe(index.sql);
  }
});
