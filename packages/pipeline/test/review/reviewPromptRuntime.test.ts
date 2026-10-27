import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNNER_TESTS_LINE } from "../../src/advance/build.js";
import { buildFixPrompt, buildReviewPrompt, type FixPromptInput, type ReviewPromptInput } from "../../src/review/reviewPrompts.js";
import { expectOneGenuineEnvelope } from "../plan/helpers/panelFixtures.js";

/**
 * D#6 R4d-4a (C33) [G6, G7]: the review and fix-round prompts are chosen per runtime. The sandbox text is pinned to the bytes it had
 * before this change (golden files made from the code before the change, for every role, the debater with and without `prior`);
 * the runner text has no fetch, checkout, reset, push or GitHub step.
 */
const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "golden");
const golden = (name: string): string => readFileSync(path.join(GOLDEN, name), "utf8");

const HEAD = "a".repeat(40);
const BASE: ReviewPromptInput = { role: "code-reviewer", owner: "acme", name: "widgets", issue: 7, branch: "fx/issue-7", pr: 41, headSha: HEAD, baseRef: "main", version: 3, spec: "Acceptance: the footer shows the year." };
const PRIOR = [
  { role: "code-reviewer", summary: "Looks right; tests cover the year." },
  { role: "security-reviewer", summary: "No untrusted input reaches a shell." },
];
const FIX: FixPromptInput = { owner: "acme", name: "widgets", issue: 7, branch: "fx/issue-7", pr: 41, headSha: HEAD, version: 3, spec: "Acceptance: the footer shows the year.", findings: [{ role: "code-reviewer", verdict: "needs-fix", findings: ["src/a.ts:3 - off by one"], summary: "one problem" }] };

const ROLES = ["code-reviewer", "acceptance-tester", "security-reviewer", "debater"] as const;

/**
 * What a runner review or fix prompt must never tell the agent to do. `git remote` is the command; the prompts' own prohibition
 * ("do not ... change remotes") names the thing it forbids, so the bare word cannot be the test.
 */
const FORBIDDEN = ["git fetch", "git checkout", "checkout -b", "checkout -B", "reset --hard", "git push", "git remote", "remote add", "remote set-url", "api.github.com", "/pulls", "--force"];
const noneOf = (text: string): string[] => FORBIDDEN.filter((f) => text.includes(f));

