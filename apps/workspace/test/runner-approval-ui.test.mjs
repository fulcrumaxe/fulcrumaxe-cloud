// apps/workspace/test/runner-approval-ui.test.mjs
//
// D#6 R2b-4b: the runner approval screens. The Pipeline Runs row and card label, the Runs app's detail, and the Repos app's Runners
// section and runner-run setting. Controllers run against a fake call(); the few views that are plain h() trees run against a small
// stand-in for the DOM calls they make (no jsdom here). The real pages are driven on the built output in e2e/runner-approval.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVALS_POLL_MS, APPROVING, RUN_APPROVALS_PATH, RUNNERS_PATH, approvalParts, autoText, createApprovals, readApprovalCopy, readApprovals, runApprovePath, waitingText,
} from "../apps/pipeline/pipeline-actions.js";
import { approvalLine, approveRunnerRun, loadRunApproval } from "../apps/runs/runs-storage.js";
import {
  CONSENT_SENTENCES, DIAL_SENTENCES, DISPOSITIONS, OFF_QUESTION, SWITCH_LABEL, consentUrl, createConsentFlow, createDialController, dialUrl, readCopy, readRunner, runnerRow, sourceWords,
} from "../apps/repos/repos-runners.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const RUN2 = "11111111-1111-4111-8111-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const REPO = "99999999-9999-4999-8999-999999999999";
const COPY = {
  approval: "Waiting for {person} to approve (it runs on their Claude plan).",
  approvalMine: "This run needs your approval. It runs on your Claude plan.",
  approvalButton: "Approve run",
  approvalDone: "Approved. Waiting for your runner.",
  approvalRefused: "This run can no longer be approved.",
  approvalAuto: "Approved automatically. It runs on {person}'s Claude plan.",
  planConsentText: "Let work on this runner's repos run on my Claude plan without asking each time.",
  dialRunnerRuns: "Runner runs on a member's plan",
  dialRunnerRunsAsk: "Ask each run",
  dialRunnerRunsAnnounce: "Approve and tell me",
  dialRunnerRunsAct: "Approve without asking",
};
const fail = (status, code) => Object.assign(new Error("server text that must never be shown"), { status, code });
const flush = () => new Promise((r) => setTimeout(r, 0));
const entry = (over = {}) => ({ run_id: RUN, work_item_id: null, role: "executor", repo_name: "a/b", created_at: "2026-10-09T00:00:00.000Z", approvers: [{ id: ME, name: "Ada Admin" }], can_approve: true, ...over });

/** A call() that answers by "METHOD path"; a function value is called each time, an Error is thrown. */
function fakeCall(routes) {
  const log = [];
  const call = vi.fn(async (method, path, body) => {
    log.push([method, path, body]);
    const r = routes[method + " " + path];
    if (r === undefined) throw fail(404, "not_found");
    const v = typeof r === "function" ? r() : r;
    if (v instanceof Error) throw v;
    return v;
  });
  call.log = log;
  return call;
}
const sent = (call, method) => call.log.filter((a) => a[0] === method);

// ── a stand-in for the DOM calls h() makes ─────────────────────────────────
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
const byTest = (nodes, id) => nodes.flatMap((n) => findAll(n, (e) => e.getAttribute("data-testid") === id))[0];
const allText = (nodes) => nodes.map((n) => n.textContent).join(" | ");
beforeEach(() => {
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("document", { createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }) });
});
afterEach(() => vi.unstubAllGlobals());

