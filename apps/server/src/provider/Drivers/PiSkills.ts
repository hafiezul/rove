import type { ServerProviderSkill } from "@t3tools/contracts";

/**
 * Pi skill discovery and `$name` → `/skill:name` prompt translation.
 *
 * Discovery is driven by Pi's own RPC `get_commands` surface so T3 Code lists
 * exactly what the Pi binary loaded (settings.json skill arrays, `--skill`
 * flags, trust rules, and name-collision rules already applied). Invocation
 * rewrites composer `$name` tokens into Pi's native `/skill:name` command
 * form so Pi's RPC input expansion loads the skill content before the model
 * sees the prompt.
 *
 * @module PiSkills
 */

/** One `get_commands` entry with `source: "skill"` (Pi >= 0.82.0 shape). */
export interface PiRpcSkillCommand {
  readonly name: string;
  readonly description?: string | undefined;
  readonly scope?: string | undefined;
  readonly path: string;
}

const PI_SKILL_COMMAND_PREFIX = "skill:";
const PI_COMPOSER_SKILL_TOKEN = /(?<![\w$])\$([A-Za-z0-9][A-Za-z0-9._-]*)/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Parse the `data.commands` payload of a Pi RPC `get_commands` response into
 * skill entries, keeping only `source: "skill"` records with a usable
 * `skill:`-prefixed name. Provenance (`path`, `scope`) comes from the
 * structured `sourceInfo` object introduced in Pi 0.82.0.
 */
export function parsePiGetCommandsResponse(response: unknown): ReadonlyArray<PiRpcSkillCommand> {
  if (!isRecord(response) || !Array.isArray(response.commands)) {
    return [];
  }
  const skills: PiRpcSkillCommand[] = [];
  for (const command of response.commands) {
    if (!isRecord(command) || command.source !== "skill") {
      continue;
    }
    const rawName = nonEmptyString(command.name);
    if (!rawName || !rawName.startsWith(PI_SKILL_COMMAND_PREFIX)) {
      continue;
    }
    const name = rawName.slice(PI_SKILL_COMMAND_PREFIX.length);
    const sourceInfo = isRecord(command.sourceInfo) ? command.sourceInfo : undefined;
    const path = nonEmptyString(sourceInfo?.path);
    if (name.length === 0 || !path) {
      continue;
    }
    const description = nonEmptyString(command.description);
    const scope = nonEmptyString(sourceInfo?.scope);
    skills.push({
      name,
      ...(description ? { description } : {}),
      ...(scope ? { scope } : {}),
      path,
    });
  }
  return skills;
}

/**
 * Map discovered Pi skill commands to the shared provider snapshot contract.
 * Every listed skill is invocable, so `enabled` is always true.
 */
export function mapPiSkillsToServerProviderSkills(
  skills: ReadonlyArray<PiRpcSkillCommand>,
): ReadonlyArray<ServerProviderSkill> {
  return skills.map((skill) => ({
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    path: skill.path,
    ...(skill.scope ? { scope: skill.scope } : {}),
    enabled: true,
  }));
}

export interface PiSkillPromptRewriteResult {
  readonly text: string;
  /** Snapshot skill names whose `$name` tokens were rewritten, in first-use order. */
  readonly invokedSkills: ReadonlyArray<string>;
}

/**
 * Rewrite composer `$name` tokens into Pi's native `/skill:name` invocation.
 *
 * Only tokens matching a known skill from the current snapshot are rewritten;
 * unknown `$name` tokens pass through untouched so free prose never produces
 * false `/skill:` commands.
 *
 * - Sole-content: the message is exactly `$name args...` → the whole prompt
 *   becomes `/skill:name args...`, guaranteeing Pi's input expansion.
 * - Mid-text: the first known token's `/skill:name` is prepended on its own
 *   line so the skill content loads first, with the prose following; any
 *   further known tokens in the prose are rewritten in place.
 */
export function rewritePiSkillTokens(
  text: string,
  knownSkillNames: ReadonlySet<string>,
): PiSkillPromptRewriteResult {
  const invokedSkills: string[] = [];
  let firstInvokedSkill: string | undefined;
  const rewritten = text.replace(PI_COMPOSER_SKILL_TOKEN, (token: string, name: string) => {
    if (!knownSkillNames.has(name)) {
      return token;
    }
    firstInvokedSkill ??= name;
    if (!invokedSkills.includes(name)) {
      invokedSkills.push(name);
    }
    return `/skill:${name}`;
  });
  if (firstInvokedSkill === undefined) {
    return { text, invokedSkills };
  }
  if (rewritten.startsWith(`/skill:${firstInvokedSkill}`)) {
    // Sole-content case: the whole prompt is the skill command plus args.
    return { text: rewritten, invokedSkills };
  }
  return { text: `/skill:${firstInvokedSkill}\n${rewritten}`, invokedSkills };
}
