import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";

/**
 * The words the product shows. Each string is asserted here by its exact text, so editing one is a deliberate change to
 * this file too (the Spec's Copy section, with correction C12 section 5 applied).
 */
describe("the runner copy (D#6 R2b)", () => {
  it("has exactly the Spec's strings, each as written", () => {
    expect(COPY).toEqual({
      localOnly:
        "The agent runs on your machine, signed in with your own Claude login or API key, and pushes with your own git credentials. Our cloud never receives your source files, diffs or Claude credentials. It sees pull-request titles and descriptions, commit messages, the paths of changed files, and run status. You can check this: the runner is open source, and every message it can send is defined in its public protocol package. Reviews run on your machine. A person on your team merges every PR, unless a repo admin turns on auto-merge for this repo.",
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
      executionModeChanged: "Cancelled because this repository was moved off your runner. Retry to run it under the new setting.",
      paused: "Paused: Claude usage limit reached.",
      takenOver: "Taken over on the runner machine at {time}",
      jobRefused: "Your runner refused this job ({detail}). Update the runner, then retry.",
      sandboxUnavailable: "Sandbox not working on this machine ({reason}). Run `fx-runner doctor` there to see the fix.",
      agentFailed: "The agent stopped without finishing. Retry, or open the run for details.",
      runnerSetupFailed: "Your runner could not start the agent ({detail}). Check the runner's setup, then retry.",
      pushRejected: "Your runner could not push to the pull request's branch, because the branch changed while the agent was working. Retry to run on the new head.",
      pushTooLarge:
        "This push is {size} MB; the limit through our proxy is 4 MB. A person can push this commit, or you can switch this repo to local-only (auto-merge turns off).",
      cloneLimited: "This repository has used today's download allowance through our proxy. The runner keeps a copy, so this is rare. It resets at 00:00 UTC.",
      headNotFromBase: "The agent's work did not start from this run's starting point, so the runner did not publish it. Build again.",
      sandboxStubCommitted: "The agent committed empty placeholder files the sandbox makes, so the runner did not publish it. Build again.",
      workspaceGitRefused: "The runner could not safely read the agent's git folder, so nothing was published. Update fx-runner, then Build again.",
      pullRequestBody:
        "Opened by fulcrumaxe for run {run} on work item {item}. The agent ran on your own machine; this description is fixed text and holds nothing the agent wrote.",
      pullRequestTitleFallback: "Changes from your runner",
      scopeUnknown:
        "This work's file scope could not be read, so the changes were not checked and no pull request was opened. The branch is kept so you can open the PR yourself.",
      scopeUnknownRenamed:
        "GitHub reported a renamed file. A rename's old path can't be read without reading file contents, which this repository's runner setting forbids. The branch is kept so you can open the PR yourself.",
      prRejected: "GitHub refused to open the pull request (HTTP {status}). The branch is kept so you can open the PR yourself.",
      prRejectedForeign:
        "GitHub already has an open pull request for this branch that fulcrumaxe did not open, so it was left alone. The branch is kept so you can open the PR yourself.",
      pricingLine: "The runner is free and open source. The $49 plan pays for the cloud side: dispatch, verification, the dashboard and review compute.",
    });
  });

  it("local-only no longer says reviews are advisory or that a person always merges", () => {
    expect(COPY.localOnly).not.toContain("advisory");
    expect(COPY.localOnly).toContain("Reviews run on your machine. A person on your team merges every PR, unless a repo admin turns on auto-merge for this repo.");
    // The old last sentence is gone, whole.
    expect(COPY.localOnly).not.toContain("Reviews run on your machine and are advisory; a person on your team merges every PR.");
  });

  it("the auto-merge string, shown where an admin turns it on, says where the reviews run and what merges without a person", () => {
    expect(COPY.localAutoMerge).toContain("run on your machine");
    expect(COPY.localAutoMerge).toContain("your own Claude plan");
    expect(COPY.localAutoMerge).toContain("your CI and your branch protection");
    expect(COPY.localAutoMerge).toContain("merges without a person");
  });

  it("no string claims the subscription is used with fulcrumaxe, and placeholders are only the known ones", () => {
    const placeholders = new Set<string>();
    for (const [key, text] of Object.entries(COPY)) {
      expect(text.toLowerCase(), key).not.toContain("use your claude subscription with fulcrumaxe");
      expect(text.trim(), key).toBe(text);
      expect(text.length, key).toBeGreaterThan(0);
      for (const match of text.matchAll(/\{([a-z]+)\}/g)) placeholders.add(match[1]!);
    }
    expect([...placeholders].sort()).toEqual(["detail", "item", "machine", "n", "person", "reason", "repo", "run", "size", "status", "time"]);
  });
});
