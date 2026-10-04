import { PortSchema, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { DEFAULT_PORT } from "../config.ts";

export const SERVICE_LAUNCH_CONFIG_FILE = "service-config.json";
export const ServiceLaunchConfig = Schema.Struct({
  host: TrimmedNonEmptyString,
  port: PortSchema,
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  environmentPath: Schema.optionalKey(Schema.String),
});
export type ServiceLaunchConfig = typeof ServiceLaunchConfig.Type;
export type ServiceLaunchPatch = Partial<Omit<ServiceLaunchConfig, "environmentPath">>;

export const DEFAULT_SERVICE_LAUNCH_CONFIG: ServiceLaunchConfig = {
  host: "127.0.0.1",
  port: DEFAULT_PORT,
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
};

export const ServiceLaunchConfigJson = Schema.fromJsonString(ServiceLaunchConfig);
const decodeServiceLaunchConfig = Schema.decodeUnknownEffect(ServiceLaunchConfigJson);
export const validateServiceLaunchConfig = Schema.decodeUnknownEffect(ServiceLaunchConfig);
export const encodeServiceLaunchConfig = Schema.encodeEffect(ServiceLaunchConfigJson);

export class ServiceLaunchConfigError extends Schema.TaggedError<ServiceLaunchConfigError>()(
  "ServiceLaunchConfigError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not read the host launch configuration at ${this.path}. Repair that file before restarting the service.`;
  }
}

export const readServiceLaunchConfig = Effect.fn("cloud.serviceLaunchConfig.read")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filename = path.join(baseDir, "runtime", SERVICE_LAUNCH_CONFIG_FILE);
  return yield* fs.readFileString(filename).pipe(
    Effect.flatMap(decodeServiceLaunchConfig),
    Effect.map(Option.some),
    Effect.catchIf(
      (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
      () => Effect.succeedNone,
    ),
    Effect.mapError((cause) => new ServiceLaunchConfigError({ path: filename, cause })),
  );
});
