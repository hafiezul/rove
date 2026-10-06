import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  decodeMigratedRoveJson,
  legacyRoveCookieName,
  legacyRoveCheckpointRef,
  migrateRoveSavedState,
  migrateRoveThemeId,
  readMigratedRoveStorage,
} from "./roveMigration.ts";

describe("Rove saved-state migration", () => {
  it("canonicalizes owned fields without rewriting labels, text, or credentials", () => {
    const migrated = migrateRoveSavedState({
      t3Home: "/custom/home",
      allT3: { cpu: 4 },
      themeId: "t3-chat",
      darkThemeId: "t3-grove",
      connections: [
        { providerKind: "t3_relay", label: "T3 Environment", bearerToken: "t3env_secret" },
      ],
      text: "Keep [context](t3-context://v1/terminal/ctx_1) and this t3Home example.",
    });
    expect(migrated).toEqual({
      roveHome: "/custom/home",
      allRove: { cpu: 4 },
      themeId: "plum",
      darkThemeId: "grove",
      connections: [
        { providerKind: "rove_relay", label: "T3 Environment", bearerToken: "t3env_secret" },
      ],
      text: "Keep [context](t3-context://v1/terminal/ctx_1) and this t3Home example.",
    });
    expect(migrateRoveSavedState(migrated)).toBe(migrated);
  });

  it("keeps the canonical value when old and new fields coexist", () => {
    expect(migrateRoveSavedState({ t3Home: "/old", roveHome: "/new" })).toEqual({
      roveHome: "/new",
    });
  });

  it("does not allocate another state tree when nothing needs migration", () => {
    const state = { themeId: "custom", connections: [{ providerKind: "direct", label: "T3" }] };
    expect(migrateRoveSavedState(state)).toBe(state);
    expect(migrateRoveThemeId("custom")).toBe("custom");
    expect(migrateRoveThemeId("t3-chat-dark")).toBe("plum-dark");
  });

  it("copies a legacy preference once and never overwrites a new preference", () => {
    const values = new Map([["t3.pullRequests.preferences", "old"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(readMigratedRoveStorage(storage, "rove.pullRequests.preferences")).toBe("old");
    values.set("rove.pullRequests.preferences", "new");
    expect(readMigratedRoveStorage(storage, "rove.pullRequests.preferences")).toBe("new");
    expect(values.get("t3.pullRequests.preferences")).toBe("old");
  });

  it("keeps a legacy preference readable when the copy cannot be written", () => {
    expect(
      readMigratedRoveStorage(
        {
          getItem: (key) => (key === "t3.backgroundActivity.clientId" ? "stable-device" : null),
          setItem: () => {
            throw new Error("quota");
          },
        },
        "rove.backgroundActivity.clientId",
      ),
    ).toBe("stable-device");
  });

  it.effect("migrates cached metadata before strict schema validation", () => {
    const schema = Schema.Struct({
      roveHome: Schema.String,
      credentialOwner: Schema.Literal("rove"),
      token: Schema.String,
    });
    const decode = decodeMigratedRoveJson(schema);
    return Effect.gen(function* () {
      expect(
        yield* decode('{"t3Home":"/old/home","credentialOwner":"t3","token":"t3env_opaque"}'),
      ).toEqual({ roveHome: "/old/home", credentialOwner: "rove", token: "t3env_opaque" });
      expect(Schema.isSchemaError(yield* decode("not JSON").pipe(Effect.flip))).toBe(true);
      expect(Schema.isSchemaError(yield* decode('{"t3Home":1}').pipe(Effect.flip))).toBe(true);
    });
  });

  it("preserves the complete scope suffix of migrated cookies", () => {
    expect(legacyRoveCookieName("rove_session_3773_abcdef")).toBe("t3_session_3773_abcdef");
    expect(legacyRoveCookieName("rove_dev_session_abcdef")).toBe("t3_dev_session_abcdef");
    expect(legacyRoveCookieName("other_cookie")).toBeUndefined();
    expect(legacyRoveCheckpointRef("refs/rove/checkpoints/thread/turn/0")).toBe(
      "refs/t3/checkpoints/thread/turn/0",
    );
    expect(legacyRoveCheckpointRef("refs/heads/rove")).toBeUndefined();
    expect(legacyRoveCheckpointRef("refs/rove/checkpoints-other/thread")).toBeUndefined();
  });
});
