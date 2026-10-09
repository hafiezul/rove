import { describe, expect, it } from "vite-plus/test";

import { hostedBuildDefines } from "./hostedBuild";

describe("hostedBuildDefines", () => {
  it("builds a manual-pairing client with a normalized public origin", () => {
    const defines = hostedBuildDefines("https://rove.hafiezulzikry.com/");

    expect(JSON.parse(defines["import.meta.env.VITE_HOSTED_APP_URL"])).toBe(
      "https://rove.hafiezulzikry.com",
    );
    expect(JSON.parse(defines["import.meta.env.VITE_HOSTED_APP_CHANNEL"])).toBe("latest");
    for (const setting of [
      "VITE_HTTP_URL",
      "VITE_WS_URL",
      "VITE_DEV_SERVER_URL",
      "VITE_ROVE_RELAY_URL",
      "VITE_CLERK_PUBLISHABLE_KEY",
      "VITE_CLERK_JWT_TEMPLATE",
      "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
      "VITE_RELAY_OTLP_TRACES_URL",
      "VITE_RELAY_OTLP_TRACES_DATASET",
      "VITE_RELAY_OTLP_TRACES_TOKEN",
    ]) {
      expect(defines).toHaveProperty([`import.meta.env.${setting}`], JSON.stringify(""));
    }
  });

  it("builds a nightly client with its own public origin and channel", () => {
    const defines = hostedBuildDefines("https://rove-nightly.hafiezulzikry.com", "nightly");

    expect(JSON.parse(defines["import.meta.env.VITE_HOSTED_APP_URL"])).toBe(
      "https://rove-nightly.hafiezulzikry.com",
    );
    expect(JSON.parse(defines["import.meta.env.VITE_HOSTED_APP_CHANNEL"])).toBe("nightly");
    expect(defines).toHaveProperty(["import.meta.env.VITE_HTTP_URL"], JSON.stringify(""));
    expect(defines).toHaveProperty(["import.meta.env.VITE_WS_URL"], JSON.stringify(""));
  });

  it.each(["stable", "preview", "unknown"])("rejects an unsupported app channel %s", (channel) => {
    expect(() => hostedBuildDefines("https://rove.hafiezulzikry.com", channel)).toThrow(
      /VITE_HOSTED_APP_CHANNEL/,
    );
  });

  it.each([
    undefined,
    "",
    "not-a-url",
    "http://localhost:5733",
    "https://user:password@example.com",
    "https://example.com/app",
    "https://example.com/?token=secret",
    "https://example.com/#token=secret",
  ])("rejects an absent or invalid public origin %s", (url) => {
    expect(() => hostedBuildDefines(url)).toThrow();
  });
});
