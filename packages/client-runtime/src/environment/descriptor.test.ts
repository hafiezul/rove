import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@rove-code/contracts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { orchestrationProtocolCompatibilityError } from "../connection/compatibility.ts";
import { fetchRemoteEnvironmentDescriptor } from "./descriptor.ts";

const descriptor = {
  environmentId: "environment-test",
  label: "Existing environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
};

describe("environment descriptor transition", () => {
  it.effect("discovers a historical server so callers can show its protocol mismatch", () => {
    const requests: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      return url.endsWith("/.well-known/t3/environment")
        ? Response.json(descriptor)
        : Response.json({ message: "not found" }, { status: 404 });
    };
    return Effect.gen(function* () {
      const value = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl: "https://server.test" });
      expect(orchestrationProtocolCompatibilityError(value)?.reason).toBe("unsupported");
      expect(requests).toEqual([
        "https://server.test/.well-known/rove/environment",
        "https://server.test/.well-known/t3/environment",
      ]);
    }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));
  });

  it.effect("uses the canonical descriptor without a historical request", () => {
    const requests: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      requests.push(String(input));
      return Response.json({
        ...descriptor,
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      });
    };
    return Effect.gen(function* () {
      const value = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl: "https://server.test" });
      expect(orchestrationProtocolCompatibilityError(value)).toBeNull();
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));
  });

  it.effect("does not retry historical discovery for an unavailable canonical endpoint", () => {
    const requests: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      requests.push(String(input));
      return Response.json({ message: "unavailable" }, { status: 503 });
    };
    return Effect.gen(function* () {
      yield* Effect.flip(fetchRemoteEnvironmentDescriptor({ httpBaseUrl: "https://server.test" }));
      expect(requests).toEqual(["https://server.test/.well-known/rove/environment"]);
    }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));
  });
});
