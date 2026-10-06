// apps/workspace/test/pipeline-approve.test.mjs
//
// D#483 P1 + P3: the approve button on the Pipeline detail. The logic (createApprove) against a fake call(), and the view
// against a small stand-in for the few DOM calls it makes (no jsdom here). The rules under test: the request has no body,
// each outcome is a fixed sentence (never a server code or message), one click is one request, an accepted request is
// followed so a refusal that costs nothing reaches the sentence, and the button is not offered while a run is live.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVE_BUILD_LABEL, APPROVE_LABEL, FOLLOW_POLLS, LABELS, NOTES, SENDING, APPROVE_SENTENCES as SENTENCES, actionPath, anyLiveRun, approvePath, approveView, canApprove, createApprove, labelFor, approveSentenceFor as sentenceFor } from "../apps/pipeline/pipeline-actions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ID = "22222222-2222-4222-8222-222222222222";
const REPO = "99999999-9999-4999-8999-999999999999";
const ITEM = { id: ID, stage: "triaged", provenance: "internal", repo_id: REPO, issue_number: 7, kind: "issue" };
const fail = (status, code) => Object.assign(new Error("server text that must never be shown"), { status, code });
const flush = () => new Promise((r) => setTimeout(r, 0));

/** `reply` answers the POST; `action` answers every GET of the run action (default: it is done). */
function fakeCall(reply, action = { state: "done" }) {
  const log = [];
  const call = vi.fn(async (...args) => {
    log.push(args);
    if (args[0] === "GET") {
      if (action instanceof Error) throw action;
      return action;
    }
    const r = typeof reply === "function" ? reply() : reply;
    if (r instanceof Error) throw r;
    return r;
  });
  call.log = log;
  return call;
}
const posts = (call) => call.log.filter((a) => a[0] === "POST");
const gets = (call) => call.log.filter((a) => a[0] === "GET");
/** createApprove with no waiting between reads of the request. */
const make = (opts = {}) => createApprove({ sleep: async () => {}, ...opts });

describe("canApprove", () => {
  it("only an internal item at a stage the server advances, with a repository and an issue number", () => {
    expect(canApprove(ITEM)).toBe(true);
    // In progress is "Check the build": offered to an internal item with a repo and an issue number, like the other stages.
    expect(canApprove({ ...ITEM, stage: "in_progress" })).toBe(true);
    expect(canApprove({ ...ITEM, stage: "in_progress" }, true)).toBe(false); // a run is live
    for (const over of [{ provenance: "external" }, { repo_id: null }, { issue_number: null }]) expect(canApprove({ ...ITEM, stage: "in_progress", ...over }), JSON.stringify(over)).toBe(false);
    for (const over of [{ provenance: "external" }, { stage: "discussing" }, { stage: "needs_human" }, { stage: "merged" }, { stage: "closed_unmerged" }, { stage: "closed" }, { repo_id: null }, { repo_id: "" }, { issue_number: null }, { issue_number: "7" }]) {
      expect(canApprove({ ...ITEM, ...over }), JSON.stringify(over)).toBe(false);
    }
    expect(canApprove(null)).toBe(false);
    expect(canApprove(undefined)).toBe(false);
  });
});

describe("canApprove at Discussing (P3: the panel and the Spec again)", () => {
  const D = { ...ITEM, stage: "discussing", kind: "feature" };
  it("only a kind that has a panel", () => {
    expect(canApprove({ ...D, kind: "feature" })).toBe(true);
    expect(canApprove({ ...D, kind: "critical" })).toBe(true);
    for (const kind of ["project", "question", "bug", "small", "doc", null, "", 7]) expect(canApprove({ ...D, kind }), String(kind)).toBe(false);
  });
});

