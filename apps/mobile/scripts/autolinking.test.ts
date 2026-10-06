import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

const mobileRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const mobileRequire = NodeModule.createRequire(NodePath.join(mobileRoot, "package.json"));
const expoRoot = NodePath.dirname(mobileRequire.resolve("expo/package.json"));
const ModuleGraph = Schema.Struct({
  modules: Schema.Array(
    Schema.Struct({
      projects: Schema.optionalKey(
        Schema.Array(Schema.Struct({ name: Schema.String, sourceDir: Schema.String })),
      ),
    }),
  ),
});

it("resolves every local Android module's project dependencies through Expo autolinking", async () => {
  const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(process.execPath, [
    NodePath.join(expoRoot, "bin", "autolinking"),
    "resolve",
    "--platform",
    "android",
    "--json",
    "--project-root",
    mobileRoot,
  ]);
  const graph = Schema.decodeUnknownSync(Schema.fromJsonString(ModuleGraph))(stdout);
  const projects = graph.modules.flatMap((module) => module.projects ?? []);
  const names = new Set(projects.map((project) => project.name));
  const localRoot = NodePath.join(mobileRoot, "modules") + NodePath.sep;
  const localProjects = projects.filter((project) => project.sourceDir.startsWith(localRoot));
  expect(localProjects.length).toBeGreaterThan(0);
  for (const project of localProjects) {
    const gradle = await NodeFSP.readFile(NodePath.join(project.sourceDir, "build.gradle"), "utf8");
    for (const dependency of gradle.matchAll(/project\(['"]:([^'"]+)['"]\)/g)) {
      expect(names, `${project.name} depends on missing project ${dependency[1]}`).toContain(
        dependency[1],
      );
    }
  }
});
