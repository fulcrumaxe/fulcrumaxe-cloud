import { describe, expect, it, vi } from "vitest";
import type { InstallationHttp, InstallationHttpRequest } from "@fx/github";
import { findPrBody, fixDescentBody, startFixBody, type OpenHttp, type ReviewCtx, type ReviewWorker } from "./advanceReviewSteps";

/**
 * D#599 PL-2b-2: the review steps around a round that works on a pull request the other side opened: how the pull request is found, what the fix step
 * sends the worker, and the descent check after a cross-side sandbox round. GitHub is a fake that answers with its real shapes.
 */
const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const RUN_BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";
const who = { accountId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002", workItemId: "00000000-0000-4000-8000-000000000003", haltEpoch: 0 };

const ctx = (over: Partial<ReviewCtx> = {}): ReviewCtx => ({
  repoId: "00000000-0000-4000-8000-000000000004",
  owner: "acme",
  name: "widgets",
  issue: 12,
  branch: "fx/issue-12",
  tier: "standard",
  specVersion: 3,
  debaterEnabled: false,
  executionMode: "sandbox",
  prExecutionMode: "runner_local",
  recordedPr: null,
  ...over,
});

function github(handler: (req: InstallationHttpRequest) => { status: number; body: unknown }): { open: OpenHttp; calls: InstallationHttpRequest[]; kinds: string[] } {
  const calls: InstallationHttpRequest[] = [];
  const kinds: string[] = [];
  const open: OpenHttp = async (kind) => {
    kinds.push(kind);
    const http: InstallationHttp = { request: async (req) => (calls.push(req), handler(req)) };
    return http;
  };
  return { open, calls, kinds };
}

describe("findPrBody", () => {
  const pull = (over: Record<string, unknown> = {}) => ({ number: 41, state: "open", head: { sha: NEXT, ref: RUN_BRANCH, repo: { full_name: "acme/widgets" } }, base: { ref: "main" }, ...over });
  const answer = (req: InstallationHttpRequest) => {
    if (req.path === "/repos/acme/widgets/pulls/41") return { status: 200, body: pull() };
    if (req.path === "/repos/acme/widgets/pulls/41/files") return { status: 200, body: [{ filename: "a.ts", changes: 1 }] };
    return { status: 404, body: {} };
  };

  it("follows the pull request a cross-side sandbox round was bound to, by number and branch, whatever side opened it", async () => {
    const gh = github(answer);
    const out = await findPrBody(gh.open, ctx({ prExecutionMode: "sandbox", recordedPr: { number: 41, branch: RUN_BRANCH, bound: true } }));
    expect(out).toMatchObject({ ok: true, number: 41, headSha: NEXT, branch: RUN_BRANCH });
    expect(gh.calls.map((c) => c.path)).toEqual(["/repos/acme/widgets/pulls/41", "/repos/acme/widgets/pulls/41/files"]);
  });

  it("refuses when the bound pull request's head is another branch, or it is closed", async () => {
    const other = await findPrBody(github((r) => (r.path.endsWith("/pulls/41") ? { status: 200, body: pull({ head: { sha: NEXT, ref: "fx/issue-12", repo: { full_name: "acme/widgets" } } }) } : answer(r))).open, ctx({ prExecutionMode: "sandbox", recordedPr: { number: 41, branch: RUN_BRANCH, bound: true } }));
    expect(other).toEqual({ ok: false, reason: "malformed" });
    const closed = await findPrBody(github((r) => (r.path.endsWith("/pulls/41") ? { status: 200, body: pull({ state: "closed" }) } : answer(r))).open, ctx({ prExecutionMode: "sandbox", recordedPr: { number: 41, branch: RUN_BRANCH, bound: true } }));
    expect(closed).toEqual({ ok: false, reason: "no_open_pr" });
  });

  it("a sandbox pair without the bound flag (a stray record) is not used: the sandbox build is found by fx/issue-<n>", async () => {
    const gh = github((r) => (r.path === "/repos/acme/widgets/pulls" ? { status: 200, body: [{ number: 41, head: { sha: HEAD, repo: { full_name: "acme/widgets" } }, base: { ref: "main" } }] } : answer(r)));
    const out = await findPrBody(gh.open, ctx({ prExecutionMode: "sandbox", recordedPr: { number: 99, branch: RUN_BRANCH } }));
    expect(out).toMatchObject({ ok: true, number: 41, branch: "fx/issue-12" });
    expect(gh.calls.map((c) => c.path)).not.toContain("/repos/acme/widgets/pulls/99");
  });

  it("a sandbox build with no recorded pair is still found by fx/issue-<n>", async () => {
    const gh = github((r) => (r.path === "/repos/acme/widgets/pulls" ? { status: 200, body: [{ number: 41, head: { sha: HEAD, repo: { full_name: "acme/widgets" } }, base: { ref: "main" } }] } : answer(r)));
    const out = await findPrBody(gh.open, ctx({ prExecutionMode: "sandbox", recordedPr: null }));
    expect(out).toMatchObject({ ok: true, branch: "fx/issue-12" });
    expect(gh.calls[0]!.query).toMatchObject({ head: "acme:fx/issue-12" });
  });
});

describe("startFixBody", () => {
  const worker = () => {
    const advanceStartFix = vi.fn(async (_who: unknown, _req: unknown) => ({ ok: true as const, runId: "00000000-0000-4000-8000-0000000000aa" }));
    const w = {
      advanceLoadSpecText: async () => ({ version: 3, body: "1. The footer shows the year." }),
      advanceRunOutcome: async () => ({ status: "succeeded", done: true, envelope: { verdict: "needs-fix", findings: ["a.ts:1 - wrong"], summary: "one problem" } }),
      advanceStartFix,
    } as unknown as ReviewWorker;
    return { w, advanceStartFix };
  };
  const failing = [{ role: "code-reviewer", runId: "00000000-0000-4000-8000-0000000000bb" }];
  const pr = { number: 41, headSha: HEAD, branch: RUN_BRANCH };
  const ACTION = "00000000-0000-4000-8000-0000000000cc";

  it("a round on the other side from the one that opened the pull request sends the pull request and a prompt that continues its branch without force", async () => {
    const t = worker();
    const out = await startFixBody(t.w, who, ctx({ executionMode: "sandbox", prExecutionMode: "runner_local" }), pr, ACTION, 1, failing);
    expect(out.ok).toBe(true);
    const sent = t.advanceStartFix.mock.calls[0]![1] as { pr?: unknown; prompt: string };
    expect(sent.pr).toEqual({ number: 41, branch: RUN_BRANCH });
    expect(sent.prompt).toContain(`git checkout -B ${RUN_BRANCH} origin/${RUN_BRANCH}`);
    expect(sent.prompt).toContain(`git merge-base --is-ancestor ${HEAD} HEAD`);
    expect(sent.prompt).toMatch(/Never use --force/);
  });

  it("a runner round on a sandbox-built pull request sends the pull request and the runner prompt (the platform publishes the commit)", async () => {
    const t = worker();
    await startFixBody(t.w, who, ctx({ executionMode: "runner_local", prExecutionMode: "sandbox" }), { ...pr, branch: "fx/issue-12" }, ACTION, 1, failing);
    const sent = t.advanceStartFix.mock.calls[0]![1] as { pr?: unknown; prompt: string };
    expect(sent.pr).toEqual({ number: 41, branch: "fx/issue-12" });
    expect(sent.prompt).toContain("Do not push");
  });

  it("a same-side sandbox round sends the pull request GitHub just showed (for the base sync) and the unchanged prompt", async () => {
    const t = worker();
    await startFixBody(t.w, who, ctx({ executionMode: "sandbox", prExecutionMode: "sandbox" }), { ...pr, branch: "fx/issue-12" }, ACTION, 1, failing);
    const sent = t.advanceStartFix.mock.calls[0]![1] as { pr?: unknown; prompt: string };
    expect(sent.pr).toEqual({ number: 41, branch: "fx/issue-12" });
    expect(sent.prompt).toContain("This continues your earlier session");
  });

  it("a same-side runner round sends no pull request", async () => {
    const t = worker();
    await startFixBody(t.w, who, ctx({ executionMode: "runner_local", prExecutionMode: "runner_local" }), pr, ACTION, 1, failing);
    const sent = t.advanceStartFix.mock.calls[0]![1] as { pr?: unknown };
    expect("pr" in sent).toBe(false);
  });
});

describe("fixDescentBody", () => {
  const compare = (status: unknown, httpStatus = 200) => github((r) => (r.path === `/repos/acme/widgets/compare/${HEAD}...${NEXT}` ? { status: httpStatus, body: { status } } : { status: 404, body: {} }));

  it("is not needed for a same-side round, or for a runner round", async () => {
    const gh = compare("ahead");
    expect(await fixDescentBody(gh.open, ctx({ executionMode: "sandbox", prExecutionMode: "sandbox" }), HEAD, NEXT)).toEqual({ state: "not_needed" });
    expect(await fixDescentBody(gh.open, ctx({ executionMode: "runner_local", prExecutionMode: "sandbox" }), HEAD, NEXT)).toEqual({ state: "not_needed" });
    expect(gh.calls).toEqual([]);
  });

  it("a cross-side sandbox round descends when GitHub says ahead (or identical)", async () => {
    for (const status of ["ahead", "identical"]) {
      expect(await fixDescentBody(compare(status).open, ctx(), HEAD, NEXT), status).toEqual({ state: "descends" });
    }
  });

  it("a rewritten branch (diverged, behind) is rewritten, and an answer GitHub cannot give is unavailable, never a pass", async () => {
    for (const status of ["diverged", "behind"]) expect(await fixDescentBody(compare(status).open, ctx(), HEAD, NEXT), status).toEqual({ state: "rewritten" });
    expect(await fixDescentBody(compare("ahead", 502).open, ctx(), HEAD, NEXT)).toEqual({ state: "unavailable" });
    expect(await fixDescentBody(compare("sideways").open, ctx(), HEAD, NEXT)).toEqual({ state: "unavailable" });
    expect(await fixDescentBody(null, ctx(), HEAD, NEXT)).toEqual({ state: "unavailable" });
    const throwing: OpenHttp = async () => {
      throw new Error("no installation");
    };
    expect(await fixDescentBody(throwing, ctx(), HEAD, NEXT)).toEqual({ state: "unavailable" });
  });
});

/**
 * SANDBOX-RERUN-BRANCH-a, criterion 5 (the web side): after a sandbox Build again the item's branch is run 2's `fx/<run>-g1` (the review context builder is tested against Postgres in the
 * pipeline package). Run 1 is on `fx/issue-12` with its pull request closed; run 2's is open. The fake answers the head- and state-filtered pulls list the way GitHub does.
 */
describe("findPrBody after a sandbox re-run", () => {
  const RUN2 = "fx/7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f-g1";
  const entry = (number: number, ref: string, state: "open" | "closed") => ({ number, state, head: { sha: NEXT, ref, repo: { full_name: "acme/widgets" } }, base: { ref: "main" } });
  const world = (pulls: Array<ReturnType<typeof entry>>) =>
    github((r) => {
      if (r.path === "/repos/acme/widgets/pulls") return { status: 200, body: pulls.filter((p) => p.state === (r.query?.state ?? "open") && r.query?.head === `acme:${p.head.ref}`) };
      const one = /^\/repos\/acme\/widgets\/pulls\/(\d+)$/.exec(r.path);
      if (one) return { status: 200, body: pulls.find((p) => p.number === Number(one[1])) ?? {} };
      if (r.path.endsWith("/files")) return { status: 200, body: [{ filename: "a.ts", changes: 1 }] };
      return { status: 404, body: {} };
    });
  const both = [entry(40, "fx/issue-12", "closed"), entry(41, RUN2, "open")];

  it("with no recorded pair, run 2's pull request is found by the run branch the context names", async () => {
    const gh = world(both);
    expect(await findPrBody(gh.open, ctx({ branch: RUN2, prExecutionMode: "sandbox", recordedPr: null }))).toMatchObject({ ok: true, number: 41, branch: RUN2 });
    expect(gh.calls[0]!.query).toMatchObject({ head: `acme:${RUN2}` });
  });

  it("with a bound pair (a cross-side round), the pair's pull request is followed by number and branch, and run 1's closed pull request on the fixed name is never returned", async () => {
    const gh = world(both);
    expect(await findPrBody(gh.open, ctx({ branch: RUN2, prExecutionMode: "sandbox", recordedPr: { number: 41, branch: RUN2, bound: true } }))).toMatchObject({ ok: true, number: 41, branch: RUN2 });
    const stale = world(both);
    expect(await findPrBody(stale.open, ctx({ branch: RUN2, prExecutionMode: "sandbox", recordedPr: { number: 40, branch: "fx/issue-12", bound: true } }))).toEqual({ ok: false, reason: "no_open_pr" });
  });

  it("a head list that holds only run 1's closed pull request is no_open_pr, bound pair or none", async () => {
    const onlyFirst = world([entry(40, "fx/issue-12", "closed")]);
    expect(await findPrBody(onlyFirst.open, ctx({ branch: RUN2, prExecutionMode: "sandbox", recordedPr: null }))).toEqual({ ok: false, reason: "no_open_pr" });
    expect(await findPrBody(onlyFirst.open, ctx({ branch: RUN2, prExecutionMode: "sandbox", recordedPr: { number: 40, branch: "fx/issue-12", bound: true } }))).toEqual({ ok: false, reason: "no_open_pr" });
  });
});
