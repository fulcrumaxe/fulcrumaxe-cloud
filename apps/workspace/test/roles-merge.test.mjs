// apps/workspace/test/roles-merge.test.mjs
//
// D#742: the Roles app's Autonomy "Merging" section. mergeModel is the pure line-building function (no DOM); mergeView renders it with h(),
// checked here against the FakeEl/document stub of test/repos-merge-queue.test.mjs; mountMerge's reads are checked with globalThis.fetch
// stubbed, as test/api-network.test.mjs does. The e2e behaviour (focus order, real routes) is in e2e/roles-autonomy.spec.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// D#742 fix round: the Merging section lives inside roles-autonomy.js (not a file of its own) -- see the comment
// there for why: a new boot-reachable file would push the account-wide static-request budget (build/budget.mjs)
// past its ceiling, which has no headroom left to spend on one.
import { MERGE_COPY, mergeModel, mergeView, mountMerge } from "../apps/roles/roles-autonomy.js";

class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) {
    super();
    this.tag = tag;
    this.attrs = {};
    this.kids = [];
    this.on = {};
    this.className = "";
    this.hidden = false;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  addEventListener(t, f) {
    this.on[t] = f;
  }
  appendChild(c) {
    this.kids.push(c);
    return c;
  }
  replaceChildren(...cs) {
    this.kids = [];
    cs.forEach((c) => this.appendChild(c));
  }
  get textContent() {
    return this.kids.map((k) => (k instanceof FakeEl ? k.textContent : k.text)).join("");
  }
}
const findAll = (el, test, out = []) => (test(el) && out.push(el), el.kids.forEach((k) => k instanceof FakeEl && findAll(k, test, out)), out);
const byId = (root, id) => findAll(root, (e) => e.getAttribute("data-testid") === id);
const rowFor = (root, key) => findAll(root, (e) => e.getAttribute("data-testid") === "merge-row" && e.getAttribute("data-row") === key)[0];

beforeEach(() => {
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("document", { createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }) });
});
afterEach(() => vi.unstubAllGlobals());

