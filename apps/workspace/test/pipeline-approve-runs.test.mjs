// apps/workspace/test/pipeline-approve-runs.test.mjs
//
// D#483: the card's approve button when runner runs wait for this person. A pending run counts as live, so the plain
// stage button was hidden (or, drawn before the runs loaded, did nothing). Now one click approves every pending run
// of the item this person may approve, by the same per-run route, and says what happened. Real createRunsPanel against
// a fake call() and a small DOM stand-in (no jsdom here); the real page is driven in e2e/pipeline-approve-runs.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveView, createApprove, createApprovals, createRunsPanel, runApprovePath, RUN_APPROVALS_PATH, RUNNERS_PATH } from "../apps/pipeline/pipeline-actions.js";

const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const REPO = "99999999-9999-4999-8999-999999999999";
const R1 = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const R2 = "11111111-1111-4111-8111-bbbbbbbbbbbb";
const R3 = "11111111-1111-4111-8111-cccccccccccc";
const ME = "33333333-3333-4333-8333-333333333333";
const COPY = {
  approval: "Waiting for {person} to approve (it runs on their Claude plan).",
  approvalMine: "This run needs your approval. It runs on your Claude plan.",
  approvalButton: "Approve run",
  approvalDone: "Approved. Waiting for your runner.",
  approvalRefused: "This run can no longer be approved.",
  approvalAuto: "Approved automatically. It runs on {person}'s Claude plan.",
};
const GENERIC = "That didn't work. Nothing was changed.";
const PR_ITEM = { id: ITEM_ID, stage: "pr_opened", provenance: "internal", repo_id: REPO, issue_number: 7, kind: "feature" };
const run = (id, role, over = {}) => ({ id, work_item_id: ITEM_ID, parent_run_id: null, role, status: "pending", usd: null, tokens_in: null, tokens_out: null, created_at: "2026-10-16T05:00:00.000Z", updated_at: "2026-10-16T05:00:00.000Z", approved_by: null, approval: null, ...over });
const RUNS = [run(R1, "code-reviewer"), run(R2, "acceptance-tester"), run(R3, "security-reviewer")];
const entry = (run_id, over = {}) => ({ run_id, work_item_id: ITEM_ID, role: "x", repo_name: "a/b", created_at: "2026-10-16T05:00:00.000Z", approvers: [{ id: ME, name: "Ada" }], can_approve: true, ...over });
const fail = (status, code) => Object.assign(new Error("server text that must never be shown"), { status, code });
const flush = () => vi.advanceTimersByTimeAsync(0);

class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.kids = []; this.on = {}; this.className = ""; this.hidden = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { this.on[t] = f; }
  appendChild(c) { this.kids.push(c); return c; }
  replaceChildren(...c) { this.kids = c; }
  remove() {}
  focus() {}
  querySelector() { return null; }
  contains(n) { return n === this || this.kids.some((k) => k instanceof FakeEl && k.contains(n)); }
  get textContent() { return this.kids.map((k) => (k instanceof FakeEl ? k.textContent : k.text)).join(""); }
  set textContent(t) { this.kids = [{ text: String(t) }]; }
}
const findAll = (el, test, out = []) => (test(el) && out.push(el), el.kids.forEach((k) => k instanceof FakeEl && findAll(k, test, out)), out);
const byTest = (root, id) => findAll(root, (e) => e.getAttribute("data-testid") === id)[0];