describe("reading the answers", () => {
  it("copy is all or nothing, and approvals keep only valid runs with named approvers", () => {
    expect(readApprovalCopy({ copy: COPY })).toEqual({ ...Object.fromEntries(Object.entries(COPY).filter(([k]) => k.startsWith("approval"))) });
    expect(readApprovalCopy({ copy: { ...COPY, approvalAuto: "" } })).toBeNull();
    expect(readApprovalCopy(null)).toBeNull();
    const m = readApprovals({ approvals: [entry({ approvers: [{ id: ME, name: "  " }, { id: ME, name: "Bo" }, { id: ME }] }), entry({ run_id: "not-a-uuid" }), null] });
    expect([...m.keys()]).toEqual([RUN]);
    expect(m.get(RUN)).toEqual({ canApprove: true, names: ["Bo"] });
    expect(readApprovals({}).size).toBe(0);
  });

  it("the waiting sentence is yours for an approver and names the people for everyone else; a name is never parsed", () => {
    expect(waitingText({ canApprove: true, names: ["Ada"] }, COPY)).toBe(COPY.approvalMine);
    expect(waitingText({ canApprove: false, names: ["Ada", "Bo"] }, COPY)).toBe("Waiting for Ada or Bo to approve (it runs on their Claude plan).");
    expect(waitingText({ canApprove: false, names: ["$& {person}"] }, COPY)).toBe("Waiting for $& {person} to approve (it runs on their Claude plan).");
    expect(waitingText({ canApprove: false, names: [] }, COPY)).toBeNull();
    expect(waitingText(null, COPY)).toBeNull();
  });

  it("an automatic approval names the person; no row shows null, undefined or an id in place of a name", () => {
    expect(autoText({ approval: "auto", approved_by: { id: ME, name: "Ada Admin" } }, COPY)).toBe("Approved automatically. It runs on Ada Admin's Claude plan.");
    for (const run of [{ approval: "auto", approved_by: { id: ME, name: "" } }, { approval: "auto", approved_by: null }, { approval: "manual", approved_by: { id: ME, name: "Ada" } }, { approval: null, approved_by: null }, {}]) {
      expect(autoText(run, COPY), JSON.stringify(run)).toBeNull();
    }
    expect(autoText({ approval: "auto", approved_by: { id: ME, name: "Ada" } }, null)).toBeNull();
  });
});

