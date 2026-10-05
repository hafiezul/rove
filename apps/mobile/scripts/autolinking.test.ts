import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

const mobileRoot = fileURLToPath(new URL("../", import.meta.url));
const mobileRequire = createRequire(Path.join(mobileRoot, "package.json"));
const expoRoot = Path.dirname(mobileRequire.resolve("expo/package.json"));
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
  const { stdout } = await promisify(execFile)(process.execPath, [
    Path.join(expoRoot, "bin", "autolinking"),
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
  const localRoot = Path.join(mobileRoot, "modules") + Path.sep;
  const localProjects = projects.filter((project) => project.sourceDir.startsWith(localRoot));
  expect(localProjects.length).toBeGreaterThan(0);
  for (const project of localProjects) {
    const gradle = await readFile(Path.join(project.sourceDir, "build.gradle"), "utf8");
    for (const dependency of gradle.matchAll(/project\(['"]:([^'"]+)['"]\)/g)) {
      expect(names, `${project.name} depends on missing project ${dependency[1]}`).toContain(
        dependency[1],
      );
    }
  }
});