describe("canApprove at Spec ready (P2: approve the Spec and build)", () => {
  const SPEC = { ...ITEM, stage: "spec_ready", kind: "feature" };
  it("an internal pipeline item at Spec ready with a buildable kind, a repository and an issue number", () => {
    for (const kind of ["critical", "feature", "small", "bug", "doc"]) expect(canApprove({ ...SPEC, kind }), kind).toBe(true);
  });
  it("not a question or a project (nothing to build), not a kind that is missing, and not an external, repo-less or issue-less item", () => {
    for (const over of [{ kind: "project" }, { kind: "question" }, { kind: null }, { kind: "" }, { kind: 7 }, { provenance: "external" }, { repo_id: null }, { issue_number: null }]) {
      expect(canApprove({ ...SPEC, ...over }), JSON.stringify(over)).toBe(false);
    }
  });
  it("the button says what it does at each stage", () => {
    expect(labelFor(ITEM)).toBe(APPROVE_LABEL);
    expect(labelFor(SPEC)).toBe(APPROVE_BUILD_LABEL);
    expect(APPROVE_BUILD_LABEL).toBe("Approve the Spec and build");
  });
  it("one click asks the server to approve THIS item, with no body, and the started sentence says a build began", async () => {
    const call = fakeCall({ action_id: "a", state: "accepted" });
    const a = make({ call });
    await a.approve(SPEC);
    expect(posts(call)).toEqual([["POST", "/api/v1/work-items/" + ID + "/approve", undefined]]);
    expect(a.state).toEqual({ itemId: ID, phase: "started", text: SENTENCES.started_build });
    expect(SENTENCES.started_build).toMatch(/building/);
    expect(SENTENCES.started_build).not.toBe(SENTENCES.started);
  });
  it("one click on a pull request stage asks for the review; the sentence says reviewers are checking", async () => {
    for (const stage of ["pr_opened", "changes_requested", "review_passed"]) {
      const call = fakeCall({ action_id: "a", state: "accepted" });
      const a = make({ call });
      await a.approve({ ...SPEC, stage });
      expect(a.state).toEqual({ itemId: ID, phase: "started", text: SENTENCES.started_review });
    }
    expect(SENTENCES.started_review).toMatch(/Reviewers/);
  });
  it("Check the build: at In progress the button is named for the check, the note says what it does, and the started sentence says it is checking", async () => {
    const IN_PROGRESS = { ...SPEC, stage: "in_progress" };
    expect(labelFor(IN_PROGRESS)).toBe("Check the build");
    expect(NOTES.in_progress).toMatch(/pull request/);
    expect(NOTES.in_progress).toMatch(/Needs a person/);
    const call = fakeCall({ action_id: "a", state: "accepted" });
    const a = make({ call });
    await a.approve(IN_PROGRESS);
    expect(posts(call)).toEqual([["POST", "/api/v1/work-items/" + ID + "/approve", undefined]]);
    expect(a.state).toEqual({ itemId: ID, phase: "started", text: SENTENCES.started_check });
    expect(SENTENCES.started_check).toMatch(/checking whether the build opened a pull request/);
  });
  it("at Discussing the started sentence says the panel is back at work", async () => {
    const a = make({ call: fakeCall({ action_id: "a", state: "accepted" }) });
    await a.approve({ ...ITEM, stage: "discussing", kind: "feature" });
    expect(a.state.text).toBe(SENTENCES.started_spec);
  });
  it("every stage's note names what it starts, and they differ", () => {
    expect(NOTES.triaged).toMatch(/panel/);
    expect(NOTES.triaged).toMatch(/Nothing is built until you approve that Spec/);
    expect(NOTES.spec_ready).toMatch(/pull request/);
    expect(NOTES.spec_ready).not.toBe(NOTES.triaged);
    expect(NOTES.pr_opened).toMatch(/review/);
    expect(NOTES.review_passed).toMatch(/merge/);
    expect(Object.keys(NOTES)).toEqual(Object.keys(LABELS));
    expect(new Set(Object.values(NOTES)).size).toBe(Object.keys(NOTES).length);
    for (const text of Object.values(NOTES)) expect(text).not.toMatch(/undefined|null|NaN/);
  });
});

