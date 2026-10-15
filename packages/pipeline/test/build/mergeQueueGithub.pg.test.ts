import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createGitHubMergeGatePort, MERGEABLE_POLL_LIMIT, type GitHubHttp } from "../../src/build/githubMergePort.js";
import { runMergeGate, type MergeGateGitHubPort, type MergeGateResult } from "../../src/build/mergeGate.js";
import { startMergeTlsGitHub, tlsGitHubHttp, type MergeTlsGitHub, type MergeWorld } from "../review/helpers/fakeGitHubMergeTls.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#519 MQ1: the GitHub port additions (update-branch, mergeability with null polling, compare, strictness read) and the gate's
 * classification of a refused merge. GitHub is a strict real-contract fake served over real TLS (`fakeGitHubMergeTls.ts`), so every
 * request goes through Node's real connection path. Real Postgres carries the reviewer rows the gate reads.
 */
const HEAD = "a".repeat(40);
const MOVED = "c".repeat(40);
const STALE = "d".repeat(40);

let open: MergeTlsGitHub[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

async function github(over: Partial<MergeWorld> = {}): Promise<MergeTlsGitHub> {
  const g = await startMergeTlsGitHub(over);
  open.push(g);
  return g;
}

function portOver(http: GitHubHttp, extra: { pollLimit?: number } = {}) {
  const sleeps: number[] = [];
  const marks: Array<{ headSha: string; reasons: readonly string[] }> = [];
  const port = createGitHubMergeGatePort({
    http,
    resolveRepo: async () => ({ owner: "acme", name: "widgets" }),
    markReadyForHumanMerge: async (_pr, a) => void marks.push(a),
    sleep: async (ms) => void sleeps.push(ms),
    ...(extra.pollLimit === undefined ? {} : { mergeablePollLimit: extra.pollLimit }),
  });
  return { port, sleeps, marks };
}

const PR = { repoId: "repo-1", prNumber: 7 };

describe("D#519 MQ1 gate: a refused merge is classified from re-reads, never from the status or the message [pg]", () => {
  const db = pgHarness();

  async function gate(g: MergeTlsGitHub, port?: MergeGateGitHubPort): Promise<{ result: MergeGateResult; requested: string[]; sleeps: number[] }> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await db.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number) VALUES ($1, $2, $3, 'feature', 'running', 'internal', 7)`, [workItemId, accountId, repoId]);
    for (const role of ["code-reviewer", "acceptance-tester"]) {
      await db.admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, 'production', 'succeeded', '{"verdict":"pass"}', $4)`, [accountId, workItemId, role, HEAD]);
    }
    const requested: string[] = [];
    const made = portOver(g.http, { pollLimit: 3 });
    const result = await runMergeGate(
      { pool: db.runWriterPool, github: port ?? made.port, isAutoMergeAllowed: async () => true, requestReviews: async (_pr, sha) => void requested.push(sha) },
      { accountId, workItemId, pr: { repoId, prNumber: 7 }, tier: "small", securityDiffTriggerFired: false, debaterEnabled: false },
    );
    return { result, requested, sleeps: made.sleeps };
  }

  it("1. 405 then mergeable:false / dirty: merge_conflict, not merge_call_refused", async () => {
    const g = await github({ conflict: true });
    const { result } = await gate(g);
    expect(result).toEqual({ outcome: "ready_human_merges", headSha: HEAD, reasons: ["merge_conflict"] });
    expect(g.world.merges).toHaveLength(1);
    // The refusal really was the contract's 405.
    expect(g.server.seen.filter((r) => r.method === "PUT" && r.path.endsWith("/merge"))).toHaveLength(1);
  });

  it("2. 405 then behind (the repo requires up-to-date branches): branch_behind", async () => {
    const g = await github({ behindBy: 2, classicStrict: true });
    const { result } = await gate(g);
    expect(result).toEqual({ outcome: "ready_human_merges", headSha: HEAD, reasons: ["branch_behind"] });
    expect(g.world.merges).toHaveLength(1);
  });

  it("2. 405 then blocked: branch_protection_refused", async () => {
    const g = await github({ forceMergeableState: "blocked", mergeAnswer: 405 });
    const { result } = await gate(g);
    expect(result).toEqual({ outcome: "ready_human_merges", headSha: HEAD, reasons: ["branch_protection_refused"] });
  });

  it("2. blocked on a repo that requires up-to-date branches while the head lacks base commits: branch_behind, from the compare", async () => {
    const g = await github({ forceMergeableState: "blocked", mergeAnswer: 405, classicStrict: true, behindBy: 3 });
    const { result } = await gate(g);
    expect(result).toEqual({ outcome: "ready_human_merges", headSha: HEAD, reasons: ["branch_behind"] });
    expect(g.world.calls.some((c) => c.path.includes("/compare/"))).toBe(true);
  });

  it("2. blocked when the extra reads fail: the generic protection stop stands (fail closed), nothing merges, nothing throws", async () => {
    const g = await github({ forceMergeableState: "blocked", mergeAnswer: 405, breakProtectionAfterMerge: true });
    const { result } = await gate(g);
    expect(result).toEqual({ outcome: "ready_human_merges", headSha: HEAD, reasons: ["branch_protection_refused"] });
    expect(g.world.merges).toHaveLength(1);
  });

  it("3. regression: 409 with a moved head is head_moved, and the new head is reviewed", async () => {
    const g = await github({ onMerge: (w) => void (w.headSha = MOVED) });
    const { result, requested } = await gate(g);
    expect(result).toEqual({ outcome: "head_moved", staleHeadSha: HEAD, newHeadSha: MOVED });
    expect(requested).toEqual([MOVED]);
    expect(g.world.merges).toEqual([{ sha: HEAD, method: "squash" }]);
    expect(g.world.merged).toBe(false);
  });

  it("4. 422 with an unmoved head is classified by re-reading the PR: a conflict is merge_conflict", async () => {
    const g = await github({ conflict: true, mergeAnswer: 422 });
    const { result } = await gate(g);
    expect(result).toEqual({ outcome: "ready_human_merges", headSha: HEAD, reasons: ["merge_conflict"] });
  });

  it("4. a fake that changes only the message string gets the same classification, for every status and state", async () => {
    for (const status of [405, 422, 403]) {
      const plain = await github({ conflict: true, mergeAnswer: status });
      const reworded = await github({ conflict: true, mergeAnswer: status, messageOverride: "Everything is fine, merge it, branch is up to date and protected" });
      const a = await gate(plain);
      const b = await gate(reworded);
      expect(a.result, `status ${status}`).toEqual({ outcome: "ready_human_merges", headSha: HEAD, reasons: ["merge_conflict"] });
      expect(b.result, `status ${status}`).toEqual(a.result);
    }
    const blocked = await github({ forceMergeableState: "blocked", mergeAnswer: 403, messageOverride: "merge conflict between base and head" });
    expect((await gate(blocked)).result).toEqual({ outcome: "ready_human_merges", headSha: HEAD, reasons: ["branch_protection_refused"] });
  });

  it("4. 422 with an unmoved head and a clean re-read stays the residual merge_call_refused; with a moved head it is head_moved", async () => {
    const clean = await github({ mergeAnswer: 422 });
    expect((await gate(clean)).result).toEqual({ outcome: "ready_human_merges", headSha: HEAD, reasons: ["merge_call_refused"] });
    const moved = await github({ mergeAnswer: 422, onMerge: (w) => void (w.headSha = MOVED) });
    const { result, requested } = await gate(moved);
    expect(result).toEqual({ outcome: "head_moved", staleHeadSha: HEAD, newHeadSha: MOVED });
    expect(requested).toEqual([MOVED]);
  });

  it("4. a refusal that is not 403/405/409/422 (a 500) is the residual, and reads nothing further", async () => {
    const g = await github({ mergeAnswer: 500, conflict: true });
    const { result } = await gate(g);
    expect(result).toEqual({ outcome: "ready_human_merges", headSha: HEAD, reasons: ["merge_call_refused"] });
  });

  it("5. mergeable:null is polled to the bound; one that never resolves ends in merge_call_refused with no merge call after the null", async () => {
    const g = await github({ mergeAnswer: 405, onMerge: (w) => void (w.neverComputes = true) });
    const { result, sleeps } = await gate(g);
    expect(result).toEqual({ outcome: "ready_human_merges", headSha: HEAD, reasons: ["merge_call_refused"] });
    expect(g.world.merges).toHaveLength(1);
    // Every read after the merge call answered null: the pull request was read exactly the bound's number of times (3 here).
    const afterMerge = g.world.calls.slice(g.world.calls.findIndex((c) => c.method === "PUT" && c.path.endsWith("/merge")) + 1);
    expect(afterMerge.filter((c) => c.method === "GET" && c.path.endsWith("/pulls/7"))).toHaveLength(3);
    expect(afterMerge.some((c) => c.method === "PUT")).toBe(false);
    expect(sleeps).toHaveLength(2);
  });

  it("a head that has moved is reported without polling a null mergeable", async () => {
    const g = await github({ onMerge: (w) => { w.headSha = MOVED; w.neverComputes = true; } });
    const { result, sleeps } = await gate(g);
    expect(result).toEqual({ outcome: "head_moved", staleHeadSha: HEAD, newHeadSha: MOVED });
    expect(sleeps).toEqual([]);
  });

  it("5. a mergeable that resolves within the bound is classified from the resolved answer", async () => {
    const g = await github({ conflict: true, mergeAnswer: 405, onMerge: (w) => void (w.computeReads = 2) });
    const { result, sleeps } = await gate(g);
    expect(result).toEqual({ outcome: "ready_human_merges", headSha: HEAD, reasons: ["merge_conflict"] });
    expect(sleeps).toHaveLength(2);
  });
});

