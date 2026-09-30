import type { ComputerUseAction, ComputerUseStatus } from "@t3tools/contracts";
import { useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { computerUseEnvironment } from "~/state/computerUse";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const PENDING_LABELS = {
  start: "Starting…",
  "grant-permissions": "Waiting for macOS…",
  stop: "Stopping…",
} satisfies Record<ComputerUseAction, string>;

function describeDriver(status: ComputerUseStatus | null, error: string | null): string {
  if (status === null) return error ?? "Checking Cua Driver on this environment…";
  switch (status.status) {
    case "unsupported":
      return `Computer use needs a macOS host. This environment runs ${status.platform}.`;
    case "not-installed":
      return "Install Cua Driver on the computer running this environment, then check again.";
    case "stopped":
      return `Cua Driver ${status.version} is installed. It starts when an agent first uses it.`;
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
        : `Cua Driver needs ${missing.join(" and ")}. macOS asks on the computer running this environment.`;
    }
  }
}

function needsPermissions(status: ComputerUseStatus | null) {
  return (
    status?.status === "running" &&
    (status.permissions === null ||
      !status.permissions.accessibility ||
      !status.permissions.screenRecording)
  );
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
  const [pending, setPending] = useState<ComputerUseAction | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const status = driver.data;

  const run = async (action: ComputerUseAction) => {
    if (environmentId === null) return;
    setPending(action);
    try {
      await control({ environmentId, input: { action } });
    } finally {
      setPending(null);
      driver.refresh();
    }
  };

  const busy = pending !== null || driver.isPending;
  const actionButton = (action: ComputerUseAction, label: string) => (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(action)}>
      {pending === action ? PENDING_LABELS[action] : label}
    </Button>
  );

  return (
    <SettingsSection id="computer-use" title="Computer use">
      <SettingsRow
        {...searchableSetting("agent-computer-use")}
        serverScoped
        settingKeys={["enableAgentComputerUse"]}
        description="Let agents see and control apps on this environment's Mac through Cua Driver. Turning this off also stops agents that are already using it."
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
          <div className="flex flex-wrap justify-end gap-2">
            {needsPermissions(status)
              ? actionButton("grant-permissions", "Grant permissions")
              : null}
            {status?.status === "stopped" ? actionButton("start", "Start") : null}
            {status?.status === "running" ? actionButton("stop", "Stop") : null}
            {status === null || status.status === "not-installed" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || environmentId === null}
                onClick={driver.refresh}
              >
                {driver.isPending ? "Checking…" : "Check again"}
              </Button>
            ) : null}
          </div>
        }
      >
        {status?.status === "not-installed" ? (
          <div className="flex items-center gap-2 px-4 pb-3">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
              {status.installCommand}
            </code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => copyToClipboard(status.installCommand, undefined)}
            >
              {isCopied ? "Copied" : "Copy"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              render={<a href={status.docsUrl} rel="noreferrer noopener" target="_blank" />}
            >
              Docs
            </Button>
          </div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
