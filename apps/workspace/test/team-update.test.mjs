// apps/workspace/test/team-update.test.mjs
//
// The Team app's engine update card (ON-15d). The cloud sends one fact per repo, `engine_update: {behind, update} | null`; every sentence, the progress step, the pull
// request link and the button are chosen here by those closed values. Pinned: every phase, every sub-step, every failure code (and that no code the runner protocol can
// send is left without words), who gets the button, the request, every answer and refusal, and a click on the real button (the page itself is driven on the built output
// in e2e/team.spec.ts).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPOS_URL, SETTINGS_URL, createTeam, createTeamApi, describe as describeState, readRepos, updateUrl } from "../apps/team/team-model.js";
import { UPDATE_WORDS, describeEngineUpdate, readEngineUpdate, updateFailure, updateNodes } from "../apps/team/team-operate.js";
import { REPO_A, makeFixtures } from "./fixtures/team/fixtures.mjs";

const NOW = Date.parse("2026-11-16T15:00:00.000Z");
const F = makeFixtures(NOW);
const POST = "POST " + updateUrl(REPO_A);
const e = (status, code) => Object.assign(new Error("server text that must never be shown"), { status, code });
const flush = () => new Promise((r) => setTimeout(r, 0));
const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

const upd = (over = {}) => ({ from_version: "1.4.0", to_version: "1.5.0", phase: "push", sub_step: "engine_fetch", state: "started", failure_code: null, pr: null, ...over });
const card = (over = {}) => ({ behind: null, update: upd(), ...over });
const BEHIND = { from: "1.4.0", to: "1.5.0" };