describe("D#519 MQ1 port: mergeability", () => {
  it("polls the default bound and returns null (never true or false) when it is spent; the default bound is the exported constant", async () => {
    const g = await github({ neverComputes: true });
    const { port, sleeps } = portOver(g.http, { pollLimit: MERGEABLE_POLL_LIMIT });
    const m = await port.getMergeability(PR);
    expect(m).toEqual({ headSha: HEAD, state: "open", merged: false, mergeable: null, mergeableState: "unknown" });
    expect(sleeps).toHaveLength(MERGEABLE_POLL_LIMIT - 1);
  });

  it("returns the computed answer as soon as GitHub has one", async () => {
    const g = await github({ computeReads: 1, conflict: true });
    const { port } = portOver(g.http);
    expect(await port.getMergeability(PR)).toMatchObject({ mergeable: false, mergeableState: "dirty" });
  });

  it("reports behind only on a repo that requires up-to-date branches (the strict fake does the same)", async () => {
    const lax = await github({ behindBy: 4 });
    expect(await portOver(lax.http).port.getMergeability(PR)).toMatchObject({ mergeable: true, mergeableState: "clean" });
    const strict = await github({ behindBy: 4, classicStrict: true });
    expect(await portOver(strict.http).port.getMergeability(PR)).toMatchObject({ mergeable: true, mergeableState: "behind" });
  });

  it("reads a state GitHub adds later as unknown, and a response without mergeable fields as malformed", async () => {
    const http: GitHubHttp = {
      async request() {
        return { status: 200, body: { state: "open", merged: false, draft: false, mergeable: true, mergeable_state: "frobnicated", head: { sha: HEAD }, base: { ref: "main" } } };
      },
    };
    expect((await portOver(http).port.getMergeability(PR)).mergeableState).toBe("unknown");
    const bare: GitHubHttp = { async request() { return { status: 200, body: { state: "open", merged: false, draft: false, head: { sha: HEAD }, base: { ref: "main" } } }; } };
    await expect(portOver(bare).port.getMergeability(PR)).rejects.toThrow(/malformed/);
    const wrong: GitHubHttp = { async request() { return { status: 200, body: { state: "open", merged: false, draft: false, mergeable: "true", mergeable_state: "clean", head: { sha: HEAD }, base: { ref: "main" } } }; } };
    await expect(portOver(wrong).port.getMergeability(PR)).rejects.toThrow(/malformed/);
  });
});

