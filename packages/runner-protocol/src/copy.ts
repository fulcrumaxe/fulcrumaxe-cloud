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
  paused: "Paused: Claude usage limit reached.",
  /** D#6 R4a-2 (C24 section 1): `{detail}` is the closed code the runner sent, shown as it is; nothing else the runner says is shown. */
  jobRefused: "Your runner refused this job ({detail}). Update the runner, then retry.",
  agentFailed: "The agent stopped without finishing. Retry, or open the run for details.",
  runnerSetupFailed: "Your runner could not start the agent ({detail}). Check the runner's setup, then retry.",
  pushTooLarge:
    "This push is {size} MB; the limit through our proxy is 4 MB. A person can push this commit, or you can switch this repo to local-only (auto-merge turns off).",
  /** The description of the draft pull request our cloud opens when a runner run finishes. Fixed text: the agent's own output never goes into it. */
  pullRequestBody: "Opened by fulcrumaxe for run {run} on work item {item}. The agent ran on your own machine; this description is fixed text and holds nothing the agent wrote.",
  /** The pull request title when the work item has none. */
  pullRequestTitleFallback: "Changes from your runner",
  pricingLine: "The runner is free and open source. The $49 plan pays for the cloud side: dispatch, verification, the dashboard and review compute.",
} as const;

export type CopyKey = keyof typeof COPY;
