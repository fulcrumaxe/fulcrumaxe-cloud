// apps/workspace/test/onboarding-picker-confirm.test.mjs
//
// The picker's Confirm button, clicked the way a browser clicks it (the listener gets the click Event as its argument), against a small stand-in for the DOM calls the picker makes
// (there is no jsdom in this package). A refusal for an unknown load must show "Checking the machine…" and send the same place request again; any other refusal must not.

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = [];
let placeAnswers = [];
vi.mock("../apps/_lib/api.js", () => {
  class ApiFailure extends Error {
    constructor(status, code, message, reason) { super(message); this.status = status; this.code = code; if (reason) this.reason = reason; }
  }
  const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  return {
    ApiFailure,
    api: async (method, path, body) => {
      calls.push({ method, path, body });
      if (path === "/api/runners/repos/picker") return { repos: [{ id: "11111111-1111-4111-8111-111111111111", name: "acme/api", visibility: "private", active_preset: "balanced" }], owners: [] };
      if (path === "/api/runners") return { runners: [{ id: M1, name: "box", state: "online_idle", facts: { engine: "microvm" } }] };
      if (path === "/api/machines") return { machines: [{ id: M1, name: "box", tier: "microvm", live: true, running: null }] };
      if (path === "/api/v1/engine/settings") return { watch_enabled: true, operate_enabled: false, can_edit: true, repos: [] };
      if (method === "GET" && /^\/api\/v1\/repos\/[^/]+\/twin$/.test(path)) throw new ApiFailure(503, "not_configured", "SERVER WORDS"); // twins off: the picker's twin card draws nothing
      if (method === "POST" && path.endsWith("/place")) {
        const next = placeAnswers.shift();
        if (next) throw new ApiFailure(next.status, next.code, "SERVER WORDS", next.reason);
        return {};
      }
      throw new Error("unexpected " + method + " " + path);
    },
  };
});

class FakeNode {}
class FakeText extends FakeNode { constructor(t) { super(); this.text = t; } }
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ""; }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...n) { this.children = n.map((x) => (x instanceof FakeNode ? x : new FakeText(String(x)))); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, f) { this.listeners[t] = f; }
  get textContent() { return this.children.map((c) => (c instanceof FakeText ? c.text : c.textContent)).join(""); }
  find(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) if (c instanceof FakeEl) c.find(pred, out); return out; }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeEl(t), createTextNode: (t) => new FakeText(t) };

const { mountProjectPicker } = await import("../apps/onboarding/onboarding-engine.js");

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(fn) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await tick(); }
  throw new Error("timed out");
}

function mount(wait, extra = {}) {
  const host = { root: null, replaceChildren(...n) { this.root = n[0] ?? null; }, querySelector: () => null };
  const waits = [];
  const env = { ...extra, signal: undefined, search: "", clearReturn() {}, announce() {}, canOpen: () => false, openApp() {}, onPlaced() {}, wait: wait ?? ((ms) => { waits.push(ms); return Promise.resolve(); }) };
  const picker = mountProjectPicker(host, env);
  const byId = (id) => host.root?.find((e) => e.attrs["data-testid"] === id)[0];
  const click = (id) => byId(id).listeners.click({ type: "click", isTrusted: true });
  return { host, waits, picker, byId, click };
}
const places = () => calls.filter((c) => c.path.endsWith("/place"));

beforeEach(() => { calls.length = 0; placeAnswers = []; });

