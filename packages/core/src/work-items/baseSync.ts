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
