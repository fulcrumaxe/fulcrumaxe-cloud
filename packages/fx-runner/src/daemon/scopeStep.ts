import { derivedCandidates, parseAcceptanceScope, pathsOutsideScope, pathsOutsideScopeFresh, type DerivedFileRule } from "@fulcrumaxe/runner-protocol";

/** What the runner reads the workspace's changed paths with: `createChangedFiles` (checkStep.ts), the guarded git listing against a base. Null when git could not say or the listing was cut. */
export type ChangedFiles = (workspace: string, base: string) => Promise<string[] | null>;

/** #751: asks whether these generated files (`paths`, outputs of `rules`) equal a fresh generator run on the workspace; answers the ones that do. See `derivedStep.ts`. */
export type VerifyDerived = (rules: readonly DerivedFileRule[], paths: readonly string[], changed: readonly string[]) => Promise<string[]>;

/**
 * D#6 SCOPE-IN-JOB: how many of the files this run changed fall outside the file list its signed job carries, or null when the runner cannot say and the run goes on as it did before the
 * field existed (the check runs). Null for every case but a list that reads and a complete listing: no `scope` on the job, a list the shared parser does not read as known (the same parser the
 * cloud uses, run again here; nothing is re-expanded), no way to list the changes, a listing git could not give, or a throw. Zero when every changed path is inside it.
 *
 * The matcher is the shared one (`pathsOutsideScope`), never a pattern library of the runner's own. The answer is a hint for the cloud, which judges the pull request itself and stays authoritative:
 * a wrong "outside" costs a skipped check and a run that ends without a pull request, never a pass. Only the count leaves this function; no path is kept or sent.
 *
 * #751: a changed generated file (the OpenAPI document and client beside a route) is not counted when `verifyDerived` finds it equal to a fresh generator run on the result and its rule's input
 * is in scope; those paths come back in `derivedFresh` so `done` can vouch for them. Without `verifyDerived`, or when it throws or the generators change anything else, nothing is lifted.
 * After a verification the workspace is listed again and the count comes from that second listing, so a generator that wrote an extra file is counted like any other change.
 */
export async function scopeVerdict(input: { scope: readonly string[] | undefined; changedFiles: ChangedFiles | undefined; workspace: string; base: string; rules?: readonly DerivedFileRule[] | undefined; verifyDerived?: VerifyDerived | undefined }): Promise<{ outside: number; derivedFresh: string[] } | null> {
  if (input.scope === undefined || input.changedFiles === undefined) return null;
  const parsed = parseAcceptanceScope([...input.scope]);
  if (parsed.kind !== "known") return null;
  const list = async (): Promise<string[] | null> => {
    try {
      const listed = await input.changedFiles!(input.workspace, input.base);
      return listed === null ? null : [...new Set(listed)];
    } catch {
      // fx-swallow-ok: a listing that threw is no answer; the check runs as it always did
      return null;
    }
  };
  const first = await list();
  if (first === null) return null;
  const outside = pathsOutsideScope(parsed, first);
  const candidates = outside.length === 0 || input.verifyDerived === undefined || input.rules === undefined ? null : derivedCandidates(input.rules, parsed, first, outside);
  if (candidates === null || candidates.paths.length === 0) return { outside: outside.length, derivedFresh: [] };
  let fresh: string[];
  try {
    fresh = await input.verifyDerived!(candidates.rules, candidates.paths, first);
  } catch {
    // fx-swallow-ok: a verification that threw vouches for nothing; the files stay outside
    fresh = [];
  }
  fresh = fresh.filter((p) => candidates.paths.includes(p));
  const second = await list();
  if (second === null) return { outside: outside.length, derivedFresh: [] };
  return { outside: pathsOutsideScopeFresh(input.rules ?? [], parsed, second, fresh).length, derivedFresh: fresh.filter((p) => second.includes(p)) };
}

/** The count alone (`scopeVerdict` without any verification): kept for the callers that only ask how many files are outside. */
export async function outOfScopeCount(input: { scope: readonly string[] | undefined; changedFiles: ChangedFiles | undefined; workspace: string; base: string }): Promise<number | null> {
  return (await scopeVerdict(input))?.outside ?? null;
}
