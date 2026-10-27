import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CHILD_BRANCH_JOB_MIN_PROTOCOL, CONTINUES_CROSS_SIDE_MIN_PROTOCOL, verifyJob } from "@fulcrumaxe/runner-protocol";
import { addSpec, plannedFixture, reapprove, row as tableRow, TABLE, type PlannedFixture } from "@fx/db/test/helpers/plannedChildren.js";
import type { ExecutionRun } from "../src/executionTarget.js";
import { JobIssueError, createJobIssuer, createJobSigner, createPgJobContext, type ContinuationBasePort } from "../src/targets/jobIssuer.js";
import { RUNNER_CONTINUES_BOUND_KIND, insertAgentRun, readBoundItemBranch } from "../src/runStatusWriter.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { createFakeVisibility } from "./helpers/runnerTargetFakes.js";
import { createFakeContinuationBinding, type FakeBindingState } from "./helpers/fakeContinuationBinding.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * [pg] D#483 S5-b2c-3, acceptance 10 and 12 (the issuer's half): a continuation of a planned PR child on its own pull request branch `fx/<parent#>-<key>`. The issuer binds the branch to the
 * child's open pull request, signs it, records one binding event, and gates the job at the child-branch protocol floor, so a runner built before it never claims it (the 0805 claim rule).
 * A branch that is the parent's `fx/issue-<n>`, a sibling's, or the child's key under another number is refused before GitHub is asked. Real Postgres and the real definers; the signature
 * is verified with the real key and the real protocol schema. GitHub is the fake of `helpers/fakeContinuationBinding.ts`.
 */
