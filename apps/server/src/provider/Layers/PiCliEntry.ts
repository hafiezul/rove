// @effect-diagnostics nodeBuiltinImport:off - Runs at Pi worker startup, outside the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";
import * as RuntimePredicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { PI_CLI_ENTRY_ENV } from "../../cli/piCli.ts";

const PiPackageManifest = Schema.Struct({
  bin: Schema.Union([Schema.String, Schema.Struct({ pi: Schema.String })]),
});
const decodePiPackageManifest = Schema.decodeUnknownSync(Schema.fromJsonString(PiPackageManifest));

/** The `pi` bin script of the SDK this process hosts. */
function resolvePiCliEntry(packageDir = getPackageDir()): string {
  const { bin } = decodePiPackageManifest(
    NodeFS.readFileSync(NodePath.join(packageDir, "package.json"), "utf8"),
  );
  return NodePath.resolve(packageDir, RuntimePredicate.isString(bin) ? bin : bin.pi);
}

/**
 * Make this process relaunchable as the `pi` CLI.
 *
 * Pi extensions start subagents as `process.execPath process.argv[1] ...piArgs`
 * (see Pi's `examples/extensions/subagent`). Inside Rove, argv[1] is the Pi
 * runtime worker, which only speaks Rove's IPC protocol. Pointing it at the
 * hosted SDK's CLI lets those children run the same Pi, under the same runtime:
 * Electron can read the SDK inside app.asar because children inherit
 * ELECTRON_RUN_AS_NODE, and plain Node reads it from disk.
 */
export function exposePiCliEntry(): void {
  const entry = resolvePiCliEntry();
  process.argv[1] = entry;
  // A single executable cannot run a script path, so its entrypoint dispatches it.
  if (NodeSea.isSea()) process.env[PI_CLI_ENTRY_ENV] = entry;
}
