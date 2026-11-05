// D#598 P5c-a: the Repos app's switch for merging plan updates automatically, state by state. The controller and the model have no DOM (a fake call() stands in for
// the server, strict about the real contract: boolean-only answers, one Idempotency-Key per write); the view is built by the shared h() against a small stand-in
// for the DOM calls it makes. The browser keyboard path is driven by the Repos e2e. The vitest environment is node.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLAN_WRITEBACK_HELD,
  PLAN_WRITEBACK_LABEL,
  PLAN_WRITEBACK_SENTENCE,
  PLAN_WRITEBACK_WORDS,
  createPlanWritebackControl,
  createPlanWritebackController,
  planWritebackModel,
  planWritebackUrl,
  readPlanWriteback,
} from "../apps/repos/repos-runners.js";

const REPO = "99999999-9999-4999-8999-999999999999";
const SENTENCE = "Merge plan updates by itself when they match what we computed and checks pass. Off: a person merges them.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status) => Object.assign(new Error("server text that must never be shown"), { status });

/** A server that keeps one value, answers { auto_merge, default } and refuses a write without a UUID key or with a non-boolean, as the API does. */
function fakeServer({ value = null, writeError = null, readError = null } = {}) {
  const log = [];
  let current = value;
  const call = vi.fn(async (method, path, body, _signal, opts) => {
    log.push([method, path, body, opts]);
    expect(path).toBe(planWritebackUrl(REPO));
    if (method === "GET") {
      if (readError) throw readError;
      return { auto_merge: current === true, default: current === null };
    }
    expect(method).toBe("PUT");
    expect(opts && UUID.test(opts.idempotencyKey)).toBe(true);
    expect(Object.keys(body)).toEqual(["auto_merge"]);
    expect(typeof body.auto_merge).toBe("boolean");
    if (writeError) throw writeError;
    current = body.auto_merge;
    return { auto_merge: current, default: false };
  });
  return { call, log };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the plan-update merge switch: model and controller", () => {
  it("P5c-a-3: the sentence is the fixed one, and the url names the plan-writeback setting of the repo", () => {
    expect(PLAN_WRITEBACK_SENTENCE).toBe(SENTENCE);
    expect(planWritebackUrl(REPO)).toBe("/api/v1/repos/" + REPO + "/plan-writeback/setting");
  });

  it("is off by default: the answer for a repo with no row reads as off, and an odd answer reads as unavailable, never as off", async () => {
    const { call } = fakeServer();
    const ctl = createPlanWritebackController({ call, repoId: REPO });
    expect(planWritebackModel(ctl.state, true).kind).toBe("loading");
    await ctl.load();
    expect(planWritebackModel(ctl.state, true)).toMatchObject({ kind: "ready", on: false, busy: false, adminOnly: false, saved: "", error: "" });
    for (const odd of [null, undefined, {}, { auto_merge: null, default: true }, { auto_merge: "false", default: true }, { auto_merge: false }]) {
      expect(readPlanWriteback(odd)).toBeNull();
      const c = createPlanWritebackController({ call: async () => odd, repoId: REPO });
      await c.load();
      expect(planWritebackModel(c.state, true)).toEqual({ kind: "error", text: "This setting isn't available right now." });
    }
  });

  it("a failed read is unavailable, not off", async () => {
    const ctl = createPlanWritebackController({ call: fakeServer({ readError: fail(500) }).call, repoId: REPO });
    await ctl.load();
    expect(planWritebackModel(ctl.state, true).kind).toBe("error");
  });

  it("turning it on sends one PUT with a fresh key, shows what the server answered and announces it; turning it off again is its own write", async () => {
    const { call, log } = fakeServer();
    const ctl = createPlanWritebackController({ call, repoId: REPO });
    await ctl.load();
    await ctl.change(true);
    expect(planWritebackModel(ctl.state, true)).toMatchObject({ on: true, saved: PLAN_WRITEBACK_WORDS.savedOn });
    await ctl.change(false);
    expect(planWritebackModel(ctl.state, true)).toMatchObject({ on: false, saved: PLAN_WRITEBACK_WORDS.savedOff });
    const puts = log.filter((l) => l[0] === "PUT");
    expect(puts.map((p) => p[2])).toEqual([{ auto_merge: true }, { auto_merge: false }]);
    expect(new Set(puts.map((p) => p[3].idempotencyKey)).size).toBe(2);
  });

  it("a second press while one is saving is not a second request", async () => {
    const { call, log } = fakeServer();
    const ctl = createPlanWritebackController({ call, repoId: REPO });
    await ctl.load();
    const first = ctl.change(true);
    expect(planWritebackModel(ctl.state, true).busy).toBe(true);
    await ctl.change(true);
    await first;
    expect(log.filter((l) => l[0] === "PUT")).toHaveLength(1);
  });

  it.each([[403, PLAN_WRITEBACK_WORDS.adminOnly], [409, PLAN_WRITEBACK_WORDS.saveFailed], [500, PLAN_WRITEBACK_WORDS.saveFailed]])(
    "a refused write (%s) shows this app's own sentence, keeps the old value and never the server's text",
    async (status, sentence) => {
      const ctl = createPlanWritebackController({ call: fakeServer({ writeError: fail(status) }).call, repoId: REPO });
      await ctl.load();
      await ctl.change(true);
      const m = planWritebackModel(ctl.state, true);
      expect(m).toMatchObject({ on: false, error: sentence, saved: "" });
      expect(JSON.stringify(m)).not.toMatch(/server text|null|undefined/);
    },
  );

  it("a person who cannot change it sees the value, the admin-only line and a disabled switch", async () => {
    const ctl = createPlanWritebackController({ call: fakeServer({ value: true }).call, repoId: REPO });
    await ctl.load();
    expect(planWritebackModel(ctl.state, false)).toMatchObject({ kind: "ready", on: true, adminOnly: true });
  });
});

