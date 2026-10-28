/**
 * D#598 P1f-6a: the fixed words the Pipeline shows for a work item's change to its paired PUBLIC repository.
 * Every sentence is chosen from the stored state and refusal code; nothing here comes from a model, a repository or GitHub.
 * A code this file does not know reads as `PUBLIC_CHANGE_UNKNOWN_REFUSAL`, never as the raw code.
 */

/** The states the item view words today. The record also allows later states; the reader shows no block for those. */
export const PUBLIC_CHANGE_STATES = ['building', 'scanning', 'pushed', 'pr_opened', 'refused', 'pushed_pr_not_opened', 'no_public_change'] as const;
export type PublicChangeState = (typeof PUBLIC_CHANGE_STATES)[number];

export const PUBLIC_CHANGE_STATE_SENTENCE: Record<Exclude<PublicChangeState, 'refused'>, string> = {
  building: 'Building the public change',
  scanning: 'Scanning',
  pushed: 'Pushed',
  pr_opened: 'PR opened',
  pushed_pr_not_opened: 'Pushed, PR not opened',
  no_public_change: 'No public change',
};

/** The reason after "Refused: ", per stored code: the push route's codes, then the worker's own (`retry_limit`, `pairing_off`, `hook_crashed`, `report_mismatch`). */
export const PUBLIC_CHANGE_REFUSAL_REASON: Readonly<Record<string, string>> = {
  bad_input: 'the change could not be read',
  private_read_failed: "the run's commits could not be read from the private repository",
  base_not_ancestor: 'the recorded start of the run is not an ancestor of its last commit',
  pairing_self: 'the public repository is this repository',
  pairing_changed: 'the pairing changed while the change was being prepared',
  pairing_off: 'the pairing is off',
  base_diverged: 'the public repository changed the same files since the build started',
  no_changes: 'there was nothing to send',
  scan_refused: 'the scan found something that must not be public',
  scan_identity_mismatch: 'the scan did not check the change that was built',
  rule_files_not_private: 'the rule files are not private paths; add them to the private paths in the pairing',
  public_unavailable: 'the public repository could not be reached',
  public_tip_moved: 'the public repository moved on while the change was being prepared',
  app_not_installed: 'the GitHub App is not installed on the public repository',
  token_scope_mismatch: 'the access granted for the public repository was wrong',
  branch_exists: 'the branch already exists in the public repository',
  public_branch_moved: 'the public branch was changed outside the cloud',
  republish_base_missing: 'the round had no signed base to rebuild the public change from',
  push_failed: 'the push to the public repository failed',
  unsafe_git_config: 'the git settings of the build were not safe to push from',
  pr_failed: 'the pull request could not be opened',
  retry_limit: 'the push has already been tried three times',
  hook_crashed: 'the publish step stopped before it finished',
  report_mismatch: 'the public repository did not match what was reported',
  // D#483 S5-b2c-4: a planned PR child whose build identity was refused when its change was published. The words are the launch rule's (`childLaunchSentence`), lower-cased for "Refused: ".
  child_orphaned: 'the item this planned PR belonged to was deleted',
  parent_closed: 'the item this planned PR belongs to is closed',
  respec_needs_approval: 'the Spec changed and needs approval again',
  key_not_in_approved_spec: 'this planned PR is no longer in the approved Spec',
  no_issue_link: 'the item this planned PR belongs to has no GitHub issue',
  not_found: 'the item could not be found',
  child_body_closing_keyword: 'the pull request text would have closed an issue, so nothing was sent',
};

/** The refusal entry that carries a failed private read's closed class (`rule_key`). */
export const PRIVATE_READ_REFUSAL_KIND = 'private_read';
/** Fixed words for the class, shown to an account owner or admin after the refusal sentence. A class not listed shows nothing. */
export const PRIVATE_READ_CLASS_SENTENCE: Readonly<Record<string, string>> = {
  auth_denied: 'The private repository refused the read (access denied).',
  not_found: 'The private repository did not have the commit.',
  object_check_failed: 'The commits came across but failed their integrity check.',
  other: 'The read failed for a reason that could not be classed.',
};

export const PUBLIC_CHANGE_UNKNOWN_REFUSAL = 'Refused: the change was not sent';

/** Added after a refusal on a run on the person's machine: that run has ended and cannot push again, so the way forward is a new build. */
export const PUBLIC_CHANGE_RUNNER_HINT = 'Use Build again to try once more.';

export function publicChangeSentence(state: PublicChangeState, code: string | null, runtime: string | null = null): string {
  if (state !== 'refused') return PUBLIC_CHANGE_STATE_SENTENCE[state];
  if (code === null || !Object.hasOwn(PUBLIC_CHANGE_REFUSAL_REASON, code)) return PUBLIC_CHANGE_UNKNOWN_REFUSAL;
  const base = `Refused: ${PUBLIC_CHANGE_REFUSAL_REASON[code]}`;
  return runtime === 'runner' && code !== 'retry_limit' ? `${base}. ${PUBLIC_CHANGE_RUNNER_HINT}` : base;
}

export const isPublicChangeState = (s: string): s is PublicChangeState => (PUBLIC_CHANGE_STATES as readonly string[]).includes(s);
