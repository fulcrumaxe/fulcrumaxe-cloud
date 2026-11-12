// apps/workspace/test/pipeline-verify-again.test.mjs
//
// D#749: the "Verify again" button in the card's check section (pipeline-insight.js). The server decides whether it is offered (the item's `actions` list
// `verify_again`); the card draws it only inside the check section and only for a finished check that did not pass. One press is one POST with no body to the
// item's verify-again route; the sentence after it is chosen here, never taken from the server. The pure half runs on the contract fixtures; the click half runs
// against the same small stand-in for the DOM calls the panel makes that the reversal tests use (no jsdom here).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVE_SENTENCES, OPERATOR_ORDER, operatorActions } from "../apps/pipeline/pipeline-actions.js";
import { createInsightPanel, verifySection, VERIFY_AGAIN_LABEL, VERIFY_AGAIN_NOTE, VERIFY_AGAIN_STARTED } from "../apps/pipeline/pipeline-insight.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (dir, name) => JSON.parse(readFileSync(join(FIXTURES, dir, name), "utf8"));
const activity = (name) => fx("getWorkItemActivity", name);
const OFFERED = "200-verify-unverified-verify-again.json";

describe("D#749: Verify again, the section model", () => {
  it("is offered on a failed or not-verified check when the server lists verify_again, and nowhere else", () => {
    expect(verifySection(activity(OFFERED)).again).toBe(true);
    expect(verifySection({ ...activity("200-verify-failed.json"), actions: ["verify_again"] }).again).toBe(true);
    // The server lists no action: no button, whatever the status.
    expect(verifySection(activity("200-verify-failed.json")).again).toBe(false);
    expect(verifySection(activity("200-verify-unverified-wrong-account.json")).again).toBe(false);
    // A status the button does not belong to never gets one, even if the list says so.
    for (const name of ["200-verify-verified.json", "200-verify-running.json", "200-verify-waiting.json"]) {
      expect(verifySection({ ...activity(name), actions: ["verify_again"] }).again, name).toBe(false);
    }
    for (const actions of [undefined, null, "verify_again", {}]) expect(verifySection({ ...activity(OFFERED), actions }).again, String(actions)).toBe(false);
  });

  it("is the section's own button: the stuck-item panel does not draw it", () => {
    expect(OPERATOR_ORDER).not.toContain("verify_again");
    expect(operatorActions({ actions: ["verify_again", "close"] })).toEqual(["close"]);
  });

  it("uses plain words that say what happens to the old result and to the streak", () => {
    expect(VERIFY_AGAIN_LABEL).toBe("Verify again");
    for (const w of [VERIFY_AGAIN_NOTE, VERIFY_AGAIN_STARTED]) {
      expect(w).not.toMatch(/_|null|undefined/);
      expect(w.endsWith(".")).toBe(true);
    }
    expect(VERIFY_AGAIN_NOTE).toContain("stays in the history");
    expect(VERIFY_AGAIN_NOTE).toContain("hands-free");
  });
});

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
  querySelector() { return null; }
  focus() {}
  get textContent() { return this.kids.map((k) => (k instanceof FakeEl ? k.textContent : k.text)).join(""); }
}
const findAll = (el, test, out = []) => (test(el) && out.push(el), el.kids.forEach((k) => k instanceof FakeEl && findAll(k, test, out)), out);
const byId = (root, id) => findAll(root, (e) => e.getAttribute("data-testid") === id);
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("D#749: Verify again, the button", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("Node", FakeNode);
    vi.stubGlobal("document", { hidden: false, activeElement: null, createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A panel whose activity read answers `reads` in order (the last one repeats); POSTs are answered in order from `answers` (an Error is thrown). */
  function make(reads, answers) {
    const posts = [];
    let n = 0;
    const call = vi.fn(async (method, url, body) => {
      if (method === "POST") {
        posts.push({ path: url, body });
        const a = answers.shift();
        if (a instanceof Error) throw a;
        return a;
      }
      return structuredClone(reads[Math.min(n++, reads.length - 1)]);
    });
    return { panel: createInsightPanel({ call, setInterval: () => 1, clearInterval: () => {} }), posts, call };
  }
  const press = async (panel) => {
    byId(panel.el, "pl-verify-again")[0].on.click();
    await flush();
  };

  it("is drawn inside the check section when the server lists it, with its note, and not otherwise", async () => {
    const a = make([activity(OFFERED)], []);
    a.panel.start("item-1");
    await flush();
    const section = byId(a.panel.el, "pl-verify")[0];
    expect(findAll(section, (e) => e.getAttribute("data-testid") === "pl-verify-again").map((b) => b.textContent)).toEqual([VERIFY_AGAIN_LABEL]);
    expect(byId(a.panel.el, "pl-verify-again-note")[0].textContent).toBe(VERIFY_AGAIN_NOTE);

    const b = make([{ ...activity(OFFERED), actions: [] }], []);
    b.panel.start("item-1");
    await flush();
    expect(byId(b.panel.el, "pl-verify")).toHaveLength(1);
    expect(byId(b.panel.el, "pl-verify-again")).toHaveLength(0);
  });

  it("one press is one POST with no body to the item's verify-again route; the new check replaces the button with the started sentence", async () => {
    const { panel, posts } = make([activity(OFFERED), activity("200-verify-waiting.json")], [{ action_id: "11111111-1111-4111-8111-111111111111", state: "accepted" }]);
    panel.start("item-1");
    await flush();
    await press(panel);
    expect(posts).toEqual([{ path: "/api/v1/work-items/item-1/verify-again", body: undefined }]);
    const say = byId(panel.el, "pl-verify-again-say")[0];
    expect(say.textContent).toBe(VERIFY_AGAIN_STARTED);
    expect(say.getAttribute("data-phase")).toBe("started");
    // The activity was read again after the press: the check now reads waiting and the button is gone.
    expect(byId(panel.el, "pl-verify")[0].getAttribute("data-status")).toBe("waiting");
    expect(byId(panel.el, "pl-verify-again")).toHaveLength(0);
  });

  it("a refusal is a fixed sentence, never the server's words, and the button stays for another try", async () => {
    const gone = Object.assign(new Error("server words"), { status: 409, code: "action_not_available" });
    const forbidden = Object.assign(new Error("server words"), { status: 403, code: "insufficient_role" });
    const slow = Object.assign(new Error("server words"), { status: 429, code: "rate_limited" });
    const { panel, posts } = make([activity(OFFERED)], [gone, forbidden, slow]);
    panel.start("item-1");
    await flush();
    for (const code of ["action_not_available", "insufficient_role", "rate_limited"]) {
      await press(panel);
      const say = byId(panel.el, "pl-verify-again-say")[0];
      expect(say.getAttribute("data-phase")).toBe("error");
      expect(say.textContent).toBe(APPROVE_SENTENCES[code]);
      expect(say.textContent).not.toMatch(/server words|null|undefined/);
      expect(byId(panel.el, "pl-verify-again")).toHaveLength(1);
    }
    expect(posts).toHaveLength(3);
  });

  it("a press while one is out sends nothing more, and opening another card starts clean", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const posts = [];
    const call = vi.fn(async (method, url) => {
      if (method === "POST") {
        posts.push(url);
        await gate;
        return { action_id: "11111111-1111-4111-8111-111111111111", state: "accepted" };
      }
      return structuredClone(activity(OFFERED));
    });
    const panel = createInsightPanel({ call, setInterval: () => 1, clearInterval: () => {} });
    panel.start("item-1");
    await flush();
    byId(panel.el, "pl-verify-again")[0].on.click();
    await flush();
    expect(byId(panel.el, "pl-verify-again")[0].getAttribute("aria-disabled")).toBe("true");
    byId(panel.el, "pl-verify-again")[0].on.click();
    await flush();
    expect(posts).toHaveLength(1);
    release();
    await flush();
    expect(byId(panel.el, "pl-verify-again-say")[0].textContent).toBe(VERIFY_AGAIN_STARTED);
    panel.start("item-2");
    await flush();
    expect(byId(panel.el, "pl-verify-again-say")).toHaveLength(0);
    expect(byId(panel.el, "pl-verify-again")[0].getAttribute("aria-disabled")).toBe("false");
  });
});
