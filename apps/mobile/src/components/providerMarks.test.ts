import { expect, it } from "vite-plus/test";

import { resolveProviderMark } from "./providerMarks";

it("resolves a distinct mark for every supported provider driver", () => {
  const drivers = ["codex", "claudeAgent", "pi", "opencode", "cursor", "grok"];

  const unresolved = drivers.filter((driver) => resolveProviderMark(driver) === undefined);
  expect(unresolved).toEqual([]);

  const markIds = drivers.map((driver) => resolveProviderMark(driver)?.id);
  expect(new Set(markIds).size).toBe(drivers.length);
});

it("renders no mark rather than a wrong brand for unknown drivers", () => {
  expect(resolveProviderMark("somethingElse")).toBeUndefined();
  expect(resolveProviderMark(undefined)).toBeUndefined();
  expect(resolveProviderMark(null)).toBeUndefined();
});
