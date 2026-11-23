// apps/workspace/test/budget-billing-engine.test.mjs
//
// D#845 ON-22c-2: the Engines row of Budget & billing, every state with its exact copy. The model (engineModel) is checked as data, and the drawn row
// (engineNode) against a small stand-in for the DOM calls it makes (there is no jsdom in this package). The copy map is checked against the billing
// route's own refusal codes and the error-code list, so a code added on one side and not the others fails here.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("../shell/core/cloud-live.js", () => ({ on: () => () => {}, onRefresh: () => () => {} }));
class FakeNode {}
class FakeText extends FakeNode { constructor(t) { super(); this.text = t; } }
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ""; }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, f) { this.listeners[t] = f; }
  get textContent() { return this.children.map((c) => (c instanceof FakeText ? c.text : c.textContent)).join(""); }
  find(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) if (c instanceof FakeEl) c.find(pred, out); return out; }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeEl(t), createTextNode: (t) => new FakeText(t) };
globalThis.window = { FULC: { register: () => {} } };
const { PAYMENT_PENDING, PAYMENT_PENDING_BILLING, ENGINE_COPY, ENGINE_REFUSED, ENGINE_BY_STATUS, ENGINE_FAILED, engineModel, engineNode, engineRefusal } = await import("../apps/budget-billing/budget-billing-app.js");
const { ApiFailure } = await import("../apps/_lib/api.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const routeSource = readFileSync(join(ROOT, "packages", "api", "src", "routes", "billing.ts"), "utf8");
const codeListSource = readFileSync(join(ROOT, "packages", "telemetry", "src", "errorCodes.ts"), "utf8");

const BODY = { offered: true, price_usd_month: 17, paid_quantity: 3, live_count: 2, min_quantity: 2, max_quantity: 100, state: "active", ended_at: null, can_change: true, as_of: "2026-11-20T10:00:00.000Z" };
const view = (over = {}, ui = {}) => {
  const body = { ...BODY, ...over };
  const calls = [];
  const notice = new FakeEl("p");
  const m = engineModel(body, ui);
  const node = engineNode(m, body, { total: (n) => calls.push(["total", n]), choose: () => calls.push(["choose"]), portal: () => calls.push(["portal"]), retry: () => calls.push(["retry"]) }, notice, false);
  const byId = (id) => node && node.find((e) => e.attrs["data-testid"] === id)[0];
  return { m, node, calls, byId, text: node ? node.textContent : "", off: (id) => byId(id) && (byId(id).disabled === true || byId(id).attrs.disabled === "true") };
};
const click = (el) => el.listeners.click();

describe("the Engines row, every state", () => {
  it("loading: its own line, no buttons", () => {
    const v = engineModel(undefined, {});
    expect(v.lines).toEqual(["Loading engines..."]);
    const d = engineNode(v, undefined, {}, new FakeEl("p"), false);
    expect(d.find((e) => e.tag === "button")).toHaveLength(0);
  });
  it("read failed: the sentence and a Try again that retries", () => {
    const v = view({}, { failed: true });
    expect(v.text).toContain("Engines couldn't be loaded.");
    click(v.byId("bb-engine-retry"));
    expect(v.calls).toEqual([["retry"]]);
  });
  it("not offered: no row, no empty box", () => {
    expect(view({ offered: false }).node).toBeNull();
  });
  it("none, owner: the line and a Choose plan button", () => {
    const v = view({ state: "none", paid_quantity: 0 });
    expect(v.text).toContain("No Engine plan yet.");
    click(v.byId("bb-engine-choose"));
    expect(v.calls).toEqual([["choose"]]);
    expect(v.byId("bb-engine-plus")).toBeUndefined();
    expect(v.byId("bb-engine-paid")).toBeUndefined();
  });
  it("active, owner: the price, both counts, and plus and minus that send the synced total one up or down", () => {
    const v = view();
    expect(v.byId("bb-engine-price").textContent).toBe("$17 a month per live engine");
    expect(v.byId("bb-engine-paid").textContent).toBe("3");
    expect(v.byId("bb-engine-live").textContent).toBe("2");
    expect(v.byId("bb-engine-summary").textContent).toBe("3 paid, 2 live");
    expect(v.byId("bb-engine-plus").attrs["aria-label"]).toBe("Add an engine");
    expect(v.byId("bb-engine-minus").attrs["aria-label"]).toBe("Remove an engine");
    click(v.byId("bb-engine-plus"));
    click(v.byId("bb-engine-minus"));
    expect(v.calls).toEqual([["total", 4], ["total", 2]]);
  });
  it("a fractional price keeps its cents", () => {
    expect(view({ price_usd_month: 26.5 }).byId("bb-engine-price").textContent).toBe("$26.50 a month per live engine");
  });
  it("minus is disabled at the minimum with the park-first words, plus at the maximum", () => {
    const low = view({ paid_quantity: 2 });
    expect(low.off("bb-engine-minus")).toBe(true);
    expect(low.byId("bb-engine-hint").textContent).toBe("Park or stop an engine to go lower.");
    const idle = view({ paid_quantity: 1, live_count: 0, min_quantity: 1 });
    expect(idle.off("bb-engine-minus")).toBe(true);
    expect(idle.byId("bb-engine-hint")).toBeUndefined();
    expect(view({ paid_quantity: 100 }).off("bb-engine-plus")).toBe(true);
    expect(view().off("bb-engine-plus")).toBe(false);
  });
  it("past due: the grace sentence, plus off, minus allowed, the portal shown", () => {
    const v = view({ state: "past_due" });
    expect(v.text).toContain("Payment overdue. Engines keep running through the grace period, then stop.");
    expect(v.off("bb-engine-plus")).toBe(true);
    expect(v.off("bb-engine-minus")).toBe(false);
    click(v.byId("bb-engine-portal"));
    expect(v.calls).toEqual([["portal"]]);
  });
  it("not paying: its sentence, both buttons off, the portal shown", () => {
    const v = view({ state: "not_paying" });
    expect(v.text).toContain("The subscription isn't being paid right now. Settle the payment in the billing portal.");
    expect(v.off("bb-engine-plus")).toBe(true);
    expect(v.off("bb-engine-minus")).toBe(true);
    expect(v.byId("bb-engine-portal")).toBeDefined();
  });
  it("a refusal that teaches not_paying turns an active row into the not-paying one", () => {
    const v = view({}, { hint: "not_paying" });
    expect(v.m.kind).toBe("not_paying");
    expect(v.off("bb-engine-plus")).toBe(true);
  });
  it("ended: the date from the server, or the plain line without one; Choose plan; no paid count", () => {
    const dated = view({ state: "ended", paid_quantity: 0, ended_at: "2026-11-01T00:00:00.000Z" });
    expect(dated.text).toContain("The Engine plan ended on Nov 1, 2026. Choose plan to start again.");
    expect(dated.byId("bb-engine-choose")).toBeDefined();
    expect(dated.byId("bb-engine-paid")).toBeUndefined();
    const undated = view({ state: "ended", paid_quantity: 0, ended_at: null });
    expect(undated.text).toContain("The Engine plan has ended.");
    for (const v of [dated, undated]) expect(v.text).not.toMatch(/undefined|null|NaN/);
  });
  it("non-owner: the same numbers, no buttons, the owner-only line", () => {
    for (const state of ["active", "past_due", "not_paying", "none", "ended"]) {
      const v = view({ can_change: false, state });
      expect(v.node.find((e) => e.tag === "button"), state).toHaveLength(0);
      expect(v.text, state).toContain("Only the account owner can change engines.");
      expect(v.byId("bb-engine-live").textContent).toBe("2");
    }
    expect(view({ can_change: false }).byId("bb-engine-paid").textContent).toBe("3");
  });
  it("busy: every button is off while a change is in flight", () => {
    const body = { ...BODY };
    const d = engineNode(engineModel(body), body, {}, new FakeEl("p"), true);
    for (const b of d.find((e) => e.tag === "button")) expect(b.disabled === true || b.attrs.disabled === "true").toBe(true);
  });
  it("a refusal that taught no_subscription offers Choose plan on an active-looking row", () => {
    expect(view({}, { hint: "no_subscription" }).byId("bb-engine-choose")).toBeDefined();
  });
  it("a payment refusal offers the billing portal", () => {
    expect(view({}, { hint: "payment" }).byId("bb-engine-portal")).toBeDefined();
  });
  it("no state draws undefined, null or NaN", () => {
    for (const over of [{}, { state: "none", paid_quantity: 0 }, { state: "past_due" }, { state: "not_paying" }, { state: "ended", paid_quantity: 0, ended_at: "garbage" }, { price_usd_month: null }, { can_change: false }]) {
      expect(view(over).text, JSON.stringify(over)).not.toMatch(/undefined|null|NaN|\[object/);
    }
  });
});

describe("the refusal copy", () => {
  const SENTENCES = {
    engine_quantity_in_use: "More engines are running than that number. Park or stop an engine first.",
    no_subscription: "This account has no paying plan yet.",
    subscription_not_paying: "The subscription isn't being paid right now. Settle the payment in the billing portal.",
    payment_pending: "The charge wasn't collected, so nothing changed. Update your payment method and try again.",
  };
  it("each code reads its own sentence from a real ApiFailure; none shows a status, undefined or a server message", () => {
    for (const [code, text] of Object.entries(SENTENCES)) {
      const status = code === "payment_pending" ? 402 : 409;
      expect(engineRefusal(new ApiFailure(status, code, "SERVER-TEXT")).text, code).toBe(text);
    }
    expect(engineRefusal(new ApiFailure(403, "insufficient_role", "SERVER-TEXT")).text).toBe("Only the account owner can change the Engine plan.");
    expect(engineRefusal(new ApiFailure(422, "invalid_quantity", "SERVER-TEXT")).text).toBe("That quantity isn't accepted.");
    expect(engineRefusal(new ApiFailure(500, "internal_error", "SERVER-TEXT")).text).toBe(ENGINE_FAILED);
    expect(engineRefusal(new Error("x")).text).toBe(ENGINE_FAILED);
    expect(engineRefusal(null).text).toBe(ENGINE_FAILED);
  });
  it("the Subscribe 402 sentences say the earlier change waits, and only one names Manage billing", () => {
    expect(PAYMENT_PENDING).toBe("An earlier change is waiting for payment, so nothing changed. Finish or update the payment, then try again.");
    expect(PAYMENT_PENDING_BILLING).toBe("An earlier change is waiting for payment, so nothing changed. Finish or update the payment in Manage billing, then try again.");
  });
  it("every code the billing route answers for the engine routes is in the error-code list and in this copy map", () => {
    const codeList = [...codeListSource.matchAll(/^\s+"([a-z_0-9]+)",$/gm)].map((m) => m[1]);
    const answered = [...routeSource.matchAll(/new ApiError\((?:409|402), "([a-z_]+)"/g)].map((m) => m[1]).filter((c) => c !== "no_billing_account");
    expect(answered.sort()).toEqual(["already_subscribed", "engine_quantity_in_use", "no_subscription", "payment_pending", "subscription_not_paying"]);
    for (const code of answered) {
      expect(codeList, code).toContain(code);
      expect(Object.keys(ENGINE_REFUSED), code).toContain(code);
    }
    expect(Object.keys(ENGINE_BY_STATUS).map(Number)).toEqual([403, 422]);
    expect(ENGINE_COPY.alreadyHeld).toBe("You already have the Engine plan.");
    expect(ENGINE_COPY.added).toBe("Engine added. This updates when the provider confirms the change.");
    expect(ENGINE_COPY.removed).toBe("Engine removed. The unused part of this month is credited to your next invoice.");
  });
});
