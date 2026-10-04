import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveServerConfig } from "../cli/config.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const flags = (baseDir: string) => ({
  mode: Option.none<"web" | "desktop">(),
  port: Option.none<number>(),
  host: Option.none<string>(),
  baseDir: Option.some(baseDir),
  cwd: Option.none<string>(),
  devUrl: Option.none<URL>(),
  noBrowser: Option.none<boolean>(),
  bootstrapFd: Option.none<number>(),
  autoBootstrapProjectFromCwd: Option.none<boolean>(),
  logWebSocketEvents: Option.none<boolean>(),
  tailscaleServeEnabled: Option.none<boolean>(),
  tailscaleServePort: Option.none<number>(),
});

it.layer(NodeServices.layer)("persistent host launch configuration", (it) => {
  it.effect("reuses the connection route on every startup and respects explicit overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "rove-host-config-" });
      yield* fs.makeDirectory(path.join(baseDir, "runtime"));
      yield* fs.writeFileString(
        path.join(baseDir, "runtime", "service-config.json"),
        encodeJson({
          host: "100.117.60.97",
          port: 4773,
          tailscaleServeEnabled: true,
          tailscaleServePort: 8443,
        }),
      );
      const resolve = (input = flags(baseDir)) =>
        resolveServerConfig(input, Option.none()).pipe(
          Effect.provide(NetService.layer),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        );
      for (const config of [yield* resolve(), yield* resolve()]) {
        expect(config.host).toBe("100.117.60.97");
        expect(config.port).toBe(4773);
        expect(config.tailscaleServeEnabled).toBe(true);
        expect(config.tailscaleServePort).toBe(8443);
      }
      const overridden = yield* resolve({
        ...flags(baseDir),
        host: Option.some("127.0.0.1"),
        port: Option.some(5773),
        tailscaleServeEnabled: Option.some(false),
      });
      expect(overridden.host).toBe("127.0.0.1");
      expect(overridden.port).toBe(5773);
      expect(overridden.tailscaleServeEnabled).toBe(false);
      const desktop = yield* resolve({ ...flags(baseDir), mode: Option.some("desktop") });
      expect(desktop.host).toBe("127.0.0.1");
      expect(desktop.tailscaleServeEnabled).toBe(false);
    }),
  );

  it.effect("fails closed when a saved port is invalid", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "rove-host-config-invalid-" });
      yield* fs.makeDirectory(path.join(baseDir, "runtime"));
      yield* fs.writeFileString(
        path.join(baseDir, "runtime", "service-config.json"),
        encodeJson({
          host: "0.0.0.0",
          port: -1,
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        }),
      );
      const result = yield* resolveServerConfig(flags(baseDir), Option.none()).pipe(
        Effect.provide(NetService.layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        Effect.exit,
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
