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
/**
 * D#6 STOP-SENTENCE-BUILD-AGAIN: these stops end a fix round, which only runs while the pull request is open, and Build again stops at an open pull request. So each ends on the one step that works,
 * Request changes (a new fix round), as `republish_failed` does. The sentence is true for any viewer; `openPrStopSentence` swaps the last step for the one the viewer's card lists.
 */
const STEP_ANY = "An owner or admin can press Request changes, once no agents are working, to run another round.";
const STEP_PRESS = "Press Request changes to run another round.";
const STEP_ROUNDS = "All of this pull request's fix rounds are used, so the cloud can't run another. Update the public branch yourself, or close this item.";
const STACKED_STEP_ANY = "; then an owner or admin can press Request changes, once no agents are working, to run another round.";
const STACKED_STEP_PRESS = "; then press Request changes to run another round.";
const STACKED_STEP_ROUNDS = ". All of this pull request's fix rounds are used, so the cloud can't run another round.";
const OPEN_PR_LEADS = {
  conflict: "Main has changed in the same places as this change, so the cloud couldn't bring the branch up to date. Nothing was started. Update the branch on GitHub (fix the conflict there).",
  unavailable: "Couldn't bring the branch up to date on GitHub, so the fix round was not started. Nothing was changed.",
  noChange: "The fix round made no changes to publish, so the public pull request is unchanged. Look at the round.",
  tipMoved: "Public main moved, try again. The public repository changed twice while the cloud was preparing the update, so the public pull request still shows the earlier change.",
} as const;
/** The sentence a viewer sees for a stop above: `sentence` is its generic form; any other text is returned as it is. */
export function openPrStopSentence(sentence: string, canRequestChanges: boolean, roundsUsed: boolean): string {
  // The stacked-change stops end a GitHub step with "; then <any viewer's step>." (below): the same per-viewer swap, so a viewer whose card does not list Request changes is not told to press it.
  if (sentence.includes(STACKED_STEP_ANY)) return sentence.replace(STACKED_STEP_ANY, canRequestChanges ? STACKED_STEP_PRESS : roundsUsed ? STACKED_STEP_ROUNDS : STACKED_STEP_ANY);
  const lead = Object.values(OPEN_PR_LEADS).find((l) => sentence === `${l} ${STEP_ANY}`);
  return lead === undefined ? sentence : `${lead} ${canRequestChanges ? STEP_PRESS : roundsUsed ? STEP_ROUNDS : STEP_ANY}`;
}
export const BASE_SYNC_CONFLICT_SENTENCE = `${OPEN_PR_LEADS.conflict} ${STEP_ANY}`;
export const BASE_SYNC_UNAVAILABLE_SENTENCE = `${OPEN_PR_LEADS.unavailable} ${STEP_ANY}`;

/**
 * FIXROUND-REPUBLISH (R2-c0): a fix round on an item whose public pull request is open must end by republishing that pull request from a base the cloud signed. A round that cannot be signed with one, or whose
 * change is stacked on another pull request (the public copy of a stacked change is not rebuilt yet), is refused before anything starts and the item goes to a person. Both are recorded as `escalated`.
 */
