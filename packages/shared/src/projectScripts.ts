import type { ProjectScript } from "@t3tools/contracts";

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

interface ProjectScriptRuntimeEnv {
  [name: string]: string;
  readonly ROVE_PROJECT_ROOT: string;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): ProjectScriptRuntimeEnv {
  const env: ProjectScriptRuntimeEnv = {
    ROVE_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.ROVE_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}
