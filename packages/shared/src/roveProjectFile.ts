import * as Exit from "effect/Exit";
import type * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";

import { RoveProjectFile, ROVE_PROJECT_FILE_SCHEMA_URL } from "@rove-code/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `t3.json` file contents (lenient JSONC string) and the
 * decoded {@link RoveProjectFile}.
 */
export const RoveProjectFileFromJson = fromLenientJson(RoveProjectFile);

const decodeRoveProjectFile = Schema.decodeExit(RoveProjectFileFromJson);

interface RoveProjectFileJsonSchema extends JsonSchema.JsonSchema {
  readonly $schema: string;
  readonly $id: string;
  $defs?: JsonSchema.Definitions;
}

/**
 * Decode raw `t3.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseRoveProjectFile(contents: string): RoveProjectFile | null {
  const decoded = decodeRoveProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the publishable JSON Schema document for `t3.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link ROVE_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildRoveProjectFileJsonSchema(): RoveProjectFileJsonSchema {
  // Closed objects, as before effect rc.113 changed the generator default;
  // editors then flag unknown keys in t3.json.
  const document = Schema.toJsonSchemaDocument(RoveProjectFile, { onExcessProperty: "error" });
  const jsonSchema: RoveProjectFileJsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: ROVE_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