describe("Pipeline: the approvals read", () => {
  const make = (routes, opts = {}) => {
    const onChange = vi.fn();
    const call = fakeCall({ [`GET ${RUNNERS_PATH}`]: { runners: [], copy: COPY }, ...routes });
    return { call, onChange, a: createApprovals({ call, onChange, ...opts }) };
  };
  const pending = [{ id: RUN, role: "executor", status: "pending", approval: null, approved_by: null }];

  it("reads the approvals only when a run is pending, and only then fetches the copy", async () => {
    const { call, a } = make({ [`GET ${RUN_APPROVALS_PATH}`]: { approvals: [entry()] } });
    a.sync([{ id: RUN, role: "executor", status: "succeeded" }]);
    await flush();
    expect(call.log).toEqual([]);
    a.sync(pending);
    await flush();
    expect(call.log.map((c) => c[1])).toEqual([RUN_APPROVALS_PATH, RUNNERS_PATH]);
    expect(a.entryFor(RUN).canApprove).toBe(true);
    expect(a.label(pending)).toBe(COPY.approvalMine);
    a.destroy();
  });

  it("a run that waits for someone else shows their name on the card; a run no runner covers is not listed and shows nothing", async () => {
    const { a } = make({ [`GET ${RUN_APPROVALS_PATH}`]: { approvals: [entry({ can_approve: false, approvers: [{ id: "x", name: "Bo" }] })] } });
    a.sync([...pending, { id: RUN2, role: "code-reviewer", status: "pending" }]);
    await flush();
    expect(a.label([{ id: RUN2, status: "pending" }])).toBeNull(); // not in the read: no runner covers it, or the dial lets it run
    expect(a.label(pending)).toBe("Waiting for Bo to approve (it runs on their Claude plan).");
    expect(allText(approvalParts({ id: RUN2, role: "code-reviewer", status: "pending" }, a))).toBe("");
    a.destroy();
  });

  it("a click is one POST even when pressed twice; 200 shows the done sentence once the run stops waiting", async () => {
    let waiting = true;
    const { call, a } = make({
      [`GET ${RUN_APPROVALS_PATH}`]: () => ({ approvals: waiting ? [entry()] : [] }),
      [`POST ${runApprovePath(RUN)}`]: () => ((waiting = false), { changed: true }),
    });
    a.sync(pending);
    await flush();
    const run = pending[0];
    const btn = byTest(approvalParts(run, a), "pl-approve-run");
    expect(btn.getAttribute("aria-label")).toBe("Approve run: executor");
    expect(btn.textContent).toBe("Approve run");
    btn.on.click();
    btn.on.click();
    await flush();
    expect(sent(call, "POST")).toHaveLength(1);
    expect(sent(call, "POST")[0][2]).toBeUndefined(); // the route takes no body
    expect(byTest(approvalParts(run, a), "pl-approve-run")).toBeUndefined();
    expect(byTest(approvalParts(run, a), "pl-run-approval-note").textContent).toBe(COPY.approvalDone);
    expect(a.label(pending)).toBeNull();
    a.destroy();
  });

  it("while sending the button says Approving and a second press does nothing", async () => {
    let release;
    const { call, a } = make({ [`GET ${RUN_APPROVALS_PATH}`]: { approvals: [entry()] }, [`POST ${runApprovePath(RUN)}`]: () => new Promise((r) => (release = r)) });
    a.sync(pending);
    await flush();
    const p = a.approve(RUN);
    await flush();
    const btn = byTest(approvalParts(pending[0], a), "pl-approve-run");
    expect(btn.textContent).toBe(APPROVING);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    await a.approve(RUN);
    expect(sent(call, "POST")).toHaveLength(1);
    release({});
    await p;
    a.destroy();
  });

  it.each([403, 409])("%i shows the refusal sentence, never the server's, and reads the approvals again", async (status) => {
    const { call, a } = make({ [`GET ${RUN_APPROVALS_PATH}`]: { approvals: [entry()] }, [`POST ${runApprovePath(RUN)}`]: fail(status, "runner_not_for_repo") });
    a.sync(pending);
    await flush();
    const reads = sent(call, "GET").filter((c) => c[1] === RUN_APPROVALS_PATH).length;
    await a.approve(RUN);
    expect(sent(call, "GET").filter((c) => c[1] === RUN_APPROVALS_PATH).length).toBe(reads + 1);
    const text = allText(approvalParts(pending[0], a));
    expect(text).toContain(COPY.approvalRefused);
    expect(text).not.toContain("server text");
    a.destroy();
  });

  it("any other failure says nothing was changed, and a second click can try again", async () => {
    const { call, a } = make({ [`GET ${RUN_APPROVALS_PATH}`]: { approvals: [entry()] }, [`POST ${runApprovePath(RUN)}`]: fail(500, "server_error") });
    a.sync(pending);
    await flush();
    await a.approve(RUN);
    expect(allText(approvalParts(pending[0], a))).toContain("That didn't work. Nothing was changed.");
    await a.approve(RUN);
    expect(sent(call, "POST")).toHaveLength(2);
    a.destroy();
  });

  it("polls every 30 seconds only while a run is shown as waiting, and stops on destroy", async () => {
    const timers = [];
    const setTimer = vi.fn((fn, ms) => (timers.push({ fn, ms }), timers.length));
    const clearTimer = vi.fn();
    let list = [entry()];
    const { a } = make({ [`GET ${RUN_APPROVALS_PATH}`]: () => ({ approvals: list }) }, { setTimer, clearTimer });
    a.sync(pending);
    await flush();
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(timers[0].ms).toBe(APPROVALS_POLL_MS);
    list = [];
    await timers[0].fn();
    expect(clearTimer).toHaveBeenCalledTimes(1); // nothing waits now: no more polling
    list = [entry()];
    await a.reload();
    await flush();
    expect(setTimer).toHaveBeenCalledTimes(2);
    a.destroy();
    expect(clearTimer).toHaveBeenCalledTimes(2);
  });

  it("an automatic approval fetches the copy and names whose plan it used", async () => {
    const { call, a } = make({});
    const run = { id: RUN, role: "executor", status: "succeeded", approval: "auto", approved_by: { id: ME, name: "Ada Admin" } };
    a.sync([run]);
    await flush();
    expect(call.log.map((c) => c[1])).toEqual([RUNNERS_PATH]);
    expect(allText(approvalParts(run, a))).toBe("Approved automatically. It runs on Ada Admin's Claude plan.");
    expect(byTest(approvalParts(run, a), "pl-approve-run")).toBeUndefined();
    a.destroy();
  });

  it("without the copy nothing is drawn (no half-sentences)", () => {
    const { a } = make({});
    expect(approvalParts(pending[0], a)).toEqual([]);
    a.destroy();
  });

  it("someone else's wait shows their name and no button", async () => {
    const { a } = make({ [`GET ${RUN_APPROVALS_PATH}`]: { approvals: [entry({ can_approve: false, approvers: [{ id: "x", name: "Bo" }] })] } });
    a.sync(pending);
    await flush();
    const parts = approvalParts(pending[0], a);
    expect(byTest(parts, "pl-run-approval").textContent).toBe("Waiting for Bo to approve (it runs on their Claude plan).");
    expect(byTest(parts, "pl-approve-run")).toBeUndefined();
    a.destroy();
  });
});

