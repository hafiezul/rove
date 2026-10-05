import type { ComputerUseControlInput, ComputerUseStatus } from "@t3tools/contracts";

export function describeDriver(status: ComputerUseStatus | null, error: string | null): string {
  if (status === null) return error ?? "Checking Cua Driver on this environment…";
  switch (status.status) {
    case "unsupported":
      return `Computer use needs a macOS or Linux host. This environment runs ${status.platform}.`;
    case "not-installed":
      return `Not installed on this environment's ${status.platform === "linux" ? "Linux host" : "Mac"}. Install downloads it from Cua's official releases.`;
    case "runtime-unavailable":
      return status.detail;
    case "needs-desktop-image":
      return "Prepare the private Linux desktop image. This downloads desktop packages and includes Cua Driver. No host folders, credentials, clipboard or display are shared.";
    case "untrusted":
      return "The Cua Driver app on this Mac is not signed by Cua AI, Inc., so Rove won't run it. Reinstall it from Cua's official releases.";
    case "stopped":
    case "running": {
      const readiness = status.readiness;
      if (readiness.platform === "linux") {
        const prefix = `Cua Driver ${status.version}. ${readiness.desktops} of ${readiness.capacity} private thread desktops in use.`;
        const lifecycle =
          " Offline guest apps and files are temporary. close_desktop, turning this off, or stopping Rove discards them. Idle connections close without discarding documents.";
        if (status.status === "stopped") return `${prefix} The desktop image is ready.${lifecycle}`;
        if (readiness.diagnostics === null)
          return `${prefix} A connection is active, but guest diagnostics could not be read.${lifecycle}`;
        const issues = readiness.diagnostics.filter((probe) => probe.status !== "ok");
        return issues.length === 0
          ? `${prefix} Guest checks passed.${lifecycle}`
          : `${prefix} ${issues.map((probe) => `${probe.label}. ${probe.message}.${probe.detail ? ` ${probe.detail}` : ""}`).join(" ")}${lifecycle}`;
      }
      if (status.status === "stopped") {
        return `Cua Driver ${status.version} starts when an agent needs it and quits after 5 idle minutes.`;
      }
      if (readiness.permissions === null) {
        return `Cua Driver ${status.version} is running, but its permissions could not be read.`;
      }
      const missing = [
        readiness.permissions.accessibility ? null : "Accessibility",
        readiness.permissions.screenRecording ? null : "Screen Recording",
      ].filter((name) => name !== null);
      return missing.length === 0
        ? `Cua Driver ${status.version} is running with Accessibility and Screen Recording.`
        : `Cua Driver needs ${missing.join(" and ")}. macOS asks on the Mac running this environment.`;
    }
  }
}

export function primaryAction(
  status: ComputerUseStatus | null,
): { input: ComputerUseControlInput; label: string } | null {
  switch (status?.status) {
    case "not-installed":
      return { input: { action: "install" }, label: "Install" };
    case "needs-desktop-image":
      return { input: { action: "install" }, label: "Prepare desktop" };
    case "untrusted":
      return { input: { action: "install" }, label: "Reinstall" };
    case "stopped":
      return {
        input: { action: "start" },
        label: status.readiness.platform === "linux" ? "Check desktop" : "Check permissions",
      };
    case "running": {
      const readiness = status.readiness;
      if (readiness.platform === "linux") return null;
      return readiness.permissions?.accessibility && readiness.permissions.screenRecording
        ? null
        : { input: { action: "grant-permissions" }, label: "Grant permissions" };
    }
    default:
      return null;
  }
}
