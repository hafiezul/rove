import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { checkReleaseIdentity, findUpstreamPublicIdentity } from "./check-release-identity.mjs";

it("flags public upstream identities, not compatibility names or attribution", () => {
  expect(findUpstreamPublicIdentity('import "@rove-code/contracts"; // read rove.json')).toEqual(
    [],
  );
  expect(findUpstreamPublicIdentity("The fork is based on Rove Code.")).toEqual([]);
  expect(
    findUpstreamPublicIdentity(
      "npx rove@nightly\nhttps://rove.hafiezulzikry.com/install.sh\nowner: 'pingdotgg'",
    ),
  ).toEqual([
    { line: 1, text: "npx rove@nightly" },
    { line: 2, text: "https://rove.hafiezulzikry.com/install.sh" },
    { line: 3, text: "owner: 'pingdotgg'" },
  ]);
});

it("reports all public claims but only blocks enabled release surfaces", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-release-identity-"));
  const files = {
    "apps/marketing/src/pages/download.astro": "npx rove@nightly\n",
    "apps/marketing/astro.config.mjs": "site: undefined\n",
    "apps/marketing/vercel.ts": "redirects: []\n",
    "apps/web/vercel.ts": "host: 'app.rove.codes'\n",
    "apps/mobile/app.config.ts": "relyingParty: 'clerk.rove.codes'\n",
    "apps/mobile/eas.json": '{ "ascAppId": "6787819824" }\n',
    "apps/mobile/src/features/settings/lib/legal-document-url.ts":
      "const site = 'https://rove.hafiezulzikry.com';\n",
  };
  for (const [file, content] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, file), content);
  }

  const messages = [];
  const previousLog = console.log;
  const previousError = console.error;
  console.log = (...args) => messages.push(args.join(" "));
  console.error = (...args) => messages.push(args.join(" "));
  try {
    expect(checkReleaseIdentity(root, {})).toBe(true);
    expect(checkReleaseIdentity(root, { ROVE_MARKETING_RELEASE_READY: "true" })).toBe(false);
    expect(checkReleaseIdentity(root, { ROVE_HOSTED_RELEASE_READY: "true" })).toBe(false);
    expect(checkReleaseIdentity(root, { ROVE_MOBILE_STORES_READY: "true" })).toBe(false);
    expect(messages.join("\n")).toMatch(
      /apps\/marketing\/src\/pages\/download\.astro:1: npx rove@nightly/,
    );
    expect(messages.join("\n")).toMatch(/Refusing publication for: marketing/);
    expect(messages.join("\n")).toMatch(/apps\/mobile\/eas\.json:1:/);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
