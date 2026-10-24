// apps/workspace/test/memory-undo.test.mjs
//
// D#601 MEM-4b3: the Memory app's undo, delete and restore, history and export, data side and pure rules, against the routes' committed fixtures.
// The DOM behaviour (toast, buttons, panels, at desktop and phone width) is in e2e/memory-undo.spec.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiFailure } from "../apps/_lib/api.js";
import { mountToasts } from "../apps/memory/memory-queue.js";
import {
  COPY, buildExport, daysLeft, decidedWords, deleteEntry, failureWords, loadHistory, omittedWords, restoreEntry, restorePrevious, revertEntries, rowActions,
} from "../apps/memory/memory-storage.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const V1 = join(HERE, "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const DAY = 86400000;

function fakeGet(reply) {
  const calls = [];
  const get = async (method, url, body) => {
    calls.push(method + " " + url + (body === undefined ? "" : " " + JSON.stringify(body)));
    return structuredClone(reply(method, url, body));
  };
  get.calls = calls;
  return get;
}
const ID = "2b9c3f40-5d6e-4f70-8182-93a40526c7d8";

describe("the calls go to the routes with the body the route takes", () => {
  it("revert, delete, restore and restore-previous", async () => {
    const get = fakeGet((m, u) => (u.endsWith("/revert") ? fx("revertMemory", "200-ok.json") : fx("deleteMemory", "200-deleted.json")));
    await revertEntries([ID, "x"], "undo_approve", get);
    await deleteEntry(ID, get);
    await restoreEntry(ID, get);
    await restorePrevious(ID, get);
    expect(get.calls).toEqual([
      `POST /api/v1/memory/revert {"ids":["${ID}","x"],"action":"undo_approve"}`,
      `POST /api/v1/memory/${ID}/delete`,
      `POST /api/v1/memory/${ID}/restore`,
      `POST /api/v1/memory/${ID}/restore-previous`,
    ]);
  });

  it("history keeps the fixed labels and who did it, and reads empty versions after a purge", async () => {
    const full = await loadHistory(ID, fakeGet(() => fx("getMemoryHistory", "200-ok.json")));
    expect(full.events.map((e) => [e.label, e.actor])).toEqual([["Proposed", "The pipeline"], ["Approved", "A member"]]);
    expect(full.versions).toHaveLength(1);
    const purged = await loadHistory(ID, fakeGet(() => ({ events: fx("getMemoryHistory", "200-ok.json").events, versions: [] })));
    expect(purged.events).toHaveLength(2);
    expect(purged.versions).toEqual([]);
    expect(JSON.stringify([...full.events, ...purged.events])).not.toMatch(/null|undefined/);
    expect(await loadHistory(ID, fakeGet(() => ({})))).toEqual({ events: [], versions: [] });
  });

  it("export asks for the repo and the style, and the omitted count is a number, never null", async () => {
    const get = fakeGet(() => fx("exportMemory", "200-ok.json"));
    const d = await buildExport("r1", "claude", get);
    expect(get.calls).toEqual(["GET /api/v1/memory/export?repo_id=r1&format=claude"]);
    expect(d).toMatchObject({ filename: "AGENTS.md", entries: 1, omitted: 0 });
    expect(d.content).toContain("Run the unit tests");
    expect((await buildExport("r1", "agents", fakeGet(() => ({ content: "x", omitted: null })))).omitted).toBe(0);
  });
});

describe("days left to restore a deleted entry, from its deleted_at", () => {
  const now = Date.parse("2026-10-23T12:00:00.000Z");
  const ago = (d) => new Date(now - d * DAY).toISOString();
  it("counts down from 30, rounds up inside the window, and is 0 once over", () => {
    expect(daysLeft(ago(0), now)).toBe(30);
    expect(daysLeft(ago(1), now)).toBe(29);
    expect(daysLeft(ago(29), now)).toBe(1);
    expect(daysLeft(ago(29.5), now)).toBe(1);
    expect(daysLeft(ago(30), now)).toBe(0);
    expect(daysLeft(ago(31), now)).toBe(0);
  });
  it("is null when there is no usable time", () => {
    for (const v of [null, undefined, "", "soon", 5]) expect(daysLeft(v, now)).toBeNull();
  });
  it("a restored-then-deleted-again entry carries its new deleted_at, so it reads 30 again", () => {
    expect(daysLeft(ago(20), now)).toBe(10);
    expect(daysLeft(ago(0), now)).toBe(30);
  });
});

