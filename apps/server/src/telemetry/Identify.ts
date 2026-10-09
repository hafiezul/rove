import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

class TelemetryIdentityReadError extends Schema.TaggedError<TelemetryIdentityReadError>()(
  "TelemetryIdentityReadError",
  {
    source: Schema.Literal("anonymous"),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read ${this.source} telemetry identity at '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdGenerationError extends Schema.TaggedError<TelemetryAnonymousIdGenerationError>()(
  "TelemetryAnonymousIdGenerationError",
  {
    source: Schema.Literal("anonymous"),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to generate anonymous telemetry identity for '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdPersistenceError extends Schema.TaggedError<TelemetryAnonymousIdPersistenceError>()(
  "TelemetryAnonymousIdPersistenceError",
  {
    source: Schema.Literal("anonymous"),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist anonymous telemetry identity at '${this.filePath}'.`;
  }
}

export class TelemetryIdentityHashError extends Schema.TaggedError<TelemetryIdentityHashError>()(
  "TelemetryIdentityHashError",
  {
    source: Schema.Literal("anonymous"),
    algorithm: Schema.Literal("SHA-256"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to hash ${this.source} telemetry identity with ${this.algorithm}.`;
  }
}

type TelemetryIdentityError =
  | TelemetryIdentityReadError
  | TelemetryAnonymousIdGenerationError
  | TelemetryAnonymousIdPersistenceError
  | TelemetryIdentityHashError;

function isNotFoundError(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "NotFound";
}

const getTelemetryIdentityCauseAnnotations = (cause: unknown) => {
  if (cause instanceof PlatformError.PlatformError) {
    return {
      causeKind: "platform",
      platformReason: cause.reason._tag,
    };
  }
  return { causeKind: "other" };
};

const logTelemetryIdentityError = (error: TelemetryIdentityError) =>
  Effect.logWarning(error.message).pipe(
    Effect.annotateLogs({
      errorTag: error._tag,
      source: error.source,
      ...("filePath" in error ? { filePath: error.filePath } : undefined),
      ...getTelemetryIdentityCauseAnnotations(error.cause),
      ...(error.stack === undefined ? undefined : { errorStack: error.stack }),
    }),
  );

const readIdentityFile = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.readFileString(filePath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        isNotFoundError(cause)
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(
              new TelemetryIdentityReadError({
                source: "anonymous",
                filePath,
                cause,
              }),
            ),
    }),
  );

const hash = (value: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.digest("SHA-256", new TextEncoder().encode(value))),
    Effect.map(Encoding.encodeHex),
    Effect.mapError(
      (cause) =>
        new TelemetryIdentityHashError({
          source: "anonymous",
          algorithm: "SHA-256",
          cause,
        }),
    ),
  );

const upsertAnonymousId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { anonymousIdPath } = yield* ServerConfig.ServerConfig;

  const existing = yield* readIdentityFile(fileSystem, anonymousIdPath);
  if (Option.isSome(existing)) {
    return existing.value;
  }

  const anonymousId = yield* Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.mapError(
      (cause) =>
        new TelemetryAnonymousIdGenerationError({
          source: "anonymous",
          filePath: anonymousIdPath,
          cause,
        }),
    ),
  );
  yield* fileSystem.writeFileString(anonymousIdPath, anonymousId).pipe(
    Effect.mapError(
      (cause) =>
        new TelemetryAnonymousIdPersistenceError({
          source: "anonymous",
          filePath: anonymousIdPath,
          cause,
        }),
    ),
  );

  return anonymousId;
});

/** Hash a random installation-scoped ID, never a provider account or credential. */
export const getTelemetryIdentifier = upsertAnonymousId.pipe(
  Effect.flatMap(hash),
  Effect.tapError(logTelemetryIdentityError),
  Effect.orElseSucceed(() => null),
);
