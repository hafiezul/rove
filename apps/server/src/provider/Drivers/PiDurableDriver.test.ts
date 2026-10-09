import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect } from "vite-plus/test";
import { ProviderInstanceId, ThreadId } from "@rove-code/contracts";
import { createModels } from "pi-durable-ai/models";
import { fauxProvider } from "pi-durable-ai/providers/faux";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../../config.ts";
import { makePiDurableDriver } from "./PiDurableDriver.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "rove-pi-durable-driver-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect("provider probes never generate and instances keep separate saved histories", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const faux = fauxProvider({ models: [{ id: "test" }] });
      const models = createModels();
      models.setProvider(faux.provider);
      const driver = makePiDurableDriver(models);
      const config = driver.defaultConfig();
      const first = yield* driver.create({
        instanceId: ProviderInstanceId.make("durable_one"),
        displayName: undefined,
        environment: [],
        enabled: true,
        config,
      });
      const second = yield* driver.create({
        instanceId: ProviderInstanceId.make("durable_two"),
        displayName: undefined,
        environment: [],
        enabled: true,
        config,
      });
      const snapshot = yield* first.snapshot.getSnapshot;
      const refreshed = yield* first.snapshot.refresh;
      expect(snapshot.status).toBe("ready");
      // Provider snapshots cross RPC as JSON, so undefined-valued fields
      // must be omitted, not merely accepted by ServerProvider's optional keys.
      expect(() => decodeJson(snapshot)).not.toThrow();
      expect(refreshed.models.map((model) => model.slug)).toEqual([`${faux.provider.id}/test`]);
      expect(snapshot.supportsTextGeneration).toBe(false);
      expect(faux.state.callCount).toBe(0);
      const threadId = ThreadId.make("shared-id");
      yield* first.adapter.startSession({ threadId, runtimeMode: "full-access" });
      // A cursor from another instance cannot cause Durable to create an empty
      // substitute database, or attach to that instance's conversation.
      const missing = yield* second.adapter
        .startSession({ threadId, runtimeMode: "full-access", resumeCursor: { version: 1 } })
        .pipe(Effect.result);
      expect(missing._tag).toBe("Failure");
      yield* second.adapter.startSession({ threadId, runtimeMode: "full-access" });
      expect((yield* second.adapter.readThread(threadId)).turns).toEqual([]);
      expect(first.continuationIdentity).not.toEqual(second.continuationIdentity);
      expect(faux.state.callCount).toBe(0);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("disabled instances cannot start work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      const driver = makePiDurableDriver(models);
      const instance = yield* driver.create({
        instanceId: ProviderInstanceId.make("durable_off"),
        displayName: undefined,
        environment: [],
        enabled: false,
        config: driver.defaultConfig(),
      });
      expect((yield* instance.snapshot.getSnapshot).status).toBe("disabled");
      const start = yield* instance.adapter
        .startSession({ threadId: ThreadId.make("disabled"), runtimeMode: "full-access" })
        .pipe(Effect.result);
      expect(start._tag).toBe("Failure");
      expect(faux.state.callCount).toBe(0);
    }),
  ).pipe(Effect.provide(testLayer)),
);
