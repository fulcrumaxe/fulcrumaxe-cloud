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
  resumeFailed: "The fix round could not start because of a fault on our side. Nothing was changed on GitHub beyond bringing the branch up to date.",
  alreadyRunning: "The fix round could not start because an earlier round's record was in the way. Nothing was changed.",
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
/** A fix round that stopped on a fault of ours before a run was created (the code the driver records is `resume_failed`). */
export const RESUME_FAILED = 'resume_failed';
export const RESUME_FAILED_SENTENCE = `${OPEN_PR_LEADS.resumeFailed} ${STEP_ANY}`;
/** A fix round refused because a live round is already recorded under the same run (the code is `already_running`). */
export const ROUND_ALREADY_RUNNING = 'already_running';
export const ROUND_ALREADY_RUNNING_SENTENCE = `${OPEN_PR_LEADS.alreadyRunning} ${STEP_ANY}`;

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
/**
 * The `republish_failed` sentence for a viewer: the step it names is the one that viewer's card lists (`request_changes` offered, or refused because the rounds are used).
 * `reason` is the fixed words of the stored refusal code of the failed update (`PUBLIC_CHANGE_REFUSAL_REASON`, a closed vocabulary), already looked up by the caller; null keeps the generic sentence.
 */
export function republishFailedSentence(canRequestChanges: boolean, roundsUsed: boolean, reason: string | null = null, terminal = false): string {
  // A terminal reason already says to close the item and start again; no round can help, so no step is added after it.
  if (reason !== null && terminal) return `${REPUBLISH_FAILED_LEAD} Refused: ${reason}.`;
  const generic = canRequestChanges ? REPUBLISH_FAILED_PRESS_SENTENCE : roundsUsed ? REPUBLISH_FAILED_ROUNDS_SENTENCE : REPUBLISH_FAILED_SENTENCE;
  return reason === null ? generic : generic.replace(`${REPUBLISH_FAILED_LEAD} `, `${REPUBLISH_FAILED_LEAD} Refused: ${reason}. `);
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

/**
 * A fix round the driver refused before any run existed leaves the item at Changes requested. Each code `refuse()` can record there has a fixed plain sentence saying what to do;
 * nothing the person did not write is echoed. A code that is not listed (and not a `continues_*` code) gets the generic sentence, which never names the code.
 */
export const FIX_ROUND_REFUSAL_FALLBACK_SENTENCE = "The fix round could not start, and nothing was changed on GitHub. Check the item's repository settings and its pull request, then ask for another round. If it stops again, ask for help.";
const FIX_ROUND_REFUSAL_SENTENCE: Readonly<Record<string, string>> = {
  no_spec_version: "The fix round could not start because the build this change continues has no approved Spec saved with it. Nothing was changed. Start a new build from the approved Spec instead of asking for another round.",
  execution_mode_changed: "The fix round could not start because this repository's run setting changed while the round was being prepared. Nothing was changed. Ask for the round again.",
  starter_unavailable: "The fix round could not start because the cloud could not begin a run just now. Nothing was changed. Ask for the round again in a few minutes.",
  pr_unbound: "The fix round could not start because the pull request is no longer paired with this item. Nothing was changed. Check on GitHub that the pull request is still open and still this item's, then ask again.",
  pr_branch_unsupported: "The fix round could not start because this pull request's branch is not one the cloud can update. Nothing was changed. Make the fixes on the branch yourself.",
  parent_chain_too_long: "The fix round could not start because this change has had too many earlier rounds recorded to continue from. Nothing was changed. Update the branch yourself, or start a new build.",
  job_too_large: "The fix round could not start because the work to hand over is too large for one run. Nothing was changed. Split the change into smaller pull requests.",
  item_halted: "The fix round could not start because this item is halted. Nothing was changed. Resume the item first, then ask for another round.",
  verified_consent_stale: "The fix round could not start because this repository's verified-copy consent is out of date. Nothing was changed. Review and confirm the consent in the repository settings, then ask again.",
  no_repo: "The fix round could not start because this item has no repository. Nothing was changed. Connect a repository to the item, then ask again.",
  no_session: "The fix round could not start because the build it continues has no saved session. Nothing was changed. Start a new build instead.",
  max_fix_rounds: "The fix round could not start because this item has used all the fix rounds its plan allows. Nothing was changed. Update the branch yourself, or ask an owner about the plan.",
  refused_spend: "The fix round could not start because a spending limit refused the run. Nothing was changed. Raise the limit, then ask for another round.",
  conflict_public_copy: "The fix round could not start because the public copy of the branch conflicts with the cloud's. Nothing was changed. Update the branch on GitHub yourself.",
  stage_changed: "The fix round could not start because the item moved to another stage while it was being prepared. Nothing was changed. Check where the item is now, then ask again if it still needs a round.",
};
/** The sentence for a refused fix round's code: always non-empty, and never the code itself. */
export function fixRoundRefusalSentence(code: string): string {
  if (Object.hasOwn(FIX_ROUND_STOP_SENTENCE, code)) return FIX_ROUND_STOP_SENTENCE[code]!;
  if (Object.hasOwn(FIX_ROUND_REFUSAL_SENTENCE, code)) return FIX_ROUND_REFUSAL_SENTENCE[code]!;
  if (code.startsWith("continues_")) return "The fix round could not start because the pull request it continues is closed, protected, or could not be read on GitHub. Nothing was changed. Check the pull request on GitHub, then ask again.";
  return FIX_ROUND_REFUSAL_FALLBACK_SENTENCE;
}

/** Every code of this module that stops a fix round, with its fixed sentence (the item view reads this table). */
export const FIX_ROUND_STOP_SENTENCE: Readonly<Record<string, string>> = {
  [BASE_SYNC_CONFLICT]: BASE_SYNC_CONFLICT_SENTENCE,
  [BASE_SYNC_UNAVAILABLE]: BASE_SYNC_UNAVAILABLE_SENTENCE,
  [RESUME_FAILED]: RESUME_FAILED_SENTENCE,
  [ROUND_ALREADY_RUNNING]: ROUND_ALREADY_RUNNING_SENTENCE,
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
