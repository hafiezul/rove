import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRoveProjectFileJsonSchema,
  parseRoveProjectFile,
  RoveProjectFileFromJson,
} from "./roveProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(RoveProjectFileFromJson);
const decodeProjectJsonSchema = Schema.decodeUnknownSync(
  Schema.Struct({
    properties: Schema.Record(
      Schema.String,
      Schema.Struct({
        description: Schema.optional(Schema.String),
        items: Schema.optional(
          Schema.Struct({
            properties: Schema.Record(Schema.String, Schema.Unknown),
            required: Schema.Array(Schema.String),
          }),
        ),
      }),
    ),
    required: Schema.optional(Schema.Array(Schema.String)),
  }),
);

describe("buildRoveProjectFileJsonSchema", () => {
  it("emits a draft 2020-12 schema with the published $id", () => {
    const schema = buildRoveProjectFileJsonSchema();

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://t3.codes/schema/t3.json");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("documents every supported field", () => {
    const schema = decodeProjectJsonSchema(buildRoveProjectFileJsonSchema());

    expect(Object.keys(schema.properties).sort()).toEqual([
      "$schema",
      "defaultThreadEnvMode",
      "iconPath",
      "scripts",
      "worktreeSubmodules",
    ]);
    expect(schema.required).toBeUndefined();
    expect(schema.properties.iconPath?.description).toContain("Workspace-relative path");
    expect(schema.properties.defaultThreadEnvMode?.description).toContain("new threads start");

    const script = schema.properties.scripts?.items;
    expect(script?.required).toEqual(["name", "command"]);
    expect(Object.keys(script?.properties ?? {}).sort()).toEqual([
      "async",
      "autoOpenPreview",
      "command",
      "icon",
      "name",
      "previewUrl",
      "runOnWorktreeCreate",
    ]);
  });

  it("stays JSON-serializable", () => {
    const schema = buildRoveProjectFileJsonSchema();
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});

describe("RoveProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });

  it("fails on malformed JSON", () => {
    expect(() => decodeJson("{ not json")).toThrow();
  });
});

describe("parseRoveProjectFile", () => {
  it("returns the decoded file for valid contents", () => {
    expect(parseRoveProjectFile('{ "defaultThreadEnvMode": "worktree" }')).toEqual({
      defaultThreadEnvMode: "worktree",
    });
  });

  it("returns null for malformed or invalid contents", () => {
    expect(parseRoveProjectFile("{ not json")).toBeNull();
    expect(parseRoveProjectFile('{ "defaultThreadEnvMode": "spaceship" }')).toBeNull();
  });
});