describe("D#519 MQ1 port: update-branch", () => {
  it("6. sends expected_head_sha; 202 is accepted, not done: the head changes only on a later read", async () => {
    const g = await github({ behindBy: 2, refreshAfterReads: 1 });
    const { port } = portOver(g.http);
    expect(await port.updateBranch(PR, { expectedHeadSha: HEAD })).toEqual({ outcome: "accepted" });
    expect(g.world.updates).toEqual([{ expected: HEAD }]);
    const update = g.world.calls.find((c) => c.path.endsWith("/update-branch"))!;
    expect(update).toMatchObject({ method: "PUT", body: { expected_head_sha: HEAD } });
    // The 202 changed nothing yet.
    expect((await port.getMergeability(PR)).headSha).toBe(HEAD);
    expect((await port.getMergeability(PR)).headSha).toBe(g.world.refreshedHeadSha);
  });

  it("6. 422 plus an unmoved head plus mergeable:false is a conflict, whatever the message says", async () => {
    for (const messageOverride of [undefined, "Validation Failed"]) {
      const g = await github({ conflict: true, behindBy: 1, ...(messageOverride ? { messageOverride } : {}) });
      expect(await portOver(g.http).port.updateBranch(PR, { expectedHeadSha: HEAD })).toEqual({ outcome: "conflict" });
    }
  });

  it("6. 422 plus a moved head is head_moved (the expected sha was stale), with the head GitHub now has", async () => {
    const g = await github({ behindBy: 1 });
    expect(await portOver(g.http).port.updateBranch(PR, { expectedHeadSha: STALE })).toEqual({ outcome: "head_moved", newHeadSha: HEAD });
  });

  it("6. a 422 whose re-read shows neither a moved head nor a conflict throws (the step retries) and never reads as done", async () => {
    const g = await github({ behindBy: 0 });
    await expect(portOver(g.http).port.updateBranch(PR, { expectedHeadSha: HEAD })).rejects.toThrow(/unmoved head/);
    const computing = await github({ conflict: true, behindBy: 1, neverComputes: true });
    await expect(portOver(computing.http, { pollLimit: 2 }).port.updateBranch(PR, { expectedHeadSha: HEAD })).rejects.toThrow(/unmoved head/);
  });

  it("6. 403 and any other status throw", async () => {
    const forbidden = await github({ behindBy: 1, updateForbidden: true });
    await expect(portOver(forbidden.http).port.updateBranch(PR, { expectedHeadSha: HEAD })).rejects.toThrow(/unexpected status 403/);
    for (const updateAnswer of [404, 409, 500, 200]) {
      const g = await github({ behindBy: 1, updateAnswer });
      await expect(portOver(g.http).port.updateBranch(PR, { expectedHeadSha: HEAD }), `status ${updateAnswer}`).rejects.toThrow(new RegExp(`unexpected status ${updateAnswer}`));
    }
  });

  it("6. a malformed expected sha makes no request", async () => {
    const g = await github({ behindBy: 1 });
    await expect(portOver(g.http).port.updateBranch(PR, { expectedHeadSha: "HEAD" })).rejects.toThrow(/malformed/);
    expect(g.world.calls).toEqual([]);
  });
});

