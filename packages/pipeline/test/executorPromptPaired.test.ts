import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildExecutorPrompt } from "../src/advance/build.js";
import { expectOneGenuineEnvelope } from "./plan/helpers/panelFixtures.js";

/**
 * D#598 P1f-5c [acceptance 25, prompt half]: on a paired repository the platform opens the pull request and publishes the public change, so the sandbox
 * prompt has no pull request step of any kind, calls no GitHub API and names only the private remote. An unpaired prompt is the bytes it always was.
 */
const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden");
const golden = (name: string): string => readFileSync(path.join(GOLDEN, name), "utf8");
const BUILD = { owner: "acme", name: "widgets", number: 41, branch: "fx/issue-41", version: 3, spec: "1. Add a footer.\n2. Test it." };
const SHA = "a".repeat(40);
const PARENT = { branch: "fx/issue-40", sha: "b".repeat(40) };
/** Anything that opens a pull request, or talks to the API that does. */
const PR_STEPS = ["curl", "/pulls", "api.github.com", "Open the pull request", "open a pull request", "pr_number"];

describe("the paired sandbox prompt", () => {
  const variants = {
    plain: { ...BUILD, planeBase: { sha: SHA } },
    rebuild: { ...BUILD, planeBase: { sha: SHA }, rebuild: true },
    stacked: { ...BUILD, planeBase: { sha: PARENT.sha }, stackBase: PARENT },
  };

  it.each(Object.entries(variants))("%s: no pull request step, no GitHub API call, and the only remote named is origin", (_name, input) => {
    const p = buildExecutorPrompt(input);
    expect(PR_STEPS.filter((s) => p.includes(s))).toEqual([]);
    // Every push or fetch command names origin and nothing else.
    for (const m of p.matchAll(/git (?:push|fetch)[^\n]*/g)) expect(m[0]).toMatch(/\borigin\b/);
    expect(p).not.toMatch(/git remote/);
    expectOneGenuineEnvelope(p);
  });

  it("builds on the recorded commit: fetches exactly it, checks it, and branches from it (a rebuild creates its own fresh branch)", () => {
    const p = buildExecutorPrompt(variants.plain);
    expect(p).toContain(`git fetch --depth 1 origin ${SHA} && test "$(git rev-parse FETCH_HEAD)" = "${SHA}"`);
    expect(p).toContain(`checkout -b fx/issue-41 "$BASE"`);
    expect(p).toContain(`BASE=${SHA}`);
    // SANDBOX-RERUN-BRANCH-a: a rebuild names a branch of its own, so it creates it fresh and never replaces one.
    expect(buildExecutorPrompt(variants.rebuild)).toContain(`checkout -b fx/issue-41 "$BASE"`);
    expect(buildExecutorPrompt(variants.rebuild)).not.toContain("checkout -B");
  });

  it("a stacked item still builds on its parent's verified branch, with the parent check kept and no pull request step", () => {
    const p = buildExecutorPrompt(variants.stacked);
    expect(p).toContain(`its head must be ${PARENT.sha}`);
    expect(p).toContain(`checkout -b fx/issue-41 "origin/$BASE"`);
    expect(p).toContain("BASE=fx/issue-40");
  });

  it("the result block still asks for a verdict, tests and a summary, and no pull request number", () => {
    const p = buildExecutorPrompt(variants.plain);
    expect(p).toContain('"verdict":"done","branch":"fx/issue-41","tests":"passed"');
    expect(p).toContain("The platform opens the pull request for you.");
  });

  it("an unpaired prompt (no planeBase) is byte-identical to the one before this change", () => {
    expect(buildExecutorPrompt(BUILD)).toBe(golden("executor-prompt.sandbox.txt"));
    expect(buildExecutorPrompt({ ...BUILD, rebuild: true })).toBe(golden("executor-prompt.sandbox-rebuild.txt"));
    expect(buildExecutorPrompt(BUILD)).toContain("curl -s -X POST https://api.github.com/repos/acme/widgets/pulls");
  });
});
