import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { runPiRuntimeWorker } from "../piRuntimeWorker.ts";

/** Single-executable equivalent of the bundled pi-runtime-worker entry. */
export const piRuntimeCommand = Command.make("__pi-runtime").pipe(
  Command.unlisted,
  Command.withHandler(() => Effect.promise(runPiRuntimeWorker)),
);