describe("createApprove", () => {
  it("sends POST to the item's approve path with NO body and no options", async () => {
    const call = fakeCall({ action_id: "a", state: "accepted" });
    const a = make({ call });
    await a.approve(ITEM);
    expect(posts(call)).toEqual([["POST", "/api/v1/work-items/" + ID + "/approve", undefined]]);
    expect(posts(call)[0]).toHaveLength(3);
    expect(approvePath("a/b c")).toBe("/api/v1/work-items/a%2Fb%20c/approve");
    expect(actionPath("a/b c")).toBe("/api/v1/run-actions/a%2Fb%20c");
  });

  it("goes sending then started, with the fixed sentences, and reports each change", async () => {
    let release;
    const call = vi.fn((method) => (method === "GET" ? Promise.resolve({ state: "done" }) : new Promise((r) => (release = r))));
    const seen = [];
    const a = make({ call, onChange: () => seen.push(a.state.phase + ":" + a.state.text) });
    const p = a.approve(ITEM);
    expect(seen).toEqual(["sending:" + SENDING]);
    release({ action_id: "a", state: "accepted" });
    await p;
    expect(seen).toEqual(["sending:" + SENDING, "started:" + SENTENCES.started]);
  });

  it("one click is one request: a second click while sending or after started sends nothing", async () => {
    let release;
    const call = vi.fn((method) => (method === "GET" ? Promise.resolve({ state: "done" }) : new Promise((r) => (release = r))));
    const a = make({ call });
    const p = a.approve(ITEM);
    await a.approve(ITEM);
    expect(call).toHaveBeenCalledTimes(1);
    release({ action_id: "a" });
    await p;
    await a.approve(ITEM);
    expect(call.mock.calls.filter((c) => c[0] === "POST")).toHaveLength(1);
  });

  it("a card that is not approvable sends nothing", async () => {
    const call = fakeCall({});
    const a = make({ call });
    await a.approve({ ...ITEM, provenance: "external" });
    await a.approve({ ...ITEM, stage: "needs_human" });
    await a.approve({ ...ITEM, stage: "discussing", kind: "project" });
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    [409, "already_running"],
    [409, "not_approvable"],
    [409, "no_repo"],
    [403, "external_requires_human"],
    [403, "insufficient_role"],
    [403, "session_required"],
    [409, "account_not_active"],
    [503, "run_actions_unavailable"],
    [0, "offline"],
    [0, "timeout"],
    [404, "not_found"],
    [422, "idempotency_key_reused"],
  ])("a %s %s answer is its own fixed sentence and never the server's text", async (status, code) => {
    const a = make({ call: fakeCall(fail(status, code)) });
    await a.approve(ITEM);
    expect(a.state.phase).toBe("error");
    expect(a.state.text).toBe(SENTENCES[code]);
    expect(a.state.text).not.toMatch(/server text|undefined|null|NaN/);
  });

  it("a 429 is the rate sentence; an unknown code or a bare error is the generic one; nothing says 'undefined'", async () => {
    for (const [e, expected] of [
      [fail(429, "rate_limited"), SENTENCES.rate_limited],
      [fail(429, undefined), SENTENCES.rate_limited],
      [fail(500, "server_error"), sentenceFor("zzz")],
      [fail(418, "teapot"), sentenceFor("zzz")],
      [new Error("boom"), sentenceFor("zzz")],
      [undefined, sentenceFor("zzz")],
    ]) {
      const call = vi.fn(async () => {
        throw e;
      });
      const a = make({ call });
      await a.approve(ITEM);
      expect(a.state.text).toBe(expected);
    }
    expect(sentenceFor("__proto__")).toBe(sentenceFor("zzz"));
    expect(sentenceFor("constructor")).toBe(sentenceFor("zzz"));
  });

  it("after an error the person can approve again (a failed classify leaves the item at Triaged)", async () => {
    const replies = [fail(503, "run_actions_unavailable"), { action_id: "a" }];
    const call = vi.fn(async (method) => {
      if (method === "GET") return { state: "done" };
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return r;
    });
    const a = make({ call });
    await a.approve(ITEM);
    expect(a.state.phase).toBe("error");
    await a.approve(ITEM);
    expect(a.state.phase).toBe("started");
    expect(call.mock.calls.filter((c) => c[0] === "POST")).toHaveLength(2);
  });

  it("opening another card, or closing, starts fresh; a late answer for an old card does not repaint the new one", async () => {
    let release;
    const call = vi.fn((method) => (method === "GET" ? Promise.resolve({ state: "done" }) : new Promise((r) => (release = r))));
    const a = make({ call });
    const p = a.approve(ITEM);
    a.reset("other");
    release({ action_id: "a" });
    await p;
    expect(a.state).toEqual({ itemId: "other", phase: "idle", text: "" });
    a.reset();
    expect(a.state).toEqual({ itemId: null, phase: "idle", text: "" });
  });

  describe("following the request (the refusals that cost nothing reach the sentence)", () => {
    const accepted = { action_id: "77777777-7777-4777-8777-777777777777", state: "accepted" };

    it.each([
      ["no_model", SENTENCES.no_model],
      ["model_budget_unset", SENTENCES.model_budget_unset],
      ["no_installation", SENTENCES.no_installation],
      ["no_card", SENTENCES.no_card],
      ["spend_refused", SENTENCES.spend_refused],
      ["refused_spend", SENTENCES.refused_spend],
      ["not_advanceable", sentenceFor("zzz")],
    ])("a request the worker refused with %s shows its own sentence, and the card is not marked started", async (code, sentence) => {
      const call = fakeCall(accepted, { state: "refused", error_code: code });
      const a = make({ call });
      await a.approve(ITEM);
      expect(a.state).toEqual({ itemId: ID, phase: "error", text: sentence });
      expect(a.state.text).not.toMatch(/undefined|null|NaN/);
      // The read is of THIS request's outcome.
      expect(gets(call)).toEqual([["GET", actionPath(accepted.action_id), undefined]]);
    });

    it("a request that failed with no code is an error sentence, not 'started'", async () => {
      const a = make({ call: fakeCall(accepted, { state: "failed" }) });
      await a.approve(ITEM);
      expect(a.state.phase).toBe("error");
    });

    it("keeps reading while the request is accepted or claimed, then reports started after the last read", async () => {
      const states = ["accepted", "claimed", "claimed", "done"];
      const call = vi.fn(async (method) => (method === "GET" ? { state: states.shift() } : accepted));
      const sleeps = [];
      const a = createApprove({ call, sleep: async (ms) => sleeps.push(ms) });
      await a.approve(ITEM);
      expect(a.state.phase).toBe("started");
      expect(call.mock.calls.filter((c) => c[0] === "GET")).toHaveLength(4);
      expect(sleeps).toHaveLength(3);
    });

    it("gives up after FOLLOW_POLLS reads and says started (the work goes on), never hanging", async () => {
      const call = fakeCall(accepted, { state: "claimed" });
      const a = make({ call });
      await a.approve(ITEM);
      expect(gets(call)).toHaveLength(FOLLOW_POLLS);
      expect(a.state).toEqual({ itemId: ID, phase: "started", text: SENTENCES.started });
    });

    it("a failed read of the request is not a refusal: the card says started", async () => {
      const a = make({ call: fakeCall(accepted, fail(500, "server_error")) });
      await a.approve(ITEM);
      expect(a.state.phase).toBe("started");
    });

    it("an answer with no action id is not followed", async () => {
      const call = fakeCall({});
      const a = make({ call });
      await a.approve(ITEM);
      expect(gets(call)).toEqual([]);
      expect(a.state.phase).toBe("started");
    });

    it("the button stays disabled for the whole follow", async () => {
      const gate = { release: () => {} };
      const call = vi.fn(async (method) => {
        if (method === "GET") {
          await new Promise((r) => (gate.release = r));
          return { state: "done" };
        }
        return accepted;
      });
      const a = make({ call });
      const p = a.approve(ITEM);
      await flush();
      expect(a.state.phase).toBe("sending");
      await a.approve(ITEM);
      expect(call.mock.calls.filter((c) => c[0] === "POST")).toHaveLength(1);
      gate.release();
      await p;
      expect(a.state.phase).toBe("started");
    });
  });

  it("an abort says nothing", async () => {
    const a = make({ call: fakeCall(Object.assign(new Error("x"), { name: "AbortError" })) });
    await a.approve(ITEM);
    expect(a.state.text).toBe(SENDING);
  });
});

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
const byTest = (root, id) => findAll(root, (e) => e.getAttribute("data-testid") === id)[0];

