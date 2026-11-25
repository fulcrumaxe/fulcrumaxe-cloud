// apps/workspace/test/onboarding-plan-review.test.mjs
//
// D#845 ON-11b: the plan review's own behaviour, mounted on a small fake DOM with the API stubbed (the drawn screen is in e2e/onboarding-plan.spec.ts). This holds what a screen cannot
// show cheaply: a re-read that finds nothing new leaves the person's ticks and edits alone, a re-read that finds a newer draft replaces them, what Approve sends in each review mode,
// and the version lock's two ways out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = [];
let script = () => ({});
vi.mock("../apps/_lib/api.js", () => ({ api: vi.fn(async (method, path, body) => { calls.push({ method, path, body }); return script(method, path, body); }) }));
import { mountPlanReview } from "../apps/onboarding/onboarding-engine.js";

class FakeNode {}
class FakeText extends FakeNode { constructor(t) { super(); this.text = t; } }
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.children = []; this.attrs = {}; this.handlers = {}; }
  set className(v) { this.attrs.class = v; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(type, fn) { this.handlers[type] = fn; }
  appendChild(c) { this.children.push(c); }
  replaceChildren(...c) { this.children = c.map((x) => (typeof x === "string" ? new FakeText(x) : x)); }
  querySelector(sel) { return find(this, sel)[0] ?? null; }
  focus() {}
}
const walk = (n, out = []) => (out.push(n), (n.children || []).forEach((c) => walk(c, out)), out);
const find = (el, sel) => walk(el).filter((n) => n instanceof FakeEl && (sel === "input" ? n.tag === "input" : sel.startsWith("[data-focus=") ? `[data-focus="${n.attrs["data-focus"]}"]` === sel : false));
const byId = (el, id) => walk(el).filter((n) => n instanceof FakeEl && n.attrs["data-testid"] === "ob-plan-" + id);
const texts = (el) => walk(el).filter((n) => n instanceof FakeText).map((n) => n.text);
const on = (el, type, target = {}) => el.handlers[type]({ target });
const settle = () => new Promise((r) => setTimeout(r, 0));
const disabled = (el) => el.attrs.disabled !== undefined && el.attrs.disabled !== false;

const ROW = (key, over = {}) => ({ row_key: key, title: "T" + key, summary: "", size: "S", depends_on: [], keep: true, ...over });
const draft = (over = {}, mode = "public") => ({ setup: { phase: "plan", state: "ok" }, draft: { id: "d", version: 4, source: "survey", status: "draft", prd_md: "# PRD", roadmap: [ROW("A1"), ROW("B2")], created_at: "x", ...over }, review_mode: mode });
const SETUP = "55555555-5555-4555-8555-555555555555";
const env = (extra = {}) => ({ setupId: SETUP, isAdmin: () => true, announce() {}, signal: undefined, onChanged() {}, runAction() {}, ctx: () => ({}), ...extra });
const failure = (status, code, extra = {}) => Object.assign(new Error("SERVER WORDS"), { status, code, ...extra });

let host;
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("document", { createElement: (t) => new FakeEl(t), createTextNode: (t) => new FakeText(t) });
  host = new FakeEl("div");
});
afterEach(() => vi.unstubAllGlobals());

async function mounted(body, e = env()) {
  script = (method) => (method === "GET" ? body : {});
  const m = mountPlanReview(host, e);
  await settle();
  return m;
}
const tickAll = () => { on(byId(host, "prd-read")[0], "change", { checked: true }); for (const t of byId(host, "row-read")) on(t, "change", { checked: true }); };

