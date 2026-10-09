import * as NodeChildProcess from "node:child_process";

export default function (pi) {
  pi.registerCommand("probe-relaunch", {
    handler(_args, ctx) {
      // Pi's examples/extensions/subagent starts children exactly this way.
      const child = NodeChildProcess.spawnSync(process.execPath, [process.argv[1], "--version"], {
        cwd: ctx.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      });
      ctx.ui.notify(
        child.status === 0
          ? `relaunched pi ${child.stdout.trim()}`
          : `relaunch failed: ${child.stderr}`,
      );
    },
  });
}
