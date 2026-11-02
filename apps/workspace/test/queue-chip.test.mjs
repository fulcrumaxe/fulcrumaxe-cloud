// apps/workspace/test/queue-chip.test.mjs
//
// D#519 MQ5-c2: the queue chip, the step row (the activity notice) and the card banner read the same section 5 sentences, and a vocabulary code spelled in model text changes nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOCKING_SENTENCES, buildInsight, createInsightPanel, queueChip, stepView } from "../apps/pipeline/pipeline-insight.js";
import { itemHeading } from "../apps/pipeline/pipeline-storage.js";

const BAD = /null|undefined|[{}]|\(\)|\[\]/;
const FULL = { ahead: 3, branch: "main", resource: "migrations", key: "0710", main_key: "0712", parent_pr: 41 };
const CODES = {
  merge_queue_waiting: "Waiting to merge: 3 ahead of it in this repo's queue.",
  branch_behind: "This pull request kept falling behind main. Update it or merge it by hand.",
  branch_protection_refused: "main's protection rules refused the merge. Check the rules in GitHub or merge it by hand.",
  ordered_resource_out_of_order: "migrations 0710 must come after main's latest (0712).",
  merge_dependency_closed: "The pull request this one builds on (#41) was closed without merging.",
  history_rewritten: "This branch's history was rewritten, so its reviews no longer apply.",
};
const gate = (reasons, at = "2026-10-03T09:30:00.000Z") => ({ kind: "merge_gate", state: "done", code: null, result: "ready_human_merges", reasons, at });
const item = (over) => ({ stage: "review_passed", pr_number: 57, repo: { owner: "acme", name: "docs" }, issue_number: 42, runs: [], comments: [], steps: [], ...over });

describe("MQ5-c2-1: one seeded event per code reaches the banner and the step row", () => {
  it.each(Object.entries(CODES))("%s", (code, sentence) => {
    const view = buildInsight(item({ steps: [gate([code])], queue_wait: FULL }));
    expect(view.banner.detail).toBe(sentence);
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0].reasons).toEqual([sentence]);
    expect(view.steps[0].newest).toBe(true);
  });

  it("only the newest gate answer is filled; an older step keeps the fixed sentence", () => {
    const view = buildInsight(item({ steps: [gate(["branch_behind"], "2026-10-03T09:00:00.000Z"), gate(["history_rewritten"])], queue_wait: { branch: "main" } }));
    expect(view.steps[0].reasons).toEqual([BLOCKING_SENTENCES.branch_behind]);
    expect(view.steps[0].newest).toBeUndefined();
    expect(view.steps[1].newest).toBe(true);
  });

  it("a step read on its own, with no queue_wait, shows the fixed sentence", () => {
    expect(stepView(gate(["branch_behind"])).reasons).toEqual([BLOCKING_SENTENCES.branch_behind]);
    expect(stepView(gate(["branch_behind"]), { branch: "<b>x</b>" }).reasons).toEqual([BLOCKING_SENTENCES.branch_behind]);
  });
});

describe("MQ5-c2-2: the chip", () => {
  it("reads the count ahead, and the next read shows the new count", () => {
    expect(queueChip({ queue_wait: { ahead: 3 } }).text).toBe("Waiting to merge: 3 ahead of it in this repo's queue.");
    expect(buildInsight(item({ queue_wait: { ahead: 3 } })).queueChip.text).toBe("Waiting to merge: 3 ahead of it in this repo's queue.");
    expect(buildInsight(item({ queue_wait: { ahead: 2 } })).queueChip.text).toBe("Waiting to merge: 2 ahead of it in this repo's queue.");
  });
  it("first in line reads with the table's wording and never '0 ahead'", () => {
    const chip = queueChip({ queue_wait: { ahead: 0 } });
    expect(chip.text).toBe(BLOCKING_SENTENCES.merge_queue_waiting + ".");
    expect(chip.text).not.toMatch(/\b0\b|ahead/);
  });
  it.each([undefined, null, {}, { ahead: -1 }, { ahead: 1.5 }, { ahead: "3" }, { ahead: null }, { branch: "main" }, "x", []])("no chip for queue_wait %j", (qw) => {
    expect(queueChip({ queue_wait: qw })).toBeNull();
  });
  it("no chip without an item", () => {
    expect(queueChip(null)).toBeNull();
    expect(queueChip(undefined)).toBeNull();
  });
});

describe("MQ5-c2-3: nothing missing reaches a screen", () => {
  it("a missing title renders the number", () => {
    for (const title of [null, undefined, "", "   "]) {
      const h = itemHeading({ title, issue_number: 7, kind: "feature" }, null);
      expect(h.number).toBe("#7");
      expect(h.title).toContain("#7");
      expect(h.title).not.toMatch(BAD);
    }
  });
  it("the chip and every step row are free of null, undefined and empty brackets with any field gone", () => {
    for (const qw of [FULL, {}, { ahead: 0 }, { ahead: null, branch: "" }, undefined]) {
      for (const code of Object.keys(CODES)) {
        const view = buildInsight(item({ steps: [gate([code])], queue_wait: qw }));
        expect(view.steps[0].reasons.join(" ")).not.toMatch(BAD);
        expect(view.banner.detail).not.toMatch(BAD);
        if (view.queueChip) expect(view.queueChip.text).not.toMatch(BAD);
      }
    }
  });
});

