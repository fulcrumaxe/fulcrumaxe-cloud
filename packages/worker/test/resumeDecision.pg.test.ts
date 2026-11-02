import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CATALOGUE } from "@fx/decisions";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { answerAsk } from "@fx/core/src/decisions/answer.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import type { AdvanceFixRequest, AdvanceRunRequest, AdvanceRunStart, AdvanceStartArgs, AdvanceStepWho } from "../src/advance.js";
import { ResumeDeferredError, ResumePausedError, createResumeModule, reconcileResumes, renderResumeContext, resumeStepKey, type ResumeFacade } from "../src/resumeDecision.js";
import { runActionSteps, type RunActionsWorker } from "@fx/pipeline";
import { createRunActionFacade } from "../src/runActions.js";

/**
 * [pg] D#7 DP11c (DP-C9 section 5, criteria 2 to 5 and 7): resume from the answer, against real Postgres with real logins. The receipt login is a member of
 * app_user and receipt_writer_invoker and nothing else; the runner login is the run writer. The run start is a keyed fake that writes real run rows and
 * counts the sandbox handles it holds; the workflow start is a recorder.
 */
const INVOKER_LOGIN = "fx_resume_perform_invoker_test";
// Not reversal_over_cap: an answer to that ask is never a resume (D#7 DP7-2e, R4), so it cannot stand in for an ordinary class 3 ask here.
const CLASS3 = CATALOGUE.find((e) => e.class === "human_in_the_loop" && e.id !== "reversal_over_cap")!.id;
const OPTIONS = [
  { id: "keep", label: "Keep the current shape" },
  { id: "split", label: "Split it in two" },
];
const PROMPT = "You are the executor. Implement the issue.\n\nAGENT_OUTPUT-instructions-here";

