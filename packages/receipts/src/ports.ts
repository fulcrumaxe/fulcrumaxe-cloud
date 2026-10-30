/**
 * The ports a reversal works through (D#7 DP7-2b). Each one is an interface plus, in the tests, a fake that refuses what the real adapter would
 * refuse. The real adapters arrive in later rows (the ledger and build-state reads, the GitHub writes); nothing in this file touches a
 * database, a network or a clock.
 */

/** Reads the money side of a work item. The estimate a person sees before a re-run comes from here, never from a guess. */
export interface LedgerPort {
  /** The sum of model spend on the item's build and fix runs, in USD, for one account's item. Rejects an id that is not a UUID. */
  workItemBuildSpendUsd(accountId: string, workItemId: string): Promise<number>;
}

export type BuildStage = "not_started" | "building" | "built" | "merged";

/** The pull request a built item has: its number and the head sha recorded when it was opened. */
export interface BuildPr {
  number: number;
  headSha: string;
}

export interface BuildState {
  stage: BuildStage;
  /** Present exactly when the stage is `built` or `merged`; absent for `not_started`; optional while `building`. */
  pr: BuildPr | null;
}

/** Reads where a work item stands in its build. A reversal re-reads this when it runs, never when the request was made. */
export interface BuildStatePort {
  stateOf(accountId: string, workItemId: string): Promise<BuildState>;
}

/**
 * Fixed result codes: no text from GitHub ever crosses a port. `person_managed`: a person took the item's public branch over (its newest push
 * record says so), so its pull request is left as it is.
 */
export type GitRefusal = "not_open" | "stale_head" | "not_merged" | "revert_refused" | "person_managed" | "unavailable";
export type GitResult<T> = ({ ok: true } & T) | { ok: false; code: GitRefusal };

export interface PullRequestRef {
  /** The repository as `owner/name`. */
  repo: string;
  number: number;
}

/**
 * The two GitHub writes a reversal makes. Neither deletes a branch: the original is kept.
 *  - `rerunAfterBuild`: R-S1-1, after the build and before merge. Closes the open PR at exactly the recorded head; the fresh build is `RebuildPort`'s.
 *  - `openRevertPr`: R-S1-3, after merge. Opens a draft revert pull request for the customer to review and merge.
 */
export interface GitPort {
  rerunAfterBuild(input: PullRequestRef & { headSha: string }): Promise<GitResult<{ closed: true }>>;
  openRevertPr(input: PullRequestRef): Promise<GitResult<{ number: number }>>;
}

/**
 * The second half of R-S1-1, after the original pull request is closed: the item moves to Needs a person on the legal edge and Build again is filed in
 * the name of the person who asked for the reversal, checked against the same table their own click is (owner or admin, nothing running). Not a GitHub
 * write. `refused`: that table said no. `state_changed`: the item is no longer where a rebuild can start from.
 */
export interface RebuildPort {
  buildAgain(input: { accountId: string; workItemId: string; userId: string }): Promise<{ ok: true; runActionId: string } | { ok: false; code: "refused" | "state_changed" }>;
}

/** Correcting a published notice (DP7b). Kept apart from GitPort: it needs write access this row does not ask for. */
export interface RetractionPort {
  retractDeprecationNotice(input: { surface: "release" | "discussion"; ref: string }): Promise<GitResult<{ retracted: true }>>;
}

/** The binding that ships with this row: every retraction answers the unavailable state (R-S1-2) and nothing is written anywhere. */
export const unavailableRetractionPort: RetractionPort = {
  retractDeprecationNotice: async () => ({ ok: false, code: "unavailable" }),
};
