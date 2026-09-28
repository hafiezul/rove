import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const configEnv = vi.hoisted(() => ({ current: {} }));
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => configEnv.current,
}));

const originalEnv = { ...process.env };
const configuredKeys = [
  "ROVE_EXPO_PROJECT_ID",
  "ROVE_EXPO_OWNER",
  "ROVE_MOBILE_UPDATES_ENABLED",
  "ROVE_APPLE_TEAM_ID",
  "ROVE_CLERK_RELYING_PARTY_DOMAIN",
];

async function configFor(env: Record<string, string>) {
  configEnv.current = env;
  vi.resetModules();
  return (await import("./app.config")).default;
}

afterEach(() => {
  for (const key of configuredKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  vi.resetModules();
});

describe("source-built mobile identity", () => {
  it("does not enroll an unconfigured app in upstream Expo, Clerk, or Apple infrastructure", async () => {
    const config = await configFor({});
    expect(config.updates?.enabled).toBe(false);
    expect(config.updates?.url).toBeUndefined();
    expect(config.extra?.eas).toBeUndefined();
    expect(config.owner).toBeUndefined();
    expect(config.ios?.appleTeamId).toBeUndefined();
    expect(config.ios?.associatedDomains).toEqual([]);
  });

  it("uses explicitly configured, project-owned native identities", async () => {
    const config = await configFor({
      ROVE_EXPO_PROJECT_ID: "00000000-0000-4000-8000-000000000000",
      ROVE_EXPO_OWNER: "rove-test",
      ROVE_MOBILE_UPDATES_ENABLED: "1",
      ROVE_APPLE_TEAM_ID: "ABCDE12345",
      ROVE_CLERK_RELYING_PARTY_DOMAIN: "rove.example.test",
    });
    expect(config.updates?.enabled).toBe(true);
    expect(config.updates?.url).toBe("https://u.expo.dev/00000000-0000-4000-8000-000000000000");
    expect(config.extra?.eas).toEqual({ projectId: "00000000-0000-4000-8000-000000000000" });
    expect(config.owner).toBe("rove-test");
    expect(config.ios?.appleTeamId).toBe("ABCDE12345");
    expect(config.ios?.associatedDomains).toEqual([
      "applinks:rove.example.test",
      "webcredentials:rove.example.test",
    ]);
  });

  it("refuses OTA updates without a project ID", async () => {
    await expect(configFor({ ROVE_MOBILE_UPDATES_ENABLED: "1" })).rejects.toThrow(
      "ROVE_EXPO_PROJECT_ID is required",
    );
  });

  it("refuses upstream relying-party domains even if explicitly configured", async () => {
    await expect(configFor({ ROVE_CLERK_RELYING_PARTY_DOMAIN: "clerk.t3.codes" })).rejects.toThrow(
      "must belong to this project",
    );
  });
});