class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.kids = []; this.on = {}; this.className = ""; this.checked = false; this.disabled = false; this.hidden = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "checked") this.checked = v === true || v === "true"; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { this.on[t] = f; }
  appendChild(c) { this.kids.push(c); return c; }
  replaceChildren(...cs) { this.kids = cs; }
  contains(n) { return n === this || this.kids.some((k) => k instanceof FakeEl && k.contains(n)); }
  querySelector(sel) { return findAll(this, (e) => "#" + e.getAttribute("id") === sel)[0] || null; }
  // A real browser cannot focus a disabled control; neither can this stand-in. A hidden element cannot take focus either.
  focus() { if (!this.disabled && !this.hidden) globalThis.document.activeElement = this; }
  get id() { return this.getAttribute("id"); }
  set id(v) { this.setAttribute("id", v); }
  get textContent() { return this.kids.map((k) => (k instanceof FakeEl ? k.textContent : k.text)).join("") + (this._text || ""); }
  set textContent(v) { this.kids = []; this._text = v; }
}
const findAll = (el, test, out = []) => (test(el) && out.push(el), el.kids.forEach((k) => k instanceof FakeEl && findAll(k, test, out)), out);
const byId = (root, id) => findAll(root, (e) => e.getAttribute("data-testid") === id)[0];

