import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BASE_SHA_JOB_MIN_PROTOCOL, BASE_SHA_RUN_BRANCH_JOB_MIN_PROTOCOL, CONTINUES_CROSS_SIDE_MIN_PROTOCOL, verifyJob } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import type { ExecutionRun } from "../src/executionTarget.js";
import { JobIssueError, createJobIssuer, createJobSigner, createPgJobContext, type ContinuationBasePort } from "../src/targets/jobIssuer.js";
import { RUNNER_CONTINUES_BOUND_KIND, RUNNER_DISPATCH_BASE_KIND, insertAgentRun, readBoundItemBranch, readRecordedRunnerBranch, readRecordedRunnerPullRequest } from "../src/runStatusWriter.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createFakeVisibility } from "./helpers/runnerTargetFakes.js";
import { createFakeContinuationBinding, type FakeBindingState } from "./helpers/fakeContinuationBinding.js";
import { pgHarness } from "./helpers/pgHarness.js";

/** A model with no price-table entry, so no window figure: these jobs carry no `context_window` and keep only the floors this file is about (D#600 CX-6b). */
const NO_WINDOW_MODEL = "windowless-model";

/**
 * D#599 PL-2b-1: a continuation on the item's own pull request branch. The issuer binds `fx/issue-<n>` to the item's open pull request in this
 * repository on GitHub, refuses a default or protected branch, records the binding with the job, and gates the job to runners new enough to read it.
 * Real Postgres and the real definers throughout; GitHub is the fake in `helpers/fakeContinuationBinding.ts`.
 */