describe("what a row offers: every disabled action has its reason", () => {
  const row = (status, extra = {}) => ({ status, scope: "repo", version: 1, ...extra });
  const keys = (r, o) => rowActions(r, o).map((a) => a.key);
  const admin = { isAdmin: true };

  it("one set of actions per status", () => {
    expect(keys(row("approved", { version: 2 }), admin)).toEqual(["retire", "restore_previous", "delete"]);
    expect(keys(row("rejected"), admin)).toEqual(["reconsider", "delete"]);
    expect(keys(row("expired"), admin)).toEqual(["renew", "delete"]);
    expect(keys(row("retired"), admin)).toEqual(["restore_retired", "delete"]);
    expect(keys(row("proposed"), admin)).toEqual(["delete"]);
    expect(keys(row("deleted", { deleted_at: new Date().toISOString() }), admin)).toEqual(["restore"]);
    expect(keys(row("archived"), admin)).toEqual([]);
    expect(keys(row("superseded"), admin)).toEqual([]);
  });

  it("restore previous is disabled with its reason when there is no earlier version", () => {
    const a = rowActions(row("approved", { version: 1 }), admin).find((x) => x.key === "restore_previous");
    expect(a).toMatchObject({ enabled: false, reason: COPY.noEarlier });
    expect(rowActions(row("approved", { version: 3 }), admin).find((x) => x.key === "restore_previous")).toMatchObject({ enabled: true, reason: "" });
  });

  it("a deleted entry shows its days left, plain Restore without a time, or says it is too old", () => {
    const now = Date.parse("2026-10-23T12:00:00.000Z");
    const at = (d) => ({ deleted_at: new Date(now - d * DAY).toISOString() });
    expect(rowActions(row("deleted", at(27)), { ...admin, now })[0]).toMatchObject({ label: "Restore (3 days left)", enabled: true });
    expect(rowActions(row("deleted", at(29)), { ...admin, now })[0].label).toBe("Restore (1 day left)");
    expect(rowActions(row("deleted", { deleted_at: null }), { ...admin, now })[0]).toMatchObject({ label: "Restore", enabled: true });
    expect(rowActions(row("deleted", at(31)), { ...admin, now })[0]).toMatchObject({ enabled: false, reason: COPY.tooOld });
  });

  it("while access is checked, or if the check failed, every action is off with its own sentence", () => {
    const r = row("approved", { version: 2 });
    for (const a of rowActions(r, { isAdmin: false, access: "checking" })) expect(a).toMatchObject({ enabled: false, reason: "Checking your access…" });
    for (const a of rowActions(r, { isAdmin: true, access: "failed" })) expect(a).toMatchObject({ enabled: false, reason: COPY.accessFailed });
    for (const a of rowActions({ ...r, scope: "item" }, { isAdmin: false, access: "checking" })) expect(a.enabled).toBe(false);
  });

  it("a member cannot act on repo, account or role memory, and says why; item memory is left to the route", () => {
    for (const scope of ["repo", "account", "role"]) for (const a of rowActions(row("approved", { scope, version: 2 }), { isAdmin: false })) expect(a, scope).toMatchObject({ enabled: false, reason: COPY.noRights });
    for (const a of rowActions(row("approved", { scope: "item", version: 2 }), { isAdmin: false })) expect(a.enabled).toBe(true);
  });

  it("no action in any state has a label or reason that reads null or undefined", () => {
    for (const status of ["proposed", "approved", "rejected", "expired", "retired", "deleted", "archived", "superseded"]) {
      for (const o of [{ isAdmin: true }, { isAdmin: false }, { access: "checking" }, { access: "failed" }]) {
        expect(JSON.stringify(rowActions(row(status), o))).not.toMatch(/null|undefined|NaN/);
      }
    }
  });
});

describe("the words", () => {
  it("a stale Undo, a full place and a changed entry each have a fixed sentence", () => {
    const stale = new ApiFailure(422, "invalid_transition", "request failed validation");
    expect(failureWords(stale)).toBe(COPY.transition);
    expect(failureWords(new ApiFailure(422, "memory_full", "request failed validation"))).toBe(COPY.full);
    expect(COPY.changedSince).toMatch(/changed/);
    for (const w of Object.values(COPY)) expect(w).not.toMatch(/null|undefined/);
  });
  it("omitted and decided counts read in plain words", () => {
    expect(omittedWords(1)).toBe("1 entry was left out because it looks like it holds a secret.");
    expect(omittedWords(3)).toBe("3 entries were left out because they look like they hold a secret.");
    expect(decidedWords("approved", 1)).toBe("Approved 1 card.");
    expect(decidedWords("approved", 4)).toBe("Approved 4 cards.");
    expect(decidedWords("rejected", 2)).toBe("Rejected 2 cards.");
  });
});

