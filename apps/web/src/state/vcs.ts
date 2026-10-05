import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@rove-code/client-runtime/state/vcs";

import { connectionAtomRuntime } from "../connection/runtime";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);
