// apps/workspace/test/pipeline-actions.test.mjs
//
// D#37 WS-F1c: Cancel and Retry on the Pipeline detail's Runs section, the logic half
// (createActions) against a fake call() and vitest's fake clock. The contract fixtures are
// the bodies the fake server returns. The DOM half (dialogs, dismiss by Escape or outside
// click, the code-never-in-the-DOM scan, phone) is in e2e/pipeline-actions.spec.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CEILING_MS, POLL_MS, SENTENCES, STATUS_WORDS, controlsFor, createActions, createRunsPanel, dialogLines, sentenceFor,
} from "../apps/pipeline/pipeline-actions.js";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages");
const fx = (...p) => JSON.parse(readFileSync(join(PACKAGES, "api", "fixtures", "v1", ...p), "utf8"));
const WORK = fx("listRuns", "200-work-item.json");
const [LIVE, REVIEW_FAILED, BUILD_OLD] = WORK.data;
const ACTION_ID = fx("cancelRun", "202-accepted.json").action_id;
const ITEM = "22222222-2222-4222-8222-222222222222";
const REPO = "99999999-9999-4999-8999-999999999999";
const ROLES = fx("listRoles", "200-ok.json");

const fail = (status, code) => Object.assign(new Error("server text that must never be shown"), { status, code });
const flush = () => vi.advanceTimersByTimeAsync(0);

/** A fake call(): routes is "METHOD /path" (no query) -> body | Error | function. Logs every call. */
function fakeCall(routes) {
  const log = [];
  const call = async (method, url, body, signal, opts) => {
    log.push({ method, url, opts });
    let r = routes[method + " " + url.split("?")[0]];
    if (typeof r === "function") r = r({ url, opts });
    if (r instanceof Error) throw r;
    if (r === undefined) throw fail(404, "not_found");
    return structuredClone(r);
  };
  call.log = log;
  call.count = (method, prefix) => log.filter((c) => c.method === method && c.url.startsWith(prefix)).length;
  return call;
}

async function make(routes = {}, { runs = WORK } = {}) {
  let n = 0;
  const call = fakeCall({
    "GET /api/v1/runs": () => runs,
    ["GET /api/v1/runs/" + LIVE.id]: fx("getRun", "200-running.json"),
    ["GET /api/v1/repos/" + REPO + "/roles"]: ROLES,
    ["POST /api/v1/runs/" + LIVE.id + "/cancel"]: fx("cancelRun", "202-accepted.json"),
    ["POST /api/v1/runs/" + REVIEW_FAILED.id + "/retry"]: fx("retryRun", "202-accepted.json"),
    ...routes,
  });
  const ctl = createActions({ itemId: ITEM, repoId: REPO, call, uuid: () => "00000000-0000-4000-8000-" + String(++n).padStart(12, "0") });
  await ctl.load();
  await flush();
  return { ctl, call };
}

const dialogOf = (ctl) => ctl.getState().dialog;

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

describe("which run gets which control", () => {
  const RUN_STATUS = readFileSync(join(PACKAGES, "runner", "src", "statusTransitions.ts"), "utf8").match(/export type RunStatus =([^;]*);/)[1].match(/"([a-z_]+)"/g).map((s) => s.slice(1, -1));
  const EXPECT = {
    pending: [true, false], running: [true, false], paused: [true, false],
    succeeded: [false, false],
    failed: [false, true], timed_out: [false, true], killed_spend: [false, true], refused_spend: [false, true], cancelled: [false, true],
  };

  it("the table covers every RunStatus on main, so a new status can't slip in unlisted", () => {
    expect(Object.keys(EXPECT).sort()).toEqual([...RUN_STATUS].sort());
    for (const s of RUN_STATUS) expect(STATUS_WORDS[s], s).toBeTruthy();
  });

  it.each([...Object.entries(EXPECT), ["from_the_future", [false, false]]])("%s -> [cancel, retry] = %j", (status, [cancel, retry]) => {
    const run = { id: "r1", role: "build", status };
    expect(controlsFor(run, [run])).toEqual({ cancel, retry });
  });

  it("Retry goes only to the newest run of its role, and nothing is offered while an action is pending", () => {
    expect(controlsFor(REVIEW_FAILED, WORK.data).retry).toBe(true);
    expect(controlsFor(BUILD_OLD, WORK.data).retry).toBe(false); // the live build run is newer
    expect(controlsFor(LIVE, WORK.data)).toEqual({ cancel: true, retry: false });
    expect(controlsFor(LIVE, WORK.data, true)).toEqual({ cancel: false, retry: false });
  });
});

