// apps/workspace/test/pipeline-reversal.test.mjs
//
// D#7 DP7-2f: the Reverse control's model (pipeline-insight.js, pure). Every state a receipt can be in has a row here, and no
// string on any of them may be empty, "null", "undefined" or a code. The clicks, the confirm step and the layout are in
// e2e/pipeline-reversal.spec.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../apps/_lib/api.js";
import { createInsightPanel, REVERSE_WORDS, RX_REFUSALS, confirmPrompt, outcomeNote, reversalRows, rxRefusal } from "../apps/pipeline/pipeline-insight.js";

const base = { id: "r1", label: "Starting a small piece of work", class: 2, at: "2026-10-20T09:30:00.000Z", by: "person", chosen: "start", rejected: "hold", reverses_receipt_id: null, reverses_text: "", free_until: null, deadline_text: "No free window.", price_kind: "not_yet_priced", price_usd: null, price_text: "No price yet.", can_reverse: true, reversal: null };
const rev = (state, over) => ({ id: "c1", state, kind: "rerun", reason_code: null, estimate_usd: null, pr_number: null, text: "Waiting to start.", ...over });
const ROWS = {
  free: { ...base, price_kind: "free_until", deadline_text: "Free to reverse until 2026-10-31 14:05:09 UTC." },
  priced: { ...base, price_kind: "estimate", price_usd: 1.5, price_text: "About $1.50 of your model spend so far on this item." },
  unpriced: base,
  refused: { ...base, can_reverse: false, price_kind: "unavailable", price_text: "This decision cannot be reversed." },
  pending: { ...base, can_reverse: false, reversal: rev("pending") },
  awaiting: { ...base, can_reverse: false, reversal: rev("awaiting_confirm", { estimate_usd: 2.25, text: "Waiting for you to confirm the estimate. Nothing has been spent." }) },
  running: { ...base, can_reverse: false, reversal: rev("running", { text: "In progress." }) },
  done: { ...base, can_reverse: false, reversal: rev("done", { text: "We opened a revert for you to review. Nothing changes until you merge it.", kind: "revert_pr", pr_number: 4 }) },
  failed: { ...base, can_reverse: false, reversal: rev("failed", { text: "GitHub could not open a revert for this pull request, most likely because later changes conflict with it." }) },
  reversal: { ...base, id: "r2", label: "Reversing a decision", can_reverse: false, price_kind: "unavailable", reverses_receipt_id: "r1", reverses_text: "Starting a small piece of work, 2026-10-20 09:30:00 UTC" },
  reversalOfRemoved: { ...base, id: "r3", can_reverse: false, price_kind: "unavailable", reverses_receipt_id: "r9", reverses_text: "removed item" },
  // Hostile or incomplete records the build must still draw in words.
  blankEverything: { id: "r4", label: "", at: "not a time", by: "robot", chosen: " ", rejected: "(not shown)", can_reverse: true, price_kind: "free_until", deadline_text: "", price_text: "", reversal: null },
  unknownState: { ...base, can_reverse: false, reversal: { id: "c9", state: "exploded", text: "" } },
  failedNoText: { ...base, can_reverse: false, reversal: { id: "c9", state: "failed", text: null } },
  refusedNoText: { ...base, can_reverse: false, price_kind: "unavailable", price_text: "" },
  reversalNoText: { ...base, id: "r5", can_reverse: false, reverses_receipt_id: "r1", reverses_text: "" },
};
const rowFor = (k) => reversalRows({ receipts: [ROWS[k]], total: 1 }).items[0];

