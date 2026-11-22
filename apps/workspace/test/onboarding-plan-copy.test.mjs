// apps/workspace/test/onboarding-plan-copy.test.mjs
//
// D#845 ON-22c-1: what a refused Engine plan purchase says in Onboarding, by the server's closed `code`. The copy map is checked against the
// error-code list and the billing route's own 409/402 map, so a code added on one side and not the other fails here. The drawn line (with its
// link) is checked against a small stand-in for the DOM calls the section makes (there is no jsdom in this package).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ApiFailure } from "../apps/_lib/api.js";
import { PLAN_BY_CODE, PLAN_BY_STATUS, PLAN_FAILED, PLAN_REREAD, engineSection, planRefusal } from "../apps/onboarding/onboarding-engine.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// The error-code list is read as text: a workspace test imports no other package's source.
const codeListSource = readFileSync(join(ROOT, "packages", "telemetry", "src", "errorCodes.ts"), "utf8");
const OWN_ERROR_CODES = [...codeListSource.matchAll(/^\s+"([a-z_0-9]+)",$/gm)].map((m) => m[1]);
const routeSource = readFileSync(join(ROOT, "packages", "api", "src", "routes", "billing.ts"), "utf8");

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

const T = "2026-11-20T10:00:00.000Z";
const IDS = ["machine", "claude", "github_app", "project", "plan", "install", "live"];
const steps = IDS.map((id) => ({ step: id, state: ["machine", "claude", "github_app"].includes(id) ? "done" : id === "project" ? "active" : "pending", completed_at: ["machine", "claude", "github_app"].includes(id) ? T : null, tier: null, ...(id === "project" ? { plan_gate: "plan_required" } : {}) }));
/** The drawn section for a refusal, the way onboarding-app.js passes it. */
function draw(failure, openable) {
  const r = planRefusal(failure);
  const opened = [];
  const root = engineSection(steps, {
    ctx: { name: "box-1", origin: "https://cloud.example.test", isAdmin: true, planNote: r.text, planLink: r.link },
    price: null, announce() {}, canOpen: (id) => openable.includes(id), openApp: (id) => opened.push(id), runAction() {},
  });
  const line = root.find((e) => e.attrs["data-testid"] === "ob-engine-line" && e.textContent.includes(r.text.slice(0, 20)))[0];
  const link = root.find((e) => e.attrs["data-testid"] === "ob-open-budget-billing");
  return { r, line, link, opened };
}

const SENTENCES = {
  already_subscribed: "This account already has that plan. Change the number of engines in Budget & billing.",
  no_subscription: "This account has no paying plan yet. Choose the Engine plan first.",
  engine_quantity_in_use: "More engines are running than that number. Park or stop an engine first.",
  subscription_not_paying: "The subscription isn't being paid right now. Settle the payment in Budget & billing, then try again.",
  payment_pending: "The charge wasn't collected, so nothing changed. Update your payment method and try again.",
};
const STATUS_OF = { already_subscribed: 409, no_subscription: 409, engine_quantity_in_use: 409, subscription_not_paying: 409, payment_pending: 402 };

describe("the five engine refusal codes, end to end across the lists", () => {
  it("every code the billing route answers for the engine routes is in the error-code list AND in the Onboarding copy map, with its status", () => {
    const answered = [...routeSource.matchAll(/new ApiError\((409|402), "([a-z_]+)"/g)].map((m) => [m[2], Number(m[1])]);
    const engineCodes = answered.filter(([c]) => c !== "no_billing_account");
    expect(Object.fromEntries(engineCodes)).toEqual(STATUS_OF);
    for (const [code] of engineCodes) {
      expect(OWN_ERROR_CODES, code).toContain(code);
      expect(Object.hasOwn(PLAN_BY_CODE, code), code).toBe(true);
    }
    expect(Object.keys(PLAN_BY_CODE).sort()).toEqual(Object.keys(STATUS_OF).sort());
  });

  it.each(Object.entries(SENTENCES))("%s renders its exact sentence from a real ApiFailure, never undefined, a status number or the server's own words", (code, sentence) => {
    const failure = new ApiFailure(STATUS_OF[code], code, "server words that must never show: cus_123");
    const { r, line } = draw(failure, []);
    expect(r.text).toBe(sentence);
    expect(line.textContent).toBe(sentence);
    expect(line.textContent).not.toMatch(/undefined|null|NaN|cus_|\b40[29]\b|server words/);
  });

  it("the Budget & billing pointer exists only in already_subscribed and subscription_not_paying, as a link only while the app can be opened", () => {
    for (const code of Object.keys(SENTENCES)) {
      const pointer = code === "already_subscribed" || code === "subscription_not_paying";
      expect(planRefusal(new ApiFailure(STATUS_OF[code], code, "x")).link, code).toBe(pointer);
      expect(SENTENCES[code].includes("Budget & billing"), code).toBe(pointer);
      const open = draw(new ApiFailure(STATUS_OF[code], code, "x"), ["budget-billing"]);
      expect(open.link, `${code} link when openable`).toHaveLength(pointer ? 1 : 0);
      expect(open.line.textContent).toBe(SENTENCES[code]);
      const shut = draw(new ApiFailure(STATUS_OF[code], code, "x"), []);
      expect(shut.link, `${code} no link when the app is off the desktop`).toHaveLength(0);
      expect(shut.line.textContent).toBe(SENTENCES[code]);
    }
    const { link, opened } = draw(new ApiFailure(409, "already_subscribed", "x"), ["budget-billing"]);
    link[0].listeners.click();
    expect(opened).toEqual(["budget-billing"]);
  });

  it("an unknown 409, an unknown code, a missing code, a non-ApiFailure and a bare 402 all read the generic line; 403 and 422 keep theirs", () => {
    for (const f of [new ApiFailure(409, "something_new", "x"), new ApiFailure(409, undefined, "x"), new ApiFailure(402, "other", "x"), new ApiFailure(500, "internal_error", "x"), new ApiFailure(409, "constructor", "x"), null, undefined, new Error("boom")]) {
      expect(planRefusal(f), String(f && f.code)).toMatchObject({ text: PLAN_FAILED, link: false });
    }
    expect(planRefusal(new ApiFailure(403, "forbidden", "x")).text).toBe("Only the account owner can change the Engine plan.");
    expect(planRefusal(new ApiFailure(422, "invalid_quantity", "x")).text).toBe("That quantity isn't accepted.");
    expect(PLAN_BY_STATUS).toEqual({ 403: "Only the account owner can change the Engine plan.", 422: "That quantity isn't accepted." });
    expect(PLAN_FAILED).toBe("The Engine plan couldn't be changed. Try again.");
  });

  it("only no_subscription and subscription_not_paying make the step read again", () => {
    expect(PLAN_REREAD).toEqual(["no_subscription", "subscription_not_paying"]);
    for (const code of PLAN_REREAD) expect(Object.hasOwn(PLAN_BY_CODE, code)).toBe(true);
  });
});
