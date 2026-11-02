/**
 * D#519 C10 rule (a), as one pure walk both sides use: the cloud (from the push records it keeps) and the local runner (from its own push log).
 * Moved here from the pipeline's `mergeQueue/conflict.ts`, which re-exports it. Imports nothing; no I/O.
 */

/** The most commits one decision reads. A longer pull request fails closed. */
export const COVERED_COMMITS_MAX = 100;

/** The part of a push record the walk reads. */
export interface CoverPush {
  /** The ref's value before the push; null (or the zero id) when the push created the branch. */
  oldSha: string | null;
  newSha: string;
  /** The pushing run's recorded start commit; null when it started from the default branch. */
  startSha: string | null;
}

const ZERO_SHA = /^0{40}(?:0{24})?$/;

/**
 * Which of the pull request's commits `prShas` the push records cover, walking `parents` (from the commit reads the decision already made) and never leaving
 * the pull request's own set. `reach(x)` is `x` and its ancestors inside the set. A record covers `reach(new)` minus `reach(old)`; one that created the
 * branch covers `reach(new)` minus `reach(start)`. A record whose `new` is outside the set, or whose non-zero `old` is (history was rewritten), covers
 * nothing. More commits than one decision reads is `unreadable`.
 */
export function coveredCommits(prShas: readonly string[], parents: ReadonlyMap<string, readonly string[]>, proof: { pushes: readonly CoverPush[] }): ReadonlySet<string> | "unreadable" {
  if (prShas.length > COVERED_COMMITS_MAX) return "unreadable";
  const inPr = new Set(prShas);
  const reach = (x: string | null): Set<string> => {
    const seen = new Set<string>();
    const todo = x !== null && inPr.has(x) ? [x] : [];
    for (let c = todo.pop(); c !== undefined; c = todo.pop()) {
      if (seen.has(c)) continue;
      seen.add(c);
      for (const p of parents.get(c) ?? []) if (inPr.has(p)) todo.push(p);
    }
    return seen;
  };
  const covered = new Set<string>();
  for (const p of proof.pushes) {
    const created = p.oldSha === null || ZERO_SHA.test(p.oldSha);
    if (!inPr.has(p.newSha) || (!created && !inPr.has(p.oldSha!))) continue;
    const below = reach(created ? p.startSha : p.oldSha);
    for (const c of reach(p.newSha)) if (!below.has(c)) covered.add(c);
  }
  return covered;
}
