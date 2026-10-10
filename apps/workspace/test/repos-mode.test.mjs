// apps/workspace/test/repos-mode.test.mjs
//
// D#6 R5b-2b-iii: the Repos app's mode picker, state by state. The decisions are in pickerModel and the controller (no DOM); the
// DOM wiring (radiogroup, aria-describedby, focus on error) is driven in the browser by e2e/repos-mode.spec.ts. The vitest environment is node.
import { describe, expect, it, vi } from "vitest";
import { MODES, UNAVAILABLE_TEXT, createModeController, modeUrl, pickerModel, readView, refusalWords } from "../apps/repos/repos-runners.js";

const REPO = "99999999-9999-4999-8999-999999999999";
const NAME = "Acme/widgets";
const HASH = "ab".repeat(32);
const KEYS = ["title", "sandbox", "sandboxHelp", "localOnly", "localOnlyHelp", "cloudVerified", "cloudVerifiedHelp", "keyRequired", "keyRequiredWhy", "typeName", "apply", "cancel", "saving", "saved", "leaveCancels", "adminOnly", "saveFailed", "nameMismatch", "copyChanged", "keyGone", "publicRepo", "visibilityUnknown"];
const COPY = Object.fromEntries(KEYS.map((k) => [k, "copy:" + k]));
const body = (over = {}) => ({ repo_id: REPO, execution_mode: "sandbox", full_name: NAME, key_required: false, copy_sha256: HASH, can_change: true, copy: COPY, ...over });
const fail = (status, code) => Object.assign(new Error("server text that must never be shown"), { status, code });

/** A call() that answers by "METHOD path"; a function value is called each time, an Error is thrown. */
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
  const ctl = createModeController({ call, repoId: REPO });
  await ctl.load();
  return { call, ctl };
}
const model = (ctl) => pickerModel(ctl.state);
const option = (m, mode) => m.options.find((o) => o.mode === mode);

describe("loading and failed reads", () => {
  it("is loading before the answer, and the model says so", async () => {
    const ctl = createModeController({ call: fakeCall({ GET: body() }), repoId: REPO });
    expect(model(ctl).kind).toBe("loading");
  });
  it("a failed read is the error state, with a sentence of the app's own", async () => {
    const ctl = createModeController({ call: fakeCall({ GET: fail(500, "internal") }), repoId: REPO });
    await ctl.load();
    expect(model(ctl).kind).toBe("error");
    expect(UNAVAILABLE_TEXT).not.toContain("server text");
  });
  it("an answer with a missing part, an unknown mode or a missing string is the error state, not a half picker", async () => {
    for (const bad of [{ execution_mode: "weird" }, { key_required: "no" }, { copy_sha256: "" }, { copy: { ...COPY, cancel: "" } }, { copy: null }]) {
      const ctl = createModeController({ call: fakeCall({ GET: body(bad) }), repoId: REPO });
      await ctl.load();
      expect(model(ctl).kind, JSON.stringify(Object.keys(bad))).toBe("error");
    }
    expect(readView(null)).toBeNull();
  });
  it("a quiet re-read that fails keeps the picker the user has", async () => {
    let n = 0;
    const call = fakeCall({ GET: () => (n++ === 0 ? body() : fail(500, "internal")) });
    const ctl = createModeController({ call, repoId: REPO });
    await ctl.load();
    await ctl.load(true);
    expect(model(ctl).kind).toBe("ready");
  });
  it("reads from the repo's execution-mode url", async () => {
    const { call } = await ready();
    expect(call.log[0]).toEqual(["GET", modeUrl(REPO), undefined]);
    expect(modeUrl("a/b")).toBe("/api/runners/repos/a%2Fb/execution-mode");
  });
});

describe("ready: the three modes", () => {
  it("shows sandbox, local-only and cloud-verified in order, with the current one checked and the words from the copy", async () => {
    const { ctl } = await ready({ execution_mode: "runner_local" });
    const m = model(ctl);
    expect(MODES).toEqual(["sandbox", "runner_local", "runner_verified"]);
    expect(m.options.map((o) => [o.mode, o.checked, o.label])).toEqual([["sandbox", false, "copy:sandbox"], ["runner_local", true, "copy:localOnly"], ["runner_verified", false, "copy:cloudVerified"]]);
    expect(m.options.map((o) => o.help)).toEqual(["copy:sandboxHelp", "copy:localOnlyHelp", "copy:cloudVerifiedHelp"]);
    expect(m.confirm).toBeNull();
    expect(m.locked).toBe(false);
  });
  it("with a key, every option is on", async () => {
    const { ctl } = await ready();
    expect(model(ctl).options.every((o) => !o.disabled && !o.keyOff)).toBe(true);
    expect(model(ctl).keyReason).toBeNull();
  });
});

