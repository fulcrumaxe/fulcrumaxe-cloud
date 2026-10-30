import type { CompensationKind } from "@fx/db/src/reversalCompensation.js";
import type { GitPort, GitRefusal, RebuildPort } from "./ports.js";
import type { ReversalPlan } from "./reverse.js";

/**
 * Carries out one reversal plan (D#7 DP7-2d): what happens on GitHub and in the pipeline once `planReversal` has decided. The answer is the row
 * the worker records with `finishCompensation`; nothing here writes a row, reads a clock or holds a database connection.
 *
 *  - `refused`: no port is called. The row is `refused`, `not_reversible`.
 *  - `free_redecide` (inside the window, or before the build): no port is called. The row is `none_before_build`.
 *  - `compensating_work`: the retraction is DP7b's, and its port answers the unavailable state today, so the row is `unavailable`,
 *    `retraction_unavailable`, and no port is called.
 *  - `rerun` (R-S1-1): only where the fresh build gets its own branch, which is the runner's `fx/<run>-g<n>`. A sandbox build force-pushes the item's
 *    one branch, and a paired sandbox build opens its private pull request on that same branch, so a rebuild there would overwrite the original:
 *    refused with `rerun_would_overwrite_branch` before any port is called. A reversal recorded by policy has no person to act for: refused with
 *    `no_person_actor`, and nothing is filed in the orchestrator's name. Otherwise the open pull request is closed at exactly its recorded head (the
 *    branch is kept), then Build again is filed in the person's name.
 *  - `revert_pr` (R-S1-3): one draft revert pull request for the customer to review. The merged change stays until they merge it.
 *
 * A port that refuses, or throws, ends the row `failed` with a fixed code. The receipt already stands and its row stays with it; the next tick
 * claims the row again until the attempts cap.
 */

/** Every code a compensation can end with. `head_moved` and `person_managed` mean the pull request was left exactly as it was. */
export const COMPENSATE_REASONS = [
  "not_reversible",
  "retraction_unavailable",
  "rerun_would_overwrite_branch",
  "no_person_actor",
  "head_moved",
  "person_managed",
  "state_changed",
  "revert_refused",
  "rerun_refused",
  "tooling_error",
] as const;
export type CompensateReason = (typeof COMPENSATE_REASONS)[number];

export interface CompensateSubject {
  accountId: string;
  workItemId: string;
  /** The item's repository as `owner/name`. */
  repo: string;
  /**
   * Which side builds the item: `runner` for the customer's runner, `cloud` for our sandbox. The caller derives it from the item's effective
   * execution mode (its placement, else `repos.execution_mode`) with the runner package's own `sideOfMode`, so there is no second list of modes.
   */
  side: "runner" | "cloud";
  /** The reversal receipt's `actor`: the session user id of the person who asked, or the literal `policy`. */
  actor: string;
}

export interface CompensatePorts {
  git: GitPort;
  rebuild: RebuildPort;
}

export interface CompensateOutcome {
  kind: CompensationKind;
  state: "done" | "failed";
  reasonCode: CompensateReason | null;
  /** `rerun`: the original pull request. `revert_pr`: the revert we opened (absent until it is open). */
  prNumber: number | null;
  /** The Build again request filed for a re-run. */
  runActionId: string | null;
}

const PERSON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GIT_REASON: Record<GitRefusal, CompensateReason> = {
  stale_head: "head_moved",
  person_managed: "person_managed",
  not_open: "state_changed",
  not_merged: "state_changed",
  revert_refused: "revert_refused",
  unavailable: "tooling_error",
};

const row = (kind: CompensationKind, state: "done" | "failed", reasonCode: CompensateReason | null, prNumber: number | null = null, runActionId: string | null = null): CompensateOutcome => ({
  kind,
  state,
  reasonCode,
  prNumber,
  runActionId,
});

/** A port call whose throw is a fixed code: a thrown error never decides anything, and its text is never kept. */
async function attempt<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch {
    // fx-swallow-ok: a port that throws ends the row failed with tooling_error (the caller's null check); its message can carry request details and is dropped
    return null;
  }
}

