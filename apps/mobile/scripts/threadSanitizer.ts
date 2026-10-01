// @effect-diagnostics nodeBuiltinImport:off - Probes the host toolchain before native regressions run.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Whether this host can run ThreadSanitizer binaries. Some macOS releases ship
 * a TSan runtime that crashes before `main`, so the native race regressions can
 * only report the toolchain there, not the code under test.
 */
export function threadSanitizerRuns(): boolean {
  // oxlint-disable-next-line rove/no-global-process-runtime -- The probe only targets the host compiler.
  if (NodeOS.platform() !== "darwin") return false;
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-tsan-probe-"));
  try {
    const source = NodePath.join(directory, "probe.c");
    const executable = NodePath.join(directory, "probe");
    NodeFS.writeFileSync(source, "int main(void) { return 0; }\n");
    NodeChildProcess.execFileSync("clang", ["-fsanitize=thread", source, "-o", executable], {
      stdio: "ignore",
      timeout: 30_000,
    });
    return (
      NodeChildProcess.spawnSync(executable, { stdio: "ignore", timeout: 30_000 }).status === 0
    );
  } catch {
    return false;
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}
