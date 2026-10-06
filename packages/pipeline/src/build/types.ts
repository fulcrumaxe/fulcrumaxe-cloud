/**
 * D#2 H14a: shared types for the build stage machine (SPEC_READY ->
 * executor -> PR opened -> reviews -> fix loop). Fixture-only, zero
 * model tokens -- see this package's README-equivalent in package.json's
 * `description` for what is and is not H14a's scope (H14b: the
 * merge-gate table; H14c: the run-start composition root and a real
 * SandboxPort).
 */

/** The three reviewer roles `work_item_transitions.reviewer` accepts
 * (packages/core/src/work-items/stages.ts's `WorkItemTransitionReviewer`)
 * plus `debater`, which is a fourth pipeline role that never writes its
 * own stage transition (see fixLoop.ts's header for why). */
export type ReviewerAgentRole = "code-reviewer" | "security-reviewer" | "acceptance-tester";

/** Every role this package dispatches or records a verdict for. */
export type PipelineRole = "executor" | ReviewerAgentRole | "debater";

/**
 * The verdict vocabulary this package's roles emit in their AGENT_OUTPUT
 * envelope (packages/roles/cards/{code-reviewer,security-reviewer,
 * acceptance-tester,debater}.md): code-reviewer and security-reviewer use
 * `pass` | `needs-fix` (`fail` only for a hard block, treated the same as
 * `needs-fix` here -- see verdictLabels.ts); acceptance-tester uses
 * `pass` | `fail`; debater uses `pass` | `needs-fix`.
 */
export type ReviewVerdict = "pass" | "needs-fix" | "fail";

/** The work item's triage tier (H15's classification, not built yet --
 * this package accepts it as an explicit input rather than assuming a
 * `work_items.kind` value H15 hasn't defined). Only `critical`/`feature`
 * matter to this package (security-reviewer's tier trigger, C11;
 * debater's Feature/Critical gate, packages/roles/src/manifest.ts). */
export type WorkItemTier = "critical" | "feature" | "small" | "bug" | "doc";

/** A GitHub label add/remove diff -- criterion 1's "Verdicts become
 * labels". Applying it to a real PR is a `LabelsPort` the composition
 * root supplies (H14c); this package only computes the diff and calls
 * whatever port it is given, so H14a stays fixture-only (a test's fake
 * port records calls; nothing here makes a GitHub API call). */
export interface LabelDiff {
  add: readonly string[];
  remove: readonly string[];
}

export interface PullRequestRef {
  repoId: string;
  prNumber: number;
}

/** Injected by the caller (a real composition root in H14c; a fixture
 * fake in this package's own tests). Labels are "display only" (C11) --
 * this package never reads them back as an input to any decision. */
export interface LabelsPort {
  setLabels(pr: PullRequestRef, diff: LabelDiff): Promise<void>;
}
