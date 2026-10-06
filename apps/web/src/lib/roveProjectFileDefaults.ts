import {
  ROVE_PROJECT_FILE_NAME,
  type EnvironmentId,
  type RoveProjectFile,
} from "@rove-code/contracts";
import { parseRoveProjectFile } from "@rove-code/shared/roveProjectFile";
import { executeAtomQuery } from "@rove-code/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * Read and decode the project's checked-in `rove.json`.
 *
 * Imperative counterpart to `useRoveProjectFileState` for the new-thread path,
 * which resolves defaults at call time rather than render time. The file
 * query atom caches per (environment, cwd), so repeat calls don't re-fetch.
 * Optimistic in-app writes overlay the query result, matching what
 * `useProjectFileQuery` renders. Missing, truncated, or invalid files
 * resolve to null.
 */
export async function readRoveProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<RoveProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, ROVE_PROJECT_FILE_NAME, {
      allowLegacyProjectFile: true,
    }),
    { reportDefect: false, reportFailure: false },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    ROVE_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.truncated) return null;
  return parseRoveProjectFile(data.contents);
}
