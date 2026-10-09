import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import type { ReadonlyRecord } from "effect/Record";

import * as ServerConfig from "../config.ts";
import * as Identify from "./Identify.ts";

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: ReadonlyRecord<string, unknown>;
}

const sha256 = (value: string) =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

const makeCaptureLogger = (logs: CapturedLog[]) =>
  Logger.make(({ fiber, message }) => {
    logs.push({
      message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });

const findIdentityLog = (logs: ReadonlyArray<CapturedLog>, errorTag: string) =>
  logs.find(
    (log) => log.annotations.source === "anonymous" && log.annotations.errorTag === errorTag,
  );

it.layer(NodeServices.layer)("telemetry identity", (it) => {
  it.effect("uses the persisted installation id without reading provider files", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const anonymousId = "persisted-anonymous-id";
      const readPaths: string[] = [];

      yield* fileSystem.writeFileString(config.anonymousIdPath, anonymousId);

      const identifier = yield* Identify.getTelemetryIdentifier.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          readFileString: (filePath, options) => {
            readPaths.push(filePath);
            assert.equal(filePath, config.anonymousIdPath);
            return fileSystem.readFileString(filePath, options);
          },
        }),
      );

      assert.equal(identifier, sha256(anonymousId));
      assert.deepEqual(readPaths, [config.anonymousIdPath]);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "rove-telemetry-identify-anonymous-",
        }),
      ),
    ),
  );

  it.effect("creates a random id once and reuses it across calls", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      assert.isFalse(yield* fileSystem.exists(config.anonymousIdPath));

      const first = yield* Identify.getTelemetryIdentifier;
      const anonymousId = yield* fileSystem.readFileString(config.anonymousIdPath);
      const second = yield* Identify.getTelemetryIdentifier;

      assert.match(
        anonymousId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.equal(first, sha256(anonymousId));
      assert.equal(second, first);
      assert.equal(yield* fileSystem.readFileString(config.anonymousIdPath), anonymousId);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "rove-telemetry-identify-generate-",
        }),
      ),
    ),
  );

  it.effect("does not link separate installations", () =>
    Effect.gen(function* () {
      const first = yield* Identify.getTelemetryIdentifier.pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "rove-telemetry-identify-first-",
          }),
        ),
      );
      const second = yield* Identify.getTelemetryIdentifier.pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "rove-telemetry-identify-second-",
          }),
        ),
      );

      assert.isString(first);
      assert.isString(second);
      assert.notEqual(first, second);
    }),
  );

  it.effect("does not overwrite the anonymous id path after a non-NotFound read failure", () => {
    const logs: CapturedLog[] = [];
    const logger = makeCaptureLogger(logs);

    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      yield* fileSystem.makeDirectory(config.anonymousIdPath);

      const identifier = yield* Identify.getTelemetryIdentifier;

      assert.isNull(identifier);
      assert.deepEqual(yield* fileSystem.readDirectory(config.anonymousIdPath), []);

      const readLog = findIdentityLog(logs, "TelemetryIdentityReadError");
      assert.isDefined(readLog);
      assert.equal(readLog?.annotations.filePath, config.anonymousIdPath);
      assert.equal(readLog?.annotations.causeKind, "platform");
      assert.notEqual(readLog?.annotations.platformReason, "NotFound");
      assert.notProperty(readLog?.annotations ?? {}, "cause");
      const errorStack = readLog?.annotations.errorStack;
      assert.isString(errorStack);
      assert.include(errorStack, "Failed to read anonymous telemetry identity");
      assert.isUndefined(findIdentityLog(logs, "TelemetryAnonymousIdPersistenceError"));
    }).pipe(
      Effect.provide(
        Layer.merge(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "rove-telemetry-identify-read-",
          }),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });
});