describe("keyRequired disables cloud-verified with a reason", () => {
  it("is off and says why; the other two stay on; choosing it does nothing", async () => {
    const { ctl } = await ready({ key_required: true });
    const m = model(ctl);
    expect(option(m, "runner_verified")).toMatchObject({ disabled: true, keyOff: true });
    expect(option(m, "sandbox").disabled).toBe(false);
    expect(option(m, "runner_local").disabled).toBe(false);
    expect(m.keyReason).toEqual(["copy:keyRequired", "copy:keyRequiredWhy"]);
    ctl.choose("runner_verified");
    expect(model(ctl).confirm).toBeNull();
  });
  it("a repo already on cloud-verified can still be left when the key is gone, and shows no key reason", async () => {
    const { ctl } = await ready({ key_required: true, execution_mode: "runner_verified" });
    const m = model(ctl);
    expect(option(m, "runner_verified")).toMatchObject({ checked: true, keyOff: false });
    expect(m.keyReason).toBeNull();
    ctl.choose("sandbox");
    expect(model(ctl).confirm).not.toBeNull();
  });
});

describe("not an owner or admin", () => {
  it("every option is off, nothing can be picked, and the model says it is locked", async () => {
    const { ctl } = await ready({ can_change: false });
    expect(model(ctl).locked).toBe(true);
    expect(model(ctl).options.every((o) => o.disabled)).toBe(true);
    ctl.choose("runner_local");
    expect(model(ctl).confirm).toBeNull();
  });
});

describe("the typed name gate", () => {
  it("picking another mode opens the confirmation with the apply button off; it turns on only for the exact name", async () => {
    const { call, ctl } = await ready();
    ctl.choose("runner_local");
    expect(model(ctl).confirm).toMatchObject({ target: "runner_local", applyDisabled: true, showWording: false, leaveNote: "" });
    expect(option(model(ctl), "runner_local").checked).toBe(true);
    for (const wrong of ["acme/widgets", "Acme/widgets ", " Acme/widgets", "Acme/widget", "widgets", ""]) {
      ctl.type(wrong);
      expect(model(ctl).confirm.applyDisabled, JSON.stringify(wrong)).toBe(true);
      await ctl.apply();
    }
    expect(posts(call)).toEqual([]);
    ctl.type(NAME);
    expect(model(ctl).confirm.applyDisabled).toBe(false);
  });
  it("a repo with no stored name can never be confirmed", async () => {
    const { call, ctl } = await ready({ full_name: null });
    ctl.choose("runner_local");
    ctl.type("null");
    ctl.type("");
    expect(model(ctl).confirm.applyDisabled).toBe(true);
    await ctl.apply();
    expect(posts(call)).toEqual([]);
  });
  it("cancel and picking the current mode again both back out, and clear what was typed", async () => {
    const { ctl } = await ready();
    ctl.choose("runner_local");
    ctl.type(NAME);
    ctl.cancel();
    expect(model(ctl).confirm).toBeNull();
    ctl.choose("runner_local");
    expect(ctl.state.typed).toBe("");
    ctl.choose("sandbox");
    expect(model(ctl).confirm).toBeNull();
  });
});

describe("what is sent", () => {
  it("cloud-verified sends the mode, the typed name and the copy hash from the read, shows the wording, and succeeds", async () => {
    const { call, ctl } = await ready({}, { POST: { execution_mode: "runner_verified", changed: true, cancelled_runs: 0 } });
    ctl.choose("runner_verified");
    expect(model(ctl).confirm).toMatchObject({ target: "runner_verified", showWording: true });
    ctl.type(NAME);
    await ctl.apply();
    expect(posts(call)).toEqual([["POST", modeUrl(REPO), { mode: "runner_verified", confirm_repo: NAME, copy_sha256: HASH }]]);
    const m = model(ctl);
    expect(m).toMatchObject({ saved: true, error: "", confirm: null });
    expect(option(m, "runner_verified").checked).toBe(true);
  });
  it("local-only and sandbox send no hash (the server refuses an unknown key)", async () => {
    const { call, ctl } = await ready({ execution_mode: "runner_verified" }, { POST: { execution_mode: "runner_local" } });
    ctl.choose("runner_local");
    ctl.type(NAME);
    await ctl.apply();
    expect(posts(call)[0][2]).toEqual({ mode: "runner_local", confirm_repo: NAME });
  });
  it("leaving to the sandbox from a runner mode says the queued runs are cancelled; going between runner modes does not", async () => {
    const { ctl } = await ready({ execution_mode: "runner_verified" });
    ctl.choose("sandbox");
    expect(model(ctl).confirm.leaveNote).toBe("copy:leaveCancels");
    ctl.choose("runner_local");
    expect(model(ctl).confirm.leaveNote).toBe("");
  });
  it("from the sandbox there is nothing to cancel, so no leave note", async () => {
    const { ctl } = await ready({ execution_mode: "sandbox" });
    ctl.choose("runner_local");
    expect(model(ctl).confirm.leaveNote).toBe("");
  });
});