export const REPUBLISH_BASE_MISSING = 'republish_base_missing';
export const REPUBLISH_STACKED_UNSUPPORTED = 'republish_stacked_unsupported';
/** D#6 FIXROUND-REPUBLISH-STACKED: the pull request a change is stacked on was merged or closed, but this change's own pull request still points at its branch. Refused before any merge; recorded as `escalated`. */
export const REPUBLISH_STACK_PARENT_ENDED = 'republish_stack_parent_ended';
/** D#6 FIXROUND-REPUBLISH-STACKED: the pull request a change is stacked on was closed without merging. The change's branch still holds that closed work, so a round is refused before any merge, whatever the pull request's base now is. Recorded as `escalated`. */
export const REPUBLISH_STACK_PARENT_CLOSED = 'republish_stack_parent_closed';
/** D#6 FIXROUND-RETARGET-OPEN-PARENT: this change's pull request targets main while the pull request it is stacked on is still open, so its branch holds that unmerged work and a round would publish it. Refused before any merge; recorded as `escalated`. */
export const REPUBLISH_STACK_PARENT_OPEN = 'republish_stack_parent_open';
export const REPUBLISH_STACK_PARENT_OPEN_SENTENCE = "The pull request this change is stacked on is still open, but this pull request's base is main, and this change's branch holds that unmerged work, so another round would publish it. Nothing was started. Change this pull request's base back to the branch it is stacked on, on GitHub; then an owner or admin can press Request changes, once no agents are working, to run another round.";
/** The pull request a change is stacked on merged into a branch other than the default branch. This change's branch holds that work, which is not in main, so a round is refused before any merge, whatever the pull request's base now is. */
export const REPUBLISH_STACK_PARENT_OFF_MAIN = 'republish_stack_parent_off_main';
export const REPUBLISH_STACK_PARENT_OFF_MAIN_SENTENCE = "The pull request this change is stacked on was merged into a branch other than main, and this change's branch holds that work, so another round would publish it. Nothing was started. The cloud will not run more rounds on this change, and pressing Request changes will not help. Update this pull request's branch on GitHub yourself, so that it no longer holds that work, or close this item and start the change again as a new item once that work is in main.";
/** The item this change is stacked on has no pull request the cloud can read (none recorded where one is needed, or its public one is gone), so the cloud cannot tell whether its work is in main. It clears only if that item's pull request gets recorded (a review of it does that); a public one that is gone does not come back. */
export const REPUBLISH_STACK_PARENT_NO_PULL_REQUEST = 'republish_stack_parent_no_pull_request';
export const REPUBLISH_STACK_PARENT_NO_PULL_REQUEST_SENTENCE = "The cloud can't find a pull request for the item this change is stacked on (none is recorded in the private repository, or the public one no longer exists), so it can't tell whether that work is in main, and another round could publish it. Nothing was started. This clears only if that item's pull request gets recorded (a review of that item records it); trying again before then changes nothing. Otherwise update this pull request's branch on GitHub yourself, or close this item and start the change again as a new item.";
export const REPUBLISH_BASE_MISSING_SENTENCE = "The cloud couldn't tell which commit of main this change builds on, so it can't update the public pull request safely. Nothing was started. Ask a person to look at the branch, then press Build again.";
export const REPUBLISH_STACKED_UNSUPPORTED_SENTENCE = "This change is stacked on another pull request, and the cloud updates the public copy of a stacked change only from a review or check fix round that runs in the cloud's sandbox. Nothing was started. Merge the pull request it is stacked on and change this pull request's base to main on GitHub; then an owner or admin can press Request changes, once no agents are working, to run another round. If it was merged into a branch other than main, update this pull request's branch on GitHub yourself instead, so that it no longer holds that work.";
export const REPUBLISH_STACK_PARENT_ENDED_SENTENCE = "The pull request this change is stacked on has been merged, but this one still points at its branch. Nothing was started. Change this pull request's base to main on GitHub; then an owner or admin can press Request changes, once no agents are working, to run another round.";
export const REPUBLISH_STACK_PARENT_CLOSED_SENTENCE = "The pull request this change is stacked on was closed without being merged, and this change's branch still holds that closed work, so changing this pull request's base to main would publish it. Nothing was started. Reopen the closed pull request on GitHub (restore its branch first if it was deleted; if that change was published, reopen both its public pull request and its private copy, because reopening only one leaves this stopped) and make sure this pull request's base is that branch; then an owner or admin can press Request changes, once no agents are working, to run another round.";

/**
 * FIXROUND-REPUBLISH (R2-c1): the fix round finished and its change is on the private branch, but the public pull request could not be updated from it. Recorded as `escalated`; the item goes to a person.
 * `republish_branch_moved`: the public branch was changed outside the cloud (the compare-and-swap refused). `republish_failed`: any other refusal of the update.
 */
