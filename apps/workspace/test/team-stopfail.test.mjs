// apps/workspace/test/team-stopfail.test.mjs
//
// The Team app's "Stop failed" chip and Try again (ON-13c4b). The cloud sends one fact per repo, `stop_failed: {reason, code, at} | null`; the words, the
// button and the answer to a click are all chosen here by those closed values. Pinned: every reason x code sentence (exact), who gets the button, the
// request, every notice and error sentence, and a click on the real button (the DOM calls the page makes are the small stand-in the other click tests use;
// the page itself is driven on the built output in e2e/team.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPOS_URL, SETTINGS_URL, createTeam, createTeamApi, describe as describeState, readRepos, retryStopUrl } from "../apps/team/team-model.js";
import { STOP_WORDS, describeStopFailed, readStopFailed, stopFailNodes, stopFailure } from "../apps/team/team-operate.js";
import { REPO_A, makeFixtures } from "./fixtures/team/fixtures.mjs";

const NOW = Date.parse("2026-11-16T15:00:00.000Z");
const F = makeFixtures(NOW);
const RETRY = "POST " + retryStopUrl(REPO_A);
const e = (status, code) => Object.assign(new Error("server text that must never be shown"), { status, code });
const flush = () => new Promise((r) => setTimeout(r, 0));
const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

/** A Team whose repo list carries `stop_failed`; `answer` is what the retry route says (a function or an Error is used as in the other fakes). */
async function failing(stopFailed, { canEdit = true, answer = { job_id: "j1", kind: "engine_session_stop", operate_epoch: 1, already_issued: false } } = {}) {
  const log = [];
  const routes = {
    ["GET " + SETTINGS_URL]: F.settings({ can_edit: canEdit, operate_enabled: true }),
    ["GET " + REPOS_URL]: F.list([F.repo({ operate_enabled: true, stop_failed: stopFailed })]),
    [RETRY]: answer,
  };
  const call = vi.fn(async (method, path, body) => {
    log.push([method, path, body]);
    const r = routes[method + " " + path];
    if (r === undefined) {
      if (path.includes("/agents") || path.includes("/lanes") || path.includes("/gates") || path.includes("/log") || path.includes("/stats") || path.includes("/usage")) return F.envelope([]);
      if (path.endsWith("/plan")) return null;
      if (path.includes("/commands")) return F.commands([]);
      if (path.includes("/decision-settings")) return F.dials();
      throw e(404, "not_found");
    }
    if (r instanceof Error) throw r;
    return r;
  });
  const t = createTeam({ client: createTeamApi(call), setTimer: () => 1, clearTimer: () => {}, setRepeat: () => 1, clearRepeat: () => {}, now: () => NOW });
  await t.load();
  log.length = 0;
  t.view = () => describeState(t.state, NOW);
  return { t, log, call, routes };
}
const sf = (reason, code = null) => ({ reason, code, at: "2026-11-16T14:55:00.000Z" });

describe("the stop_failed fact", () => {
  it("is read as the closed shape, and a repo without it has none", () => {
    expect(readStopFailed(null)).toBeNull();
    expect(readStopFailed(undefined)).toBeNull();
    expect(readStopFailed("x")).toBeNull();
    expect(readStopFailed([])).toBeNull();
    expect(readStopFailed(sf("halt", "job_silent"))).toEqual({ reason: "halt", code: "job_silent", at: "2026-11-16T14:55:00.000Z" });
    expect(readStopFailed({ reason: "reboot", code: 5, at: 3 })).toEqual({ reason: "", code: "", at: "" }); // an unknown reason is kept as "no reason", not dropped
    expect(readRepos([{ repo_id: REPO_A, full_name: "a/b" }])[0].stopFailed).toBeNull();
  });
});

