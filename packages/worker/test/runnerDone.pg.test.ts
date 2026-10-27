import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CHECK_NOT_RUN_REASONS, DoneReply, DoneRetryReply, NOT_RECORDED_MEASURE, type Check, type DoneCheck, RUNNER_ELIGIBLE_ROLES, StopReply, sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { RUNNER_DISPATCH_BASE_KIND, readRecordedRunnerBranch, recordContextLedger } from "@fx/runner";
import { withTenant } from "@fx/db/src/withTenant.js";
import { CLAIM_PATH, DISPATCH_BASE_KIND, claimRun, createRunPullRequestPort, donePath, doneRun, eventsPath, heartbeatRun, HEARTBEAT_PATH, ingestEvents, toResponse, type RunnerCloudDeps } from "@fx/runner-cloud";
import { RunActionInputError } from "../src/index.js";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { createRunnerGitTicketFacade } from "../src/runnerGitTicket.js";
import { DONE_FAILURE_REASONS, DROPPED_AGENT_OUTPUT, createRunnerDoneFacade, type RunnerDoneFacade, type RunnerDoneVerdict } from "../src/runnerDone.js";
import { FAKE_APP_LOGIN, FakeGithub } from "../../runner-cloud/test/helpers/githubFake.js";
import { ORIGIN, newKey, signed, type TestKey } from "../../runner-cloud/test/helpers.js";

/**
 * [pg] D#6 R2b-3f: the `done` half of the lease facade against the real definers (0754), the real compare-and-set writer and a real
 * run-writer login; then the whole claim -> events -> done run through the real routes, the real facades and the real GitHub port over a
 * strict fake, which is the fixture that replaces #63's listed sequence.
 */
