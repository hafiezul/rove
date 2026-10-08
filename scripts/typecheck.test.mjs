import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { HostProcessPlatform } from "@rove-code/shared/hostProcess";

import rootPackage from "../package.json" with { type: "json" };
import contractsPackage from "../packages/contracts/package.json" with { type: "json" };
import webPackage from "../apps/web/package.json" with { type: "json" };
import desktopPackage from "../apps/desktop/package.json" with { type: "json" };
import baseConfig from "../tsconfig.base.json" with { type: "json" };
import { bunTypecheckTasks } from "./lib/bun-typecheck.ts";

const repository = NodeURL.fileURLToPath(new URL("../", import.meta.url));
let directory;
let app;

const writeJson = (path, value) => NodeFS.writeFileSync(path, JSON.stringify(value));

beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-typecheck-"));
  app = NodePath.join(directory, "packages", "app");
  NodeFS.mkdirSync(NodePath.join(app, "src"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(directory, "packages", "shared", "src"), { recursive: true });
  writeJson(NodePath.join(directory, "package.json"), {
    name: "@rove-code/typecheck-fixture",
    private: true,
    type: "module",
    packageManager: rootPackage.packageManager,
    scripts: {
      typecheck: rootPackage.scripts.typecheck,
      "typecheck:effect": rootPackage.scripts["typecheck:effect"],
    },
  });
  NodeFS.writeFileSync(
    NodePath.join(directory, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n",
  );
  writeJson(NodePath.join(app, "package.json"), {
    name: "@rove-code/typecheck-app-fixture",
    private: true,
    type: "module",
    scripts: {
      typecheck: contractsPackage.scripts.typecheck,
      "typecheck:effect": contractsPackage.scripts["typecheck:effect"],
    },
  });
  writeJson(NodePath.join(app, "tsconfig.json"), {
    extends: "../../tsconfig.base.json",
    include: ["src"],
  });
  writeJson(NodePath.join(directory, "tsconfig.base.json"), {
    ...baseConfig,
    compilerOptions: { ...baseConfig.compilerOptions, types: [] },
  });
  const linkType = HostProcessPlatform.defaultValue() === "win32" ? "junction" : "dir";
  NodeFS.symlinkSync(
    NodePath.join(repository, "node_modules"),
    NodePath.join(directory, "node_modules"),
    linkType,
  );
  NodeFS.symlinkSync(
    NodePath.join(repository, "packages", "contracts", "node_modules"),
    NodePath.join(app, "node_modules"),
    linkType,
  );
});

