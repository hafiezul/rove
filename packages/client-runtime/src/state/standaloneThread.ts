import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ModelSelection,
  type ServerConfig,
  type ThreadId,
} from "@rove-code/contracts";
import type { CreateThreadInput } from "../operations/commands.ts";

/** Servers from before standalone threads reject a null projectId outright. */
export function supportsStandaloneThreads(config: ServerConfig | null | undefined): boolean {
  return config?.environment.capabilities.standaloneThreads === true;
}

export const STANDALONE_THREADS_UNSUPPORTED_MESSAGE =
  "Update this environment's server to start threads without a project.";

export function standaloneThreadInput(
  threadId: ThreadId,
  config: ServerConfig | null | undefined,
  carrySelection?: ModelSelection | null,
): CreateThreadInput {
  const settings = config?.settings ?? DEFAULT_SERVER_SETTINGS;
  const provider = config?.providers.find(
    (provider) => provider.enabled && provider.installed && provider.availability !== "unavailable",
  );
  const model = provider?.models.find((model) => model.isDefault) ?? provider?.models[0];
  return {
    threadId,
    projectId: null,
    title: "New thread",
    modelSelection: settings.defaultModelSelection ??
      carrySelection ?? {
        instanceId: provider?.instanceId ?? ProviderInstanceId.make("codex"),
        model: model?.slug ?? DEFAULT_MODEL,
      },
    runtimeMode: settings.defaultRuntimeMode,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
  };
}
