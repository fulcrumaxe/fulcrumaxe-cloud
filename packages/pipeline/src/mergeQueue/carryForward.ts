import type { RunRow } from "../build/mergeGate.js";

/**
 * D#519 MQ3-a: the rule for carrying reviewer passes across a VERIFIED PLATFORM REFRESH (owner ruling Q1(b)). A refresh is GitHub's
 * update-branch merge of the default branch into the reviewed head, called by us and verified by `refresh.ts` (two parents, our App's
 * identity); it is recorded as a `head_refreshes` row. Nothing else is a refresh. A merge commit that a person or a bot pushed is not
 * one, gets no row and carries nothing (that case is D#598 P7c's, which never reads this table).
 *
 * The rule has two halves, both here and both pure (no GitHub, no database):
 *  - `decideCarryForward`: do the files the pull request changed and the files the default branch changed overlap?
 *  - `effectiveRunRows`: which reviewer rows speak for a refreshed head.
 */

export type CarryDecision = { carry: true } | { carry: false; reason: "files_overlap" | "files_unknown" };

/**
 * `prFiles`: paths the pull request changed against the default branch. `mainFiles`: paths the refresh merge brought in from the
 * default branch. Both include both names of a rename, so a rename overlaps on either name. A list that is `null` (cut at GitHub's cap)
 * is unknown, and unknown is never disjoint. Paths are compared exactly.
 */
export function decideCarryForward(prFiles: readonly string[] | null, mainFiles: readonly string[] | null): CarryDecision {
  if (prFiles === null || mainFiles === null) return { carry: false, reason: "files_unknown" };
  const pr = new Set(prFiles);
  return mainFiles.some((f) => pr.has(f)) ? { carry: false, reason: "files_overlap" } : { carry: true };
}

/** The reviewer rows on one head of a refresh chain. */
export interface HeadRuns {
  rows: readonly RunRow[];
  /** The refresh INTO this head (from the next head of the chain) had overlapping files. */
  refreshOverlap: boolean;
}

/**
 * Which rows speak for the newest head. `chain[0]` is that head, `chain[1]` the head it was refreshed from, and so on back to the head
 * the reviewers saw. Per role, a head's own rows win (a delta review or a new review on the refreshed head is never overridden by an
 * older pass). A role with no row on a head falls back to the head before it, through a verified row, but ONLY across a refresh whose
 * files were disjoint. When a refresh overlapped, NO pass crosses it, whatever the role: the delta review of the merge commit has to
 * supply every pass the refreshed head needs (Spec; TL ruling on D#519 MQ3-a).
 */
export function effectiveRunRows(chain: readonly HeadRuns[]): RunRow[] {
  const roles = new Set(chain.flatMap((h) => h.rows.map((r) => r.role)));
  const out: RunRow[] = [];
  for (const role of roles) {
    for (const head of chain) {
      const mine = head.rows.filter((r) => r.role === role);
      if (mine.length > 0) {
        out.push(...mine);
        break;
      }
      if (head.refreshOverlap) break;
    }
  }
  return out;
}
