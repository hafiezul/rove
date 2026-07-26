import { PiSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ProcessRunner } from "../../processRunner.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import { mapPiModelCatalog, type PiModelCatalogEntry } from "./PiModels.ts";
import { mapPiSkillsToServerProviderSkills, type PiRpcSkillCommand } from "./PiSkills.ts";
import { makePiSessionRuntime, type PiSessionRuntimeError } from "./PiSessionRuntime.ts";
import {
  parsePiVersion,
  PI_MINIMUM_VERSION,
  T3CODE_PI_EXTENSION_ENV,
  validatePiLaunchArgs,
} from "./PiRuntime.ts";

const PI_DRIVER = ProviderDriverKind.make("pi");
const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
  showRuntimeModeSelector: false,
  toolAccessDescription:
    "Pi manages enabled tool access; Pi tools can run without a T3 Code per-tool confirmation.",
} as const;

export interface PiCatalogProbeInput {
  readonly binaryPath: string;
  readonly configDirectory: string;
  readonly launchArgs: string;
  readonly trustedExtensions: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

/** Result of one no-session Pi RPC probe: the model catalog plus loaded skills. */
export interface PiCatalogProbeResult {
  readonly models: ReadonlyArray<PiModelCatalogEntry>;
  readonly skills: ReadonlyArray<PiRpcSkillCommand>;
}

export type PiCatalogProbe<R = never> = (
  input: PiCatalogProbeInput,
) => Effect.Effect<PiCatalogProbeResult, PiSessionRuntimeError, R>;

/** Resolve the instance's trusted-extension selection, including the env escape hatch. */
export const resolvePiTrustedExtensions = (
  trustedExtensions: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<string> => {
  const envExtension = environment[T3CODE_PI_EXTENSION_ENV]?.trim();
  return envExtension ? [...trustedExtensions, envExtension] : trustedExtensions;
};

/**
 * Discover the exact model + thinking catalog and the loaded skill commands
 * from Pi RPC without creating a native session. Each catalog entry is
 * selected before querying its valid thinking levels because Pi exposes that
 * capability for the active model. Skills come from Pi's own `get_commands`
 * surface so the snapshot reflects exactly what the configured Pi binary
 * loaded (settings, flags, and trust rules already applied).
 */
export const discoverPiCatalog: PiCatalogProbe<ChildProcessSpawner.ChildProcessSpawner> = (input) =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* makePiSessionRuntime({
        binaryPath: input.binaryPath,
        configDirectory: input.configDirectory,
        launchArgs: input.launchArgs,
        trustedExtensions: input.trustedExtensions,
        cwd: input.cwd,
        environment: input.environment,
      });
      const initialState = yield* runtime.start();
      const [models, skills] = yield* Effect.all(
        [runtime.getAvailableModels(), runtime.getCommands()],
        { concurrency: 1 },
      );
      const catalog = yield* Effect.forEach(
        models,
        (model) =>
          Effect.gen(function* () {
            yield* runtime.setModel({ provider: model.provider, modelId: model.id });
            const [thinkingLevels, state] = yield* Effect.all(
              [runtime.getAvailableThinkingLevels(), runtime.getState()],
              { concurrency: 1 },
            );
            const isDefault =
              initialState.model?.provider === model.provider && initialState.model.id === model.id;
            return {
              model,
              thinkingLevels,
              ...(state.thinkingLevel ? { currentThinkingLevel: state.thinkingLevel } : {}),
              ...(isDefault ? { isDefault: true } : {}),
            } satisfies PiModelCatalogEntry;
          }),
        { concurrency: 1 },
      );
      return { models: catalog, skills } satisfies PiCatalogProbeResult;
    }),
  );

function piSnapshot(input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly models?: ServerProviderDraft["models"];
  readonly skills?: ServerProviderDraft["skills"];
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: "ready" | "warning" | "error";
  readonly message?: string | undefined;
}): ServerProviderDraft {
  return buildServerProvider({
    driver: PI_DRIVER,
    presentation: PI_PRESENTATION,
    enabled: input.enabled,
    checkedAt: input.checkedAt,
    models: input.models ?? [],
    ...(input.skills ? { skills: input.skills } : {}),
    probe: {
      installed: input.installed,
      version: input.version,
      status: input.status,
      auth: { status: "unknown" },
      ...(input.message ? { message: input.message } : {}),
    },
  });
}

