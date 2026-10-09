import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { HostProcessArchitecture, HostProcessPlatform } from "@rove-code/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import { getTelemetryIdentifier } from "./Identify.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as RuntimePredicate from "effect/Predicate";

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly batch?: ReadonlyArray<{
      readonly event?: string;
      readonly properties?: {
        readonly index?: number;
        readonly clientType?: string;
        readonly serverOs?: string;
        readonly serverArch?: string;
        readonly serverAppVersion?: string;
        readonly serverMode?: string;
        readonly roveVersion?: string;
      };
    }>;
  } | null;
}

interface RecordedBatchBody {
  readonly batch: ReadonlyArray<{
    readonly event?: string;
    readonly properties?: {
      readonly index?: number;
      readonly clientType?: string;
      readonly serverOs?: string;
      readonly serverArch?: string;
      readonly serverAppVersion?: string;
      readonly serverMode?: string;
      readonly roveVersion?: string;
    };
  }>;
}

const decodeBatchPayload = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      api_key: Schema.String,
      batch: Schema.Array(
        Schema.Struct({
          event: Schema.String,
          distinct_id: Schema.String,
          properties: Schema.Struct({ $process_person_profile: Schema.Boolean }),
        }),
      ),
    }),
  ),
);

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  it.effect("uses Rove's project key and US ingestion host by default", () =>
    Effect.gen(function* () {
      const requests: Array<{ url: string; body: string }> = [];
      const httpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push({
            url: request.url,
            body:
              request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
          });
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
        }),
      );
      const runtimeLayer = AnalyticsService.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "rove-telemetry-default-" })),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, httpClient),
            Layer.succeed(HostProcessPlatform, "linux"),
            Layer.succeed(HostProcessArchitecture, "arm64"),
            ConfigProvider.layer(ConfigProvider.fromUnknown({})),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.default");
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.url, "https://us.i.posthog.com/batch/");
      const payload = yield* decodeBatchPayload(requests[0]?.body ?? "");
      assert.equal(payload.api_key, "phc_yeQwVXeqVTddxs65mQDciB89XFT3VdixFEyPuHdEbR9V");
      assert.equal(payload.batch.length, 1);
      assert.equal(payload.batch[0]?.event, "test.default");
      assert.match(payload.batch[0]?.distinct_id ?? "", /^[0-9a-f]{64}$/);
      assert.isFalse(payload.batch[0]?.properties.$process_person_profile);
    }),
  );

  it.effect("flush drains all buffered events across multiple batches", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "rove-telemetry-base-",
      });

      const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ROVE_TELEMETRY_ENABLED: true,
          ROVE_POSTHOG_KEY: "phc_test_key",
          ROVE_POSTHOG_HOST: "http://localhost",
          ROVE_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }

          const // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
            payload = yield* request.json.pipe(
              Effect.map((body) => body as RecordedBatchRequest["body"]),
              Effect.orElseSucceed(() => null),
            );

          capturedRequests.push({ path: request.url, body: payload });

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "linux"),
            Layer.succeed(HostProcessArchitecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const telemetryIdentifier = yield* getTelemetryIdentifier;
        assert.equal(telemetryIdentifier !== null, true);
        const analytics = yield* AnalyticsService.AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", { index });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 3);
      assert.equal(
        batchRequests.every(
          (request) => request.path.endsWith("/batch/") || request.path.endsWith("/batch"),
        ),
        true,
      );
      const deliveredIndexes = batchRequests.flatMap((request) =>
        request.body.batch
          .filter((event) => event.event === "test.flush.drain")
          .map((event) => event.properties?.index)
          .filter((index): index is number => RuntimePredicate.isNumber(index)),
      );

      const sorted = deliveredIndexes.toSorted((a, b) => a - b);
      assert.equal(sorted.length, 45);
      assert.deepEqual(
        sorted,
        Array.from({ length: 45 }, (_, index) => index),
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every((event) => event.properties?.clientType === "cli-web-client"),
        ),
        true,
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every(
            (event) =>
              event.properties?.serverOs === "Linux" &&
              event.properties.serverArch === "arm64" &&
              event.properties.serverAppVersion === event.properties.roveVersion &&
              event.properties.serverMode === "web",
          ),
        ),
        true,
      );
    }),
  );

  it.effect("does not access identity files or send requests when telemetry is disabled", () =>
    Effect.gen(function* () {
      const capturedPaths: Array<string> = [];
      const fileSystem = yield* FileSystem.FileSystem;
      const identityReads: Array<string> = [];
      const identityWrites: Array<string> = [];
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "rove-telemetry-disabled-",
      });
      const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ROVE_TELEMETRY_ENABLED: false,
          ROVE_POSTHOG_KEY: "phc_test_key",
          ROVE_POSTHOG_HOST: "http://localhost",
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          capturedPaths.push(request.url);
          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "linux"),
            Layer.succeed(HostProcessArchitecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.disabled", { index: 1 });
        yield* analytics.flush;
        const config = yield* ServerConfig.ServerConfig;
        assert.isFalse(yield* fileSystem.exists(config.anonymousIdPath));
      }).pipe(
        Effect.provide(runtimeLayer),
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          readFileString: (filePath, options) => {
            identityReads.push(filePath);
            return fileSystem.readFileString(filePath, options);
          },
          writeFileString: (filePath, contents, options) => {
            identityWrites.push(filePath);
            return fileSystem.writeFileString(filePath, contents, options);
          },
        }),
      );

      assert.deepEqual(identityReads, []);
      assert.deepEqual(identityWrites, []);
      assert.deepEqual(capturedPaths, []);
    }),
  );
});
