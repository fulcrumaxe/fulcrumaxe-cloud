/**
 * FIXROUND-BASE-SYNC: before a fix round (a review fix or a check fix) the cloud merges the pull request's base branch into the item's private branch, so the
 * round never builds on a stale base. The two ways it can refuse, by fixed code, and the fixed sentence the item shows for each. The words are fixed text:
 * nothing from GitHub, the branch or the item is put in.
 */
/** The base and the branch conflict (GitHub answered 409). Recorded as `escalated`; the item goes to Needs a person. */
export const BASE_SYNC_CONFLICT = 'base_sync_conflict';
/** The branch could not be brought up to date (GitHub could not be asked, or answered something else). Recorded as `stopped`; nothing was started. */
export const BASE_SYNC_UNAVAILABLE = 'base_sync_unavailable';
/** The code of the `pr_head_pushed` fact the sync's merge commit leaves. */
export const BASE_SYNCED = 'base_synced';
export const BASE_SYNC_CONFLICT_SENTENCE = "Main has changed in the same places as this change, so the cloud couldn't bring the branch up to date. Nothing was started. Update the branch on GitHub (fix the conflict there), then press Build again.";
export const BASE_SYNC_UNAVAILABLE_SENTENCE = "Couldn't bring the branch up to date on GitHub, so the fix round was not started. Nothing was changed. Press Build again in a moment.";

/**
 * FIXROUND-REPUBLISH (R2-c0): a fix round on an item whose public pull request is open must end by republishing that pull request from a base the cloud signed. A round that cannot be signed with one, or whose
 * change is stacked on another pull request (the public copy of a stacked change is not rebuilt yet), is refused before anything starts and the item goes to a person. Both are recorded as `escalated`.
 */
export const REPUBLISH_BASE_MISSING = 'republish_base_missing';
export const REPUBLISH_STACKED_UNSUPPORTED = 'republish_stacked_unsupported';
export const REPUBLISH_BASE_MISSING_SENTENCE = "The cloud couldn't tell which commit of main this change builds on, so it can't update the public pull request safely. Nothing was started. Ask a person to look at the branch, then press Build again.";
export const REPUBLISH_STACKED_UNSUPPORTED_SENTENCE = "This change is stacked on another pull request, and the cloud can't update the public copy of a stacked change yet. Nothing was started. Merge the pull request it is stacked on, then press Build again.";
/** Every code of this module that stops a fix round, with its fixed sentence (the item view reads this table). */
export const FIX_ROUND_STOP_SENTENCE: Readonly<Record<string, string>> = {
  [BASE_SYNC_CONFLICT]: BASE_SYNC_CONFLICT_SENTENCE,
  [BASE_SYNC_UNAVAILABLE]: BASE_SYNC_UNAVAILABLE_SENTENCE,
  [REPUBLISH_BASE_MISSING]: REPUBLISH_BASE_MISSING_SENTENCE,
  [REPUBLISH_STACKED_UNSUPPORTED]: REPUBLISH_STACKED_UNSUPPORTED_SENTENCE,
};
