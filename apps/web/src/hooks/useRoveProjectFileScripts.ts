import {
  ROVE_PROJECT_FILE_NAME,
  type EnvironmentId,
  type RoveProjectFile,
  type RoveProjectFileScript,
} from "@rove-code/contracts";
import { parseRoveProjectFile } from "@rove-code/shared/roveProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<RoveProjectFileScript> = [];

export interface RoveProjectFileState {
  /**
   * - `valid`: rove.json exists and decoded.
   * - `invalid`: rove.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable rove.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: RoveProjectFile | null;
  scripts: ReadonlyArray<RoveProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `rove.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function useRoveProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): RoveProjectFileState {
  const query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    ROVE_PROJECT_FILE_NAME,
    cwd !== null,
    { allowLegacyProjectFile: true },
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parseRoveProjectFile(contents);
    if (file === null) {
      return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, isPending]);
}

/**
 * Scripts declared in the project's checked-in `rove.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useRoveProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<RoveProjectFileScript> {
  return useRoveProjectFileState(environmentId, cwd).scripts;
}