describe("D#519 MQ1 port: requires up-to-date branches", () => {
  it("7. true for classic protection strict:true", async () => {
    const g = await github({ classicStrict: true });
    expect(await portOver(g.http).port.requiresUpToDateBranch(PR)).toBe(true);
  });

  it("7. true for a ruleset with strict_required_status_checks_policy:true, and an inactive ruleset does not count", async () => {
    const on = await github({ rules: [{ type: "deletion" }, { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "build" }] } }] });
    expect(await portOver(on.http).port.requiresUpToDateBranch(PR)).toBe(true);
    const off = await github({ rules: [{ type: "required_status_checks", enforcement: "disabled", parameters: { strict_required_status_checks_policy: true, required_status_checks: [] } }] });
    expect(await portOver(off.http).port.requiresUpToDateBranch(PR)).toBe(false);
  });

  it("7. false when neither exists, for GitHub's two documented 404s and for non-strict rules", async () => {
    expect(await portOver((await github()).http).port.requiresUpToDateBranch(PR)).toBe(false);
    expect(await portOver((await github({ classicNotEnabled: true })).http).port.requiresUpToDateBranch(PR)).toBe(false);
    expect(await portOver((await github({ classicStrict: false, rules: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [] } }] })).http).port.requiresUpToDateBranch(PR)).toBe(false);
  });

  it("7. an unexpected status throws: a 403, a 404 with another message, a 500; never 'not required'", async () => {
    for (const protectionStatus of [403, 404, 500]) {
      const g = await github({ protectionStatus });
      await expect(portOver(g.http).port.requiresUpToDateBranch(PR), `status ${protectionStatus}`).rejects.toThrow(/unexpected status/);
    }
  });

  it("7. a rule without the boolean policy is malformed, not 'not strict'", async () => {
    const g = await github({ rules: [{ type: "required_status_checks", parameters: { required_status_checks: [] } }] });
    await expect(portOver(g.http).port.requiresUpToDateBranch(PR)).rejects.toThrow(/malformed/);
  });
});

