/**
 * Which merge-gate reasons leave an item "ready to merge", that is, only a person's press on Merge is missing. The gate files every stop where a person decides
 * under one outcome (`ready_human_merges`) and attaches the reasons; the outcome alone does not say that a pull request exists, is open, is green or is
 * reviewed. An item is ready when its newest gate answer holds no reasons, or only reasons in this set. Any other reason, including a code this list has never
 * heard of, means something still blocks the merge (fail closed).
 *
 * The Pipeline app keeps a copy of this list in plain script (apps/workspace/apps/pipeline/pipeline-insight.js); a test pins the two equal.
 */
export const PERSON_MERGES_REASONS: readonly string[] = Object.freeze([
  // The repository's setting: the cloud does not merge, a person does.
  'auto_merge_not_allowed',
  'human_merge_only',
  // Reviews passed on the person's machine, or the repository runs on it and the cloud does not merge there.
  'local_review_not_enabled',
  'local_reviews_passed_advisory',
  'runner_merge_unavailable',
  'runner_merge_timeout',
  'runner_merge_failed',
  'runner_report_mismatch',
  // A person took over the public branch: the merge is theirs.
  'public_branch_person_managed',
  // No automatic review runs (the caps), a person reviews and merges.
  'review_round_cap',
  'review_compute_cap',
]);

/** Pure: whether a gate answer's reasons leave only the person's press on Merge. No reasons counts as ready. */
export function onlyPersonMerges(reasons: readonly string[]): boolean {
  return reasons.every((r) => PERSON_MERGES_REASONS.includes(r));
}

/** The reasons that still block the merge, in the order the gate recorded them. */
export function blockingReasons(reasons: readonly string[]): string[] {
  return reasons.filter((r) => !PERSON_MERGES_REASONS.includes(r));
}
