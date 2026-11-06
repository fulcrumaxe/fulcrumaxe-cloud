import { parseAcceptanceScope, pathsOutsideScope } from "@fulcrumaxe/runner-protocol";

/** What the runner reads the workspace's changed paths with: `createChangedFiles` (checkStep.ts), the guarded git listing against a base. Null when git could not say or the listing was cut. */
export type ChangedFiles = (workspace: string, base: string) => Promise<string[] | null>;

/**
 * D#6 SCOPE-IN-JOB: how many of the files this run changed fall outside the file list its signed job carries, or null when the runner cannot say and the run goes on as it did before the
 * field existed (the check runs). Null for every case but a list that reads and a complete listing: no `scope` on the job, a list the shared parser does not read as known (the same parser the
 * cloud uses, run again here; nothing is re-expanded), no way to list the changes, a listing git could not give, or a throw. Zero when every changed path is inside it.
 *
 * The matcher is the shared one (`pathsOutsideScope`), never a pattern library of the runner's own. The answer is a hint for the cloud, which judges the pull request itself and stays authoritative:
 * a wrong "outside" costs a skipped check and a run that ends without a pull request, never a pass. Only the count leaves this function; no path is kept or sent.
 */
export async function outOfScopeCount(input: { scope: readonly string[] | undefined; changedFiles: ChangedFiles | undefined; workspace: string; base: string }): Promise<number | null> {
  if (input.scope === undefined || input.changedFiles === undefined) return null;
  const parsed = parseAcceptanceScope([...input.scope]);
  if (parsed.kind !== "known") return null;
  let listed: string[] | null;
  try {
    listed = await input.changedFiles(input.workspace, input.base);
  } catch {
    // fx-swallow-ok: a listing that threw is no answer; the check runs as it always did
    return null;
  }
  if (listed === null) return null;
  return pathsOutsideScope(parsed, [...new Set(listed)]).length;
}
