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
    "The agent runs on your machine, signed in with your own Claude login or API key, and pushes with your own git credentials. Our cloud never receives your source files, diffs or Claude credentials. It sees pull-request titles and descriptions, commit messages, the paths of changed files, and run status. You can check this: the runner is open source, and every message it can send is defined in its public protocol package. Reviews run on your machine. A person on your team merges every PR, unless a repo admin turns on auto-merge for this repo.",
  /** Shown where an owner or admin turns auto-merge on for one repo. */
  localAutoMerge:
    "Reviews for this repo run on your machine, through your runner and your own Claude plan. With auto-merge on, a pull request that passes those reviews, your CI and your branch protection merges without a person.",
  cloudVerified:
    "The agent runs on your machine. Its pushes pass through our GitHub proxy in transit and are not stored, and each pull request is reviewed in our sandbox on the API key you connect. Reviewed pull requests can merge automatically.",
  keyRequired: "Cloud-verified review runs on an API key you connect. With a Claude subscription alone, this repo stays local-only.",
  usageLimits: "Work runs within your own Claude plan's usage limits. When you reach them, work pauses until they reset. fulcrumaxe cannot raise them.",
  runner: "Runs the Claude Code you have already signed in to.",
  waiting: "Waiting for a runner: none has been online for {repo} since {time}. Start `fx-runner run` on {machine}.",
  approval: "Waiting for {person} to approve (it runs on their Claude plan).",
  lost: "Runner lost contact at {time}. Retrying from the last pushed commit (attempt {n} of 2).",
  timedOut: "Timed out waiting for a runner.",
  /** The reason on a queued runner run that was cancelled because its repo left `runner_local` (failure reason `execution_mode_changed`). */
  executionModeChanged: "Cancelled because this repository was moved off your runner. Retry to run it under the new setting.",
  paused: "Paused: Claude usage limit reached.",
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
  /** D#6 R5a-2b (C27 section 4.5): shown for a `run_ended` `clone_limited`. Exact text; the daily figure is pinned to the database function by a test. */
  cloneLimited: "This repository has been cloned in full 3 times today through our proxy, the daily limit. The runner keeps a copy so this is rare. It resets at 00:00 UTC.",
  /** The description of the draft pull request our cloud opens when a runner run finishes. Fixed text: the agent's own output never goes into it. */
  pullRequestBody: "Opened by fulcrumaxe for run {run} on work item {item}. The agent ran on your own machine; this description is fixed text and holds nothing the agent wrote.",
  /** The pull request title when the work item has none. */
  pullRequestTitleFallback: "Changes from your runner",
  /** D#6 R2b-3f: why an executor run ended `scope_unknown` when the Spec's file scope could not be read (no scope on record, or one the matcher cannot parse). */
  scopeUnknown:
    "This work's file scope could not be read, so the changes were not checked and no pull request was opened. The branch is kept so you can open the PR yourself.",
  /** D#6 R2b-3f (C23 section 3): the one `scope_unknown` variant for a renamed file. It names no path. */
  scopeUnknownRenamed:
    "GitHub reported a renamed file. A rename's old path can't be read without reading file contents, which this repository's runner setting forbids. The branch is kept so you can open the PR yourself.",
  /** D#6 R2b-3f (C23 section 4): `pr_rejected` with the HTTP status GitHub answered. Never any GitHub message text. */
  prRejected: "GitHub refused to open the pull request (HTTP {status}). The branch is kept so you can open the PR yourself.",
  /** D#6 R2b-3f: `pr_rejected` when no HTTP status exists, because an open pull request on the run's branch was not opened by fulcrumaxe and was left untouched. */
  prRejectedForeign:
    "GitHub already has an open pull request for this branch that fulcrumaxe did not open, so it was left alone. The branch is kept so you can open the PR yourself.",
  pricingLine: "The runner is free and open source. The $49 plan pays for the cloud side: dispatch, verification, the dashboard and review compute.",
} as const;

export type CopyKey = keyof typeof COPY;

/**
 * What the dashboard shows for a `run_ended` `runner_setup` event (C24 section 1, C27 section 4.5). The closed `detail` code is shown as the runner
 * sent it, except the two details with a string of their own: `push_too_large` (with `size_mb`) and `clone_limited`. Never null: a missing or
 * out-of-range size shows the plain code, not a hole in the sentence.
 */
export function runnerSetupText(detail: string, sizeMb?: number): string {
  if (detail === "clone_limited") return COPY.cloneLimited;
  if (detail === "push_too_large" && sizeMb !== undefined && Number.isSafeInteger(sizeMb) && sizeMb >= 5) return COPY.pushTooLarge.replace("{size}", String(sizeMb));
  return COPY.runnerSetupFailed.replace("{detail}", detail);
}