describe("the row's sentence: every reason and every code", () => {
  const BASE = {
    person: "The stop didn't finish. The engine may still be running",
    halt: "The halt didn't finish stopping the engine. It may still be running, and commands stay refused",
    operate_off: "Operate is off, but the engine didn't stop. It may still be running",
    plan: "The Engine plan ended, but the engine didn't stop. It may still be running",
    move: "Moving the project didn't stop the engine on its old machine",
    remove: "Removing the project didn't stop its engine",
    other: "The engine didn't stop",
  };
  const WHY = {
    snapshot_failed: "the engine's state couldn't be saved", vm_teardown_incomplete: "the machine couldn't finish shutting it down",
    job_expired: "the machine didn't pick up the stop in time", job_silent: "the machine went quiet", job_overran: "the stop took too long",
  };
  const NO_WHY = [null, "kind_unsupported", "engine_unsupported", "something_new"];
  const reasons = [["person", "person"], ["halt", "halt"], ["operate_off", "operate_off"], ["plan", "plan"], ["move", "move"], ["remove", "remove"], [null, "other"], ["reboot", "other"]];

  for (const [reason, key] of reasons) {
    it(`reason ${String(reason)}: ${Object.keys(WHY).length} codes with their why, ${NO_WHY.length} without`, async () => {
      for (const [code, why] of Object.entries(WHY)) {
        const { t } = await failing(sf(reason, code));
        expect(t.view().stopFail.text, `${reason}/${code}`).toBe(BASE[key] + " (" + why + ").");
      }
      for (const code of NO_WHY) {
        const { t } = await failing(sf(reason, code));
        expect(t.view().stopFail.text, `${reason}/${String(code)}`).toBe(BASE[key] + ".");
      }
    });
  }
  it("the chip reads Stop failed, and nothing is drawn for a repo whose stop did not fail", async () => {
    const { t } = await failing(sf("person"));
    expect(t.view().stopFail).toMatchObject({ chip: "Stop failed", id: REPO_A });
    expect(STOP_WORDS.chipContext).toBe("Engine stop: ");
    const none = await failing(null);
    expect(none.t.view().stopFail).toBeNull();
  });
  it("what follows the sentence: a system cause says the cloud tries again, a move and a removal say what to do, a person's or a halt's stop says nothing", async () => {
    const after = async (reason) => (await failing(sf(reason))).t.view().stopFail.after;
    expect(await after("operate_off")).toBe("We'll try again when the machine next reports in.");
    expect(await after("plan")).toBe("We'll try again when the machine next reports in.");
    expect(await after("move")).toBe("Start the move again to try once more.");
    expect(await after("remove")).toBe("Stop it on the machine itself.");
    expect(await after("person")).toBe("");
    expect(await after("halt")).toBe("");
    expect(await after(null)).toBe("");
  });
  it("no string of the row holds null, undefined or NaN, whatever the fact says", async () => {
    for (const [reason] of reasons) for (const code of [null, "snapshot_failed", "nope"]) {
      const { t } = await failing(sf(reason, code));
      for (const s of strings(t.view().stopFail)) expect(s).not.toMatch(/\bnull\b|undefined|NaN/);
    }
  });
});

describe("who gets the button", () => {
  it("an owner or admin has it for a person, a halt, a system cause and an unknown reason; a move and a removal have none", async () => {
    for (const reason of ["person", "halt", "operate_off", "plan", null]) expect((await failing(sf(reason))).t.view().stopFail, String(reason)).toMatchObject({ button: true, canRetry: true, forbidden: "", label: "Try again" });
    for (const reason of ["move", "remove"]) expect((await failing(sf(reason))).t.view().stopFail, reason).toMatchObject({ button: false, canRetry: false, forbidden: "" });
  });
  it("a member sees the button, disabled, with the line that says why; a move and a removal still have none", async () => {
    for (const reason of ["person", "halt", "operate_off", "plan", null]) expect((await failing(sf(reason), { canEdit: false })).t.view().stopFail, String(reason)).toMatchObject({ button: true, canRetry: false, forbidden: "Only an owner or admin can try again." });
    for (const reason of ["move", "remove"]) expect((await failing(sf(reason), { canEdit: false })).t.view().stopFail, reason).toMatchObject({ button: false, forbidden: "" });
  });
  it("a member's press reaches the controller and sends nothing; so does a move's or a removal's, even for an owner", async () => {
    const m = await failing(sf("person"), { canEdit: false });
    expect(await m.t.operate.retryStop()).toBe(false);
    for (const reason of ["move", "remove"]) {
      const o = await failing(sf(reason));
      expect(await o.t.operate.retryStop()).toBe(false);
      expect(o.log).toEqual([]);
    }
    expect(m.log).toEqual([]);
  });
});