describe("the dialogs read before they ask, and send only on Confirm", () => {
  it("Cancel shows spend so far from GET /runs/{id}, or 'not known yet' when usd is null", async () => {
    const { ctl, call } = await make();
    ctl.openDialog("cancel", LIVE);
    expect(dialogLines(dialogOf(ctl))).toEqual(["Checking what this run has cost…"]);
    await flush();
    expect(dialogLines(dialogOf(ctl))).toEqual(["Spent so far: not known yet", "Anything reserved for this run and not spent is released."]);
    expect(call.count("GET", "/api/v1/runs/" + LIVE.id)).toBe(1);
    ctl.dismiss();
    const { ctl: c2 } = await make({ ["GET /api/v1/runs/" + LIVE.id]: { ...fx("getRun", "200-running.json"), usd: 0.42 } });
    c2.openDialog("cancel", LIVE);
    await flush();
    expect(dialogLines(dialogOf(c2))[0]).toBe("Spent so far: $0.42");
  });

  it("Retry shows the role's usual cost and caveat, once per open and never on load", async () => {
    const { ctl, call } = await make();
    expect(call.count("GET", "/api/v1/repos")).toBe(0);
    ctl.openDialog("retry", { ...REVIEW_FAILED, role: "build" });
    await flush();
    expect(dialogLines(dialogOf(ctl))).toEqual(["Usually about $0.60 per run", ROLES.data.find((r) => r.role === "build").expected_spend.caveat, "A retry may use a stronger model, which can cost more."]);
    expect(call.count("GET", "/api/v1/repos")).toBe(1);
  });

  it("Retry falls back to a fixed line, with Confirm still possible, when the roles read fails or the role is missing", async () => {
    for (const roles of [fail(500, "internal_error"), { data: [] }]) {
      const { ctl } = await make({ ["GET /api/v1/repos/" + REPO + "/roles"]: roles });
      ctl.openDialog("retry", REVIEW_FAILED);
      await flush();
      expect(dialogLines(dialogOf(ctl))).toEqual(["The expected spend isn't available right now.", "A retry may use a stronger model, which can cost more."]);
      expect(dialogOf(ctl).phase).toBe("ready");
    }
  });

  it("dismissing sends no POST, and opening one does not send either", async () => {
    const { ctl, call } = await make();
    ctl.openDialog("cancel", LIVE);
    await flush();
    ctl.dismiss();
    ctl.openDialog("retry", REVIEW_FAILED);
    await flush();
    ctl.dismiss();
    expect(dialogOf(ctl)).toBeNull();
    expect(call.log.filter((c) => c.method === "POST")).toEqual([]);
  });
});

