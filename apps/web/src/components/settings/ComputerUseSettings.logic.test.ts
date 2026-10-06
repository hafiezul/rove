import type { ComputerUseStatus } from "@rove-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeDriver, primaryAction } from "./ComputerUseSettings.logic";

const linux = {
  status: "stopped",
  version: "1.2.3",
  telemetry: false,
  readiness: {
    platform: "linux",
    desktops: 0,
    capacity: 4,
    diagnostics: [
      { label: "display server", status: "ok", message: "X11 desktop" },
      { label: "AT-SPI", status: "ok", message: "Accessibility bus reachable" },
    ],
  },
} satisfies ComputerUseStatus;

const mac = {
  status: "running",
  version: "1.2.3",
  telemetry: false,
  readiness: {
    platform: "darwin",
    permissions: { accessibility: true, screenRecording: false },
  },
} satisfies ComputerUseStatus;

describe("computer use setup", () => {
  it("distinguishes missing prerequisites from an image that needs preparation", () => {
    const unavailable = {
      status: "runtime-unavailable",
      detail: "Install rootless Podman.",
    } satisfies ComputerUseStatus;
    expect(describeDriver(unavailable, null)).toBe("Install rootless Podman.");
    expect(primaryAction(unavailable)).toBeNull();
    const missingImage = { status: "needs-desktop-image" } satisfies ComputerUseStatus;
    expect(primaryAction(missingImage)).toEqual({
      input: { action: "install" },
      label: "Prepare desktop",
    });
    expect(describeDriver(missingImage, null)).toContain("No host folders");
  });
  it("offers installation on Linux instead of describing an unsupported host", () => {
    const missing = { status: "not-installed", platform: "linux" } satisfies ComputerUseStatus;
    expect(describeDriver(missing, null)).toContain("Linux host");
    expect(primaryAction(missing)?.input).toEqual({ action: "install" });
  });

  it("checks a stopped Linux desktop without offering macOS grants", () => {
    expect(primaryAction(linux)).toEqual({ input: { action: "start" }, label: "Check desktop" });
    expect(primaryAction({ ...linux, status: "running" })).toBeNull();
    expect(describeDriver(linux, null)).toContain("desktop image is ready");
    expect(describeDriver({ ...linux, status: "running" }, null)).toContain(
      "0 of 4 private thread desktops",
    );
  });

  it("shows Linux diagnostic remedies even while the runtime is connected", () => {
    const degraded = {
      ...linux,
      status: "running",
      readiness: {
        platform: "linux",
        desktops: 1,
        capacity: 4,
        diagnostics: [
          {
            label: "AT-SPI",
            status: "warn",
            message: "Accessibility bus not reachable",
            detail: "Install at-spi2-core.",
          },
        ],
      },
    } satisfies ComputerUseStatus;
    const text = describeDriver(degraded, null);
    expect(text).toContain("Accessibility bus not reachable");
    expect(text).toContain("Install at-spi2-core");
    expect(text).not.toContain("no diagnostic warnings");
    expect(primaryAction(degraded)).toBeNull();
  });

  it("does not claim readiness when Linux diagnostics could not be read", () => {
    const unknown = {
      ...linux,
      status: "running",
      readiness: { platform: "linux", diagnostics: null, desktops: 0, capacity: 4 },
    } satisfies ComputerUseStatus;
    expect(describeDriver(unknown, null)).toContain("diagnostics could not be read");
    expect(describeDriver(unknown, null)).not.toContain("no diagnostic warnings");
  });

  it("preserves macOS grants and names the missing permission", () => {
    expect(describeDriver(mac, null)).toContain("needs Screen Recording");
    expect(primaryAction(mac)?.input).toEqual({ action: "grant-permissions" });
    const granted = {
      ...mac,
      readiness: {
        platform: "darwin",
        permissions: { accessibility: true, screenRecording: true },
      },
    } satisfies ComputerUseStatus;
    expect(primaryAction(granted)).toBeNull();
    expect(describeDriver(granted, null)).toContain(
      "running with Accessibility and Screen Recording",
    );
  });

  it("preserves unavailable-host and connection-error messages", () => {
    expect(describeDriver({ status: "unsupported", platform: "win32" }, null)).toContain(
      "macOS or Linux host",
    );
    expect(primaryAction({ status: "unsupported", platform: "win32" })).toBeNull();
    expect(describeDriver(null, "Disconnected")).toBe("Disconnected");
  });
});
