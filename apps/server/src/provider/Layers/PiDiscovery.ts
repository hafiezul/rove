// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import type { ServerProviderSlashCommand } from "@rove-code/contracts";

import { expandHomePath } from "../../pathExpansion.ts";
import type { PiDiscoveryClient } from "./PiProvider.ts";

/** Discover resources without running extensions or changing persisted project trust. */
export const makeSdkDiscoveryClient = (
  getExtensionCommands?: () =>
    | ReadonlyArray<ServerProviderSlashCommand>
    | Promise<ReadonlyArray<ServerProviderSlashCommand>>,
  agentDir?: string,
): PiDiscoveryClient => ({
  discover: async ({ cwd }) => {
    const { DefaultResourceLoader, getAgentDir, SettingsManager } =
      await import("@earendil-works/pi-coding-agent");
    const resolvedAgentDir = agentDir ? NodePath.resolve(expandHomePath(agentDir)) : getAgentDir();
    const settingsManager = SettingsManager.create(cwd ?? resolvedAgentDir, resolvedAgentDir);
    if (cwd !== undefined) settingsManager.setProjectTrusted(true);
    const loader = new DefaultResourceLoader({
      cwd: cwd ?? resolvedAgentDir,
      agentDir: resolvedAgentDir,
      settingsManager,
      noExtensions: true,
    });
    // The SDK loader does not populate skills or prompts until reload completes.
    await loader.reload();
    const [{ skills }, { prompts }] = [loader.getSkills(), loader.getPrompts()];
    let extensionCommands: ReadonlyArray<ServerProviderSlashCommand> = [];
    try {
      extensionCommands = (await getExtensionCommands?.()) ?? [];
    } catch {
      // A failed extension-command read must not hide ordinary prompt templates.
    }
    const slashCommandsByName = new Map<string, ServerProviderSlashCommand>();
    for (const command of [
      ...extensionCommands,
      ...prompts.map((prompt) => ({
        name: prompt.name,
        ...(prompt.description.trim().length > 0 ? { description: prompt.description } : undefined),
        ...(prompt.argumentHint !== undefined && prompt.argumentHint.trim().length > 0
          ? { input: { hint: prompt.argumentHint } }
          : undefined),
      })),
    ]) {
      if (!slashCommandsByName.has(command.name)) slashCommandsByName.set(command.name, command);
    }
    return {
      skills: skills.map((skill) => ({
        name: skill.name,
        ...(skill.description.trim().length > 0 ? { description: skill.description } : undefined),
        path: skill.filePath,
        scope: skill.sourceInfo.scope === "project" ? "project" : "user",
        enabled: true,
      })),
      slashCommands: [...slashCommandsByName.values()],
    };
  },
});
