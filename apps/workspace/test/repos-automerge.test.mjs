// apps/workspace/test/repos-automerge.test.mjs
//
// D#6 R2b: the Repos app's "Merge after reviews on your machine" control, state by state. The decisions are in autoMergeModel and the
// controller (no DOM); the DOM wiring is driven in the browser by e2e/repos-automerge.spec.ts. The vitest environment is node.
import { describe, expect, it, vi } from "vitest";
import { autoMergeModel, autoMergeRefusal, createAutoMergeController, createModeController, modeUrl, readAutoMerge } from "../apps/repos/repos-runners.js";

const REPO = "99999999-9999-4999-8999-999999999999";
const NAME = "Acme/widgets";
const HASH = "ab".repeat(32);
const AM_HASH = "ef".repeat(32);
const MODE_KEYS = ["title", "sandbox", "sandboxHelp", "localOnly", "localOnlyHelp", "cloudVerified", "cloudVerifiedHelp", "keyRequired", "keyRequiredWhy", "typeName", "apply", "cancel", "saving", "saved", "leaveCancels", "adminOnly", "saveFailed", "nameMismatch", "copyChanged", "keyGone", "publicRepo", "visibilityUnknown"];
const AM_KEYS = ["autoMergeWording", "autoMergeTitle", "autoMergeIsOn", "autoMergeIsOff", "autoMergeTurnOn", "autoMergeTurnOff", "autoMergeSavedOn", "autoMergeSavedOff", "autoMergeHumanOnly", "autoMergeNotLocal"];
const COPY = Object.fromEntries([...MODE_KEYS, ...AM_KEYS].map((k) => [k, "copy:" + k]));
const body = (over = {}) => ({ repo_id: REPO, execution_mode: "runner_local", full_name: NAME, key_required: false, copy_sha256: HASH, auto_merge: false, auto_merge_copy_sha256: AM_HASH, can_change: true, copy: COPY, ...over });
const fail = (status, code) => Object.assign(new Error("server text that must never be shown"), { status, code });

/** A call() that answers by method; a function value is called each time, an Error is thrown. */
function fakeCall(routes) {
  const log = [];
  const call = vi.fn(async (method, path, b) => {
    log.push([method, path, b]);
    const r = routes[method];
    const v = typeof r === "function" ? r(b) : r;
    if (v instanceof Error) throw v;
    return v;
  });
  call.log = log;
  return call;
}
const posts = (call) => call.log.filter((a) => a[0] === "POST");
async function ready(over = {}, routes = {}) {
  const call = fakeCall({ GET: body(over), ...routes });
  const ctl = createAutoMergeController({ call, repoId: REPO });
  await ctl.load();
  return { call, ctl };
}
const model = (ctl) => autoMergeModel(ctl.state);
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("what is shown for which repo", () => {
  it("is hidden before the answer and after a failed read (the picker above says so), not an empty fieldset of words", async () => {
    const pending = createAutoMergeController({ call: fakeCall({ GET: body() }), repoId: REPO });
    expect(model(pending).kind).toBe("hidden");
    const ctl = createAutoMergeController({ call: fakeCall({ GET: fail(500, "internal") }), repoId: REPO });
    await ctl.load();
    expect(model(ctl).kind).toBe("hidden");
  });
  it("is hidden for a sandbox repo and for a cloud-verified repo", async () => {
    for (const execution_mode of ["sandbox", "runner_verified"]) {
      const { ctl } = await ready({ execution_mode });
      expect(model(ctl).kind, execution_mode).toBe("hidden");
    }
  });
  it("is shown for a local-only repo: off, with the server's exact wording and a way to turn it on", async () => {
    const { ctl } = await ready();
    expect(model(ctl)).toMatchObject({ kind: "ready", on: false, locked: false, statusText: "copy:autoMergeIsOff", wording: "copy:autoMergeWording", canTurnOn: true, canTurnOff: false, confirm: null, saving: false, saved: "", error: "" });
  });
  it("shows on when the server says on, with a way to turn it off and no question", async () => {
    const { ctl } = await ready({ auto_merge: true });
    expect(model(ctl)).toMatchObject({ on: true, statusText: "copy:autoMergeIsOn", canTurnOn: false, canTurnOff: true, confirm: null });
  });
  it("an answer without the auto-merge parts is not shown as a half control", async () => {
    for (const bad of [{ auto_merge: "yes" }, { auto_merge: undefined }, { auto_merge_copy_sha256: "" }, { copy: { ...COPY, autoMergeWording: "" } }, { copy: { ...COPY, autoMergeTurnOn: undefined } }]) {
      const { ctl } = await ready(bad);
      expect(model(ctl).kind, JSON.stringify(Object.keys(bad))).toBe("hidden");
    }
    expect(readAutoMerge(null)).toBeNull();
    expect(readAutoMerge(body())).toMatchObject({ autoMerge: false, amHash: AM_HASH, mode: "runner_local" });
  });
});