describe("resume_decision: resume from the answer [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let runnerPool: Pool;

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
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, receiptPool, runnerPool]) await p.end();
  });

  /**
   * The fakes: keyed run starts (a replay returns the same run, and a start a spending limit denied leaves a `refused_spend` run holding its key, as the real one
   * does) that open one sandbox handle per run, and a workflow recorder.
   */
  function fakes(opts: { startReason?: string; followThrows?: boolean; deny?: string | null } = {}) {
    const starts: AdvanceRunRequest[] = [];
    const fixes: Array<{ who: AdvanceStepWho; req: AdvanceFixRequest }> = [];
    const follows: AdvanceStartArgs[] = [];
    const handles = new Set<string>();
    const denied = new Map<string, string>();
    const state: { startReason?: string; followThrows?: boolean; deny?: string | null } = { ...opts };
    const keyed = async (key: string, accountId: string, workItemId: string): Promise<AdvanceRunStart> => {
      const held = await admin.query<{ run_id: string }>("SELECT run_id FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [accountId, key]);
      if (held.rows[0]) {
        const why = denied.get(key);
        return why === undefined ? { ok: true, runId: held.rows[0].run_id } : { ok: false, reason: why };
      }
      const runId = randomUUID();
      const refusedFor = state.deny ?? null;
      await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', $4)", [runId, accountId, workItemId, refusedFor === null ? "running" : "refused_spend"]);
      await admin.query("INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)", [accountId, key, runId, "0".repeat(64)]);
      if (refusedFor !== null) {
        denied.set(key, refusedFor);
        return { ok: false, reason: refusedFor };
      }
      handles.add(runId);
      return { ok: true, runId };
    };
    const startRun = async (req: AdvanceRunRequest): Promise<AdvanceRunStart> => {
      starts.push(req);
      if (state.startReason !== undefined) return { ok: false, reason: state.startReason };
      return keyed(`advance:${req.workItemId}:${req.step}`, req.accountId, req.workItemId);
    };
    const startFix = async (who: AdvanceStepWho, req: AdvanceFixRequest): Promise<AdvanceRunStart> => {
      fixes.push({ who, req });
      if (state.startReason !== undefined) return { ok: false, reason: state.startReason };
      return keyed(`advance:${who.workItemId}:fix:${req.headSha}:${req.actionId}${req.spendAttempt ? `:s${req.spendAttempt}` : ""}`, who.accountId, who.workItemId);
    };
    const startAdvance = async (args: AdvanceStartArgs): Promise<void> => {
      if (state.followThrows) throw new Error("workflow service down");
      follows.push(args);
    };
    const facade: ResumeFacade = createResumeModule(runnerPool, { startRun, startFix, startAdvance });
    return { starts, fixes, follows, handles, state, facade };
  }

  interface World {
    a: SeedRefs;
    itemId: string;
    parkedRunId: string;
    askId: string;
  }
  /** An item parked on an open ask: an executor run that succeeded and asked, a retained start prompt, a stage and a halt epoch. */
  async function park(o: { a?: SeedRefs; stage?: string; prompt?: string | null; ghNumber?: number | null; spec?: boolean; mode?: string; head?: string } = {}): Promise<World> {
    const a = o.a ?? (await seedAccount(admin, randomUUID()));
    const itemId = randomUUID();
    const parkedRunId = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', $4, $5)", [itemId, a.accountId, a.repoId, o.stage ?? "in_progress", o.ghNumber === undefined ? 42 : o.ghNumber]);
    let specId: string | null = null;
    if (o.spec === true) {
      specId = randomUUID();
      await admin.query("INSERT INTO spec_versions (id, account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, $3, 1, $4, $5, 'system')", [specId, a.accountId, itemId, SPEC_BODY, SPEC_SHA]);
    }
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, ended_at, spec_version_id, execution_mode, head_sha) VALUES ($1, $2, $3, 'executor', $6, 'succeeded', now(), $4, $5, $7)", [parkedRunId, a.accountId, itemId, specId, o.mode ?? null, o.mode === undefined ? "local" : "runner", o.head ?? null]);
    if (o.prompt !== null) await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.input', $3::jsonb)", [a.accountId, parkedRunId, JSON.stringify({ prompt: o.prompt ?? PROMPT })]);
    const askId = await withTenant(receiptPool, a.accountId, async (c) =>
      (await c.query<{ id: string }>(
        `SELECT decision_ask_raise('human_in_the_loop', $1::text, $2::uuid, $3::uuid, $4::jsonb, 'keep', 'because', '["untrusted"]'::jsonb, 60, 'stop_and_flag', 0) AS id`,
        [CLASS3, itemId, parkedRunId, JSON.stringify(OPTIONS)],
      )).rows[0]!.id);
    return { a, itemId, parkedRunId, askId };
  }

  const SPEC_BODY = "Build the widget exactly as described.";
  const SPEC_SHA = createHash("sha256").update(SPEC_BODY).digest("hex");
  const HEAD = "c".repeat(40);
  interface FixWorld extends World {
    failingRunId: string;
  }
  /**
   * An item parked INSIDE a fix round: the stage is Changes requested, the parked run is the fix run (its prompt says the Spec is unchanged, as a sandbox fix
   * round's does), the driver recorded `fix_round_started` for it, and the move into Changes requested names the review that asked.
   */
  async function parkFix(o: { prompt?: string; spec?: boolean; context?: boolean; mode?: string } = {}): Promise<FixWorld> {
    const prompt = o.prompt ?? `You are the executor. The reviewers asked for changes.\n\nSpec v1 unchanged (sha256 ${SPEC_SHA})\n\nREVIEWER FINDINGS:\n- handle the empty list`;
    const w = await park({ stage: "changes_requested", prompt, spec: o.spec !== false, ...(o.mode === undefined ? {} : { mode: o.mode }) });
    const failingRunId = randomUUID();
    if (o.context !== false) {
      await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, head_sha, round, run_id, dedupe_key) VALUES ($1, $2, 'fix_round_started', $3, 2, $4, 'fix:seed')", [w.a.accountId, w.itemId, HEAD, w.parkedRunId]);
      await admin.query(
        "INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, reviewer, at, source, source_ref) VALUES ($1, $2, 'pr_opened', 'changes_requested', 'security', now(), 'control_plane', $3)",
        [w.a.accountId, w.itemId, `fix-round:${failingRunId}`],
      );
    }
    return { ...w, failingRunId };
  }
  const refusalFact = async (itemId: string) => (await admin.query<{ code: string; run_id: string | null }>("SELECT code, run_id FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'resume_refused' ORDER BY seq", [itemId])).rows;

  const answer = (w: World, choice: string) => answerAsk({ pool: receiptPool, principal: { accountId: w.a.accountId, userId: w.a.userId } }, { askId: w.askId, choice });
  const requests = async (askId: string) => (await admin.query("SELECT * FROM run_action_requests WHERE kind = 'resume_decision' AND target_id = $1", [askId])).rows;
  /** Claims the request the way the workflow does: a live lease. */
  async function claim(askId: string): Promise<string> {
    const [r] = await requests(askId);
    await admin.query("UPDATE run_action_requests SET state = 'claimed', claimed_until = now() + interval '5 minutes', attempts = attempts + 1 WHERE id = $1", [r.id]);
    return r.id;
  }
  const runsOf = async (itemId: string) => (await admin.query("SELECT id, status FROM agent_runs WHERE work_item_id = $1 ORDER BY created_at", [itemId])).rows;

  describe("the answer asks for the resume, and the resume starts one run carrying it", () => {
    it("an answered ask: the request is the person's, the run is keyed resume:<ask>, its prompt is the parked prompt plus the typed context, the workflow follows it", async () => {
      const w = await park();
      await answer(w, "split");
      const [req] = await requests(w.askId);
      expect(req).toMatchObject({ requested_by: `session:${w.a.userId}`, principal_kind: "session", state: "accepted", resume_halt_epoch: 0 });
      const f = fakes();
      const actionId = await claim(w.askId);
      const out = await f.facade.performResumeDecision(actionId);
      expect(out).toMatchObject({ result: "done", outcome: { work_item_id: w.itemId, cause: "decision_resolved" } });
      expect(f.starts).toHaveLength(1);
      expect(f.starts[0]).toMatchObject({ accountId: w.a.accountId, workItemId: w.itemId, role: "executor", step: resumeStepKey(w.askId), clone: true, exclusive: true, pr: 42, haltEpoch: 0, parentRunId: w.parkedRunId });
      expect(f.starts[0]!.prompt.startsWith(PROMPT)).toBe(true);
      expect(f.starts[0]!.prompt).toContain("cause: decision_resolved\noption: split");
      const runId = (out as unknown as { outcome: { run_id: string } }).outcome.run_id;
      expect(f.follows).toEqual([{ accountId: w.a.accountId, userId: w.a.userId, workItemId: w.itemId, actionId, haltEpoch: 0, specVersion: null, resumeRunId: runId }]);
    });

    it("D#519 MQ4-b0: a parked stacked build resumes from the parked run's start commit (its head_sha); a default-branch build passes none", async () => {
      const stacked = await park({ head: "e".repeat(40), prompt: `${PROMPT}\n1. This work builds on a pull request that has not merged yet.` });
      await answer(stacked, "split");
      const f = fakes();
      await f.facade.performResumeDecision(await claim(stacked.askId));
      expect(f.starts).toHaveLength(1);
      expect(f.starts[0]!.headSha).toBe("e".repeat(40));
      const plain = await park();
      await answer(plain, "split");
      const g = fakes();
      await g.facade.performResumeDecision(await claim(plain.askId));
      expect(g.starts).toHaveLength(1);
      expect(g.starts[0]).not.toHaveProperty("headSha");
    });

    it("deny resumes with decision_denied and no option", async () => {
      const w = await park();
      await answer(w, "deny");
      const f = fakes();
      const out = await f.facade.performResumeDecision(await claim(w.askId));
      expect(out).toMatchObject({ result: "done", outcome: { cause: "decision_denied" } });
      expect(f.starts[0]!.prompt).toContain("cause: decision_denied");
      expect(f.starts[0]!.prompt).not.toContain("option:");
    });

    it("performing twice resumes once (a replay returns the same run, starts nothing, and follows it again only while it is live)", async () => {
      const w = await park();
      await answer(w, "keep");
      const f = fakes();
      const id = await claim(w.askId);
      const first = await f.facade.performResumeDecision(id);
      const second = await f.facade.performResumeDecision(id);
      expect(second).toEqual(first);
      expect((await runsOf(w.itemId)).filter((r) => r.id !== w.parkedRunId)).toHaveLength(1);
      expect(f.starts).toHaveLength(1);
      expect(f.follows).toHaveLength(2); // at-least-once while the run is live
      await admin.query("UPDATE agent_runs SET status = 'succeeded', ended_at = now() WHERE work_item_id = $1 AND id <> $2", [w.itemId, w.parkedRunId]);
      // The run ended in the crash window before any workflow read it, and the item still sits where the park left it: nobody has read its outcome, so it is followed.
      await f.facade.performResumeDecision(id);
      expect(f.follows).toHaveLength(3);
      expect(f.starts).toHaveLength(1);
      // Once the item has moved on (the workflow got there), a finished run is not followed again.
      await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [w.itemId]);
      expect(await f.facade.performResumeDecision(id)).toEqual(first);
      expect(f.follows).toHaveLength(3);
      expect(f.starts).toHaveLength(1);
    });

    it("a run that ended before the workflow start was retried is still followed (the crash window), then not again once the item moved on", async () => {
      const w = await park();
      await answer(w, "keep");
      const f = fakes({ followThrows: true });
      const id = await claim(w.askId);
      await expect(f.facade.performResumeDecision(id)).rejects.toThrow("workflow service down");
      await admin.query("UPDATE agent_runs SET status = 'succeeded', ended_at = now() WHERE work_item_id = $1 AND id <> $2", [w.itemId, w.parkedRunId]);
      f.state.followThrows = false;
      expect(await f.facade.performResumeDecision(id)).toMatchObject({ result: "done" });
      expect(f.follows).toHaveLength(1);
      expect(f.starts).toHaveLength(1);
    });

    it("a crash between the run and the workflow start: the retry finds the run, starts no second one, and follows it", async () => {
      const w = await park();
      await answer(w, "keep");
      const f = fakes({ followThrows: true });
      const id = await claim(w.askId);
      await expect(f.facade.performResumeDecision(id)).rejects.toThrow("workflow service down");
      expect((await runsOf(w.itemId)).filter((r) => r.id !== w.parkedRunId)).toHaveLength(1);
      f.state.followThrows = false;
      const out = await f.facade.performResumeDecision(id);
      expect(out).toMatchObject({ result: "done" });
      expect((await runsOf(w.itemId)).filter((r) => r.id !== w.parkedRunId)).toHaveLength(1);
      expect(f.follows).toHaveLength(1);
    });

    it("a crash between the answer and the request: an ask answered with no request is found by the reconcile, once, and resumes", async () => {
      const w = await park();
      await answer(w, "keep");
      await admin.query("DELETE FROM run_action_requests WHERE target_id = $1", [w.askId]); // a request the old code never made
      expect(await requests(w.askId)).toEqual([]);
      const warns: string[] = [];
      expect(await reconcileResumes({ pool: receiptPool, warn: (l) => warns.push(l) })).toBeGreaterThanOrEqual(1);
      expect(await reconcileResumes({ pool: receiptPool, warn: (l) => warns.push(l) })).toBe(0);
      const [req] = await requests(w.askId);
      expect(req).toMatchObject({ requested_by: "system", principal_kind: "system" });
      const f = fakes();
      const out = await f.facade.performResumeDecision(await claim(w.askId));
      expect(out).toMatchObject({ result: "done", outcome: { cause: "decision_resolved" } });
      // the person who answered is who the resumed run is for
      expect(f.follows[0]).toMatchObject({ userId: w.a.userId, resumeRunId: expect.any(String) });
      expect(warns.some((l) => l.includes("decision.resume_requested"))).toBe(true);
    });

    it("a proceeded ask (a timeout that went ahead) resumes with its proposed option, for the approver; with no approver it is refused, not lost", async () => {
      const w = await park();
      await admin.query("UPDATE decision_asks SET state = 'proceeded', answered_option = proposed, answered_at = now() WHERE id = $1", [w.askId]);
      await reconcileResumes({ pool: receiptPool, warn: () => undefined });
      const f = fakes();
      const id = await claim(w.askId);
      expect(await f.facade.performResumeDecision(id)).toMatchObject({ result: "refused", errorCode: "principal_not_authorised" });
      expect(f.starts).toEqual([]);
      await admin.query("INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash, state, finished_at) VALUES ($1, 'advance_work_item', $2, $3, 'session', 'h', 'done', now())", [w.a.accountId, w.itemId, `session:${w.a.userId}`]);
      const out = await f.facade.performResumeDecision(id);
      expect(out).toMatchObject({ result: "done", outcome: { cause: "decision_resolved" } });
      expect(f.starts[0]!.prompt).toContain("option: keep");
      expect(f.follows[0]).toMatchObject({ userId: w.a.userId });
    });
  });

  describe("what never resumes", () => {
    async function refusedWith(w: World, code: string, setup: () => Promise<void> = async () => undefined, extraRuns = 0) {
      await answer(w, "keep");
      await setup();
      const f = fakes();
      const out = await f.facade.performResumeDecision(await claim(w.askId));
      expect(out).toEqual({ result: "refused", errorCode: code });
      expect(f.starts).toEqual([]);
      expect(f.follows).toEqual([]);
      expect((await runsOf(w.itemId)).filter((r) => r.id !== w.parkedRunId)).toHaveLength(extraRuns);
    }

    it("a halted item", async () => {
      const w = await park();
      await refusedWith(w, "work_item_not_resumable", async () => void (await admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = halt_epoch + 1 WHERE id = $1", [w.itemId, randomUUID()])));
    });

    it("an item that was already halted when the answer was made (the request records the halted epoch, so only the marker stops it)", async () => {
      const w = await park();
      await admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = halt_epoch + 1 WHERE id = $1", [w.itemId, randomUUID()]);
      await refusedWith(w, "work_item_not_resumable");
    });

    it("a changed halt epoch, even when the halt was lifted again", async () => {
      const w = await park();
      await refusedWith(w, "work_item_not_resumable", async () => void (await admin.query("UPDATE work_items SET halt_epoch = halt_epoch + 1 WHERE id = $1", [w.itemId])));
    });

    it("an item that has moved on: closed, merged, needs a person", async () => {
      for (const stage of ["closed", "merged", "needs_human", "pr_opened"]) {
        const w = await park();
        await refusedWith(w, "work_item_not_resumable", async () => void (await admin.query("UPDATE work_items SET stage = $2 WHERE id = $1", [w.itemId, stage])));
      }
    });

    it("a superseded ask: a newer executor run exists because a person pressed Approve or Build again", async () => {
      const w = await park();
      await refusedWith(w, "work_item_not_resumable", async () => {
        await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, created_at) VALUES ($1, $2, $3, 'executor', 'local', 'running', now() + interval '1 second')", [randomUUID(), w.a.accountId, w.itemId]);
      }, 1);
    });

    it("a withdrawn ask: the request definer cannot be asked for it, and a forged request for it is refused", async () => {
      const w = await park();
      await admin.query("UPDATE decision_asks SET state = 'withdrawn', withdrawn_reason = 'superseded' WHERE id = $1", [w.askId]);
      await expect(answer(w, "keep")).rejects.toMatchObject({ code: "already_answered" });
      expect(await requests(w.askId)).toEqual([]);
      await reconcileResumes({ pool: receiptPool, warn: () => undefined });
      expect(await requests(w.askId)).toEqual([]);
      await admin.query("INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash, resume_halt_epoch, state, claimed_until) VALUES ($1, 'resume_decision', $2, 'system', 'system', 'h', 0, 'claimed', now() + interval '5 minutes')", [w.a.accountId, w.askId]);
      const f = fakes();
      const [req] = await requests(w.askId);
      expect(await f.facade.performResumeDecision(req.id)).toEqual({ result: "refused", errorCode: "ask_not_resumable" });
      expect(f.starts).toEqual([]);
    });

    it("an open or overdue ask (a forged request)", async () => {
      for (const state of ["open", "overdue"]) {
        const w = await park();
        if (state === "overdue") await admin.query("UPDATE decision_asks SET state = 'overdue' WHERE id = $1", [w.askId]);
        await admin.query("INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash, resume_halt_epoch, state, claimed_until) VALUES ($1, 'resume_decision', $2, 'system', 'system', 'h', 0, 'claimed', now() + interval '5 minutes')", [w.a.accountId, w.askId]);
        const f = fakes();
        const [req] = await requests(w.askId);
        expect(await f.facade.performResumeDecision(req.id)).toEqual({ result: "refused", errorCode: "ask_not_resumable" });
        expect(f.starts).toEqual([]);
      }
    });

    it("a parked run whose start prompt was not retained", async () => {
      const w = await park({ prompt: null });
      await refusedWith(w, "prompt_not_retained");
    });

    it("an action that is not a resume_decision, and a request nobody can perform as", async () => {
      const w = await park();
      await answer(w, "keep");
      const id = await claim(w.askId);
      await admin.query("UPDATE run_action_requests SET requested_by = $2 WHERE id = $1", [id, `session:${randomUUID()}`]);
      const f = fakes();
      expect(await f.facade.performResumeDecision(id)).toEqual({ result: "refused", errorCode: "principal_not_authorised" });
      await expect(f.facade.performResumeDecision("not-a-uuid")).rejects.toMatchObject({ name: "RunActionInputError" });
    });

    it("a person who is no longer an owner or admin", async () => {
      const w = await park();
      await answer(w, "keep");
      await admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [w.a.accountId, w.a.userId]);
      const f = fakes();
      expect(await f.facade.performResumeDecision(await claim(w.askId))).toEqual({ result: "refused", errorCode: "principal_not_authorised" });
      expect(f.starts).toEqual([]);
    });
  });

  describe("start outcomes", () => {
    it.each(["start_sandbox_reaping", "starter_unavailable"])("%s is deferred: nothing is started and the request waits a minute (an attempt is given back)", async (reason) => {
      const w = await park();
      await answer(w, "keep");
      const f = fakes({ startReason: reason });
      await expect(f.facade.performResumeDecision(await claim(w.askId))).rejects.toBeInstanceOf(ResumeDeferredError);
      expect(f.follows).toEqual([]);
      expect(await refusalFact(w.itemId)).toEqual([]);
    });

    it.each(["account_budget_reached", "compute_cap_reached", "item_cap_reached", "run_limit_below_estimate", "envelope_reached", "model_credits_exhausted", "model_budget_exceeded", "compute_cap_exceeded", "work_item_cap_exceeded", "per_spawn_cap_exceeded", "envelope_exceeded", "already_running", "waiting_for_capacity"])(
      "%s is a pause or a wait on another run, not a refusal: nothing is started and the request waits for the limit",
      async (reason) => {
        const w = await park();
        await answer(w, "keep");
        const f = fakes({ startReason: reason });
        await expect(f.facade.performResumeDecision(await claim(w.askId))).rejects.toBeInstanceOf(ResumePausedError);
        expect(f.follows).toEqual([]);
        expect(await refusalFact(w.itemId)).toEqual([]);
      },
    );

    it.each(["item_halted", "halted_since_approval"])("%s refuses the action as not resumable, and the item says so", async (reason) => {
      const w = await park();
      await answer(w, "keep");
      const f = fakes({ startReason: reason });
      expect(await f.facade.performResumeDecision(await claim(w.askId))).toEqual({ result: "refused", errorCode: "work_item_not_resumable" });
      expect(await refusalFact(w.itemId)).toEqual([{ code: "work_item_not_resumable", run_id: w.parkedRunId }]);
    });

    it("any other refusal is passed on as its fixed code, and text that is not a code becomes start_refused; each leaves its code on the item", async () => {
      const w = await park();
      await answer(w, "keep");
      expect(await fakes({ startReason: "no_repo" }).facade.performResumeDecision(await claim(w.askId))).toEqual({ result: "refused", errorCode: "no_repo" });
      expect((await refusalFact(w.itemId)).map((r) => r.code)).toEqual(["no_repo"]);
      const v = await park();
      await answer(v, "keep");
      expect(await fakes({ startReason: "Some Free Text!" }).facade.performResumeDecision(await claim(v.askId))).toEqual({ result: "refused", errorCode: "start_refused" });
      expect((await refusalFact(v.itemId)).map((r) => r.code)).toEqual(["start_refused"]);
    });

    it("a spending limit that denied the start leaves a spent key: the next start is a new attempt (:s1, :s2), so it can start once the limit allows it", async () => {
      const w = await park();
      await answer(w, "keep");
      const f = fakes({ deny: "model_budget_exceeded" });
      const id = await claim(w.askId);
      await expect(f.facade.performResumeDecision(id)).rejects.toBeInstanceOf(ResumePausedError);
      expect(f.starts.map((x) => x.step)).toEqual([resumeStepKey(w.askId)]);
      // the same request again (the sweep), still denied: a new attempt, a new key
      await admin.query("UPDATE run_action_requests SET state = 'claimed', claimed_until = now() + interval '5 minutes' WHERE id = $1", [id]);
      await expect(f.facade.performResumeDecision(id)).rejects.toBeInstanceOf(ResumePausedError);
      expect(f.starts.map((x) => x.step)).toEqual([resumeStepKey(w.askId), `${resumeStepKey(w.askId)}:s1`]);
      // the limit is raised: the third attempt starts, the refused runs do not count as a newer run of the item, and the workflow follows the started one
      f.state.deny = null;
      const out = await f.facade.performResumeDecision(id);
      expect(out).toMatchObject({ result: "done", outcome: { work_item_id: w.itemId } });
      expect(f.starts.map((x) => x.step)).toEqual([resumeStepKey(w.askId), `${resumeStepKey(w.askId)}:s1`, `${resumeStepKey(w.askId)}:s2`]);
      expect(f.follows).toHaveLength(1);
      expect((await runsOf(w.itemId)).map((r) => r.status).sort()).toEqual(["refused_spend", "refused_spend", "running", "succeeded"]);
    });
  });

  describe("a parked fix round (changes_requested) resumes through the fix start", () => {
    it("is started by the fix start (never the build's default-branch clone), carrying the head, round, review and the Spec body, once-blocked, and the workflow follows it", async () => {
      const w = await parkFix();
      await answer(w, "split");
      const f = fakes();
      const actionId = await claim(w.askId);
      const out = await f.facade.performResumeDecision(actionId);
      expect(out).toMatchObject({ result: "done", outcome: { work_item_id: w.itemId, cause: "decision_resolved" } });
      expect(f.starts).toEqual([]);
      expect(f.fixes).toHaveLength(1);
      const { who, req } = f.fixes[0]!;
      expect(who).toEqual({ accountId: w.a.accountId, userId: w.a.userId, workItemId: w.itemId, haltEpoch: 0 });
      expect(req).toMatchObject({ issue: 42, headSha: HEAD, round: 2, actionId, reviewer: "security", failingRunId: w.failingRunId });
      expect(req.prompt).toContain("SPEC (version 1):");
      expect(req.prompt).toContain(SPEC_BODY);
      expect(req.prompt).not.toContain("unchanged");
      expect(req.prompt).toContain("REVIEWER FINDINGS:\n- handle the empty list");
      expect(req.prompt.match(/Resume context, from the orchestrator/g)).toHaveLength(1);
      expect(req.prompt).toContain("cause: decision_resolved\noption: split");
      expect(req.held).toBeUndefined();
      expect(req.fallbackPrompt).toBeUndefined();
      expect(req.spendAttempt).toBeUndefined();
      const runId = (out as unknown as { outcome: { run_id: string } }).outcome.run_id;
      expect(f.follows).toEqual([{ accountId: w.a.accountId, userId: w.a.userId, workItemId: w.itemId, actionId, haltEpoch: 0, specVersion: 1, resumeRunId: runId }]);
    });

    it("a prompt that already carries the Spec body (a runner round's) is sent as it is, with the block once", async () => {
      const w = await parkFix({ prompt: `You are the executor.\n\nSPEC (version 1):\n${SPEC_BODY}\n\nREVIEWER FINDINGS:\n- a` });
      await answer(w, "deny");
      const f = fakes();
      await f.facade.performResumeDecision(await claim(w.askId));
      const prompt = f.fixes[0]!.req.prompt;
      expect(prompt.match(/SPEC \(version 1\):/g)).toHaveLength(1);
      expect(prompt).toContain("cause: decision_denied");
    });

    it("a spending limit that denies the fix start is a pause: the next attempt carries spendAttempt, and the denied key is not mistaken for a newer run", async () => {
      const w = await parkFix();
      await answer(w, "keep");
      const f = fakes({ deny: "envelope_exceeded" });
      const id = await claim(w.askId);
      await expect(f.facade.performResumeDecision(id)).rejects.toBeInstanceOf(ResumePausedError);
      await admin.query("UPDATE run_action_requests SET state = 'claimed', claimed_until = now() + interval '5 minutes' WHERE id = $1", [id]);
      await expect(f.facade.performResumeDecision(id)).rejects.toBeInstanceOf(ResumePausedError);
      f.state.deny = null;
      await admin.query("UPDATE run_action_requests SET state = 'claimed', claimed_until = now() + interval '5 minutes' WHERE id = $1", [id]);
      expect(await f.facade.performResumeDecision(id)).toMatchObject({ result: "done" });
      expect(f.fixes.map((x) => x.req.spendAttempt)).toEqual([undefined, 1, 2]);
    });

    it("another run of the item still live is a wait, and the fix start is not even asked", async () => {
      const w = await parkFix();
      await answer(w, "keep");
      await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, created_at) VALUES ($1, $2, $3, 'code-reviewer', 'local', 'running', now() - interval '1 day')", [randomUUID(), w.a.accountId, w.itemId]);
      const f = fakes();
      await expect(f.facade.performResumeDecision(await claim(w.askId))).rejects.toBeInstanceOf(ResumePausedError);
      expect(f.fixes).toEqual([]);
    });

    it.each([
      ["the fix round is not on record (no head, round or review)", () => parkFix({ context: false }), "fix_round_context_missing"],
      ["the Spec it names is gone", () => parkFix({ spec: false }), "spec_unavailable"],
      ["the Spec line names another body", () => parkFix({ prompt: `x\n\nSpec v1 unchanged (sha256 ${"0".repeat(64)})\n\ny` }), "spec_unavailable"],
      ["the prompt carries no Spec at all", () => parkFix({ prompt: "You are the executor. Fix it." }), "spec_unavailable"],
    ])("%s: refused with a visible code, nothing started", async (_why, make, code) => {
      const w = await make();
      await answer(w, "keep");
      const f = fakes();
      expect(await f.facade.performResumeDecision(await claim(w.askId))).toEqual({ result: "refused", errorCode: code });
      expect(f.fixes).toEqual([]);
      expect(f.starts).toEqual([]);
      expect(await refusalFact(w.itemId)).toEqual([{ code, run_id: w.parkedRunId }]);
    });

    it("a repository that changed side since the round was parked cannot continue it", async () => {
      const w = await parkFix({ mode: "runner_local" });
      await answer(w, "keep");
      const f = fakes();
      expect(await f.facade.performResumeDecision(await claim(w.askId))).toEqual({ result: "refused", errorCode: "execution_mode_changed" });
      expect(f.fixes).toEqual([]);
    });
  });

  describe("a run resumed twice carries one Resume context block", () => {
    it("the stored prompt of a resumed run already ends in a block: the next resume replaces it", async () => {
      const first = renderResumeContext({ cause: "decision_resolved", option: "keep" });
      const w = await park({ prompt: `${PROMPT}\n\n${first}` });
      await answer(w, "split");
      const f = fakes();
      await f.facade.performResumeDecision(await claim(w.askId));
      const prompt = f.starts[0]!.prompt;
      expect(prompt.match(/Resume context, from the orchestrator/g)).toHaveLength(1);
      expect(prompt.startsWith(PROMPT)).toBe(true);
      expect(prompt).toContain("option: split");
      expect(prompt).not.toContain("option: keep");
    });

    it("text in the prompt that only looks like the block (not at the very end) is left alone", async () => {
      const w = await park({ prompt: `${PROMPT}\n\nResume context, from the orchestrator (it is not part of the repository or the Spec):\nan agent wrote this\n\nmore text` });
      await answer(w, "keep");
      const f = fakes();
      await f.facade.performResumeDecision(await claim(w.askId));
      expect(f.starts[0]!.prompt).toContain("an agent wrote this");
      expect(f.starts[0]!.prompt.match(/Resume context, from the orchestrator/g)).toHaveLength(2);
    });
  });

  describe("a refused or failed resume leaves its fixed code on the item", () => {
    it.each([
      ["prompt_not_retained", async () => park({ prompt: null }), async () => undefined],
      ["work_item_not_resumable", async () => park(), async (w: World) => void (await admin.query("UPDATE work_items SET stage = 'closed' WHERE id = $1", [w.itemId]))],
      ["principal_not_authorised", async () => park(), async (w: World) => void (await admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [w.a.accountId, w.a.userId]))],
    ])("%s", async (code, make, setup) => {
      const w = await make();
      await answer(w, "keep");
      await setup(w);
      const f = fakes();
      expect(await f.facade.performResumeDecision(await claim(w.askId))).toEqual({ result: "refused", errorCode: code });
      expect(await refusalFact(w.itemId)).toEqual([{ code, run_id: w.parkedRunId }]);
    });

    it("an ask with no run to resume: ask_no_run", async () => {
      // The answer refuses an ask with no run, so this is the other way to get here: the run row the ask names is gone by the time the resume is performed.
      const w = await park();
      await answer(w, "keep");
      await admin.query("UPDATE decision_asks SET run_id = NULL WHERE id = $1", [w.askId]);
      const f = fakes();
      expect(await f.facade.performResumeDecision(await claim(w.askId))).toEqual({ result: "refused", errorCode: "ask_no_run" });
      expect(await refusalFact(w.itemId)).toEqual([{ code: "ask_no_run", run_id: null }]);
    });

    it("a request nobody should have made (a forged one for an open ask) leaves nothing on the item", async () => {
      const w = await park();
      await admin.query("INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash, resume_halt_epoch, state, claimed_until) VALUES ($1, 'resume_decision', $2, 'system', 'system', 'h', 0, 'claimed', now() + interval '5 minutes')", [w.a.accountId, w.askId]);
      const f = fakes();
      const [req] = await requests(w.askId);
      expect(await f.facade.performResumeDecision(req.id)).toEqual({ result: "refused", errorCode: "ask_not_resumable" });
      expect(await refusalFact(w.itemId)).toEqual([]);
    });

    it("the last attempt a failure gets leaves resume_failed, and an earlier one does not", async () => {
      const w = await park();
      await answer(w, "keep");
      const f = fakes({ followThrows: true });
      const [req] = await requests(w.askId);
      await admin.query("UPDATE run_action_requests SET attempts = 2 WHERE id = $1", [req.id]);
      await expect(f.facade.performResumeDecision(await claim(w.askId))).rejects.toThrow("workflow service down");
      expect(await refusalFact(w.itemId)).toEqual([]);
      await admin.query("UPDATE run_action_requests SET state = 'accepted', attempts = 4, claimed_until = NULL WHERE id = $1", [req.id]);
      await expect(f.facade.performResumeDecision(await claim(w.askId))).rejects.toThrow("workflow service down");
      expect(await refusalFact(w.itemId)).toEqual([{ code: "resume_failed", run_id: w.parkedRunId }]);
    });

    it("a fact that cannot be written is a fixed log line and never changes the answer", async () => {
      const w = await park({ prompt: null });
      await answer(w, "keep");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      // A runner pool whose insert into the driver facts fails, as a lost connection would.
      const flaky = new Proxy(runnerPool, {
        get(target, prop) {
          if (prop === "connect") {
            return async () => {
              const c = await target.connect();
              // A view of the client, never a change to it: the pool hands the same client to the next test.
              return new Proxy(c, {
                get(client, p) {
                  if (p === "query") return (...a: unknown[]) => (typeof a[0] === "string" && a[0].includes("INSERT INTO work_item_driver_events") ? Promise.reject(new Error("connect ECONNREFUSED 10.0.0.1")) : (client.query as (...x: unknown[]) => unknown)(...a));
                  const v = (client as unknown as Record<string | symbol, unknown>)[p];
                  return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(client) : v;
                },
              });
            };
          }
          const v = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      try {
        const facade = createResumeModule(flaky, { startRun: async () => ({ ok: false, reason: "unused" }), startFix: async () => ({ ok: false, reason: "unused" }), startAdvance: null });
        expect(await facade.performResumeDecision(await claim(w.askId))).toEqual({ result: "refused", errorCode: "prompt_not_retained" });
        expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: "decision.resume_refusal_unrecorded", ask_id: w.askId, code: "prompt_not_retained" }));
        expect(await refusalFact(w.itemId)).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("the session request acts only as its requester", () => {
    it("the requester was demoted while another approver is still an admin: refused, nothing started (the approver's standing is not the requester's)", async () => {
      const w = await park();
      const approver = randomUUID();
      await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [approver, `approver-${approver}@example.test`]);
      await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')", [w.a.accountId, approver]);
      await admin.query("INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash, state, finished_at) VALUES ($1, 'advance_work_item', $2, $3, 'session', 'h', 'done', now())", [w.a.accountId, w.itemId, `session:${approver}`]);
      await answer(w, "keep");
      await admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [w.a.accountId, w.a.userId]);
      const f = fakes();
      expect(await f.facade.performResumeDecision(await claim(w.askId))).toEqual({ result: "refused", errorCode: "principal_not_authorised" });
      expect(f.starts).toEqual([]);
      expect(f.follows).toEqual([]);
    });
  });

  describe("a spending pause that outlasts the run-action retries is deferred, not lost", () => {
    /** The real claim, perform and settle steps over the real run-action facade; only the run start is a fake. */
    function stepsWorker(f: ReturnType<typeof fakes>): RunActionsWorker {
      return { ...createRunActionFacade(runnerPool, {} as never), performResumeDecision: f.facade.performResumeDecision } as unknown as RunActionsWorker;
    }
    const row = async (askId: string) => (await requests(askId))[0];

    it("the pause lifts after hours (far more than five minutes and five attempts): the request is still waiting, spent no attempt, and then starts the run", async () => {
      const w = await park();
      await answer(w, "keep");
      const f = fakes({ deny: "model_budget_exceeded" });
      const worker = stepsWorker(f);
      const actionId = (await row(w.askId)).id as string;
      for (let cycle = 0; cycle < 8; cycle++) {
        const settled = await runActionSteps(worker, actionId);
        expect(settled, `cycle ${cycle}`).toMatchObject({ state: "accepted" });
        const r = await row(w.askId);
        expect(r).toMatchObject({ state: "accepted", attempts: 0 });
        // due about fifteen minutes from now, not at once
        expect(new Date(r.not_before).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
        expect(await runActionSteps(worker, actionId), "a claim before it is due takes nothing").toBeNull();
        // fifteen minutes pass
        await admin.query("UPDATE run_action_requests SET created_at = created_at - interval '15 minutes', not_before = now() - interval '1 second' WHERE id = $1", [actionId]);
      }
      f.state.deny = null;
      expect(await runActionSteps(worker, actionId)).toMatchObject({ state: "done" });
      expect(await row(w.askId)).toMatchObject({ state: "done" });
      expect(f.follows).toHaveLength(1);
      expect(f.starts.at(-1)!.step).toBe(`${resumeStepKey(w.askId)}:s8`);
      expect(await refusalFact(w.itemId)).toEqual([]);
    });

    it("a sandbox being reaped is a short deferral that spends no attempt either", async () => {
      const w = await park();
      await answer(w, "keep");
      const f = fakes({ startReason: "start_sandbox_reaping" });
      const worker = stepsWorker(f);
      const actionId = (await row(w.askId)).id as string;
      for (let cycle = 0; cycle < 7; cycle++) {
        expect(await runActionSteps(worker, actionId)).toMatchObject({ state: "accepted" });
        expect(await row(w.askId)).toMatchObject({ state: "accepted", attempts: 0 });
        await admin.query("UPDATE run_action_requests SET not_before = now() - interval '1 second' WHERE id = $1", [actionId]);
      }
    });

    it("a request that has waited more than 14 days is refused with resume_pause_expired, and the item says so", async () => {
      const w = await park();
      await answer(w, "keep");
      const f = fakes({ deny: "model_budget_exceeded" });
      const worker = stepsWorker(f);
      const actionId = (await row(w.askId)).id as string;
      await admin.query("UPDATE run_action_requests SET created_at = now() - interval '14 days 2 hours' WHERE id = $1", [actionId]);
      expect(await runActionSteps(worker, actionId)).toMatchObject({ state: "refused" });
      expect(await row(w.askId)).toMatchObject({ state: "refused", error_code: "resume_pause_expired" });
      expect(await refusalFact(w.itemId)).toEqual([{ code: "resume_pause_expired", run_id: w.parkedRunId }]);
    });
  });
});
