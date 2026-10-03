import * as Schema from "effect/Schema";
import { CommandId, IsoDateTime, ThreadId } from "./baseSchemas.ts";

export const MAX_LIMIT_RECOVERY_ATTEMPTS = 3;

export const ProviderUsageLimit = Schema.Struct({
  resetAt: Schema.NullOr(IsoDateTime),
});
export type ProviderUsageLimit = typeof ProviderUsageLimit.Type;

export const ThreadLimitRecoverySetCommand = Schema.Struct({
  type: Schema.Literal("thread.limit-recovery.set"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CommandId,
  resumeAt: Schema.NullOr(IsoDateTime),
});
