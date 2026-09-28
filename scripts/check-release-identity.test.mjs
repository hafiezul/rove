import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { checkReleaseIdentity, findUpstreamPublicIdentity } from "./check-release-identity.mjs";

NodeTest.test("flags public upstream identities, not compatibility names or attribution", () => {
  NodeAssert.deepEqual(
    findUpstreamPublicIdentity('import "@t3tools/contracts"; // read t3.json'),
    [],
  );
  NodeAssert.deepEqual(findUpstreamPublicIdentity("The fork is based on T3 Code."), []);
  NodeAssert.deepEqual(
    findUpstreamPublicIdentity("npx t3@nightly\nhttps://t3.codes/install.sh\nowner: 'pingdotgg'"),
    [
      { line: 1, text: "npx t3@nightly" },
      { line: 2, text: "https://t3.codes/install.sh" },
      { line: 3, text: "owner: 'pingdotgg'" },
    ],
  );
});

NodeTest.test("reports all public claims but only blocks enabled release surfaces", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-release-identity-"));
  const files = {
    "apps/marketing/src/pages/download.astro": "npx t3@nightly\n",
    "apps/marketing/astro.config.mjs": "site: undefined\n",
    "apps/marketing/vercel.ts": "redirects: []\n",
    "apps/web/vercel.ts": "host: 'app.t3.codes'\n",
    "apps/mobile/app.config.ts": "relyingParty: 'clerk.t3.codes'\n",
    "apps/mobile/src/features/settings/lib/legal-document-url.ts":
      "const site = 'https://t3.codes';\n",
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
    NodeAssert.equal(checkReleaseIdentity(root, {}), true);
    NodeAssert.equal(checkReleaseIdentity(root, { ROVE_MARKETING_RELEASE_READY: "true" }), false);
    NodeAssert.equal(checkReleaseIdentity(root, { ROVE_HOSTED_RELEASE_READY: "true" }), false);
    NodeAssert.equal(checkReleaseIdentity(root, { ROVE_MOBILE_STORES_READY: "true" }), false);
    NodeAssert.match(
      messages.join("\n"),
      /apps\/marketing\/src\/pages\/download\.astro:1: npx t3@nightly/,
    );
    NodeAssert.match(messages.join("\n"), /Refusing publication for: marketing/);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