const BAD = /null|undefined|NaN|\[object|[a-z]+_[a-z]+/;
const section = (data) => {
  const el = new FakeEl("div");
  el.replaceChildren(...mergeView(mergeModel(data)));
  return el;
};

describe("mergeModel: each line, from its own data, fails closed", () => {
  const SETTINGS = { auto_merge: true, block_external_auto_merge: false, merge_queue: { state: "on" } };

  it("auto-merge: on and off, else unavailable", () => {
    expect(mergeModel({ settings: { ...SETTINGS, auto_merge: true }, roles: null, mode: null }).rows[0]).toMatchObject({ key: "auto-merge", value: "On" });
    expect(mergeModel({ settings: { ...SETTINGS, auto_merge: false }, roles: null, mode: null }).rows[0]).toMatchObject({ key: "auto-merge", value: "Off" });
    for (const bad of [null, {}, { auto_merge: "yes" }, { auto_merge: null }]) {
      expect(mergeModel({ settings: bad, roles: null, mode: null }).rows[0]).toMatchObject({ key: "auto-merge", unavailable: true });
    }
  });

  it("outside contributors' pull requests: blocked and allowed, else unavailable", () => {
    expect(mergeModel({ settings: { ...SETTINGS, block_external_auto_merge: true }, roles: null, mode: null }).rows[1]).toMatchObject({ value: "Never merged automatically" });
    expect(mergeModel({ settings: { ...SETTINGS, block_external_auto_merge: false }, roles: null, mode: null }).rows[1]).toMatchObject({ value: "May be merged automatically" });
    expect(mergeModel({ settings: { auto_merge: true }, roles: null, mode: null }).rows[1]).toMatchObject({ unavailable: true });
  });

  it.each([
    ["on", MERGE_COPY.mergeQueue.on],
    ["off", MERGE_COPY.mergeQueue.off],
    ["runner", MERGE_COPY.mergeQueue.runner],
  ])("merge queue state %j shows its own phrase", (state, phrase) => {
    expect(mergeModel({ settings: { ...SETTINGS, merge_queue: { state } }, roles: null, mode: null }).rows[2]).toMatchObject({ value: phrase, where: MERGE_COPY.mergeQueue.where });
  });

  it("merge queue: not_installed, unreadable, missing or a non-object merge_queue all read unavailable, and the pointer names GitHub, not Repos", () => {
    for (const mq of [undefined, null, {}, { state: "not_installed" }, { state: "unreadable" }, { state: "ON" }, "on"]) {
      expect(mergeModel({ settings: { ...SETTINGS, merge_queue: mq }, roles: null, mode: null }).rows[2]).toMatchObject({ unavailable: true });
    }
    expect(MERGE_COPY.mergeQueue.where).toMatch(/GitHub/);
    expect(MERGE_COPY.mergeQueue.where).not.toMatch(/Repos/);
  });

  it.each([
    ["off", MERGE_COPY.debater.off],
    ["feature_critical", MERGE_COPY.debater.feature_critical],
    ["always", MERGE_COPY.debater.always],
  ])("debater mode %j shows its own phrase, and the raw value never appears", (mode, phrase) => {
    const model = mergeModel({ settings: null, roles: [{ role: "debater", mode }], mode: null });
    expect(model.rows[3]).toMatchObject({ value: phrase, where: "Change this in the Roles tab." });
    expect(phrase).not.toBe(mode);
  });

  it("debater: no entry, an odd mode, or a non-array roles answer all read unavailable, never 'off'", () => {
    for (const roles of [[], [{ role: "build", mode: "auto" }], [{ role: "debater", mode: "sometimes" }], [{ role: "debater" }], null, {}, "x"]) {
      const row = mergeModel({ settings: null, roles, mode: null }).rows[3];
      expect(row).toMatchObject({ unavailable: true });
      expect(row.value).toBeUndefined();
    }
  });

  it("reviews on your machine: present only for runner_local, on/off from auto_merge", () => {
    expect(mergeModel({ settings: null, roles: null, mode: { execution_mode: "runner_local", auto_merge: true } }).rows).toHaveLength(5);
    expect(mergeModel({ settings: null, roles: null, mode: { execution_mode: "runner_local", auto_merge: true } }).rows[4]).toMatchObject({ key: "local-review", value: "On" });
    expect(mergeModel({ settings: null, roles: null, mode: { execution_mode: "runner_local", auto_merge: false } }).rows[4]).toMatchObject({ value: "Off" });
  });

  it("reviews on your machine: absent (not unavailable) for sandbox, runner_verified, a failed read or an unknown shape", () => {
    for (const mode of [null, { execution_mode: "sandbox", auto_merge: false }, { execution_mode: "runner_verified", auto_merge: true }, { execution_mode: "runner_local" }, { auto_merge: true }, {}]) {
      const rows = mergeModel({ settings: null, roles: null, mode }).rows;
      expect(rows).toHaveLength(4);
      expect(rows.some((r) => r.key === "local-review")).toBe(false);
    }
  });
});

describe("human_merge_only: the lock marks every line, hides none", () => {
  const DATA = { settings: { auto_merge: true, block_external_auto_merge: true, merge_queue: { state: "off" }, human_merge_only: true }, roles: [{ role: "debater", mode: "always" }], mode: { execution_mode: "runner_local", auto_merge: true } };

  it("locked === true only on settings.human_merge_only === true (strict)", () => {
    expect(mergeModel(DATA).locked).toBe(true);
    const withoutLock = { ...DATA.settings };
    delete withoutLock.human_merge_only;
    for (const settings of [{ ...withoutLock, human_merge_only: false }, { ...withoutLock, human_merge_only: "true" }, { ...withoutLock, human_merge_only: 1 }, withoutLock]) {
      expect(mergeModel({ ...DATA, settings }).locked).toBe(false);
    }
  });

  it("every row is marked not in effect, with real values, and none is dropped", () => {
    const model = mergeModel(DATA);
    expect(model.rows).toHaveLength(5);
    expect(model.rows.every((r) => r.inEffect === false)).toBe(true);
    expect(model.rows.map((r) => r.value)).toEqual(["On", "Never merged automatically", "Off", "On for every pull request", "On"]);
  });

  it("unlocked rows carry no not-in-effect marker", () => {
    const model = mergeModel({ ...DATA, settings: { ...DATA.settings, human_merge_only: false } });
    expect(model.locked).toBe(false);
    expect(model.rows.every((r) => r.inEffect === true)).toBe(true);
  });
});

describe("one failed read leaves the others alone", () => {
  it("a failed settings read leaves debater and the local-review line", () => {
    const model = mergeModel({ settings: null, roles: [{ role: "debater", mode: "feature_critical" }], mode: { execution_mode: "runner_local", auto_merge: false } });
    expect(model.rows.filter((r) => r.unavailable).map((r) => r.key)).toEqual(["auto-merge", "external-guard", "merge-queue"]);
    expect(model.rows.find((r) => r.key === "debater")).toMatchObject({ value: MERGE_COPY.debater.feature_critical });
    expect(model.rows.find((r) => r.key === "local-review")).toMatchObject({ value: "Off" });
  });

  it("a failed roles read leaves auto-merge, the guard, the queue and the local-review line", () => {
    const model = mergeModel({ settings: { auto_merge: false, block_external_auto_merge: false, merge_queue: { state: "runner" } }, roles: null, mode: { execution_mode: "runner_local", auto_merge: true } });
    expect(model.rows.find((r) => r.key === "debater")).toMatchObject({ unavailable: true });
    expect(model.rows.filter((r) => !r.unavailable).map((r) => r.key)).toEqual(["auto-merge", "external-guard", "merge-queue", "local-review"]);
  });
});

describe("rendering: the heading, intro, pointer and locked line are MERGE_COPY, and no forbidden text leaks", () => {
  it("renders the intro, the pointer and each row's name, value and pointer as plain text", () => {
    const el = section({ settings: { auto_merge: true, block_external_auto_merge: true, merge_queue: { state: "on" } }, roles: [{ role: "debater", mode: "off" }], mode: { execution_mode: "runner_local", auto_merge: false } });
    expect(byId(el, "merge-intro")[0].textContent).toBe(MERGE_COPY.intro);
    expect(byId(el, "merge-pointer")[0].textContent).toBe(MERGE_COPY.pipelinePointer);
    expect(el.textContent).toContain("these are this repository's own settings".replace("these", "These"));
    const row = rowFor(el, "auto-merge");
    expect(row.textContent).toContain(MERGE_COPY.autoMerge.name);
    expect(row.textContent).toContain("On");
    expect(row.textContent).toContain(MERGE_COPY.autoMerge.where);
    expect(byId(el, "merge-locked")).toHaveLength(0);
  });

  it("the locked line renders first, names the operator, and every other row still carries its real value plus the marker", () => {
    const el = section({ settings: { auto_merge: true, block_external_auto_merge: false, merge_queue: { state: "off" }, human_merge_only: true }, roles: [{ role: "debater", mode: "always" }], mode: null });
    const locked = byId(el, "merge-locked")[0];
    expect(locked.textContent).toContain(MERGE_COPY.lockedHeading);
    expect(locked.textContent).toContain(MERGE_COPY.lockedLine);
    const rows = byId(el, "merge-rows")[0];
    expect(rows.kids[0]).toBe(locked);
    const autoMerge = rowFor(el, "auto-merge");
    expect(autoMerge.getAttribute("data-in-effect")).toBe("false");
    expect(autoMerge.textContent).toContain("On");
    expect(autoMerge.textContent).toContain(MERGE_COPY.notInEffect);
  });

  it("an unavailable line shows only the name and the fixed unavailable sentence", () => {
    const el = section({ settings: null, roles: null, mode: null });
    const row = rowFor(el, "auto-merge");
    expect(row.textContent).toBe(MERGE_COPY.autoMerge.name + MERGE_COPY.unavailable);
  });

  it("no state renders null, undefined, NaN, [object or a raw snake_case value", () => {
    const cases = [
      { settings: null, roles: null, mode: null },
      { settings: {}, roles: [], mode: {} },
      { settings: { auto_merge: true, block_external_auto_merge: true, merge_queue: { state: "runner" }, human_merge_only: true }, roles: [{ role: "debater", mode: "off" }], mode: { execution_mode: "runner_local", auto_merge: true } },
      { settings: { auto_merge: false, block_external_auto_merge: false, merge_queue: {} }, roles: [{ role: "debater", mode: "always" }], mode: { execution_mode: "sandbox", auto_merge: true } },
      { settings: { auto_merge: true, block_external_auto_merge: true, merge_queue: { state: "not_installed" } }, roles: [{ role: "debater", mode: "feature_critical" }], mode: { execution_mode: "runner_verified", auto_merge: false } },
    ];
    for (const data of cases) expect(section(data).textContent, JSON.stringify(data)).not.toMatch(BAD);
    for (const v of [...Object.values(MERGE_COPY).filter((v) => typeof v === "string"), ...Object.values(MERGE_COPY.autoMerge), ...Object.values(MERGE_COPY.externalGuard), ...Object.values(MERGE_COPY.mergeQueue), ...Object.values(MERGE_COPY.debater), ...Object.values(MERGE_COPY.localReview)]) {
      expect(v).not.toMatch(BAD);
    }
  });

  it("no interactive element and no click handler anywhere in the section", () => {
    const el = section({ settings: { auto_merge: true, block_external_auto_merge: true, merge_queue: { state: "on" }, human_merge_only: true }, roles: [{ role: "debater", mode: "always" }], mode: { execution_mode: "runner_local", auto_merge: true } });
    const interactive = findAll(el, (e) => ["button", "input", "select", "textarea", "a"].includes(e.tag) || e.getAttribute("tabindex") !== null);
    expect(interactive).toHaveLength(0);
    expect(findAll(el, (e) => typeof e.on.click === "function")).toHaveLength(0);
  });
});

describe("mountMerge: reads, loading, repo switches and the unchanged-repo no-op", () => {
  const SETTINGS = { auto_merge: true, block_external_auto_merge: false, merge_queue: { state: "on" } };
  const ROLES = { data: [{ role: "debater", mode: "feature_critical" }] };
  const MODE = { execution_mode: "sandbox", auto_merge: false };
  const bodyOf = (host) => byId(host, "merge-body")[0];
  const reply = (body, status = 200) => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const bodyFor = (url) => (url.endsWith("/settings") ? SETTINGS : url.endsWith("/roles") ? ROLES : MODE);

  function pendingFetch() {
    const calls = [];
    const fn = vi.fn((url, init) => new Promise((resolve, reject) => calls.push({ url, init, resolve, reject })));
    return { fn, calls };
  }

  beforeEach(() => vi.stubGlobal("AbortController", globalThis.AbortController));

  it("shows the loading line with no rows while the three reads are in flight, then one single render with every row", async () => {
    const host = new FakeEl("div");
    const { fn, calls } = pendingFetch();
    vi.stubGlobal("fetch", fn);
    const merge = mountMerge(host);
    const p = merge.load("r1");
    expect(byId(host, "merge-loading")).toHaveLength(1);
    expect(byId(host, "merge-rows")).toHaveLength(0);
    expect(calls).toHaveLength(3);
    for (const c of calls) c.resolve(reply(bodyFor(c.url)));
    await p;
    expect(byId(host, "merge-loading")).toHaveLength(0);
    expect(byId(host, "merge-row").length).toBeGreaterThan(0);
    expect(host.hidden).toBe(false);
  });

  it("switching repos aborts the previous repo's reads and drops a late answer for it", async () => {
    const host = new FakeEl("div");
    const { fn, calls } = pendingFetch();
    vi.stubGlobal("fetch", fn);
    const merge = mountMerge(host);
    const p1 = merge.load("r1");
    expect(calls).toHaveLength(3);
    const r1 = calls.splice(0, 3);
    const p2 = merge.load("r2");
    expect(r1.every((c) => c.init.signal.aborted)).toBe(true);
    await p1; // dropped: readAll sees a stale seq and returns without rendering
    expect(byId(host, "merge-loading")).toHaveLength(1); // r2's reads are still in flight
    expect(calls).toHaveLength(3);
    const r2 = calls.splice(0, 3);
    for (const c of r2) c.resolve(reply(bodyFor(c.url)));
    await p2;
    expect(byId(host, "merge-loading")).toHaveLength(0);
    expect(byId(host, "merge-row").length).toBeGreaterThan(0);
    // r1's reply, if it ever arrived, changed nothing: resolving it now has no observable effect.
    for (const c of r1) c.resolve(reply(bodyFor(c.url)));
    await Promise.resolve();
    expect(byId(host, "merge-loading")).toHaveLength(0);
  });

  it("load() with the repo already loaded and unchanged issues no new request", async () => {
    const host = new FakeEl("div");
    const { fn, calls } = pendingFetch();
    vi.stubGlobal("fetch", fn);
    const merge = mountMerge(host);
    const p = merge.load("r1");
    for (const c of calls) c.resolve(reply(bodyFor(c.url)));
    await p;
    calls.length = 0;
    fn.mockClear();
    await merge.load("r1");
    expect(fn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("clear() hides and empties the section; destroy() leaves nothing behind", async () => {
    const host = new FakeEl("div");
    const { fn, calls } = pendingFetch();
    vi.stubGlobal("fetch", fn);
    const merge = mountMerge(host);
    const p = merge.load("r1");
    for (const c of calls) c.resolve(reply(bodyFor(c.url)));
    await p;
    merge.clear();
    expect(host.hidden).toBe(true);
    expect(bodyOf(host).kids).toHaveLength(0);
    merge.destroy();
    expect(host.kids).toHaveLength(0);
  });
});
