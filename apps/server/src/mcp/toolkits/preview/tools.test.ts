import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { PreviewToolkit } from "./tools.ts";
import * as RuntimePredicate from "effect/Predicate";
import type { Json as SchemaJson } from "effect/Schema";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || !(RuntimePredicate.isObjectOrArray(schema) || schema === null)) return false;
  const // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
    record = schema as Record<string, SchemaJson>;
  if (RuntimePredicate.isString(record.description) && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

const schemaHasMultipleAllOfDescriptions = (schema: unknown): boolean => {
  if (!schema || !(RuntimePredicate.isObjectOrArray(schema) || schema === null)) return false;
  const // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
    record = schema as Record<string, SchemaJson>;
  const allOf = Array.isArray(record.allOf) ? record.allOf : [];
  const // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
    descriptionCount = allOf.filter(
      (member) =>
        RuntimePredicate.isObjectOrArray(member) &&
        RuntimePredicate.isString((member as Record<string, SchemaJson>).description),
    ).length;
  return descriptionCount > 1 || Object.values(record).some(schemaHasMultipleAllOfDescriptions);
};

it("exports provider-compatible object schemas with described parameters", () => {
  for (const tool of Object.values(PreviewToolkit.tools)) {
    const // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
      schema = Tool.getJsonSchema(tool) as {
        readonly type?: unknown;
        readonly properties?: Readonly<Record<string, SchemaJson>>;
        readonly anyOf?: unknown;
        readonly oneOf?: unknown;
      };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    if (tool.name === "preview_navigate") {
      expect(schemaHasMultipleAllOfDescriptions(schema)).toBe(false);
    }
    expect(
      schema.properties?.tabId,
      `${tool.name} must allow an explicit collaborative browser tab target`,
    ).toBeDefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass`,
      ).toBe(true);
    }
  }
});