describe("Runs: the open run's approval", () => {
  const route = (over = {}) => fakeCall({ "GET /api/runners/approvals": { approvals: [entry()] }, "GET /api/runners": { copy: COPY }, ...over });
  const pendingRun = { id: RUN, work_item_id: null, status: "pending", role: "executor", approval: null, approved_by: null };

  it("a pending run that waits reads the entry and the copy; the line says whose approval it needs", async () => {
    const call = route();
    const state = await loadRunApproval(pendingRun, call);
    expect(approvalLine(pendingRun, state)).toBe(COPY.approvalMine);
    const other = await loadRunApproval(pendingRun, route({ "GET /api/runners/approvals": { approvals: [entry({ can_approve: false, approvers: [{ id: "x", name: "Bo" }, { id: "y", name: "Cy" }] })] } }));
    expect(approvalLine(pendingRun, other)).toBe("Waiting for Bo or Cy to approve (it runs on their Claude plan).");
    expect(other.entry.canApprove).toBe(false);
  });

  it("a pending run that nothing waits on (no covering runner, or the dial lets it run) reads no copy and shows no line", async () => {
    const call = route({ "GET /api/runners/approvals": { approvals: [entry({ run_id: RUN2 })] } });
    const state = await loadRunApproval(pendingRun, call);
    expect(state).toEqual({ entry: null, copy: null });
    expect(approvalLine(pendingRun, state)).toBe("");
    expect(call.log.map((c) => c[1])).toEqual(["/api/runners/approvals"]);
  });

  it("a run that is not pending is not asked about; an automatic one reads the copy and names the person", async () => {
    const done = { ...pendingRun, status: "succeeded", approval: "auto", approved_by: { id: ME, name: "Ada Admin" } };
    const call = route();
    const state = await loadRunApproval(done, call);
    expect(call.log.map((c) => c[1])).toEqual(["/api/runners"]);
    expect(approvalLine(done, state)).toBe("Approved automatically. It runs on Ada Admin's Claude plan.");
    const plain = route();
    expect(await loadRunApproval({ ...pendingRun, status: "running" }, plain)).toEqual({ entry: null, copy: null });
    expect(plain.log).toEqual([]);
  });

  it("a failed read never rejects and leaves the run without a line", async () => {
    const state = await loadRunApproval(pendingRun, route({ "GET /api/runners/approvals": fail(500, "server_error") }));
    expect(state).toEqual({ entry: null, copy: null });
  });

  it("the approve call maps the answers: 200 done, 403 and 409 refused, the rest failed", async () => {
    expect(await approveRunnerRun(RUN, fakeCall({ [`POST ${runApprovePath(RUN)}`]: {} }))).toBe("done");
    expect(await approveRunnerRun(RUN, fakeCall({ [`POST ${runApprovePath(RUN)}`]: fail(403, "forbidden") }))).toBe("refused");
    expect(await approveRunnerRun(RUN, fakeCall({ [`POST ${runApprovePath(RUN)}`]: fail(409, "approved_by_other") }))).toBe("refused");
    expect(await approveRunnerRun(RUN, fakeCall({ [`POST ${runApprovePath(RUN)}`]: fail(500, "x") }))).toBe("failed");
    await expect(approveRunnerRun(RUN, fakeCall({ [`POST ${runApprovePath(RUN)}`]: Object.assign(new Error("a"), { name: "AbortError" }) }))).rejects.toThrow();
  });
});

