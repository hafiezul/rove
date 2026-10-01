import * as Schema from "effect/Schema";

/** Cua Driver's own macOS grants, read from its daemon; `null` when the daemon did not answer. */
export const ComputerUsePermissions = Schema.Struct({
  accessibility: Schema.Boolean,
  screenRecording: Schema.Boolean,
});
export type ComputerUsePermissions = typeof ComputerUsePermissions.Type;

/** Cua's own usage-data preference; `null` when it could not be read. */
const Telemetry = Schema.NullOr(Schema.Boolean);

/** Cua Driver on the environment's host, from absent to ready. */
export const ComputerUseStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unsupported"), platform: Schema.String }),
  Schema.Struct({ status: Schema.Literal("not-installed") }),
  /** An app is installed where Cua belongs, but Cua AI, Inc. did not sign it. Rove will not run it. */
  Schema.Struct({ status: Schema.Literal("untrusted") }),
  Schema.Struct({
    status: Schema.Literal("stopped"),
    version: Schema.String,
    telemetry: Telemetry,
  }),
  Schema.Struct({
    status: Schema.Literal("running"),
    version: Schema.String,
    telemetry: Telemetry,
    permissions: Schema.NullOr(ComputerUsePermissions),
  }),
]);
export type ComputerUseStatus = typeof ComputerUseStatus.Type;

export const ComputerUseControlInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("install") }),
  Schema.Struct({ action: Schema.Literal("start") }),
  Schema.Struct({ action: Schema.Literal("grant-permissions") }),
  Schema.Struct({ action: Schema.Literal("set-telemetry"), enabled: Schema.Boolean }),
]);
export type ComputerUseControlInput = typeof ComputerUseControlInput.Type;

export const ComputerUseAction = Schema.Literals([
  "install",
  "start",
  "grant-permissions",
  "set-telemetry",
]);
export type ComputerUseAction = typeof ComputerUseAction.Type;

export class ComputerUseControlError extends Schema.TaggedError<ComputerUseControlError>()(
  "ComputerUseControlError",
  { action: ComputerUseAction, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