describe("runner done [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  const signing = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  let clock = T0;
  let A: SeedRefs;
  let runner: string;
  let facade: RunnerDoneFacade;
  let claims: ReturnType<typeof createRunnerClaimFacade>;
  // The ticket methods are part of the lease ops; this suite never calls them (gitTicket.pg.test.ts does).
  const gitTickets = createRunnerGitTicketFacade(null as never, { signer: null, audience: null });

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    facade = createRunnerDoneFacade(writerPool, { now: () => clock });
    claims = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => clock, randomBetween: (min) => min });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });
  beforeEach(async () => {
    clock = T0;
    // The claim looks at every account's queue through its own tenant only, but other files leave running runner runs behind.
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [A.repoId]);
    await admin.query("UPDATE work_items SET title = 'Add the footer' WHERE id = $1", [A.workItemId]);
    runner = await newRunner();
  });

  async function newRunner(key?: TestKey): Promise<string> {
    const id = await insertRunner(admin, A.accountId, A.userId, key ? { jwk: key.jwk, jkt: key.jkt, credentialMode: "api_key" } : { credentialMode: "api_key" });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [id, [A.repoId]]);
    // D#483 S4-b2c: as its hello would say, so every eligible role (the capability-gated claim verifier included) can be claimed here.
    await admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, '{proposal_verifier}')", [id, A.accountId]);
    return id;
  }

  async function spec(files: unknown): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO spec_versions (id, account_id, work_item_id, version, body, body_sha256, frontmatter, created_by_kind)
       VALUES ($1, $2, $3, (SELECT COALESCE(max(version), 0) + 1 FROM spec_versions WHERE work_item_id = $3), 'spec', $4, $5::jsonb, 'system')`,
      [id, A.accountId, A.workItemId, sha256Text("spec"), JSON.stringify({ acceptance_files: files })],
    );
    return id;
  }

  /** A pending runner run with a real signed job, ready to be claimed. */
  async function pending(o: { role?: string; specVersion?: string | null; continues?: { branch: string; prNumber?: number; baseSha?: string }; check?: Check } = {}): Promise<string> {
    const id = randomUUID();
    const job: Job = {
      schema_version: 1,
      job_id: randomUUID(),
      run_id: id,
      repo: { id: A.repoId, owner: "acme", name: "widgets", private: true },
      role: (o.role ?? "executor") as Job["role"],
      mode: "local",
      spec: null,
      task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") },
      role_card: { text: "c", sha256: sha256Text("c") },
      role_tools_sha256: "a".repeat(64),
      continues: o.continues ? { parent_run_id: randomUUID(), ...(o.continues.prNumber === undefined ? { session_id: "sess-1" } : { session_id: null, pr_number: o.continues.prNumber }), branch: o.continues.branch, ...(o.continues.baseSha === undefined ? {} : { base_sha: o.continues.baseSha }) } : null,
      branch_prefix: "fx/",
      model_hint: null,
      issued_at: new Date(T0 - 1000).toISOString(),
      expires_at: new Date(T0 + 72 * 3_600_000).toISOString(),
      key_id: "k1",
      ...(o.check ? { check: o.check } : {}),
    };
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, initiated_by, spec_version_id, created_at)
       VALUES ($1, $2, $3, $4, 'runner', 'pending', 'runner_local', $5, $6::jsonb, $7, $8, to_timestamp($9 / 1000.0))`,
      [id, A.accountId, A.workItemId, job.role, A.repoId, JSON.stringify(signJob(job, signing)), A.userId, o.specVersion ?? null, T0 - 5000],
    );
    return id;
  }
  const claimed = async (id: string, runnerId = runner): Promise<number> => {
    const r = await claims.claimRunnerRun({ accountId: A.accountId, runnerId });
    if (r.kind !== "claimed" || r.runId !== id) throw new Error("not claimed");
    return r.leaseGeneration;
  };
  const lease = (runId: string, leaseGeneration: number, runnerId = runner) => ({ accountId: A.accountId, runnerId, runId, leaseGeneration });
  const row = async (id: string) => (await admin.query("SELECT status, runner_id, lease_generation, lease_expires_at, cc_session_id, envelope, usd, tokens_in FROM agent_runs WHERE id = $1", [id])).rows[0];
  const statusEvents = async (id: string) => (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' ORDER BY seq", [id])).rows.map((r) => r.payload as Record<string, unknown>);
  const ok: RunnerDoneVerdict = { outcome: "succeeded", failureReason: null, prNumber: 5 };
  const nothingWritten = async (id: string, status = "running") => {
    const r = await row(id);
    expect(r.status).toBe(status);
    expect(r.cc_session_id).toBeNull();
    expect(r.envelope).toBeNull();
    expect((await statusEvents(id)).filter((p) => p.viaRunnerDone === true)).toEqual([]);
  };

  describe("begin", () => {
    it("proceeds for the runner that holds the run, renews the lease like a heartbeat, and changes nothing else", async () => {
      const id = await pending();
      const g = await claimed(id);
      clock = T0 + 30_000;
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "proceed" });
      expect((await row(id)).lease_expires_at.getTime()).toBe(T0 + 30_000 + 90_000);
      expect((await row(id)).status).toBe("running");
      expect(await statusEvents(id)).toEqual([{ from: "pending", to: "running" }]);
    });

    it("is fenced: a stale generation, another runner's, an unknown run, an expired lease and a run past its wall clock are each told why, and nothing moves", async () => {
      const id = await pending();
      const g = await claimed(id);
      const before = (await row(id)).lease_expires_at;
      expect(await facade.beginRunnerDone(lease(id, g + 1))).toEqual({ kind: "fenced", reason: "stale_generation" });
      expect(await facade.beginRunnerDone(lease(id, g, await newRunner()))).toEqual({ kind: "fenced", reason: "stale_generation" });
      expect(await facade.beginRunnerDone(lease(randomUUID(), g))).toEqual({ kind: "fenced", reason: "stale_generation" });
      clock = T0 + 90_000;
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "fenced", reason: "lease_expired" });
      expect((await row(id)).lease_expires_at).toEqual(before);
      clock = T0;
      const started = (await admin.query("SELECT started_at FROM agent_runs WHERE id = $1", [id])).rows[0].started_at.getTime() as number;
      await admin.query("UPDATE agent_runs SET lease_expires_at = to_timestamp($2 / 1000.0) WHERE id = $1", [id, started + 3 * 3_600_000]);
      clock = started + 7_200_001;
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "fenced", reason: "wall_clock_limit" });
      expect((await row(id)).status).toBe("running");
    });

    it("a run that finished some other way is a stop, never a replay: cancelled, failed by the sweeper's reason, or ended by a usage limit", async () => {
      for (const [status, failureReason] of [["cancelled", null], ["failed", "runner_lost"], ["failed", "usage_limit"], ["failed", "internal_error"], ["failed", "no_commit"], ["succeeded", null], ["timed_out", null]] as const) {
        const id = await pending();
        const g = await claimed(id);
        await admin.query("UPDATE agent_runs SET status = $2 WHERE id = $1", [id, status]);
        await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 99, 'run.status_changed', $3::jsonb)", [A.accountId, id, JSON.stringify({ from: "running", to: status, ...(failureReason ? { failureReason } : {}) })]);
        expect(await facade.beginRunnerDone(lease(id, g)), `${status} ${failureReason}`).toEqual({ kind: "fenced", reason: "run_terminal" });
        await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [id]);
        clock = T0;
      }
    });
  });

  describe("finish", () => {
    it("records a success under the fence: status, the pull request number on the status event, the session id and the redacted envelope, usd still NULL", async () => {
      const id = await pending();
      const g = await claimed(id);
      const token = `ghp_${"A1b2".repeat(9)}`;
      const result = await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, sessionId: "7f0c1d2e-aaaa-bbbb", agentOutput: { verdict: "pass", note: `token ${token} leaked`, nested: { items: [1, 2] } } });
      expect(result).toEqual({ kind: "recorded", verdict: ok });
      const r = await row(id);
      expect(r).toMatchObject({ status: "succeeded", cc_session_id: "7f0c1d2e-aaaa-bbbb", usd: null, tokens_in: null });
      expect(JSON.stringify(r.envelope)).not.toContain(token);
      expect(r.envelope).toMatchObject({ verdict: "pass", nested: { items: [1, 2] } });
      expect(await statusEvents(id)).toEqual([{ from: "pending", to: "running" }, { from: "running", to: "succeeded", viaRunnerDone: true, prNumber: 5 }]);
    });

    it("a fix round's done that arrives while its item sits in Needs a person is recorded as any other, and the item stays where it is (FIXROUND-REPUBLISH R2-c0)", async () => {
      // A signed-base continuation of a run branch: the round the cloud started before the item was handed to a person.
      const id = await pending({ continues: { branch: `fx/${randomUUID()}-g1`, baseSha: "b".repeat(40) } });
      const g = await claimed(id);
      await admin.query("UPDATE work_items SET stage = 'needs_human' WHERE id = $1", [A.workItemId]);
      await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'escalated', 'republish_base_missing', 'k')", [A.accountId, A.workItemId]);
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "proceed" });
      expect(await facade.finishRunnerDone({ ...lease(id, g), verdict: ok })).toEqual({ kind: "recorded", verdict: ok });
      expect((await row(id)).status).toBe("succeeded");
      expect((await admin.query("SELECT stage FROM work_items WHERE id = $1", [A.workItemId])).rows[0].stage).toBe("needs_human");
      // A replay gives the stored verdict back, as for every run.
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "replay", verdict: ok });
    });

    it("records the run branch next to the pull request number, and a replay gives it back (C25 section 1.2)", async () => {
      const id = await pending();
      const g = await claimed(id);
      const branch = `fx/${id}-g${g}`;
      const verdict: RunnerDoneVerdict = { outcome: "succeeded", failureReason: null, prNumber: 5, branch };
      expect(await facade.finishRunnerDone({ ...lease(id, g), verdict })).toEqual({ kind: "recorded", verdict });
      expect((await statusEvents(id)).at(-1)).toEqual({ from: "running", to: "succeeded", viaRunnerDone: true, prNumber: 5, branch });
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "replay", verdict });
      // The same reading the job issuer uses for a fix round.
      expect(await withTenant(writerPool, A.accountId, (c) => readRecordedRunnerBranch(c, { accountId: A.accountId, runId: id }))).toBe(branch);
    });

    it("records the head the cloud read for the branch (D#598 P1f-5c) on the same event, and a replay gives it back; a verdict without one records none", async () => {
      const id = await pending();
      const g = await claimed(id);
      const branch = `fx/${id}-g${g}`;
      const verdict: RunnerDoneVerdict = { outcome: "succeeded", failureReason: null, prNumber: 5, branch, headOid: "e".repeat(40) };
      expect(await facade.finishRunnerDone({ ...lease(id, g), verdict })).toEqual({ kind: "recorded", verdict });
      expect((await statusEvents(id)).at(-1)).toEqual({ from: "running", to: "succeeded", viaRunnerDone: true, prNumber: 5, branch, headOid: "e".repeat(40) });
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "replay", verdict });
      const plain = await pending();
      const g2 = await claimed(plain);
      await facade.finishRunnerDone({ ...lease(plain, g2), verdict: { outcome: "succeeded", failureReason: null, prNumber: 6, branch: `fx/${plain}-g${g2}` } });
      expect((await statusEvents(plain)).at(-1)).not.toHaveProperty("headOid");
    });

    it("a failed verdict with a pull request records its branch too; one without a pull request records none", async () => {
      const id = await pending();
      const g = await claimed(id);
      const branch = `fx/${id}-g${g}`;
      await facade.finishRunnerDone({ ...lease(id, g), verdict: { outcome: "failed", failureReason: "scope_violation", prNumber: 4, branch } });
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "replay", verdict: { outcome: "failed", failureReason: "scope_violation", prNumber: 4, branch } });
      const none = await pending();
      const g2 = await claimed(none);
      await facade.finishRunnerDone({ ...lease(none, g2), verdict: { outcome: "failed", failureReason: "no_commit", prNumber: null } });
      expect(await withTenant(writerPool, A.accountId, (c) => readRecordedRunnerBranch(c, { accountId: A.accountId, runId: none }))).toBeNull();
    });

    it("records every failure reason with its pull request number, HTTP status and detail", async () => {
      const cases: RunnerDoneVerdict[] = [
        { outcome: "failed", failureReason: "no_commit", prNumber: null },
        { outcome: "failed", failureReason: "scope_unknown", prNumber: null },
        { outcome: "failed", failureReason: "scope_unknown", prNumber: 3, detail: "renamed" },
        { outcome: "failed", failureReason: "scope_unknown", prNumber: 3, detail: "unknown_change_type" },
        { outcome: "failed", failureReason: "scope_unknown", prNumber: null, detail: "no_file_list" },
        { outcome: "failed", failureReason: "scope_violation", prNumber: 4 },
        { outcome: "failed", failureReason: "pr_rejected", prNumber: null, prHttpStatus: 422 },
        { outcome: "failed", failureReason: "pr_rejected", prNumber: null },
        { outcome: "failed", failureReason: "internal_error", prNumber: 9 },
        { outcome: "failed", failureReason: "taken_over", prNumber: null },
        { outcome: "failed", failureReason: "check_failed", prNumber: null },
      ];
      expect(new Set(cases.map((c) => c.failureReason))).toEqual(new Set(DONE_FAILURE_REASONS));
      for (const verdict of cases) {
        const id = await pending();
        const g = await claimed(id);
        expect(await facade.finishRunnerDone({ ...lease(id, g), verdict })).toEqual({ kind: "recorded", verdict });
        expect((await row(id)).status).toBe("failed");
        const event = (await statusEvents(id)).at(-1)!;
        expect(event).toMatchObject({ from: "running", to: "failed", failureReason: verdict.failureReason, viaRunnerDone: true, prNumber: verdict.prNumber });
        // A replay gives back exactly what was recorded.
        expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "replay", verdict });
        clock = T0;
      }
    });

    it("stores a session id and envelope on a failed run too (the fix round resumes from it)", async () => {
      const id = await pending();
      const g = await claimed(id);
      await facade.finishRunnerDone({ ...lease(id, g), verdict: { outcome: "failed", failureReason: "no_commit", prNumber: null }, sessionId: "sess-9", agentOutput: { verdict: "fail" } });
      expect(await row(id)).toMatchObject({ status: "failed", cc_session_id: "sess-9", envelope: { verdict: "fail" } });
    });

    it("a taken-over run is recorded failed taken_over with the session id and NO envelope, even when the runner sent one (D#6 R4a-7)", async () => {
      const id = await pending();
      const g = await claimed(id);
      const result = await facade.finishRunnerDone({ ...lease(id, g), verdict: { outcome: "failed", failureReason: "taken_over", prNumber: null }, sessionId: "sess-9", agentOutput: { verdict: "pass" } });
      expect(result).toMatchObject({ kind: "recorded", verdict: { outcome: "failed", failureReason: "taken_over" } });
      const r = await row(id);
      expect(r).toMatchObject({ status: "failed", cc_session_id: "sess-9" });
      expect(r.envelope).toBeNull();
    });

    it("drops an envelope that is still over the byte cap once redacted, instead of storing it", async () => {
      const id = await pending();
      const g = await claimed(id);
      await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, agentOutput: { big: "€".repeat(90_000) } });
      expect((await row(id)).envelope).toEqual(DROPPED_AGENT_OUTPUT);
    });

    // D#600 CX-1b: the run's context ledger is written in the done transaction by `run_context_ledger_record` on the run-writer login.
    describe("context ledger", () => {
      const ledgerRows = async (id: string) => (await admin.query("SELECT * FROM run_context_ledger WHERE account_id = $1 AND run_id = $2", [A.accountId, id])).rows;
      const body = {
        basis: "measured" as const,
        sections: [{ code: "spec" as const, bytes: 12, sha256: "c".repeat(64), trimmed_bytes: 0 }],
        first_turn_input: 100,
        peak_context: 400,
        cache_read: 900,
        cache_write: 50,
        tool_output_bytes: { Read: 7 },
        compactions: 1,
      };

      it("stores the runner's ledger with the verdict, as measured", async () => {
        const id = await pending();
        const g = await claimed(id);
        expect(await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, contextLedger: body })).toEqual({ kind: "recorded", verdict: ok });
        const rows = await ledgerRows(id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ basis: "measured", first_turn_input_tokens: "100", peak_context_tokens: "400", cache_read_tokens: "900", cache_write_tokens: "50", compactions: 1, tool_output_bytes: { Read: 7 }, sections: body.sections });
      });

      it("an older runner that sent no ledger gets a partial row with nothing measured: null figures, never zeros", async () => {
        const id = await pending();
        const g = await claimed(id);
        await facade.finishRunnerDone({ ...lease(id, g), verdict: ok });
        const rows = await ledgerRows(id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ basis: "partial", first_turn_input_tokens: null, peak_context_tokens: null, cache_read_tokens: null, cache_write_tokens: null, memory_tokens: null, compactions: 0, tool_output_bytes: {}, sections: [] });
      });

      it("a taken-over run records a partial row even if a ledger was sent", async () => {
        const id = await pending();
        const g = await claimed(id);
        await facade.finishRunnerDone({ ...lease(id, g), verdict: { outcome: "failed", failureReason: "taken_over", prNumber: null }, contextLedger: body });
        expect((await ledgerRows(id))[0]).toMatchObject({ basis: "partial", peak_context_tokens: null });
      });

      it("a ledger the definer refuses (past the schema) writes no row and does not cost the verdict", async () => {
        const id = await pending();
        const g = await claimed(id);
        const lines: string[] = [];
        const warn = console.warn;
        console.warn = (line: unknown) => void lines.push(String(line));
        try {
          const refused = { ...body, sections: [{ code: "not_a_section", bytes: 1, sha256: "c".repeat(64), trimmed_bytes: 0 }] } as never;
          expect(await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, contextLedger: refused })).toEqual({ kind: "recorded", verdict: ok });
        } finally {
          console.warn = warn;
        }
        expect(await ledgerRows(id)).toEqual([]);
        expect((await row(id)).status).toBe("succeeded");
        expect(lines.join("\n")).toContain("runner.done.context_ledger_not_recorded");
        expect(lines.join("\n")).not.toContain("not_a_section");
      });

      // D#600 CX-2b: the dispatch already wrote the cloud's sections (a partial row, nothing measured); the done adds the runner's figures and map.
      describe("after the dispatch recorded the cloud's sections (CX-2b)", () => {
        const sec = (code: string, bytes: number, sha = "d") => ({ code: code as "spec", bytes, sha256: sha.repeat(64), trimmed_bytes: 0 });
        const cloud = [sec("boundary", 60), sec("card", 120), sec("spec", 300), sec("output", 40)];
        const dispatched = async (id: string, sections = cloud) =>
          withTenant(writerPool, A.accountId, (client) => recordContextLedger(client, { accountId: A.accountId, runId: id, sections, measure: NOT_RECORDED_MEASURE }));
        // The staging shape of 10-17: first turn 12,619 tokens.
        const staging = { ...body, sections: [sec("map", 800, "e")], first_turn_input: 12_619, peak_context: 12_900 };

        it("lists every cloud section plus the daemon's map entry, measured, with the first turn (acceptance 1 and 2)", async () => {
          const id = await pending();
          const g = await claimed(id);
          await dispatched(id);
          await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, contextLedger: staging });
          const rows = await ledgerRows(id);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ basis: "measured", first_turn_input_tokens: "12619", peak_context_tokens: "12900" });
          expect(rows[0].sections).toEqual([...cloud, sec("map", 800, "e")]);
        });

        it("an older runner that sends no ledger still gets the cloud's sections: partial, nothing measured (acceptance 3)", async () => {
          const id = await pending();
          const g = await claimed(id);
          await dispatched(id);
          await facade.finishRunnerDone({ ...lease(id, g), verdict: ok });
          const rows = await ledgerRows(id);
          expect(rows[0]).toMatchObject({ basis: "partial", first_turn_input_tokens: null, peak_context_tokens: null, cache_read_tokens: null, compactions: 0, sections: cloud });
        });

        it("a taken-over run keeps the cloud's sections and takes nothing the runner sent", async () => {
          const id = await pending();
          const g = await claimed(id);
          await dispatched(id);
          await facade.finishRunnerDone({ ...lease(id, g), verdict: { outcome: "failed", failureReason: "taken_over", prNumber: null }, contextLedger: staging });
          expect((await ledgerRows(id))[0]).toMatchObject({ basis: "partial", peak_context_tokens: null, sections: cloud });
        });

        it("the runner's figures for a code the cloud assembled are ignored, and its extra codes are not added", async () => {
          const id = await pending();
          const g = await claimed(id);
          await dispatched(id);
          await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, contextLedger: { ...body, sections: [sec("spec", 1, "f"), sec("findings", 9, "f")] } });
          expect((await ledgerRows(id))[0].sections).toEqual(cloud);
        });

        it("D#600 CX-5c2: the runner's pinned sections and reason notes are stored after the cloud's, once, and a repeat or another code adds nothing", async () => {
          const id = await pending();
          const g = await claimed(id);
          await dispatched(id);
          const pinned = [sec("pinned", 150, "1"), { ...sec("pinned", 3, "2"), trimmed_reason: "pin_missing" as const }, { ...sec("pinned", 7, "3"), trimmed_reason: "pins_over_budget" as const }];
          await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, contextLedger: { ...staging, sections: [sec("map", 800, "e"), ...pinned, sec("spec", 1, "f")] } });
          expect((await ledgerRows(id))[0].sections).toEqual([...cloud, sec("map", 800, "e"), ...pinned]);
        });

        it("a ledger the definer refuses leaves the dispatch row as it was", async () => {
          const id = await pending();
          const g = await claimed(id);
          await dispatched(id);
          const warn = console.warn;
          console.warn = () => undefined;
          try {
            const refused = { ...body, sections: [{ code: "not_a_section", bytes: 1, sha256: "c".repeat(64), trimmed_bytes: 0 }] } as never;
            expect(await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, contextLedger: refused })).toEqual({ kind: "recorded", verdict: ok });
          } finally {
            console.warn = warn;
          }
          expect((await ledgerRows(id))[0]).toMatchObject({ basis: "partial", peak_context_tokens: null, sections: cloud });
        });
      });

      it("a fenced done writes no ledger", async () => {
        const id = await pending();
        const g = await claimed(id);
        expect(await facade.finishRunnerDone({ ...lease(id, g + 1), verdict: ok, contextLedger: body })).toEqual({ kind: "fenced", reason: "stale_generation" });
        expect(await ledgerRows(id)).toEqual([]);
      });
    });

    it("is fenced inside the write transaction: a stale generation, another runner, and a lease that ended while GitHub was asked write nothing", async () => {
      const id = await pending();
      const g = await claimed(id);
      const extra = { sessionId: "sess-1", agentOutput: { a: 1 } };
      expect(await facade.finishRunnerDone({ ...lease(id, g + 1), verdict: ok, ...extra })).toEqual({ kind: "fenced", reason: "stale_generation" });
      expect(await facade.finishRunnerDone({ ...lease(id, g, await newRunner()), verdict: ok, ...extra })).toEqual({ kind: "fenced", reason: "stale_generation" });
      // begin passed, then the lease ended before finish: the second fence refuses.
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "proceed" });
      clock = T0 + 90_000;
      expect(await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, ...extra })).toEqual({ kind: "fenced", reason: "lease_expired" });
      await nothingWritten(id);
    });

    it("a lease renewed by begin lets finish through later in the same minute", async () => {
      const id = await pending();
      const g = await claimed(id);
      clock = T0 + 80_000;
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "proceed" });
      clock = T0 + 80_000 + 60_000;
      expect(await facade.finishRunnerDone({ ...lease(id, g), verdict: ok })).toMatchObject({ kind: "recorded" });
    });

    it("a run cancelled while GitHub was asked stays cancelled: finish is a stop and writes nothing", async () => {
      const id = await pending();
      const g = await claimed(id);
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "proceed" });
      await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [id]);
      expect(await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, sessionId: "s", agentOutput: { a: 1 } })).toEqual({ kind: "fenced", reason: "run_terminal" });
      await nothingWritten(id, "cancelled");
    });

    it("refuses an invalid verdict, session id or ids before any SQL", async () => {
      const id = await pending();
      const g = await claimed(id);
      const bad: Array<Partial<Parameters<RunnerDoneFacade["finishRunnerDone"]>[0]>> = [
        { verdict: { outcome: "succeeded", failureReason: "no_commit", prNumber: null } as never },
        { verdict: { outcome: "failed", failureReason: null, prNumber: null } as never },
        { verdict: { outcome: "failed", failureReason: "usage_limit", prNumber: null } as never },
        { verdict: { outcome: "failed", failureReason: "runner_lost", prNumber: null } as never },
        { verdict: { outcome: "paused", failureReason: null, prNumber: null } as never },
        { verdict: { ...ok, prNumber: 0 } },
        { verdict: { ...ok, prNumber: 1.5 } },
        // A branch must be a run branch (or, bound to this run, the item pull request branch: fx/issue-12 here has no bound event, so it is refused in the transaction) and may only accompany a pull request number.
        { verdict: { ...ok, branch: "fx/issue-12" } },
        { verdict: { ...ok, branch: "main" } },
        { verdict: { ...ok, branch: "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g0" } },
        { verdict: { outcome: "failed", failureReason: "no_commit", prNumber: null, branch: "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1" } as never },
        { verdict: { outcome: "failed", failureReason: "pr_rejected", prNumber: null, prHttpStatus: 99 } },
        { verdict: { outcome: "failed", failureReason: "no_commit", prNumber: null, detail: "renamed" } },
        // The cloud-only detail is for scope_unknown alone (D#6 R4d-5a, C34 section 2.2).
        { verdict: { outcome: "failed", failureReason: "scope_violation", prNumber: 4, detail: "no_file_list" } },
        { verdict: { outcome: "failed", failureReason: "no_commit", prNumber: null, detail: "no_file_list" } },
        // A head is a full sha, and only rides with a pull request (D#598 P1f-5c).
        { verdict: { ...ok, headOid: "main" } },
        { verdict: { ...ok, headOid: "E".repeat(40) } },
        { verdict: { outcome: "failed", failureReason: "no_commit", prNumber: null, headOid: "e".repeat(40) } as never },
        { verdict: ok, sessionId: "bad session" },
        { verdict: null as never },
        { ...lease(id, -1), verdict: ok },
      ];
      for (const patch of bad) await expect(facade.finishRunnerDone({ ...lease(id, g), verdict: ok, ...patch }), JSON.stringify(patch)).rejects.toBeInstanceOf(RunActionInputError);
      await nothingWritten(id);
    });
  });

  // D#6 R-CHK-3 (C47): the approved check's result is a row of its own (migration 0888), written in the transaction that ends the run.
  describe("the approved check (R-CHK-3)", () => {
    const checkRows = async (id: string) => (await admin.query("SELECT exit_code, duration_ms, timed_out, skipped_tests, summary FROM run_checks WHERE account_id = $1 AND run_id = $2", [A.accountId, id])).rows;
    const result = (over: Partial<DoneCheck> = {}): DoneCheck => ({ exit_code: 1, duration_ms: 2_460_000, timed_out: false, skipped_tests: 4, summary: "FAIL src/a.test.ts", ...over });
    const result0 = (over: Partial<DoneCheck>): DoneCheck => ({ exit_code: 0, duration_ms: 1000, timed_out: false, skipped_tests: null, summary: "ok", ...over });
    const failedVerdict = (branch: string): RunnerDoneVerdict => ({ outcome: "failed", failureReason: "check_failed", prNumber: null, branch });

    it("a failed check ends the run failed check_failed with its row, a log line, the run branch recorded without a pull request, and a replay gives the verdict back", async () => {
      const id = await pending();
      const g = await claimed(id);
      const verdict = failedVerdict(`fx/${id}-g${g}`);
      expect(await facade.finishRunnerDone({ ...lease(id, g), verdict, check: result() })).toEqual({ kind: "recorded", verdict });
      expect((await row(id)).status).toBe("failed");
      expect(await checkRows(id)).toEqual([{ exit_code: 1, duration_ms: "2460000", timed_out: false, skipped_tests: 4, summary: "FAIL src/a.test.ts" }]);
      expect((await statusEvents(id)).at(-1)).toEqual({ from: "running", to: "failed", failureReason: "check_failed", viaRunnerDone: true, prNumber: null, branch: verdict.branch });
      const logged = (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.check_ended'", [id])).rows.map((r) => r.payload);
      expect(logged).toEqual([{ exit_code: 1, timed_out: false, duration_ms: 2_460_000 }]);
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "replay", verdict });
      // The same reading the job issuer uses to find the branch a fix round continues.
      expect(await withTenant(writerPool, A.accountId, (c) => readRecordedRunnerBranch(c, { accountId: A.accountId, runId: id }))).toBe(verdict.branch);
      // Recorded once: a second finish is the stored verdict, with no second row.
      expect((await facade.finishRunnerDone({ ...lease(id, g), verdict, check: result({ exit_code: 2 }) })).kind).toBe("replay");
      expect(await checkRows(id)).toHaveLength(1);
    });

    it("a check killed at its cap has no exit status and says so; one that never started records exit null, 0 ms and an empty summary", async () => {
      const killed = await pending();
      const gk = await claimed(killed);
      await facade.finishRunnerDone({ ...lease(killed, gk), verdict: failedVerdict(`fx/${killed}-g${gk}`), check: result({ exit_code: null, timed_out: true, duration_ms: 5_400_000, skipped_tests: null }) });
      expect(await checkRows(killed)).toEqual([{ exit_code: null, duration_ms: "5400000", timed_out: true, skipped_tests: null, summary: "FAIL src/a.test.ts" }]);
      const never = await pending();
      const gn = await claimed(never);
      await facade.finishRunnerDone({ ...lease(never, gn), verdict: failedVerdict(`fx/${never}-g${gn}`), check: result({ exit_code: null, duration_ms: 0, skipped_tests: null, summary: "" }) });
      expect(await checkRows(never)).toEqual([{ exit_code: null, duration_ms: "0", timed_out: false, skipped_tests: null, summary: "" }]);
    });

    it("a passing check is recorded beside a success, the summary is redacted again and cut at 4096 characters", async () => {
      const id = await pending();
      const g = await claimed(id);
      const token = `ghp_${"A1b2".repeat(9)}`;
      await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, check: result({ exit_code: 0, summary: `token ${token}\n${"y".repeat(5000)}`.slice(0, 4096) }) });
      const [only] = await checkRows(id);
      expect(only!.exit_code).toBe(0);
      expect(only!.summary).not.toContain(token);
      expect(only!.summary.length).toBeLessThanOrEqual(4096);
    });

    // A result the table cannot hold must not abort the finish (the run would stay running with no fix round) and must not count as a pass: it is stored in its nearest storable form,
    // with a note in the summary, and the run ends failed check_failed whatever verdict came with it.
    it.each([
      ["a NUL in the summary", { summary: "bad\u0000output" }, "summary", { summary: "badoutput\ncheck result out of range: summary" }],
      ["a summary over the cap", { summary: "x".repeat(5000) }, "summary", {}],
      ["a killed check with an exit status", { timed_out: true, exit_code: 0 }, "exit_code", { exit_code: null, timed_out: true }],
      ["an exit status out of range", { exit_code: 2_000_000 }, "exit_code", { exit_code: 1_000_000 }],
      ["a negative duration", { duration_ms: -5 }, "duration_ms", { duration_ms: "0" }],
      ["a duration past a week", { duration_ms: 999_999_999_999 }, "duration_ms", { duration_ms: "604800000" }],
      ["a negative skipped count", { skipped_tests: -1 }, "skipped_tests", { skipped_tests: 0 }],
      ["a skipped count out of range", { skipped_tests: 999_999_999 }, "skipped_tests", { skipped_tests: 100_000_000 }],
    ] as Array<[string, Partial<DoneCheck>, string, Record<string, unknown>]>)("%s: the run ends failed check_failed with a row, even beside a success verdict", async (_name, bad, field, expectedRow) => {
      const id = await pending();
      const g = await claimed(id);
      const result = await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, check: result0(bad) });
      expect(result).toMatchObject({ kind: "recorded", verdict: { outcome: "failed", failureReason: "check_failed", prNumber: null } });
      expect((await row(id)).status).toBe("failed");
      expect((await statusEvents(id)).at(-1)).toMatchObject({ to: "failed", failureReason: "check_failed", viaRunnerDone: true });
      const rows = await checkRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.summary).toContain(`check result out of range: ${field}`);
      expect(rows[0]).toMatchObject(expectedRow);
      expect(rows[0]!.summary.length).toBeLessThanOrEqual(4096);
      expect(rows[0]!.summary).not.toContain("\u0000");
    });

    it("an out-of-range result keeps the run branch of the verdict it arrives with, so the fix round can continue from it", async () => {
      const id = await pending();
      const g = await claimed(id);
      const branch = `fx/${id}-g${g}`;
      await facade.finishRunnerDone({ ...lease(id, g), verdict: failedVerdict(branch), check: result0({ duration_ms: -1 }) });
      expect(await withTenant(writerPool, A.accountId, (c) => readRecordedRunnerBranch(c, { accountId: A.accountId, runId: id }))).toBe(branch);
    });

    it("a taken-over run records no result, whatever the runner sent", async () => {
      const id = await pending();
      const g = await claimed(id);
      await facade.finishRunnerDone({ ...lease(id, g), verdict: { outcome: "failed", failureReason: "taken_over", prNumber: null }, check: result({ exit_code: 0 }) });
      expect(await checkRows(id)).toEqual([]);
    });

    it("a run branch rides on a check_failed verdict only; any other verdict with a branch and no pull request is refused, as is an item branch with none", async () => {
      const id = await pending();
      const g = await claimed(id);
      const branch = `fx/${id}-g${g}`;
      for (const verdict of [{ outcome: "failed", failureReason: "no_commit", prNumber: null, branch }, { outcome: "failed", failureReason: "check_failed", prNumber: null, branch: "main" }] as RunnerDoneVerdict[]) {
        await expect(facade.finishRunnerDone({ ...lease(id, g), verdict }), JSON.stringify(verdict)).rejects.toBeInstanceOf(RunActionInputError);
      }
      await nothingWritten(id);
    });

    it("the table: the run's own tenant reads its rows and no other does; the runner login inserts for its tenant and can neither update, delete nor insert for another account; the database refuses an exit status on a killed check", async () => {
      const id = await pending();
      const g = await claimed(id);
      await facade.finishRunnerDone({ ...lease(id, g), verdict: failedVerdict(`fx/${id}-g${g}`), check: result() });
      const mine = await withTenant(appPool, A.accountId, (c) => c.query("SELECT 1 FROM run_checks WHERE run_id = $1", [id]));
      expect(mine.rowCount).toBe(1);
      const other = await seedAccount(admin, randomUUID());
      const theirs = await withTenant(appPool, other.accountId, (c) => c.query("SELECT 1 FROM run_checks WHERE run_id = $1", [id]));
      expect(theirs.rowCount).toBe(0);
      await expect(withTenant(appPool, A.accountId, (c) => c.query("DELETE FROM run_checks WHERE run_id = $1", [id]))).rejects.toThrow();
      await expect(withTenant(writerPool, A.accountId, (c) => c.query("UPDATE run_checks SET exit_code = 0 WHERE run_id = $1", [id]))).rejects.toThrow();
      await expect(withTenant(writerPool, A.accountId, (c) => c.query("DELETE FROM run_checks WHERE run_id = $1", [id]))).rejects.toThrow();
      await expect(withTenant(writerPool, other.accountId, (c) => c.query("INSERT INTO run_checks (account_id, run_id, exit_code, duration_ms, timed_out, summary) VALUES ($1, $2, 0, 1, false, '')", [A.accountId, id]))).rejects.toThrow();
      const second = await pending();
      await expect(admin.query("INSERT INTO run_checks (account_id, run_id, exit_code, duration_ms, timed_out, summary) VALUES ($1, $2, 1, 1, true, '')", [A.accountId, second])).rejects.toThrow();
      await expect(admin.query("INSERT INTO run_checks (account_id, run_id, exit_code, duration_ms, timed_out, summary) VALUES ($1, $2, 1, 1, false, $3)", [A.accountId, second, "z".repeat(4097)])).rejects.toThrow();
    });

    // D#6 R-CHK-3d (migration 0891): the optional reason code.
    const reasonOf = async (id: string) => (await admin.query("SELECT reason FROM run_checks WHERE account_id = $1 AND run_id = $2", [A.accountId, id])).rows[0]!.reason as string | null;

    it("a reason is stored as the closed code it is; no reason is stored as null; a word outside the set is stored as the generic code", async () => {
      for (const [sent, stored] of [["sandbox_refused", "sandbox_refused"], [undefined, null], ["a_newer_reason", "other"]] as Array<[string | undefined, string | null]>) {
        const id = await pending();
        const g = await claimed(id);
        await facade.finishRunnerDone({ ...lease(id, g), verdict: failedVerdict(`fx/${id}-g${g}`), check: result({ exit_code: null, ...(sent === undefined ? {} : { reason: sent }) }) });
        expect(await reasonOf(id), String(sent)).toBe(stored);
      }
    });

    it("every code the runner protocol lists is stored as it is (the table's list cannot drift from the protocol's)", async () => {
      for (const reason of CHECK_NOT_RUN_REASONS) {
        const id = await pending();
        const g = await claimed(id);
        await facade.finishRunnerDone({ ...lease(id, g), verdict: failedVerdict(`fx/${id}-g${g}`), check: result({ exit_code: null, reason }) });
        expect(await reasonOf(id), reason).toBe(reason);
      }
    });

    it("the table refuses a reason outside the closed set, and the runner login cannot change one", async () => {
      const id = await pending();
      const g = await claimed(id);
      await facade.finishRunnerDone({ ...lease(id, g), verdict: failedVerdict(`fx/${id}-g${g}`), check: result({ exit_code: null, reason: "pin_failed" }) });
      await expect(withTenant(writerPool, A.accountId, (c) => c.query("UPDATE run_checks SET reason = 'other' WHERE run_id = $1", [id]))).rejects.toThrow();
      const second = await pending();
      await expect(admin.query("INSERT INTO run_checks (account_id, run_id, exit_code, duration_ms, timed_out, summary, reason) VALUES ($1, $2, NULL, 1, false, '', 'click this link')", [A.accountId, second])).rejects.toThrow();
    });
  });

  describe("the item's pull request branch is recorded only for the run bound to it (D#599 PL-2b-1)", () => {
    const ITEM = "fx/issue-12";
    const bind = (runId: string, payload: Record<string, unknown>) =>
      admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, (SELECT COALESCE(max(seq), 0) + 1 FROM run_events WHERE run_id = $2), 'runner.continues_bound', $3::jsonb)", [A.accountId, runId, JSON.stringify(payload)]);
    const verdict: RunnerDoneVerdict = { outcome: "succeeded", failureReason: null, prNumber: 41, branch: ITEM };
    beforeEach(async () => {
      await admin.query("UPDATE work_items SET gh_number = 12 WHERE id = $1", [A.workItemId]);
    });

    it("records the verdict, replays it, and the recorded-branch read gives it back when the bound event, the signed job and the item's issue all agree", async () => {
      const id = await pending({ continues: { branch: ITEM, prNumber: 41 } });
      await bind(id, { pr_number: 41, branch: ITEM });
      const g = await claimed(id);
      expect(await facade.finishRunnerDone({ ...lease(id, g), verdict })).toEqual({ kind: "recorded", verdict });
      expect((await statusEvents(id)).at(-1)).toEqual({ from: "running", to: "succeeded", viaRunnerDone: true, prNumber: 41, branch: ITEM });
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "replay", verdict });
      expect(await withTenant(writerPool, A.accountId, (c) => readRecordedRunnerBranch(c, { accountId: A.accountId, runId: id }))).toBe(ITEM);
    });

    it.each([
      ["no bound event", null],
      ["a bound event for another branch", { pr_number: 41, branch: "fx/issue-8" }],
      ["a bound event for another pull request number", { pr_number: 42, branch: ITEM }],
    ])("refuses the verdict and writes nothing: %s", async (_name, event) => {
      const id = await pending({ continues: { branch: ITEM, prNumber: 41 } });
      if (event) await bind(id, event);
      const g = await claimed(id);
      await expect(facade.finishRunnerDone({ ...lease(id, g), verdict })).rejects.toBeInstanceOf(RunActionInputError);
      await nothingWritten(id);
    });

    it("refuses it when the signed job names a different branch than the verdict, even with a matching event", async () => {
      const id = await pending();
      await bind(id, { pr_number: 41, branch: ITEM });
      const g = await claimed(id);
      await expect(facade.finishRunnerDone({ ...lease(id, g), verdict })).rejects.toBeInstanceOf(RunActionInputError);
      await nothingWritten(id);
    });

    it("refuses it when the item's issue number is not the branch's", async () => {
      const id = await pending({ continues: { branch: ITEM, prNumber: 41 } });
      await bind(id, { pr_number: 41, branch: ITEM });
      const g = await claimed(id);
      await admin.query("UPDATE work_items SET gh_number = 13 WHERE id = $1", [A.workItemId]);
      await expect(facade.finishRunnerDone({ ...lease(id, g), verdict })).rejects.toBeInstanceOf(RunActionInputError);
      await nothingWritten(id);
    });

    it("a run branch needs no binding, as before", async () => {
      const id = await pending();
      const g = await claimed(id);
      const branch = `fx/${id}-g${g}`;
      expect(await facade.finishRunnerDone({ ...lease(id, g), verdict: { ...verdict, branch } })).toMatchObject({ kind: "recorded" });
    });
  });

  describe("a repeat done replays what was stored (C21 section 1)", () => {
    it("begin after a recorded done answers the stored verdict, and writes nothing", async () => {
      const id = await pending();
      const g = await claimed(id);
      await facade.finishRunnerDone({ ...lease(id, g), verdict: ok });
      const events = await statusEvents(id);
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "replay", verdict: ok });
      expect(await statusEvents(id)).toEqual(events);
    });

    it("a second finish answers the FIRST verdict, even one that differs, and records once", async () => {
      const id = await pending();
      const g = await claimed(id);
      await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, sessionId: "first" });
      const second = await facade.finishRunnerDone({ ...lease(id, g), verdict: { outcome: "failed", failureReason: "no_commit", prNumber: null }, sessionId: "second" });
      expect(second).toEqual({ kind: "replay", verdict: ok });
      expect(await row(id)).toMatchObject({ status: "succeeded", cc_session_id: "first" });
      expect((await statusEvents(id)).filter((p) => p.viaRunnerDone === true)).toHaveLength(1);
    });

    it("only for the same runner and the same generation: any other is a stop", async () => {
      const id = await pending();
      const g = await claimed(id);
      await facade.finishRunnerDone({ ...lease(id, g), verdict: ok });
      expect(await facade.beginRunnerDone(lease(id, g + 1))).toEqual({ kind: "fenced", reason: "stale_generation" });
      expect(await facade.beginRunnerDone(lease(id, g, await newRunner()))).toEqual({ kind: "fenced", reason: "stale_generation" });
      expect(await facade.finishRunnerDone({ ...lease(id, g + 1), verdict: ok })).toEqual({ kind: "fenced", reason: "stale_generation" });
    });

    it("two done attempts at the same moment record once; the other is told the winner's verdict", async () => {
      const id = await pending();
      const g = await claimed(id);
      const a: RunnerDoneVerdict = { outcome: "succeeded", failureReason: null, prNumber: 11 };
      const b: RunnerDoneVerdict = { outcome: "failed", failureReason: "scope_violation", prNumber: 12 };
      const results = await Promise.all([facade.finishRunnerDone({ ...lease(id, g), verdict: a }), facade.finishRunnerDone({ ...lease(id, g), verdict: b })]);
      expect(results.filter((r) => r.kind === "recorded")).toHaveLength(1);
      const winner = results.find((r) => r.kind === "recorded")!;
      const loser = results.find((r) => r.kind === "replay")!;
      expect(loser).toEqual({ kind: "replay", verdict: (winner as { verdict: RunnerDoneVerdict }).verdict });
      expect((await statusEvents(id)).filter((p) => p.viaRunnerDone === true)).toHaveLength(1);
    });
  });

  it("the dispatch record's event kind is the same string in the issuer and in the route", () => {
    expect(DISPATCH_BASE_KIND).toBe(RUNNER_DISPATCH_BASE_KIND);
  });

  describe("claim -> events -> done through the routes, the facades and the real GitHub port", () => {
    let key: TestKey;
    const BRANCH = (runId: string, g: number) => `fx/${runId}-g${g}`;
    let fake: FakeGithub;
    let deps: RunnerCloudDeps;
    let runnerKeyed: string;

    beforeEach(async () => {
      key = newKey();
      fake = new FakeGithub();
      fake.addRepo("acme", "widgets");
      const port = createRunPullRequestPort({ open: async () => fake, appLogin: async () => FAKE_APP_LOGIN });
      deps = { appUserPool: appPool, origin: ORIGIN, failRunnerLeases: null, leases: { ...claims, ...facade, ...gitTickets }, pullRequests: port };
      runnerKeyed = await newRunner(key);
    });

    const send = (path: string, body: unknown) => signed(key, path, body);
    const run = (fn: () => Promise<{ status: number; body: unknown }>) => toResponse(fn);

    /** Claims `id` as the keyed runner, through the claim route. */
    async function claimRoute(id: string): Promise<number> {
      const res = await run(() => claimRun(deps, send(CLAIM_PATH, {})));
      const body = res.body as { run_id?: string; lease_generation?: number };
      if (res.status !== 200 || body.run_id !== id) throw new Error(`claim route: ${res.status} ${JSON.stringify(res.body)}`);
      return body.lease_generation!;
    }
    const done = (id: string, g: number, extra: object = {}) => run(() => doneRun(deps, send(donePath(id), { run_id: id, lease_generation: g, ...extra }), id));

    it("an executor's whole run: claim, heartbeat, events, done -> a ready pull request, status succeeded, only A1 to A5 and zero refusals", async () => {
      const id = await pending({ specVersion: await spec(["src/**"]) });
      const g = await claimRoute(id);
      expect((await run(() => heartbeatRun(deps, send(HEARTBEAT_PATH, { run_id: id, lease_generation: g })))).status).toBe(200);
      const ev = { seq: 0, ts: new Date().toISOString(), type: "tool_use", tool_name: "Edit" };
      expect((await run(() => ingestEvents(deps, send(eventsPath(id), { run_id: id, lease_generation: g, events: [ev] }), id))).status).toBe(200);

      const repo = fake.repos.get("acme/widgets")!;
      fake.pushBranch(repo, BRANCH(id, g), { files: [{ path: "src/footer.ts", changeType: "ADDED" }], aheadBy: 2 });
      const res = await done(id, g, { session_id: "7f0c1d2e-aaaa", agentOutput: { verdict: "pass" } });
      expect(res.status).toBe(200);
      expect(DoneReply.parse(res.body)).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: 1 });
      expect(await row(id)).toMatchObject({ status: "succeeded", cc_session_id: "7f0c1d2e-aaaa", envelope: { verdict: "pass" }, usd: null });
      expect(repo.pulls).toHaveLength(1);
      expect(repo.pulls[0]).toMatchObject({ draft: false, state: "open", head: BRANCH(id, g), title: "Add the footer" });
      expect(fake.denied).toBe(0);
      expect([...new Set(fake.calls.map((c) => c.label.split(" ")[0]))].sort()).toEqual(["A1", "A2", "A3", "A4"]);
      expect(fake.calls.map((c) => c.label)).toEqual(["A2", "A1 RunBranchState", "A3", "A4", "A1 PullRequestFiles", "A1 MarkReady"]);
      expect(runnerKeyed).toBeTruthy();

      // The idempotent repeat: the same reply, no GitHub call, no second write.
      const calls = fake.calls.length;
      const events = await statusEvents(id);
      const again = await done(id, g, { session_id: "other-session", agentOutput: { verdict: "fail" } });
      expect(again).toEqual({ ...res });
      expect(fake.calls.length).toBe(calls);
      expect(await statusEvents(id)).toEqual(events);
      expect(await row(id)).toMatchObject({ cc_session_id: "7f0c1d2e-aaaa", envelope: { verdict: "pass" } });
    });

    // D#600 CX-5c2, end to end: the done route -> the facade -> the real definer. What a runner reports about its pinned files must be what the row holds.
    it("a runner's pin sections and reasons, sent in `done` after the dispatch write, are in the stored ledger row", async () => {
      const id = await pending({ specVersion: await spec(["src/**"]) });
      const g = await claimRoute(id);
      const sec = (code: string, bytes: number, sha: string) => ({ code: code as "spec", bytes, sha256: sha.repeat(64), trimmed_bytes: 0 });
      const cloudSections = [sec("boundary", 60, "d"), sec("spec", 300, "d")];
      await withTenant(writerPool, A.accountId, (client) => recordContextLedger(client, { accountId: A.accountId, runId: id, sections: cloudSections, measure: NOT_RECORDED_MEASURE }));
      fake.pushBranch(fake.repos.get("acme/widgets")!, BRANCH(id, g), { files: [{ path: "src/footer.ts", changeType: "ADDED" }], aheadBy: 1 });
      const pinned = [sec("pinned", 150, "1"), { ...sec("pinned", 2, "2"), trimmed_reason: "pin_too_large" }, { ...sec("pinned", 1, "3"), trimmed_reason: "pin_excluded" }];
      const ledger = { basis: "measured", sections: pinned, first_turn_input: 100, peak_context: 200, tool_output_bytes: {}, compactions: 0 };
      expect((await done(id, g, { context_ledger: ledger })).status).toBe(200);
      const stored = (await admin.query("SELECT sections FROM run_context_ledger WHERE account_id = $1 AND run_id = $2", [A.accountId, id])).rows;
      expect(stored).toHaveLength(1);
      expect(stored[0].sections).toEqual([...cloudSections, ...pinned]);
    });

    // D#6 R-CHK-3 (C47). The runner sends run_ended(check_failed) FIRST and `done` with its `check` after it: the event ends nothing, the `done` is accepted (no stop), and the run ends
    // `failed check_failed` from the check. Nothing is asked of GitHub and no pull request is opened.
    describe("the approved check, in the order a runner sends it", () => {
      const CHECK: Check = { argv: ["bash", "scripts/check.sh"], dev_shell: true, timeout_s: 5400 };
      const runEnded = (id: string, g: number, extra: object = {}) =>
        run(() => ingestEvents(deps, send(eventsPath(id), { run_id: id, lease_generation: g, events: [{ seq: 0, ts: new Date().toISOString(), type: "run_ended", reason: "check_failed", ...extra }] }), id));
      const storedEnded = async (id: string) => (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'runner.event' AND payload->>'type' = 'run_ended'", [id])).rows.map((r) => r.payload);
      const checkRow = async (id: string) => (await admin.query("SELECT exit_code, duration_ms, timed_out, skipped_tests, summary FROM run_checks WHERE run_id = $1", [id])).rows;

      it("a failed check: run_ended(check_failed) leaves the run running, then done is recorded failed check_failed with the check, the branch kept, no GitHub call", async () => {
        const id = await pending({ specVersion: await spec(["src/**"]), check: CHECK });
        const g = await claimRoute(id);
        expect((await runEnded(id, g)).status).toBe(200);
        expect((await row(id)).status).toBe("running");
        const summary = "check files changed by this branch: scripts/check.sh, package.json\nFAIL src/a.test.ts";
        const res = await done(id, g, { check: { exit_code: 1, duration_ms: 2_460_000, timed_out: false, skipped_tests: 4, summary } });
        expect(res.status).toBe(200);
        expect(DoneReply.parse(res.body)).toEqual({ continue: false, outcome: "failed", failure_reason: "check_failed", pr_number: null });
        expect((await row(id)).status).toBe("failed");
        expect(fake.calls).toEqual([]);
        expect(fake.repos.get("acme/widgets")!.pulls).toHaveLength(0);
        // The first summary line is the base-commit pin (#386); it is stored exactly as sent.
        expect(await checkRow(id)).toEqual([{ exit_code: 1, duration_ms: "2460000", timed_out: false, skipped_tests: 4, summary }]);
        expect((await statusEvents(id)).at(-1)).toEqual({ from: "running", to: "failed", failureReason: "check_failed", viaRunnerDone: true, prNumber: null, branch: BRANCH(id, g) });
        expect(await storedEnded(id)).toEqual([{ type: "run_ended", reason: "check_failed", seq: 0, ts: expect.any(String) }]);
        // The repeat replays the stored verdict and writes nothing more.
        expect(await done(id, g, { check: { exit_code: 0, duration_ms: 1, timed_out: false, skipped_tests: null, summary: "" } })).toEqual(res);
        expect(await checkRow(id)).toHaveLength(1);
      });

      it("no dev shell: run_ended(check_failed, check_no_dev_shell), then done with exit null, 0 ms and an empty summary: failed check_failed, the detail kept on the event", async () => {
        const id = await pending({ specVersion: await spec(["src/**"]), check: CHECK });
        const g = await claimRoute(id);
        expect((await runEnded(id, g, { detail: "check_no_dev_shell" })).status).toBe(200);
        expect((await row(id)).status).toBe("running");
        const res = await done(id, g, { check: { exit_code: null, duration_ms: 0, timed_out: false, skipped_tests: null, summary: "" } });
        expect(DoneReply.parse(res.body)).toEqual({ continue: false, outcome: "failed", failure_reason: "check_failed", pr_number: null });
        expect(await checkRow(id)).toEqual([{ exit_code: null, duration_ms: "0", timed_out: false, skipped_tests: null, summary: "" }]);
        expect((await storedEnded(id))[0]).toMatchObject({ reason: "check_failed", detail: "check_no_dev_shell" });
        expect(fake.calls).toEqual([]);
      });

      it("a check that timed out ends the same way, with no exit status", async () => {
        const id = await pending({ specVersion: await spec(["src/**"]), check: CHECK });
        const g = await claimRoute(id);
        expect((await runEnded(id, g)).status).toBe(200);
        const res = await done(id, g, { check: { exit_code: null, duration_ms: 5_400_000, timed_out: true, skipped_tests: null, summary: "tail" } });
        expect(DoneReply.parse(res.body).failure_reason).toBe("check_failed");
        expect(await checkRow(id)).toEqual([{ exit_code: null, duration_ms: "5400000", timed_out: true, skipped_tests: null, summary: "tail" }]);
      });

      it("a passing check goes on to the pull request, and its row is recorded with the success", async () => {
        const id = await pending({ specVersion: await spec(["src/**"]), check: CHECK });
        const g = await claimRoute(id);
        fake.pushBranch(fake.repos.get("acme/widgets")!, BRANCH(id, g), { files: [{ path: "src/a.ts", changeType: "MODIFIED" }], aheadBy: 1 });
        const res = await done(id, g, { check: { exit_code: 0, duration_ms: 41 * 60_000, timed_out: false, skipped_tests: 3, summary: "ok" } });
        expect(DoneReply.parse(res.body)).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: 1 });
        expect(await checkRow(id)).toHaveLength(1);
      });
    });

    it("a violation ends the run failed with the pull request closed, and the repeat replays it", async () => {
      const id = await pending({ specVersion: await spec(["src/**"]) });
      const g = await claimRoute(id);
      const repo = fake.repos.get("acme/widgets")!;
      fake.pushBranch(repo, BRANCH(id, g), { files: [{ path: "src/a.ts", changeType: "MODIFIED" }, { path: ".github/workflows/ci.yml", changeType: "MODIFIED" }] });
      const res = await done(id, g);
      expect(DoneReply.parse(res.body)).toEqual({ continue: false, outcome: "failed", failure_reason: "scope_violation", pr_number: 1 });
      expect(repo.pulls[0]!.state).toBe("closed");
      expect((await row(id)).status).toBe("failed");
      expect(await done(id, g)).toEqual(res);
    });

    it("a reviewer's done succeeds with no GitHub call at all", async () => {
      const id = await pending({ role: "code-reviewer" });
      const g = await claimRoute(id);
      const res = await done(id, g, { agentOutput: { verdict: "pass" } });
      expect(DoneReply.parse(res.body)).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: null });
      expect(fake.calls).toEqual([]);
      expect((await row(id)).status).toBe("succeeded");
    });

    it("GitHub down: 503 { retry_after }, the run's outcome is not written, and the retry finishes it without a second pull request", async () => {
      const id = await pending({ specVersion: await spec(["src/**"]) });
      const g = await claimRoute(id);
      const repo = fake.repos.get("acme/widgets")!;
      fake.pushBranch(repo, BRANCH(id, g), { files: [{ path: "src/a.ts", changeType: "MODIFIED" }] });
      fake.inject = { label: /^A1 PullRequestFiles$/, reply: { status: 502, body: {} } };
      const down = await done(id, g, { session_id: "sess-1", agentOutput: { v: 1 } });
      expect(down.status).toBe(503);
      expect(DoneRetryReply.parse(down.body)).toEqual({ retry_after: 15 });
      await nothingWritten(id);
      // The runner keeps heartbeating, and sends done again.
      expect((await run(() => heartbeatRun(deps, send(HEARTBEAT_PATH, { run_id: id, lease_generation: g })))).status).toBe(200);
      const retry = await done(id, g, { session_id: "sess-1", agentOutput: { v: 1 } });
      expect(DoneReply.parse(retry.body)).toMatchObject({ outcome: "succeeded", pr_number: 1 });
      expect(repo.pulls).toHaveLength(1);
    });

    it("a stale generation's done is a stop and its branch is never looked at; a done for a run another runner holds is a stop", async () => {
      const id = await pending({ specVersion: await spec(["src/**"]) });
      const g = await claimRoute(id);
      const repo = fake.repos.get("acme/widgets")!;
      fake.pushBranch(repo, BRANCH(id, g + 1), { files: [{ path: "src/a.ts", changeType: "MODIFIED" }] });
      const res = await done(id, g + 1);
      expect(res.status).toBe(409);
      expect(StopReply.parse(res.body)).toEqual({ continue: false, reason: "stale_generation" });
      expect(fake.calls).toEqual([]);
      expect((await row(id)).status).toBe("running");
    });

    it("a revoked runner's done never reaches the facade", async () => {
      const id = await pending({ specVersion: await spec(["src/**"]) });
      const g = await claimRoute(id);
      await admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runnerKeyed]);
      expect((await done(id, g)).status).toBe(401);
      expect(fake.calls).toEqual([]);
    });

    it("a docs-writer's whole run goes through the executor's path: its own branch, the scope check, a ready pull request, and its branch recorded (C25 section 3.1)", async () => {
      const id = await pending({ role: "docs-writer", specVersion: await spec(["docs/**"]) });
      const g = await claimRoute(id);
      const repo = fake.repos.get("acme/widgets")!;
      fake.pushBranch(repo, BRANCH(id, g), { files: [{ path: "docs/guide.md", changeType: "MODIFIED" }], aheadBy: 1 });
      const res = await done(id, g);
      expect(DoneReply.parse(res.body)).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: 1 });
      expect(repo.pulls[0]).toMatchObject({ head: BRANCH(id, g), draft: false });
      expect(await withTenant(writerPool, A.accountId, (c) => readRecordedRunnerBranch(c, { accountId: A.accountId, runId: id }))).toBe(BRANCH(id, g));
    });

    it("a docs-writer that pushed nothing ends succeeded with no pull request", async () => {
      const id = await pending({ role: "docs-writer", specVersion: await spec(["docs/**"]) });
      const g = await claimRoute(id);
      expect(DoneReply.parse((await done(id, g)).body)).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: null });
      expect(fake.repos.get("acme/widgets")!.pulls).toHaveLength(0);
    });

    it("the role list the route judges is the protocol's: every eligible role other than the executor and the docs-writer ends succeeded without GitHub", async () => {
      for (const role of RUNNER_ELIGIBLE_ROLES.filter((r) => r !== "executor" && r !== "docs-writer")) {
        const id = await pending({ role });
        const g = await claimRoute(id);
        expect(DoneReply.parse((await done(id, g)).body).outcome, role).toBe("succeeded");
        clock = T0;
        await admin.query("UPDATE runner_claim_stamps SET last_claim_at = now() - interval '1 hour'");
      }
      expect(fake.calls).toEqual([]);
    });
  });
});
