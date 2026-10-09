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
  PHASES, REFRESH_MS, SENTENCES, buildInsight, createInsightPanel, firstLine, groupRounds, noticeBanner, phaseOf, pullUrl, readyBanner, reasonWord, roleWord, runView, statusWord, stepView, usdText,
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
    expect(held.reasons).toEqual(["CI is not green", "auto-merge is not allowed"]);
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
  appendChild(c) { this.kids.push(c); return c; }
  replaceChildren(...c) { this.kids = c; }
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
    vi.stubGlobal("document", { hidden: false, createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }) });
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

  it("an unchanged answer does not redraw at all, and opening the item again starts from the defaults", async () => {
    const { panel } = make(OK);
    panel.start("item-1");
    await flush();
    const before = panel.el.kids[0];
    timers[0].fn();
    await flush();
    expect(panel.el.kids[0]).toBe(before); // same answer: not redrawn
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
    const before = panel.el.kids[0];
    timers[0].fn();
    await flush();
    expect(panel.el.kids[0]).not.toBe(before); // redrawn
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