describe("Try again: the request and what is said after it", () => {
  it("one POST to the repo's retry-stop route with no body, then the list is read again", async () => {
    expect(retryStopUrl(REPO_A)).toBe("/api/v1/engine/repos/" + REPO_A + "/retry-stop");
    const { t, log } = await failing(sf("person"));
    expect(await t.operate.retryStop()).toBe(true);
    expect(log[0]).toEqual(["POST", "/api/v1/engine/repos/" + REPO_A + "/retry-stop", undefined]);
    expect(log.filter(([m]) => m === "POST")).toHaveLength(1);
    expect(log.some(([m, p]) => m === "GET" && p === REPOS_URL)).toBe(true);
  });
  it("says each answer in its own words", async () => {
    const said = async (answer, reason = "person") => { const r = await failing(sf(reason), { answer }); await r.t.operate.retryStop(); return r.t.view().stopFail.note; };
    expect(await said({ job_id: "j", kind: "engine_session_stop", operate_epoch: 1, already_issued: false })).toBe("Asked the machine to stop the engine again.");
    expect(await said({ job_id: "j", kind: "engine_session_stop", operate_epoch: 1, already_issued: true }, "halt")).toBe("A stop is already on its way.");
    expect(await said({ queued: true }, "operate_off")).toBe("Asked again. The stop goes out when the machine next reports in.");
  });
  it("says each refusal in its own words, never the server's, and reads the list again after a 404 or a 409", async () => {
    const cases = [
      [e(403, "forbidden"), "Only an owner or admin can try again."],
      [e(404, "not_found"), "That repository no longer exists."],
      [e(409, "not_placed"), "This project isn't on a machine."],
      [e(409, "runner_removed"), "The machine was removed."],
      [e(409, "nothing_to_retry"), "The stop already changed. Reload the page."],
      [e(409, "cause_gone"), "That's no longer needed, so nothing was sent."],
      [e(409, "not_retryable"), "That didn't send. Try again."],
      [e(401, "unauthorized"), "Your session has ended. Sign in again."],
      [e(503, "not_configured"), "That didn't send. Try again."],
      [e(500, "server_error"), "That didn't send. Try again."],
      [Object.assign(new Error("network"), { status: 0 }), "That didn't send. Try again."],
    ];
    for (const [err, sentence] of cases) {
      const { t, log } = await failing(sf("person"), { answer: err });
      expect(await t.operate.retryStop(), sentence).toBe(false);
      expect(t.view().stopFail.note).toBe(sentence);
      expect(t.view().stopFail.note).not.toContain("server text");
      expect(t.state.op.stopBusy).toBe(false);
      expect(log.filter(([m, p]) => m === "GET" && p === REPOS_URL).length > 0, String(err.status) + err.code).toBe(err.status === 404 || err.status === 409);
    }
    expect(stopFailure(undefined)).toBe("That didn't send. Try again.");
  });
  it("shows Trying again… while the call is out and ignores a second press", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const r = await failing(sf("person"));
    r.routes[RETRY] = undefined;
    r.call.mockImplementation(async (method, path) => { if (method === "POST") { await gate; return { job_id: "j", kind: "engine_session_stop", operate_epoch: 1, already_issued: false }; } return path === REPOS_URL ? F.list([F.repo({ operate_enabled: true, stop_failed: sf("person") })]) : path === SETTINGS_URL ? F.settings({ operate_enabled: true }) : F.envelope([]); });
    const first = r.t.operate.retryStop();
    expect(r.t.view().stopFail).toMatchObject({ label: "Trying again…", busy: true });
    expect(await r.t.operate.retryStop()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(r.call.mock.calls.filter(([m]) => m === "POST")).toHaveLength(1);
    expect(r.t.view().stopFail).toMatchObject({ label: "Try again", busy: false });
  });
});