export const REPUBLISH_BRANCH_MOVED = 'republish_branch_moved';
export const REPUBLISH_FAILED = 'republish_failed';
export const REPUBLISH_BRANCH_MOVED_SENTENCE = "The fix round finished, but the public pull request's branch was changed outside the cloud, so it was not updated. Close it or reset its branch, then press Build again.";
const REPUBLISH_FAILED_LEAD = "The fix round finished, but the cloud couldn't update the public pull request, so it still shows the earlier change. Nothing in the private repository was lost.";
/** Build again cannot help here (an open pull request stops a rebuild), so the one step is Request changes: a new fix round that publishes again. The generic sentence is true for any viewer; the other two are chosen from what the viewer's card offers. */
export const REPUBLISH_FAILED_SENTENCE = `${REPUBLISH_FAILED_LEAD} An owner or admin can press Request changes, once no agents are working, to run another round that tries to update it again.`;
export const REPUBLISH_FAILED_PRESS_SENTENCE = `${REPUBLISH_FAILED_LEAD} Press Request changes to run another round that tries to update it again.`;
export const REPUBLISH_FAILED_ROUNDS_SENTENCE = `${REPUBLISH_FAILED_LEAD} All of this pull request's fix rounds are used, so the cloud can't run another. Update the public branch yourself, or close this item.`;
/** The `republish_failed` sentence for a viewer: the step it names is the one that viewer's card lists (`request_changes` offered, or refused because the rounds are used). */
export function republishFailedSentence(canRequestChanges: boolean, roundsUsed: boolean): string {
  return canRequestChanges ? REPUBLISH_FAILED_PRESS_SENTENCE : roundsUsed ? REPUBLISH_FAILED_ROUNDS_SENTENCE : REPUBLISH_FAILED_SENTENCE;
}
/** The fix round ended with nothing to publish (it added no commit, or its change is already in the public tip), so the public pull request is unchanged. Recorded as `escalated`. */
export const REPUBLISH_NO_CHANGE = 'republish_no_change';
/** D#598 P1g-3a-3: the same end for the round a person's confirmed Replace started. The Replace is spent and a rebuild is refused while the pull request is open, so the sentence does not say to build again. */
export const REPUBLISH_REPLACE_NO_CHANGE = 'republish_replace_no_change';
/**
 * D#598 P1g-3a-3: the update of the round a person's confirmed Replace started was refused for a reason that is not about the branch (GitHub or the pairing could not be reached). The Replace is spent, a rebuild is
 * refused while the pull request is open, and the question is raised again with the branch as it is now, so the person answers it again at once.
 */
export const REPUBLISH_REPLACE_FAILED = 'republish_replace_failed';
export const REPUBLISH_REPLACE_FAILED_SENTENCE = "The replacement round finished, but the cloud couldn't update the public pull request just now, so it still shows the earlier change. Nothing was sent and your answer is used up. Answer the question again, or update the branch yourself.";
export const REPUBLISH_REPLACE_NO_CHANGE_SENTENCE = "The replacement round made no change to publish. Nothing was sent, and the public pull request still shows the earlier change. Answer again, or update the branch yourself.";
export const REPUBLISH_NO_CHANGE_SENTENCE = `${OPEN_PR_LEADS.noChange} ${STEP_ANY}`;

/**
 * D#598 P1g-1: the update of the public pull request stopped before anything was pushed. The branch is untouched; each sentence says what happened and what the person can do on GitHub
 * (reopen and close choices in the cloud arrive later). Recorded as `escalated`.
 */
export const REPUBLISH_TIP_MOVED = 'republish_tip_moved';
/** D#598 P1g-3a-3: the same end for the round a person's confirmed Replace started: the answer is used up and the question is raised again, so the sentence does not say to build again. */
export const REPUBLISH_REPLACE_TIP_MOVED = 'republish_replace_tip_moved';
export const REPUBLISH_REPLACE_TIP_MOVED_SENTENCE = "Public main moved, try again. The public repository changed twice while the cloud was preparing the update, so the public pull request still shows the earlier change. Nothing was sent and your answer is used up. Answer the question again, or update the branch yourself.";
export const REPUBLISH_PR_CLOSED = 'republish_pr_closed';
export const REPUBLISH_PR_MERGED = 'republish_pr_merged';
export const REPUBLISH_PAIRING_OFF = 'republish_pairing_off';
export const REPUBLISH_TIP_MOVED_SENTENCE = `${OPEN_PR_LEADS.tipMoved} ${STEP_ANY}`;
export const REPUBLISH_PR_CLOSED_SENTENCE = "Public PR closed. The fix round finished, but the public pull request was closed without merging, so it was not updated. To update it, reopen the pull request on GitHub first.";
export const REPUBLISH_PR_MERGED_SENTENCE = "Public PR already merged. The fix round finished, but the public pull request was already merged, so nothing was pushed. Follow-up work becomes a new item.";
export const REPUBLISH_PAIRING_OFF_SENTENCE = "Public PR is open but the pairing is off. The fix round finished, but this repository is no longer paired with its public repository, so the open public pull request was not updated. Turn the pairing back on in the repository settings, or leave the pull request as it is.";