export const makePendingPiProvider = (settings: PiSettings): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return piSnapshot({
      enabled: settings.enabled,
      checkedAt,
      installed: false,
      version: null,
      status: "warning",
      message: settings.enabled
        ? "Pi provider status has not been checked in this session yet."
        : "Pi is disabled in T3 Code settings.",
    });
  });

export function checkPiProviderStatus<R = never>(
  settings: PiSettings,
  environment: NodeJS.ProcessEnv,
  discoverCatalog?: PiCatalogProbe<R>,
  cwd = process.cwd(),
): Effect.Effect<ServerProviderDraft, never, ProcessRunner | R> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    if (!settings.enabled) {
      return piSnapshot({
        enabled: false,
        checkedAt,
        installed: false,
        version: null,
        status: "warning",
        message: "Pi is disabled in T3 Code settings.",
      });
    }

    const launchArgsValidationError = validatePiLaunchArgs(settings.launchArgs);
    if (launchArgsValidationError) {
      return piSnapshot({
        enabled: true,
        checkedAt,
        installed: false,
        version: null,
        status: "error",
        message: launchArgsValidationError,
      });
    }

    const processRunner = yield* ProcessRunner;
    const versionExit = yield* Effect.exit(
      processRunner.run({
        command: settings.binaryPath || "pi",
        args: ["--version"],
        env: settings.configDirectory
          ? { ...environment, PI_CODING_AGENT_DIR: settings.configDirectory }
          : environment,
      }),
    );
    if (versionExit._tag === "Failure") {
      return piSnapshot({
        enabled: true,
        checkedAt,
        installed: false,
        version: null,
        status: "error",
        message: `Pi CLI (${settings.binaryPath || "pi"}) is not installed or could not be started. Check the binary path.`,
      });
    }

    const versionResult = versionExit.value;
    if (versionResult.timedOut || versionResult.code !== 0) {
      return piSnapshot({
        enabled: true,
        checkedAt,
        installed: true,
        version: null,
        status: "error",
        message: versionResult.timedOut
          ? "Pi CLI version check timed out. Check the selected binary and try again."
          : "Pi CLI version check failed. Check the selected binary and try again.",
      });
    }

    const parsedVersion = parsePiVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    if (parsedVersion._tag === "Invalid") {
      return piSnapshot({
        enabled: true,
        checkedAt,
        installed: true,
        version: null,
        status: "error",
        message: "Could not determine the Pi CLI version. Check that the selected binary is Pi.",
      });
    }

    if (parsedVersion._tag === "Unsupported") {
      return piSnapshot({
        enabled: true,
        checkedAt,
        installed: true,
        version: parsedVersion.version,
        status: "error",
        message: `Pi v${parsedVersion.version} is too old. Upgrade to v${PI_MINIMUM_VERSION} or later.`,
      });
    }

    if (!discoverCatalog) {
      return piSnapshot({
        enabled: true,
        checkedAt,
        installed: true,
        version: parsedVersion.version,
        status: "ready",
      });
    }

    const catalogExit = yield* Effect.exit(
      discoverCatalog({
        binaryPath: settings.binaryPath || "pi",
        configDirectory: settings.configDirectory,
        launchArgs: settings.launchArgs,
        trustedExtensions: resolvePiTrustedExtensions(settings.trustedExtensions, environment),
        cwd,
        environment,
      }),
    );
    if (Exit.isFailure(catalogExit)) {
      return piSnapshot({
        enabled: true,
        checkedAt,
        installed: true,
        version: parsedVersion.version,
        status: "error",
        message:
          "Pi RPC model discovery failed. Check the selected Pi configuration and try again.",
      });
    }

    return piSnapshot({
      enabled: true,
      checkedAt,
      installed: true,
      version: parsedVersion.version,
      status: "ready",
      models: mapPiModelCatalog(catalogExit.value.models),
      skills: mapPiSkillsToServerProviderSkills(catalogExit.value.skills),
    });
  });
}
