import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

// 0.82.0 moved `get_commands` skill provenance from `path`/`location` to
// structured `sourceInfo`, which the T3 skill probe relies on.
export const PI_MINIMUM_VERSION = "0.82.0";

// Extension loading is managed through the per-instance trusted-extension
// setting: T3 Code owns every --extension argument so raw launch arguments
// cannot bypass the trusted-extension policy.
const MANAGED_FLAGS = new Set([
  "continue",
  "extension",
  "fork",
  "mode",
  "no-extensions",
  "no-session",
  "resume",
  "session",
  "session-dir",
  "session-id",
]);
const MANAGED_SHORT_FLAGS = new Set(["-c", "-r"]);

// Project-trust overrides (`--approve` / `--no-approve`) are intentionally not
// managed: they are the only way to let the no-session probe (and sessions)
// see project-level skills and other trusted resources in RPC mode, where Pi
// never shows a trust prompt.

export type PiLaunchPlan =
  | {
      readonly _tag: "Success";
      readonly args: ReadonlyArray<string>;
      readonly environment: NodeJS.ProcessEnv;
    }
  | { readonly _tag: "Failure"; readonly message: string };

export function validatePiLaunchArgs(launchArgs: string): string | undefined {
  const managedFlag = tokenizeCliArgs(launchArgs).find((arg) => {
    if (MANAGED_SHORT_FLAGS.has(arg)) return true;
    if (!arg.startsWith("--")) return false;
    return MANAGED_FLAGS.has(arg.slice(2).split("=", 1)[0]!);
  });
  return managedFlag
    ? `${managedFlag} is managed by T3 Code and cannot be set in Pi launch arguments.`
    : undefined;
}

/**
 * Environment escape hatch for an extra trusted extension path without
 * editing settings, mirroring how Pi's own escape hatches work. Instance
 * environment is merged into the probe/session environment by the driver.
 */
export const T3CODE_PI_EXTENSION_ENV = "T3CODE_PI_EXTENSION";

/** The only --extension arguments Pi ever receives: the selected trusted paths. */
const trustedExtensionArgs = (trustedExtensions: ReadonlyArray<string>): ReadonlyArray<string> =>
  trustedExtensions.flatMap((path) => {
    const trimmed = path.trim();
    return trimmed.length > 0 ? ["--extension", trimmed] : [];
  });

const resolveTrustedExtensions = (input: {
  readonly trustedExtensions: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
}): ReadonlyArray<string> => {
  const envExtension = input.environment[T3CODE_PI_EXTENSION_ENV]?.trim();
  return envExtension ? [...input.trustedExtensions, envExtension] : input.trustedExtensions;
};

export function buildPiLaunchPlan(input: {
  readonly configDirectory: string;
  readonly launchArgs: string;
  readonly trustedExtensions: ReadonlyArray<string>;
  readonly sessionDirectory: string;
  readonly sessionId: string;
  readonly environment?: NodeJS.ProcessEnv;
}): PiLaunchPlan {
  const userArgs = tokenizeCliArgs(input.launchArgs);
  const validationError = validatePiLaunchArgs(input.launchArgs);
  if (validationError) {
    return {
      _tag: "Failure",
      message: validationError,
    };
  }

  const trustedExtensions = resolveTrustedExtensions({
    trustedExtensions: input.trustedExtensions,
    environment: input.environment ?? {},
  });

  return {
    _tag: "Success",
    args: [
      ...userArgs,
      "--mode",
      "rpc",
      "--no-extensions",
      ...trustedExtensionArgs(trustedExtensions),
      "--session-dir",
      input.sessionDirectory,
      "--session-id",
      input.sessionId,
    ],
    environment: input.configDirectory ? { PI_CODING_AGENT_DIR: input.configDirectory } : {},
  };
}

/**
 * Launch plan for the no-session probe process. The probe issues
 * `get_available_models`, per-model thinking-level queries, and
 * `get_commands` (skill discovery) and must not create a native session.
 */
export function buildPiModelProbeLaunchPlan(input: {
  readonly configDirectory: string;
  readonly launchArgs: string;
  readonly trustedExtensions: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
}): PiLaunchPlan {
  const validationError = validatePiLaunchArgs(input.launchArgs);
  if (validationError) {
    return {
      _tag: "Failure",
      message: validationError,
    };
  }

  const trustedExtensions = resolveTrustedExtensions({
    trustedExtensions: input.trustedExtensions,
    environment: input.environment ?? {},
  });

  return {
    _tag: "Success",
    args: [
      ...tokenizeCliArgs(input.launchArgs),
      "--mode",
      "rpc",
      "--no-extensions",
      ...trustedExtensionArgs(trustedExtensions),
      "--no-session",
    ],
    environment: input.configDirectory ? { PI_CODING_AGENT_DIR: input.configDirectory } : {},
  };
}

export type PiVersionStatus =
  | { readonly _tag: "Supported"; readonly version: string }
  | { readonly _tag: "Unsupported"; readonly version: string }
  | { readonly _tag: "Invalid" };

export function parsePiVersion(output: string): PiVersionStatus {
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return { _tag: "Invalid" };

  const version = `${match[1]}.${match[2]}.${match[3]}`;
  const parsed = match.slice(1).map(Number);
  const minimum = PI_MINIMUM_VERSION.split(".").map(Number);
  for (const [index, part] of parsed.entries()) {
    const minimumPart = minimum[index]!;
    if (part > minimumPart) return { _tag: "Supported", version };
    if (part < minimumPart) return { _tag: "Unsupported", version };
  }
  return { _tag: "Supported", version };
}
