import type { Json } from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const LEGACY_PROJECT_FILE_NAME = "t3.json";
export const LEGACY_SERVICE_LAUNCHER_CONTEXT_ENV = "T3_SERVICE_LAUNCHER_CONTEXT";
export const LEGACY_BOOT_SERVICE_UNIT_ENV = "T3_BOOT_SERVICE_UNIT";
export const LEGACY_RELAY_CLIENT_IDS = ["t3-mobile", "t3-web"] as const;
export const COMPOSER_CONTEXT_READ_HTML_ATTRIBUTES = [
  "data-rove-context-fragment",
  "data-t3-context-fragment",
] as const;
export const COMPOSER_CONTEXT_READ_PROTOCOLS = ["rove-context", "t3-context"] as const;
export const ASSISTANT_CITATION_READ_PROTOCOLS = ["rove-citation", "t3-citation"] as const;
export const COMPOSER_ATTACHMENT_READ_DIRECTORIES = [
  "rove-composer-attachments",
  "t3-composer-attachments",
] as const;
export const CAPTURE_HELPER_READ_MARKERS = [
  "X-RoveCode-Capture-Helper=true",
  "X-T3Code-Capture-Helper=true",
] as const;

const THEME_IDS = new Map([
  ["t3-chat", "plum"],
  ["t3-chat-dark", "plum-dark"],
  ["t3-grove", "grove"],
  ["t3-ocean", "ocean"],
  ["t3-ember", "ember"],
  ["t3-iris", "iris"],
]);
export const LEGACY_THEME_IDS = [...THEME_IDS.keys()];

const STORAGE_KEYS = new Map([
  ["rove.pullRequests.preferences", "t3.pullRequests.preferences"],
  ["rove.pullRequests.detail", "t3.pullRequests.detail"],
  ["rove:chatgpt-sharing-welcome:v1", "t3:chatgpt-sharing-welcome:v1"],
  ["rove.backgroundActivity.clientId", "t3.backgroundActivity.clientId"],
]);
const PROPERTY_NAMES = new Map([
  ["t3Home", "roveHome"],
  ["t3CodeRange", "roveCodeRange"],
  ["allT3", "allRove"],
]);
const VALUE_NAMES = new Map([
  ["providerKind", new Map([["t3_relay", "rove_relay"]])],
  ["owner", new Map([["t3", "rove"]])],
  ["credentialOwner", new Map([["t3", "rove"]])],
  ...["themeId", "lightThemeId", "darkThemeId", "theme"].map(
    (field) => [field, THEME_IDS] as const,
  ),
]);

export function migrateRoveThemeId(value: string): string {
  return THEME_IDS.get(value) ?? value;
}

/** Only app-owned JSON is eligible. Conversation text and opaque credentials stay unchanged. */
export function migrateRoveSavedState(value: Json): Json {
  if (Array.isArray(value)) {
    let changed: Json[] | undefined;
    for (let index = 0; index < value.length; index++) {
      const entry = value[index]!;
      const migrated = migrateRoveSavedState(entry);
      if (migrated !== entry) changed ??= value.slice();
      if (changed) changed[index] = migrated;
    }
    return changed ?? value;
  }
  if (value === null || typeof value !== "object") return value;
  let changed: { [key: string]: Json } | undefined;
  const entries = Object.entries<Json>(value);
  for (const [field, entry] of entries) {
    const name = PROPERTY_NAMES.get(field) ?? field;
    if (name !== field && Object.hasOwn(value, name)) {
      changed ??= Object.fromEntries(entries);
      delete changed[field];
      continue;
    }
    const migrated =
      typeof entry === "string"
        ? (VALUE_NAMES.get(name)?.get(entry) ?? entry)
        : migrateRoveSavedState(entry);
    if (name !== field || migrated !== entry) {
      changed ??= Object.fromEntries(entries);
      if (name !== field) delete changed[field];
      changed[name] = migrated;
    }
  }
  return changed ?? value;
}

export const decodeMigratedRoveJson = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
) => {
  const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
  const decode = Schema.decodeUnknownEffect(schema);
  return (raw: string) =>
    decodeJson(raw).pipe(Effect.map(migrateRoveSavedState), Effect.flatMap(decode));
};

export const ROVE_CHECKPOINT_REFS_PREFIX = "refs/rove/checkpoints";
export const LEGACY_CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function legacyRoveCheckpointRef(ref: string): string | undefined {
  const prefix = `${ROVE_CHECKPOINT_REFS_PREFIX}/`;
  return ref.startsWith(prefix)
    ? `${LEGACY_CHECKPOINT_REFS_PREFIX}/${ref.slice(prefix.length)}`
    : undefined;
}

export function legacyRoveCookieName(name: string): string | undefined {
  if (name.startsWith("rove_session")) return name.replace(/^rove_session/, "t3_session");
  if (name.startsWith("rove_dev_session_"))
    return name.replace(/^rove_dev_session_/, "t3_dev_session_");
  return undefined;
}

export function readMigratedRoveStorage(
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void },
  key: string,
): string | null {
  const current = storage.getItem(key);
  if (current !== null) return current;
  const detailPrefix = "rove.pullRequests.detail:";
  const legacyKey =
    STORAGE_KEYS.get(key) ??
    (key.startsWith(detailPrefix)
      ? `${STORAGE_KEYS.get("rove.pullRequests.detail")}:${key.slice(detailPrefix.length)}`
      : undefined);
  if (legacyKey === undefined) return null;
  const previous = storage.getItem(legacyKey);
  if (previous !== null) {
    try {
      storage.setItem(key, previous);
    } catch {
      // A denied write must not make an existing preference unreadable.
    }
  }
  return previous;
}
