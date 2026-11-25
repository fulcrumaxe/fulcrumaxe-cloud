import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DoneReply, MACHINE_ONBOARDING_MIN_PROTOCOL, SURVEY_DEADLINE_GRACE_MS, SURVEY_MAX_RUN_MS, SURVEY_ROLE, StopReply } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { writeRunStatusOn, type RunStatus } from "@fx/runner";
import { CLAIM_PATH, HEARTBEAT_PATH, claimRun, donePath, doneRun, heartbeatRun, toResponse, type RunnerCloudDeps } from "@fx/runner-cloud";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { createRunnerDoneFacade } from "../src/runnerDone.js";
import { createRunnerGitTicketFacade } from "../src/runnerGitTicket.js";
import { createRunnerLeaseSweeper } from "../src/runnerLeaseSweep.js";
import { requestFollowUp } from "../src/runnerFollowUp.js";
import { createSurveyStart } from "../src/surveyStart.js";
import { ORIGIN, newKey, signed, type TestKey } from "../../runner-cloud/test/helpers.js";
import { issueSurveyRun } from "./helpers/surveyRunIssuer.js";

const MIN = 60_000;
const DEADLINE_MS = SURVEY_MAX_RUN_MS + SURVEY_DEADLINE_GRACE_MS;
const DRAFT = { v: 1, prd_md: "# Plan\n\nLateAnswerMarker: a small service.\n", roadmap: [{ row_key: "A", title: "Row A", summary: "Does a thing.", size: "M", depends_on: [] }] };

/**
 * [pg] D#845 ON-10b2 (Ruling 88 items 5 and 7): how a survey run's end lands on its setup, with the real status writer, the real definers (1059), the real claim, heartbeat and done routes and the real lease sweep. The deadline runs
 * the worker's real function over a fake clock; the setup's and the run's times are set in the database, and the clock is placed relative to them.
 */
