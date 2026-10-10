/**
 * The exact words the product shows about the local runner. One place, so the dashboard never retypes them and a test can
 * pin each string. Placeholders in braces (`{repo}`, `{time}`, ...) are filled from server data by the caller.
 *
 * D#6 R2b (correction C12 section 5): the last sentence of `localOnly` changed, and `localAutoMerge` is new. The reviews of
 * a runner repo run on the customer's machine, and a repo admin may let a pull request that passes them merge without a
 * person; both strings say that plainly.
 */
export const COPY = {
  localOnly:
    "The agent runs on your machine, signed in with your own Claude login or API key, and pushes with your own git credentials. Our cloud never receives your source files, diffs or Claude credentials. It sees pull-request titles and descriptions, commit messages, the paths of changed files, and run status. You can check this: the runner's source is published for anyone to read, and every message it can send is defined in its protocol package. Reviews run on your machine. A person on your team merges every PR, unless a repo admin turns on auto-merge for this repo.",
  /** Shown where an owner or admin turns auto-merge on for one repo. */
  localAutoMerge:
    "Reviews for this repo run on your machine, through your runner and your own Claude plan. With auto-merge on, a pull request that passes those reviews, your CI and your branch protection merges without a person.",
  cloudVerified:
    "The agent runs on your machine. Its pushes pass through our GitHub proxy in transit and are not stored, and each pull request is reviewed in our sandbox on the API key you connect. Reviewed pull requests can merge automatically.",
  keyRequired: "Cloud-verified review runs on an API key you connect. With a Claude subscription alone, this repo stays local-only.",
  /** D#6 R5b-2b-iii (C40): the repo mode picker in the Repos app. The one place each word is written; the app retypes none of them. */
  modeTitle: "Where this repo's work runs",
  modeSandbox: "Sandbox",
  modeSandboxHelp: "The agent runs in our cloud sandbox.",
  modeLocalOnly: "Local-only",
  modeCloudVerified: "Cloud-verified",
  modeKeyRequiredWhy: "Cloud-verified is off until a model API key is connected.",
  modeTypeName: "Type the repository's full name to confirm.",
  modeApply: "Change mode",
  modeCancel: "Cancel",
  modeSaving: "Saving...",
  modeSaved: "Saved. The mode changed.",
  modeLeaveCancels: "Moving this repo to the sandbox cancels its queued runner runs. A run that is already running is not stopped.",
  modeAdminOnly: "Only owners and admins can change this.",
  modeSaveFailed: "That change couldn't be saved. Try again.",
  modeNameMismatch: "That isn't the repository's name. Type it exactly, including capital letters.",
  modeCopyChanged: "The wording changed, so it was reloaded. Read it and confirm again.",
  modeKeyGone: "No usable model API key is connected any more, so cloud-verified stayed off.",
  modePublicRepo: "A public repository can't run on a runner.",
  modeVisibilityUnknown: "The repository's visibility couldn't be read. Try again in a moment.",
  /** D#6 R5b-2a / R5b-2b-i: the gate line of a cloud-verified pull request whose review did not start. Exact text; the one place each is written. */
  reviewKeyMissing: "A review is waiting for your model key to be connected.",
  reviewQuietUnsettled: "Reviews are waiting for pushes to settle.",
  reviewRoundCap: "This pull request has been reviewed on three versions, so no further automatic review will run. A person reviews and merges it.",
  reviewComputeCap: "This month's allowance for cloud review compute is used up, so this pull request is not reviewed automatically. A person reviews and merges it. The allowance resets on the 1st, UTC.",
  usageLimits: "Work runs within your own Claude plan's usage limits. When you reach them, work pauses until they reset. fulcrumaxe cannot raise them.",
  runner: "Runs the Claude Code you have already signed in to.",
  waiting: "Waiting for a runner: none has been online for {repo} since {time}. Start `fx-runner run` on {machine}.",
  approval: "Waiting for {person} to approve (it runs on their Claude plan).",
  /** D#6 R2b-4a (C30 section 2 item 4, C31 section 3): the approval words the runner screens and the Pipeline row show. The UI retypes none of them. */
  approvalMine: "This run needs your approval. It runs on your Claude plan.",
  approvalButton: "Approve run",
  approvalDone: "Approved. Waiting for your runner.",
  approvalRefused: "This run can no longer be approved.",
  /** A run the claim approved by itself (the dial said announce, and its plan holder's consent is on). `{person}` is that plan holder. */
  approvalAuto: "Approved automatically. It runs on {person}'s Claude plan.",
  /** The sentence a plan holder agrees to when they turn "Run work without asking each time" on for one runner. */
  planConsentText:
    "Let work on this runner's repos run on my Claude plan without asking each time. This includes work anyone in this account starts on those repos. You can turn this off at any time.",
  /** The repo-settings control for the runner-run dial: its title, then its three values (ask, announce, act). */
  dialRunnerRuns: "Runner runs on a member's plan",
  dialRunnerRunsAsk: "Ask each run",
  dialRunnerRunsAnnounce: "Approve and tell me",
  dialRunnerRunsAct: "Approve without asking",
  lost: "Runner lost contact at {time}. Retrying from the last pushed commit (attempt {n} of 2).",
  timedOut: "Timed out waiting for a runner.",
  /** The reason on a queued runner run that was cancelled because its repo left `runner_local` (failure reason `execution_mode_changed`). */
  executionModeChanged: "Cancelled because this repository was moved off your runner. Retry to run it under the new setting.",
  paused: "Paused: Claude usage limit reached.",
  /**
   * D#6 C42-3b: why a queued runner run is not running yet, one plain sentence for each wait reason and each cause of a full runner. Fixed text with no
   * name or time in it. The reasons `timed_out_waiting` and `paused_usage_limit` use `timedOut` and `paused` above, so each sentence is written once.
   */
  waitForRunner: "Waiting for your runner to come online",
  waitForSlot: "Waiting for a free slot on your runner",
  waitForSlotMemory: "Waiting for a free slot on your runner (memory is short)",
  waitForSlotCpu: "Waiting for a free slot on your runner (CPU is busy)",
  waitForSlotDisk: "Waiting for a free slot on your runner (disk is low)",
  waitRunnerPaused: "Your runner is paused",
  waitRunnerAtLimit: "Waiting: your runner is at its job limit",
  waitAccountCap: "Waiting: your account's runner job limit is reached",
  waitApproval: "Waiting for approval before this run starts on a Claude plan",
  waitRunnerLost: "Your runner lost contact. Retrying from the last pushed commit",
  /** D#6 R4a-7: shown on a run its owner took over by hand on the runner machine (failure reason `taken_over`). `{time}` is the time of the `taken_over` event. */
  takenOver: "Taken over on the runner machine at {time}",
  /** D#6 R4a-2 (C24 section 1): `{detail}` is the closed code the runner sent, shown as it is; nothing else the runner says is shown. */
  jobRefused: "Your runner refused this job ({detail}). Update the runner, then retry.",
  /** D#6 R4a-6 (C16 section 1.3): on the runner screen for a runner whose sandbox does not work. `{reason}` is the closed code it reported. */
  sandboxUnavailable: "Sandbox not working on this machine ({reason}). Run `fx-runner doctor` there to see the fix.",
  agentFailed: "The agent stopped without finishing. Retry, or open the run for details.",
  runnerSetupFailed: "Your runner could not start the agent ({detail}). Check the runner's setup, then retry.",
  /** D#6 R4a-3b (C25 section 1.4): shown when a fix round's push was rejected. */
  pushRejected: "Your runner could not push to the pull request's branch, because the branch changed while the agent was working. Retry to run on the new head.",
  pushTooLarge:
    "This push is {size} MB; the limit through our proxy is 4 MB. A person can push this commit, or you can switch this repo to local-only (auto-merge turns off).",
  /** D#6 R5a-2b (C27 section 4.5): shown for a `run_ended` `clone_limited`. Exact text (C28 section 3 item 7); the one place it is written. */
  cloneLimited: "This repository has used today's download allowance through our proxy. The runner keeps a copy, so this is rare. It resets at 00:00 UTC.",
  /** D#6 R4d-2 (C32 section 2), the three details of a run that published nothing. Exact text; the one place each is written. */
  headNotFromBase: "The agent's work did not start from this run's starting point, so the runner did not publish it. Build again.",
  sandboxStubCommitted: "The agent committed empty placeholder files the sandbox makes, so the runner did not publish it. Build again.",
  workspaceGitRefused: "The runner could not safely read the agent's git folder, so nothing was published. Update fx-runner, then Build again.",
  /** The description of the draft pull request our cloud opens when a runner run finishes. Fixed text: the agent's own output never goes into it. */
  pullRequestBody: "Opened by fulcrumaxe for run {run} on work item {item}. The agent ran on your own machine; this description is fixed text and holds nothing the agent wrote.",
  /** The pull request title when the work item has none. */
  pullRequestTitleFallback: "Changes from your runner",
  /** D#6 R2b-3f: why an executor run ended `scope_unknown` when the Spec's file scope could not be read (no scope on record, or one the matcher cannot parse). */
  scopeUnknown:
    "This work's file scope could not be read, so the changes were not checked and no pull request was opened. The branch is kept so you can open the PR yourself.",
  /** D#6 R4d-5a (C34 section 2.4): a build refused at start (`spec_has_no_file_list`) and a run that ended `scope_unknown` with detail `no_file_list`. Exact text; the one place it is written. */
  specHasNoFileList:
    "This Spec has no file list, so the platform cannot check the agent's changes and will not open a pull request. Re-spec to have the project manager add the list (the Spec's text stays the same), then Build again.",
  /** D#6 R4d-5b (C34 section 2.4): shown after a Re-spec whose project-manager file list could not be read (nothing was changed). Exact text; the one place it is written. */
  respecListUnreadable: "The project manager's file list for this Spec could not be read, so nothing was changed. Re-spec to try again.",
  /** D#6 R4d-5c (C36 section 3): a retry, fix round or continuation refused `no_spec_version` because the run it follows was built before runs were tied to a Spec version. Exact text; the one place it is written. */
  noSpecVersion:
    "This work was built before the platform recorded which Spec it was built against, so it cannot be continued on your runner. Re-spec if the Spec needs a change, then Build again.",
  /** D#6 R2b-3f (C23 section 3): the one `scope_unknown` variant for a renamed file. It names no path. */
  scopeUnknownRenamed:
    "GitHub reported a renamed file. A rename's old path can't be read without reading file contents, which this repository's runner setting forbids. The branch is kept so you can open the PR yourself.",
  /** D#6 R2b-3f (C23 section 4): `pr_rejected` with the HTTP status GitHub answered. Never any GitHub message text. */
  prRejected: "GitHub refused to open the pull request (HTTP {status}). The branch is kept so you can open the PR yourself.",
  /** D#6 R2b-3f: `pr_rejected` when no HTTP status exists, because an open pull request on the run's branch was not opened by fulcrumaxe and was left untouched. */
  prRejectedForeign:
    "GitHub already has an open pull request for this branch that fulcrumaxe did not open, so it was left alone. The branch is kept so you can open the PR yourself.",
  pricingLine: "The runner is free to use. The $49 plan pays for the cloud side: dispatch, verification, the dashboard and review compute.",
} as const;

