import type { ComputerUseControlInput } from "@t3tools/contracts";
import { useState } from "react";

import { computerUseEnvironment } from "~/state/computerUse";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { describeDriver, primaryAction } from "./ComputerUseSettings.logic";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type Action = ComputerUseControlInput["action"];

const PENDING_LABELS = {
  install: "Installing…",
  start: "Checking…",
  "grant-permissions": "Waiting for macOS…",
  "set-telemetry": "Saving…",
} satisfies Record<Action, string>;

export function ComputerUseSettings() {
  const { scope, environment } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const environmentId =
    environment?.connection.phase === "connected" && environment.serverConfig !== null
      ? environment.environmentId
      : null;
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const driver = useEnvironmentQuery(
    environmentId === null ? null : computerUseEnvironment.status({ environmentId, input: {} }),
  );
  const control = useAtomCommand(computerUseEnvironment.control, "Cua Driver");
  const [pending, setPending] = useState<Action | null>(null);
  const status = driver.data;
  const busy = pending !== null || driver.isPending;
  const primary = primaryAction(status);
  const telemetry =
    status?.status === "stopped" || status?.status === "running" ? status.telemetry : null;

  const run = async (input: ComputerUseControlInput) => {
    if (environmentId === null) return;
    setPending(input.action);
    try {
      await control({ environmentId, input });
    } finally {
      setPending(null);
      driver.refresh();
    }
  };

  return (
    <SettingsSection id="computer-use" title="Computer use">
      <SettingsRow
        {...searchableSetting("agent-computer-use")}
        serverScoped
        settingKeys={["enableAgentComputerUse"]}
        description="Use Cua Driver for background-only Mac app control or a private, offline Linux desktop per thread. Linux apps and files are temporary and cannot access the project or host desktop. Turning this off discards Linux desktops and quits a Mac daemon Rove started."
        control={
          <ScopedSwitch
            settingKeys={["enableAgentComputerUse"]}
            checked={settings.enableAgentComputerUse}
            disabled={projectScope || environmentId === null}
            aria-label="Agent computer use"
            onCheckedChange={(checked) =>
              updateSettings({ enableAgentComputerUse: Boolean(checked) })
            }
          />
        }
      />
      <SettingsRow
        {...searchableSetting("cua-driver")}
        description={describeDriver(status, driver.error)}
        control={
          primary ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(primary.input)}
            >
              {pending === primary.input.action
                ? PENDING_LABELS[primary.input.action]
                : primary.label}
            </Button>
          ) : status === null ||
            status.status === "runtime-unavailable" ||
            (status.status === "running" && status.readiness.platform === "linux") ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || environmentId === null}
              onClick={driver.refresh}
            >
              {driver.isPending ? "Checking…" : "Check again"}
            </Button>
          ) : null
        }
      />
      {telemetry !== null ? (
        <SettingsRow
          {...searchableSetting("cua-telemetry")}
          description="Cua collects a pseudonymous installation ID and content-free usage counts, never prompts, screen contents, or file paths. Rove turns this off when it installs Cua."
          control={
            <Switch
              checked={telemetry}
              disabled={busy}
              aria-label="Share usage data with Cua"
              onCheckedChange={(checked) =>
                void run({ action: "set-telemetry", enabled: Boolean(checked) })
              }
            />
          }
        />
      ) : null}
    </SettingsSection>
  );
}
