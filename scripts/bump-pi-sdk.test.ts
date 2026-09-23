import { describe, expect, it } from "vite-plus/test";

import { applyPiSdkBump, piSdkBranch, planPiSdkBranch, planPiSdkBump } from "./bump-pi-sdk.ts";

describe("planPiSdkBump", () => {
  it("reports up-to-date when the pin already matches latest", () => {
    expect(
      planPiSdkBump({
        latest: "0.87.0",
        packageJson: { dependencies: { "@earendil-works/pi-coding-agent": "^0.87.0" } },
      }),
    ).toEqual({ action: "up-to-date", version: "0.87.0" });
  });

  it("plans a bump recording the pinned version as the source", () => {
    expect(
      planPiSdkBump({
        latest: "0.87.0",
        packageJson: {
          dependencies: {
            "@earendil-works/pi-ai": "^0.85.1",
            "@earendil-works/pi-coding-agent": "^0.85.1",
          },
        },
      }),
    ).toEqual({ action: "bump", from: "0.85.1", to: "0.87.0" });
  });
});

describe("applyPiSdkBump", () => {
  it("preserves unrelated fields while bumping pins and the license URL", () => {
    const next = applyPiSdkBump({
      latest: "0.87.0",
      packageJson: {
        name: "fixture-server",
        dependencies: {
          "@earendil-works/pi-ai": "^0.85.1",
          "@earendil-works/pi-coding-agent": "^0.85.1",
          unrelated: "1.2.3",
        },
      },
      licenses: {
        customNotices: [],
        packageOverrides: [
          {
            repositoryUrl: "https://github.com/earendil-works/pi",
            sourceUrl: "https://github.com/earendil-works/pi/blob/v0.85.1/LICENSE",
            generatedNotice: { licenseId: "MIT" },
          },
          {
            repositoryUrl: "https://github.com/example/other",
            sourceUrl: "https://github.com/example/other/blob/v9.9.9/LICENSE",
          },
        ],
      },
    });
    expect(next.packageJson).toEqual({
      name: "fixture-server",
      dependencies: {
        "@earendil-works/pi-ai": "^0.87.0",
        "@earendil-works/pi-coding-agent": "^0.87.0",
        unrelated: "1.2.3",
      },
    });
    expect(next.licenses.customNotices).toEqual([]);
    expect(next.licenses.packageOverrides).toEqual([
      {
        repositoryUrl: "https://github.com/earendil-works/pi",
        sourceUrl: "https://github.com/earendil-works/pi/blob/v0.87.0/LICENSE",
        generatedNotice: { licenseId: "MIT" },
      },
      {
        repositoryUrl: "https://github.com/example/other",
        sourceUrl: "https://github.com/example/other/blob/v9.9.9/LICENSE",
      },
    ]);
  });
});

describe("pi-sdk branch planning", () => {
  it("reuses the branch when already on it, creates otherwise", () => {
    expect(piSdkBranch("0.87.0")).toBe("chore/pi-sdk-0.87.0");
    expect(
      planPiSdkBranch({
        currentBranch: "chore/pi-sdk-0.87.0",
        targetBranch: "chore/pi-sdk-0.87.0",
      }),
    ).toEqual({ action: "reuse", branch: "chore/pi-sdk-0.87.0" });
    expect(planPiSdkBranch({ currentBranch: "main", targetBranch: "chore/pi-sdk-0.87.0" })).toEqual(
      { action: "create", branch: "chore/pi-sdk-0.87.0" },
    );
  });
});