// ── the toast module, on a tiny stand-in for the DOM (the vitest environment here is node) and a clock the test drives ──
class FakeNode {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.parent = null; this.textContent = ""; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(ev, fn) { this.listeners[ev] = fn; }
  click() { return this.listeners.click && this.listeners.click(); }
  find(testid) { const out = []; const walk = (n) => { if (n.attrs["data-testid"] === testid) out.push(n); n.children.forEach(walk); }; walk(this); return out; }
}
class FakeText extends FakeNode { constructor(t) { super("#text"); this.textContent = t; } }

describe("the Undo toasts", () => {
  let saved;
  beforeEach(() => {
    saved = { document: globalThis.document, Node: globalThis.Node };
    globalThis.Node = FakeNode;
    globalThis.document = { createElement: (t) => new FakeNode(t), createTextNode: (t) => new FakeText(t) };
  });
  afterEach(() => { globalThis.document = saved.document; globalThis.Node = saved.Node; });

  function rig() {
    let now = 0;
    const timers = new Map();
    let nextId = 1;
    const clock = { now: () => now, set: (f, ms) => (timers.set(nextId, { f, at: now + ms }), nextId++), clear: (id) => timers.delete(id) };
    const advance = (ms) => { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.f(); } };
    const host = new FakeNode("div");
    return { host, toasts: mountToasts(host, { ms: 30000, clock }), advance, setNow: (n) => (now = n), timers };
  }
  const undoOk = () => Promise.resolve({ ok: true, message: "Done." });

  it("offers Undo for 30 seconds, then takes the toast off the page", () => {
    const { host, toasts, advance } = rig();
    toasts.show({ message: "Approved 1 card.", onUndo: undoOk });
    expect(host.find("mem-undo")).toHaveLength(1);
    advance(29999);
    expect(host.find("mem-undo")).toHaveLength(1);
    advance(1);
    expect(host.find("mem-toast")).toHaveLength(0);
  });

  it("an Undo click runs the call once, shows its words, drops the button and stops the 30 second timer", async () => {
    const { host, toasts, advance, timers } = rig();
    let calls = 0;
    toasts.show({ message: "m", onUndo: async () => (calls++, { ok: true, message: "Put back." }) });
    const btn = host.find("mem-undo")[0];
    const p1 = btn.click();
    btn.click(); // a second click while it runs does nothing
    await p1;
    expect(calls).toBe(1);
    expect(host.find("mem-toast-text")[0].textContent).toBe("Put back.");
    expect(host.find("mem-undo")).toHaveLength(0);
    expect(timers.size).toBe(1); // only the short note timer is left
    advance(8000);
    expect(host.find("mem-toast")).toHaveLength(0);
  });

  it("a slow Undo keeps its toast past 30 seconds and still shows its answer", async () => {
    const { host, toasts, advance } = rig();
    let finish;
    toasts.show({ message: "m", onUndo: () => new Promise((r) => (finish = r)) });
    const p = host.find("mem-undo")[0].click();
    advance(40000);
    expect(host.find("mem-toast")).toHaveLength(1);
    finish({ ok: false, message: "That entry has already changed." });
    await p;
    expect(host.find("mem-toast-text")[0].textContent).toBe("That entry has already changed.");
  });

  it("a late click (the timer ran late) removes the toast without calling Undo", async () => {
    const { host, toasts, setNow } = rig();
    let calls = 0;
    toasts.show({ message: "m", onUndo: async () => (calls++, { ok: true, message: "x" }) });
    const btn = host.find("mem-undo")[0];
    setNow(31000); // time passed but the timer has not fired yet
    await btn.click();
    expect(calls).toBe(0);
    expect(host.find("mem-toast")).toHaveLength(0);
  });

  it("never pushes out a toast whose Undo is live; only finished notes make room", () => {
    const { host, toasts } = rig();
    for (let i = 0; i < 5; i++) toasts.show({ message: "n" + i, onUndo: undoOk });
    expect(host.find("mem-undo")).toHaveLength(5);
    toasts.show({ message: "a note" });
    toasts.show({ message: "another note" });
    expect(host.find("mem-undo")).toHaveLength(5);
    expect(host.find("mem-toast").length).toBeLessThanOrEqual(6);
  });
});
