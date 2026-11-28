// apps/workspace/test/team-next.test.mjs
//
// The Team app's next-step card (D#845 ON-14c): the repo list's `machine_name`, `setup`, `session` and `quota` facts choose one sentence and at most one button. Pinned: the fact reader,
// every chip row's exact copy and its action, who gets the button, the quota countdown, "Started fresh at HH:MM", the chip word of a stopped or starting session, the exact request each
// button makes and every refusal in fixed words, and a click on the real button (the page is driven on the built output in e2e/team.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPOS_URL, SETTINGS_URL, chipOf, createTeam, createTeamApi, describe as describeState, readRepos } from "../apps/team/team-model.js";
import { NEXT_WORDS, NO_OP, createOperate, describeNext, nextFailure, nextNodes, readFacts, untilWords } from "../apps/team/team-operate.js";
import { REPO_A, RUNNER_A, RUNNER_B, makeFixtures } from "./fixtures/team/fixtures.mjs";

const NOW = Date.parse("2026-11-16T15:00:00.000Z");
const F = makeFixtures(NOW);
const e = (status, code) => Object.assign(new Error("server text that must never be shown"), { status, code });
const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
const clock = (iso) => { const d = new Date(iso); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
const AT = "2026-11-16T14:30:00.000Z";
const NEXT_RESET = "2026-11-17T00:00:00.000Z";

const session = (state, over = {}) => ({ state, last_start_mode: "created", last_start_at: AT, stopped_reason: null, state_at: AT, ...over });
const setup = (status, over = {}) => ({ status, phase: status === "none" ? null : status === "done" ? "done" : "install", sub_step: null, state: status === "none" ? null : "ok", failure_code: null, ...over });
const quota = (state = "ok") => ({ state, session_used: state === "ok" ? 10 : 5000, session_limit: 5000, repo_used: state === "repo_full" ? 20000 : 10, repo_limit: 20000, resets_at: NEXT_RESET });
const item = (over = {}) => F.repo({ operate_enabled: true, machine_name: "Studio laptop", setup: setup("done"), session: session("running"), quota: quota(), ...over });

/** A Team on `repo`; `canEdit` false is a member. `routes` answers the POSTs; the others are the usual reads. */
async function rig(repo, { canEdit = true, role = "owner", watch = true, routes = {}, assign = vi.fn(), runners = F.fleet([F.runner(), F.runner({ id: RUNNER_B, name: "Garage box" })], role) } = {}) {
  const log = [];
  const table = {
    ["GET " + SETTINGS_URL]: F.settings({ can_edit: canEdit, operate_enabled: true, watch_enabled: watch }),
    ["GET " + REPOS_URL]: F.list([repo]),
    "GET /api/runners": runners,
    ...routes,
  };
  const call = vi.fn(async (method, path, body) => {
    log.push([method, path, body]);
    const r = table[method + " " + path];
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
  const t = createTeam({ client: createTeamApi(call), setTimer: () => 1, clearTimer: () => {}, setRepeat: () => 1, clearRepeat: () => {}, now: () => NOW, assign });
  await t.load();
  log.length = 0;
  t.view = () => describeState(t.state, NOW);
  return { t, log, call, table, assign };
}
const posts = (r) => r.log.filter(([m]) => m === "POST");

describe("the session facts", () => {
  it("are read as the closed shape; a list without them has no card", () => {
    expect(readFacts({})).toBeNull();
    expect(readFacts({ session: { state: "later" } })).toBeNull();
    expect(readRepos([{ repo_id: REPO_A, full_name: "a/b" }])[0].facts).toBeNull();
    expect(readFacts({ machine_name: "M", setup: setup("open"), session: session("never", { last_start_mode: "weird", stopped_reason: "weird" }), quota: quota("session_full") }))
      .toEqual({ machine: "M", setup: { status: "open", phase: "install", failed: false }, session: { state: "never", mode: "", startAt: AT, reason: "", at: AT }, quota: { state: "session_full", resetsAt: NEXT_RESET } });
    expect(readFacts({ session: session("running"), quota: { state: "ok", resets_at: "not a time" } }).quota).toBeNull();
  });
  it("a repo whose facts are missing draws no card and keeps the old chip", async () => {
    const r = await rig(F.repo({ operate_enabled: true }));
    delete r.table["GET " + REPOS_URL].items[0].session;
    await r.t.load();
    expect(r.t.view().next).toBeNull();
  });
});

describe("the chip rows: exact copy and action", () => {
  const rows = [
    ["never + an open setup", { liveness: "never", setup: setup("open", { phase: "install" }), session: session("never", { last_start_at: null, state_at: null }) }, "Setting up: installing the engine", "onboarding", "Open Onboarding", ""],
    ["never + an open setup that failed", { liveness: "never", setup: setup("open", { phase: "plan", state: "failed", failure_code: "plan_failed" }), session: session("never") }, "Setting up: writing the plan (it stopped; open Onboarding to try again)", "onboarding", "Open Onboarding", ""],
    ["never + no setup", { liveness: "never", setup: setup("none"), session: session("never") }, "This repo isn't set up on a machine yet", "setup", "Set up the engine", NEXT_WORDS.ask.setup],
    ["never + setup done, operate off", { liveness: "never", operate_enabled: false, setup: setup("done"), session: session("never") }, "Operate is off, so the engine isn't running on Studio laptop", "operate", "Turn on operate", NEXT_WORDS.ask.turnOn],
    ["never + setup done, operate on", { liveness: "never", setup: setup("done"), session: session("never") }, "The engine isn't running on Studio laptop", "start", "Start engine", NEXT_WORDS.ask.start],
    ["stale", { liveness: "stale", session: session("stale") }, "Start the runner on Studio laptop", "machines", "Open Machines", ""],
    ["runner_removed", { liveness: "runner_removed", session: session("runner_removed") }, "Its machine was removed", "move", "Move to another machine", NEXT_WORDS.ask.move],
    ["session stopped by a person", { session: session("stopped", { stopped_reason: "person" }) }, "Stopped " + clock(AT), "start", "Start engine", NEXT_WORDS.ask.start],
    ["session stopped by a halt", { session: session("stopped", { stopped_reason: "halt" }) }, "Stopped " + clock(AT), "start", "Start engine", NEXT_WORDS.ask.start],
    ["session halted", { halted: true, session: session("halted") }, "Stopped " + clock(AT), "start", "Start engine", NEXT_WORDS.ask.start],
    ["session stopped, operate off", { session: session("stopped", { stopped_reason: "operate_off" }) }, "Stopped at " + clock(AT) + " because operate was turned off", "operate", "Turn on operate", NEXT_WORDS.ask.turnOn],
    ["session stopped, plan ended", { session: session("stopped", { stopped_reason: "plan" }) }, "Plan ended: the engine is stopped", "renew", "Renew", NEXT_WORDS.ask.renew],
    ["session starting", { session: session("starting") }, "Starting the engine on Studio laptop…", null, "", ""],
  ];
  for (const [name, over, text, action, label, ask] of rows) {
    it(`${name}: "${text}"`, async () => {
      const r = await rig(item(over));
      const nx = r.t.view().next;
      expect(nx.text).toBe(text);
      expect(nx.action).toEqual(action ? { id: action, label } : null);
      expect(nx.ask).toBe("");
      // A member sees the same sentence; a row that needs an owner or admin loses its button and says so.
      const m = await rig(item(over), { canEdit: false });
      const mn = m.t.view().next;
      expect(mn.text).toBe(text);
      if (ask === "") expect(mn.action).toEqual(nx.action);
      else { expect(mn.action).toBeNull(); expect(mn.ask).toBe(ask); }
    });
  }
  it("a running engine has no sentence, and an unknown machine name falls back to words without one", async () => {
    expect((await rig(item())).t.view().next).toBeNull();
    expect((await rig(item({ liveness: "stale", machine_name: null, session: session("stale") }))).t.view().next.text).toBe("Start the runner on your machine");
    expect((await rig(item({ session: session("starting"), machine_name: null }))).t.view().next.text).toBe("Starting the engine…");
    expect((await rig(item({ liveness: "never", machine_name: null, setup: setup("done"), session: session("never") }))).t.view().next.text).toBe("The engine isn't running");
    expect((await rig(item({ liveness: "never", operate_enabled: false, machine_name: null, setup: setup("done"), session: session("never") }))).t.view().next.text).toBe("Operate is off, so the engine isn't running");
  });
  it("the operate-off line and the member's ask read exactly as specified", async () => {
    const m = await rig(item({ liveness: "never", operate_enabled: false, setup: setup("done"), session: session("never") }), { canEdit: false });
    expect(m.t.view().next.ask).toBe("Ask an owner or admin to turn on operate");
  });
});

describe("operate off while a cloud session is listed", () => {
  const off = (over) => item({ operate_enabled: false, ...over });
  const OFF_LINE = "Operate is off, so the engine isn't running on Studio laptop";
  it("a stale session says it is stopping when the machine comes back, with no button and no Live or Stale chip", async () => {
    const r = await rig(off({ liveness: "stale", last_heard_at: AT, session: session("stale") }));
    const nx = r.t.view().next;
    expect(nx.text).toBe("Stopping when Studio laptop comes back");
    expect(nx.action).toBeNull();
    expect(nx.ask).toBe("");
    expect(r.t.view().chip).toBe("Operate off");
  });
  it("a running session says operate is off and offers Turn on operate; the chip is never Live", async () => {
    const r = await rig(off({ liveness: "live", session: session("running") }));
    expect(r.t.view().next.text).toBe(OFF_LINE);
    expect(r.t.view().next.action).toEqual({ id: "operate", label: "Turn on operate" });
    expect(r.t.view().chip).toBe("Operate off");
    expect((await rig(off({ liveness: "live", session: session("running") }), { canEdit: false })).t.view().next).toMatchObject({ action: null, ask: "Ask an owner or admin to turn on operate" });
  });
  for (const reason of ["person", "halt", "move"]) {
    it(`stopped by ${reason}: Turn on operate, never Start engine (the start route answers 409 operate_off)`, async () => {
      const r = await rig(off({ session: session("stopped", { stopped_reason: reason }) }));
      expect(r.t.view().next.text).toBe(OFF_LINE);
      expect(r.t.view().next.action).toEqual({ id: "operate", label: "Turn on operate" });
      expect(r.t.view().chip).toBe("Stopped");
      expect((await rig(off({ session: session("stopped", { stopped_reason: reason }) }), { canEdit: false })).t.view().next).toMatchObject({ action: null, ask: "Ask an owner or admin to turn on operate" });
    });
  }
  it("a halted or removed-machine repo with operate off also gets Turn on operate, not Start or Move", async () => {
    expect((await rig(off({ halted: true, session: session("halted") }))).t.view().next.action.id).toBe("operate");
    const gone = (await rig(off({ liveness: "runner_removed", session: session("runner_removed") }))).t.view().next;
    expect(gone.action.id).toBe("operate");
    expect(gone.text).toBe("Its machine was removed, and operate is off");
  });
  it("a plan that ended still says so, with Renew", async () => {
    expect((await rig(off({ session: session("stopped", { stopped_reason: "plan" }) }))).t.view().next.action).toEqual({ id: "renew", label: "Renew" });
  });
  it("a watch-only repo (no sandbox listed) keeps its Live chip and has no card", async () => {
    const r = await rig(F.repo({ operate_enabled: false }));
    expect(r.t.view().chip).toBe("Live");
    expect(r.t.view().next).toBeNull();
  });
  it("a removed project stops without a Start engine button", async () => {
    const nx = (await rig(item({ session: session("stopped", { stopped_reason: "remove" }) }))).t.view().next;
    expect(nx.text).toBe("Stopped " + clock(AT));
    expect(nx.action).toBeNull();
  });
});

describe("Renew is for an owner", () => {
  const plan = () => item({ session: session("stopped", { stopped_reason: "plan" }) });
  it("an owner gets the button; an admin gets the ask line and no button", async () => {
    expect((await rig(plan(), { role: "owner" })).t.view().next).toMatchObject({ action: { id: "renew", label: "Renew" }, ask: "" });
    expect((await rig(plan(), { role: "admin" })).t.view().next).toMatchObject({ action: null, ask: "Ask an owner to renew the plan" });
    expect((await rig(plan(), { canEdit: false, role: "member" })).t.view().next).toMatchObject({ action: null, ask: "Ask an owner to renew the plan" });
  });
  it("a role that could not be read shows no button", async () => {
    const r = await rig(plan(), { runners: e(500, "x") });
    expect(r.t.view().next).toMatchObject({ action: null, ask: "Ask an owner to renew the plan" });
  });
  it("a 403 from checkout is said in owner-only words", async () => {
    const r = await rig(plan(), { routes: { "POST /api/v1/billing/checkout-session": e(403, "forbidden") } });
    expect(await r.t.operate.renew()).toBe(false);
    expect(r.t.view().next.note).toBe("Only an owner can renew the plan.");
  });
});

describe("Turn on operate from the card", () => {
  it("saves the switch, and a member's press sends nothing", async () => {
    const r = await rig(item({ liveness: "never", operate_enabled: false, setup: setup("done"), session: session("never") }), { routes: { ["PUT " + SETTINGS_URL]: {} } });
    await r.t.operate.turnOnOperate();
    expect(r.log.filter(([m]) => m === "PUT")).toEqual([["PUT", SETTINGS_URL, { operate_enabled: true }]]);
    const m = await rig(item({ liveness: "never", operate_enabled: false, setup: setup("done"), session: session("never") }), { canEdit: false });
    expect(await m.t.operate.turnOnOperate()).toBe(false);
    expect(m.log).toEqual([]);
  });
});

describe("Turn on operate says why it cannot act", () => {
  const harness = (settings, op) => {
    let st = { settings, repos: [{ id: REPO_A }], selectedId: REPO_A, saving: false, op: { ...NO_OP, ...op } };
    const ops = createOperate({ client: {}, signal: undefined, get: () => st, set: (p) => { st = { ...st, ...p }; }, refresh: async () => {}, aborted: () => false });
    return { ops, state: () => st };
  };
  it("with engine watch off it says to turn watch on first, and sends nothing", async () => {
    const h = harness({ canEdit: true, watch: false }, {});
    expect(await h.ops.turnOnOperate()).toBe(false);
    expect(h.state().op).toMatchObject({ nextRepo: REPO_A, nextNote: "Turn on engine watch first." });
  });
  it("while a save is out it says so, and sends nothing", async () => {
    const h = harness({ canEdit: true, watch: true }, { saving: true });
    expect(await h.ops.turnOnOperate()).toBe(false);
    expect(h.state().op.nextNote).toBe("A change is being saved. Try again in a moment.");
  });
});

describe("started fresh, and the event limit", () => {
  it("a running session that came up fresh says so, with the time of the start", async () => {
    const nx = (await rig(item({ session: session("running", { last_start_mode: "fresh" }) }))).t.view().next;
    expect(nx.fresh).toBe("Started fresh at " + clock(AT));
    expect(nx.parts).toEqual([]);
    for (const mode of ["created", "resumed"]) expect((await rig(item({ session: session("running", { last_start_mode: mode }) }))).t.view().next).toBeNull();
    expect((await rig(item({ session: session("stopped", { last_start_mode: "fresh", stopped_reason: "person" }) }))).t.view().next.fresh).toBe("");
  });
  it("the quota chip counts down to 00:00 UTC for a full session and a full repo", async () => {
    for (const state of ["session_full", "repo_full"]) {
      const nx = (await rig(item({ quota: quota(state) }))).t.view().next;
      expect(nx.quota).toBe("Today's event limit is reached. Updates resume at 00:00 UTC (in 9 h)");
    }
    expect((await rig(item({ quota: quota("ok") }))).t.view().next).toBeNull();
  });
  it("the countdown is hours, minutes in the last hour, and under a minute; each rounded up", () => {
    const at = (ms) => untilWords(NEXT_RESET, Date.parse(NEXT_RESET) - ms);
    expect(at(9 * 3600e3)).toBe("in 9 h");
    expect(at(9 * 3600e3 - 1)).toBe("in 9 h");
    expect(at(3600e3 + 1)).toBe("in 2 h");
    expect(at(3600e3)).toBe("in 1 h");
    expect(at(3600e3 - 1)).toBe("in 60 min");
    expect(at(58 * 60e3)).toBe("in 58 min");
    expect(at(60e3)).toBe("in 1 min");
    expect(at(59e3)).toBe("in under a minute");
    expect(at(30e3)).toBe("in under a minute");
    expect(at(0)).toBe("in under a minute");
    expect(at(-5)).toBe("in under a minute");
  });
  it("pinned UTC clocks: 22:00, 23:02, 23:59:30 and 00:00:01 each read to the next 00:00 UTC", () => {
    const at = (clock) => untilWords("2026-11-17T00:00:00.000Z", Date.parse(clock));
    expect(at("2026-11-16T22:00:00Z")).toBe("in 2 h");
    expect(at("2026-11-16T23:02:00Z")).toBe("in 58 min");
    expect(at("2026-11-16T23:59:30Z")).toBe("in under a minute");
    expect(at("2026-11-17T00:00:01Z")).toBe("in under a minute"); // the day has turned: the cloud's next read resets the counter
  });
  it("a full quota shows beside a next step, and on a running engine", async () => {
    const nx = (await rig(item({ session: session("stopped", { stopped_reason: "plan" }), quota: quota("repo_full") }))).t.view().next;
    expect(nx.text).toBe("Plan ended: the engine is stopped");
    expect(nx.quota).toContain("Today's event limit is reached");
  });
});

describe("the chip word", () => {
  it("a stopped or starting session is never Live or Stale", async () => {
    expect(chipOf(readRepos([item({ liveness: "live", session: session("stopped", { stopped_reason: "person" }) })])[0])).toBe("Stopped");
    expect(chipOf(readRepos([item({ liveness: "stale", session: session("starting") })])[0])).toBe("Starting");
    expect(chipOf(readRepos([item({ liveness: "live", session: session("running") })])[0])).toBe("Live");
    expect(chipOf(readRepos([item({ liveness: "stale", session: session("stale"), last_heard_at: AT })])[0])).toBe("Stale since " + clock(AT));
    expect(chipOf(readRepos([item({ liveness: "never", session: session("never") })])[0])).toBe("Never connected");
  });
});

describe("the buttons", () => {
  const START = "/api/v1/engine/repos/" + REPO_A + "/start";
  const stopped = () => item({ session: session("stopped", { stopped_reason: "person" }) });
  it("Start engine sends one POST with no body, says so, and reads the list again", async () => {
    const r = await rig(stopped(), { routes: { ["POST " + START]: { job_id: "j1", kind: "engine_session_start", operate_epoch: 1, already_issued: false } } });
    expect(await r.t.operate.startEngine()).toBe(true);
    expect(posts(r)).toEqual([["POST", START, undefined]]);
    expect(r.t.view().next.note).toBe("Asked the machine to start the engine.");
    expect(r.log.some(([m, p]) => m === "GET" && p === REPOS_URL)).toBe(true);
  });
  it("an answer that was already issued says a start is on its way", async () => {
    const r = await rig(stopped(), { routes: { ["POST " + START]: { job_id: "j1", kind: "engine_session_start", operate_epoch: 1, already_issued: true } } });
    await r.t.operate.startEngine();
    expect(r.t.view().next.note).toBe("A start is already on its way.");
  });
  it("every refusal is said in fixed words, never the server's", async () => {
    const cases = [
      [e(402, "plan_required"), "The engine needs the Engine plan. Choose it in Onboarding."], [e(402, "engine_quantity"), "Every engine on your plan is in use. Add an engine in Onboarding."],
      [e(402, "plan_ended"), "The Engine plan ended. Renew it first."], [e(402, "account_held"), "This account is on hold."],
      [e(409, "operate_off"), "Operate is off. Turn it on first."], [e(409, "start_pending"), "A start is already waiting for the machine."], [e(409, "not_placed"), "This project isn't on a machine."],
      [e(409, "machine_single_project"), "That machine can't take the project right now. Pick another."], [e(409, "project_not_placed"), "This project isn't on a machine."], [e(409, "placement_busy"), "That didn't go through. Try again."],
      [e(403, "forbidden"), "Only an owner or admin can do that."], [e(404, "not_found"), "That repository or machine no longer exists."], [e(401, "x"), "Your session has ended. Sign in again."],
      [e(500, "something_new"), "That didn't go through. Try again."], [e(409, "constructor"), "That didn't go through. Try again."],
    ];
    for (const [err, sentence] of cases) {
      const r = await rig(stopped(), { routes: { ["POST " + START]: err } });
      expect(await r.t.operate.startEngine(), sentence).toBe(false);
      expect(r.t.view().next.note).toBe(sentence);
      expect(r.t.view().next.note).not.toContain("server text");
      expect(r.t.state.op.nextBusy).toBe(false);
    }
    expect(nextFailure(undefined)).toBe("That didn't go through. Try again.");
  });
  it("a member's press sends nothing, and a second press while a call is out is ignored", async () => {
    const m = await rig(stopped(), { canEdit: false });
    expect(await m.t.operate.startEngine()).toBe(false);
    expect(await m.t.operate.renew()).toBe(false);
    expect(await m.t.operate.askMove()).toBe(false);
    expect(m.log).toEqual([]);
    let release;
    const gate = new Promise((x) => { release = x; });
    const r = await rig(stopped());
    r.call.mockImplementation(async (method, path) => { if (method === "POST") { await gate; return { job_id: "j", already_issued: false }; } return path === REPOS_URL ? F.list([stopped()]) : path === SETTINGS_URL ? F.settings({ operate_enabled: true }) : F.envelope([]); });
    const first = r.t.operate.startEngine();
    expect(r.t.view().next.busy).toBe(true);
    expect(await r.t.operate.startEngine()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(r.call.mock.calls.filter(([m2]) => m2 === "POST")).toHaveLength(1);
  });
  it("Turn on operate saves the account switch through the settings route", async () => {
    const r = await rig(item({ liveness: "never", operate_enabled: false, setup: setup("done"), session: session("never") }), { routes: { ["PUT " + SETTINGS_URL]: {} } });
    await r.t.operate.setOperate(true);
    expect(r.log.filter(([m]) => m === "PUT")).toEqual([["PUT", SETTINGS_URL, { operate_enabled: true }]]);
  });
  it("Renew calls the checkout route the Onboarding Renew uses, and follows only an https address", async () => {
    const CHECKOUT = "POST /api/v1/billing/checkout-session";
    const plan = () => item({ session: session("stopped", { stopped_reason: "plan" }) });
    const assign = vi.fn();
    const url = await rig(plan(), { assign, routes: { [CHECKOUT]: { url: "https://pay.example.test/c/1" } } });
    expect(await url.t.operate.renew()).toBe(true);
    expect(posts(url)).toEqual([["POST", "/api/v1/billing/checkout-session", { plan: "engine", quantity: 1, success_path: "/", cancel_path: "/" }]]);
    expect(assign.mock.calls).toEqual([["https://pay.example.test/c/1"]]);
    for (const [answer, sentence] of [[{ already_held: true }, "You already have the Engine plan."], [{ added: true }, "Engine added. This updates when the provider confirms the change."], [{ url: "http://insecure.example.test" }, "That didn't go through. Try again."], [{}, "That didn't go through. Try again."]]) {
      const r = await rig(plan(), { assign, routes: { [CHECKOUT]: answer } });
      await r.t.operate.renew();
      expect(r.t.view().next.note, JSON.stringify(answer)).toBe(sentence);
    }
    const r = await rig(plan(), { assign, routes: { [CHECKOUT]: e(409, "already_subscribed") } });
    expect(await r.t.operate.renew()).toBe(false);
    expect(r.t.view().next.note).toBe("That didn't go through. Try again.");
    expect(assign).toHaveBeenCalledTimes(1); // only the https answer above followed a link
  });
  it("Move reads the machines, offers only online ones, and sends the chosen one", async () => {
    const MOVE = "/api/runners/repos/" + REPO_A + "/move";
    const gone = () => item({ liveness: "runner_removed", session: session("runner_removed") });
    const runners = F.fleet([F.runner({ id: RUNNER_A, name: "Workshop laptop" }), F.runner({ id: RUNNER_B, name: "Garage box", state: "busy" }), F.runner({ id: "9d2c7b1e-5f3a-4e8b-8a6d-1c2b3a4d5e88", name: "Old desktop", state: "offline" }), F.runner({ id: "9d2c7b1e-5f3a-4e8b-8a6d-1c2b3a4d5e99", name: "Paused box", state: "paused" })]);
    const r = await rig(gone(), { runners, routes: { ["POST " + MOVE]: { repo_id: REPO_A, from_runner_id: null, to_runner_id: RUNNER_B, old_copy: "none" } } });
    await r.t.operate.askMove();
    expect(r.t.view().next.move).toEqual({ loading: false, choices: [{ id: RUNNER_A, name: "Workshop laptop" }, { id: RUNNER_B, name: "Garage box" }], pick: RUNNER_A });
    expect(r.t.view().next.action).toBeNull(); // the picker replaces the button
    r.t.operate.pickMove("not-a-listed-machine");
    expect(r.t.view().next.move.pick).toBe(RUNNER_A);
    r.t.operate.pickMove(RUNNER_B);
    expect(await r.t.operate.moveNow()).toBe(true);
    expect(posts(r)).toEqual([["POST", MOVE, { to_runner_id: RUNNER_B }]]);
    expect(r.t.view().next.note).toBe("Moved. The engine starts on the new machine.");
    expect(r.t.view().next.move).toBeNull();
  });
  it("Move with no machine online says so and can be cancelled; a refused move keeps the picker with its sentence", async () => {
    const MOVE = "/api/runners/repos/" + REPO_A + "/move";
    const gone = () => item({ liveness: "runner_removed", session: session("runner_removed") });
    const none = await rig(gone(), { runners: F.fleet([F.runner({ state: "offline" })]) });
    await none.t.operate.askMove();
    expect(none.t.view().next.move.choices).toEqual([]);
    expect(await none.t.operate.moveNow()).toBe(false);
    none.t.operate.cancelMove();
    expect(none.t.view().next.move).toBeNull();
    expect(posts(none)).toEqual([]);
    const refused = await rig(gone(), { routes: { ["POST " + MOVE]: e(409, "machine_single_project") } });
    await refused.t.operate.askMove();
    expect(await refused.t.operate.moveNow()).toBe(false);
    expect(refused.t.view().next.note).toBe("That machine can't take the project right now. Pick another.");
    expect(refused.t.view().next.move).not.toBeNull();
    const down = await rig(gone());
    down.table["GET /api/runners"] = e(500, "x");
    await down.t.operate.askMove();
    expect(down.t.view().next.move).toMatchObject({ loading: false, choices: [] });
  });
});

describe("what is drawn", () => {
  const strs = (v) => strings(v);
  it("no null, undefined or NaN reaches a sentence, whatever is missing", async () => {
    for (const over of [{ session: session("stopped", { stopped_reason: null, state_at: null }) }, { session: session("running", { last_start_mode: "fresh", last_start_at: null }) }, { machine_name: null, session: session("starting") }, { quota: { ...quota("repo_full"), resets_at: NEXT_RESET }, session: session("never"), setup: { status: "open", phase: null, state: null } }]) {
      const nx = (await rig(item(over))).t.view().next;
      for (const s of strs(nx ?? {})) expect(s).not.toMatch(/null|undefined|NaN/);
    }
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
describe("nodes", () => {
  beforeEach(() => {
    vi.stubGlobal("Node", FakeNode);
    vi.stubGlobal("document", { createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }) });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("the button calls go with its action id and no event; a name stays text in its own run", async () => {
    const r = await rig(item({ machine_name: "<img src=x onerror=alert(1)>", liveness: "never", setup: setup("done"), session: session("never") }));
    const go = vi.fn();
    const nodes = nextNodes(r.t.view().next, go, {});
    const [text] = byId(nodes, "tm-next-text");
    expect(text.textContent).toBe("The engine isn't running on <img src=x onerror=alert(1)>");
    expect(findAll(text, (x) => x.tag === "bdi")).toHaveLength(1);
    expect(findAll(text, (x) => x.tag === "img")).toHaveLength(0);
    const [btn] = byId(nodes, "tm-next-start");
    expect(btn.textContent).toBe("Start engine");
    btn.on.click({ type: "click", isTrusted: true });
    expect(go.mock.calls).toEqual([["start"]]);
  });
  it("a busy button keeps its place in the Tab order and ignores a click; the move picker names its machines", async () => {
    const busy = { ...describeNext({ settings: { canEdit: true }, op: { nextBusy: true, nextRepo: REPO_A, nextNote: "", move: null } }, readRepos([item({ liveness: "runner_removed", session: session("runner_removed") })])[0], NOW) };
    const go = vi.fn();
    const [, btn] = nextNodes(busy, go, {});
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.attrs.disabled).toBeUndefined();
    btn.on.click();
    expect(go).not.toHaveBeenCalled();
    const mv = { pick: vi.fn(), go: vi.fn(), cancel: vi.fn() };
    const picking = { ...busy, busy: false, action: null, move: { loading: false, choices: [{ id: RUNNER_A, name: "Workshop laptop" }, { id: RUNNER_B, name: "Garage box" }], pick: RUNNER_A } };
    const nodes = nextNodes(picking, go, mv);
    expect(byId(nodes, "tm-move")[0].getAttribute("aria-label")).toBe("Move to another machine");
    expect(findAll(byId(nodes, "tm-move-pick")[0], (x) => x.tag === "option").map((o) => o.textContent)).toEqual(["Workshop laptop", "Garage box"]);
    byId(nodes, "tm-move-go")[0].on.click();
    byId(nodes, "tm-move-cancel")[0].on.click();
    expect(mv.go).toHaveBeenCalledTimes(1);
    expect(mv.cancel).toHaveBeenCalledTimes(1);
  });
});