export type CopyKey = keyof typeof COPY;

/**
 * D#6 R4d-2 (C32 section 3): the line for each detail the runner's git path can end a run with. Each says what happened to the work and what to do;
 * none holds a path, a code or text from the agent. The last three are the rulings' exact words (`COPY`).
 */
export const GIT_PATH_LINES = {
  push_ref_refused: "The runner would not publish the agent's work, because it was not shaped like a run's branch. Nothing was published. Build again.",
  snapshot_refused: "The runner could not safely copy the agent's work out of its folder (it may be too large), so nothing was published. Build again.",
  push_failed: "The runner could not push the agent's work to GitHub with your git credentials, so nothing was published. Check that git can push to this repository from that machine, then Build again.",
  mirror_failed: "The runner could not update its local copy of this repository, so the run did not start. Check the runner machine's git access to the repository, then Build again.",
  mirror_dir_insecure: "The folder where the runner keeps its repository copies is not private enough to use. Fix its permissions, then Build again.",
  git_version_unsupported: "The git on the runner machine is too old. Update git, then Build again.",
  workspace_failed: "The runner could not prepare a working folder for the agent. Check the disk space and git access on that machine, then Build again.",
  workspace_git_refused: COPY.workspaceGitRefused,
  head_not_from_base: COPY.headNotFromBase,
  sandbox_stub_committed: COPY.sandboxStubCommitted,
  review_sha_not_in_mirror: "The runner's copy of the repository does not have the commit to review on any branch, so the review did not start. If the pull request comes from a fork, it cannot be reviewed on your machine. Otherwise, review again.",
} as const;