describe("D#7 DP7-2f: the Reverse control model", () => {
  it("offers a control only where one can work: an open receipt reverses, an awaiting reversal confirms, nothing else has a button", () => {
    const actions = Object.fromEntries(Object.keys(ROWS).map((k) => [k, rowFor(k).action]));
    expect(actions).toEqual({
      free: "reverse", priced: "reverse", unpriced: "reverse", refused: null, pending: null, awaiting: "confirm", running: null, done: null, failed: null,
      reversal: null, reversalOfRemoved: null, blankEverything: "reverse", unknownState: null, failedNoText: null, refusedNoText: null, reversalNoText: null,
    });
  });

  it("a free receipt shows its deadline, a priced one its estimate and asks to confirm it, a refusal gives the reason and what to do instead", () => {
    expect(rowFor("free").hint).toBe("Free to reverse until 2026-10-31 14:05:09 UTC.");
    expect(rowFor("free").figure).toBeNull();
    expect(rowFor("priced").figure).toBe(1.5);
    expect(rowFor("priced").hint).toContain("About $1.50");
    expect(confirmPrompt(1.5)).toBe("A fresh build would use about $1.50 of your model spend. Nothing is spent until you confirm.");
    expect(rowFor("refused").hint).toBe("This decision cannot be reversed. To change course, ask for the work again.");
    expect(rowFor("awaiting").figure).toBe(2.25);
    expect(rowFor("awaiting").targetId).toBe("c1");
  });

  it("states a reversal's progress in the server's fixed words, strikes a reversed original, and shows a failure with its reason and no action", () => {
    expect(rowFor("pending").hint).toBe("Waiting to start.");
    expect(rowFor("running").hint).toBe("In progress.");
    expect(rowFor("done").struck).toBe(true);
    expect(rowFor("done").hint).toBe("Reversed. We opened a revert for you to review. Nothing changes until you merge it.");
    expect(rowFor("failed").struck).toBe(false);
    expect(rowFor("failed").hint).toMatch(/^Reversal failed\. GitHub could not open a revert/);
    expect(rowFor("failed").action).toBeNull();
    expect(rowFor("reversal").hint).toBe("Reverses Starting a small piece of work, 2026-10-20 09:30:00 UTC.");
    expect(rowFor("reversalOfRemoved").hint).toBe("Reverses removed item.");
    expect(rowFor("reversalNoText").hint).toBe("Reverses removed item.");
  });

  it("never draws an empty, null, undefined or code-shaped string, for every state", () => {
    const all = reversalRows({ receipts: Object.values(ROWS), total: 40 });
    expect(all.items).toHaveLength(Object.keys(ROWS).length);
    for (const it of all.items) {
      for (const k of ["text", "hint"]) {
        if (k === "hint" && it.state === "none") continue;
        expect(typeof it[k], `${it.state} ${k}`).toBe("string");
        expect(it[k].trim(), `${it.state} ${k}`).not.toBe("");
        expect(it[k], `${it.state} ${k}`).not.toMatch(/null|undefined|NaN|\[object|_/);
      }
    }
    for (const w of [...Object.values(REVERSE_WORDS), ...Object.values(RX_REFUSALS)]) {
      expect(w.trim()).not.toBe("");
      expect(w).not.toMatch(/null|undefined/);
    }
    expect(all.more).toBe("Showing the newest 16 of 40.");
  });

  it("answers each refusal with a fixed sentence, an owner-or-admin one for a member", () => {
    for (const code of ["forbidden", "insufficient_role"]) expect(rxRefusal({ code })).toBe("Only an owner or an admin can reverse a decision.");
    for (const code of ["not_reversible", "reversal_unavailable", "estimate_changed", "not_found"]) expect(rxRefusal({ code, message: "server words" })).toBe(RX_REFUSALS[code]);
    for (const e of [{ code: "offline" }, { code: "timeout" }, { code: "weird" }, null, undefined, "x"]) {
      const s = rxRefusal(e);
      expect(s.trim()).not.toBe("");
      expect(s).not.toMatch(/null|undefined|weird|server words/);
    }
  });

  it("takes the outcome's own sentence, and points at Needs you for the over-cap answer", () => {
    expect(outcomeNote({ status: "started", message: "Reversal recorded. It will start shortly." })).toEqual({ text: "Reversal recorded. It will start shortly.", needsYou: false });
    expect(outcomeNote({ status: "needs_ask", message: "" })).toEqual({ text: REVERSE_WORDS.needsYouPointer, needsYou: true });
    expect(outcomeNote(null).text).toBe("Reversal recorded.");
  });

  it("draws nothing for a missing or empty list", () => {
    for (const d of [null, {}, { receipts: "x" }, { receipts: [] }, { receipts: [null, 3] }]) expect(reversalRows(d)).toBeNull();
  });
});

// ── the panel's confirm handlers, against a small stand-in for the DOM calls it makes (no jsdom here) ──────────────────────────
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
const flush = () => vi.advanceTimersByTimeAsync(0);
const ACTIVITY = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1", "getWorkItemActivity", "200-receipts.json"), "utf8"));
const conflict = (usd) => Object.assign(new Error("estimate changed"), { status: 409, code: "estimate_changed", currentEstimateUsd: usd });

describe("D#7 DP7-2f: the confirm handlers send the figure the person was shown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("Node", FakeNode);
    vi.stubGlobal("document", { hidden: false, activeElement: null, createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A panel on one receipt; POSTs are answered in order from `answers` (an Error is thrown, anything else returned); the receipts read always answers `receipt`. */
  function make(receipt, answers) {
    const posts = [];
    const call = vi.fn(async (method, url, body) => {
      if (method === "POST") {
        posts.push({ path: url, body });
        const a = answers.shift();
        if (a instanceof Error) throw a;
        return a;
      }
      return structuredClone(url.endsWith("/receipts") ? { total: 1, receipts: [receipt] } : ACTIVITY);
    });
    const panel = createInsightPanel({ call, setInterval: () => 1, clearInterval: () => {} });
    return { panel, posts };
  }
  const press = async (panel, id) => {
    byId(panel.el, id)[0].on.click();
    await flush();
  };
  const hint = (panel) => byId(panel.el, "pl-receipt-hint")[0].textContent;

  it("the pending confirm posts to the reversal's confirm route with the stored figure it shows", async () => {
    const { panel, posts } = make(ROWS.awaiting, [{ status: "done", message: "Reversal recorded." }]);
    panel.start("item-1");
    await flush();
    expect(hint(panel)).toContain("$2.25");
    await press(panel, "pl-reverse-confirm-pending");
    expect(posts).toEqual([{ path: "/api/v1/reversals/c1/confirm", body: { confirmEstimateUsd: 2.25 } }]);
  });

  it("a 409 with a higher live estimate shows that figure although the stored one is unchanged, the next confirm sends it, and a 200 completes", async () => {
    const { panel, posts } = make(ROWS.awaiting, [conflict(3.4), { status: "done", message: "Reversal recorded." }]);
    panel.start("item-1");
    await flush();
    await press(panel, "pl-reverse-confirm-pending");
    expect(posts[0].body).toEqual({ confirmEstimateUsd: 2.25 });
    expect(byId(panel.el, "pl-reverse-note")[0].textContent).toContain(RX_REFUSALS.estimate_changed);
    expect(hint(panel)).toContain("$3.40");
    expect(hint(panel)).not.toContain("$2.25");
    await press(panel, "pl-reverse-confirm-pending");
    expect(posts[1]).toEqual({ path: "/api/v1/reversals/c1/confirm", body: { confirmEstimateUsd: 3.4 } });
    expect(byId(panel.el, "pl-reverse-note")[0].textContent).toContain("Reversal recorded.");
  });

  it("a 409 that names a lower figure than the one on screen never lowers what is shown or sent", async () => {
    const { panel, posts } = make(ROWS.awaiting, [conflict(1), { status: "done", message: "ok" }]);
    panel.start("item-1");
    await flush();
    await press(panel, "pl-reverse-confirm-pending");
    await press(panel, "pl-reverse-confirm-pending");
    expect(posts[1].body).toEqual({ confirmEstimateUsd: 2.25 });
  });

  it("the first-click path sends the figure shown, and after a 409 the next prompt and body carry the live one", async () => {
    const { panel, posts } = make(ROWS.priced, [conflict(2.75), { status: "done", message: "Reversal recorded." }]);
    panel.start("item-1");
    await flush();
    await press(panel, "pl-reverse");
    expect(byId(panel.el, "pl-reverse-estimate")[0].textContent).toContain("$1.50");
    await press(panel, "pl-reverse-confirm");
    expect(posts[0]).toEqual({ path: "/api/v1/receipts/r1/reverse", body: { confirmEstimateUsd: 1.5 } });
    await press(panel, "pl-reverse");
    expect(byId(panel.el, "pl-reverse-estimate")[0].textContent).toContain("$2.75");
    await press(panel, "pl-reverse-confirm");
    expect(posts[1]).toEqual({ path: "/api/v1/receipts/r1/reverse", body: { confirmEstimateUsd: 2.75 } });
  });
});

describe("D#7 DP7-2f: the shared client keeps the live estimate a 409 names", () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (status, body) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status, headers: { get: () => null }, text: async () => JSON.stringify(body) })));
  const post = () => api("POST", "/api/v1/reversals/c1/confirm", { confirmEstimateUsd: 2.25 }).catch((e) => e);

  it("carries data.current_estimate_usd as a number on the failure, and nothing else the server wrote", async () => {
    answer(409, { error: { code: "estimate_changed", message: "the estimate is now $3.40" }, data: { current_estimate_usd: 3.4, note: "x" } });
    const e = await post();
    expect([e.status, e.code, e.currentEstimateUsd]).toEqual([409, "estimate_changed", 3.4]);
    expect(Object.keys(e)).not.toContain("note");
  });

  it("ignores a figure that is not a plain non-negative number", async () => {
    for (const v of ["3.4", null, -1, Infinity, {}]) {
      answer(409, { error: { code: "estimate_changed", message: "m" }, data: { current_estimate_usd: v } });
      expect((await post()).currentEstimateUsd).toBeUndefined();
    }
  });
});