describe("Repos: the runners read", () => {
  const raw = (over = {}) => ({
    id: "r1", credential_mode: "subscription", registered_by: { id: ME, name: "Ada Admin" }, state: "online_idle",
    plan_consent: { granted: false, changed_at: null }, can_change_plan_consent: true, repos: [{ id: REPO, name: "acme/web" }], ...over,
  });

  it("words the paused and draining states with the resume note, never undefined (D#605 FL-3)", () => {
    for (const [state, word] of [["paused", "Paused"], ["draining", "Draining"]]) {
      const row = readRunner(raw({ state, state_note: "Resumes within 5 min" }));
      expect(row).toMatchObject({ state, note: "Resumes within 5 min" });
      const el = runnerRow(row, { begin: vi.fn() });
      expect(byTest([el], "repos-runner-state").textContent).toContain(word);
      expect(byTest([el], "repos-runner-note").textContent).toBe("Resumes within 5 min");
      expect(el.textContent).not.toMatch(/undefined|null/);
    }
    // No note, no line: a runner without one shows nothing extra.
    expect(byTest([runnerRow(readRunner(raw()), { begin: vi.fn() })], "repos-runner-note")).toBeUndefined();
    expect(readRunner(raw({ state_note: null })).note).toBe("");
  });

  it("reads a row, leaves an unnamed person unnamed, and drops what is not a runner", () => {
    expect(readRunner(raw())).toMatchObject({ id: "r1", person: "Ada Admin", repos: ["acme/web"], granted: false, canChange: true });
    expect(readRunner(raw({ registered_by: { id: ME, name: "" } })).person).toBe("");
    expect(readRunner(raw({ can_change_plan_consent: undefined })).canChange).toBe(false);
    expect(readRunner(null)).toBeNull();
    expect(readRunner({ id: "x" })).toBeNull();
    expect(readCopy({ copy: COPY })).toBe(COPY);
    expect(readCopy({ copy: { ...COPY, planConsentText: "" } })).toBeNull();
  });
});