describe("buildReviewPrompt by runtime", () => {
  it.each(ROLES)("G6: the sandbox prompt for %s is byte-identical to the one before this change, with or without an explicit runtime", (role) => {
    const file = role === "debater" ? "review-prompt.sandbox.debater-no-prior.txt" : `review-prompt.sandbox.${role}.txt`;
    expect(buildReviewPrompt({ ...BASE, role })).toBe(golden(file));
    expect(buildReviewPrompt({ ...BASE, role, runtime: "sandbox" })).toBe(golden(file));
  });

  it("G6: the debater's sandbox prompt with prior reviews is byte-identical too", () => {
    expect(buildReviewPrompt({ ...BASE, role: "debater", prior: PRIOR })).toBe(golden("review-prompt.sandbox.debater-prior.txt"));
    expect(buildReviewPrompt({ ...BASE, role: "debater", prior: PRIOR, runtime: "sandbox" })).toBe(golden("review-prompt.sandbox.debater-prior.txt"));
  });

  it.each(ROLES)("D#598 P7d: the runner prompt for %s tells the reviewer how to report that the tests could not run, and the sandbox prompt is unchanged", (role) => {
    expect(buildReviewPrompt({ ...BASE, role, runtime: "runner" })).toContain('set "environment_failure" to true');
    expect(buildReviewPrompt({ ...BASE, role })).not.toContain("environment_failure");
  });

  it.each(ROLES)("%s: only the acceptance tester is told about the `unverifiable` outcome, on both runtimes, and it is never told to ask for changes for what its environment cannot run", (role) => {
    for (const runtime of [undefined, "runner"] as const) {
      const p = buildReviewPrompt({ ...BASE, role, ...(runtime ? { runtime } : {}) });
      if (role !== "acceptance-tester") {
        expect(p).not.toContain("unverifiable");
        continue;
      }
      expect(p).toContain('A fourth verdict word, "unverifiable"');
      expect(p).toContain('{"verdict":"unverifiable","unverifiable":[{"criterion"');
      expect(p).toContain("do not ask for changes, because the builder cannot change your environment");
      // The old rule that made a skipped test a failure is gone; an unrun criterion is still never a pass.
      expect(p).not.toContain("A criterion you could not verify is a failure");
      expect(p).toContain("A criterion you could not verify is never a pass");
      // Exactly one genuine block is still in the prompt, and it is the last thing.
      expect(p.match(/<!-- AGENT_OUTPUT -->/g)).toHaveLength(1);
    }
  });

  it.each(ROLES)("RUNNER-AGENT-NO-FULLCHECK: the runner prompt for %s says to run only the affected tests, never the whole check; the sandbox prompt is unchanged", (role) => {
    const p = buildReviewPrompt({ ...BASE, role, runtime: "runner", ...(role === "debater" ? { prior: PRIOR } : {}) });
    expect(p).toContain(RUNNER_TESTS_LINE);
    expect(RUNNER_TESTS_LINE).toMatch(/^Run only the tests that cover the files this change touches/);
    expect(RUNNER_TESTS_LINE).toContain("Do not run the repository's whole check or full test suite");
    expect(RUNNER_TESTS_LINE).toContain("the runner runs it on this commit itself, separately, after you finish");
    expect(buildReviewPrompt({ ...BASE, role })).not.toContain("Run only the tests");
  });

  it("RUNNER-AGENT-NO-FULLCHECK: the runner fix prompt carries the same line; the sandbox and cross-side fix prompts do not", () => {
    expect(buildFixPrompt({ ...FIX, runtime: "runner" })).toContain(RUNNER_TESTS_LINE);
    expect(buildFixPrompt(FIX)).not.toContain(RUNNER_TESTS_LINE);
    expect(buildFixPrompt({ ...FIX, crossSide: true })).not.toContain(RUNNER_TESTS_LINE);
  });

  it.each(ROLES)("G7: the runner prompt for %s names none of the sandbox's git steps, the head sha and the three-dot diff from HEAD", (role) => {
    const p = buildReviewPrompt({ ...BASE, role, runtime: "runner", ...(role === "debater" ? { prior: PRIOR } : {}) });
    expect(noneOf(p)).toEqual([]);
    expect(p).toContain(HEAD);
    expect(p).toContain("git diff origin/main...HEAD");
    expect(p).not.toContain(`...${HEAD}`);
    expect(p).toContain(`already checked out at commit ${HEAD}, with a detached HEAD`);
    expect(p).toContain(`Confirm \`git rev-parse HEAD\` prints ${HEAD} before you review`);
    expect(p).toContain("workspace was at the wrong commit");
    expect(p).toContain("Do not commit: you only report.");
    expect(p).not.toContain("Do not push, comment on GitHub");
    expectOneGenuineEnvelope(p);
  });

  it("the runner prompt changes only the checkout lines: job, Spec, prior reviews, verdict rules and envelope are the sandbox text", () => {
    const sandbox = buildReviewPrompt({ ...BASE, role: "debater", prior: PRIOR });
    const runner = buildReviewPrompt({ ...BASE, role: "debater", prior: PRIOR, runtime: "runner" });
    const tail = (t: string): string => t.slice(t.indexOf("Everything between the untrusted-content fences"));
    expect(tail(runner)).toBe(tail(sandbox));
    const head = (t: string): string => t.slice(0, t.indexOf("The repository"));
    expect(head(runner)).toBe(head(sandbox));
  });

  it("the runner prompt prints the base ref only after a validated check: an unsafe ref still throws", () => {
    expect(() => buildReviewPrompt({ ...BASE, runtime: "runner", baseRef: "main; rm -rf /" })).toThrow();
  });
});

describe("buildFixPrompt by runtime", () => {
  it("G6: the sandbox fix prompt is its golden: the same text as before, with the findings after the Spec (D#600 CX-2)", () => {
    expect(buildFixPrompt(FIX)).toBe(golden("fix-prompt.sandbox.txt"));
    expect(buildFixPrompt({ ...FIX, runtime: "sandbox" })).toBe(golden("fix-prompt.sandbox.txt"));
  });

  it("G7: the runner fix prompt names none of the forbidden steps (no fetch, reset --hard, checkout, push, remote command) and names the head sha", () => {
    const p = buildFixPrompt({ ...FIX, runtime: "runner" });
    expect(noneOf(p)).toEqual([]);
    expect(p).toContain(HEAD);
    expectOneGenuineEnvelope(p);
  });
});