describe("the Idempotency-Key", () => {
  const retryOpen = async (routes) => {
    const m = await make(routes);
    m.ctl.openDialog("retry", REVIEW_FAILED);
    await flush();
    return m;
  };
  const keys = (call) => call.log.filter((c) => c.method === "POST").map((c) => c.opts && c.opts.idempotencyKey);

  it("two separate confirms send two different fresh keys", async () => {
    const { ctl, call } = await retryOpen({ ["POST /api/v1/runs/" + REVIEW_FAILED.id + "/retry"]: fail(409, "run_not_retryable") });
    await ctl.confirm();
    ctl.dismiss();
    ctl.openDialog("retry", REVIEW_FAILED);
    await flush();
    await ctl.confirm();
    const [a, b] = keys(call);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it("after a network failure, Try again resends the SAME key; closing and confirming again makes a new one", async () => {
    let n = 0;
    const { ctl, call } = await retryOpen({ ["POST /api/v1/runs/" + REVIEW_FAILED.id + "/retry"]: () => (++n < 3 ? fail(0, "network") : fx("retryRun", "202-accepted.json")) });
    await ctl.confirm();
    expect(dialogOf(ctl)).toMatchObject({ phase: "error", error: "network" });
    expect(sentenceFor("network")).toBe("Couldn't reach the server.");
    await ctl.confirm(); // Try again
    const [first, again] = keys(call);
    expect(again).toBe(first);
    ctl.dismiss();
    ctl.openDialog("retry", REVIEW_FAILED);
    await flush();
    await ctl.confirm();
    expect(keys(call)[2]).not.toBe(first);
  });

  it("a double click on Confirm sends exactly one request", async () => {
    const { ctl, call } = await retryOpen();
    await Promise.all([ctl.confirm(), ctl.confirm()]);
    expect(keys(call)).toHaveLength(1);
  });

  it("Cancel sends no key", async () => {
    const { ctl, call } = await make();
    ctl.openDialog("cancel", LIVE);
    await flush();
    await ctl.confirm();
    expect(call.log.filter((c) => c.method === "POST")).toEqual([{ method: "POST", url: "/api/v1/runs/" + LIVE.id + "/cancel", opts: undefined }]);
  });
});

describe("after the 202", () => {
  it("the card label and action id are kept, Cancel is not offered again, and a repeated action id changes nothing", async () => {
    const { ctl } = await make();
    ctl.openDialog("cancel", LIVE);
    await flush();
    await ctl.confirm();
    expect(ctl.label()).toBe("Cancelling…");
    expect(ctl.pendingOf(LIVE.id).actionId).toBe(ACTION_ID);
    expect(dialogOf(ctl)).toBeNull();
    expect(ctl.controls(LIVE)).toEqual({ cancel: false, retry: false });
    ctl.openDialog("retry", REVIEW_FAILED);
    await flush();
    await ctl.confirm(); // the fake server answers with the same action id
    expect(ctl.pendingOf(REVIEW_FAILED.id)).toBeNull();
    expect(ctl.label()).toBe("Cancelling…");
    expect(ctl.liveTimers()).toBe(1);
  });

  it("the action id goes into the poll URL percent-encoded, so an odd id can't change the path", async () => {
    const odd = "a/b?c d";
    const { ctl, call } = await make({
      ["POST /api/v1/runs/" + LIVE.id + "/cancel"]: { action_id: odd, state: "accepted" },
      ["GET /api/v1/run-actions/" + encodeURIComponent(odd)]: fx("getRunAction", "200-done.json"),
    });
    ctl.openDialog("cancel", LIVE);
    await flush();
    await ctl.confirm();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(call.log.filter((c) => c.url.includes("run-actions")).map((c) => c.url)).toEqual(["/api/v1/run-actions/a%2Fb%3Fc%20d"]);
    expect(ctl.label()).toBeNull();
  });

  it("a retry labels the card 'Retrying…'", async () => {
    const { ctl } = await make();
    ctl.openDialog("retry", REVIEW_FAILED);
    await flush();
    await ctl.confirm();
    expect(ctl.label()).toBe("Retrying…");
  });
});

describe("when the pending label clears (R-8)", () => {
  const cancelled = async (routes) => {
    const m = await make(routes);
    m.ctl.openDialog("cancel", LIVE);
    await flush();
    await m.ctl.confirm();
    return m;
  };
  const retried = async (routes, opts) => {
    const m = await make(routes, opts);
    m.ctl.openDialog("retry", REVIEW_FAILED);
    await flush();
    await m.ctl.confirm();
    return m;
  };
  const polls = (call) => call.count("GET", "/api/v1/run-actions/");

  it("(a) Cancel: a status change of that run to a terminal status clears it and re-reads the list; other changes do not", async () => {
    const { ctl, call } = await cancelled();
    const before = call.count("GET", "/api/v1/runs?");
    ctl.onRunChanged({ runId: "someone-else", from: "running", to: "cancelled" });
    ctl.onRunChanged({ runId: LIVE.id, from: "pending", to: "running" });
    await flush();
    expect(ctl.label()).toBe("Cancelling…");
    expect(call.count("GET", "/api/v1/runs?")).toBe(before + 2); // every change re-reads the list
    ctl.onRunChanged({ runId: LIVE.id, from: "running", to: "cancelled" });
    expect(ctl.label()).toBeNull();
    expect(ctl.liveTimers()).toBe(0);
  });

  it("(a) Retry: the re-read list showing a newer run of the same role clears it, and not before", async () => {
    let list = WORK;
    const { ctl } = await retried({ "GET /api/v1/runs": () => list });
    ctl.onRunChanged({ runId: "x", from: "pending", to: "running" });
    await flush();
    expect(ctl.label()).toBe("Retrying…");
    list = { data: [{ ...LIVE, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9", role: "code-reviewer", status: "pending" }, ...WORK.data], next_cursor: null };
    ctl.onRunChanged({ runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9", from: "pending", to: "running" });
    await flush();
    expect(ctl.label()).toBeNull();
    expect(ctl.liveTimers()).toBe(0);
  });

  it("(b) the poll runs every 5 s; done on a retry re-reads the list and clears", async () => {
    const { ctl, call } = await retried({ ["GET /api/v1/run-actions/" + ACTION_ID]: fx("getRunAction", "200-retry_done.json") });
    const before = call.count("GET", "/api/v1/runs?");
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(polls(call)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls(call)).toBe(1);
    expect(ctl.label()).toBeNull();
    expect(call.count("GET", "/api/v1/runs?")).toBe(before + 1);
    expect(ctl.liveTimers()).toBe(0);
  });

  it("(b) refused (and failed) show the sentence for the error code, not the code", async () => {
    const { ctl } = await retried({ ["GET /api/v1/run-actions/" + ACTION_ID]: fx("getRunAction", "200-retry_refused.json") });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(ctl.label()).toBeNull();
    expect(ctl.getState().notice).toBe(SENTENCES.model_budget_exceeded);
    expect(ctl.getState().notice).not.toMatch(/model_budget_exceeded/);
  });

  it("(b) a poll that is still running goes on until the 3-minute ceiling, then says 'Still working' and stops", async () => {
    const { ctl, call } = await retried({ ["GET /api/v1/run-actions/" + ACTION_ID]: { ...fx("getRunAction", "200-retry_refused.json"), state: "running", error_code: null } });
    await vi.advanceTimersByTimeAsync(CEILING_MS - POLL_MS);
    expect(ctl.label()).toBe("Retrying…");
    expect(polls(call)).toBe(CEILING_MS / POLL_MS - 1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(ctl.label()).toBeNull();
    expect(ctl.getState().notice).toBe("Still working. Check back shortly.");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls(call)).toBe(CEILING_MS / POLL_MS - 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("(b) a hidden tab stops the poll and showing it again resumes it; past 3 minutes it just says so", async () => {
    const running = { ...fx("getRunAction", "200-retry_refused.json"), state: "running", error_code: null };
    const { ctl, call } = await retried({ ["GET /api/v1/run-actions/" + ACTION_ID]: running });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(polls(call)).toBe(2);
    ctl.hide();
    expect(ctl.liveTimers()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls(call)).toBe(2);
    ctl.show();
    expect(ctl.liveTimers()).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(polls(call)).toBe(3);
    ctl.hide();
    await vi.advanceTimersByTimeAsync(CEILING_MS);
    ctl.show();
    expect(ctl.label()).toBeNull();
    expect(ctl.getState().notice).toBe("Still working. Check back shortly.");
    expect(ctl.liveTimers()).toBe(0);
  });
});

describe("refusals are sentences", () => {
  const CODES = [
    "network", "not_cancellable", "run_actions_unavailable", "session_required", "insufficient_role", "untrusted_author", "run_not_retryable",
    "escalate", "author_check_unavailable", "idempotency_key_reused", "account_not_active", "principal_not_authorised", "kind_mismatch",
    "target_not_found", "retry_unavailable", "prompt_not_retained", "seat_refused", "refused_spend", "model_budget_exceeded",
  ];

  it("the table has a sentence for every code the routes and the performer answer, and none repeats its own code", () => {
    for (const code of CODES) {
      expect(SENTENCES[code], code).toMatch(/^[A-Z].*[.]$/);
      expect(SENTENCES[code].includes(code), code).toBe(false);
    }
    for (const [code, sentence] of Object.entries(SENTENCES)) expect(sentence.toLowerCase().includes(code), code).toBe(false);
  });

  it("an unknown code, a missing one and an inherited name all get the generic sentence", () => {
    expect(sentenceFor("from_the_future")).toBe("That didn't work. Nothing was changed.");
    expect(sentenceFor(undefined)).toBe(sentenceFor("constructor"));
  });

  it.each([["account_not_active", 409], ["run_actions_unavailable", 503], ["untrusted_author", 403], ["idempotency_key_reused", 422]])("a %s answer to Confirm keeps the dialog open on that code", async (code, status) => {
    const { ctl } = await make({ ["POST /api/v1/runs/" + REVIEW_FAILED.id + "/retry"]: fail(status, code) });
    ctl.openDialog("retry", REVIEW_FAILED);
    await flush();
    await ctl.confirm();
    expect(dialogOf(ctl)).toMatchObject({ phase: "error", error: code });
    expect(ctl.label()).toBeNull();
  });

  it("not_cancellable is 'already stopped': the dialog closes, the list is read again, and it is a notice", async () => {
    const { ctl, call } = await make({ ["POST /api/v1/runs/" + LIVE.id + "/cancel"]: fail(409, "not_cancellable") });
    const before = call.count("GET", "/api/v1/runs?");
    ctl.openDialog("cancel", LIVE);
    await flush();
    await ctl.confirm();
    await flush();
    expect(dialogOf(ctl)).toBeNull();
    expect(ctl.getState().notice).toBe("This run has already stopped.");
    expect(call.count("GET", "/api/v1/runs?")).toBe(before + 1);
  });

  it("a 401 closes the dialog and says nothing: the shell's live client owns it", async () => {
    const { ctl } = await make({ ["POST /api/v1/runs/" + LIVE.id + "/cancel"]: fail(401, "http_401") });
    ctl.openDialog("cancel", LIVE);
    await flush();
    await ctl.confirm();
    expect(dialogOf(ctl)).toBeNull();
    expect(ctl.getState().notice).toBeNull();
  });
});

describe("no leaks", () => {
  it("twenty open/close cycles with a pending action leave no timer and no live poll", async () => {
    for (let i = 0; i < 20; i++) {
      const { ctl } = await make();
      ctl.openDialog("cancel", LIVE);
      await flush();
      await ctl.confirm();
      expect(ctl.liveTimers()).toBe(1);
      ctl.destroy();
      expect(ctl.liveTimers()).toBe(0);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("nothing is sent or changed after destroy", async () => {
    const { ctl, call } = await make();
    ctl.openDialog("cancel", LIVE);
    ctl.destroy();
    const n = call.log.length;
    await ctl.confirm();
    ctl.onRunChanged({ runId: LIVE.id, to: "cancelled" });
    await flush();
    expect(call.log.length).toBe(n);
  });
});

// The dialog's DOM half, against a small stand-in for the few DOM calls the panel makes (no jsdom here).
class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.kids = []; this.on = {}; this.className = ""; this.hidden = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { this.on[t] = f; }
  appendChild(c) { this.kids.push(c); return c; }
  replaceChildren(...c) { this.kids = c; }
  remove() {}
  close() {}
  showModal() {}
  focus() { globalThis.document.activeElement = this; }
  querySelector() { return null; }
  contains(n) { return n === this || this.kids.some((k) => k instanceof FakeEl && k.contains(n)); }
  get textContent() { return this.kids.map((k) => (k instanceof FakeEl ? k.textContent : k.text)).join(""); }
  set textContent(t) { this.kids = [{ text: String(t) }]; }
}
const findAll = (el, test, out = []) => (test(el) && out.push(el), el.kids.forEach((k) => k instanceof FakeEl && findAll(k, test, out)), out);
const byTest = (root, id) => findAll(root, (e) => e.getAttribute("data-testid") === id)[0];

describe("the dialog's description and button names", () => {
  let body;
  beforeEach(() => {
    body = new FakeEl("body");
    vi.stubGlobal("Node", FakeNode);
    vi.stubGlobal("document", {
      body, activeElement: null, visibilityState: "visible", addEventListener() {}, removeEventListener() {},
      createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function panel(routes = {}) {
    const { call } = await make(routes);
    const p = createRunsPanel({ itemId: ITEM, repoId: REPO, call, uuid: () => "00000000-0000-4000-8000-000000000001" });
    await flush();
    const open = async (testid) => {
      byTest(p.el, testid).on.click();
      await flush();
      return body.kids[body.kids.length - 1];
    };
    return { p, open };
  }

  it("the dialog is described by its own cost lines, with an id no other dialog has, and not by the error", async () => {
    const { p, open } = await panel({ ["POST /api/v1/runs/" + LIVE.id + "/cancel"]: fail(503, "run_actions_unavailable") });
    const first = await open("pl-cancel");
    const info = byTest(first, "pl-dialog-info");
    expect(info.getAttribute("id")).toBe(first.getAttribute("aria-describedby"));
    expect(info.textContent).toContain("Spent so far");
    byTest(first, "pl-confirm").on.click();
    await flush();
    expect(byTest(first, "pl-dialog-error").textContent).not.toBe("");
    expect(info.contains(byTest(first, "pl-dialog-error"))).toBe(false);
    byTest(first, "pl-dialog-close").on.click();
    const second = await open("pl-retry");
    const id = second.getAttribute("aria-describedby");
    expect(id).toMatch(/^pl-dlg-d-\d+$/);
    expect(id).not.toBe(first.getAttribute("aria-describedby"));
    expect(byTest(second, "pl-dialog-info").getAttribute("id")).toBe(id);
    p.destroy();
  });

  it("each dialog names what Confirm does and what staying does; after a failure the dismiss is plain Close", async () => {
    const { p, open } = await panel({ ["POST /api/v1/runs/" + REVIEW_FAILED.id + "/retry"]: fail(503, "run_actions_unavailable") });
    const c = await open("pl-cancel");
    expect([byTest(c, "pl-confirm").textContent, byTest(c, "pl-dialog-close").textContent]).toEqual(["Yes, cancel run", "Keep the run"]);
    byTest(c, "pl-dialog-close").on.click();
    const r = await open("pl-retry");
    expect([byTest(r, "pl-confirm").textContent, byTest(r, "pl-dialog-close").textContent]).toEqual(["Yes, retry run", "Don't retry"]);
    byTest(r, "pl-confirm").on.click();
    await flush();
    expect(byTest(r, "pl-confirm").hidden).toBe(true);
    expect(byTest(r, "pl-dialog-close").textContent).toBe("Close");
    p.destroy();
  });
});
