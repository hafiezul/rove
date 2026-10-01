import { createComputerUseEnvironmentAtoms } from "@t3tools/client-runtime/state/computer-use";

import { connectionAtomRuntime } from "../connection/runtime";

export const computerUseEnvironment = createComputerUseEnvironmentAtoms(connectionAtomRuntime);
