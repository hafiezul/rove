import * as Schema from "effect/Schema";

/** Cua Driver's own macOS grants, read from its daemon; `null` when the daemon did not answer. */
export const ComputerUsePermissions = Schema.Struct({
  accessibility: Schema.Boolean,
  screenRecording: Schema.Boolean,
});
export type ComputerUsePermissions = typeof ComputerUsePermissions.Type;

/** Cua Driver on the environment's host, from absent to ready. */
export const ComputerUseStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unsupported"), platform: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("not-installed"),
    installCommand: Schema.String,
    docsUrl: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("stopped"), version: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("running"),
    version: Schema.String,
    permissions: Schema.NullOr(ComputerUsePermissions),
  }),
]);
export type ComputerUseStatus = typeof ComputerUseStatus.Type;

export const ComputerUseAction = Schema.Literals(["start", "grant-permissions", "stop"]);
export type ComputerUseAction = typeof ComputerUseAction.Type;

export const ComputerUseControlInput = Schema.Struct({ action: ComputerUseAction });
export type ComputerUseControlInput = typeof ComputerUseControlInput.Type;

export class ComputerUseControlError extends Schema.TaggedError<ComputerUseControlError>()(
  "ComputerUseControlError",
  { action: ComputerUseAction, detail: Schema.String },
) {
  override get message(): string {
    return `Could not ${this.action.replace("-", " ")} Cua Driver: ${this.detail}`;
  }
}