describe("Repos: the consent switch", () => {
  const runner = (granted) => ({ id: "r1", granted });

  it("turning it on sends nothing until confirm, and then exactly one POST { granted: true }, even when confirm is pressed twice", async () => {
    const call = fakeCall({ [`POST ${consentUrl("r1")}`]: { plan_consent: { granted: true }, changed: true } });
    const onSaved = vi.fn();
    const flow = createConsentFlow({ call, onSaved });
    flow.begin(runner(false));
    await flush();
    expect(call.log).toEqual([]);
    expect(flow.state).toMatchObject({ runnerId: "r1", granted: true, phase: "ask" });
    flow.confirm();
    flow.confirm();
    await flush();
    expect(call.log).toEqual([["POST", consentUrl("r1"), { granted: true }]]);
    expect(flow.state).toBeNull();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("cancel sends nothing and closes the question", async () => {
    const call = fakeCall({});
    const flow = createConsentFlow({ call });
    flow.begin(runner(false));
    flow.cancel();
    expect(flow.state).toBeNull();
    await flow.confirm();
    expect(call.log).toEqual([]);
  });

  it("turning it off asks first and sends { granted: false }", async () => {
    const call = fakeCall({ [`POST ${consentUrl("r1")}`]: { changed: true } });
    const flow = createConsentFlow({ call });
    flow.begin(runner(true));
    expect(flow.state.granted).toBe(false);
    expect(call.log).toEqual([]);
    await flow.confirm();
    expect(call.log).toEqual([["POST", consentUrl("r1"), { granted: false }]]);
    expect(OFF_QUESTION).toBe("Ask before each run again?");
  });

  it.each([[403, CONSENT_SENTENCES[403]], [404, CONSENT_SENTENCES[404]], [500, CONSENT_SENTENCES.other]])("%i is a sentence of ours and keeps the question open", async (status, text) => {
    const flow = createConsentFlow({ call: fakeCall({ [`POST ${consentUrl("r1")}`]: fail(status, "x") }) });
    flow.begin(runner(false));
    await flow.confirm();
    expect(flow.state).toMatchObject({ phase: "error", error: text });
    expect(text).not.toContain("server text");
  });
});

describe("Repos: the runner rows, as the person who registered the runner and as anyone else", () => {
  const base = { id: "r1", mode: "subscription", state: "online_idle", person: "Ada Admin", repos: ["acme/web", "acme/api"], granted: false, changedAt: null, canChange: false };
  const flow = { begin: vi.fn() };

  it("the owner of the runner sees the switch, saved value off, and a line that says it asks each run", () => {
    const row = runnerRow({ ...base, canChange: true }, flow);
    const box = byTest([row], "repos-consent-switch");
    expect(box.getAttribute("role")).toBe("switch");
    expect(box.checked).toBeFalsy();
    expect(row.textContent).toContain(SWITCH_LABEL);
    expect(byTest([row], "repos-consent-state").textContent).toBe("Ada Admin approves each run");
    expect(byTest([row], "repos-runner-repos").textContent).toBe("Repos: acme/web, acme/api");
    expect(byTest([row], "repos-consent-when")).toBeUndefined(); // never switched: nothing to say about who and when
  });

  it("pressing the switch opens the question and does not change the box", () => {
    const f = { begin: vi.fn() };
    const row = runnerRow({ ...base, canChange: true }, f);
    const preventDefault = vi.fn();
    byTest([row], "repos-consent-switch").on.click({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(f.begin).toHaveBeenCalledWith(expect.objectContaining({ id: "r1", granted: false }));
  });

  it("anyone else sees the line read-only, with who turned it on and when, and no switch", () => {
    const row = runnerRow({ ...base, granted: true, changedAt: "2026-10-09T05:00:00.000Z" }, flow);
    expect(byTest([row], "repos-consent-switch")).toBeUndefined();
    expect(byTest([row], "repos-consent-state").textContent).toBe("Ada Admin lets work run on their plan without asking");
    expect(byTest([row], "repos-consent-when").textContent).toMatch(/^Turned on by Ada Admin, /);
    const off = runnerRow({ ...base, granted: false, changedAt: "2026-10-09T06:00:00.000Z" }, flow);
    expect(byTest([off], "repos-consent-when").textContent).toMatch(/^Turned off by Ada Admin, /);
  });

  it("an API key runner and a revoked runner have no consent to show; a runner with no repos says so; no blank, null or undefined appears", () => {
    for (const over of [{ mode: "api_key", canChange: true }, { state: "revoked", canChange: true }]) {
      const row = runnerRow({ ...base, ...over }, flow);
      expect(byTest([row], "repos-consent-state"), JSON.stringify(over)).toBeUndefined();
      expect(byTest([row], "repos-consent-switch")).toBeUndefined();
    }
    const none = runnerRow({ ...base, repos: [], person: "" }, flow);
    expect(byTest([none], "repos-runner-repos").textContent).toBe("No repos");
    expect(none.textContent).toContain("A runner");
    for (const text of [none.textContent, runnerRow({ ...base, canChange: true }, flow).textContent]) expect(text).not.toMatch(/null|undefined|NaN/);
  });
});

describe("Repos: the runner-run setting", () => {
  const body = (over = {}) => ({ repo_id: REPO, decision_type: "runner_run_on_member_plan", disposition: "announce", source: "default", preset: null, version: null, can_change: true, ...over });
  const URL = dialUrl(REPO);

  it.each(DISPOSITIONS)("as an owner or admin: %s round-trips through the GET after a save", async (target) => {
    const start = target === "ask" ? "announce" : "ask";
    let current = body({ disposition: start, source: "override" });
    const call = fakeCall({ [`GET ${URL}`]: () => current, [`PUT ${URL}`]: () => (current = body({ disposition: target, source: "override" })) });
    const ctl = createDialController({ call, repoId: REPO });
    await ctl.load();
    expect(ctl.state.dial).toMatchObject({ disposition: start, canChange: true });
    await ctl.save(target);
    expect(sent(call, "PUT")).toEqual([["PUT", URL, { disposition: target }]]);
    expect(ctl.state.dial.disposition).toBe(target);
    await ctl.load();
    expect(ctl.state.dial.disposition).toBe(target);
  });

  it("as a member: the value is shown and a save is never sent", async () => {
    const call = fakeCall({ [`GET ${URL}`]: body({ disposition: "ask", can_change: false, source: "preset", preset: "cautious", version: 3 }) });
    const ctl = createDialController({ call, repoId: REPO });
    await ctl.load();
    await ctl.save("act");
    expect(sent(call, "PUT")).toEqual([]);
    expect(ctl.state.dial).toMatchObject({ disposition: "ask", canChange: false });
  });

  it("saving the value already in force sends nothing; a double press is one PUT", async () => {
    let release;
    const call = fakeCall({ [`GET ${URL}`]: body(), [`PUT ${URL}`]: () => new Promise((r) => (release = r)) });
    const ctl = createDialController({ call, repoId: REPO });
    await ctl.load();
    await ctl.save("announce");
    expect(sent(call, "PUT")).toEqual([]);
    const p = ctl.save("ask");
    ctl.save("act");
    release(body({ disposition: "ask", source: "override" }));
    await p;
    expect(sent(call, "PUT")).toHaveLength(1);
  });

  it("403 turns the control read-only; 409 shows the current value; both with our sentence", async () => {
    const forbidden = fakeCall({ [`GET ${URL}`]: body(), [`PUT ${URL}`]: fail(403, "forbidden") });
    const a = createDialController({ call: forbidden, repoId: REPO });
    await a.load();
    await a.save("ask");
    expect(a.state.error).toBe(DIAL_SENTENCES[403]);
    expect(a.state.dial).toMatchObject({ disposition: "announce", canChange: false });
    let n = 0;
    const raced = fakeCall({ [`GET ${URL}`]: () => body({ disposition: n++ ? "act" : "announce" }), [`PUT ${URL}`]: fail(409, "dial_changed") });
    const b = createDialController({ call: raced, repoId: REPO });
    await b.load();
    await b.save("ask");
    await flush();
    expect(b.state.error).toBe(DIAL_SENTENCES[409]);
    expect(b.state.dial.disposition).toBe("act");
  });

  it("a read that fails, or answers something unknown, is an error state, not a guess", async () => {
    const down = createDialController({ call: fakeCall({ [`GET ${URL}`]: fail(500, "x") }), repoId: REPO });
    await down.load();
    expect(down.state.status).toBe("error");
    const odd = createDialController({ call: fakeCall({ [`GET ${URL}`]: body({ disposition: "sometimes" }) }), repoId: REPO });
    await odd.load();
    expect(odd.state.status).toBe("error");
  });

  it("says where the value comes from, including a preset adopted before the entry existed (default under Cautious)", () => {
    expect(sourceWords({ source: "default", preset: null })).toBe("This is the default. Nobody has set it for this repo.");
    expect(sourceWords({ source: "preset", preset: "cautious" })).toBe("Set by the Cautious preset.");
    expect(sourceWords({ source: "preset", preset: null })).toBe("Set by a preset.");
    expect(sourceWords({ source: "override", preset: null })).toBe("Set for this repo.");
  });
});