describe("Confirm in the project picker, clicked with a real event", () => {
  it("an unknown load shows 'Checking the machine…', waits, and sends the same place request again until it is placed", async () => {
    placeAnswers = [{ status: 409, code: "machine_not_eligible", reason: "load_unknown" }, { status: 409, code: "machine_not_eligible", reason: "load_unknown" }];
    const m = mount();
    await until(() => m.byId("ob-pick-repo"));
    m.click("ob-pick-repo");
    await until(() => m.byId("ob-pick-confirm"));
    m.click("ob-pick-confirm");
    await until(() => places().length === 3);
    expect(m.waits).toEqual([8000, 8000]);
    await until(() => m.byId("ob-pick-placed"));
    expect(places().every((c) => JSON.stringify(c.body) === JSON.stringify(places()[0].body))).toBe(true);
    expect(m.host.root.textContent).not.toMatch(/Checking the machine|SERVER WORDS/);
  });

  it("while it waits the button says 'Checking the machine…' and the note is shown", async () => {
    placeAnswers = [{ status: 409, code: "machine_not_eligible", reason: "load_unknown" }];
    let release;
    const m = mount(() => new Promise((r) => { release = r; }));
    await until(() => m.byId("ob-pick-repo"));
    m.click("ob-pick-repo");
    await until(() => m.byId("ob-pick-confirm"));
    m.click("ob-pick-confirm");
    await until(() => m.byId("ob-pick-note"));
    expect(m.byId("ob-pick-note").textContent).toBe("Checking the machine…");
    expect(m.byId("ob-pick-confirm").textContent).toBe("Checking the machine…");
    expect(m.byId("ob-pick-error")).toBeUndefined();
    release();
    await until(() => m.byId("ob-pick-placed"));
    expect(places()).toHaveLength(2);
  });

  it("a refusal for any other reason is not asked again and shows its own sentence", async () => {
    placeAnswers = [{ status: 409, code: "machine_not_eligible", reason: "low_disk" }];
    const m = mount();
    await until(() => m.byId("ob-pick-repo"));
    m.click("ob-pick-repo");
    await until(() => m.byId("ob-pick-confirm"));
    m.click("ob-pick-confirm");
    await until(() => m.byId("ob-pick-error"));
    expect(m.byId("ob-pick-error").textContent).toMatch(/less than 10 GB of free disk/);
    expect(places()).toHaveLength(1);
    expect(m.waits).toEqual([]);
  });

  it("a machine that never reports is asked 5 times in all, then the load_unknown sentence shows", async () => {
    placeAnswers = Array.from({ length: 9 }, () => ({ status: 409, code: "machine_not_eligible", reason: "load_unknown" }));
    const m = mount();
    await until(() => m.byId("ob-pick-repo"));
    m.click("ob-pick-repo");
    await until(() => m.byId("ob-pick-confirm"));
    m.click("ob-pick-confirm");
    await until(() => m.byId("ob-pick-error"));
    expect(places()).toHaveLength(5);
    expect(m.byId("ob-pick-error").textContent).toMatch(/hasn't reported its free memory and disk yet/);
    expect(m.byId("ob-pick-note")).toBeUndefined();
  });
});

describe("a repo another app asked for (D#845 ON-14c)", () => {
  const R1 = "11111111-1111-4111-8111-111111111111";
  const asked = (id) => { const st = { id, done: false }; return { wanted: () => (st.done ? "" : st.id), wantedDone: () => { st.done = true; }, st }; };
  it("opens on the confirm step for that repo when this read lists it, and asks for it once", async () => {
    const a = asked(R1);
    const m = mount(undefined, a);
    await until(() => m.byId("ob-pick-confirm"));
    expect(m.host.root.textContent).toContain("acme/api");
    expect(a.st.done).toBe(true);
    expect(places()).toHaveLength(0); // nothing is sent until Confirm
  });
  it("an id the read does not list is ignored: the list shows", async () => {
    const a = asked("99999999-9999-4999-8999-999999999999");
    const m = mount(undefined, a);
    await until(() => m.byId("ob-pick-repo"));
    expect(m.byId("ob-pick-confirm")).toBeUndefined();
    expect(a.st.done).toBe(false);
  });
  it("preselect() on an open list picks the repo, and does nothing once a repo is being confirmed", async () => {
    const a = asked("");
    const m = mount(undefined, a);
    await until(() => m.byId("ob-pick-repo"));
    a.st.id = R1;
    m.picker.preselect();
    await until(() => m.byId("ob-pick-confirm"));
    m.picker.preselect();
    expect(a.st.done).toBe(true);
  });
});