describe("the plan review's re-reads and ticks", () => {
  it("a re-read that finds the same draft leaves the ticks, the edits and the notes alone", async () => {
    const m = await mounted(draft());
    tickAll();
    expect(disabled(byId(host, "approve")[0])).toBe(false);
    const before = host.children[0];
    m.refresh();
    await settle();
    expect(host.children[0]).toBe(before); // not redrawn
    expect(disabled(byId(host, "approve")[0])).toBe(false);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("a re-read that finds a newer draft takes it, and the ticks start again", async () => {
    const m = await mounted(draft());
    tickAll();
    script = () => draft({ version: 5, prd_md: "# Newer" });
    m.refresh();
    await settle();
    expect(disabled(byId(host, "approve")[0])).toBe(true);
    expect(byId(host, "prd")[0].attrs.value).toBe("# Newer");
    expect(byId(host, "hint")[0].children[0].text).toBe("Tick every item as read to approve.");
  });

  it("a re-read that fails keeps the screen; a re-read that finds no draft says there is none", async () => {
    const m = await mounted(draft());
    script = () => { throw failure(500, "boom"); };
    m.refresh();
    await settle();
    expect(byId(host, "approve")).toHaveLength(1);
    script = () => { throw failure(404, "not_found"); };
    m.refresh();
    await settle();
    expect(texts(host)).toContain("There is no plan to review. Write your own.");
  });

  it("a re-read is skipped while there are unsaved edits", async () => {
    const m = await mounted(draft({}, "standard"));
    on(byId(host, "title")[0], "input", { value: "Changed" });
    const reads = calls.length;
    m.refresh();
    await settle();
    expect(calls).toHaveLength(reads);
  });
});

describe("what Approve sends", () => {
  it("a public draft sends every row key and the PRD tick; a standard draft sends only the version", async () => {
    const m = await mounted(draft());
    tickAll();
    script = (method) => (method === "GET" ? draft({ status: "approved" }) : { approved: true, install: { job_id: "j", attempt: 1 }, gate: null, install_error: null });
    on(byId(host, "approve")[0], "click");
    await settle();
    await settle();
    expect(calls.find((c) => c.path.endsWith("/approve")).body).toEqual({ version: 4, reviewed_row_keys: ["A1", "B2"], prd_reviewed: true });
    expect(texts(host)).toContain("Approved. The install has started.");
    m.destroy();
    calls.length = 0;
    host = new FakeEl("div");
    const std = await mounted(draft({}, "standard"));
    script = (method) => (method === "GET" ? draft({}, "standard") : { approved: true, install: { job_id: "j" }, gate: null, install_error: null });
    on(byId(host, "approve")[0], "click");
    await settle();
    expect(calls.find((c) => c.path.endsWith("/approve")).body).toEqual({ version: 4 });
    std.destroy();
  });

  it("a member gets no editing control, and an owner's Start the install sends only the version", async () => {
    await mounted(draft({}, "standard"), env({ isAdmin: () => false }));
    for (const id of ["prd", "save", "approve", "discard", "blank", "restart", "add", "title"]) expect(byId(host, id), id).toHaveLength(0);
    expect(texts(host)).toContain("Only owners and admins can edit or approve the plan.");
    host = new FakeEl("div");
    await mounted(draft({ status: "approved" }, "public"));
    script = (method) => (method === "GET" ? draft({ status: "approved" }) : { approved: true, install: null, gate: null, install_error: { code: "github_unavailable" } });
    on(byId(host, "install")[0], "click");
    await settle();
    await settle();
    expect(calls.at(-2)).toMatchObject({ method: "POST", body: { version: 4 } });
    expect(texts(host).join(" ")).toContain("GitHub couldn't be reached.");
  });
});

describe("the version lock", () => {
  it("a stale save says so; Keep mine keeps the edit on the newer version and Load theirs takes the other", async () => {
    await mounted(draft({}, "standard"));
    on(byId(host, "title")[0], "input", { value: "Mine" });
    script = (method) => { if (method === "PUT") throw failure(409, "draft_conflict", { version: 9 }); return draft({ version: 9, roadmap: [ROW("A1", { title: "Theirs" })] }, "standard"); };
    on(byId(host, "save")[0], "click");
    await settle();
    await settle();
    expect(texts(host)).toContain("This plan changed in another window");
    expect(byId(host, "theirs")).toHaveLength(1);
    expect(disabled(byId(host, "save")[0])).toBe(true);
    on(byId(host, "mine")[0], "click");
    await settle();
    expect(texts(host)).not.toContain("This plan changed in another window");
    script = (method) => (method === "PUT" ? { version: 10 } : {});
    on(byId(host, "save")[0], "click");
    await settle();
    expect(calls.filter((c) => c.method === "PUT").at(-1).body.version).toBe(9);
  });
});