describe("read-only for members", () => {
  it("shows the state and the wording but offers neither turn-on nor turn-off, and sends nothing", async () => {
    for (const auto_merge of [false, true]) {
      const { call, ctl } = await ready({ can_change: false, auto_merge });
      expect(model(ctl)).toMatchObject({ kind: "ready", locked: true, on: auto_merge, canTurnOn: false, canTurnOff: false, confirm: null });
      ctl.begin();
      await ctl.turnOff();
      expect(model(ctl).confirm).toBeNull();
      expect(posts(call)).toEqual([]);
    }
  });
});

describe("turning it on", () => {
  it("opens the question; apply is off until the exact name is typed, and nothing is sent before then", async () => {
    const { call, ctl } = await ready();
    ctl.begin();
    expect(model(ctl)).toMatchObject({ confirm: { applyDisabled: true }, canTurnOn: false });
    for (const wrong of ["", "acme/widgets", "Acme/widget", "Acme/widgets ", " Acme/widgets"]) {
      ctl.type(wrong);
      expect(model(ctl).confirm.applyDisabled, JSON.stringify(wrong)).toBe(true);
      await ctl.turnOn();
    }
    expect(posts(call)).toEqual([]);
    ctl.type(NAME);
    expect(model(ctl).confirm.applyDisabled).toBe(false);
  });
  it("sends auto_merge, the typed name and the hash of the wording that was shown, once even on a double press; then reads the state again", async () => {
    let on = false;
    const call = fakeCall({ GET: () => body({ auto_merge: on }), POST: () => ((on = true), { execution_mode: "runner_local", auto_merge: true, changed: true }) });
    const ctl = createAutoMergeController({ call, repoId: REPO });
    await ctl.load();
    ctl.begin();
    ctl.type(NAME);
    await Promise.all([ctl.turnOn(), ctl.turnOn()]);
    await settle();
    expect(posts(call)).toEqual([["POST", modeUrl(REPO), { auto_merge: true, confirm_repo: NAME, copy_sha256: AM_HASH }]]);
    expect(call.log.filter((a) => a[0] === "GET")).toHaveLength(2); // the load, and the read after the save
    expect(model(ctl)).toMatchObject({ on: true, confirm: null, saved: "copy:autoMergeSavedOn", error: "", canTurnOff: true });
  });
  it("shows the saving state while the request is out: the question stays, apply is off, cancel does nothing", async () => {
    let release = () => {};
    const gate = new Promise((r) => (release = r));
    const { ctl } = await ready({}, { POST: async () => { await gate; return { auto_merge: true }; } });
    ctl.begin();
    ctl.type(NAME);
    const p = ctl.turnOn();
    expect(model(ctl)).toMatchObject({ saving: true, confirm: { applyDisabled: true } });
    ctl.cancel();
    expect(model(ctl).confirm).not.toBeNull();
    release();
    await p;
    expect(model(ctl).saving).toBe(false);
  });
  it("cancelling closes the question and forgets the typed name", async () => {
    const { call, ctl } = await ready();
    ctl.begin();
    ctl.type(NAME);
    ctl.cancel();
    expect(model(ctl)).toMatchObject({ confirm: null, canTurnOn: true });
    ctl.begin();
    expect(model(ctl).confirm.applyDisabled).toBe(true);
    expect(posts(call)).toEqual([]);
  });
});

describe("turning it off", () => {
  it("sends only auto_merge: false, with no question, and then reads the state again", async () => {
    let on = true;
    const call = fakeCall({ GET: () => body({ auto_merge: on }), POST: () => ((on = false), { execution_mode: "runner_local", auto_merge: false, changed: true }) });
    const ctl = createAutoMergeController({ call, repoId: REPO });
    await ctl.load();
    await ctl.turnOff();
    await settle();
    expect(posts(call)).toEqual([["POST", modeUrl(REPO), { auto_merge: false }]]);
    expect(model(ctl)).toMatchObject({ on: false, saved: "copy:autoMergeSavedOff", error: "", canTurnOn: true });
  });
});