describe("the plan-update merge switch: the view", () => {
  beforeEach(() => {
    vi.stubGlobal("Node", FakeNode);
    vi.stubGlobal("document", { createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }), activeElement: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function open(canChange, server = fakeServer()) {
    const view = createPlanWritebackControl({ call: server.call, repoId: REPO, canChange: () => canChange });
    expect(byId(view.el, "repos-plan-writeback-note").textContent).toBe("Loading...");
    view.load();
    await settle();
    return { view, ...server };
  }

  it("P5c-a-3: shows the sentence, a labelled switch that is off, described by the sentence, with a status line that announces", async () => {
    const { view } = await open(true);
    const box = byId(view.el, "repos-plan-writeback-switch");
    expect(box.getAttribute("type")).toBe("checkbox");
    expect(box.getAttribute("role")).toBe("switch");
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
    expect(byId(view.el, "repos-plan-writeback-help").textContent).toBe(SENTENCE);
    expect(box.getAttribute("aria-describedby")).toBe(byId(view.el, "repos-plan-writeback-help").getAttribute("id"));
    const label = findAll(view.el, (e) => e.tag === "label")[0];
    expect(label.getAttribute("for")).toBe(box.getAttribute("id"));
    expect(label.textContent).toContain(PLAN_WRITEBACK_LABEL);
    expect(byId(view.el, "repos-plan-writeback-saved").getAttribute("role")).toBe("status");
    expect(byId(view.el, "repos-plan-writeback-error").getAttribute("role")).toBe("alert");
    expect(view.el.textContent).not.toMatch(/null|undefined|NaN|\[object/);
  });

  const press = (box, value) => { box.checked = value; box.on.change(); };
  const withFocus = async (view) => { const box = byId(view.el, "repos-plan-writeback-switch"); box.focus(); expect(globalThis.document.activeElement).toBe(box); return box; };

  it("is a native checkbox, so Space operates it from the keyboard; after a save the SAME switch holds focus, was never disabled, and the new sentence is announced", async () => {
    const { view, log } = await open(true);
    const box = await withFocus(view);
    expect(box.getAttribute("tabindex")).toBeNull(); // in the tab order, not taken out of it
    // Record every moment the switch is disabled: focus() on a disabled element is a no-op in a browser, so it must never be.
    press(box, true);
    expect(box.disabled).toBe(false);
    expect(box.getAttribute("aria-disabled")).toBe("true"); // saving: announced as unavailable, still focusable
    expect(globalThis.document.activeElement).toBe(box);
    await settle();
    expect(log.filter((l) => l[0] === "PUT")).toHaveLength(1);
    expect(byId(view.el, "repos-plan-writeback-switch")).toBe(box); // one element for the life of the control
    expect(box.checked).toBe(true);
    expect(box.getAttribute("aria-disabled")).toBe("false");
    expect(globalThis.document.activeElement).toBe(box);
    expect(byId(view.el, "repos-plan-writeback-saved").textContent).toBe(PLAN_WRITEBACK_WORDS.savedOn);
  });

  it("a press while a save is in flight is ignored and the switch shows the saved value, so there is one request", async () => {
    const { view, log } = await open(true);
    const box = await withFocus(view);
    press(box, true);
    press(box, false); // second press before the first answer
    expect(box.checked).toBe(true);
    await settle();
    expect(log.filter((l) => l[0] === "PUT")).toHaveLength(1);
    expect(box.checked).toBe(true);
  });

  it("a refused write puts the switch back, moves focus to the alert line and says why there", async () => {
    const { view } = await open(true, fakeServer({ writeError: fail(403) }));
    const box = await withFocus(view);
    press(box, true);
    await settle();
    const err = byId(view.el, "repos-plan-writeback-error");
    expect(box.checked).toBe(false);
    expect(err.textContent).toBe(PLAN_WRITEBACK_WORDS.adminOnly);
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.getAttribute("tabindex")).toBe("-1");
    expect(globalThis.document.activeElement).toBe(err);
    // A second failure of the same kind repaints without stealing focus again from where the person went.
    box.focus();
    expect(globalThis.document.activeElement).toBe(box);
  });

  it("a member sees the switch disabled with the admin-only line; a failed read shows the unavailable line and no switch", async () => {
    const { view } = await open(false);
    expect(byId(view.el, "repos-plan-writeback-switch").disabled).toBe(true);
    expect(byId(view.el, "repos-plan-writeback-admin-only").hidden).toBe(false);
    expect(byId(view.el, "repos-plan-writeback-admin-only").textContent).toBe(PLAN_WRITEBACK_WORDS.adminOnly);
    const broken = await open(true, fakeServer({ readError: fail(500) }));
    expect(byId(broken.view.el, "repos-plan-writeback-group").hidden).toBe(true);
    expect(byId(broken.view.el, "repos-plan-writeback-note").textContent).toBe("This setting isn't available right now.");
    expect(byId(broken.view.el, "repos-plan-writeback-note").hidden).toBe(false);
  });
});

describe("the plan-update merge switch: the merge dial holds it", () => {
  const HELD = "Automatic merging is on, but \"Merging a pull request once its reviews pass\" is set to ask, so a person merges plan updates for now. Change that in Roles, Autonomy.";
  const ready = (over) => ({ status: "ready", phase: "idle", error: "", on: true, dial: "act", last: null, ...over });

  it("says plainly that the merge dial is what holds it, names the setting and where to change it", () => {
    expect(PLAN_WRITEBACK_HELD).toBe(HELD);
    expect(planWritebackModel(ready({ dial: "ask" }), true).held).toBe(HELD);
  });

  it("says nothing when nothing is held: the switch off, the dial at act or announce, or a dial the answer did not carry", () => {
    for (const st of [ready({ on: false, dial: "ask" }), ready({ dial: "act" }), ready({ dial: "announce" }), ready({ dial: null })]) {
      expect(planWritebackModel(st, true).held).toBe("");
    }
  });

  it("reads the dial and the newest automatic merge from the answer; an odd word reads as no dial, never as ask", () => {
    const base = { auto_merge: true, default: false };
    expect(readPlanWriteback({ ...base, merge_dial: "ask", recent_merges: [{ id: "r", at: "2026-11-04T09:30:00.000Z", chosen: "act" }] })).toEqual({ on: true, dial: "ask", last: "2026-11-04" });
    expect(readPlanWriteback({ ...base, merge_dial: "maybe", recent_merges: "x" })).toEqual({ on: true, dial: null, last: null });
    expect(planWritebackModel(ready({ last: "2026-11-04" }), true).last).toBe("Last plan update merged automatically on 2026-11-04.");
  });

  it("the controller keeps the dial from the read and from the write, and a write never touches anything but the switch", async () => {
    const seen = [];
    const call = async (method, path, body) => {
      seen.push([method, path, body]);
      return { auto_merge: method === "PUT" ? body.auto_merge : false, default: false, merge_dial: "ask", recent_merges: [] };
    };
    const ctl = createPlanWritebackController({ call, repoId: REPO });
    await ctl.load();
    expect(planWritebackModel(ctl.state, true).held).toBe("");
    await ctl.change(true);
    expect(planWritebackModel(ctl.state, true).held).toBe(HELD);
    expect(seen.map((s) => s[0])).toEqual(["GET", "PUT"]);
    expect(seen[1][2]).toEqual({ auto_merge: true });
  });
});
