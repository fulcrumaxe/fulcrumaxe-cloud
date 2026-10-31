// apps/workspace/test/pipeline-insight.test.mjs
//
// D#483 P4: the Pipeline detail's "What's happening" section. The model half (pipeline-insight.js, pure) is tested on the
// contract fixtures for every state; the panel half (same file) runs against a small stand-in for the few
// DOM calls it makes (no jsdom here), with a fake call() and a fake interval. The full DOM (phone and tablet layout,
// hostile text under the production CSP) is in e2e/pipeline-insight.spec.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLAG_WORDS, RECEIPTS_HEADING, receiptsSection, formatWhen, NEEDS_YOU_APP, SETUP_PAUSE_WORDS, START_DECISION_WORDS, PHASES, REFRESH_MS, SENTENCES, stateFlags, buildInsight, createInsightPanel, firstLine, groupRounds, noticeBanner, SPEC_REFUSED_SENTENCES, SPEC_REFUSED_GENERIC, SUPERSEDED_SENTENCE, SUPERSEDED_LINK_LABEL, phaseOf, pullUrl, readyBanner, mergeBlockSentence, blockingSentence, BLOCKING_SENTENCES, PUBLIC_REFUSED_SENTENCE, REVIEW_BLOCK_SENTENCE, UNKNOWN_BLOCK_SENTENCE, reasonWord, roleWord, runView, statusWord, stepView, usdText,
} from "../apps/pipeline/pipeline-insight.js";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages");
const fx = (name) => JSON.parse(readFileSync(join(PACKAGES, "api", "fixtures", "v1", "getWorkItemActivity", name), "utf8"));
const OK = fx("200-ok.json");
const REVIEW_PASSED = fx("200-review-passed.json");
const EMPTY = fx("200-empty.json");
const NOT_FEASIBLE = fx("200-not-feasible.json");
const NEEDS_HUMAN = fx("200-needs-human.json");
const CHECK_FAILED = fx("200-check-failed.json");

describe("phases and words", () => {
  it("labels every pipeline role with its phase, and an unknown role plainly", () => {
    expect(phaseOf("project-manager")).toBe("Triage & Spec");
    for (const r of ["technical-architect", "product-owner", "performance-expert", "security-expert", "cost-analyst"]) expect(phaseOf(r)).toBe("Panel");
    expect(phaseOf("executor")).toBe("Build");
    for (const r of ["code-reviewer", "acceptance-tester", "security-reviewer", "debater"]) expect(phaseOf(r)).toBe("Review");
    expect(phaseOf("something-new")).toBe("Run");
    expect(Object.keys(PHASES).length).toBeGreaterThan(8);
    expect(roleWord("code-reviewer")).toBe("Code reviewer");
    expect(roleWord("something-new")).toBe("something-new");
    expect(roleWord(undefined)).toBe("Agent");
  });

  it("names every run status, never the raw code", () => {
    expect(statusWord("succeeded")).toBe("finished");
    expect(statusWord("running")).toBe("running");
    expect(statusWord("timed_out")).toBe("timed out");
    expect(statusWord("killed_spend")).toBe("stopped at the spend limit");
    expect(statusWord("from_the_future")).toBe("ended");
  });

  it("firstLine skips blank lines and cuts a long one", () => {
    expect(firstLine("\n\n  hello there  \nsecond")).toBe("hello there");
    expect(firstLine("x".repeat(300)).length).toBe(110);
    expect(firstLine("x".repeat(300)).endsWith("…")).toBe(true);
    expect(firstLine(null)).toBe("");
    expect(usdText(1.5)).toBe("$1.50");
    expect(usdText(null)).toBe("");
  });
});

describe("rounds", () => {
  it("a role's first comment is Round 1 and its later ones are the challenge round", () => {
    const { round1, challenge } = groupRounds(OK.comments);
    expect(round1.map((c) => c.who)).toEqual(["Technical architect", "Product owner", "Security expert"]);
    expect(challenge.map((c) => c.who)).toEqual(["Technical architect", "Security expert"]);
    expect(round1[0].preview).toBe("Round 1. The change fits the existing route layer.");
    expect(round1[0].body).toContain("No new table is needed.");
    expect(new Set([...round1, ...challenge].map((c) => c.key)).size).toBe(5);
  });

  it("handles no comments, a null role and a third comment", () => {
    expect(groupRounds([])).toEqual({ round1: [], challenge: [] });
    expect(groupRounds(undefined)).toEqual({ round1: [], challenge: [] });
    const g = groupRounds([{ role: null, body: "a" }, { role: null, body: "b" }, { role: null, body: "c" }]);
    expect(g.round1).toHaveLength(1);
    expect(g.challenge).toHaveLength(2);
  });
});

describe("one run as a section", () => {
  it("a running run opens by default, a finished one does not, and the newest 40 lines are kept", () => {
    const running = runView(OK.runs[5]);
    expect(running).toMatchObject({ phase: "Review", role: "Code reviewer", live: true, openByDefault: true, statusWord: "running", cost: "" });
    const done = runView(OK.runs[4]);
    expect(done).toMatchObject({ phase: "Build", openByDefault: false, cost: "$1.40", summary: "Added the activity route and the panel. Tests pass." });
    const many = runView({ ...OK.runs[4], lines: Array.from({ length: 60 }, (_, i) => ({ at: "t", text: "line " + i })) });
    expect(many.lines).toHaveLength(40);
    expect(many.lines[39]).toBe("line 59");
    expect(many.hiddenLines).toBe(20);
  });

  it("a blank summary is no summary; a run with no lines has none", () => {
    expect(runView({ ...OK.runs[0], summary: "   " }).summary).toBeNull();
    expect(runView({ ...OK.runs[0], summary: null }).summary).toBeNull();
    expect(runView({ ...OK.runs[1], lines: [] }).lines).toEqual([]);
  });
});

