import { useCallback, useRef } from "react";
import { squashAtomCommandFailure } from "@rove-code/client-runtime/state/runtime";
import {
  STANDALONE_THREADS_UNSUPPORTED_MESSAGE,
  standaloneThreadInput,
  supportsStandaloneThreads,
} from "@rove-code/client-runtime/state/standalone-thread";
import { ThreadId, type EnvironmentId } from "@rove-code/contracts";
import { uuidv4 } from "../lib/uuid";
import { useServerConfigs } from "./entities";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

export function useStartStandaloneThread() {
  const configs = useServerConfigs();
  const createThread = useAtomCommand(threadEnvironment.create);
  const pending = useRef<Promise<{ environmentId: EnvironmentId; threadId: ThreadId }> | null>(
    null,
  );
  return useCallback(
    (targetEnvironmentId?: EnvironmentId | null) => {
      if (pending.current) return pending.current;
      const environmentId = targetEnvironmentId ?? configs.keys().next().value;
      if (!environmentId)
        return Promise.reject(new Error("Connect an environment to start a thread."));
      const config = configs.get(environmentId);
      if (!supportsStandaloneThreads(config))
        return Promise.reject(new Error(STANDALONE_THREADS_UNSUPPORTED_MESSAGE));
      const threadId = ThreadId.make(uuidv4());
      const request = createThread({
        environmentId,
        input: standaloneThreadInput(threadId, config),
      })
        .then((result) => {
          if (result._tag === "Failure") {
            const error = squashAtomCommandFailure(result);
            throw error instanceof Error
              ? error
              : new Error("Could not start a standalone thread.");
          }
          return { environmentId, threadId };
        })
        .finally(() => {
          pending.current = null;
        });
      pending.current = request;
      return request;
    },
    [configs, createThread],
  );
}