describe("saving", () => {
  it("while the request is out the model is saving, everything is off, and a second press sends nothing", async () => {
    let release = () => {};
    const gate = new Promise((r) => (release = r));
    const { call, ctl } = await ready({}, { POST: async () => { await gate; return { execution_mode: "runner_local" }; } });
    ctl.choose("runner_local");
    ctl.type(NAME);
    const first = ctl.apply();
    const second = ctl.apply();
    const m = model(ctl);
    expect(m.saving).toBe(true);
    expect(m.confirm.applyDisabled).toBe(true);
    expect(m.options.every((o) => o.disabled)).toBe(true);
    ctl.cancel();
    ctl.choose("sandbox");
    release();
    await Promise.all([first, second]);
    expect(posts(call)).toHaveLength(1);
    expect(model(ctl).saved).toBe(true);
  });
});

describe("refusals are sentences of the copy, never the server's text", () => {
  async function refused(error, over = {}) {
    const { call, ctl } = await ready(over, { POST: error });
    ctl.choose(over.execution_mode === "runner_verified" ? "sandbox" : "runner_verified");
    ctl.type(NAME);
    await ctl.apply();
    return { call, ctl, m: model(ctl) };
  }
  it("400 confirmation_mismatch: the name sentence, the choice stays so it can be retyped", async () => {
    const { m } = await refused(fail(400, "confirmation_mismatch"));
    expect(m.error).toBe("copy:nameMismatch");
    expect(m.confirm).not.toBeNull();
    expect(m.saved).toBe(false);
  });
  it("409 copy_changed: the wording sentence, and the picker re-reads so the next confirm carries the new hash", async () => {
    let n = 0;
    const call = fakeCall({ GET: () => body({ copy_sha256: n++ === 0 ? HASH : "cd".repeat(32) }), POST: fail(409, "copy_changed") });
    const ctl = createModeController({ call, repoId: REPO });
    await ctl.load();
    ctl.choose("runner_verified");
    ctl.type(NAME);
    await ctl.apply();
    expect(model(ctl).error).toBe("copy:copyChanged");
    expect(ctl.state.view.hash).toBe("cd".repeat(32));
  });
  it("409 api_key_required: the key sentence, and the re-read turns cloud-verified off", async () => {
    let n = 0;
    const call = fakeCall({ GET: () => body({ key_required: n++ > 0 }), POST: fail(409, "api_key_required") });
    const ctl = createModeController({ call, repoId: REPO });
    await ctl.load();
    ctl.choose("runner_verified");
    ctl.type(NAME);
    await ctl.apply();
    expect(model(ctl).error).toBe("copy:keyGone");
    expect(option(model(ctl), "runner_verified").disabled).toBe(true);
  });
  it("409 public_repo and repo_visibility_unknown have their own sentences", async () => {
    expect((await refused(fail(409, "public_repo"))).m.error).toBe("copy:publicRepo");
    expect((await refused(fail(409, "repo_visibility_unknown"))).m.error).toBe("copy:visibilityUnknown");
  });
  it("403: the admin-only sentence, and the picker turns read-only", async () => {
    const { m } = await refused(fail(403, "forbidden"));
    expect(m.error).toBe("copy:adminOnly");
    expect(m.locked).toBe(true);
    expect(m.confirm).toBeNull();
  });
  it("any other failure, and a network error with no status: the generic save sentence, and the choice is kept for a retry", async () => {
    for (const e of [fail(500, "internal"), new Error("offline"), fail(429, "rate_limited")]) {
      const { m } = await refused(e);
      expect(m.error).toBe("copy:saveFailed");
      expect(m.confirm).not.toBeNull();
    }
  });
  it("the next press clears the error, and an abort leaves the state alone", async () => {
    let n = 0;
    const { ctl } = await ready({}, { POST: () => (n++ === 0 ? fail(500, "internal") : { execution_mode: "runner_verified" }) });
    ctl.choose("runner_verified");
    ctl.type(NAME);
    await ctl.apply();
    expect(model(ctl).error).toBe("copy:saveFailed");
    await ctl.apply();
    expect(model(ctl)).toMatchObject({ error: "", saved: true });
    const aborted = await ready({}, { POST: Object.assign(new Error("x"), { name: "AbortError" }) });
    aborted.ctl.choose("runner_local");
    aborted.ctl.type(NAME);
    await aborted.ctl.apply();
    expect(model(aborted.ctl).error).toBe("");
  });
  it("refusalWords is by status and code only", () => {
    expect(refusalWords(fail(409, "something_new"), COPY)).toBe("copy:saveFailed");
    expect(refusalWords(undefined, COPY)).toBe("copy:saveFailed");
  });
});
