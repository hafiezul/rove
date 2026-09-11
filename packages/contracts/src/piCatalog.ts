import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

export const PiCatalogInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type PiCatalogInput = typeof PiCatalogInput.Type;

export const PiCatalogExtensionInfo = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  source: Schema.String,
  scope: Schema.Literals(["user", "project", "temporary"]),
  tools: Schema.Array(Schema.String),
  commands: Schema.Array(Schema.String),
});
export type PiCatalogExtensionInfo = typeof PiCatalogExtensionInfo.Type;

export const PiCatalogSnapshot = Schema.Struct({
  extensions: Schema.Array(PiCatalogExtensionInfo),
  modelProviders: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      authenticated: Schema.Boolean,
      modelCount: Schema.Number,
    }),
  ),
  warnings: Schema.Array(Schema.String),
});
export type PiCatalogSnapshot = typeof PiCatalogSnapshot.Type;

export class PiCatalogError extends Schema.TaggedErrorClass<PiCatalogError>()("PiCatalogError", {
  message: Schema.String,
}) {}
