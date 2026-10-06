import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { build } from "vite-plus";
import { ROVE_PROJECT_FILE_SCHEMA_URL } from "@rove-code/contracts";
import { buildRoveProjectFileJsonSchema } from "@rove-code/shared/roveProjectFile";
import { decodeJsonResult } from "@rove-code/shared/schemaJson";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { projectFileSchemaPlugin } from "./projectFileSchema";

it.layer(NodeServices.layer)("project file schema publication", (it) => {
  describe("build output", () => {
    it.effect("emits the schema as a real web build asset instead of the SPA document", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rove-schema-build-" });
        yield* fs.writeFileString(
          path.join(root, "index.html"),
          "<!doctype html><title>Build fixture</title>",
        );
        yield* Effect.promise(() =>
          build({
            root,
            configFile: false,
            logLevel: "silent",
            plugins: [projectFileSchemaPlugin()],
            build: { outDir: "dist", emptyOutDir: true },
          }),
        );
        const raw = yield* fs.readFileString(path.join(root, "dist/schema/rove.json"));
        const schema = decodeJsonResult(Schema.Json)(raw);
        expect(Result.getOrThrow(schema)).toEqual(buildRoveProjectFileJsonSchema());
        expect(raw).toContain(ROVE_PROJECT_FILE_SCHEMA_URL);
      }),
    );
  });
});
