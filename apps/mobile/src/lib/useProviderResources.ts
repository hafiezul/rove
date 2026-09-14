import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  readPiInstanceSettings,
  togglePiExtensionDisabled,
} from "@t3tools/client-runtime/state/providerSettings";
import { useCallback, useMemo, useState } from "react";
import * as Cause from "effect/Cause";
import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentServerConfig } from "../state/entities";

const EMPTY_STRING_LIST: ReadonlyArray<string> = [];

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
  const updateSettingsCommand = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const serverConfig = useEnvironmentServerConfig(environmentId);
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
  const settingsReady =
    environmentId !== null && instanceId !== null && serverConfig?.settings !== undefined;
  const disabledExtensions = useMemo(() => {
    if (!settingsReady || instanceId === null) return EMPTY_STRING_LIST;
    return readPiInstanceSettings(serverConfig?.settings ?? {}, instanceId).disabledExtensions;
  }, [settingsReady, instanceId, serverConfig?.settings]);
  const toggleExtension = useCallback(
    (path: string, disabled: boolean) => {
      if (
        !settingsReady ||
        serverConfig?.settings === undefined ||
        instanceId === null ||
        environmentId === null
      ) {
        return;
      }
      void updateSettingsCommand({
        environmentId,
        input: {
          patch: togglePiExtensionDisabled({
            settings: serverConfig.settings,
            instanceId,
            path,
            disabled,
          }),
        },
      });
    },
    [environmentId, instanceId, serverConfig, settingsReady, updateSettingsCommand],
  );
  return {
    data: query.data,
    error: (refreshState?.key === key ? refreshState.error : null) ?? query.error,
    isPending:
      (query.data === null && query.isPending) ||
      (refreshState?.key === key && refreshState.pending),
    refresh,
    disabledExtensions,
    toggleExtension,
    settingsReady,
  };
}