/** D#6 R4d-4 (C33 section 3): the line for a review job the runner refused before starting it (`job_refused`). */
export const REVIEW_REFUSED_LINE = "The runner refused a review job it could not check. Update fx-runner, then review again.";
export const JOB_REFUSED_LINES = { review_sha_missing: REVIEW_REFUSED_LINE, review_wrong_role: REVIEW_REFUSED_LINE } as const;

/** What the dashboard shows for a `run_ended` `job_refused` event's detail: a line of its own for the review refusals, else the plain code. */
export function jobRefusedText(detail: string): string {
  const own = (JOB_REFUSED_LINES as Readonly<Record<string, string>>)[detail];
  return own !== undefined ? own : `Your runner refused this job (${detail}).`;
}

/**
 * What the dashboard shows for a `run_ended` `runner_setup` event (C24 section 1, C27 section 4.5). The closed `detail` code is shown as the runner
 * sent it, except the details with a string of their own: `push_too_large` (with `size_mb`), `clone_limited`, and the git-path ones in `GIT_PATH_LINES`. Never null: a missing or
 * out-of-range size shows the plain code, not a hole in the sentence.
 */
export function runnerSetupText(detail: string, sizeMb?: number): string {
  if (detail === "clone_limited") return COPY.cloneLimited;
  const own = (GIT_PATH_LINES as Readonly<Record<string, string>>)[detail];
  if (own !== undefined) return own;
  if (detail === "push_too_large" && sizeMb !== undefined && Number.isSafeInteger(sizeMb) && sizeMb >= 5) return COPY.pushTooLarge.replace("{size}", String(sizeMb));
  return COPY.runnerSetupFailed.replace("{detail}", detail);
}