// ── a click on the real button ─────────────────────────────────────────────────────────────────────────────────────────────
class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.kids = []; this.on = {}; this.className = ""; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { this.on[t] = f; }
  appendChild(c) { this.kids.push(c); return c; }
  get textContent() { return this.kids.map((k) => (k instanceof FakeEl ? k.textContent : k.text)).join(""); }
}
const findAll = (el, test, out = []) => (test(el) && out.push(el), el.kids.forEach((k) => k instanceof FakeEl && findAll(k, test, out)), out);
const byId = (nodes, id) => nodes.filter(Boolean).flatMap((n) => findAll(n, (x) => x.getAttribute("data-testid") === id));

describe("a click on Try again", () => {
  beforeEach(() => {
    vi.stubGlobal("Node", FakeNode);
    vi.stubGlobal("document", { createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("calls retry() with no argument, and one click is one POST through the real controller", async () => {
    const r = await failing(sf("halt", "job_silent"));
    const retry = vi.fn(() => r.t.operate.retryStop());
    const nodes = stopFailNodes(r.t.view().stopFail, () => retry());
    expect(byId(nodes, "tm-stopfail-text")[0].textContent).toBe("The halt didn't finish stopping the engine. It may still be running, and commands stay refused (the machine went quiet).");
    const [btn] = byId(nodes, "tm-stopfail-retry");
    expect(btn.textContent).toBe("Try again");
    expect(btn.disabled).toBeUndefined(); // an owner's button is not set disabled
    btn.on.click({ type: "click", target: btn, isTrusted: true }); // the browser hands the handler an event; it must not reach the controller
    await flush();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.calls[0]).toEqual([]);
    expect(r.log.filter(([m]) => m === "POST")).toEqual([["POST", "/api/v1/engine/repos/" + REPO_A + "/retry-stop", undefined]]);
    expect(r.t.view().stopFail.note).toBe("Asked the machine to stop the engine again.");
  });
  it("a member's button is drawn disabled beside its line, and a click that reaches it makes no call", async () => {
    const r = await failing(sf("person"), { canEdit: false });
    const nodes = stopFailNodes(r.t.view().stopFail, () => r.t.operate.retryStop());
    const [btn] = byId(nodes, "tm-stopfail-retry");
    expect(btn.attrs["aria-disabled"]).toBe("true");
    expect(btn.attrs.disabled).toBeUndefined();
    expect(btn.getAttribute("aria-describedby")).toBe("tm-stopfail-why");
    expect(byId(nodes, "tm-stopfail-why")[0].textContent).toBe("Only an owner or admin can try again.");
    btn.on.click({ type: "click" });
    await flush();
    expect(r.log).toEqual([]);
  });
  it("while a call is out the button reads Trying again… and a click does nothing", async () => {
    const view = { ...describeStopFailed({ settings: { canEdit: true }, op: { stopBusy: true, stopNote: "" } }, { id: REPO_A, stopFailed: sf("person") }) };
    const retry = vi.fn();
    const [, btn] = stopFailNodes(view, retry);
    expect(btn.textContent).toBe("Trying again…");
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    btn.on.click();
    expect(retry).not.toHaveBeenCalled();
  });
  it("a move or a removal draws no button, only its sentence and what to do", async () => {
    for (const [reason, line] of [["move", "Start the move again to try once more."], ["remove", "Stop it on the machine itself."]]) {
      const r = await failing(sf(reason));
      const nodes = stopFailNodes(r.t.view().stopFail, () => r.t.operate.retryStop());
      expect(byId(nodes, "tm-stopfail-retry")).toHaveLength(0);
      expect(byId(nodes, "tm-stopfail-after")[0].textContent).toBe(line);
    }
  });
});