describe("cross-side continuation: the issuer's binding [pg] (D#599 PL-2b-1)", () => {
  const db = pgHarness();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signer = createJobSigner({ keyId: "job-key-1", privateKey });
  const NOW = new Date("2026-10-15T12:00:00.000Z");
  const ISSUE = 12;
  const OWNER = "acme";
  const REPO_GH_ID = 7001;
  const RUN_BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";
  const ITEM_BRANCH = `fx/issue-${ISSUE}`;
  const base: ContinuationBasePort = { headOid: async () => "a".repeat(40) };

  async function world(issue: number | null = ISSUE) {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId, { executionMode: "runner_local" });
    await db.admin.query("UPDATE repos SET gh_owner = $2, gh_name = 'widgets' WHERE id = $1", [repoId, OWNER]);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: issue as number });
    const body = "1. The footer shows the year.";
    await db.admin.query("INSERT INTO discussions (account_id, number, repo_id, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, 6, $2, 'feature', 'Footer', $3, 'internal', 'system')", [accountId, repoId, workItemId]);
    await db.admin.query("UPDATE work_items SET discussion_id = (SELECT id FROM discussions WHERE account_id = $1 AND root_work_item_id = $2) WHERE id = $2", [accountId, workItemId]);
    await db.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [accountId, workItemId, body, createHash("sha256").update(body).digest("hex")]);
    return { accountId, userId, repoId, workItemId };
  }
  type World = Awaited<ReturnType<typeof world>>;

  async function executor(w: World, parentRunId: string | null = null): Promise<ExecutionRun> {
    const id = randomUUID();
    const pin = parentRunId ? undefined : (await db.admin.query<{ id: string }>("SELECT id FROM spec_versions WHERE work_item_id = $1 ORDER BY version DESC LIMIT 1", [w.workItemId])).rows[0]?.id;
    await insertAgentRun(db.runWriterPool, { id, accountId: w.accountId, workItemId: w.workItemId, parentRunId, ...(pin ? { specVersionId: pin } : {}), role: "executor", runtime: "runner", executionMode: "runner_local", dispatchRepoId: w.repoId, initiatedBy: w.userId });
    return { id, accountId: w.accountId, workItemId: w.workItemId, parentRunId, role: "executor", product: "team", repoId: w.repoId, headSha: null, roleCard: "You are the executor.\n", prompt: "Fix the review findings.\n", model: NO_WINDOW_MODEL, capUsd: 0, spend: { plan: "starter", estimateComputeUsd: 0, trigger: "foreground" } };
  }

  const openPull = (over: Partial<FakeBindingState["pulls"][number]> = {}): FakeBindingState["pulls"][number] => ({ number: 41, state: "open", headRepoId: REPO_GH_ID, baseRepoId: REPO_GH_ID, headRef: ITEM_BRANCH, headOwner: OWNER, ...over });

  function issuerWith(binding: ReturnType<typeof createFakeContinuationBinding> | null) {
    return createJobIssuer({
      pool: db.runWriterPool,
      signer,
      visibility: createFakeVisibility("private"),
      context: createPgJobContext(db.runWriterPool),
      continuationBase: base,
      ...(binding ? { continuationBinding: binding } : {}),
      now: () => NOW,
      newId: () => "7b9d1c6e-4f0a-4c53-9a58-2f0d5b6c3a11",
    });
  }

  const row = async (id: string) => (await db.admin.query<{ job_signed: unknown; min_protocol_version: number | null }>("SELECT job_signed, min_protocol_version FROM agent_runs WHERE id = $1", [id])).rows[0]!;
  const eventsOf = async (id: string, kind: string) => (await db.admin.query<{ payload: Record<string, unknown> }>("SELECT payload FROM run_events WHERE run_id = $1 AND kind = $2 ORDER BY seq", [id, kind])).rows.map((r) => r.payload);
  const codeOf = async (p: Promise<unknown>) => p.then(() => "returned", (e) => (e instanceof JobIssueError ? `${e.code}${e.retryable ? "+retryable" : ""}` : `other:${String(e)}`));

  /** A finished parent executor run and a fix round on the item's pull request branch. */
  async function pair(w: World) {
    const parent = await executor(w);
    const run = await executor(w, parent.id);
    return { parent, run };
  }

  describe("a cloud build, then a runner fix round on the item's own pull request", () => {
    it("signs continues = { parent, session_id: null, branch: fx/issue-<n>, pr_number } and records exactly one runner.continues_bound event with the job", async () => {
      const w = await world();
      const { parent, run } = await pair(w);
      const binding = createFakeContinuationBinding({ pulls: [openPull()] });
      await issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH, prNumber: 41 } });

      const stored = await row(run.id);
      const job = verifyJob(stored.job_signed, { "job-key-1": publicKey }, { now: NOW });
      expect(job.continues).toEqual({ parent_run_id: parent.id, session_id: null, branch: ITEM_BRANCH, pr_number: 41 });
      expect(job.task.kind).toBe("fix");
      expect(await eventsOf(run.id, RUNNER_CONTINUES_BOUND_KIND)).toEqual([{ pr_number: 41, branch: ITEM_BRANCH }]);
      expect(stored.min_protocol_version).toBe(CONTINUES_CROSS_SIDE_MIN_PROTOCOL);
      // The reads happened, in the order the model gives: the pull request, then the default branch, then the protection read of this branch.
      expect(binding.calls).toEqual([`list ${OWNER}:${ITEM_BRANCH}`, "default_branch", `protection ${ITEM_BRANCH}`]);
      // The branch head is read at this run's own dispatch, as for every continuation.
      expect(await eventsOf(run.id, RUNNER_DISPATCH_BASE_KIND)).toEqual([{ head_oid: "a".repeat(40) }]);
    });

    it("signs the diff base the caller chose as continues.base_sha, and gates the job at the base-sha floor (FIXROUND-BASE-SYNC R2-b)", async () => {
      const w = await world();
      const { parent, run } = await pair(w);
      const binding = createFakeContinuationBinding({ pulls: [openPull()] });
      const baseSha = "b".repeat(40);
      await issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH, prNumber: 41, baseSha, baseBranch: ITEM_BRANCH } });
      const stored = await row(run.id);
      const job = verifyJob(stored.job_signed, { "job-key-1": publicKey }, { now: NOW });
      expect(job.continues).toEqual({ parent_run_id: parent.id, session_id: null, branch: ITEM_BRANCH, pr_number: 41, base_sha: baseSha });
      expect(stored.min_protocol_version).toBe(BASE_SHA_JOB_MIN_PROTOCOL);
    });

    it("signs the base on a run-branch continuation too, same-side with a session and cross-side without, and gates the job at the run-branch floor (R2-c0)", async () => {
      const w = await world();
      const baseSha = "b".repeat(40);
      for (const sessionId of ["s-1", null]) {
        const { parent, run } = await pair(w);
        await issuerWith(createFakeContinuationBinding({ pulls: [openPull()] })).issue({ run, continues: { parentRunId: parent.id, sessionId, branch: RUN_BRANCH, baseSha, baseBranch: RUN_BRANCH } });
        const stored = await row(run.id);
        const job = verifyJob(stored.job_signed, { "job-key-1": publicKey }, { now: NOW });
        expect(job.continues).toEqual({ parent_run_id: parent.id, session_id: sessionId, branch: RUN_BRANCH, base_sha: baseSha });
        expect(stored.min_protocol_version).toBe(BASE_SHA_RUN_BRANCH_JOB_MIN_PROTOCOL);
      }
    });

    it("a continuation the caller gave no base for keeps its floor and its bytes: no base_sha key", async () => {
      const w = await world();
      const { parent, run } = await pair(w);
      await issuerWith(createFakeContinuationBinding({ pulls: [openPull()] })).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH, prNumber: 41 } });
      const stored = await row(run.id);
      expect(JSON.stringify(stored.job_signed)).not.toContain("base_sha");
      expect(stored.min_protocol_version).toBe(CONTINUES_CROSS_SIDE_MIN_PROTOCOL);
    });

    it("sets no base_sha on a job that continues nothing: a fresh run never carries one", async () => {
      const w = await world();
      const run = await executor(w);
      await issuerWith(createFakeContinuationBinding({ pulls: [openPull()] })).issue({ run });
      const stored = await row(run.id);
      expect(JSON.stringify(stored.job_signed)).not.toContain("base_sha");
      expect(stored.min_protocol_version).toBeNull();
    });

    it("refuses a base that is not a full lower-case commit id, or that was synced on another branch than the one continued, and records nothing", async () => {
      const w = await world();
      const { parent, run } = await pair(w);
      const binding = createFakeContinuationBinding({ pulls: [openPull()] });
      for (const baseSha of ["main", "b".repeat(39), "B".repeat(40), `${"b".repeat(40)}\n`]) {
        expect(await codeOf(issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH, prNumber: 41, baseSha, baseBranch: ITEM_BRANCH } })), baseSha).toBe("continues_base_invalid");
      }
      // A base with no branch named, or synced on another branch, is refused for either kind of continuation.
      for (const other of [undefined, RUN_BRANCH, "fx/issue-99"]) {
        expect(await codeOf(issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH, prNumber: 41, baseSha: "b".repeat(40), ...(other === undefined ? {} : { baseBranch: other }) } })), String(other)).toBe("continues_base_invalid");
      }
      expect(await codeOf(issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: "s-1", branch: RUN_BRANCH, baseSha: "b".repeat(40), baseBranch: ITEM_BRANCH } }))).toBe("continues_base_invalid");
      expect(await codeOf(issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: "s-1", branch: RUN_BRANCH, baseSha: "b".repeat(40) } }))).toBe("continues_base_invalid");
      expect((await row(run.id)).job_signed).toBeNull();
      expect(await eventsOf(run.id, RUNNER_CONTINUES_BOUND_KIND)).toEqual([]);
    });

    it("refuses a continuation that names no pull request number, before GitHub is asked and with nothing recorded (R-599-PL2b-1-c)", async () => {
      const w = await world();
      const { parent, run } = await pair(w);
      const binding = createFakeContinuationBinding({ pulls: [openPull()] });
      expect(await codeOf(issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH } }))).toBe("continues_pr_mismatch");
      expect(binding.calls).toEqual([]);
      expect((await row(run.id)).job_signed).toBeNull();
      expect(await eventsOf(run.id, RUNNER_CONTINUES_BOUND_KIND)).toEqual([]);
    });

    it("signs the number only when it is the one the caller recorded for the item", async () => {
      const w = await world();
      const { parent, run } = await pair(w);
      const binding = createFakeContinuationBinding({ pulls: [openPull()] });
      expect(await codeOf(issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH, prNumber: 99 } }))).toBe("continues_pr_mismatch");
      expect((await row(run.id)).job_signed).toBeNull();
      expect(await eventsOf(run.id, RUNNER_CONTINUES_BOUND_KIND)).toEqual([]);
      expect(await eventsOf(run.id, RUNNER_DISPATCH_BASE_KIND)).toEqual([]);
      await issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH, prNumber: 41 } });
      expect((await row(run.id)).job_signed).not.toBeNull();
    });

    it("picks the open pull request of this repository when the same head also has a closed one and a fork's", async () => {
      const w = await world();
      const { parent, run } = await pair(w);
      const binding = createFakeContinuationBinding({
        pulls: [openPull({ number: 30, state: "closed" }), openPull({ number: 35, headRepoId: 9999 }), openPull({ number: 41 })],
      });
      await issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH, prNumber: 41 } });
      expect((await eventsOf(run.id, RUNNER_CONTINUES_BOUND_KIND))[0]).toEqual({ pr_number: 41, branch: ITEM_BRANCH });
    });
  });

  describe("refusals record nothing: no job, no bound event, no dispatch base", () => {
    const REFUSALS: Array<[string, Partial<FakeBindingState>, string, string?]> = [
      ["a pull request from a fork", { pulls: [openPull({ headRepoId: 9999 })] }, "continues_pr_mismatch"],
      ["a pull request whose head repository is gone", { pulls: [openPull({ headRepoId: null })] }, "continues_pr_mismatch"],
      ["a closed pull request", { pulls: [openPull({ state: "closed" })] }, "continues_pr_not_open"],
      ["no pull request at all", { pulls: [] }, "continues_pr_not_open"],
      ["two open pull requests on the head", { pulls: [openPull({ number: 41 }), openPull({ number: 42 })] }, "continues_pr_mismatch"],
      ["a pull request whose head ref is not the branch (a list that ignores the head filter)", { pulls: [openPull({ headRef: "fx/issue-99" })], ignoreHeadFilter: true }, "continues_pr_mismatch"],
      ["a head ref other than the branch, as GitHub's own filter leaves it: nothing listed", { pulls: [openPull({ headRef: "fx/issue-99" })] }, "continues_pr_not_open"],
      ["the repository's default branch", { pulls: [openPull()], defaultBranch: ITEM_BRANCH }, "continues_branch_protected"],
      ["a protected branch (the protection read answers 200)", { pulls: [openPull()], protection: { [ITEM_BRANCH]: 200 } }, "continues_branch_protected"],
      ["a protection read that answers 500", { pulls: [openPull()], protection: { [ITEM_BRANCH]: 500 } }, "continues_base_unavailable+retryable"],
      ["a protection read that answers 403", { pulls: [openPull()], protection: { [ITEM_BRANCH]: 403 } }, "continues_base_unavailable+retryable"],
      ["a default branch that cannot be read", { pulls: [openPull()], defaultBranch: null }, "continues_base_unavailable+retryable"],
      ["a pull request list that answers 502", { pulls: [openPull()], listStatus: 502 }, "continues_base_unavailable+retryable"],
      ["a list that drops the connection", { pulls: [openPull()], throwOn: "list" }, "continues_base_unavailable+retryable"],
      ["a protection read that drops the connection", { pulls: [openPull()], throwOn: "protection" }, "continues_base_unavailable+retryable"],
    ];

    it.each(REFUSALS)("%s", async (_name, state, code) => {
      const w = await world();
      const { parent, run } = await pair(w);
      const binding = createFakeContinuationBinding(state);
      expect(await codeOf(issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH, prNumber: 41 } }))).toBe(code);
      expect((await row(run.id)).job_signed).toBeNull();
      expect((await row(run.id)).min_protocol_version).toBeNull();
      expect(await eventsOf(run.id, RUNNER_CONTINUES_BOUND_KIND)).toEqual([]);
      expect(await eventsOf(run.id, RUNNER_DISPATCH_BASE_KIND)).toEqual([]);
    });

    it("fx/issue-<another item's issue>, even when that pull request is open: refused before GitHub is asked", async () => {
      const w = await world();
      const { parent, run } = await pair(w);
      const binding = createFakeContinuationBinding({ pulls: [openPull({ headRef: "fx/issue-13", number: 50 })] });
      expect(await codeOf(issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: "fx/issue-13", prNumber: 41 } }))).toBe("continues_pr_mismatch");
      expect(binding.calls).toEqual([]);
      expect((await row(run.id)).job_signed).toBeNull();
      expect(await eventsOf(run.id, RUNNER_CONTINUES_BOUND_KIND)).toEqual([]);
    });

    it("SANDBOX-RERUN-BRANCH-a criterion 11: once the item's newest sandbox run is on its own run branch, a runner continuation onto fx/issue-<n>, or onto that run branch with a pull request number, is refused with its existing code, before GitHub is asked", async () => {
      const w = await world();
      const { parent, run } = await pair(w);
      const sandbox = randomUUID();
      await db.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', 'sandbox', $4)`, [sandbox, w.accountId, w.workItemId, w.repoId]);
      await db.admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'build.branch', $3::jsonb)`, [w.accountId, sandbox, JSON.stringify({ branch: `fx/${sandbox}-g1` })]);
      const binding = createFakeContinuationBinding({ pulls: [openPull(), openPull({ headRef: `fx/${sandbox}-g1`, number: 42 })] });
      expect(await codeOf(issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH, prNumber: 41 } }))).toBe("continues_pr_mismatch");
      expect(await codeOf(issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: `fx/${sandbox}-g1`, prNumber: 42 } }))).toBe("continues_pr_mismatch");
      expect(binding.calls).toEqual([]);
      expect((await row(run.id)).job_signed).toBeNull();
      expect(await eventsOf(run.id, RUNNER_CONTINUES_BOUND_KIND)).toEqual([]);
    });

    it("an item with no issue number has no pull request branch", async () => {
      const w = await world(null);
      const { parent, run } = await pair(w);
      const binding = createFakeContinuationBinding({ pulls: [openPull()] });
      expect(await codeOf(issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH, prNumber: 41 } }))).toBe("continues_pr_mismatch");
      expect(binding.calls).toEqual([]);
    });

    it("a session id is never claimed on the item's branch (with one, that name is not a continuation branch), and without the binding port the branch is refused", async () => {
      const w = await world();
      const { parent, run } = await pair(w);
      const binding = createFakeContinuationBinding({ pulls: [openPull()] });
      expect(await codeOf(issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: "sess_01", branch: ITEM_BRANCH } }))).toBe("continues_branch_mismatch");
      expect(await codeOf(issuerWith(null).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH, prNumber: 41 } }))).toBe("continues_base_unavailable");
      expect(binding.calls).toEqual([]);
      expect((await row(run.id)).job_signed).toBeNull();
    });

    it.each(["main", "fx/issue-0", "fx/issue-12/x", "fx/issues-12", "refs/heads/fx/issue-12", "fx/docs/x", "fx/issue-012"])("the branch %s is neither a run branch nor the item's: continues_branch_mismatch", async (branch) => {
      const w = await world();
      const { parent, run } = await pair(w);
      const binding = createFakeContinuationBinding({ pulls: [openPull()] });
      expect(await codeOf(issuerWith(binding).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch } }))).toBe("continues_branch_mismatch");
      expect(binding.calls).toEqual([]);
    });

    it("a pull request number is refused on a run branch", async () => {
      const w = await world();
      const { parent, run } = await pair(w);
      expect(await codeOf(issuerWith(createFakeContinuationBinding()).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: RUN_BRANCH, prNumber: 41 } }))).toBe("continues_pr_mismatch");
    });
  });

  describe("which jobs are gated to a newer runner", () => {
    it("a run branch with a null session is gated; a run branch with a session, and a job that continues nothing, are open to any runner", async () => {
      const w = await world();
      // One live continuation per parent is a database rule, so each round has a parent of its own.
      const parent = await executor(w);
      const otherParent = await executor(w);
      const nullSession = await executor(w, parent.id);
      const withSession = await executor(w, otherParent.id);
      const fresh = await executor(w);
      const issuer = issuerWith(createFakeContinuationBinding());
      await issuer.issue({ run: nullSession, continues: { parentRunId: parent.id, sessionId: null, branch: RUN_BRANCH } });
      await issuer.issue({ run: withSession, continues: { parentRunId: otherParent.id, sessionId: "sess_01", branch: RUN_BRANCH } });
      await issuer.issue({ run: fresh });
      expect((await row(nullSession.id)).min_protocol_version).toBe(CONTINUES_CROSS_SIDE_MIN_PROTOCOL);
      expect((await row(withSession.id)).min_protocol_version).toBeNull();
      expect((await row(fresh.id)).min_protocol_version).toBeNull();
      // A run branch needs no pull request binding: no event, and the job carries no number.
      expect(await eventsOf(nullSession.id, RUNNER_CONTINUES_BOUND_KIND)).toEqual([]);
      expect(verifyJob((await row(nullSession.id)).job_signed, { "job-key-1": publicKey }, { now: NOW }).continues).toEqual({ parent_run_id: parent.id, session_id: null, branch: RUN_BRANCH });
    });
  });

  describe("min_protocol_version is written with the job and never again", () => {
    it("refuses any later change of it, by any role, and leaves no value behind in the session", async () => {
      const w = await world();
      const { parent, run } = await pair(w);
      await issuerWith(createFakeContinuationBinding({ pulls: [openPull()] })).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH, prNumber: 41 } });
      await expect(db.admin.query("UPDATE agent_runs SET min_protocol_version = 1 WHERE id = $1", [run.id])).rejects.toMatchObject({ code: "23514" });
      await expect(db.admin.query("UPDATE agent_runs SET min_protocol_version = NULL WHERE id = $1", [run.id])).rejects.toMatchObject({ code: "23514" });
      await expect(db.admin.query("UPDATE agent_runs SET min_protocol_version = 0 WHERE id = $1", [parent.id])).rejects.toThrow();
      expect((await row(run.id)).min_protocol_version).toBe(CONTINUES_CROSS_SIDE_MIN_PROTOCOL);
      // The transaction-local value is cleared: nothing leaks to the next statement on the pooled connection.
      const left = await withTenant(db.runWriterPool, w.accountId, async (client) => (await client.query<{ v: string | null }>("SELECT current_setting('fx.job_min_protocol', true) AS v")).rows[0]!.v);
      expect(left === null || left === "").toBe(true);
    });

    it("a job written without a value stays open to every runner, and the definer's refusal of a second job leaves the first value alone", async () => {
      const w = await world();
      const { parent, run } = await pair(w);
      const issuer = issuerWith(createFakeContinuationBinding({ pulls: [openPull()] }));
      await issuer.issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH, prNumber: 41 } });
      expect(await codeOf(issuer.issue({ run }))).toBe("job_not_recorded");
      expect((await row(run.id)).min_protocol_version).toBe(CONTINUES_CROSS_SIDE_MIN_PROTOCOL);
    });
  });

  describe("the recorded-branch and recorded-pull-request reads accept the item's branch only when the run is bound to it", () => {
    /** The verdict `done` writes: a succeeded move that names the pull request and branch. */
    async function recordDone(w: World, runId: string, payload: Record<string, unknown>) {
      await db.admin.query(
        "INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, (SELECT COALESCE(max(seq), 0) + 1 FROM run_events WHERE run_id = $2), 'run.status_changed', $3::jsonb)",
        [w.accountId, runId, JSON.stringify({ from: "running", to: "succeeded", viaRunnerDone: true, ...payload })],
      );
    }
    const readPr = (w: World) => withTenant(db.runWriterPool, w.accountId, (client) => readRecordedRunnerPullRequest(client, { accountId: w.accountId, workItemId: w.workItemId }));
    const readBranch = (w: World, runId: string) => withTenant(db.runWriterPool, w.accountId, (client) => readRecordedRunnerBranch(client, { accountId: w.accountId, runId }));
    const readBound = (w: World, runId: string) => withTenant(db.runWriterPool, w.accountId, (client) => readBoundItemBranch(client, { accountId: w.accountId, runId }));

    async function boundRun(w: World) {
      const { parent, run } = await pair(w);
      await issuerWith(createFakeContinuationBinding({ pulls: [openPull()] })).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH, prNumber: 41 } });
      return run;
    }

    it("a done row naming fx/issue-<n> reads as the item's pull request only with a matching bound event", async () => {
      const w = await world();
      const run = await boundRun(w);
      await recordDone(w, run.id, { prNumber: 41, branch: ITEM_BRANCH });
      expect(await readBound(w, run.id)).toEqual({ branch: ITEM_BRANCH, prNumber: 41 });
      expect(await readPr(w)).toEqual({ number: 41, branch: ITEM_BRANCH });
      expect(await readBranch(w, run.id)).toBe(ITEM_BRANCH);
    });

    it("the same done row with no bound event reads as null (and so does a run branch's old behaviour stay)", async () => {
      const w = await world();
      const { run } = await pair(w);
      await recordDone(w, run.id, { prNumber: 41, branch: ITEM_BRANCH });
      expect(await readPr(w)).toBeNull();
      expect(await readBranch(w, run.id)).toBeNull();
      const other = await world();
      const { run: runBranchRun } = await pair(other);
      await recordDone(other, runBranchRun.id, { prNumber: 7, branch: RUN_BRANCH });
      expect(await readPr(other)).toEqual({ number: 7, branch: RUN_BRANCH });
      expect(await readBranch(other, runBranchRun.id)).toBe(RUN_BRANCH);
    });

    it.each([
      ["a bound event naming another branch", { pr_number: 41, branch: "fx/issue-8" }],
      ["a bound event naming another pull request number", { pr_number: 42, branch: ITEM_BRANCH }],
    ])("%s reads as null", async (_name, payload) => {
      const w = await world();
      const { run } = await pair(w);
      await db.admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, (SELECT COALESCE(max(seq), 0) + 1 FROM run_events WHERE run_id = $2), $3, $4::jsonb)", [w.accountId, run.id, RUNNER_CONTINUES_BOUND_KIND, JSON.stringify(payload)]);
      await recordDone(w, run.id, { prNumber: 41, branch: ITEM_BRANCH });
      expect(await readBound(w, run.id)).toBeNull();
      expect(await readPr(w)).toBeNull();
      expect(await readBranch(w, run.id)).toBeNull();
    });

    it("all three must agree: a bound event and a job that name the branch are not enough once the item's issue number differs", async () => {
      const w = await world();
      const run = await boundRun(w);
      await recordDone(w, run.id, { prNumber: 41, branch: ITEM_BRANCH });
      await db.admin.query("UPDATE work_items SET gh_number = 13 WHERE id = $1", [w.workItemId]);
      expect(await readBound(w, run.id)).toBeNull();
      expect(await readPr(w)).toBeNull();
    });

    /** Writes a signed-job shape straight onto the run, as the admin role would, with the minimum the guard requires. Only the fields the read looks at. */
    async function plantJob(runId: string, continues: Record<string, unknown>) {
      await db.admin.query("BEGIN");
      try {
        await db.admin.query("SELECT set_config('fx.job_min_protocol', '3', true)");
        await db.admin.query("UPDATE agent_runs SET job_signed = $2::jsonb WHERE id = $1", [runId, JSON.stringify({ job: { continues }, signature: "x" })]);
        await db.admin.query("COMMIT");
      } catch (error) {
        await db.admin.query("ROLLBACK");
        throw error;
      }
    }
    const plantEvent = (w: World, runId: string, payload: Record<string, unknown>) =>
      db.admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, (SELECT COALESCE(max(seq), 0) + 1 FROM run_events WHERE run_id = $2), $3, $4::jsonb)", [w.accountId, runId, RUNNER_CONTINUES_BOUND_KIND, JSON.stringify(payload)]);

    it("the job's branch leg: a job naming fx/issue-13 (pr 41) does not bind to an event for fx/issue-12 (pr 41) on item 12", async () => {
      const w = await world();
      const { parent, run } = await pair(w);
      await plantJob(run.id, { parent_run_id: parent.id, session_id: null, branch: "fx/issue-13", pr_number: 41 });
      await plantEvent(w, run.id, { pr_number: 41, branch: ITEM_BRANCH });
      expect(await readBound(w, run.id)).toBeNull();
      await recordDone(w, run.id, { prNumber: 41, branch: ITEM_BRANCH });
      expect(await readPr(w)).toBeNull();
    });

    it("the pull request number leg: matching branches with different numbers read as null through the recorded-branch read", async () => {
      const w = await world();
      const { parent, run } = await pair(w);
      await plantJob(run.id, { parent_run_id: parent.id, session_id: null, branch: ITEM_BRANCH, pr_number: 41 });
      await plantEvent(w, run.id, { pr_number: 42, branch: ITEM_BRANCH });
      await recordDone(w, run.id, { prNumber: 41, branch: ITEM_BRANCH });
      expect(await readBound(w, run.id)).toBeNull();
      expect(await readBranch(w, run.id)).toBeNull();
      // Control: the same rows with agreeing numbers do bind, so the null above is the number leg and nothing else.
      const other = await world();
      const pair2 = await pair(other);
      await plantJob(pair2.run.id, { parent_run_id: pair2.parent.id, session_id: null, branch: ITEM_BRANCH, pr_number: 41 });
      await plantEvent(other, pair2.run.id, { pr_number: 41, branch: ITEM_BRANCH });
      await recordDone(other, pair2.run.id, { prNumber: 41, branch: ITEM_BRANCH });
      expect(await readBranch(other, pair2.run.id)).toBe(ITEM_BRANCH);
    });

    it("a bound event is no use to a run whose signed job names a different branch", async () => {
      const w = await world();
      const { parent, run } = await pair(w);
      // The run's job continues a run branch; an event for the item's branch is planted beside it.
      await issuerWith(createFakeContinuationBinding()).issue({ run, continues: { parentRunId: parent.id, sessionId: null, branch: RUN_BRANCH } });
      await db.admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, (SELECT COALESCE(max(seq), 0) + 1 FROM run_events WHERE run_id = $2), $3, $4::jsonb)", [w.accountId, run.id, RUNNER_CONTINUES_BOUND_KIND, JSON.stringify({ pr_number: 41, branch: ITEM_BRANCH })]);
      await recordDone(w, run.id, { prNumber: 41, branch: ITEM_BRANCH });
      expect(await readBound(w, run.id)).toBeNull();
      expect(await readPr(w)).toBeNull();
    });
  });
});
