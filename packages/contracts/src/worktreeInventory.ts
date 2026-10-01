import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export class WorktreeInventoryError extends Schema.TaggedError<WorktreeInventoryError>()(
  "WorktreeInventoryError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

export const WorktreeInventoryInput = Schema.Struct({
  projectIds: Schema.optionalKey(Schema.Array(ProjectId)),
});
export type WorktreeInventoryInput = typeof WorktreeInventoryInput.Type;

export const WorktreeInventoryEntry = Schema.Struct({
  projectId: ProjectId,
  projectTitle: Schema.String,
  workspaceRoot: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  head: Schema.String,
  managed: Schema.Boolean,
  lastActivityAt: Schema.NullOr(IsoDateTime),
  threads: Schema.Array(
    Schema.Struct({
      id: ThreadId,
      title: Schema.String,
      archived: Schema.Boolean,
    }),
  ),
  removalBlockers: Schema.NullOr(Schema.Array(Schema.String)),
});
export type WorktreeInventoryEntry = typeof WorktreeInventoryEntry.Type;

export const WorktreeInventoryInspection = Schema.Struct({
  ...WorktreeInventoryEntry.fields,
  removalBlockers: Schema.Array(Schema.String),
});
export type WorktreeInventoryInspection = typeof WorktreeInventoryInspection.Type;

export const WorktreeInventoryResult = Schema.Struct({
  worktrees: Schema.Array(WorktreeInventoryEntry),
  issues: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      projectTitle: Schema.String,
      detail: Schema.String,
    }),
  ),
});

export const WorktreeInventoryTarget = Schema.Struct({
  projectId: ProjectId,
  path: TrimmedNonEmptyString,
});
export type WorktreeInventoryTarget = typeof WorktreeInventoryTarget.Type;

export const WorktreeInventoryRemoveInput = Schema.Struct({
  ...WorktreeInventoryTarget.fields,
  expectedHead: TrimmedNonEmptyString,
  expectedBranch: Schema.NullOr(TrimmedNonEmptyString),
});
export type WorktreeInventoryRemoveInput = typeof WorktreeInventoryRemoveInput.Type;

export const WorktreeInventorySize = Schema.Struct({ bytes: NonNegativeInt });