describe("approveView", () => {
  beforeEach(() => {
    vi.stubGlobal("Node", FakeNode);
    vi.stubGlobal("document", { createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is a button named 'Approve and start' with no note at first; a click asks the controller", async () => {
    const call = fakeCall({});
    const a = make({ call });
    a.reset(ID);
    const el = approveView(ITEM, a);
    const btn = byTest(el, "pl-approve-btn");
    expect(btn.textContent).toBe(APPROVE_LABEL);
    expect(btn.getAttribute("disabled")).toBeNull();
    expect(byTest(el, "pl-approve-note")).toBeUndefined();
    expect(byTest(el, "pl-approve-hint").textContent).toBe(NOTES.triaged);
    btn.on.click();
    await flush();
    expect(posts(call)).toHaveLength(1);
  });

  it("while sending and after started the button is disabled and the sentence is shown (role=status); after an error it is enabled again", async () => {
    const a = make({ call: fakeCall({}) });
    await a.approve(ITEM);
    let el = approveView(ITEM, a);
    expect(byTest(el, "pl-approve-btn").getAttribute("disabled")).toBe("true");
    expect(byTest(el, "pl-approve-note").textContent).toBe(SENTENCES.started);
    expect(byTest(el, "pl-approve-note").getAttribute("role")).toBe("status");
    const b = make({ call: fakeCall(fail(409, "already_running")) });
    await b.approve(ITEM);
    el = approveView(ITEM, b);
    expect(byTest(el, "pl-approve-btn").getAttribute("disabled")).toBeNull();
    expect(byTest(el, "pl-approve-note").textContent).toBe(SENTENCES.already_running);
  });

  it("at Spec ready the button is named for the build and the note says what the build does", () => {
    const a = make({ call: fakeCall({}) });
    const el = approveView({ ...ITEM, stage: "spec_ready", kind: "feature" }, a);
    expect(byTest(el, "pl-approve-btn").textContent).toBe(APPROVE_BUILD_LABEL);
    expect(byTest(el, "pl-approve-hint").textContent).toBe(NOTES.spec_ready);
  });

  it("at In progress the button reads Check the build and the note says what the check does", () => {
    const a = make({ call: fakeCall({}) });
    const el = approveView({ ...ITEM, stage: "in_progress", kind: "feature" }, a);
    expect(byTest(el, "pl-approve-btn").textContent).toBe("Check the build");
    expect(byTest(el, "pl-approve-hint").textContent).toBe(NOTES.in_progress);
  });

  it("an item with a live run is not approvable, whatever its stage", async () => {
    for (const stage of ["triaged", "discussing", "spec_ready", "in_progress", "pr_opened", "changes_requested", "review_passed"]) {
      expect(canApprove({ ...ITEM, stage, kind: "feature" }, true), stage).toBe(false);
      expect(canApprove({ ...ITEM, stage, kind: "feature" }, false), stage).toBe(true);
    }
    // a click that arrives after a run went live sends nothing
    const call = fakeCall({});
    await make({ call }).approve(ITEM, true);
    expect(call).not.toHaveBeenCalled();
  });

  it("anyLiveRun is true for a pending, running or paused run and for nothing else", () => {
    for (const status of ["pending", "running", "paused"]) expect(anyLiveRun([{ status: "succeeded" }, { status }])).toBe(true);
    for (const status of ["succeeded", "failed", "timed_out", "killed_spend", "refused_spend", "cancelled", "weird"]) expect(anyLiveRun([{ status }])).toBe(false);
    expect(anyLiveRun([])).toBe(false);
    expect(anyLiveRun(undefined)).toBe(false);
    expect(anyLiveRun([null, 3, {}])).toBe(false);
  });

  it("every approvable stage has its own label", () => {
    expect(Object.keys(LABELS)).toEqual(["triaged", "discussing", "spec_ready", "in_progress", "pr_opened", "changes_requested", "review_passed"]);
    expect(new Set(Object.values(LABELS)).size).toBe(7);
    expect(LABELS.in_progress).toBe("Check the build");
  });

  it("another card's state is never shown on this one", async () => {
    const a = make({ call: fakeCall({}) });
    await a.approve(ITEM);
    const el = approveView({ ...ITEM, id: "33333333-3333-4333-8333-333333333333" }, a);
    expect(byTest(el, "pl-approve-note")).toBeUndefined();
    expect(byTest(el, "pl-approve-btn").getAttribute("disabled")).toBeNull();
  });
});

describe("the source", () => {
  const src = readFileSync(join(HERE, "..", "apps", "pipeline", "pipeline-actions.js"), "utf8");
  const app = readFileSync(join(HERE, "..", "apps", "pipeline", "pipeline-app.js"), "utf8");

  it("builds text with h() only: no innerHTML, no insertAdjacentHTML, no document.write, no eval", () => {
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  });
  it("never puts a server code or message on the screen: no err.message, no String(code) in a text position", () => {
    expect(src).not.toMatch(/\.message\b/);
  });
  it("the app imports and uses it, once, only for an approvable card with no live run", () => {
    expect(app).toMatch(/from "\.\/pipeline-actions\.js"/);
    expect(app.match(/approveView\(/g)).toHaveLength(1);
    expect(app).toMatch(/canApprove\(openItem, live\)\s*\?\s*\[approveView\(openItem, approver, live\)\]/);
    // the slot is redrawn on its own: a change of "a run is live" never rebuilds the Runs section (and the focus held in it)
    expect(app).toMatch(/onChange: \(\) => \{\s*paint\(\);\s*syncApprove\(\);/);
  });
});