/**
 * D#598 P1g-3a-3: a round a person's Replace started that ends without a landed update is recorded under the Replace form of its code (the marker on its run decides), and the
 * "someone pushed" question is raised again. `republish_branch_moved` is the same question's other way in and keeps its own code.
 */
export const REPLACE_ROUND_CODE_OF: Readonly<Record<string, string>> = {
  [REPUBLISH_NO_CHANGE]: REPUBLISH_REPLACE_NO_CHANGE,
  [REPUBLISH_TIP_MOVED]: REPUBLISH_REPLACE_TIP_MOVED,
  [REPUBLISH_FAILED]: REPUBLISH_REPLACE_FAILED,
};
export const REPLACE_ROUND_CODES: readonly string[] = Object.values(REPLACE_ROUND_CODE_OF);

/** Every code of this module that stops a fix round, with its fixed sentence (the item view reads this table). */
export const FIX_ROUND_STOP_SENTENCE: Readonly<Record<string, string>> = {
  [BASE_SYNC_CONFLICT]: BASE_SYNC_CONFLICT_SENTENCE,
  [BASE_SYNC_UNAVAILABLE]: BASE_SYNC_UNAVAILABLE_SENTENCE,
  [REPUBLISH_BASE_MISSING]: REPUBLISH_BASE_MISSING_SENTENCE,
  [REPUBLISH_STACKED_UNSUPPORTED]: REPUBLISH_STACKED_UNSUPPORTED_SENTENCE,
  [REPUBLISH_STACK_PARENT_ENDED]: REPUBLISH_STACK_PARENT_ENDED_SENTENCE,
  [REPUBLISH_STACK_PARENT_CLOSED]: REPUBLISH_STACK_PARENT_CLOSED_SENTENCE,
  [REPUBLISH_STACK_PARENT_OPEN]: REPUBLISH_STACK_PARENT_OPEN_SENTENCE,
  [REPUBLISH_STACK_PARENT_OFF_MAIN]: REPUBLISH_STACK_PARENT_OFF_MAIN_SENTENCE,
  [REPUBLISH_STACK_PARENT_NO_PULL_REQUEST]: REPUBLISH_STACK_PARENT_NO_PULL_REQUEST_SENTENCE,
  [REPUBLISH_BRANCH_MOVED]: REPUBLISH_BRANCH_MOVED_SENTENCE,
  [REPUBLISH_FAILED]: REPUBLISH_FAILED_SENTENCE,
  [REPUBLISH_NO_CHANGE]: REPUBLISH_NO_CHANGE_SENTENCE,
  [REPUBLISH_REPLACE_NO_CHANGE]: REPUBLISH_REPLACE_NO_CHANGE_SENTENCE,
  [REPUBLISH_REPLACE_FAILED]: REPUBLISH_REPLACE_FAILED_SENTENCE,
  [REPUBLISH_REPLACE_TIP_MOVED]: REPUBLISH_REPLACE_TIP_MOVED_SENTENCE,
  [REPUBLISH_TIP_MOVED]: REPUBLISH_TIP_MOVED_SENTENCE,
  [REPUBLISH_PR_CLOSED]: REPUBLISH_PR_CLOSED_SENTENCE,
  [REPUBLISH_PR_MERGED]: REPUBLISH_PR_MERGED_SENTENCE,
  [REPUBLISH_PAIRING_OFF]: REPUBLISH_PAIRING_OFF_SENTENCE,
};
