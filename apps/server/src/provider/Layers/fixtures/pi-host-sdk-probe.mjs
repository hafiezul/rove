import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
NodeAssert.ok(root, "Pi extensions need the host SDK root before loading");
NodeAssert.equal(
  JSON.parse(NodeFS.readFileSync(NodePath.join(root, "package.json"), "utf8")).name,
  "@earendil-works/pi-coding-agent",
);
const entry = NodeURL.pathToFileURL(NodePath.join(root, "dist", "index.js")).href;
const sdk = await import(entry);
NodeAssert.ok(sdk.createAgentSession);

const child = NodeChildProcess.spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `const sdk = await import(${JSON.stringify(entry)}); if (!sdk.createAgentSession) process.exit(1);`,
  ],
  {
    cwd: import.meta.dirname,
    env: { ...process.env, NODE_PATH: "" },
    encoding: "utf8",
    timeout: 5_000,
  },
);
NodeAssert.equal(child.status, 0, child.stderr || child.stdout);

export default function (pi) {
  pi.registerCommand("probe-host-sdk", {
    handler(_args, ctx) {
      ctx.ui.notify("host SDK loaded in Rove and detached child");
    },
  });
}
