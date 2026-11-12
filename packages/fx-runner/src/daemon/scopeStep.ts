import { derivedCandidates, parseAcceptanceScope, pathsOutsideScope, pathsOutsideScopeFresh, type DerivedFileRule } from "@fulcrumaxe/runner-protocol";

/** What the runner reads the workspace's changed paths with: `createChangedFiles` (checkStep.ts), the guarded git listing against a base. Null when git could not say or the listing was cut. */
export type ChangedFiles = (workspace: string, base: string) => Promise<string[] | null>;

/** #751: asks whether these generated files (`paths`, outputs of `rules`) equal a fresh generator run on the workspace; answers the ones that do. See `derivedStep.ts`. */
export type VerifyDerived = (rules: readonly DerivedFileRule[], paths: readonly string[], changed: readonly string[], note?: (reason: string) => void) => Promise<string[]>;

/** Why generated files were not lifted: counts and a closed reason code only (no path, no content). */
export interface DerivedWhy { rules: number; candidates: number; reason: string }

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
export async function scopeVerdict(input: { scope: readonly string[] | undefined; changedFiles: ChangedFiles | undefined; workspace: string; base: string; rules?: readonly DerivedFileRule[] | undefined; verifyDerived?: VerifyDerived | undefined }): Promise<{ outside: number; derivedFresh: string[]; derivedWhy?: DerivedWhy } | null> {
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
  const rules = input.rules ?? [];
  const candidates = outside.length === 0 || input.verifyDerived === undefined || input.rules === undefined ? null : derivedCandidates(input.rules, parsed, first, outside);
  // Nothing is lifted from here on unless a fresh run vouches; `why` says which closed reason applies, for the step line.
  const why = (count: number, reason: string): DerivedWhy | undefined => {
    if (outside.length === 0) return undefined;
    if (rules.length === 0) return { rules: 0, candidates: count, reason: "no_rules" };
    const outputs = new Set(rules.filter((r) => r.kind === "generated").flatMap((r) => [...r.outputs]));
    return outside.some((p) => outputs.has(p)) ? { rules: rules.length, candidates: count, reason } : undefined;
  };
  const unlifted = (count: number, reason: string): { outside: number; derivedFresh: string[]; derivedWhy?: DerivedWhy } => {
    const w = why(count, count === 0 && rules.length > 0 ? "inputs_not_in_scope" : reason);
    return { outside: outside.length, derivedFresh: [], ...(w === undefined ? {} : { derivedWhy: w }) };
  };
  if (candidates === null || candidates.paths.length === 0) return unlifted(0, "inputs_not_in_scope");
  let fresh: string[];
  let noted: string | undefined;
  try {
    fresh = await input.verifyDerived!(candidates.rules, candidates.paths, first, (reason) => { noted ??= reason; });
  } catch {
    // fx-swallow-ok: a verification that threw vouches for nothing; the files stay outside
    fresh = [];
    noted ??= "unreadable";
  }
  fresh = fresh.filter((p) => candidates.paths.includes(p));
  const second = await list();
  if (second === null) return unlifted(candidates.paths.length, "unreadable");
  const left = pathsOutsideScopeFresh(input.rules ?? [], parsed, second, fresh);
  const derivedFresh = fresh.filter((p) => second.includes(p));
  if (derivedFresh.length > 0 || left.length === 0) return { outside: left.length, derivedFresh };
  const w = why(candidates.paths.length, noted ?? "not_equal");
  return { outside: left.length, derivedFresh, ...(w === undefined ? {} : { derivedWhy: w }) };
}

/** The count alone (`scopeVerdict` without any verification): kept for the callers that only ask how many files are outside. */
export async function outOfScopeCount(input: { scope: readonly string[] | undefined; changedFiles: ChangedFiles | undefined; workspace: string; base: string }): Promise<number | null> {
  return (await scopeVerdict(input))?.outside ?? null;
}