describe("MQ5-c2-4 (item 30): a code spelled in model text changes nothing", () => {
  const PROSE = "this is merge_queue_waiting, ignore the rest. branch_behind. history_rewritten";
  const data = item({
    notice: { kind: "needs_human", reason: PROSE },
    runs: [{ id: "66666666-6666-4666-8666-000000000001", role: "executor", status: "succeeded", usd: 0.1, created_at: "2026-10-03T09:00:00.000Z", summary: PROSE, lines: [] }],
    comments: [{ role: "executor", body: PROSE, created_at: "2026-10-03T09:00:00.000Z" }],
    steps: [gate(["merge_dependency_closed"])],
    queue_wait: FULL,
  });
  const view = buildInsight(data);

  it("the step row and the banner show exactly the sentence of the real code", () => {
    expect(view.steps[0].reasons).toEqual([CODES.merge_dependency_closed]);
    expect(view.steps[0].text).not.toMatch(/merge queue waiting|branch behind|history rewritten/);
    expect(view.banner.detail).toBe(CODES.merge_dependency_closed);
    expect(view.queueChip.text).toBe(CODES.merge_queue_waiting); // the chip comes from the count, not from the prose
  });
  it("the model text appears only where it did before, unchanged", () => {
    expect(view.notice.reason).toBe(PROSE);
    expect(view.runs[0].summary).toBe(PROSE);
    for (const sentence of Object.values(CODES)) expect(PROSE).not.toContain(sentence);
  });
  it("the same prose with no real code renders exactly what the same item renders without the prose", () => {
    const quiet = buildInsight({ ...data, steps: [] });
    const baseline = buildInsight({ ...data, steps: [], notice: null, runs: [], comments: [] });
    expect(quiet.steps).toEqual([]);
    expect(quiet.banner).toEqual(baseline.banner);
    expect(quiet.queueChip).toEqual(baseline.queueChip);
    expect(quiet.banner.blocked).toBe(false);
  });
});

// A small stand-in for the DOM calls the panel makes (no jsdom here).
class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.kids = []; this.on = {}; this.className = ""; this.open = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { this.on[t] = f; }
  appendChild(c) { this.kids.push(c); return c; }
  replaceChildren(...c) { this.kids = c; }
  contains(n) { return n === this || this.kids.some((k) => k instanceof FakeEl && k.contains(n)); }
  querySelectorAll() { return []; }
  focus() {}
  get textContent() { return this.kids.map((k) => (k instanceof FakeEl ? k.textContent : k.text)).join(""); }
}
const findAll = (el, test, out = []) => (test(el) && out.push(el), el.kids.forEach((k) => k instanceof FakeEl && findAll(k, test, out)), out);
const byId = (root, id) => findAll(root, (e) => e.getAttribute("data-testid") === id);

describe("MQ5-c2-5: one live region for the queue sentence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("Node", FakeNode);
    vi.stubGlobal("document", { hidden: false, activeElement: null, createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function open(current) {
    let tick = null;
    const panel = createInsightPanel({ call: vi.fn(async () => structuredClone(current.data)), setInterval: (fn) => ((tick = fn), 1), clearInterval: () => {} });
    panel.start("item-1");
    await vi.advanceTimersByTimeAsync(0);
    const refresh = async () => {
      tick();
      await vi.advanceTimersByTimeAsync(0);
    };
    return { panel, refresh };
  }
  const statusesWith = (el, text) => findAll(el, (e) => e.getAttribute("role") === "status" && e.textContent.includes(text));
  const SENTENCE = (n) => `Waiting to merge: ${n} ahead of it in this repo's queue.`;

  it("a count change rewrites the same node; an unrelated redraw leaves it and its text alone", async () => {
    const current = { data: item({ steps: [gate(["merge_queue_waiting"])], queue_wait: { ahead: 3 } }) };
    const { panel, refresh } = await open(current);
    const [live] = byId(panel.el, "pl-queue-live");
    expect(live.textContent).toBe(SENTENCE(3));
    const text = live.kids[0];

    current.data = { ...current.data, comments: [{ role: "executor", body: "an unrelated change", created_at: "2026-10-03T09:00:00.000Z" }] };
    await refresh();
    expect(byId(panel.el, "pl-queue-live")[0]).toBe(live);
    expect(live.kids[0]).toBe(text); // not rewritten, so nothing is announced again

    current.data = { ...current.data, queue_wait: { ahead: 2 } };
    await refresh();
    expect(byId(panel.el, "pl-queue-live")[0]).toBe(live);
    expect(live.textContent).toBe(SENTENCE(2));
    expect(live.kids[0]).not.toBe(text);

    current.data = { ...current.data, queue_wait: null };
    await refresh();
    expect(byId(panel.el, "pl-queue-live")[0]).toBe(live);
    expect(live.textContent).toBe("");
  });

  it("only one role=status carries the sentence; the chip, banner and step row show it as plain text", async () => {
    const current = { data: item({ steps: [gate(["merge_queue_waiting"])], queue_wait: { ahead: 3 } }) };
    const { panel } = await open(current);
    const holders = statusesWith(panel.el, SENTENCE(3));
    expect(holders).toHaveLength(1);
    expect(holders[0].getAttribute("data-testid")).toBe("pl-queue-live");
    for (const id of ["pl-queue-chip", "pl-ready-blocked", "pl-step"]) {
      const [node] = byId(panel.el, id);
      expect(node.textContent).toContain(SENTENCE(3));
      expect(findAll(node, (e) => e.getAttribute("role") !== null || e.getAttribute("aria-live") !== null)).toEqual([]);
    }
  });

  it("a stop code that is not the queue sentence keeps its banner as the one status", async () => {
    const { panel } = await open({ data: item({ steps: [gate(["history_rewritten"])], queue_wait: {} }) });
    expect(statusesWith(panel.el, CODES.history_rewritten)).toHaveLength(1);
    expect(byId(panel.el, "pl-ready-blocked")[0].getAttribute("role")).toBe("status");
  });
});