describe("recorded pipeline steps", () => {
  it("writes the merge gate's recorded result and fixed reason codes in words, and nothing it was not told", () => {
    const merged = stepView({ kind: "continue_work_item", state: "done", code: null, result: "merged", reasons: [], at: "t" });
    expect(merged.text).toBe("Continue request · done · Merge gate: merged");
    const held = stepView(REVIEW_PASSED.steps[1]);
    expect(held.text).toContain("Merge gate: not merged, a person merges");
    expect(held.reasons).toEqual(["auto-merge is not allowed"]);
    expect(stepView({ kind: "continue_work_item", state: "refused", code: "advance_unavailable", result: null, reasons: [], at: "t" }).text).toBe("Continue request · refused · reason: advance unavailable");
    expect(stepView(null)).toBeNull();
  });

  it("names reviewer-specific gate codes and falls back to the code with spaces", () => {
    expect(reasonWord("verdict_not_pass_code_reviewer")).toBe("the code review did not pass");
    expect(reasonWord("missing_run_acceptance_tester")).toBe("no acceptance test run on this commit");
    expect(reasonWord("run_not_succeeded_security_reviewer")).toBe("the security review did not finish");
    expect(reasonWord("some_new_code")).toBe("some new code");
  });

  it("D#6 R3c: the advisory reason reads as reviews passed on the person's machine, not as missing reviews", () => {
    expect(reasonWord("local_reviews_passed_advisory")).toBe("Reviews passed on your machine. A person merges this pull request.");
  });

  describe("D#598 P3b: the stacked stop (C3 R-598-P5b-6)", () => {
    const gate = (reasons) => ({ kind: "continue_work_item", state: "done", code: null, result: "ready_human_merges", reasons, at: "t" });

    it("says the fixed sentence with the parent's pull request number, and shows the number code nowhere else", () => {
      const row = stepView(gate(["stacked_on_open_pr", "stacked_on_pr_40", "ci_not_green"]));
      expect(row.reasons).toEqual(["This builds on #40, which hasn't merged yet.", "CI is not green"]);
      expect(row.reasons.join(" ")).not.toMatch(/stacked_on_pr|stacked on pr|undefined|null/);
    });

    it.each([
      ["no number was recorded", ["stacked_on_open_pr"]],
      ["the number code is not a pull request number", ["stacked_on_open_pr", "stacked_on_pr_0"]],
      ["the number code is not a number", ["stacked_on_open_pr", "stacked_on_pr_x"]],
      ["the number is too long to be one", ["stacked_on_open_pr", "stacked_on_pr_12345678901"]],
    ])("%s: a plain sentence with no number, never '#undefined' or '#null'", (_n, reasons) => {
      const row = stepView(gate(reasons));
      expect(row.reasons).toHaveLength(1);
      expect(row.reasons[0]).toBe("This builds on a pull request that hasn't merged yet.");
      expect(row.reasons.join(" ")).not.toMatch(/undefined|null|NaN|#/);
    });

    it("a number code without the stop says only what it is", () => {
      expect(stepView(gate(["stacked_on_pr_40"])).reasons).toEqual([]);
    });

    it("a person-readable stop for the reason code alone", () => {
      expect(reasonWord("stacked_on_open_pr")).toBe("This builds on a pull request that hasn't merged yet.");
    });

    it("the two-plane stops have sentences, never raw codes", () => {
      expect(reasonWord("public_pr_not_open")).toMatch(/public pull request is not open/);
      expect(reasonWord("runner_merge_unavailable")).toMatch(/A person merges the public pull request/);
    });

    it("the runner-merge stops have sentences, never raw codes", () => {
      for (const code of ["runner_merge_timeout", "runner_merge_failed", "runner_report_mismatch", "pairing_changed", "public_branch_person_managed", "public_head_unrecorded", "public_head_not_reviewed", "no_pull_request", "go_not_applicable"]) {
        const word = reasonWord(code);
        expect(word).toMatch(/runner|pairing|public|pull request/i);
        expect(word).not.toMatch(/_/);
        // A real sentence, not the fallback that shows the code with its underscores as spaces.
        expect(word).not.toBe(code.replace(/_/g, " "));
        expect(word.length).toBeGreaterThan(code.length + 15);
      }
    });
  });
});

describe("the Ready to merge banner reads the real state", () => {
  it("shows only at review_passed, with the real auto-merge state and a PR link", () => {
    expect(readyBanner(OK)).toBeNull();
    expect(readyBanner(EMPTY)).toBeNull();
    const on = readyBanner(REVIEW_PASSED);
    expect(on).toMatchObject({ title: "Ready to merge", autoMerge: true, url: "https://github.com/acme/docs/pull/57" });
    expect(on.autoMergeText).toBe("Auto-merge is on for this repo: it merges once the merge gate and CI are green.");
    const off = readyBanner({ ...REVIEW_PASSED, auto_merge: false });
    expect(off.autoMerge).toBe(false);
    expect(off.autoMergeText).toBe("Auto-merge is off for this repo: a person merges the pull request on GitHub.");
    expect(off.autoMergeText).not.toContain("is on");
  });

  it("builds a link only from a validated repo and a real PR number", () => {
    const base = { repo: { owner: "acme", name: "docs" }, pr_number: 9 };
    expect(pullUrl(base)).toBe("https://github.com/acme/docs/pull/9");
    for (const bad of [
      { ...base, pr_number: null }, { ...base, pr_number: 0 }, { ...base, pr_number: "9" }, { ...base, repo: null },
      { ...base, repo: { owner: "a/b", name: "docs" } }, { ...base, repo: { owner: "acme", name: "docs?x=1" } },
      { ...base, repo: { owner: "javascript:alert(1)//", name: "x" } },
    ]) expect(pullUrl(bad), JSON.stringify(bad)).toBeNull();
    // No real PR number: the search for the executor's branch, never /pull/<issue>.
    expect(readyBanner({ ...REVIEW_PASSED, pr_number: null }).url).toBe("https://github.com/acme/docs/pulls?q=is%3Apr+head%3Afx%2Fissue-42");
    expect(pullUrl({ ...base, pr_number: null, issue_number: null })).toBeNull();
  });

  it("links the REAL pull request when the issue number and the PR number differ, never the issue", () => {
    // The fixture: issue 42, pull request 57. /pull/42 would open the issue.
    expect(REVIEW_PASSED.issue_number).toBe(42);
    expect(REVIEW_PASSED.pr_number).toBe(57);
    expect(readyBanner(REVIEW_PASSED).url).toBe("https://github.com/acme/docs/pull/57");
    expect(readyBanner(REVIEW_PASSED).url).not.toContain("/pull/42");
  });

  it("a PR number equal to the issue number is the issue leaking through (one number space): it is not linked as a pull request", () => {
    const leaked = { ...REVIEW_PASSED, pr_number: 42 };
    expect(pullUrl(leaked)).toBe("https://github.com/acme/docs/pulls?q=is%3Apr+head%3Afx%2Fissue-42");
    expect(pullUrl(leaked)).not.toContain("/pull/42");
  });
});

describe("the Ready to merge banner is honest about what still blocks the merge", () => {
  const gateStep = (reasons) => ({ kind: "continue_work_item", state: "done", code: null, result: "ready_human_merges", reasons, at: "2026-10-27T10:00:00Z" });
  const withGate = (reasons, extra = {}) => ({ ...REVIEW_PASSED, steps: [gateStep(reasons)], ...extra });

  it("only auto_merge_not_allowed (or no reasons) keeps today's ready banner, unchanged", () => {
    for (const reasons of [[], ["auto_merge_not_allowed"], ["auto_merge_not_allowed", "human_merge_only"]]) {
      const b = readyBanner(withGate(reasons, { auto_merge: false }));
      expect(b).toMatchObject({ blocked: false, title: "Ready to merge", detail: "Every required reviewer passed.", autoMerge: false, url: "https://github.com/acme/docs/pull/57" });
      expect(b.autoMergeText).toBe("Auto-merge is off for this repo: a person merges the pull request on GitHub.");
    }
  });

  it.each([
    ["public_pr_not_open", "The public pull request isn't open yet"],
    ["pr_draft", "The pull request is a draft"],
    ["ci_not_green", "Checks haven't passed yet"],
    ["repo_ci_missing", "The repository has no checks of its own yet"],
    ["no_branch_protection", "The base branch has no protection rules yet"],
    ["head_sha_malformed", "The pull request's latest commit could not be read"],
    ["run_timestamp_invalid", "A review has an invalid time, so it can't be counted yet"],
    ["public_head_unrecorded", "The public pull request's latest commit isn't the one the platform pushed"],
    ["public_head_not_reviewed", "The public pull request doesn't hold exactly what was reviewed"],
    ["stacked_on_open_pr", "It builds on a pull request that hasn't merged yet"],
    ["stacked_on_pr_40", "It builds on a pull request that hasn't merged yet"],
    ["merge_call_refused", "GitHub refused the merge"],
    ["merge_conflict", "The pull request has a merge conflict"],
    ["branch_behind", "The branch is behind its base branch"],
    ["branch_protection_refused", "Branch protection refused the merge"],
    ["merge_queue_waiting", "The pull request is waiting in the merge queue"],
    ["ordered_resource_out_of_order", "Another change has to merge before this one"],
    ["merge_dependency_closed", "The pull request it builds on was closed without merging"],
    ["history_rewritten", "The branch history was rewritten after review"],
    ["pairing_changed", "The public repository's pairing changed"],
    ["no_pull_request", "There is no pull request on record to merge"],
    ["go_not_applicable", "The merge could not go through your runner"],
    ["verdict_not_pass_code_reviewer", REVIEW_BLOCK_SENTENCE],
    ["missing_run_security_reviewer", REVIEW_BLOCK_SENTENCE],
    ["run_not_succeeded_debater", REVIEW_BLOCK_SENTENCE],
    ["something_new_the_card_has_never_seen", UNKNOWN_BLOCK_SENTENCE],
  ])("%s blocks with one fixed sentence, no merge sentence and no link to GitHub", (code, sentence) => {
    expect(blockingSentence(code)).toBe(sentence);
    const b = readyBanner(withGate(["auto_merge_not_allowed", code]));
    expect(b).toMatchObject({ blocked: true, title: "Not ready to merge yet", detail: sentence + ".", url: null, autoMergeText: "" });
    expect(b.detail).not.toContain(code);
  });

  it("names the first blocking reason, leaving the person-merges ones out", () => {
    expect(mergeBlockSentence(withGate(["auto_merge_not_allowed", "ci_not_green", "pr_draft"]))).toBe("Checks haven't passed yet");
  });

  it("the public pull request not being open is named before the reasons that are about a pull request that is not there", () => {
    expect(mergeBlockSentence(withGate(["pr_draft", "ci_not_green", "auto_merge_not_allowed", "public_pr_not_open"]))).toBe("The public pull request isn't open yet");
  });

  it("the sentences are fixed: every one is in the table, none carries markup or a raw code", () => {
    for (const v of [...Object.values(BLOCKING_SENTENCES), REVIEW_BLOCK_SENTENCE, UNKNOWN_BLOCK_SENTENCE, PUBLIC_REFUSED_SENTENCE]) expect(v).not.toMatch(/[_<>]|undefined|null/);
  });

  it("a paired item whose public change was refused never reads ready, whatever the gate's reasons (even none)", () => {
    const refused = { state: "refused", code: "scan_refused", sentence: "Refused: the scan found something that must not be public", repo: "acme/docs-public", branch: "fx/issue-42", pr_number: null, pr_url: null, head_sha: null, actions: [] };
    for (const steps of [[], [gateStep([])], [gateStep(["auto_merge_not_allowed"])]]) {
      const b = readyBanner({ ...REVIEW_PASSED, steps, public_change: refused });
      expect(b).toMatchObject({ blocked: true, detail: PUBLIC_REFUSED_SENTENCE + ".", url: null });
    }
  });

  it("a paired item with no public pull request on record never reads ready", () => {
    const pushed = { state: "pushed_pr_not_opened", code: null, sentence: "Pushed, PR not opened", repo: "acme/docs-public", branch: "fx/issue-42", pr_number: null, pr_url: null, head_sha: "a".repeat(40), actions: [] };
    expect(readyBanner({ ...REVIEW_PASSED, steps: [], public_change: pushed })).toMatchObject({ blocked: true, detail: "The public pull request isn't open yet." });
    const opened = { ...pushed, state: "pr_opened", pr_number: 9, pr_url: "https://github.com/acme/docs-public/pull/9" };
    expect(readyBanner({ ...REVIEW_PASSED, steps: [gateStep(["auto_merge_not_allowed"])], public_change: opened })).toMatchObject({ blocked: false, title: "Ready to merge" });
  });
});

describe("D#483: a build waiting for a slot", () => {
  const WAITING = { notice: { kind: "build_slot_wait", reason: "Waiting for a build slot. Issue #65 is holding this repository's only build slot, and keeps it until its pull request is merged or closed. This build starts by itself after that." } };
  it("the banner is the server's whole sentence, with no words of the card's own", () => {
    expect(noticeBanner(WAITING)).toEqual({ kind: "build_slot_wait", title: "", lead: "", tail: "", reason: WAITING.notice.reason });
  });
  it("the timeline row says waiting, with the reason in words, never 'the pipeline started'", () => {
    const row = stepView({ kind: "advance_work_item", state: "done", code: null, result: "waiting", reasons: ["one_build_per_repo_until_d598"], at: "t" });
    expect(row.text).toContain("the build is waiting for a build slot");
    expect(row.text).not.toContain("the pipeline started");
    expect(row.reasons).toEqual(["this repository builds one item at a time"]);
  });
});

describe("the notice banner", () => {
  it("not_feasible and needs_human are read from the response; nothing else draws", () => {
    expect(noticeBanner(NOT_FEASIBLE)).toMatchObject({ kind: "not_feasible", title: "Stopped before building. ", reason: NOT_FEASIBLE.notice.reason });
    expect(noticeBanner(NEEDS_HUMAN)).toMatchObject({ kind: "needs_human", title: "Needs a person. ", reason: NEEDS_HUMAN.notice.reason });
    for (const data of [OK, EMPTY, null, undefined, {}, { notice: null }, { notice: { kind: "other", reason: "x" } }, { notice: { kind: "needs_human" } }, { notice: { kind: "needs_human", reason: 7 } }]) {
      expect(noticeBanner(data), JSON.stringify(data)).toBeNull();
    }
    expect(noticeBanner(CHECK_FAILED)).toMatchObject({ kind: "check_failed", title: "Couldn't check the build. ", reason: CHECK_FAILED.notice.reason });
    // D#6 R4d-5b: the server sends the whole sentence (the runner protocol's copy); the card adds no words around it.
    for (const kind of ["no_file_list", "respec_failed"]) {
      const data = { notice: { kind, reason: "The sentence from the server." } };
      expect(noticeBanner(data)).toEqual({ kind, title: "", lead: "", tail: "", reason: "The sentence from the server." });
    }
    expect(buildInsight(NOT_FEASIBLE).notice.kind).toBe("not_feasible");
    expect(buildInsight(OK).notice).toBeNull();
  });
});

describe("D#7 DP8-f1: halted and waiting on an answer", () => {
  it("draws each state alone, both, and neither", () => {
    expect(stateFlags({ ...OK, halted: true, waiting_on_answer: false }).map((f) => f.kind)).toEqual(["halted"]);
    expect(stateFlags({ ...OK, halted: false, waiting_on_answer: true }).map((f) => f.kind)).toEqual(["waiting_on_answer"]);
    expect(stateFlags({ ...OK, halted: true, waiting_on_answer: true }).map((f) => f.kind)).toEqual(["halted", "waiting_on_answer"]);
    expect(stateFlags({ ...OK, halted: false, waiting_on_answer: false })).toEqual([]);
    expect(buildInsight({ ...OK, halted: true, waiting_on_answer: true }).flags).toHaveLength(2);
  });

  it("uses the approved wording for the waiting state", () => {
    expect(FLAG_WORDS.waiting_on_answer).toBe("Waiting for your answer");
  });

  it("anything but a real true draws nothing, and an older server that sends neither field draws nothing", () => {
    for (const v of [undefined, null, "true", 1, 0, "", {}]) expect(stateFlags({ ...OK, halted: v, waiting_on_answer: v })).toEqual([]);
    const old = { ...OK };
    delete old.halted;
    delete old.waiting_on_answer;
    expect(stateFlags(old)).toEqual([]);
    expect(stateFlags(null)).toEqual([]);
    expect(stateFlags(undefined)).toEqual([]);
  });
});

describe("buildInsight over every state", () => {
  it("nothing recorded: no runs, no panel, no Spec, no steps, nothing running", () => {
    const m = buildInsight(EMPTY);
    expect(m).toMatchObject({ banner: null, runningText: "Nothing is running right now.", totalsText: "0 agent runs finished", runs: [], steps: [], spec: null, commentCount: 0 });
  });

  it("mid-pipeline: every run kept oldest first, the running one named, finished cost summed", () => {
    const m = buildInsight(OK);
    expect(m.runs.map((r) => r.phase)).toEqual(["Triage & Spec", "Panel", "Panel", "Panel", "Build", "Review"]);
    expect(m.runningText).toBe("Running now: Code reviewer");
    expect(m.totalsText).toBe("5 agent runs finished · $1.97 so far");
    expect(m.spec).toEqual({ version: 2, body: expect.stringContaining("Spec (Acceptance)") });
    expect(m.commentCount).toBe(5);
    expect(m.steps.map((s) => s.text)).toEqual(["Continue request · done · the pipeline started"]);
  });

  it("a failed run stays in the list, collapsed, with its own word", () => {
    const failed = { ...OK, runs: [{ ...OK.runs[4], status: "failed", summary: null, lines: [] }] };
    const m = buildInsight(failed);
    expect(m.runs).toHaveLength(1);
    expect(m.runs[0]).toMatchObject({ statusWord: "failed", openByDefault: false, live: false });
    expect(m.runningText).toBe("Nothing is running right now.");
  });

  it("a long text passes through whole (the server caps it) and the truncation flags carry over", () => {
    const long = "w".repeat(20000);
    const m = buildInsight({ ...OK, spec: { version: 1, body: long }, runs_truncated: true, comments_truncated: true });
    expect(m.spec.body).toHaveLength(20000);
    expect(m.runsTruncated).toBe(true);
    expect(m.commentsTruncated).toBe(true);
  });
});

// ── the view, against a small stand-in for the DOM calls it makes ──────────────────────────────────
class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.kids = []; this.on = {}; this.className = ""; this.open = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { this.on[t] = f; }
  appendChild(c) { this.kids.push(c); if (c instanceof FakeEl) c.parent = this; return c; }
  replaceChildren(...c) { this.kids.forEach((k) => k instanceof FakeEl && (k.parent = null)); this.kids = c; c.forEach((k) => k instanceof FakeEl && (k.parent = this)); }
  contains(n) { return n === this || this.kids.some((k) => k instanceof FakeEl && k.contains(n)); }
  querySelectorAll(sel) { const m = /^\[([\w-]+)\]$/.exec(sel); return findAll(this, (e) => e !== this && !!m && e.getAttribute(m[1]) !== null); }
  focus() { globalThis.document.activeElement = this; }
  get textContent() { return this.kids.map((k) => (k instanceof FakeEl ? k.textContent : k.text)).join(""); }
}
const findAll = (el, test, out = []) => (test(el) && out.push(el), el.kids.forEach((k) => k instanceof FakeEl && findAll(k, test, out)), out);
const byId = (root, id) => findAll(root, (e) => e.getAttribute("data-testid") === id);
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("the view", () => {
  let timers;
  beforeEach(() => {
    vi.useFakeTimers();
    timers = [];
    vi.stubGlobal("Node", FakeNode);
    vi.stubGlobal("document", { hidden: false, activeElement: null, createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function make(replies) {
    const calls = [];
    const call = vi.fn(async (method, url, body, signal) => {
      calls.push({ url, signal });
      const r = typeof replies === "function" ? replies(url, calls.length) : replies;
      if (r instanceof Error) throw r;
      return structuredClone(r);
    });
    const panel = createInsightPanel({
      call,
      setInterval: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearInterval: () => {},
    });
    return { panel, call, calls };
  }

  it("shows a loading sentence first, then the runs, and asks the activity route for the item", async () => {
    const { panel, calls } = make(OK);
    panel.start("item-1");
    expect(panel.el.textContent).toBe(SENTENCES.loading);
    await flush();
    expect(calls[0].url).toBe("/api/v1/work-items/item-1/activity");
    expect(byId(panel.el, "pl-ins-run")).toHaveLength(6);
    expect(byId(panel.el, "pl-ins-run").map((e) => e.getAttribute("data-phase"))).toEqual(["Triage & Spec", "Panel", "Panel", "Panel", "Build", "Review"]);
    // Running runs are open, finished are closed.
    expect(byId(panel.el, "pl-ins-run").map((e) => e.open)).toEqual([false, false, false, false, false, true]);
    expect(byId(panel.el, "pl-panel")[0].open).toBe(false);
    expect(byId(panel.el, "pl-spec")[0].open).toBe(false);
    expect(byId(panel.el, "pl-comment")).toHaveLength(5);
    expect(timers[0].ms).toBe(REFRESH_MS);
  });

  it("empty states are sentences, never null or undefined", async () => {
    const { panel } = make(EMPTY);
    panel.start("item-2");
    await flush();
    const text = panel.el.textContent;
    expect(text).toContain(SENTENCES.noRuns);
    expect(text).toContain(SENTENCES.noPanel);
    expect(text).toContain(SENTENCES.noSpec);
    expect(text).not.toMatch(/null|undefined|NaN/);
    expect(byId(panel.el, "pl-ready")).toHaveLength(0);
  });

  it("D#598 P3b page: a stacked stop shows the sentence with the parent's number, and the page text holds no null or undefined", async () => {
    const stacked = { ...REVIEW_PASSED, steps: [{ kind: "continue_work_item", state: "done", code: null, result: "ready_human_merges", reasons: ["stacked_on_open_pr", "stacked_on_pr_40", "auto_merge_not_allowed"], at: "2026-10-16T10:00:00Z" }] };
    const { panel } = make(stacked);
    panel.start("item-stacked");
    await flush();
    const [step] = byId(panel.el, "pl-step");
    expect(step.textContent).toContain("Merge gate: not merged, a person merges");
    expect(step.textContent).toContain("This builds on #40, which hasn't merged yet.");
    expect(panel.el.textContent).not.toMatch(/null|undefined|NaN|stacked_on/);
  });

  it("D#598 P3b page: a stacked stop with no recorded number still reads as a sentence", async () => {
    const stacked = { ...REVIEW_PASSED, steps: [{ kind: "continue_work_item", state: "done", code: null, result: "ready_human_merges", reasons: ["stacked_on_open_pr"], at: "2026-10-16T10:00:00Z" }] };
    const { panel } = make(stacked);
    panel.start("item-stacked-2");
    await flush();
    expect(byId(panel.el, "pl-step")[0].textContent).toContain("This builds on a pull request that hasn't merged yet.");
    expect(panel.el.textContent).not.toMatch(/null|undefined|NaN|#undefined|stacked_on/);
  });

  it("shows the Ready to merge banner with the real auto-merge state and the PR link", async () => {
    const { panel } = make(REVIEW_PASSED);
    panel.start("item-3");
    await flush();
    const [banner] = byId(panel.el, "pl-ready");
    expect(banner.textContent).toContain("Ready to merge.");
    expect(byId(banner, "pl-ready-merge")[0].getAttribute("data-auto-merge")).toBe("on");
    expect(byId(banner, "pl-ready-link")[0].attrs.href).toBe("https://github.com/acme/docs/pull/57");
    expect(byId(banner, "pl-ready-link")[0].attrs.rel).toBe("noopener noreferrer");
  });

  it("renders the observed state (refused public change; draft, checks, no auto-merge, public pull request not open) without saying ready or offering the link", async () => {
    const refused = { state: "refused", code: "scan_refused", sentence: "Refused: the scan found something that must not be public", repo: "acme/docs-public", branch: "fx/issue-42", pr_number: null, pr_url: null, head_sha: null, actions: [] };
    const data = { ...REVIEW_PASSED, auto_merge: false, public_change: refused, steps: [{ kind: "continue_work_item", state: "done", code: null, result: "ready_human_merges", reasons: ["pr_draft", "ci_not_green", "auto_merge_not_allowed", "public_pr_not_open"], at: "2026-10-27T10:00:00Z" }] };
    const { panel } = make(data);
    panel.start("item-refused");
    await flush();
    expect(byId(panel.el, "pl-ready")).toHaveLength(0);
    expect(byId(panel.el, "pl-ready-link")).toHaveLength(0);
    expect(byId(panel.el, "pl-ready-merge")).toHaveLength(0);
    const [banner] = byId(panel.el, "pl-ready-blocked");
    expect(banner.textContent).toBe("Not ready to merge yet. " + PUBLIC_REFUSED_SENTENCE + ".");
    expect(panel.el.textContent).not.toMatch(/Ready to merge|a person merges the pull request|Open the pull request on GitHub/);
  });

  it("shows the not-feasible notice with the project manager's reason as TEXT, and the needs-human notice with the executor's account as TEXT", async () => {
    const nf = make(NOT_FEASIBLE);
    nf.panel.start("item-nf");
    await flush();
    const [banner] = byId(nf.panel.el, "pl-not-feasible");
    expect(banner.textContent).toContain("Stopped before building. ");
    expect(banner.textContent).toContain("The project manager says this can't be built as written: ");
    expect(banner.textContent).toContain(NOT_FEASIBLE.notice.reason);
    expect(banner.textContent).toContain("Edit the issue on GitHub and approve again, or close it.");
    expect(byId(nf.panel.el, "pl-needs-human")).toHaveLength(0);
    // model markup stays characters: no element was made from it
    expect(findAll(nf.panel.el, (e) => e.tag === "b" || e.tag === "img")).toHaveLength(0);

    const nh = make(NEEDS_HUMAN);
    nh.panel.start("item-nh");
    await flush();
    const [needs] = byId(nh.panel.el, "pl-needs-human");
    expect(needs.textContent).toContain("Needs a person. ");
    expect(needs.textContent).toContain("The build stopped without a pull request. The executor's own account: ");
    expect(needs.textContent).toContain(NEEDS_HUMAN.notice.reason);
    expect(findAll(nh.panel.el, (e) => e.tag === "img")).toHaveLength(0);
    expect(findAll(needs, (e) => e.tag === "pre")).toHaveLength(1);
    expect(byId(nh.panel.el, "pl-not-feasible")).toHaveLength(0);
  });

  it("shows the check-failed notice, so a Check the build that could not decide is visible on the card", async () => {
    const { panel } = make(CHECK_FAILED);
    panel.start("item-cf");
    await flush();
    const [banner] = byId(panel.el, "pl-check-failed");
    expect(banner.textContent).toBe("Couldn't check the build. " + CHECK_FAILED.notice.reason);
    expect(byId(panel.el, "pl-not-feasible")).toHaveLength(0);
    expect(byId(panel.el, "pl-needs-human")).toHaveLength(0);
  });

  it("no notice is drawn when the response has none", async () => {
    const { panel } = make(OK);
    panel.start("item-ok");
    await flush();
    expect(byId(panel.el, "pl-not-feasible")).toHaveLength(0);
    expect(byId(panel.el, "pl-needs-human")).toHaveLength(0);
  });

  describe("D#598 P8c-3: the pause line for an item a setup request holds", () => {
    const OPEN_UNCHECKED = fx("200-setup-pause-open-unchecked.json");
    const OPEN_CHECKED = fx("200-setup-pause-open-checked.json");
    const WITHDRAWN = fx("200-setup-pause-withdrawn.json");
    const lineOf = (panel) => byId(panel.el, "pl-setup-pause").map((e) => e.textContent);

    it("shows the request's own status sentence for an open request, from the activity read alone", async () => {
      for (const data of [OPEN_UNCHECKED, OPEN_CHECKED]) {
        const { panel, calls } = make(data);
        panel.start("item-sp");
        await flush();
        expect(lineOf(panel)).toEqual([data.setup_pause.sentence]);
        expect(byId(panel.el, "pl-setup-pause")[0].getAttribute("data-state")).toBe("open");
        expect(calls.map((c) => c.url)).toEqual(["/api/v1/work-items/item-sp/activity"]); // no extra request
      }
    });

    it("a request with no sentence shows the generic line, never blank or null", async () => {
      const { panel } = make(WITHDRAWN);
      panel.start("item-sp");
      await flush();
      expect(lineOf(panel)).toEqual([SETUP_PAUSE_WORDS.withdrawn]);
      const open = make({ ...OPEN_CHECKED, setup_pause: { state: "open", sentence: null } });
      open.panel.start("item-sp2");
      await flush();
      expect(lineOf(open.panel)).toEqual([SETUP_PAUSE_WORDS.open]);
      for (const sentence of [undefined, "", "   ", 5]) {
        const m = buildInsight({ ...OK, setup_pause: { state: "open", sentence } });
        expect(m.setupPause.text).toBe(SETUP_PAUSE_WORDS.open);
      }
      for (const text of Object.values(SETUP_PAUSE_WORDS)) expect(text).not.toMatch(/null|undefined|NaN/);
    });

    it("draws nothing without a pause, or with a malformed one", async () => {
      for (const sp of [undefined, null, {}, { state: "done", sentence: "x" }, "open", 3]) {
        const { panel } = make({ ...OK, setup_pause: sp });
        panel.start("item-none");
        await flush();
        expect(lineOf(panel)).toEqual([]);
      }
    });

    it("follows the request on the next refresh, with one activity read per refresh and no other request", async () => {
      const answers = [OPEN_UNCHECKED, OPEN_CHECKED, WITHDRAWN, OK];
      let n = 0;
      const { panel, calls } = make(() => answers[Math.min(n++, answers.length - 1)]);
      panel.start("item-follow");
      await flush();
      const seen = [lineOf(panel)];
      for (let i = 0; i < 3; i++) {
        timers[0].fn();
        await flush();
        seen.push(lineOf(panel));
      }
      expect(seen).toEqual([[OPEN_UNCHECKED.setup_pause.sentence], [OPEN_CHECKED.setup_pause.sentence], [SETUP_PAUSE_WORDS.withdrawn], []]);
      expect(calls).toHaveLength(4);
      expect(new Set(calls.map((c) => c.url))).toEqual(new Set(["/api/v1/work-items/item-follow/activity"]));
    });

    it("shows hostile sentence text as text only", async () => {
      const hostile = "<img src=x onerror=alert(1)>";
      const { panel } = make({ ...OPEN_CHECKED, setup_pause: { state: "open", sentence: hostile } });
      panel.start("item-xss");
      await flush();
      expect(lineOf(panel)).toEqual([hostile]);
      expect(findAll(panel.el, (e) => e.tag === "img")).toHaveLength(0);
    });
  });

  describe("D#7 start gate (c): how the item's start was decided", () => {
    const FX = Object.fromEntries(["asked", "started-person", "started-dial", "declined", "withdrawn", "unknown"].map((k) => [k, fx("200-start-decision-" + k + ".json")]));
    const lineOf = (panel) => byId(panel.el, "pl-start-decision").map((e) => e.textContent);

    it("shows the cloud's sentence for each outcome, with when it was decided, from the activity read alone", async () => {
      for (const [k, data] of Object.entries(FX)) {
        const { panel, calls } = make(data);
        panel.start("item-sd-" + k);
        await flush();
        const [line] = lineOf(panel);
        expect(line.startsWith(data.start_decision.sentence), k).toBe(true);
        if (data.start_decision.at !== null) expect(line.length, k).toBeGreaterThan(data.start_decision.sentence.length + 4); // the time follows
        else expect(line, k).toBe(data.start_decision.sentence);
        expect(byId(panel.el, "pl-start-decision")[0].getAttribute("data-state")).toBe(data.start_decision.state);
        expect(calls).toHaveLength(1);
        expect(line).not.toMatch(/start_work|start_parent|start_after|policy|null|undefined|NaN|[0-9a-f]{8}-[0-9a-f]{4}/);
      }
    });

    it("says who and which setting decided: a person by name, the dial by its preset", () => {
      expect(FX["started-person"].start_decision.sentence).toBe("Started by Ada Lovelace.");
      expect(FX["started-dial"].start_decision.sentence).toMatch(/^Started automatically under your Autonomous setting/);
      expect(FX.declined.start_decision.sentence).toMatch(/^Held by Ada Lovelace\./);
    });

    it("falls back to words for the state when the sentence is missing, and to a generic line for a state it does not know", () => {
      for (const sentence of [undefined, "", "   ", 5, null]) {
        for (const state of ["asked", "started", "declined", "withdrawn"]) expect(buildInsight({ ...OK, start_decision: { state, sentence } }).startDecision.text).toBe(START_DECISION_WORDS[state]);
      }
      for (const state of ["unknown", "brand_new_state", undefined, 7, null]) {
        const m = buildInsight({ ...OK, start_decision: { state, sentence: "" } });
        expect(m.startDecision).toEqual({ state: "unknown", text: START_DECISION_WORDS.unknown });
      }
      for (const text of Object.values(START_DECISION_WORDS)) expect(text).not.toMatch(/null|undefined|NaN|_/);
      expect(buildInsight({ ...OK, start_decision: { state: "started", sentence: "Started by a person.", at: "not a date" } }).startDecision.text).toBe("Started by a person.");
    });

    it("draws nothing without a start decision, or with a malformed one", async () => {
      for (const sd of [undefined, null, "started", 3, [], true]) {
        const { panel } = make({ ...OK, start_decision: sd });
        panel.start("item-sd-none");
        await flush();
        expect(lineOf(panel)).toEqual([]);
      }
    });

    it("shows hostile text as text only", async () => {
      const hostile = "<img src=x onerror=alert(1)>";
      const { panel } = make({ ...OK, start_decision: { state: "started", by: "person", name: hostile, at: null, sentence: "Started by " + hostile + "." } });
      panel.start("item-sd-xss");
      await flush();
      expect(lineOf(panel)).toEqual(["Started by " + hostile + "."]);
      expect(findAll(panel.el, (e) => e.tag === "img")).toHaveLength(0);
    });
  });

  describe("D#7 DW-R5: the decisions recorded for the item", () => {
    const R = fx("200-receipts.json");
    const one = (over) => ({ id: "r1", label: "Starting a small piece of work", class: 2, at: "2026-10-20T09:30:00.000Z", by: "policy", chosen: "start", rejected: "hold", ...over });
    const texts = (data) => (receiptsSection(data) ? receiptsSection(data).items.map((i) => i.text) : null);

    it("has the fixed heading and one line per receipt, newest first as sent, from the activity read alone", async () => {
      const m = buildInsight(R).receipts;
      expect(m.heading).toBe("Decisions recorded for this item");
      expect(RECEIPTS_HEADING).toBe(m.heading);
      expect(m.items).toHaveLength(3);
      expect(m.items[0].text).toMatch(/^Undoing an earlier decision\. Chosen: undo\. Not chosen: keep\. Decided by a person, /);
      expect(m.items[1].text).toMatch(/^Starting a small piece of work\. Chosen: start\. Not chosen: hold\. Decided by your setting, /);
      expect(m.more).toBe("Showing the newest 3 of 52.");
      const { panel } = make(R);
      panel.start("item-rc");
      await flush();
      expect(byId(panel.el, "pl-receipt")).toHaveLength(3);
      expect(byId(panel.el, "pl-receipts-heading").map((e) => e.textContent)).toEqual([RECEIPTS_HEADING]);
    });

    it("tells two receipts of the same type apart by their times", () => {
      const [a, b] = texts({ receipts: [one({ at: "2026-10-22T10:00:00.000Z" }), one({ at: "2026-10-20T09:30:00.000Z" })] });
      expect(a).not.toBe(b);
    });

    it("never makes an empty, null or undefined line, whatever it is given", () => {
      const cases = [
        [one({ label: undefined }), /^A decision\./],
        [one({ label: "  " }), /^A decision\./],
        [one({ at: undefined }), /^Starting a small piece of work\. Chosen: start\. Not chosen: hold\. Decided by your setting\.$/],
        [one({ at: "not a date" }), /Decided by your setting\.$/],
        [one({ by: "robot" }), /^Starting a small piece of work\. Chosen: start\. Not chosen: hold\. \S/],
        [one({ by: undefined, at: undefined }), /^Starting a small piece of work\. Chosen: start\. Not chosen: hold\.$/],
        [one({ chosen: "(not shown)", rejected: 7 }), /^Starting a small piece of work\. Decided by your setting, /],
        [one({ label: "Undoing a decision again after two undos", by: "person" }), /^Undoing a decision again after two undos\. /],
      ];
      for (const [r, re] of cases) {
        const [line] = texts({ receipts: [r] });
        expect(line).toMatch(re);
        expect(line).not.toMatch(/null|undefined|NaN|\[object|Invalid/);
      }
    });

    it("draws nothing for no receipts, a missing list, or entries that are not objects; one good entry among bad ones still shows", () => {
      for (const receipts of [undefined, null, [], "x", 3, {}, [null, 5, "s", []]]) expect(receiptsSection({ receipts })).toBeNull();
      expect(texts({ receipts: [null, one(), 7] })).toHaveLength(1);
      expect(receiptsSection({ receipts: [one()] }).more).toBeNull();
      expect(receiptsSection({ receipts: [one()], receipts_total: "9" }).more).toBeNull();
      expect(buildInsight({ ...OK }).receipts).toBeNull();
    });

    it("shows hostile text as text only", async () => {
      const hostile = "<img src=x onerror=alert(1)>";
      const { panel } = make({ ...OK, receipts: [one({ label: hostile })] });
      panel.start("item-rc-xss");
      await flush();
      expect(byId(panel.el, "pl-receipt").map((e) => e.textContent)).toEqual([hostile + ". Chosen: start. Not chosen: hold. Decided by your setting, " + formatWhen("2026-10-20T09:30:00.000Z") + "."]);
      expect(findAll(panel.el, (e) => e.tag === "img")).toHaveLength(0);
    });
  });

  describe("D#7 DP8-f1: the state flags", () => {
    afterEach(() => vi.unstubAllGlobals());
    const drawn = async (over) => {
      const { panel } = make({ ...OK, ...over });
      panel.start("item-flags");
      await flush();
      return panel;
    };

    it("halted alone draws only the halted flag", async () => {
      const panel = await drawn({ halted: true, waiting_on_answer: false });
      expect(byId(panel.el, "pl-flag-halted")).toHaveLength(1);
      expect(byId(panel.el, "pl-flag-halted")[0].textContent).toBe(FLAG_WORDS.halted);
      expect(byId(panel.el, "pl-flag-waiting_on_answer")).toHaveLength(0);
    });

    it("waiting alone draws 'Waiting for your answer' and no halted flag", async () => {
      const panel = await drawn({ halted: false, waiting_on_answer: true });
      expect(byId(panel.el, "pl-flag-waiting_on_answer")[0].textContent).toBe("Waiting for your answer");
      expect(byId(panel.el, "pl-flag-halted")).toHaveLength(0);
    });

    it("both draw side by side, and neither leaves the live region empty", async () => {
      const both = await drawn({ halted: true, waiting_on_answer: true });
      expect(byId(both.el, "pl-flags")).toHaveLength(1);
      expect(byId(both.el, "pl-flag-halted")).toHaveLength(1);
      expect(byId(both.el, "pl-flag-waiting_on_answer")).toHaveLength(1);
      const none = await drawn({ halted: false, waiting_on_answer: false });
      expect(byId(none.el, "pl-flags")).toHaveLength(1);
      expect(byId(none.el, "pl-flags")[0].textContent).toBe("");
      expect(byId(none.el, "pl-flag-halted")).toHaveLength(0);
      expect(byId(none.el, "pl-flag-waiting_on_answer")).toHaveLength(0);
    });

    it("never draws a raw id, null or undefined, in any of the four states", async () => {
      for (const [halted, waiting_on_answer] of [[true, false], [false, true], [true, true], [false, false]]) {
        const panel = await drawn({ halted, waiting_on_answer });
        const flags = byId(panel.el, "pl-flags").map((f) => f.textContent).join("");
        expect(flags).not.toMatch(/null|undefined|NaN|waiting_on_answer|[0-9a-f]{8}-[0-9a-f]{4}/);
      }
    });

    it("keeps one polite live region across refreshes and writes the flag text into it", async () => {
      let n = 0;
      const answers = [{ ...OK, halted: false, waiting_on_answer: false }, { ...OK, halted: false, waiting_on_answer: true }, { ...OK, halted: true, waiting_on_answer: true }, { ...OK, halted: false, waiting_on_answer: false }];
      const { panel } = make(() => answers[Math.min(n++, answers.length - 1)]);
      panel.start("item-live");
      await flush();
      const [region] = byId(panel.el, "pl-flags");
      expect(region.getAttribute("role")).toBe("status");
      expect(region.getAttribute("aria-live")).toBe("polite");
      expect(region.textContent).toBe("");
      const texts = [];
      for (let i = 0; i < 3; i++) {
        timers[0].fn();
        await flush();
        expect(byId(panel.el, "pl-flags")).toHaveLength(1);
        expect(byId(panel.el, "pl-flags")[0]).toBe(region);
        texts.push(region.textContent);
      }
      expect(texts).toEqual([FLAG_WORDS.waiting_on_answer, FLAG_WORDS.halted + FLAG_WORDS.waiting_on_answer, ""]);
    });

    it("keeps focus on the Needs you button when the card redraws", async () => {
      vi.stubGlobal("window", { FULCWM: { open: vi.fn() }, FULCApps: { get: (id) => (id === NEEDS_YOU_APP ? {} : undefined) } });
      let n = 0;
      const { panel } = make(() => ({ ...OK, halted: false, waiting_on_answer: true, runs: n++ ? OK.runs.slice(0, 2) : OK.runs }));
      panel.start("item-focus");
      await flush();
      const [before] = byId(panel.el, "pl-flag-needs-you");
      before.focus();
      expect(document.activeElement).toBe(before);
      timers[0].fn();
      await flush();
      const [after] = byId(panel.el, "pl-flag-needs-you");
      expect(after).not.toBe(before);
      expect(document.activeElement).toBe(after);
    });

    it("links the waiting flag to Needs you only while that app is registered, and the link opens it", async () => {
      const open = vi.fn();
      vi.stubGlobal("window", { FULCWM: { open }, FULCApps: { get: (id) => (id === NEEDS_YOU_APP ? {} : undefined) } });
      const linked = await drawn({ halted: false, waiting_on_answer: true });
      const [btn] = byId(linked.el, "pl-flag-needs-you");
      expect(btn.textContent).toBe("Needs you");
      btn.on.click();
      expect(open).toHaveBeenCalledWith(NEEDS_YOU_APP);
      vi.stubGlobal("window", { FULCWM: { open }, FULCApps: { get: () => undefined } });
      const unlinked = await drawn({ halted: false, waiting_on_answer: true });
      expect(byId(unlinked.el, "pl-flag-needs-you")).toHaveLength(0);
      expect(byId(unlinked.el, "pl-flag-waiting_on_answer")).toHaveLength(1);
    });
  });

  it("an unchanged answer does not redraw at all, and opening the item again starts from the defaults", async () => {
    const { panel } = make(OK);
    panel.start("item-1");
    await flush();
    const before = byId(panel.el, "pl-ins-run")[0];
    timers[0].fn();
    await flush();
    expect(byId(panel.el, "pl-ins-run")[0]).toBe(before); // same answer: not redrawn
    // The person closes the running review (the click handler runs before the browser toggles).
    const runs = byId(panel.el, "pl-ins-run");
    runs[5].open = true;
    runs[5].kids[0].on.click();
    panel.start("item-1"); // opened again: back to the defaults, loading first
    expect(panel.el.textContent).toBe(SENTENCES.loading);
    await flush();
    expect(byId(panel.el, "pl-ins-run")[5].open).toBe(true);
  });

  it("choices survive a changed answer for the same open item", async () => {
    let n = 0;
    const { panel } = make(() => {
      n += 1;
      const d = structuredClone(OK);
      if (n > 1) d.runs[5].lines.push({ at: "2026-10-03T10:02:00.000Z", text: "Reading src/more.ts" });
      return d;
    });
    panel.start("item-1");
    await flush();
    const runs = byId(panel.el, "pl-ins-run");
    runs[4].open = false;
    runs[4].kids[0].on.click(); // the person opens the executor's run
    runs[5].open = true;
    runs[5].kids[0].on.click(); // and closes the running review
    byId(panel.el, "pl-spec")[0].open = false;
    byId(panel.el, "pl-spec")[0].kids[0].on.click();
    const before = byId(panel.el, "pl-ins-run")[0];
    timers[0].fn();
    await flush();
    expect(byId(panel.el, "pl-ins-run")[0]).not.toBe(before); // redrawn
    const after = byId(panel.el, "pl-ins-run");
    expect(after.map((e) => e.open)).toEqual([false, false, false, false, true, false]);
    expect(byId(panel.el, "pl-spec")[0].open).toBe(true);
    expect(byId(after[5], "pl-feed")[0].kids.length).toBe(OK.runs[5].lines.length + 1);
  });

  it("a failed refresh keeps the last answer and says so; a failed first load is one fixed sentence", async () => {
    const boom = Object.assign(new Error("server text that must never be shown"), { status: 500 });
    let fail = false;
    const { panel } = make(() => (fail ? boom : OK));
    panel.start("item-1");
    await flush();
    fail = true;
    timers[0].fn();
    await flush();
    expect(panel.el.textContent).toContain(SENTENCES.stale);
    expect(byId(panel.el, "pl-ins-run")).toHaveLength(6);
    expect(panel.el.textContent).not.toContain("server text");
    fail = false;
    timers[0].fn();
    await flush();
    expect(panel.el.textContent).not.toContain(SENTENCES.stale);

    const { panel: p2 } = make(boom);
    p2.start("item-9");
    await flush();
    expect(p2.el.textContent).toBe(SENTENCES.error);
  });

  it("a malformed answer is an error, not a half-drawn panel", async () => {
    const { panel } = make({ runs: "no" });
    panel.start("item-1");
    await flush();
    expect(panel.el.textContent).toBe(SENTENCES.error);
  });

  it("an answer for an item that is no longer open is dropped, and stop aborts the request", async () => {
    let resolveFirst;
    const calls = [];
    const panel = createInsightPanel({
      call: (m, url, b, signal) => {
        calls.push({ url, signal });
        return calls.length === 1 ? new Promise((r) => (resolveFirst = () => r(structuredClone(OK)))) : Promise.resolve(structuredClone(EMPTY));
      },
      setInterval: () => 1,
      clearInterval() {},
    });
    panel.start("a");
    panel.start("b");
    await flush();
    resolveFirst();
    await flush();
    expect(calls[0].signal.aborted).toBe(true);
    expect(panel.el.textContent).toContain(SENTENCES.noRuns); // item b's answer, not a's
    panel.stop();
    expect(calls[1].signal.aborted).toBe(true);
  });

  it("does not poll while the page is hidden", async () => {
    const { panel, call } = make(OK);
    panel.start("item-1");
    await flush();
    document.hidden = true;
    timers[0].fn();
    await flush();
    expect(call).toHaveBeenCalledTimes(1);
    document.hidden = false;
    timers[0].fn();
    await flush();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("model text is only ever text: no element is built from it", async () => {
    const hostile = structuredClone(OK);
    const payload = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=1</script>';
    hostile.comments[0].body = payload;
    hostile.spec.body = payload;
    hostile.runs[4].summary = payload;
    hostile.runs[5].lines[0].text = payload;
    const { panel } = make(hostile);
    panel.start("item-1");
    await flush();
    expect(findAll(panel.el, (e) => ["img", "script"].includes(e.tag))).toHaveLength(0);
    expect(panel.el.textContent).toContain(payload);
  });
});

describe("D#600 CX-8b: the context button's accessible name is unique per run", () => {
  it("runs of one role are told apart by their place among them; a lone role keeps the short name", () => {
    const mk = (id, role) => ({ id, role, status: "succeeded", runtime: "production", created_at: "2026-10-15T10:00:00Z", lines: [] });
    const m = buildInsight({ runs: [mk("1", "executor"), mk("2", "code-reviewer"), mk("3", "executor")] });
    const labels = m.runs.map((r) => r.contextLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toMatch(/, run 1 of 2$/);
    expect(labels[2]).toMatch(/, run 2 of 2$/);
    expect(labels[1]).toBe("What this run loaded: " + m.runs[1].role);
  });
});

describe("runs that wait for a runner are not read as running", () => {
  const mk = (id, role, status, extra = {}) => ({ id, role, status, runtime: "runner", created_at: "2026-10-24T18:28:00Z", lines: [], ...extra });
  const slot = (cause) => ({ reason: "waiting_for_runner_slot", limited_by: cause, text: "Waiting for a free slot on your runner" });

  it("unclaimed runner runs are not under Running now; the waiting line names them and the cause the runner gave", () => {
    const m = buildInsight({ runs: [mk("1", "code-reviewer", "pending", { wait: slot("memory") }), mk("2", "acceptance-tester", "pending", { wait: slot("memory") })] });
    expect(m.runningText).toBe("Nothing is running right now.");
    expect(m.waitingText).toBe("Waiting for your runner: Code reviewer, Acceptance tester (memory is short)");
  });

  it("a running run keeps Running now while its sibling waits", () => {
    const m = buildInsight({ runs: [mk("1", "executor", "running"), mk("2", "code-reviewer", "pending", { wait: slot("cpu") })] });
    expect(m.runningText).toBe("Running now: Executor");
    expect(m.waitingText).toBe("Waiting for your runner: Code reviewer (the CPU is busy)");
  });

  it("without a cause, the cloud's own sentence for the wait is shown; with none at all, only the names", () => {
    const offline = { reason: "waiting_for_runner", limited_by: null, text: "Waiting for your runner to come online" };
    expect(buildInsight({ runs: [mk("1", "code-reviewer", "pending", { wait: offline })] }).waitingText).toBe("Waiting for your runner: Code reviewer · Waiting for your runner to come online");
    expect(buildInsight({ runs: [mk("1", "code-reviewer", "pending")] }).waitingText).toBe("Waiting for your runner: Code reviewer");
  });

  it("a cause this build does not know falls back to the sentence, never to the code", () => {
    const m = buildInsight({ runs: [mk("1", "code-reviewer", "pending", { wait: { reason: "waiting_for_runner_slot", limited_by: "from_the_future", text: "Waiting for a free slot on your runner" } })] });
    expect(m.waitingText).toBe("Waiting for your runner: Code reviewer · Waiting for a free slot on your runner");
    expect(m.waitingText).not.toContain("from_the_future");
  });

  it("nothing waiting: no waiting line", () => {
    expect(buildInsight(OK).waitingText).toBeNull();
    expect(buildInsight(EMPTY).waitingText).toBeNull();
  });
});

// ── D#598 P1f-6a: the "Public change" block, one page test per state, over the fixtures the real route produced ──────────────────
describe("the Public change block", () => {
  const CASES = [
    ["building", "Building the public change"],
    ["scanning", "Scanning"],
    ["pushed", "Pushed"],
    ["pr_opened", "PR opened"],
    ["refused", "Refused: the scan found something that must not be public"],
    ["pushed_pr_not_opened", "Pushed, PR not opened"],
    ["no_public_change", "No public change"],
    ["refused-retry_limit", "Refused: the push has already been tried three times"],
    ["refused-pairing_off", "Refused: the pairing is off"],
    ["refused-unknown_code", "Refused: the change was not sent"],
    ["refused-runner", "Refused: the public repository could not be reached. Use Build again to try once more."],
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("Node", FakeNode);
    vi.stubGlobal("document", { hidden: false, activeElement: null, createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function show(data) {
    const panel = createInsightPanel({ call: vi.fn(async () => structuredClone(data)), setInterval: () => 1, clearInterval: () => {} });
    panel.start("item-1");
    await flush();
    return panel;
  }

  for (const [name, sentence] of CASES) {
    it(name + ": shows the sentence, the full repo name and the branch, with no null or undefined text", async () => {
      const data = fx("200-public-change-" + name + ".json");
      const panel = await show(data);
      const block = byId(panel.el, "pl-public-change");
      expect(block).toHaveLength(1);
      expect(byId(panel.el, "pl-public-change-sentence")[0].textContent).toBe(sentence);
      const where = byId(panel.el, "pl-public-change-where")[0].textContent;
      expect(where).toContain("acme/docs-public");
      expect(where).toContain(data.public_change.branch);
      expect(block[0].textContent).not.toMatch(/null|undefined/);
      // The raw code is never what the person reads for a refusal the copy does not know.
      expect(block[0].textContent).not.toContain("a_code_from_the_future");
    });
  }

  it("a pull request shows as text and one anchor to github.com; a state with none has no anchor", async () => {
    const withPr = await show(fx("200-public-change-pr_opened.json"));
    expect(byId(withPr.el, "pl-public-change-where")[0].textContent).toContain("Pull request #88");
    const links = byId(withPr.el, "pl-public-change-link");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://github.com/acme/docs-public/pull/88");
    const without = await show(fx("200-public-change-pushed.json"));
    expect(byId(without.el, "pl-public-change-link")).toHaveLength(0);
  });

  it("an address that is not a github.com pull request gets no anchor", () => {
    const data = fx("200-public-change-pr_opened.json");
    data.public_change.pr_url = "https://evil.example/acme/docs-public/pull/88";
    expect(buildInsight(data).publicChange.prUrl).toBeNull();
    data.public_change.pr_url = "javascript:alert(1)";
    expect(buildInsight(data).publicChange.prUrl).toBeNull();
  });

  it("the anchor leads to exactly this pull request of this repository: another pull request, another repository or another host gets none", () => {
    const data = fx("200-public-change-pr_opened.json");
    data.public_change.pr_url = "https://github.com/acme/docs-public/pull/89";
    expect(buildInsight(data).publicChange.prUrl).toBeNull();
    data.public_change.pr_url = "https://github.com/evil/other/pull/88";
    expect(buildInsight(data).publicChange.prUrl).toBeNull();
    data.public_change.pr_url = "https://github.com/acme/docs-public/pull/88/files";
    expect(buildInsight(data).publicChange.prUrl).toBeNull();
    data.public_change.pr_url = "https://github.com/Acme/Docs-Public/pull/88";
    expect(buildInsight(data).publicChange.prUrl).toBe("https://github.com/Acme/Docs-Public/pull/88");
  });

  it("an item with no public change draws no block", async () => {
    expect(buildInsight(OK).publicChange).toBeNull();
    const panel = await show(OK);
    expect(byId(panel.el, "pl-public-change")).toHaveLength(0);
  });
});

describe("the short-Spec refusal notice (spec_refused)", () => {
  const TAIL = " Nothing was saved. Edit the issue on GitHub and approve again, or close it.";
  const banner = (reason) => noticeBanner({ notice: { kind: "spec_refused", reason } });
  const SENTENCES_BY_CODE = {
    invalid_spec_output: "The Spec writer's output was incomplete, so no Spec was published." + TAIL,
    invalid_file_scope: "The Spec writer didn't give a readable list of the files the change may touch, so no Spec was published." + TAIL,
    invalid_planned_prs: "The Spec writer's list of planned pull requests couldn't be read, so no Spec was published." + TAIL,
    planned_prs_too_large: "The Spec writer planned more pull requests than one Spec may hold, so no Spec was published." + TAIL,
    planned_split_missing: "The Spec writer said the work should be split into several pull requests but gave no list of them, so no Spec was published." + TAIL,
    planned_split_unflagged: "The Spec writer listed several pull requests without saying the work should be split, so no Spec was published." + TAIL,
    spec_too_large: "The Spec came out larger than a Spec may be, so it was not published." + TAIL,
    item_halted: "This item is halted, so no Spec was published. Approve it again when you want it to continue, or close it.",
    publish_failed: "The Spec couldn't be saved just now, so it was not published." + TAIL,
    empty_agent_output: "The Spec writer finished without giving an answer, so no Spec was published. Approve again to try once more, or close it.",
    clone_failed: "The Spec writer couldn't get a copy of the repository, so no Spec was published. Approve again to try once more, or close it.",
  };
  for (const [code, sentence] of Object.entries(SENTENCES_BY_CODE)) {
    it(`${code} reads as its one fixed sentence`, () => {
      expect(banner(code)).toEqual({ kind: "spec_refused", title: "Stopped before building. ", lead: "", tail: "", reason: sentence });
    });
  }
  it("has exactly these sentences, and an unknown or hostile code reads as the generic one, never as the code's own text", () => {
    expect(Object.keys(SPEC_REFUSED_SENTENCES).sort()).toEqual(Object.keys(SENTENCES_BY_CODE).sort());
    for (const code of ["refused", "from_the_future", "constructor", "__proto__", "<b>x</b>"]) expect(banner(code).reason, code).toBe(SPEC_REFUSED_GENERIC);
    expect(SPEC_REFUSED_GENERIC).toBe("The Spec step stopped before publishing a Spec." + TAIL);
  });
});

describe("a request retired for its tracked item (superseded)", () => {
  const ROOT = "3a1f9a52-7a43-4c1e-9b0e-0c5d9a2b7e11";
  const banner = (reason) => noticeBanner({ notice: { kind: "superseded", reason } });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("Node", FakeNode);
    vi.stubGlobal("document", { hidden: false, activeElement: null, createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  async function show(reason, onOpenItem) {
    const data = { ...structuredClone(OK), stage: "closed", notice: { kind: "superseded", reason } };
    const panel = createInsightPanel({ call: vi.fn(async () => structuredClone(data)), setInterval: () => 1, clearInterval: () => {}, onOpenItem });
    panel.start("item-1");
    await flush();
    return panel;
  }

  it("reads as its one fixed sentence, never the id, and carries the root id only when it is well formed", () => {
    expect(banner(ROOT)).toEqual({ kind: "superseded", title: "", lead: "", tail: "", reason: SUPERSEDED_SENTENCE, rootId: ROOT });
    expect(SUPERSEDED_SENTENCE).toBe("This request moved to its tracked item, which carries the work from here.");
    for (const bad of ["", "not-an-id", "<b>x</b>", ROOT + "x", "__proto__"]) expect(banner(bad), bad).toMatchObject({ reason: SUPERSEDED_SENTENCE, rootId: null });
  });

  it("the card shows the sentence and a link that opens the root item", async () => {
    const open = vi.fn();
    const panel = await show(ROOT, open);
    expect(byId(panel.el, "pl-superseded")).toHaveLength(1);
    expect(byId(panel.el, "pl-notice-reason")[0].textContent).toBe(SUPERSEDED_SENTENCE);
    const link = byId(panel.el, "pl-superseded-link");
    expect(link).toHaveLength(1);
    expect(link[0].textContent).toBe(SUPERSEDED_LINK_LABEL);
    link[0].on.click();
    expect(open).toHaveBeenCalledWith(ROOT);
  });

  it("with no root the sentence shows and no link is drawn (an item of another account is never linked)", async () => {
    const panel = await show("", vi.fn());
    expect(byId(panel.el, "pl-notice-reason")[0].textContent).toBe(SUPERSEDED_SENTENCE);
    expect(byId(panel.el, "pl-superseded-link")).toHaveLength(0);
  });
});
