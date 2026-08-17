import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PgDialect } from "drizzle-orm/pg-core";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks } from "../persistence/schema.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as RuntimePredicate from "effect/Predicate";
import type { Json as SchemaJson } from "effect/Schema";

describe("EnvironmentLinks", () => {
  it.effect("retains link lookup failures with user and environment identity", () => {
    const cause = new Error("database unavailable");
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relayEnvironmentLinks);
          return {
            where: () => ({
              limit: () => Effect.fail(cause),
            }),
          };
        },
      }),
    } as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const error = yield* Effect.flip(
        links.getForUser({ userId: "user-1", environmentId: "env-1" }),
      );

      expect(error).toMatchObject({
        _tag: "EnvironmentLinkLookupPersistenceError",
        userId: "user-1",
        environmentId: "env-1",
      });
      expect(error.cause).toBe(cause);
    }).pipe(
      Effect.provide(
        EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb))),
      ),
    );
  });

  it.effect("identifies delivery-user list failures without retaining key material", () => {
    const cause = new Error("database unavailable");
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relayEnvironmentLinks);
          return {
            where: () => Effect.fail(cause),
          };
        },
      }),
    } as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const error = yield* Effect.flip(
        links.listDeliveryUsersForEnvironment({
          environmentId: "env-1",
          environmentPublicKey: "sensitive-public-key-material",
        }),
      );

      expect(error).toMatchObject({
        _tag: "EnvironmentLinkUserListPersistenceError",
        operation: "list-delivery-users",
        environmentId: "env-1",
      });
      expect(error.cause).toBe(cause);
      expect(error).not.toHaveProperty("environmentPublicKey");
    }).pipe(
      Effect.provide(
        EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb))),
      ),
    );
  });

  it.effect("selects users when either notifications or Live Activities are enabled", () => {
    const whereConditions: Array<unknown> = [];
    const fakeDb = {
      select: (selection: unknown) => {
        expect(selection).toBeDefined();
        return {
          from: (table: unknown) => {
            expect(table).toBe(relayEnvironmentLinks);
            return {
              where: (condition: unknown) => {
                whereConditions.push(condition);
                return Effect.succeed([]);
              },
            };
          },
        };
      },
    } as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      expect(yield* links.listUsersForEnvironment({ environmentId: "env-1" })).toEqual([]);
      expect(whereConditions).toHaveLength(1);

      const // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
        query = new PgDialect().sqlToQuery(whereConditions[0] as never);
      expect(query.sql).toContain('"relay_environment_links"."environment_id" = $1');
      expect(query.sql).toContain('"relay_environment_links"."revoked_at" is null');
      expect(query.sql).toContain('"relay_environment_links"."notifications_enabled" = $2');
      expect(query.sql).toContain('"relay_environment_links"."live_activities_enabled" = $3');
      expect(query.sql).toContain(" or ");
      expect(query.params).toEqual(["env-1", true, true]);
    }).pipe(
      Effect.provide(
        EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb))),
      ),
    );
  });

  it.effect("revokes only the active link owned by the requesting user", () => {
    const updateValues: Array<Record<string, SchemaJson>> = [];
    const whereConditions: Array<unknown> = [];
    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(relayEnvironmentLinks);
        return {
          set: (values: Record<string, SchemaJson>) => {
            updateValues.push(values);
            return {
              where: (condition: unknown) => {
                whereConditions.push(condition);
                return {
                  returning: (selection: unknown) => {
                    expect(selection).toBeDefined();
                    return Effect.succeed([{ environmentId: "env-1" }]);
                  },
                };
              },
            };
          },
        };
      },
    } as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const revoked = yield* links.revokeForUser({
        userId: "user-1",
        environmentId: "env-1",
      });

      expect(revoked).toBe(true);
      expect(updateValues).toHaveLength(1);
      expect(updateValues[0]?.revokedAt).toEqual(updateValues[0]?.updatedAt);
      expect(RuntimePredicate.isString(updateValues[0]?.revokedAt)).toBe(true);
      expect(whereConditions).toHaveLength(1);

      const dialect = new PgDialect();
      const // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
        query = dialect.sqlToQuery(whereConditions[0] as never);
      expect(query.sql).toContain('"relay_environment_links"."user_id" = $1');
      expect(query.sql).toContain('"relay_environment_links"."environment_id" = $2');
      expect(query.sql).toContain('"relay_environment_links"."revoked_at" is null');
      expect(query.params).toEqual(["user-1", "env-1"]);
    }).pipe(
      Effect.provide(
        EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb))),
      ),
    );
  });
});
