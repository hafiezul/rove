import { createComputerUseEnvironmentAtoms } from "@rove-code/client-runtime/state/computer-use";

import { connectionAtomRuntime } from "../connection/runtime";

export const computerUseEnvironment = createComputerUseEnvironmentAtoms(connectionAtomRuntime);
