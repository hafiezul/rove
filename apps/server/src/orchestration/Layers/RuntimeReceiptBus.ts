/**
 * RuntimeReceiptBus layers.
 *
 * `RuntimeReceiptBusLive` is the production default and intentionally does not
 * retain or broadcast receipts. `RuntimeReceiptBusTest` installs the in-memory
 * PubSub-backed implementation used by integration tests that need to await
 * checkpoint-reactor milestones precisely.
 *
 * @module RuntimeReceiptBus
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  RuntimeReceiptBus,
  type RuntimeReceiptBusContract,
  type OrchestrationRuntimeReceipt,
} from "../Services/RuntimeReceiptBus.ts";

const makeRuntimeReceiptBus = Effect.succeed({
  publish: () => Effect.void,
  streamEventsForTest: Stream.empty,
} satisfies RuntimeReceiptBusContract);

const makeRuntimeReceiptBusTest = Effect.gen(function* () {
  const pubSub = yield* PubSub.unbounded<OrchestrationRuntimeReceipt>();

  return {
    publish: (receipt) => PubSub.publish(pubSub, receipt).pipe(Effect.asVoid),
    get streamEventsForTest() {
      return Stream.fromPubSub(pubSub);
    },
  } satisfies RuntimeReceiptBusContract;
});

export const RuntimeReceiptBusLive = Layer.effect(RuntimeReceiptBus, makeRuntimeReceiptBus);
export const RuntimeReceiptBusTest = Layer.effect(RuntimeReceiptBus, makeRuntimeReceiptBusTest);
