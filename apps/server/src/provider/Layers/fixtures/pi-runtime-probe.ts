// @effect-diagnostics nodeBuiltinImport:off - Extension smoke fixture spawns a plain Node child without an Effect runtime.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { getPackageDir, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("probe-child-runtime", {
    description: "Verify foreground and background Pi runtime bootstrap without inference.",
    handler: async (_args, ctx) => {
      initTheme("dark");
      const entry = NodeURL.fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
      let directory = NodePath.dirname(entry);
      while (directory !== NodePath.dirname(directory)) {
        const manifest = NodePath.join(directory, "package.json");
        if (
          NodeFS.existsSync(manifest) &&
          JSON.parse(NodeFS.readFileSync(manifest, "utf8")).name ===
            "@earendil-works/pi-coding-agent"
        )
          break;
        directory = NodePath.dirname(directory);
      }
      NodeAssert.equal(directory, getPackageDir(), "extension resolution must locate the host SDK");
      NodeAssert.ok(NodeFS.existsSync(NodePath.join(directory, "dist", "index.js")));
      const childPath = NodePath.join(directory, "rove-child-probe.mjs");
      NodeFS.writeFileSync(
        childPath,
        `
        import '@earendil-works/chord';
        import '@earendil-works/chord/context';
        import assert from 'node:assert/strict';
        const root = ${JSON.stringify(directory)};
        const pi = await import(${JSON.stringify(NodeURL.pathToFileURL(entry).href)});
        pi.initTheme('dark');
        assert.equal(pi.getPackageDir(), root);
        const services = await pi.createAgentSessionServices({
          cwd: ${JSON.stringify(ctx.cwd)},
          resourceLoaderOptions: { noExtensions: true },
        });
        const { session } = await pi.createAgentSessionFromServices({
          services, sessionManager: pi.SessionManager.inMemory(),
        });
        session.dispose();
        console.log('background Pi runtime bootstrap passed');
      `,
      );
      const child = NodeChildProcess.spawnSync(process.execPath, [childPath], {
        cwd: ctx.cwd,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, PI_OFFLINE: "1" },
      });
      NodeAssert.equal(child.status, 0, child.stderr || child.stdout);
      NodeAssert.match(child.stdout, /background Pi runtime bootstrap passed/);
      NodeFS.writeFileSync(NodePath.join(ctx.cwd, "runtime-probe.txt"), child.stdout);
    },
  });
}