export async function compensate(plan: ReversalPlan, subject: CompensateSubject, ports: CompensatePorts): Promise<CompensateOutcome> {
  switch (plan.kind) {
    case "refused":
      return row("refused", "done", "not_reversible");
    case "free_redecide":
      return row("none_before_build", "done", null);
    case "compensating_work":
      return row("unavailable", "done", "retraction_unavailable");
    case "revert_pr": {
      const opened = await attempt(() => ports.git.openRevertPr({ repo: subject.repo, number: plan.pr.number }));
      if (opened === null) return row("revert_pr", "failed", "tooling_error");
      if (!opened.ok) return row("revert_pr", "failed", GIT_REASON[opened.code]);
      return row("revert_pr", "done", null, opened.number);
    }
    case "rerun": {
      const pr = plan.pr;
      const prNumber = pr?.number ?? null;
      if (subject.side !== "runner") return row("rerun", "failed", "rerun_would_overwrite_branch", prNumber);
      if (!PERSON.test(subject.actor)) return row("rerun", "failed", "no_person_actor", prNumber);
      if (pr !== null) {
        const closed = await attempt(() => ports.git.rerunAfterBuild({ repo: subject.repo, number: pr.number, headSha: pr.headSha }));
        if (closed === null) return row("rerun", "failed", "tooling_error", prNumber);
        if (!closed.ok) return row("rerun", "failed", GIT_REASON[closed.code], prNumber);
      }
      const filed = await attempt(() => ports.rebuild.buildAgain({ accountId: subject.accountId, workItemId: subject.workItemId, userId: subject.actor }));
      if (filed === null) return row("rerun", "failed", "tooling_error", prNumber);
      if (!filed.ok) return row("rerun", "failed", filed.code === "refused" ? "rerun_refused" : "state_changed", prNumber);
      return row("rerun", "done", null, prNumber, filed.runActionId);
    }
  }
}

/**
 * What a person reads for each outcome: fixed words, no GitHub text and no item text. After a merge the change is not undone by us: we open a revert
 * and the customer decides (R-S1-3), and the copy says so.
 */
export const COMPENSATION_COPY = {
  none_before_build: "Reversed before the build started. Nothing on GitHub was changed; decide again when you are ready.",
  rerun: "We closed the pull request and started a fresh build on a new branch. The original branch is kept.",
  revert_pr: "We opened a revert for you to review. Nothing changes until you merge it.",
  refused: "This decision cannot be reversed.",
  unavailable: "This cannot be corrected automatically yet, so nothing was changed.",
  failed: {
    not_reversible: "This decision cannot be reversed.",
    retraction_unavailable: "This cannot be corrected automatically yet, so nothing was changed.",
    rerun_would_overwrite_branch: "A fresh build here would replace the original branch, so we did not start one. Nothing was changed.",
    no_person_actor: "Only a person can ask for a fresh build, so we did not start one. Nothing was changed.",
    head_moved: "The pull request has new commits since it was built, so we left it as it is.",
    person_managed: "A person has taken this change over, so we left its pull request as it is.",
    state_changed: "The item moved on after the reversal was asked for, so nothing was changed.",
    revert_refused: "GitHub could not open a revert for this pull request, most likely because later changes conflict with it.",
    rerun_refused: "The fresh build could not be started: an owner or admin can start it once nothing else is running.",
    tooling_error: "We could not finish this step. It can be tried again.",
  } satisfies Record<CompensateReason, string>,
} as const;

/** The sentence for one outcome. */
export function compensationSentence(outcome: Pick<CompensateOutcome, "kind" | "state" | "reasonCode">): string {
  if (outcome.state === "failed" || outcome.kind === "refused" || outcome.kind === "unavailable") {
    if (outcome.reasonCode !== null) return COMPENSATION_COPY.failed[outcome.reasonCode];
    return outcome.kind === "refused" ? COMPENSATION_COPY.refused : outcome.kind === "unavailable" ? COMPENSATION_COPY.unavailable : COMPENSATION_COPY.failed.tooling_error;
  }
  return COMPENSATION_COPY[outcome.kind];
}
