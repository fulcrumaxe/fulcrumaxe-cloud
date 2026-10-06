import type { LabelDiff, PipelineRole, ReviewVerdict } from "./types.js";

/**
 * D#2 H14a: the verdict-to-label mapping (criterion 1, "Verdicts become
 * labels"). Pure, no I/O -- `stageMachine.ts`/`fixLoop.ts` call this and
 * hand the result to whatever `LabelsPort` they were given.
 *
 * Label names: `code-review-passed` and `security-review-passed` and
 * `acceptance-failed` are named directly by D#2 correction C11 (the H14b
 * merge-gate criterion this package does not implement, but whose exact
 * label spelling this package's mapping must match, since H14b reads
 * these same names later). `needs-fix` is C11's own name for the label a
 * reviewer's non-pass verdict produces (criterion 2's own name for the
 * loop: "needs-fix resumes the same executor session"). Every other
 * label name here (`debate-passed`, `acceptance-passed`) is this
 * package's own bookkeeping extension, not named by the frozen Spec text,
 * and is not read by C11's merge-gate table.
 */
export const NEEDS_FIX_LABEL = "needs-fix";

export const ROLE_PASS_LABEL: Readonly<Record<ReviewerRoleWithDebater, string>> = Object.freeze({
  "code-reviewer": "code-review-passed",
  "security-reviewer": "security-review-passed",
  "acceptance-tester": "acceptance-passed",
  debater: "debate-passed",
});

/** C11's own name; the only non-pass label the frozen Spec text names
 * for acceptance-tester ("its latest row on that SHA must not be a
 * fail"). */
export const ACCEPTANCE_FAILED_LABEL = "acceptance-failed";

type ReviewerRoleWithDebater = Exclude<PipelineRole, "executor">;

/**
 * True when `verdict` should trigger the fix loop for `role`. A reviewer
 * (code/security/debater) treats both `needs-fix` and `fail` as "send it
 * back" (code-reviewer's card: "emit `verdict: fail` if you cannot
 * proceed at all" is a hard block, not a pass, so it must not merge
 * silently). acceptance-tester's card only ever emits `pass` | `fail`,
 * so `fail` is its own "send it back" value; it has no `needs-fix`
 * concept of its own.
 */
export function isFixRequired(_role: ReviewerRoleWithDebater, verdict: ReviewVerdict): boolean {
  return verdict !== "pass";
}

/**
 * The label add/remove diff for one role's finished verdict. Always
 * removes the OTHER outcome's label for the same role first (so a
 * re-review after a fix round never leaves a stale `needs-fix` label
 * next to a fresh `*-review-passed` one, or vice versa) -- C11's merge
 * gate never reads labels itself, but a human "ready, human merges" PR
 * still needs an accurate label set to act on.
 */
export function labelsForVerdict(role: ReviewerRoleWithDebater, verdict: ReviewVerdict): LabelDiff {
  const passLabel = ROLE_PASS_LABEL[role];
  const failLabel = role === "acceptance-tester" ? ACCEPTANCE_FAILED_LABEL : NEEDS_FIX_LABEL;

  if (verdict === "pass") {
    return { add: [passLabel], remove: [failLabel] };
  }
  return { add: [failLabel], remove: [passLabel] };
}