afterEach(() => {
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

const check = (script = "typecheck", flags = []) => {
  const result = NodeChildProcess.spawnSync("vp", ["run", ...flags, script], {
    cwd: directory,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

it("rechecks imported changes, newly included files, and inherited compiler options", () => {
  const shared = NodePath.join(directory, "packages", "shared", "src", "value.ts");
  const entry = NodePath.join(app, "src", "index.ts");
  NodeFS.writeFileSync(shared, "export type Value = number;\n");
  NodeFS.writeFileSync(
    entry,
    'import type { Value } from "../../shared/src/value.ts";\nexport const value: Value = 42;\n',
  );
  expect(check().status).toBe(0);
  expect(check().status).toBe(0);

  NodeFS.writeFileSync(shared, "export type Value = string;\n");
  const importedError = check();
  expect(importedError.status).toBe(1);
  expect(importedError.output).toContain("TS2322");
  NodeFS.writeFileSync(shared, "export type Value = number;\n");
  expect(check().status).toBe(0);

  const added = NodePath.join(app, "src", "added.ts");
  NodeFS.writeFileSync(added, 'export const invalid: number = "not a number";\n');
  const addedError = check();
  expect(addedError.status).toBe(1);
  expect(addedError.output).toContain("added.ts");
  expect(addedError.output).toContain("TS2322");
  NodeFS.unlinkSync(added);

  NodeFS.writeFileSync(entry, "export const nullable: number = undefined;\n");
  const strictError = check();
  expect(strictError.status).toBe(1);
  expect(strictError.output).toContain("TS2322");
  writeJson(NodePath.join(directory, "tsconfig.base.json"), {
    ...baseConfig,
    compilerOptions: {
      ...baseConfig.compilerOptions,
      types: [],
      strict: false,
      exactOptionalPropertyTypes: false,
    },
  });
  expect(check().status).toBe(0);
});

it("keeps Effect errors enforced by the full verification command", () => {
  NodeFS.writeFileSync(
    NodePath.join(app, "src", "index.ts"),
    'import * as Effect from "effect/Effect";\nexport const probe = Effect.sync(() => console.log("probe"));\n',
  );
  const result = check("typecheck:effect");
  expect(result.status).toBe(1);
  expect(result.output).toContain("TS377065");
  expect(result.output).toContain("globalConsoleInEffect");
});

for (const client of [webPackage, desktopPackage]) {
  describe(`${client.name} cached typecheck`, () => {
    beforeEach(() => {
      writeJson(NodePath.join(app, "package.json"), {
        name: "@rove-code/typecheck-app-fixture",
        private: true,
        type: "module",
        scripts: {
          typecheck: client.scripts.typecheck,
          "typecheck:effect": client.scripts["typecheck:effect"],
        },
      });
      NodeFS.writeFileSync(
        NodePath.join(app, "vite.config.js"),
        `export default ${JSON.stringify({ run: { tasks: bunTypecheckTasks } })};\n`,
      );
      NodeFS.writeFileSync(
        NodePath.join(app, "src", "index.ts"),
        "export const value: number = 42;\n",
      );
    });

    it("reuses successes but rechecks shared edits, added files, and deleted imports", () => {
      const shared = NodePath.join(directory, "packages", "shared", "src", "value.ts");
      const entry = NodePath.join(app, "src", "index.ts");
      NodeFS.writeFileSync(shared, "export type Value = number;\n");
      NodeFS.writeFileSync(
        entry,
        'import type { Value } from "../../shared/src/value.ts";\nexport const value: Value = 42;\n',
      );
      expect(check().status).toBe(0);
      const unchanged = check();
      expect(unchanged.status).toBe(0);
      expect(unchanged.output).toContain("cache hit");

      NodeFS.writeFileSync(shared, "export type Value = string;\n");
      const importedError = check();
      expect(importedError.status).toBe(1);
      expect(importedError.output).toContain("TS2322");
      NodeFS.writeFileSync(shared, "export type Value = number;\n");
      expect(check().status).toBe(0);

      const added = NodePath.join(app, "src", "added.ts");
      NodeFS.writeFileSync(added, 'export const invalid: number = "not a number";\n');
      const addedError = check();
      expect(addedError.status).toBe(1);
      expect(addedError.output).toContain("TS2322");
      NodeFS.unlinkSync(added);
      expect(check().status).toBe(0);
      NodeFS.unlinkSync(shared);
      const removedImport = check();
      expect(removedImport.status).toBe(1);
      expect(removedImport.output).toContain("TS2307");
    });

    it("invalidates successes when dependency pins, patches, or manifests change", () => {
      for (const [path, initial, updated] of [
        ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n", "lockfileVersion: '9.0'\n# changed pin\n"],
        ["patches/fixture.patch", "initial patch\n", "updated patch\n"],
      ]) {
        const file = NodePath.join(directory, path);
        NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
        NodeFS.writeFileSync(file, initial);
        expect(check().status).toBe(0);
        expect(check().output).toContain("cache hit");
        NodeFS.writeFileSync(file, updated);
        const metadataChange = check();
        expect(metadataChange.status).toBe(0);
        expect(metadataChange.output).toContain("cache miss");
      }

      const manifestPath = NodePath.join(directory, "package.json");
      const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
      writeJson(manifestPath, {
        ...manifest,
        devDependencies: { bun: rootPackage.devDependencies.bun },
      });
      const manifestChange = check();
      expect(manifestChange.status).toBe(0);
      expect(manifestChange.output).toContain("cache miss");
    });

    it("invalidates a success when inherited compiler options change", () => {
      const configPath = NodePath.join(directory, "tsconfig.base.json");
      NodeFS.writeFileSync(
        NodePath.join(app, "src", "index.ts"),
        "export const nullable: number = undefined;\n",
      );
      writeJson(configPath, {
        ...baseConfig,
        compilerOptions: {
          ...baseConfig.compilerOptions,
          types: [],
          strict: false,
          exactOptionalPropertyTypes: false,
        },
      });
      expect(check().status).toBe(0);
      expect(check().output).toContain("cache hit");
      writeJson(configPath, {
        ...baseConfig,
        compilerOptions: { ...baseConfig.compilerOptions, types: [] },
      });
      const configError = check();
      expect(configError.status).toBe(1);
      expect(configError.output).toContain("TS2322");
    });

    it("allows an explicit uncached recheck", () => {
      expect(check().status).toBe(0);
      expect(check().output).toContain("cache hit");
      const forced = check("typecheck", ["--no-cache"]);
      expect(forced.status).toBe(0);
      expect(forced.output).not.toContain("cache hit");
    });
  });
}