describe("survey endings and the deadline [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  const signing = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  let A: SeedRefs;
  let key: TestKey;
  let runner: string;
  let claims: ReturnType<typeof createRunnerClaimFacade>;
  let deps: RunnerCloudDeps;
  const gitTickets = createRunnerGitTicketFacade(null as never, { signer: null, audience: null });

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    claims = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => T0, randomBetween: (min) => min });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });
  beforeEach(async () => {
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [A.repoId]);
    key = newKey();
    const id = await insertRunner(admin, A.accountId, A.userId, { jwk: key.jwk, jkt: key.jkt, credentialMode: "api_key", protocolVersion: MACHINE_ONBOARDING_MIN_PROTOCOL });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [id, [A.repoId]]);
    await admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, '{survey_v1}')", [id, A.accountId]);
    runner = id;
    deps = { appUserPool: appPool, origin: ORIGIN, failRunnerLeases: null, leases: { ...claims, ...createRunnerDoneFacade(writerPool, { now: () => T0 }), ...gitTickets } };
  });

  const survey = () => issueSurveyRun(admin, appPool, { accountId: A.accountId, userId: A.userId, repoId: A.repoId, signing, createdMs: T0 - 5000, expiresMs: T0 + 72 * 3_600_000, placeOn: runner });
  const run = (fn: () => Promise<{ status: number; body: unknown }>) => toResponse(fn);
  async function claim(id: string): Promise<number> {
    const res = await run(() => claimRun(deps, signed(key, CLAIM_PATH, {})));
    const body = res.body as { run_id?: string; lease_generation?: number };
    if (res.status !== 200 || body.run_id !== id) throw new Error(`claim: ${res.status} ${JSON.stringify(res.body)}`);
    return body.lease_generation!;
  }
  const setupOf = async (id: string) => (await admin.query("SELECT phase, state, survey_run_id, survey_started_at, failure_code, failure_reason FROM project_setups WHERE id = $1", [id])).rows[0];
  const runOf = async (id: string) => (await admin.query("SELECT status, started_at, envelope FROM agent_runs WHERE id = $1", [id])).rows[0];
  const children = async (id: string) => Number((await admin.query("SELECT count(*) FROM agent_runs WHERE parent_run_id = $1", [id])).rows[0].count);
  const drafts = async (setupId: string) => Number((await admin.query("SELECT count(*) FROM project_drafts WHERE setup_id = $1", [setupId])).rows[0].count);
  /** The move through the real writer, in the person-less run-writer login's own tenant transaction, as the status funnel is called. */
  const move = (runId: string, from: RunStatus, to: RunStatus, failureReason?: string) =>
    withTenant(writerPool, A.accountId, (client) => writeRunStatusOn(client, { accountId: A.accountId, runId, from, to, ...(failureReason === undefined ? {} : { failureReason }) }));
  /** The setup's survey fields as they were set, so a time can be placed relative to them. */
  const startedAt = async (setupId: string) => (await setupOf(setupId)).survey_started_at as Date;
  const ends = (now: number) => createSurveyStart({ pool: writerPool, registry: {} as never, resolveRunSeat: async () => ({ ok: false, reason: "unknown_role" }) as never, now: () => new Date(now) });
  const look = (runId: string, setupId: string, now: number, cancel?: boolean) => ends(now).endSurveyAtDeadline({ accountId: A.accountId, setupId, runId, ...(cancel === true ? { cancel: true } : {}) });

  describe("the status hook: every row of the table, through the real writer", () => {
    const rows: Array<{ name: string; claimed: boolean; from: RunStatus; to: RunStatus; reason?: string; expect: { code: string; reason: string } | null }> = [
      { name: "pending -> failed (an admit or issuer refusal)", claimed: false, from: "pending", to: "failed", reason: "internal_error", expect: { code: "survey_failed", reason: "refused_at_admit" } },
      { name: "pending -> refused_spend", claimed: false, from: "pending", to: "refused_spend", expect: { code: "survey_failed", reason: "refused_at_admit" } },
      { name: "running -> failed, runner_lost", claimed: true, from: "running", to: "failed", reason: "runner_lost", expect: { code: "survey_failed", reason: "runner_lost" } },
      { name: "running -> failed, any other reason", claimed: true, from: "running", to: "failed", reason: "agent_failed", expect: { code: "survey_failed", reason: "run_failed" } },
      { name: "running -> failed, no reason", claimed: true, from: "running", to: "failed", expect: { code: "survey_failed", reason: "run_failed" } },
      { name: "running -> killed_spend", claimed: true, from: "running", to: "killed_spend", expect: { code: "survey_failed", reason: "run_failed" } },
      { name: "pending -> cancelled", claimed: false, from: "pending", to: "cancelled", expect: { code: "survey_failed", reason: "cancelled" } },
      { name: "running -> cancelled", claimed: true, from: "running", to: "cancelled", expect: { code: "survey_failed", reason: "cancelled" } },
      { name: "running -> timed_out", claimed: true, from: "running", to: "timed_out", reason: "wall_clock_limit", expect: { code: "survey_timeout", reason: "deadline" } },
      { name: "pending -> timed_out", claimed: false, from: "pending", to: "timed_out", reason: "wall_clock_limit", expect: { code: "survey_timeout", reason: "deadline" } },
      { name: "running -> succeeded (the done branch wrote the draft)", claimed: true, from: "running", to: "succeeded", expect: null },
      { name: "running -> failed, survey_output_invalid (the done branch already called survey_fail)", claimed: true, from: "running", to: "failed", reason: "survey_output_invalid", expect: null },
    ];
    for (const r of rows) {
      it(`${r.name}: ${r.expect === null ? "the setup is left alone" : `${r.expect.code} / ${r.expect.reason}`}, with no draft and no envelope text`, async () => {
        const { runId, setupId } = await survey();
        if (r.claimed) await claim(runId);
        expect(await move(runId, r.from, r.to, r.reason)).toEqual({ updated: true });
        expect((await runOf(runId)).status).toBe(r.to);
        expect(await setupOf(setupId)).toMatchObject(r.expect === null ? { state: "started", failure_code: null, failure_reason: null, survey_run_id: runId } : { phase: "survey", state: "failed", failure_code: r.expect.code, failure_reason: r.expect.reason, survey_run_id: runId });
        expect(await drafts(setupId)).toBe(0);
        expect((await runOf(runId)).envelope).toBeNull();
      });
    }

    it("a repeat of the same ending is a no-op on the setup, and an ending of an older run does not touch a setup that moved on to a newer one", async () => {
      const { runId, setupId } = await survey();
      await move(runId, "pending", "cancelled");
      const first = await setupOf(setupId);
      await withTenant(writerPool, A.accountId, (client) => client.query("SELECT survey_fail($1::uuid, 'survey_timeout', 'deadline')", [runId]));
      expect(await setupOf(setupId)).toEqual(first);
    });

    it("the status move stands when survey_fail is refused by the database (the login loses EXECUTE for the test), and the savepoint leaves the transaction usable: the status event and a later write in it still commit", async () => {
      // An inactive account would refuse the status move itself, so the refusal comes from the grant: a real 42501 from the real function, restored right after.
      const { runId, setupId } = await survey();
      await admin.query("REVOKE EXECUTE ON FUNCTION survey_fail(uuid, text, text) FROM agent_run_writer");
      try {
        const written = await withTenant(writerPool, A.accountId, async (client) => {
          const moved = await writeRunStatusOn(client, { accountId: A.accountId, runId, from: "pending", to: "cancelled" });
          await client.query("SELECT 1");
          return moved;
        });
        expect(written).toEqual({ updated: true });
      } finally {
        await admin.query("GRANT EXECUTE ON FUNCTION survey_fail(uuid, text, text) TO agent_run_writer");
      }
      expect((await runOf(runId)).status).toBe("cancelled");
      expect((await admin.query("SELECT count(*) FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed'", [runId])).rows[0].count).toBe("1");
      expect(await setupOf(setupId)).toMatchObject({ state: "started", failure_code: null });
    });

    it("a run of another role is not touched by the hook", async () => {
      const { runId, setupId } = await survey();
      const other = randomUUID();
      await admin.query("INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id) VALUES ($1, $2, 'executor', 'runner', 'pending', 'runner_local', $3)", [other, A.accountId, A.repoId]);
      expect(await move(other, "pending", "cancelled")).toEqual({ updated: true });
      expect(await setupOf(setupId)).toMatchObject({ state: "started", survey_run_id: runId });
    });
  });

  describe("no follow-up run for a survey", () => {
    it("requestFollowUp answers not_eligible for a failed survey run that ended runner_lost, and makes no child", async () => {
      const { runId } = await survey();
      await claim(runId);
      await move(runId, "running", "failed", "runner_lost");
      const outcome = await withTenant(writerPool, A.accountId, (client) => requestFollowUp(client, runId));
      expect(outcome).toEqual({ kind: "not_eligible" });
      expect(await children(runId)).toBe(0);
    });

    it("a lost survey run (its lease ends, found by the sweeper) makes no child run, and its setup is survey_failed / runner_lost", async () => {
      const { runId, setupId } = await survey();
      await claim(runId);
      const lease = (await admin.query("SELECT lease_expires_at FROM agent_runs WHERE id = $1", [runId])).rows[0].lease_expires_at as Date;
      const swept = await createRunnerLeaseSweeper(writerPool, { now: () => lease.getTime() + 1 }).sweepRunnerLeases();
      expect(swept.lost).toBeGreaterThanOrEqual(1);
      expect((await runOf(runId)).status).toBe("failed");
      expect(await children(runId)).toBe(0);
      expect(await setupOf(setupId)).toMatchObject({ state: "failed", failure_code: "survey_failed", failure_reason: "runner_lost" });
    });

    it("a usage-limit end through ingest makes no child run, and its setup is survey_failed / run_failed", async () => {
      const { runId, setupId } = await survey();
      const g = await claim(runId);
      const out = await claims.ingestRunnerEvents({ accountId: A.accountId, runnerId: runner, runId, leaseGeneration: g, events: [{ seq: 0, ts: "2026-10-10T12:00:00.000Z", type: "usage_limit_reached", reset_at: "2026-10-10T17:00:00.000Z" }] as never });
      expect(out).toMatchObject({ outcome: "accepted", ended: "usage_limit" });
      expect((await runOf(runId)).status).toBe("failed");
      expect(await children(runId)).toBe(0);
      expect(await setupOf(setupId)).toMatchObject({ state: "failed", failure_code: "survey_failed", failure_reason: "run_failed" });
    });
  });

  describe("the deadline", () => {
    it("a pending run is left until 22 minutes after the survey started (the answer says when to look next), then ended timed_out with survey_timeout / deadline", async () => {
      const { runId, setupId } = await survey();
      const s = (await startedAt(setupId)).getTime();
      expect(await look(runId, setupId, s + MIN)).toEqual({ final: false, wakeAt: new Date(s + DEADLINE_MS).toISOString() });
      expect(await look(runId, setupId, s + DEADLINE_MS - 1)).toEqual({ final: false, wakeAt: new Date(s + DEADLINE_MS).toISOString() });
      expect((await runOf(runId)).status).toBe("pending");
      expect(await look(runId, setupId, s + DEADLINE_MS)).toEqual({ final: true });
      expect((await runOf(runId)).status).toBe("timed_out");
      expect(await setupOf(setupId)).toMatchObject({ state: "failed", failure_code: "survey_timeout", failure_reason: "deadline" });
      const events = (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' ORDER BY seq", [runId])).rows.map((r) => r.payload);
      expect(events.at(-1)).toEqual({ from: "pending", to: "timed_out", failureReason: "wall_clock_limit" });
      // A look after the end is final and writes nothing.
      expect(await look(runId, setupId, s + 2 * DEADLINE_MS)).toEqual({ final: true });
    });

    it("a run whose placement moved is never claimed (the pin), and the deadline still ends it, counted from the survey's start", async () => {
      const { runId, setupId } = await survey();
      const other = await insertRunner(admin, A.accountId, A.userId, { credentialMode: "api_key", protocolVersion: MACHINE_ONBOARDING_MIN_PROTOCOL });
      await admin.query("DELETE FROM project_placements WHERE account_id = $1 AND repo_id = $2", [A.accountId, A.repoId]);
      await admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')", [A.repoId, A.accountId, other]);
      expect(await claims.claimRunnerRun({ accountId: A.accountId, runnerId: runner })).toMatchObject({ kind: "idle" });
      expect((await runOf(runId)).status).toBe("pending");
      const s = (await startedAt(setupId)).getTime();
      expect(await look(runId, setupId, s + DEADLINE_MS - 1)).toMatchObject({ final: false });
      expect(await look(runId, setupId, s + DEADLINE_MS)).toEqual({ final: true });
      expect((await runOf(runId)).status).toBe("timed_out");
      expect(await setupOf(setupId)).toMatchObject({ state: "failed", failure_code: "survey_timeout", failure_reason: "deadline" });
    });

    it("a running run with a late claim gets its full 20 minutes plus the grace, counted from its start and not from the survey's", async () => {
      const { runId, setupId } = await survey();
      await claim(runId);
      const s = (await startedAt(setupId)).getTime();
      // The claim came 15 minutes after the survey started.
      const claimedAt = s + 15 * MIN;
      // The start stamp is for live sessions, not fixtures (the lease sweep's test sets it the same way).
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query("UPDATE agent_runs SET started_at = $2 WHERE id = $1", [runId, new Date(claimedAt)]);
      } finally {
        await admin.query("SET session_replication_role = DEFAULT");
      }
      expect(await look(runId, setupId, s + DEADLINE_MS + MIN)).toEqual({ final: false, wakeAt: new Date(claimedAt + DEADLINE_MS).toISOString() });
      expect((await runOf(runId)).status).toBe("running");
      expect(await look(runId, setupId, claimedAt + DEADLINE_MS - 1)).toMatchObject({ final: false });
      expect(await look(runId, setupId, claimedAt + DEADLINE_MS)).toEqual({ final: true });
      expect((await runOf(runId)).status).toBe("timed_out");
      expect(await setupOf(setupId)).toMatchObject({ state: "failed", failure_code: "survey_timeout", failure_reason: "deadline" });
    });

    it("a run that ended by a move that bypasses the writer (a mode change cancels it in the database) is closed out as survey_failed / cancelled", async () => {
      const { runId, setupId } = await survey();
      await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [runId]);
      expect(await setupOf(setupId)).toMatchObject({ state: "started" });
      expect(await look(runId, setupId, Date.now())).toEqual({ final: true });
      expect(await setupOf(setupId)).toMatchObject({ state: "failed", failure_code: "survey_failed", failure_reason: "cancelled" });
    });

    it("a setup that moved on (or never waited for this run) is final, with nothing written", async () => {
      const { runId, setupId } = await survey();
      await admin.query("UPDATE project_setups SET phase = 'plan', state = 'ok' WHERE id = $1", [setupId]);
      const before = await setupOf(setupId);
      const s = (await startedAt(setupId)).getTime();
      expect(await look(runId, setupId, s + 10 * DEADLINE_MS)).toEqual({ final: true });
      expect((await runOf(runId)).status).toBe("pending");
      expect(await setupOf(setupId)).toEqual(before);
      // Another run's id is not this setup's run either.
      expect(await look(randomUUID(), setupId, s)).toEqual({ final: true });
    });

    it("another account's setup is final and untouched (the account is named in every query, on top of row security)", async () => {
      const { runId, setupId } = await survey();
      const B = await seedAccount(admin, randomUUID());
      const s = (await startedAt(setupId)).getTime();
      expect(await ends(s + 10 * DEADLINE_MS).endSurveyAtDeadline({ accountId: B.accountId, setupId, runId })).toEqual({ final: true });
      expect((await runOf(runId)).status).toBe("pending");
      expect(await setupOf(setupId)).toMatchObject({ state: "started" });
    });

    it("the start's own failure path (cancel) ends a pending run now, as cancelled, whatever its deadline", async () => {
      const { runId, setupId } = await survey();
      const s = (await startedAt(setupId)).getTime();
      expect(await look(runId, setupId, s, true)).toEqual({ final: true });
      expect((await runOf(runId)).status).toBe("cancelled");
      expect(await setupOf(setupId)).toMatchObject({ state: "failed", failure_code: "survey_failed", failure_reason: "cancelled" });
    });

    it("the heartbeat after the deadline gets continue:false", async () => {
      const { runId, setupId } = await survey();
      const g = await claim(runId);
      const live = await run(() => heartbeatRun(deps, signed(key, HEARTBEAT_PATH, { run_id: runId, lease_generation: g })));
      expect(live.status).toBe(200);
      const s = (await startedAt(setupId)).getTime();
      const startedMs = ((await runOf(runId)).started_at as Date).getTime();
      await look(runId, setupId, Math.max(s, startedMs) + DEADLINE_MS);
      expect((await runOf(runId)).status).toBe("timed_out");
      const late = await run(() => heartbeatRun(deps, signed(key, HEARTBEAT_PATH, { run_id: runId, lease_generation: g })));
      expect(StopReply.parse(late.body)).toMatchObject({ continue: false });
    });

    it("a done after the deadline gets continue:false, stores nothing, and is never a 5xx", async () => {
      const { runId, setupId } = await survey();
      const g = await claim(runId);
      const startedMs = ((await runOf(runId)).started_at as Date).getTime();
      await look(runId, setupId, Math.max((await startedAt(setupId)).getTime(), startedMs) + DEADLINE_MS);
      const res = await run(() => doneRun(deps, signed(key, donePath(runId), { run_id: runId, lease_generation: g, agentOutput: DRAFT }), runId));
      expect(res.status).toBeLessThan(500);
      expect((DoneReply.safeParse(res.body).success ? DoneReply.parse(res.body) : StopReply.parse(res.body)).continue).toBe(false);
      expect(await drafts(setupId)).toBe(0);
      expect(JSON.stringify([(await runOf(runId)).envelope, (await admin.query("SELECT payload FROM run_events WHERE run_id = $1", [runId])).rows])).not.toContain("LateAnswerMarker");
      expect(await setupOf(setupId)).toMatchObject({ phase: "survey", state: "failed", failure_code: "survey_timeout", failure_reason: "deadline" });
    });

    // The page code that renders the row (surveyDetail in the onboarding app) is in an app, which a package test must not import; its mapping from exactly these shapes is pinned in apps/workspace/test/onboarding-engine.test.mjs.
    it("the row the page reads is exactly {phase, state, survey_run_id, failure_code, failure_reason}: after a start, after a real failure and after the real deadline", async () => {
      const shape = async (id: string) => (await admin.query("SELECT phase, state, survey_run_id, failure_code, failure_reason FROM project_setups WHERE id = $1", [id])).rows[0];
      const a = await survey();
      expect(await shape(a.setupId)).toEqual({ phase: "survey", state: "started", survey_run_id: a.runId, failure_code: null, failure_reason: null });
      await move(a.runId, "pending", "failed", "internal_error");
      expect(await shape(a.setupId)).toEqual({ phase: "survey", state: "failed", survey_run_id: a.runId, failure_code: "survey_failed", failure_reason: "refused_at_admit" });
      await admin.query("UPDATE project_setups SET phase = 'done' WHERE id = $1", [a.setupId]);
      const b = await survey();
      await look(b.runId, b.setupId, (await startedAt(b.setupId)).getTime() + DEADLINE_MS);
      expect(await shape(b.setupId)).toEqual({ phase: "survey", state: "failed", survey_run_id: b.runId, failure_code: "survey_timeout", failure_reason: "deadline" });
    });

    it("the survey role is the one the status hook and the deadline look at (a sanity check of the constants)", () => {
      expect(SURVEY_ROLE).toBe("project-surveyor");
      expect(DEADLINE_MS).toBe(22 * MIN);
    });
  });
});
