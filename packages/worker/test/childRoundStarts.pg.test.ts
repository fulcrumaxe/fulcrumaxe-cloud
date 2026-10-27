import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CATALOGUE } from "@fx/decisions";
import { sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { answerAsk } from "@fx/core/src/decisions/answer.js";
import { addSpec, plannedFixture, reapprove, row, TABLE, type PlannedFixture } from "@fx/db/test/helpers/plannedChildren.js";
import { IdempotencyKeyTakenError, RUNNER_CONTINUES_BOUND_KIND, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { startCheckFixRound, CHECK_FIX_BRANCH_UNKNOWN, type CheckFixDeps } from "../src/checkFix.js";
import { continuationStartInput } from "../src/continuation.js";
import { createResumeModule, resumeStepKey, type ResumeFacade } from "../src/resumeDecision.js";
import type { AdvanceFixRequest, AdvanceRunRequest, AdvanceRunStart, AdvanceStartArgs, AdvanceStepWho } from "../src/advance.js";
import { createSeatResolver, type SeatRequest, type SeatResult } from "../src/seat.js";

/**
 * [pg] D#483 S5-b2c-3, acceptance 10, 11, 12 (sandbox half) and 16: a planned PR child's check-fix round, resume and continuation take the parent's issue number and the child's own
 * branch from the build identity, and refuse with the identity's code, before anything is written, when the parent was deleted, closed, re-specced and not approved again, or the child's
 * key left the approved Spec. The rows are made by the real definers (approval, children); the run starts are keyed stand-ins that write the rows the real ones write.
 */
const INVOKER_LOGIN = "fx_child_round_starts_invoker_test";
const CLASS3 = CATALOGUE.find((e) => e.class === "human_in_the_loop")!.id;
const OPTIONS = [{ id: "keep", label: "Keep the current shape" }, { id: "split", label: "Split it in two" }];
const PROMPT = "You are the executor. Build the planned PR.\n\nAGENT_OUTPUT-instructions-here";
const PARENT_NUMBER = 41;

describe("a planned PR child's check-fix, resume and continuation [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let runnerPool: Pool;
  let appPool: Pool;
  let resolve: (r: SeatRequest) => Promise<SeatResult>;
  const signing = generateKeyPairSync("ed25519").privateKey;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
    runnerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    resolve = createSeatResolver({ pool: runnerPool });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, receiptPool, runnerPool, appPool]) await p.end();
  });

  /** A launched child that built: parent number 41, an executor run pinned to the parent's Spec version. */
  async function kid(o: { mode?: "sandbox" | "runner_local" } = {}): Promise<{ f: PlannedFixture; child: string }> {
    const f = await plannedFixture(admin, appPool, { dial: null, weeklyUsd: null });
    await admin.query("UPDATE work_items SET gh_number = $2 WHERE id = $1", [f.parent, PARENT_NUMBER]);
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = $2 WHERE id = $1", [f.t.repoId, o.mode ?? "sandbox"]);
    await admin.query("UPDATE accounts SET model_budget_usd_month = 437 WHERE id = $1", [f.t.accountId]);
    await admin.query("UPDATE work_items SET envelope_id = (SELECT envelope_id FROM work_items WHERE id = $2) WHERE id = $1", [f.kids.api, f.parent]);
    return { f, child: f.kids.api! };
  }
  const arrange: Record<string, (k: { f: PlannedFixture; child: string }) => Promise<void>> = {
    child_orphaned: async (k) => void (await admin.query("DELETE FROM work_items WHERE id = $1", [k.f.parent])),
    parent_closed: async (k) => void (await admin.query("UPDATE work_items SET stage = 'closed' WHERE id = $1", [k.f.parent])),
    respec_needs_approval: async (k) => void (await addSpec(admin, k.f.t, k.f.parent, 2, TABLE)),
    key_not_in_approved_spec: async (k) => { await addSpec(admin, k.f.t, k.f.parent, 2, [row("docs"), row("other")]); await reapprove(appPool, k.f); },
  };
  const CODES = Object.keys(arrange);
  const runCount = async (f: PlannedFixture) => Number((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1", [f.t.accountId])).rows[0].n);
  const reservations = async (f: PlannedFixture) => Number((await admin.query("SELECT count(*)::int AS n FROM spend_reservations WHERE account_id = $1", [f.t.accountId])).rows[0].n);
  const stageOf = async (id: string) => (await admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [id])).rows[0]?.stage ?? null;

  describe("continuation", () => {
    const BASE_PROMPT = "Build the planned PR.\n\nEnd your final message with this block, and nothing after it:\n<AGENT_OUTPUT>{}</AGENT_OUTPUT>";
    async function ended(k: { f: PlannedFixture; child: string }, over: { mode?: string } = {}): Promise<string> {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, cc_session_id, backend, spec_version_id) VALUES ($1, $2, $3, 'executor', 'production', 'timed_out', $4, $5, 'cc-owned', 'claude', $6)`,
        [id, k.f.t.accountId, k.child, over.mode ?? "sandbox", k.f.t.repoId, k.f.specV1],
      );
      const sha = createHash("sha256").update(BASE_PROMPT).digest("hex");
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 0, 'run.input', $3)`, [k.f.t.accountId, id, JSON.stringify({ prompt: BASE_PROMPT, prompt_sha256: sha })]);
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'checkpoint', $3)`, [k.f.t.accountId, id, JSON.stringify({ reason: "agent_checkpoint", summary: "NOTES", extensions_used: 1 })]);
      return id;
    }
    const deps = () => ({ pool: runnerPool, resolveRunSeat: resolve });

    it("S5b2c3-12: a sandbox continuation of a child's executor run names the parent's issue number and keeps the child's pinned Spec version", async () => {
      const k = await kid();
      const input = await continuationStartInput(deps(), k.f.t.accountId, await ended(k));
      if ("refused" in input) throw new Error(`refused: ${input.refused}`);
      expect(input).toMatchObject({ pr: PARENT_NUMBER, specVersionId: k.f.specV1, repoId: k.f.t.repoId, expectedExecutionMode: "sandbox" });
    });

    it("a started child's continuation goes on after the parent is approved again, on its pinned version (R11)", async () => {
      const k = await kid();
      const run = await ended(k);
      await addSpec(admin, k.f.t, k.f.parent, 2, [row("api", "The API"), row("other", "Other")]);
      await reapprove(appPool, k.f);
      const input = await continuationStartInput(deps(), k.f.t.accountId, run);
      expect(input).toMatchObject({ pr: PARENT_NUMBER, specVersionId: k.f.specV1 });
    });

    for (const code of CODES) {
      it(`S5b2c3-16: ${code} refuses the continuation with the identity's code; nothing starts`, async () => {
        const k = await kid();
        const run = await ended(k);
        await arrange[code]!(k);
        const before = await runCount(k.f);
        const held = await reservations(k.f);
        expect(await continuationStartInput(deps(), k.f.t.accountId, run)).toEqual({ refused: code });
        expect(await runCount(k.f)).toBe(before);
        expect(await reservations(k.f)).toBe(held);
      });
    }
  });

  describe("resume", () => {
    function fakes() {
      const starts: AdvanceRunRequest[] = [];
      const fixes: Array<{ who: AdvanceStepWho; req: AdvanceFixRequest }> = [];
      const follows: AdvanceStartArgs[] = [];
      const keyed = async (key: string, accountId: string, workItemId: string): Promise<AdvanceRunStart> => {
        const runId = randomUUID();
        await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', 'running')", [runId, accountId, workItemId]);
        await admin.query("INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)", [accountId, key, runId, "0".repeat(64)]);
        return { ok: true, runId };
      };
      const facade: ResumeFacade = createResumeModule(runnerPool, {
        startRun: async (req) => (starts.push(req), keyed(`advance:${req.workItemId}:${req.step}`, req.accountId, req.workItemId)),
        startFix: async (who, req) => (fixes.push({ who, req }), keyed(`advance:${who.workItemId}:fix:${req.headSha}:${req.actionId}`, who.accountId, who.workItemId)),
        startAdvance: async (args) => void follows.push(args),
      });
      return { starts, fixes, follows, facade };
    }
    /** The child parked on an open ask: an executor run that succeeded and asked, a retained start prompt. `fix` parks it inside a fix round (Changes requested). */
    async function park(k: { f: PlannedFixture; child: string }, o: { fix?: boolean } = {}) {
      const parked = randomUUID();
      const spec = (await admin.query<{ version: number; body_sha256: string }>("SELECT version, body_sha256 FROM spec_versions WHERE id = $1", [k.f.specV1])).rows[0]!;
      await admin.query("UPDATE work_items SET stage = $2 WHERE id = $1", [k.child, o.fix ? "changes_requested" : "in_progress"]);
      await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, ended_at, spec_version_id, execution_mode) VALUES ($1, $2, $3, 'executor', 'local', 'succeeded', now(), $4, NULL)", [parked, k.f.t.accountId, k.child, k.f.specV1]);
      await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.input', $3::jsonb)", [k.f.t.accountId, parked, JSON.stringify({ prompt: o.fix ? `You are the executor. The reviewers asked for changes.\n\nSpec v${spec.version} unchanged (sha256 ${spec.body_sha256})\n\nREVIEWER FINDINGS:\n- fix it` : PROMPT })]);
      if (o.fix) {
        await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, head_sha, round, run_id, pr_number, dedupe_key) VALUES ($1, $2, 'fix_round_started', $3, 1, $4, 9, 'fix:seed')", [k.f.t.accountId, k.child, "c".repeat(40), parked]);
        await admin.query("INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, reviewer, at, source, source_ref) VALUES ($1, $2, 'pr_opened', 'changes_requested', 'code', now(), 'control_plane', $3)", [k.f.t.accountId, k.child, `fix-round:${randomUUID()}`]);
      }
      const askId = await withTenant(receiptPool, k.f.t.accountId, async (c) =>
        (await c.query<{ id: string }>(`SELECT decision_ask_raise('human_in_the_loop', $1::text, $2::uuid, $3::uuid, $4::jsonb, 'keep', 'because', '["untrusted"]'::jsonb, 60, 'stop_and_flag', 0) AS id`, [CLASS3, k.child, parked, JSON.stringify(OPTIONS)])).rows[0]!.id);
      await answerAsk({ pool: receiptPool, principal: { accountId: k.f.t.accountId, userId: k.f.t.userId } }, { askId, choice: "split" });
      const [req] = (await admin.query("SELECT * FROM run_action_requests WHERE kind = 'resume_decision' AND target_id = $1", [askId])).rows;
      await admin.query("UPDATE run_action_requests SET state = 'claimed', claimed_until = now() + interval '5 minutes', attempts = attempts + 1 WHERE id = $1", [req.id]);
      return { askId, parked, actionId: req.id as string };
    }
    const refusalCodes = async (id: string) => (await admin.query<{ code: string }>("SELECT code FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'resume_refused' ORDER BY seq", [id])).rows.map((r) => r.code);

    it("S5b2c3-11: a child with a resumable ask resumes with the parent's issue number and its pinned version, in the child's own step", async () => {
      const k = await kid();
      const p = await park(k);
      const f = fakes();
      const out = await f.facade.performResumeDecision(p.actionId);
      expect(out).toMatchObject({ result: "done", outcome: { work_item_id: k.child } });
      expect(f.starts).toHaveLength(1);
      expect(f.starts[0]).toMatchObject({ workItemId: k.child, step: resumeStepKey(p.askId), pr: PARENT_NUMBER, parentRunId: p.parked, specVersionId: k.f.specV1 });
    });

    it("S5b2c3-11: a parked fix round of a child resumes on the child's branch and the pull request number it recorded", async () => {
      const k = await kid();
      const p = await park(k, { fix: true });
      const f = fakes();
      await f.facade.performResumeDecision(p.actionId);
      expect(await refusalCodes(k.child)).toEqual([]);
      expect(f.fixes).toHaveLength(1);
      expect(f.fixes[0]!.req).toMatchObject({ issue: PARENT_NUMBER, pr: { number: 9, branch: "fx/41-api" } });
      expect(f.fixes[0]!.who.workItemId).toBe(k.child);
    });

    it("S5b2c3-11: on an orphan the card shows child_orphaned, not a bare work_item_not_resumable", async () => {
      const k = await kid();
      const p = await park(k);
      await arrange.child_orphaned!(k);
      const f = fakes();
      await f.facade.performResumeDecision(p.actionId).catch(() => undefined);
      expect(f.starts).toHaveLength(0);
      expect(await refusalCodes(k.child)).toEqual(["child_orphaned"]);
    });

    for (const code of CODES.filter((c) => c !== "child_orphaned")) {
      it(`S5b2c3-16: ${code} refuses the resume with that code; no run, no reservation, the stage unchanged`, async () => {
        const k = await kid();
        const p = await park(k);
        await arrange[code]!(k);
        const before = await runCount(k.f);
        const held = await reservations(k.f);
        const stage = await stageOf(k.child);
        const f = fakes();
        await f.facade.performResumeDecision(p.actionId).catch(() => undefined);
        expect(f.starts).toHaveLength(0);
        expect(await runCount(k.f)).toBe(before);
        expect(await reservations(k.f)).toBe(held);
        expect(await stageOf(k.child)).toBe(stage);
        expect(await refusalCodes(k.child)).toEqual([code]);
      });
    }
  });

  describe("check-fix", () => {
    interface Started { input: StartAgentRunInput; via: "resume" | "starter" }
    const started: Started[] = [];
    const targets: Array<{ repo: { id: string; owner: string; name: string }; pr: { number: number; branch: string } } | null> = [];
    const seen = new Set<string>();
    const never = {} as ExecutionTargetRegistry;
    let world: { f: PlannedFixture; child: string };

    const make = async (input: StartAgentRunInput, via: Started["via"]) => {
      if (input.role !== "executor" || !input.parentRunId || !Number.isSafeInteger(input.pr)) throw new Error("the real start refuses this input");
      if (seen.has(input.idempotency!.key)) throw new IdempotencyKeyTakenError();
      seen.add(input.idempotency!.key);
      started.push({ input, via });
      const id = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, parent_run_id) VALUES ($1, $2, $3, 'executor', 'runner', 'pending', 'runner_local', $4, $5)`, [id, world.f.t.accountId, world.child, world.f.t.repoId, input.parentRunId]);
      await admin.query("INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)", [world.f.t.accountId, input.idempotency!.key, id, input.idempotency!.requestHash]);
      return id;
    };
    const deps = (): CheckFixDeps => ({
      pool: runnerPool,
      registry: never,
      starter: { start: async (input) => ({ runId: await make(input as StartAgentRunInput, "starter") }) },
      resolveRunSeat: async () => ({ ok: true, seat: { repoId: world.f.t.repoId, product: "team", limits: {}, timeoutMs: 1, maxExtensions: 0 } }) as never,
      resume: async (_p, _r, input) => ({ id: await make(input, "resume"), status: "pending", queued: true }) as never,
      beforeStart: async (target) => (targets.push(target), null),
    });

    beforeEach(() => {
      started.length = 0;
      targets.length = 0;
      seen.clear();
    });

    /** A failed run that worked on the child's pull request branch (a cross-side round), with the cloud's own binding record. */
    async function failedOnItemBranch(branch: string, bound: { branch: string; pr: number } | null, jobBranch = branch): Promise<string> {
      const id = randomUUID();
      const job: Job = {
        schema_version: 1, job_id: randomUUID(), run_id: id, repo: { id: world.f.t.repoId, owner: "acme", name: "widgets", private: true }, role: "executor", mode: "local", spec: null,
        task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") }, role_card: { text: "c", sha256: sha256Text("c") }, role_tools_sha256: "a".repeat(64),
        continues: { parent_run_id: randomUUID(), session_id: null, branch: jobBranch, pr_number: 7 },
        branch_prefix: "fx/", model_hint: null, issued_at: "2026-10-10T12:00:00.000Z", expires_at: "2026-10-13T12:00:00.000Z", key_id: "k1",
        check: { argv: ["bash", "scripts/check.sh"], dev_shell: true, timeout_s: 5400 },
      };
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, cc_session_id, spec_version_id) VALUES ($1, $2, $3, 'executor', 'runner', 'failed', 'runner_local', $4, $5::jsonb, 'sess-1', $6)`,
        [id, world.f.t.accountId, world.child, world.f.t.repoId, JSON.stringify(signJob(job, signing)), world.f.specV1],
      );
      await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)", [world.f.t.accountId, id, JSON.stringify({ from: "running", to: "failed", failureReason: "check_failed" })]);
      if (bound !== null) await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 2, $3, $4::jsonb)", [world.f.t.accountId, id, RUNNER_CONTINUES_BOUND_KIND, JSON.stringify({ branch: bound.branch, pr_number: bound.pr })]);
      await admin.query("INSERT INTO run_checks (account_id, run_id, exit_code, duration_ms, timed_out, summary) VALUES ($1, $2, 1, 60000, false, 'FAIL src/a.test.ts')", [world.f.t.accountId, id]);
      return id;
    }
    const who = () => ({ accountId: world.f.t.accountId, workItemId: world.child });

    it("S5b2c3-10: a child's failed check run on its pull request branch produces a target with the child branch and the bound number; the issue number is the parent's", async () => {
      world = await kid({ mode: "runner_local" });
      const failed = await failedOnItemBranch("fx/41-api", { branch: "fx/41-api", pr: 7 });
      expect(await startCheckFixRound(deps(), who(), failed)).toMatchObject({ ok: true });
      expect(targets).toEqual([{ repo: { id: world.f.t.repoId, owner: "acme", name: "widgets" }, pr: { number: 7, branch: "fx/41-api" } }]);
      expect(started).toHaveLength(1);
      expect(started[0]!.via).toBe("starter");
      expect(started[0]!.input).toMatchObject({ pr: PARENT_NUMBER, workItemId: world.child, parentRunId: failed, continues: { branch: "fx/41-api", prNumber: 7 }, specVersionId: world.f.specV1 });
    });

    it("S5b2c3-10: a record that disagrees gives the existing refusal: the parent's branch, a sibling's branch, or a job and record that name different branches", async () => {
      world = await kid({ mode: "runner_local" });
      for (const [bound, jobBranch] of [
        [{ branch: "fx/issue-41", pr: 7 }, "fx/issue-41"],
        [{ branch: "fx/41-ui", pr: 7 }, "fx/41-ui"],
        [{ branch: "fx/41-api", pr: 7 }, "fx/41-ui"],
        [{ branch: "fx/42-api", pr: 7 }, "fx/42-api"],
        [null, "fx/41-api"],
      ] as const) {
        const failed = await failedOnItemBranch(jobBranch, bound, jobBranch);
        expect(await startCheckFixRound(deps(), who(), failed), JSON.stringify([bound, jobBranch])).toEqual({ ok: false, reason: CHECK_FIX_BRANCH_UNKNOWN });
      }
      expect(started).toEqual([]);
    });

    for (const code of CODES) {
      it(`S5b2c3-16: ${code} refuses the check-fix round with that code; no run, no reservation, the stage unchanged`, async () => {
        world = await kid({ mode: "runner_local" });
        const failed = await failedOnItemBranch("fx/41-api", { branch: "fx/41-api", pr: 7 });
        await arrange[code]!(world);
        const before = await runCount(world.f);
        const held = await reservations(world.f);
        const stage = await stageOf(world.child);
        expect(await startCheckFixRound(deps(), who(), failed)).toEqual({ ok: false, reason: code });
        expect(started).toEqual([]);
        expect(await runCount(world.f)).toBe(before);
        expect(await reservations(world.f)).toBe(held);
        expect(await stageOf(world.child)).toBe(stage);
      });
    }
  });
});
