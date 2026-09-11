import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";
import * as Cause from "effect/Cause";
import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";

/** Instance level Pi catalog: no thread required, cached until refreshed. */
export function useProviderResources(
  environmentId: EnvironmentId | null,
  instanceId: ProviderInstanceId | null,
) {
  const target = environmentId && instanceId ? { environmentId, input: { instanceId } } : null;
  const key = JSON.stringify(target);
  const query = useEnvironmentQuery(target ? serverEnvironment.piCatalog(target) : null);
  const refreshCommand = useAtomCommand(serverEnvironment.refreshPiCatalog, {
    reportFailure: false,
  });
  const [refreshState, setRefreshState] = useState<{
    key: string;
    pending: boolean;
    error: string | null;
  } | null>(null);
  const refresh = async () => {
    if (!target) return;
    setRefreshState({ key, pending: true, error: null });
    const result = await refreshCommand(target);
    setRefreshState({
      key,
      pending: false,
      error: result._tag === "Failure" ? String(Cause.squash(result.cause)) : null,
    });
    query.refresh();
  };
  return {
    data: query.data,
    error: (refreshState?.key === key ? refreshState.error : null) ?? query.error,
    isPending:
      (query.data === null && query.isPending) ||
      (refreshState?.key === key && refreshState.pending),
    refresh,
  };
}