/** A Team whose repo list carries `engine_update`; `answer` is what the update route says (a function or an Error is used as in the other fakes). */
async function carded(engineUpdate, { canEdit = true, operate = true, answer = { update_id: "u1", job_id: "j1", attempt: 1, from_version: "1.4.0", to_version: "1.5.0", branch: "fx/engine-update-1.5.0" } } = {}) {
  const log = [];
  const routes = {
    ["GET " + SETTINGS_URL]: F.settings({ can_edit: canEdit, operate_enabled: operate }),
    ["GET " + REPOS_URL]: F.list([F.repo({ operate_enabled: operate, engine_update: engineUpdate })]),
    [POST]: answer,
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
const view = async (eu, o) => (await carded(eu, o)).t.view().updateCard;

describe("the engine_update fact", () => {
  it("is read as the closed shape; anything else is nothing to show", () => {
    expect(readEngineUpdate(null)).toBeNull();
    expect(readEngineUpdate(undefined)).toBeNull();
    expect(readEngineUpdate("x")).toBeNull();
    expect(readEngineUpdate([])).toBeNull();
    expect(readEngineUpdate({ behind: null, update: null })).toBeNull();
    expect(readEngineUpdate({ behind: BEHIND, update: null })).toEqual({ behind: BEHIND, update: null });
    expect(readEngineUpdate({ behind: { from: "1.4", to: "1.5.0" }, update: null })).toBeNull(); // not MAJOR.MINOR.PATCH
    expect(readEngineUpdate({ behind: { from: "1.4.0", to: "<b>1.5.0</b>" }, update: null })).toBeNull();
    expect(readEngineUpdate(card({ update: upd({ phase: "reboot" }) }))).toBeNull();
    expect(readEngineUpdate(card({ update: upd({ state: "wat" }) }))).toBeNull();
    expect(readEngineUpdate(card({ update: upd({ phase: "done" }) }))).toBeNull(); // a finished update is nothing to show
    expect(readEngineUpdate(card({ update: upd({ pr: -3 }) })).update.pr).toBe(0);
    expect(readEngineUpdate(card({ update: upd({ pr: 2.5 }) })).update.pr).toBe(0);
    expect(readEngineUpdate(card({ update: upd({ failure_code: "Not A Code", sub_step: "../x" }) })).update).toMatchObject({ code: "", sub: "" });
    expect(readRepos([{ repo_id: REPO_A, full_name: "a/b" }])[0].engineUpdate).toBeNull();
  });
  it("a repo with no installed project, or nothing behind and nothing under way, draws no card", async () => {
    expect(await view(null)).toBeNull();
    expect(await view({ behind: null, update: null })).toBeNull();
  });
});

describe("update available", () => {
  it("says the two versions, offers Update, and draws no progress", async () => {
    const v = await view({ behind: BEHIND, update: null });
    expect(v).toMatchObject({ id: REPO_A, title: "Update available (v1.4.0 → v1.5.0)", detail: "", step: null, link: null, button: true, canStart: true, label: "Update", forbidden: "", said: "" });
    expect(UPDATE_WORDS.available("1.4.0", "1.5.0")).toBe("Update available (v1.4.0 → v1.5.0)");
  });
  it("a member sees the same card with the button disabled and the line that says why", async () => {
    expect(await view({ behind: BEHIND, update: null }, { canEdit: false })).toMatchObject({ button: true, canStart: false, forbidden: "Only an owner or admin can update the engine." });
  });
});

describe("progress: every phase and sub-step", () => {
  const SUBS = { engine_fetch: "fetching the new version", sandbox_boot: "starting a sandbox", workspace_in: "copying the project in", bootstrap: "applying the update", bundle_out: "collecting the changes", push: "sending the changes to GitHub" };
  for (const [sub, words] of Object.entries(SUBS)) {
    it(`push, ${sub}`, async () => {
      for (const state of ["started", "ok", "skipped"]) {
        const v = await view(card({ update: upd({ sub_step: sub, state }) }));
        expect(v).toMatchObject({ title: "Updating the engine (v1.4.0 → v1.5.0)", detail: "Step 1 of 4: Preparing the update (" + words + ").", step: { n: 1, of: 4 }, button: false, link: null });
      }
    });
  }
  it("push with no sub-step, or one the app does not know, says the step alone", async () => {
    for (const sub of [null, "pr_open", "brand_new"]) expect((await view(card({ update: upd({ sub_step: sub }) }))).detail).toBe("Step 1 of 4: Preparing the update.");
  });
  it("pr: Opening the pull request, with no link until it has a number", async () => {
    const v = await view(card({ update: upd({ phase: "pr", sub_step: "push", state: "ok" }) }));
    expect(v).toMatchObject({ detail: "Step 2 of 4: Opening the pull request.", step: { n: 2, of: 4 }, link: null });
  });
  it("await_merge: waits for a person, with the pull request linked", async () => {
    const v = await view(card({ update: upd({ phase: "await_merge", sub_step: "pr_open", state: "ok", pr: 41 }) }));
    expect(v).toMatchObject({ detail: "Step 3 of 4: Waiting for someone to merge the pull request.", step: { n: 3, of: 4 }, link: { href: "https://github.com/" + F.repo().full_name + "/pull/41", text: "Pull request #41" } });
  });
  it("restart: Restarting when Operate is on; says it waits when Operate is off", async () => {
    const eu = card({ update: upd({ phase: "restart", sub_step: "pr_merged", state: "ok", pr: 41 }) });
    expect(await view(eu, { operate: true })).toMatchObject({ detail: "Merged. Restarting the engine on v1.5.0.", step: { n: 4, of: 4 }, link: { text: "Pull request #41" } });
    expect(await view(eu, { operate: false })).toMatchObject({ detail: "Merged. The engine restarts on v1.5.0 when Operate is next on." });
  });
  it("while one is under way there is no Update button, for an owner or a member, and no why line", async () => {
    for (const canEdit of [true, false]) expect(await view(card(), { canEdit })).toMatchObject({ button: false, forbidden: "" });
  });
  it("what is said to the page is the progress line, and only when there is one", async () => {
    expect((await view(card())).said).toBe("Step 1 of 4: Preparing the update (fetching the new version).");
    expect((await view({ behind: BEHIND, update: null })).said).toBe("");
  });
});

describe("failure: every code", () => {
  const WHY = {
    engine_fetch_failed: "the new version couldn't be downloaded", engine_checksum: "the download didn't match its checksum", engine_archive_refused: "the download wasn't accepted",
    bootstrap_failed: "the update step failed on the machine", bundle_refused: "the changes from the machine weren't accepted", push_failed: "the changes couldn't be sent to GitHub",
    direct_raced: "the update branch changed while it ran", vm_admission_refused: "the machine had no room for a sandbox", vm_boot_failed: "the sandbox didn't start",
    vm_egress_unavailable: "the sandbox couldn't reach the network", vm_token_delivery_failed: "the sandbox couldn't be given access", vm_workspace_failed: "the project couldn't be copied into the sandbox",
    vm_teardown_incomplete: "the sandbox didn't shut down cleanly", job_expired: "the machine didn't pick up the update in time", job_silent: "the machine went quiet", job_overran: "the update took too long",
    engine_unsupported: "this machine can't run that version", kind_unsupported: "this machine can't run updates yet", pr_open_failed: "GitHub didn't open the pull request",
    pr_scope_refused: "the update touched files it shouldn't have", update_head_changed: "the update branch changed after it was pushed", pr_closed: "the pull request was closed without merging",
    pr_not_opened: "the pull request was never opened",
  };
  const failed = (code, over = {}) => card({ behind: BEHIND, update: upd({ phase: "failed", state: "failed", failure_code: code, ...over }) });
  it("every code has its own sentence, Try again, and no progress step", async () => {
    for (const [code, why] of Object.entries(WHY)) {
      expect(await view(failed(code)), code).toMatchObject({ title: "Update available (v1.4.0 → v1.5.0)", detail: "The update to v1.5.0 didn't finish (" + why + ").", step: null, button: true, label: "Try again", canStart: true });
    }
  });
  it("the table is exactly the app's words, and every code the runner protocol can send an update with has words or is named here as one an update never reports", () => {
    expect(UPDATE_WORDS.why).toEqual(WHY);
    const src = readFileSync(new URL("../../../packages/runner-protocol/src/machineJobs.ts", import.meta.url), "utf8");
    const list = (name) => [...(src.match(new RegExp("export const " + name + " = \\[([\\s\\S]*?)\\] as const")) || ["", ""])[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    const protocol = [...list("SETUP_FAILURE_CODES"), ...list("SETUP_VM_JOB_CODES")];
    expect(protocol.length).toBeGreaterThan(20);
    const NEVER_FOR_AN_UPDATE = ["plan_fetch_failed", "plan_checksum", "plan_invalid", "setup_status_refused", "finalize_failed", "install_head_changed", "labels_failed", "twin_head_moved", "twin_too_large", "twin_not_empty", "twin_fetch_failed"];
    for (const code of protocol) expect(Object.hasOwn(WHY, code) || NEVER_FOR_AN_UPDATE.includes(code), code).toBe(true);
  });
  it("a code the app does not know, or none, says the update didn't finish and nothing more", async () => {
    for (const code of [null, "parked", "brand_new", "Not-a-code"]) expect((await view(failed(code))).detail, String(code)).toBe("The update to v1.5.0 didn't finish.");
  });
  it("a failure reported by a step (state failed) is a failure whatever the phase says", async () => {
    expect(await view(failed("push_failed", { phase: "push" }))).toMatchObject({ detail: expect.stringContaining("couldn't be sent to GitHub"), step: null });
  });
  it("a failed update that has a pull request links it (a closed one)", async () => {
    expect((await view(failed("pr_closed", { pr: 41 }))).link).toEqual({ href: "https://github.com/" + F.repo().full_name + "/pull/41", text: "Pull request #41" });
  });
  it("a failure with nothing behind is titled as a failure and has no button", async () => {
    expect(await view({ behind: null, update: upd({ phase: "failed", state: "failed", failure_code: "job_silent" }) })).toMatchObject({ title: "Engine update failed (v1.4.0 → v1.5.0)", button: false });
  });
  it("a member sees the failure, and Try again disabled with the line that says why", async () => {
    expect(await view(failed("job_silent"), { canEdit: false })).toMatchObject({ button: true, canStart: false, label: "Try again", forbidden: "Only an owner or admin can update the engine." });
  });
});

describe("the link", () => {
  it("is built from the repo's own name and a whole number, and never from a name that is not owner/name", () => {
    const st = (name) => [{ settings: { canEdit: true }, op: {} }, { id: REPO_A, name, operate: true, engineUpdate: readEngineUpdate(card({ update: upd({ phase: "await_merge", pr: 7 }) })) }];
    expect(describeEngineUpdate(...st("acme/widgets")).link.href).toBe("https://github.com/acme/widgets/pull/7");
    for (const bad of ["acme", "a/b/c", "acme/wid gets", "acme/<x>", "../x/y", ""]) expect(describeEngineUpdate(...st(bad)).link, bad).toBeNull();
  });
});

describe("no string of the card holds null, undefined or NaN, whatever the fact says", () => {
  it("across every phase, state and an unknown value", async () => {
    for (const phase of ["push", "pr", "await_merge", "restart", "failed"]) for (const state of ["started", "ok", "failed", "skipped"]) for (const pr of [null, 12]) {
      const v = await view(card({ behind: BEHIND, update: upd({ phase, state, pr, failure_code: state === "failed" ? "nope" : null }) }));
      for (const s of strings(v)) expect(s, phase + state).not.toMatch(/\bnull\b|undefined|NaN/);
    }
  });
});

describe("Update: the request and what is said after it", () => {
  it("one POST to the repo's update route with no body, then the list is read again", async () => {
    expect(updateUrl(REPO_A)).toBe("/api/v1/engine/repos/" + REPO_A + "/update");
    const { t, log } = await carded({ behind: BEHIND, update: null });
    expect(await t.operate.startUpdate()).toBe(true);
    expect(log[0]).toEqual(["POST", "/api/v1/engine/repos/" + REPO_A + "/update", undefined]);
    expect(log.filter(([m]) => m === "POST")).toHaveLength(1);
    expect(log.some(([m, p]) => m === "GET" && p === REPOS_URL)).toBe(true);
    expect(t.view().updateCard.note).toBe("Started the update to v1.5.0.");
  });
  it("a start with an answer the app cannot read still says it started", async () => {
    const { t } = await carded({ behind: BEHIND, update: null }, { answer: { to_version: "<b>x</b>" } });
    await t.operate.startUpdate();
    expect(t.view().updateCard.note).toBe("Started the update.");
  });
  it("says each refusal in its own words, never the server's, and reads the list again after a 404 or a 409", async () => {
    const cases = [
      [e(403, "forbidden"), "Only an owner or admin can update the engine."],
      [e(404, "not_found"), "That project isn't installed any more."],
      [e(409, "not_behind"), "The engine is already up to date."],
      [e(409, "update_live"), "An update is already under way."],
      [e(409, "setup_not_placed"), "This project isn't on a machine."],
      [e(409, "setup_changed"), "A new version came out while we got ready. Try again."],
      [e(409, "something_new"), "That didn't send. Try again."],
      [e(503, "not_configured"), "Updating isn't available right now. Try again later."],
      [e(503, "forbidden"), "That didn't send. Try again."],
      [e(401, "unauthorized"), "Your session has ended. Sign in again."],
      [e(500, "server_error"), "That didn't send. Try again."],
      [Object.assign(new Error("network"), { status: 0 }), "That didn't send. Try again."],
    ];
    for (const [err, sentence] of cases) {
      const { t, log } = await carded({ behind: BEHIND, update: null }, { answer: err });
      expect(await t.operate.startUpdate(), sentence).toBe(false);
      expect(t.view().updateCard.note).toBe(sentence);
      expect(t.view().updateCard.note).not.toContain("server text");
      expect(t.state.op.updateBusy).toBe(false);
      expect(log.filter(([m, p]) => m === "GET" && p === REPOS_URL).length > 0, String(err.status) + err.code).toBe(err.status === 404 || err.status === 409);
    }
    expect(updateFailure(undefined)).toBe("That didn't send. Try again.");
  });
  it("shows Starting the update… while the call is out and ignores a second press", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const r = await carded({ behind: BEHIND, update: null });
    r.call.mockImplementation(async (method, path) => { if (method === "POST") { await gate; return { to_version: "1.5.0" }; } return path === REPOS_URL ? F.list([F.repo({ operate_enabled: true, engine_update: { behind: BEHIND, update: null } })]) : path === SETTINGS_URL ? F.settings({ operate_enabled: true }) : F.envelope([]); });
    const first = r.t.operate.startUpdate();
    expect(r.t.view().updateCard).toMatchObject({ label: "Starting the update…", busy: true });
    expect(await r.t.operate.startUpdate()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(r.call.mock.calls.filter(([m]) => m === "POST")).toHaveLength(1);
    expect(r.t.view().updateCard).toMatchObject({ label: "Update", busy: false });
  });
  it("nothing is sent for a member, a card with no offer, or an update already under way", async () => {
    const m = await carded({ behind: BEHIND, update: null }, { canEdit: false });
    expect(await m.t.operate.startUpdate()).toBe(false);
    const live = await carded(card());
    expect(await live.t.operate.startUpdate()).toBe(false);
    const none = await carded(null);
    expect(await none.t.operate.startUpdate()).toBe(false);
    expect([m.log, live.log, none.log]).toEqual([[], [], []]);
  });
  it("the note belongs to the repo it was made on", async () => {
    const r = await carded({ behind: BEHIND, update: null });
    await r.t.operate.startUpdate();
    r.t.state.op.updateRepo = "another-repo";
    expect(r.t.view().updateCard.note).toBe("");
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

describe("a click on Update", () => {
  beforeEach(() => {
    vi.stubGlobal("Node", FakeNode);
    vi.stubGlobal("document", { createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("calls start() with no argument, and one click is one POST through the real controller", async () => {
    const r = await carded({ behind: BEHIND, update: null });
    const start = vi.fn(() => r.t.operate.startUpdate());
    const nodes = updateNodes(r.t.view().updateCard, () => start());
    expect(byId(nodes, "tm-update-title")[0].textContent).toBe("Update available (v1.4.0 → v1.5.0)");
    const [btn] = byId(nodes, "tm-update-start");
    expect(btn.textContent).toBe("Update");
    expect(btn.attrs.disabled).toBeUndefined(); // an owner's button is not set disabled
    expect(btn.attrs["aria-disabled"]).toBe("false");
    btn.on.click({ type: "click", target: btn, isTrusted: true }); // the browser hands the handler an event; it must not reach the controller
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]).toEqual([]);
    expect(r.log.filter(([m]) => m === "POST")).toEqual([["POST", "/api/v1/engine/repos/" + REPO_A + "/update", undefined]]);
    expect(r.t.view().updateCard.note).toBe("Started the update to v1.5.0.");
  });
  it("a member's button is aria-disabled (never disabled) beside its line, and a click that reaches it makes no call", async () => {
    const r = await carded({ behind: BEHIND, update: null }, { canEdit: false });
    const nodes = updateNodes(r.t.view().updateCard, () => r.t.operate.startUpdate());
    const [btn] = byId(nodes, "tm-update-start");
    expect(btn.attrs["aria-disabled"]).toBe("true");
    expect(btn.attrs.disabled).toBeUndefined();
    expect(btn.getAttribute("aria-describedby")).toBe("tm-update-why");
    expect(byId(nodes, "tm-update-why")[0].textContent).toBe("Only an owner or admin can update the engine.");
    btn.on.click({ type: "click" });
    await flush();
    expect(r.log).toEqual([]);
  });
  it("while a call is out the button reads Starting the update… and a click does nothing", async () => {
    const v = describeEngineUpdate({ settings: { canEdit: true }, op: { updateBusy: true } }, { id: REPO_A, name: "a/b", operate: true, engineUpdate: readEngineUpdate({ behind: BEHIND, update: null }) });
    const start = vi.fn();
    const btn = byId(updateNodes(v, start), "tm-update-start")[0];
    expect(btn.textContent).toBe("Starting the update…");
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    btn.on.click();
    expect(start).not.toHaveBeenCalled();
  });
  it("an update under way draws its progress and a new-tab pull request link, and no button", async () => {
    const r = await carded(card({ update: upd({ phase: "await_merge", sub_step: "pr_open", state: "ok", pr: 41 }) }));
    const nodes = updateNodes(r.t.view().updateCard, () => {});
    expect(byId(nodes, "tm-update-text")[0].textContent).toBe("Step 3 of 4: Waiting for someone to merge the pull request.");
    expect(byId(nodes, "tm-update-start")).toHaveLength(0);
    const [a] = byId(nodes, "tm-update-pr");
    expect(a.attrs).toMatchObject({ target: "_blank", rel: "noopener noreferrer", href: "https://github.com/" + F.repo().full_name + "/pull/41" });
    expect(a.textContent).toBe("Pull request #41 (opens in a new tab)");
  });
  it("a failure draws its sentence and Try again", async () => {
    const r = await carded({ behind: BEHIND, update: upd({ phase: "failed", state: "failed", failure_code: "job_silent" }) });
    const nodes = updateNodes(r.t.view().updateCard, () => r.t.operate.startUpdate());
    expect(byId(nodes, "tm-update-text")[0].textContent).toBe("The update to v1.5.0 didn't finish (the machine went quiet).");
    expect(byId(nodes, "tm-update-start")[0].textContent).toBe("Try again");
  });
});
