import type { ThreadId } from "@t3tools/contracts";
import * as RuntimePredicate from "effect/Predicate";
import type { Json as SchemaJson } from "effect/Schema";

/**
 * Opaque, exclusive cursor for windowed thread detail reads. Encodes the thread
 * id and the keyset boundary of an already-delivered page: the boundary turn's
 * anchor timestamp (`COALESCE(requested_at, started_at, '')`) and turn id.
 * Passing it back requests the adjacent disjoint slice of strictly older turns
 * under `(anchor, turn_id)` ordering.
 *
 * The boundary is deliberately NOT a `projection_turns.row_id`: row ids are
 * rewritten by the revert projector (delete + re-upsert) and by projection
 * rebuilds, which would silently invalidate every persisted cursor with no
 * event emitted. The (anchor, turnId) pair is derived from event content, so
 * cursors survive both and no client-side refresh machinery is needed. The
 * anchor doubles as the time bound for rows with no turn linkage (straggler
 * user messages, turnless activities). The thread id is embedded so a cursor
 * can never be replayed against a different thread. Clients must treat the
 * string as opaque.
 */
export interface ThreadDetailPageCursor {
  readonly threadId: ThreadId;
  readonly beforeAnchorAt: string;
  /** Boundary turn id; "" for the rare turn row with a null turn_id. */
  readonly beforeTurnId: string;
}

export function encodeThreadDetailPageCursor(cursor: ThreadDetailPageCursor): string {
  return Buffer.from(
    JSON.stringify({ t: cursor.threadId, a: cursor.beforeAnchorAt, i: cursor.beforeTurnId }),
  ).toString("base64url");
}

/**
 * Returns null for anything that is not a well-formed cursor. Callers degrade
 * a malformed or foreign-thread cursor to a first-page request.
 */
export function decodeThreadDetailPageCursor(encoded: string): ThreadDetailPageCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!RuntimePredicate.isObjectOrArray(parsed)) {
    return null;
  }
  const // SAFETY: The surrounding adapter has established this JSON-object view before field access.
    record = parsed as Record<string, SchemaJson>;
  if (!RuntimePredicate.isString(record.t) || record.t.length === 0) {
    return null;
  }
  // Empty strings are valid boundary values, not malformed input: the anchor
  // is COALESCE(requested_at, started_at, ''), so a boundary turn with no
  // timestamps encodes a: "" (and sorts before every real anchor, correctly
  // ending the walk); the turn key is "" for a null turn_id.
  if (!RuntimePredicate.isString(record.a)) {
    return null;
  }
  if (!RuntimePredicate.isString(record.i)) {
    return null;
  }
  // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
  return { threadId: record.t as ThreadId, beforeAnchorAt: record.a, beforeTurnId: record.i };
}
