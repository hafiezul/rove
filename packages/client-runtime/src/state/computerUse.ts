import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createComputerUseEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Cua Driver install, daemon, and permission state on the environment's host. */
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:computer-use:status",
      tag: WS_METHODS.computerUseStatus,
    }),
    control: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer-use:control",
      tag: WS_METHODS.computerUseControl,
      scheduler: createAtomCommandScheduler(),
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
  };
}