describe("refusals are the app's sentences from the server's copy, by status and code, never the server's message", () => {
  const cases = [
    [fail(409, "human_merge_only"), "copy:autoMergeHumanOnly"],
    [fail(400, "confirmation_mismatch"), "copy:nameMismatch"],
    [fail(409, "copy_changed"), "copy:copyChanged"],
    [fail(409, "not_runner_local"), "copy:autoMergeNotLocal"],
    [fail(403, "forbidden"), "copy:adminOnly"],
    [fail(500, "internal"), "copy:saveFailed"],
  ];
  for (const [err, words] of cases) {
    it(`${err.status} ${err.code}`, async () => {
      const { ctl } = await ready({}, { POST: err });
      ctl.begin();
      ctl.type(NAME);
      await ctl.turnOn();
      await settle();
      expect(model(ctl).error).toBe(words);
      expect(model(ctl).error).not.toContain("server text");
      expect(model(ctl).saved).toBe("");
    });
  }
  it("a 403 turns the control read-only", async () => {
    const { ctl } = await ready({}, { POST: fail(403, "forbidden") });
    ctl.begin();
    ctl.type(NAME);
    await ctl.turnOn();
    expect(model(ctl)).toMatchObject({ locked: true, confirm: null, canTurnOn: false });
  });
  it("a 409 copy_changed re-reads and the next confirm carries the new hash, keeping what was typed", async () => {
    let hash = AM_HASH;
    let first = true;
    const NEW = "cd".repeat(32);
    const { call, ctl } = await ready({}, {
      GET: () => body({ auto_merge_copy_sha256: hash }),
      POST: () => {
        if (!first) return { auto_merge: true };
        first = false;
        hash = NEW;
        throw fail(409, "copy_changed");
      },
    });
    ctl.begin();
    ctl.type(NAME);
    await ctl.turnOn();
    await settle();
    expect(model(ctl).error).toBe("copy:copyChanged");
    expect(model(ctl).confirm).toMatchObject({ applyDisabled: false });
    await ctl.turnOn();
    expect(posts(call).map((p) => p[2].copy_sha256)).toEqual([AM_HASH, NEW]);
  });
  it("a 409 not_runner_local re-reads and the control goes away once the repo is no longer local-only", async () => {
    let mode = "runner_local";
    const { ctl } = await ready({}, { GET: () => body({ execution_mode: mode }), POST: () => ((mode = "sandbox"), (() => { throw fail(409, "not_runner_local"); })()) });
    ctl.begin();
    ctl.type(NAME);
    await ctl.turnOn();
    await settle();
    expect(model(ctl).kind).toBe("hidden");
  });
  it("the sentence table never falls back to the server's message", () => {
    expect(autoMergeRefusal(fail(418, "teapot"), COPY)).toBe("copy:saveFailed");
    expect(autoMergeRefusal(null, COPY)).toBe("copy:saveFailed");
  });
});

describe("reload-safe", () => {
  it("a fresh controller shows what the server says now: on after a reload, off after a reload", async () => {
    for (const auto_merge of [true, false]) {
      const { ctl } = await ready({ auto_merge });
      expect(model(ctl).on).toBe(auto_merge);
    }
  });
  it("a quiet re-read that fails keeps the control the user has", async () => {
    let n = 0;
    const call = fakeCall({ GET: () => (n++ === 0 ? body() : fail(500, "internal")) });
    const ctl = createAutoMergeController({ call, repoId: REPO });
    await ctl.load();
    await ctl.load(true);
    expect(model(ctl).kind).toBe("ready");
  });
});

describe("the mode picker tells the control when the mode changed", () => {
  it("calls onApplied after a successful mode change, and not after a refusal", async () => {
    const onApplied = vi.fn();
    const modeBody = { ...body(), execution_mode: "runner_local" };
    const ok = createModeController({ call: fakeCall({ GET: modeBody, POST: { execution_mode: "sandbox" } }), repoId: REPO, onApplied });
    await ok.load();
    ok.choose("sandbox");
    ok.type(NAME);
    await ok.apply();
    expect(onApplied).toHaveBeenCalledTimes(1);
    const bad = createModeController({ call: fakeCall({ GET: modeBody, POST: fail(500, "internal") }), repoId: REPO, onApplied });
    await bad.load();
    bad.choose("sandbox");
    bad.type(NAME);
    await bad.apply();
    expect(onApplied).toHaveBeenCalledTimes(1);
  });
});
