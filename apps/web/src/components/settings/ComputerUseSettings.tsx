import type { ComputerUseControlInput, ComputerUseStatus } from "@t3tools/contracts";
import { useState } from "react";

import { computerUseEnvironment } from "~/state/computerUse";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
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

function describeDriver(status: ComputerUseStatus | null, error: string | null): string {
  if (status === null) return error ?? "Checking Cua Driver on this environment…";
  switch (status.status) {
    case "unsupported":
      return `Computer use needs a macOS host. This environment runs ${status.platform}.`;
    case "not-installed":
      return "Not installed on this environment's Mac. Install downloads it from Cua's official releases.";
    case "untrusted":
      return "The Cua Driver app on this Mac is not signed by Cua AI, Inc., so Rove won't run it. Reinstall it from Cua's official releases.";
    case "stopped":
      return `Cua Driver ${status.version} starts when an agent needs it and quits after 5 idle minutes.`;
    case "running": {
      if (status.permissions === null) {
        return `Cua Driver ${status.version} is running, but its permissions could not be read.`;
      }
      const missing = [
        status.permissions.accessibility ? null : "Accessibility",
        status.permissions.screenRecording ? null : "Screen Recording",
      ].filter((name) => name !== null);
      return missing.length === 0
        ? `Cua Driver ${status.version} is running with Accessibility and Screen Recording.`
        : `Cua Driver needs ${missing.join(" and ")}. macOS asks on the Mac running this environment.`;
    }
  }
}

function primaryAction(
  status: ComputerUseStatus | null,
): { input: ComputerUseControlInput; label: string } | null {
  switch (status?.status) {
    case "not-installed":
      return { input: { action: "install" }, label: "Install" };
    case "untrusted":
      return { input: { action: "install" }, label: "Reinstall" };
    case "stopped":
      return { input: { action: "start" }, label: "Check permissions" };
    case "running":
      return status.permissions?.accessibility && status.permissions.screenRecording
        ? null
        : { input: { action: "grant-permissions" }, label: "Grant permissions" };
    default:
      return null;
  }
}

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
        description="Let agents see and control apps on this environment's Mac through Cua Driver. Turning this off stops agents that are using it and quits Cua if Rove started it."
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
          ) : status === null ? (
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