/** A fake server: the runs list, the approvals read, and the per-run POST (status per run id, 200 removes the wait). */
function server({ posts = {}, approvals = RUNS.map((r) => entry(r.id)) } = {}) {
  const state = { approvals: [...approvals], log: [] };
  const call = async (method, url) => {
    const path = url.split("?")[0];
    state.log.push(method + " " + path);
    if (method === "GET" && path === "/api/v1/runs") return { data: RUNS, next_cursor: null };
    if (method === "GET" && path === RUN_APPROVALS_PATH) return { approvals: state.approvals };
    if (method === "GET" && path === RUNNERS_PATH) return { runners: [], copy: COPY };
    const m = /^\/api\/runners\/runs\/([^/]+)\/approve$/.exec(path);
    if (method === "POST" && m) {
      const s = posts[m[1]] ?? 200;
      if (s !== 200) throw fail(s, "x");
      state.approvals = state.approvals.filter((a) => a.run_id !== m[1]);
      return { approved: true, changed: true };
    }
    if (method === "POST" && /^\/api\/v1\/work-items\/[^/]+\/approve$/.test(path)) return { action_id: null };
    throw fail(404, "not_found");
  };
  call.state = state;
  call.posted = () => state.log.filter((l) => l.startsWith("POST /api/runners/")).map((l) => l.split("/")[4]);
  return call;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("document", { body: new FakeEl("body"), activeElement: null, visibilityState: "visible", addEventListener() {}, removeEventListener() {}, createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function panelOn(call) {
  const onChange = vi.fn();
  const p = createRunsPanel({ itemId: ITEM_ID, repoId: REPO, call, uuid: () => "00000000-0000-4000-8000-000000000001", onChange });
  await flush();
  await flush();
  return { p, onChange };
}

describe("approvableIds", () => {
  it("lists the pending runs the server says this person may approve, and no one else's", async () => {
    const call = server({ approvals: [entry(R1), entry(R2, { can_approve: false }), entry(R3)] });
    const a = createApprovals({ call });
    a.sync(RUNS);
    await flush();
    await flush();
    expect(a.approvableIds(RUNS)).toEqual([R1, R3]);
    expect(a.approvableIds([{ ...RUNS[0], status: "running" }])).toEqual([]);
    a.destroy();
  });
});

describe("the card's button for waiting runner runs", () => {
  it("is offered while pending runs wait for this person (a pending run is live, which used to hide it) and one click approves every one by the per-run route", async () => {
    const call = server();
    const { p, onChange } = await panelOn(call);
    expect(p.hasLive()).toBe(true);
    expect(p.approvableCount()).toBe(3);
    expect(onChange).toHaveBeenCalled(); // the parent redraws when the count changes, so the button appears without a reload
    const approver = createApprove({ call, sleep: async () => {} });
    const btn = byTest(approveView(PR_ITEM, approver, true, p), "pl-approve-btn");
    expect(btn.textContent).toBe("Approve and review");
    btn.on.click();
    await flush();
    await flush();
    expect(call.posted().sort()).toEqual([R1, R2, R3].sort());
    expect(approver.state).toMatchObject({ phase: "started", text: COPY.approvalDone });
    // nothing is left to approve: only the answer stays, no button
    const after = approveView(PR_ITEM, approver, true, p);
    expect(byTest(after, "pl-approve-btn")).toBeUndefined();
    expect(byTest(after, "pl-approve-note").textContent).toBe("Approved. Waiting for your runner.");
    p.destroy();
  });

  it("a double click is still one request per run", async () => {
    const call = server();
    const { p } = await panelOn(call);
    const approver = createApprove({ call, sleep: async () => {} });
    const btn = byTest(approveView(PR_ITEM, approver, true, p), "pl-approve-btn");
    btn.on.click();
    btn.on.click();
    await flush();
    await flush();
    expect(call.posted()).toHaveLength(3);
    p.destroy();
  });

  it("a refusal (403) shows the refusal sentence, never the server's text, and the button stays for a retry", async () => {
    const call = server({ posts: { [R2]: 403 } });
    const { p } = await panelOn(call);
    const approver = createApprove({ call, sleep: async () => {} });
    byTest(approveView(PR_ITEM, approver, true, p), "pl-approve-btn").on.click();
    await flush();
    await flush();
    expect(approver.state).toMatchObject({ phase: "error", text: COPY.approvalRefused });
    expect(p.approvableCount()).toBe(1); // R2 still waits
    const again = approveView(PR_ITEM, approver, true, p);
    expect(byTest(again, "pl-approve-btn")).toBeDefined();
    expect(byTest(again, "pl-approve-note").textContent).not.toContain("server text");
    p.destroy();
  });

  it("any other failure (500) is shown as an error, never silent", async () => {
    const call = server({ posts: { [R1]: 500 } });
    const { p } = await panelOn(call);
    const approver = createApprove({ call, sleep: async () => {} });
    byTest(approveView(PR_ITEM, approver, true, p), "pl-approve-btn").on.click();
    await flush();
    await flush();
    expect(approver.state).toMatchObject({ phase: "error", text: GENERIC });
    p.destroy();
  });

  it("without pending runs this person may approve, the plain stage button is unchanged", async () => {
    const call = server({ approvals: [entry(R1, { can_approve: false })] });
    const { p } = await panelOn(call);
    expect(p.approvableCount()).toBe(0);
    const approver = createApprove({ call, sleep: async () => {} });
    const view = approveView({ ...PR_ITEM }, approver, false, null);
    byTest(view, "pl-approve-btn").on.click();
    await flush();
    expect(call.state.log.some((l) => l.startsWith("POST /api/v1/work-items/"))).toBe(true);
    p.destroy();
  });

  it("a triaged card whose Approve and start made a waiting project-manager run shows that run's waiting sentence and an Approve control, then approves it", async () => {
    const pm = run(R1, "project-manager");
    const call = server({ approvals: [entry(R1)] });
    const base = call;
    const only = async (m, u, ...r) => (m === "GET" && u.split("?")[0] === "/api/v1/runs" ? { data: [pm], next_cursor: null } : base(m, u, ...r));
    only.posted = base.posted;
    const { p } = await panelOn(only);
    const triaged = { ...PR_ITEM, stage: "triaged" };
    const approver = createApprove({ call: only, sleep: async () => {} });
    const view = approveView(triaged, approver, true, p);
    expect(byTest(view, "pl-approve-hint").textContent).toBe(COPY.approvalMine);
    expect(byTest(view, "pl-approve-btn").textContent).toBe("Approve run"); // never "Approve and start" a second time
    byTest(view, "pl-approve-btn").on.click();
    await flush();
    await flush();
    expect(only.posted()).toEqual([R1]);
    expect(approver.state.text).toBe(COPY.approvalDone);
    p.destroy();
  });

  it("if the copy is not read when every run was approved, the approved sentence is still the right one, not a failure", async () => {
    const base = server();
    const noCopy = async (m, u, ...r) => {
      if (m === "GET" && u.split("?")[0] === RUNNERS_PATH) throw fail(500, "x"); // the copy cannot be read
      return base(m, u, ...r);
    };
    const { p } = await panelOn(noCopy);
    expect(p.approvableCount()).toBeGreaterThan(0);
    const out = await p.approveAll();
    expect(out).toEqual({ ok: true, text: "Approved. Waiting for your runner." });
    p.destroy();
  });

  it("the per-run path is the one the row button uses", () => {
    expect(runApprovePath(R1)).toBe("/api/runners/runs/" + R1 + "/approve");
  });
});