describe("a planned PR child's continuation on its own branch [pg] (D#483 S5-b2c-3)", () => {
  const db = pgHarness();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signer = createJobSigner({ keyId: "job-key-1", privateKey });
  const NOW = new Date("2026-10-15T12:00:00.000Z");
  const OWNER = "acme";
  const REPO_GH_ID = 7001;
  const PARENT_NUMBER = 41;
  const CHILD_BRANCH = "fx/41-api";
  const RUN_BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";
  const base: ContinuationBasePort = { headOid: async () => "a".repeat(40) };
  const NO_WINDOW_MODEL = "windowless-model";

  async function kid(): Promise<{ f: PlannedFixture; child: string }> {
    const f = await plannedFixture(db.admin, db.pureAppUserPool, { dial: null, weeklyUsd: null });
    await db.admin.query("UPDATE repos SET gh_owner = $2, gh_name = 'widgets', execution_mode = 'runner_local' WHERE id = $1", [f.t.repoId, OWNER]);
    await db.admin.query("UPDATE work_items SET gh_number = $2 WHERE id = $1", [f.parent, PARENT_NUMBER]);
    await db.admin.query("INSERT INTO discussions (account_id, number, repo_id, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, 6, $2, 'feature', 'Footer', $3, 'internal', 'system')", [f.t.accountId, f.t.repoId, f.parent]);
    return { f, child: f.kids.api! };
  }
  async function executor(k: { f: PlannedFixture; child: string }, parentRunId: string | null = null): Promise<ExecutionRun> {
    const id = randomUUID();
    await insertAgentRun(db.runWriterPool, { id, accountId: k.f.t.accountId, workItemId: k.child, parentRunId, specVersionId: k.f.specV1, role: "executor", runtime: "runner", executionMode: "runner_local", dispatchRepoId: k.f.t.repoId, initiatedBy: k.f.t.userId });
    return { id, accountId: k.f.t.accountId, workItemId: k.child, parentRunId, role: "executor", product: "team", repoId: k.f.t.repoId, headSha: null, roleCard: "You are the executor.\n", prompt: "Fix the review findings.\n", model: NO_WINDOW_MODEL, capUsd: 0, spend: { plan: "starter", estimateComputeUsd: 0 } as never } as unknown as ExecutionRun;
  }
  const openPull = (branch: string, over: Partial<FakeBindingState["pulls"][number]> = {}): FakeBindingState["pulls"][number] => ({ number: 52, state: "open", headRepoId: REPO_GH_ID, baseRepoId: REPO_GH_ID, headRef: branch, headOwner: OWNER, ...over });
  const issuerWith = (binding: ReturnType<typeof createFakeContinuationBinding>) =>
    createJobIssuer({ pool: db.runWriterPool, signer, visibility: createFakeVisibility("private"), context: createPgJobContext(db.runWriterPool), continuationBase: base, continuationBinding: binding, now: () => NOW, newId: () => "7b9d1c6e-4f0a-4c53-9a58-2f0d5b6c3a11" });
  const stored = async (id: string) => (await db.admin.query<{ job_signed: unknown; min_protocol_version: number | null }>("SELECT job_signed, min_protocol_version FROM agent_runs WHERE id = $1", [id])).rows[0]!;
  const eventsOf = async (id: string, kind: string) => (await db.admin.query<{ payload: Record<string, unknown> }>("SELECT payload FROM run_events WHERE run_id = $1 AND kind = $2 ORDER BY seq", [id, kind])).rows.map((r) => r.payload);
  const codeOf = async (p: Promise<unknown>) => p.then(() => "returned", (e) => (e instanceof JobIssueError ? e.code : `other:${String(e)}`));
  async function pair(k: { f: PlannedFixture; child: string }) {
    const parent = await executor(k);
    return { parent, run: await executor(k, parent.id) };
  }
  const issue = (k: { f: PlannedFixture; child: string }, over: { branch?: string; prNumber?: number; pulls?: FakeBindingState["pulls"]; arrange?: () => Promise<void> } = {}) => {
    return (async () => {
      const { parent, run } = await pair(k);
      await over.arrange?.();
      const binding = createFakeContinuationBinding({ pulls: over.pulls ?? [openPull(over.branch ?? CHILD_BRANCH)] });
      const result = await codeOf(issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: over.branch ?? CHILD_BRANCH, prNumber: over.prNumber ?? 52 } }));
      return { result, run, parent, binding };
    })();
  };

  it("signs continues = { parent, session_id: null, fx/<parent#>-<key>, pr_number }, records exactly one binding event, and gates the job at the child-branch protocol", async () => {
    const k = await kid();
    const { result, run, parent, binding } = await issue(k);
    expect(result).toBe("returned");
    const s = await stored(run.id);
    const job = verifyJob(s.job_signed, { "job-key-1": publicKey }, { now: NOW });
    expect(job.continues).toEqual({ parent_run_id: parent.id, session_id: null, branch: CHILD_BRANCH, pr_number: 52 });
    expect(await eventsOf(run.id, RUNNER_CONTINUES_BOUND_KIND)).toEqual([{ pr_number: 52, branch: CHILD_BRANCH }]);
    expect(s.min_protocol_version).toBe(CHILD_BRANCH_JOB_MIN_PROTOCOL);
    expect(CHILD_BRANCH_JOB_MIN_PROTOCOL).toBeGreaterThan(CONTINUES_CROSS_SIDE_MIN_PROTOCOL);
    expect(binding.calls).toEqual([`list ${OWNER}:${CHILD_BRANCH}`, "default_branch", `protection ${CHILD_BRANCH}`]);
    // the bound-branch read agrees: the event, the signed job and the child's identity name one branch
    const bound = await withTenant(db.runWriterPool, k.f.t.accountId, (c) => readBoundItemBranch(c, { accountId: k.f.t.accountId, runId: run.id }));
    expect(bound).toEqual({ branch: CHILD_BRANCH, prNumber: 52 });
  });

  it("S5b2c3-12: a job naming the parent's fx/issue-<n>, a sibling's branch, or the child's key under another number is refused, with no job, no binding event and no GitHub read", async () => {
    for (const branch of ["fx/issue-41", "fx/41-ui", "fx/42-api", "fx/4-api", "fx/41-api-extra", "fx/041-api"]) {
      const k = await kid();
      const { result, run, binding } = await issue(k, { branch, pulls: [openPull(branch)] });
      expect(result, branch).toMatch(/^continues_(pr_mismatch|branch_mismatch)$/);
      expect((await stored(run.id)).job_signed).toBeNull();
      expect(await eventsOf(run.id, RUNNER_CONTINUES_BOUND_KIND)).toEqual([]);
      expect(binding.calls, branch).toEqual([]);
    }
  });

  it("the child's pull request number is the one GitHub says: another number is refused", async () => {
    const k = await kid();
    const { result } = await issue(k, { prNumber: 99, pulls: [openPull(CHILD_BRANCH)] });
    expect(result).toBe("continues_pr_mismatch");
  });

  it("S5b2c3-16: a deleted parent, a parent closed, a Spec not approved again or a key that left the approved Spec refuses the continuation (the identity), before GitHub is asked", async () => {
    const cases: Array<(k: { f: PlannedFixture; child: string }) => Promise<void>> = [
      async (k) => void (await db.admin.query("DELETE FROM work_items WHERE id = $1", [k.f.parent])),
      async (k) => void (await db.admin.query("UPDATE work_items SET stage = 'closed' WHERE id = $1", [k.f.parent])),
      async (k) => void (await addSpec(db.admin, k.f.t, k.f.parent, 2, TABLE)),
      async (k) => { await addSpec(db.admin, k.f.t, k.f.parent, 2, [tableRow("docs"), tableRow("other")]); await reapprove(db.pureAppUserPool, k.f); },
    ];
    for (const arrange of cases) {
      const k = await kid();
      const { result, run, binding } = await issue(k, { arrange: () => arrange(k) });
      expect(result).toBe("continues_identity_refused");
      expect((await stored(run.id)).job_signed).toBeNull();
      expect(binding.calls).toEqual([]);
    }
  });

  it("a started child whose key is still in a newer approved version is bound on its branch (R11)", async () => {
    const k = await kid();
    await addSpec(db.admin, k.f.t, k.f.parent, 2, [tableRow("api", "The API"), tableRow("other", "Other")]);
    await reapprove(db.pureAppUserPool, k.f);
    const first = await executor(k);
    await db.admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [first.id]);
    const run = await executor(k, first.id);
    const out = await codeOf(issuerWith(createFakeContinuationBinding({ pulls: [openPull(CHILD_BRANCH)] })).issue({ run, continues: { parentRunId: first.id, sessionId: null, branch: CHILD_BRANCH, prNumber: 52 } }));
    expect(out).toBe("returned");
  });

  it("a runner child whose pull request is on its own run branch needs none of this: no identity check, and the floor of a run-branch continuation (none)", async () => {
    const k = await kid();
    await db.admin.query("UPDATE work_items SET stage = 'closed' WHERE id = $1", [k.f.parent]);
    const { parent, run } = await pair(k);
    const out = await codeOf(issuerWith(createFakeContinuationBinding({ pulls: [] })).issue({ run, continues: { parentRunId: parent.id, sessionId: "s-1", branch: RUN_BRANCH } }));
    expect(out).toBe("returned");
    expect((await stored(run.id)).min_protocol_version).toBeNull();
  });

  it("a top-level item's fx/issue-<n> continuation is unchanged: it keeps the cross-side floor, not the child floor", async () => {
    const f = await plannedFixture(db.admin, db.pureAppUserPool, { dial: null, weeklyUsd: null });
    await db.admin.query("UPDATE repos SET gh_owner = $2, gh_name = 'widgets', execution_mode = 'runner_local' WHERE id = $1", [f.t.repoId, OWNER]);
    await db.admin.query("UPDATE work_items SET gh_number = 12 WHERE id = $1", [f.parent]);
    await db.admin.query("INSERT INTO discussions (account_id, number, repo_id, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, 6, $2, 'feature', 'Footer', $3, 'internal', 'system')", [f.t.accountId, f.t.repoId, f.parent]);
    await db.admin.query("UPDATE work_items SET discussion_id = (SELECT id FROM discussions WHERE account_id = $1 AND root_work_item_id = $2) WHERE id = $2", [f.t.accountId, f.parent]);
    const top = { f, child: f.parent };
    const { parent, run } = await pair(top);
    const out = await codeOf(issuerWith(createFakeContinuationBinding({ pulls: [openPull("fx/issue-12", { number: 41 })] })).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: "fx/issue-12", prNumber: 41 } }));
    expect(out).toBe("returned");
    expect((await stored(run.id)).min_protocol_version).toBe(CONTINUES_CROSS_SIDE_MIN_PROTOCOL);
  });
});
