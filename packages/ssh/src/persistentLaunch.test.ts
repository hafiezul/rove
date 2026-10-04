// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { remoteStateKey } from "./command.ts";
import { buildRemoteLaunchScript, buildRemoteStopScript } from "./tunnel.ts";

const target = { alias: "wsl", hostname: "100.117.60.97", username: "jo", port: 22 };
const runner = { archiveVersion: "1.2.3" };

it.each([
  {
    name: "new host",
    installed: false,
    running: false,
    supported: true,
    action: "install",
    success: true,
  },
  {
    name: "stopped service",
    installed: true,
    running: false,
    supported: true,
    action: "restart",
    success: true,
  },
  {
    name: "connected service",
    installed: true,
    running: true,
    supported: true,
    action: "",
    success: true,
  },
  {
    name: "unsupported host",
    installed: false,
    running: false,
    supported: false,
    action: "install",
    success: false,
  },
])("release SSH lifecycle on a $name", ({ installed, running, supported, action, success }) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-persistent-ssh-"));
  try {
    const runtime = NodePath.join(home, ".rove-code/runtime/versions", runner.archiveVersion);
    NodeFS.mkdirSync(runtime, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(runtime, ".install-complete"), `${runner.archiveVersion}\n`);
    NodeFS.writeFileSync(
      NodePath.join(runtime, "rove"),
      `#!/bin/sh
set -eu
case "$1" in
  --version) printf 'rove v1.2.3\\n' ;;
  __ssh-helper)
    case "$2" in
      runtime-port) ${running ? "printf '42 3773'" : "exit 1"} ;;
      wait-ready) exit 0 ;;
      wait-service) printf '42 3773' ;;
      *) exit 1 ;;
    esac ;;
  service)
    case "$2" in
      status) printf '{"installed":${installed}}\\n' ;;
      install|restart) printf '%s\\n' "$2" >>"$HOME/actions"; ${supported ? "exit 0" : "exit 1"} ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const launched = NodeChildProcess.spawnSync("/bin/sh", ["-s", "--", remoteStateKey(target)], {
      input: buildRemoteLaunchScript(runner),
      env: { ...process.env, HOME: home },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(launched.error).toBeUndefined();
    expect(launched.status === 0).toBe(success);
    const actions = NodePath.join(home, "actions");
    expect(NodeFS.existsSync(actions) ? NodeFS.readFileSync(actions, "utf8").trim() : "").toBe(
      action,
    );
    if (success) {
      expect(JSON.parse(launched.stdout.trim())).toEqual({
        remotePort: 3773,
        serverKind: "external",
      });
      const stopped = NodeChildProcess.spawnSync("/bin/sh", ["-s"], {
        input: buildRemoteStopScript(target),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(stopped.status).toBe(0);
      expect(NodeFS.existsSync(actions) ? NodeFS.readFileSync(actions, "utf8").trim() : "").toBe(
        action,
      );
      expect(NodeFS.existsSync(NodePath.join(runtime, "rove"))).toBe(true);
    } else {
      expect(
        NodeFS.existsSync(
          NodePath.join(home, ".rove-code/ssh-launch", remoteStateKey(target), "managed"),
        ),
      ).toBe(false);
    }
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
