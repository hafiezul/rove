import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { ComputerUseStatus } from "./computerUse.ts";

const decode = Schema.decodeUnknownSync(ComputerUseStatus);

const installed = { status: "running", version: "1.2.3", telemetry: false };

describe("computer use status", () => {
  it("distinguishes runtime setup from image preparation and validates slot counts", () => {
    expect(decode({ status: "runtime-unavailable", detail: "Podman unavailable" })).toEqual({
      status: "runtime-unavailable",
      detail: "Podman unavailable",
    });
    expect(decode({ status: "needs-desktop-image" })).toEqual({ status: "needs-desktop-image" });
    for (const [desktops, capacity] of [
      [-1, 4],
      [1, 0],
      [1.5, 4],
    ]) {
      expect(() =>
        decode({
          ...installed,
          readiness: { platform: "linux", diagnostics: null, desktops, capacity },
        }),
      ).toThrow();
    }
  });
  it("carries Linux diagnostic failures without calling them macOS grants", () => {
    const status = {
      ...installed,
      readiness: {
        platform: "linux",
        desktops: 0,
        capacity: 4,
        diagnostics: [
          {
            label: "AT-SPI",
            status: "err",
            message: "No accessibility bus",
            detail: "Install at-spi2-core.",
          },
        ],
      },
    };
    expect(decode(status)).toEqual(status);
    expect(() =>
      decode({
        ...installed,
        readiness: {
          platform: "linux",
          permissions: { accessibility: true, screenRecording: true },
        },
      }),
    ).toThrow();
  });

  it("preserves macOS permission failures separately", () => {
    const status = {
      ...installed,
      readiness: {
        platform: "darwin",
        permissions: { accessibility: true, screenRecording: false },
      },
    };
    expect(decode(status)).toEqual(status);
    expect(() =>
      decode({ ...installed, readiness: { platform: "darwin", diagnostics: [] } }),
    ).toThrow();
  });

  it("rejects unknown diagnostic severities", () => {
    expect(() =>
      decode({
        ...installed,
        readiness: {
          platform: "linux",
          diagnostics: [{ label: "AT-SPI", status: "ready", message: "Bus found" }],
        },
      }),
    ).toThrow();
  });

  it("accepts an unreadable diagnostic report and platform-specific install states", () => {
    expect(
      decode({
        ...installed,
        status: "stopped",
        readiness: { platform: "linux", diagnostics: null, desktops: 0, capacity: 4 },
      }),
    ).toMatchObject({ status: "stopped" });
    expect(decode({ status: "not-installed", platform: "linux" })).toEqual({
      status: "not-installed",
      platform: "linux",
    });
    expect(() => decode({ status: "not-installed", platform: "win32" })).toThrow();
    expect(() =>
      decode({ ...installed, readiness: { platform: "linux", diagnostics: [] } }),
    ).toThrow();
  });
});
