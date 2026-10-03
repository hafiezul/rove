import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "limit_recovery_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN limit_recovery_json TEXT`;
  }
  yield* sql`CREATE INDEX IF NOT EXISTS projection_threads_limit_resume_at_idx
    ON projection_threads(json_extract(limit_recovery_json, '$.resumeAt'))
    WHERE deleted_at IS NULL AND archived_at IS NULL`;
});