describe("D#519 MQ1 port: compare", () => {
  it("reads status and behind_by without asking for files", async () => {
    const g = await github({ behindBy: 3, aheadBy: 2 });
    const cmp = await portOver(g.http).port.compareToBase(PR, HEAD);
    expect(cmp).toEqual({ status: "diverged", aheadBy: 2, behindBy: 3, files: null, filesTruncated: false });
    expect(g.server.seen.find((r) => r.path.includes("/compare/"))?.query).toBe("per_page=1");
  });

  it("maps every documented status", async () => {
    const cases: Array<[Partial<MergeWorld>, string]> = [
      [{ aheadBy: 0, behindBy: 0 }, "identical"],
      [{ aheadBy: 2, behindBy: 0 }, "ahead"],
      [{ aheadBy: 0, behindBy: 2 }, "behind"],
    ];
    for (const [over, status] of cases) {
      const g = await github(over);
      expect((await portOver(g.http).port.compareToBase(PR, HEAD)).status).toBe(status);
    }
  });

  it("reads the files from one response (250 files, no page-2 request) and lists both names of a rename", async () => {
    const files: Array<{ filename: string; previous_filename?: string }> = Array.from({ length: 249 }, (_, i) => ({ filename: `src/f${i}.ts` }));
    files.push({ filename: "src/new-name.ts", previous_filename: "src/old-name.ts" });
    const g = await github({ files, aheadBy: 1 });
    const cmp = await portOver(g.http).port.compareToBase(PR, HEAD, { files: true });
    expect(cmp.filesTruncated).toBe(false);
    expect(cmp.files).toHaveLength(251);
    expect(cmp.files).toContain("src/old-name.ts");
    expect(cmp.files).toContain("src/new-name.ts");
    const calls = g.world.calls.filter((c) => c.path.includes("/compare/"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query ?? "").not.toMatch(/page=/);
  });

  it("at GitHub's 300-file cap the list is withheld and flagged truncated, never returned as if complete", async () => {
    for (const n of [300, 450]) {
      const files = Array.from({ length: n }, (_, i) => ({ filename: `src/f${i}.ts` }));
      const g = await github({ files, aheadBy: 1 });
      const cmp = await portOver(g.http).port.compareToBase(PR, HEAD, { files: true });
      expect(cmp, `${n} files`).toEqual({ status: "ahead", aheadBy: 1, behindBy: 0, files: null, filesTruncated: true });
      expect(g.world.calls.filter((c) => c.path.includes("/compare/"))).toHaveLength(1);
    }
    // One file under the cap is a complete list.
    const g = await github({ files: Array.from({ length: 299 }, (_, i) => ({ filename: `src/f${i}.ts` })), aheadBy: 1 });
    expect((await portOver(g.http).port.compareToBase(PR, HEAD, { files: true })).filesTruncated).toBe(false);
  });

  it("a repeated file, an unknown status and a malformed count all throw", async () => {
    const http = (page: unknown): GitHubHttp => ({
      async request(req) {
        if (req.path.endsWith("/pulls/7")) return { status: 200, body: { state: "open", merged: false, draft: false, mergeable: true, mergeable_state: "clean", head: { sha: HEAD }, base: { ref: "main" } } };
        return { status: 200, body: typeof page === "function" ? (page as (r: typeof req) => unknown)(req) : page };
      },
    });
    const repeat = http(() => ({ status: "ahead", ahead_by: 1, behind_by: 0, files: Array.from({ length: 100 }, () => ({ filename: "a.ts" })) }));
    await expect(portOver(repeat).port.compareToBase(PR, HEAD, { files: true })).rejects.toThrow(/repeated|malformed/);
    await expect(portOver(http({ status: "sideways", ahead_by: 1, behind_by: 0 })).port.compareToBase(PR, HEAD)).rejects.toThrow(/malformed/);
    await expect(portOver(http({ status: "ahead", ahead_by: -1, behind_by: 0 })).port.compareToBase(PR, HEAD)).rejects.toThrow(/malformed/);
    await expect(portOver(http({ status: "ahead", ahead_by: 1, behind_by: "0" })).port.compareToBase(PR, HEAD)).rejects.toThrow(/malformed/);
  });

  it("a head GitHub does not know is an error, not an empty comparison", async () => {
    const g = await github();
    await expect(portOver(g.http).port.compareToBase(PR, STALE)).rejects.toThrow(/unexpected status 404/);
  });
});

describe("D#519 MQ1 port: a runner_local repository stays inside its allowlist", () => {
  function localPort() {
    const requests: string[] = [];
    const sleeps: number[] = [];
    const pull = { number: 7, state: "open", merged_at: null, draft: false, head: { sha: HEAD, ref: "fx/run-1", repo: { full_name: "acme/widgets" } }, base: { ref: "main", repo: { full_name: "acme/widgets" } } };
    const http = {
      async request(req: { method: string; path: string }) {
        requests.push(`${req.method} ${req.path}`);
        return { status: 200, body: [pull] };
      },
      async graphql() {
        throw new Error("not used");
      },
    };
    const port = createGitHubMergeGatePort({
      http,
      resolveRepo: async () => ({ owner: "acme", name: "widgets" }),
      markReadyForHumanMerge: async () => undefined,
      sleep: async (ms) => void sleeps.push(ms),
      local: { http, recordedBranch: async () => "fx/run-1" },
    });
    return { port, requests, sleeps };
  }

  it("the list read carries no mergeability, so nothing is classified from it and nothing is polled", async () => {
    const { port, requests, sleeps } = localPort();
    expect(await port.getMergeability(PR)).toEqual({ headSha: HEAD, state: "open", merged: false, mergeable: null, mergeableState: "unknown" });
    expect(sleeps).toEqual([]);
    expect(requests).toEqual(["GET /repos/acme/widgets/pulls"]);
  });

  it("update-branch, compare and the strictness read make no request there (they are not on the allowlist) and throw", async () => {
    const { port, requests } = localPort();
    await expect(port.updateBranch(PR, { expectedHeadSha: HEAD })).rejects.toThrow(/allowlist/);
    await expect(port.compareToBase(PR, HEAD)).rejects.toThrow(/allowlist/);
    await expect(port.requiresUpToDateBranch(PR)).rejects.toThrow(/allowlist/);
    expect(requests).toEqual([]);
  });
});

describe("D#519 MQ1 port: the real transport contract", () => {
  it("every request carries what the strict server demands (User-Agent, Accept, API version, bearer, JSON body) over verified TLS", async () => {
    const g = await github({ behindBy: 1 });
    const { port } = portOver(g.http);
    await port.getMergeability(PR);
    await port.updateBranch(PR, { expectedHeadSha: HEAD });
    for (const r of g.server.seen) {
      expect(r.servername).toBe("api.github.com");
      expect(r.headers["user-agent"]).toBeTruthy();
      expect(r.headers["x-github-api-version"]).toBe("2022-11-28");
    }
    expect(g.server.seen.find((r) => r.path.endsWith("/update-branch"))?.headers["content-type"]).toBe("application/json");
  });

  it("update-branch with no body at all is a 422 from the strict server (the port always sends one)", async () => {
    const g = await github({ behindBy: 1 });
    const res = await tlsGitHubHttp(g.server).request({ method: "PUT", path: "/repos/acme/widgets/pulls/7/update-branch", body: undefined });
    expect(res.status).toBe(422);
  });
});
