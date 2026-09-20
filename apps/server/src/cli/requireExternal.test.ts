// @effect-diagnostics nodeBuiltinImport:off - Exercise Node's real export-condition resolution.
import * as NodeModule from "node:module";
import { describe, expect, it } from "@effect/vitest";

import { requireCliExternal } from "./requireExternal.ts";

const require = NodeModule.createRequire(import.meta.url);

describe("standalone executable external packages", () => {
  it("loads Pi's import-only SDK and OAuth entry points through require", () => {
    expect(requireCliExternal("@earendil-works/pi-coding-agent")).toHaveProperty(
      "createAgentSession",
      expect.any(Function),
    );
    expect(requireCliExternal("@earendil-works/pi-ai/bun-oauth")).toHaveProperty(
      "registerBunOAuthFlows",
      expect.any(Function),
    );
    // The temporary export-condition hook must not leak into unrelated loads.
    expect(() => require.resolve("@earendil-works/pi-coding-agent")).toThrow();
  });

  it("restores resolution after a failed Pi load", () => {
    expect(() => requireCliExternal("@earendil-works/missing-package")).toThrow();
    expect(() => require.resolve("@earendil-works/pi-coding-agent")).toThrow();
    expect(requireCliExternal("ws")).toHaveProperty("WebSocketServer", expect.any(Function));
  });
});
