// D#6 M1G-a: the Repos app's human-merge-only rules, kept free of the DOM so a plain node test can read them.
// The operator lists a repository in the server setting; the settings read then carries human_merge_only: true.

export const HUMAN_MERGE_LINE = "A person merges every pull request in this repository. This is set by the operator.";

/** Only the literal true counts; absent, false or anything else is not locked. */
export const isLocked = (settings) => !!settings && settings.human_merge_only === true;

/** The sentence to show for a repo, or "" when it is not locked. */
export const lockNote = (settings) => (isLocked(settings) ? HUMAN_MERGE_LINE : "");

/**
 * Whether the auto-merge toggle is disabled. A locked repo cannot have auto-merge turned on, so the control is disabled
 * while it is off; while it is on (set before the lock) it stays usable, because turning a setting off is always allowed.
 */
export function autoMergeDisabled(settings, { isAdmin, saving }) {
  if (!isAdmin || saving) return true;
  return isLocked(settings) && settings.auto_merge !== true;
}
