import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PLANE_PUSH_PAIRING_PATH, PLANE_PUSH_REPORT_PATH, PLANE_PUSH_TOKEN_PATH, PlanePushPairingReply, PlanePushTokenReply, STOP_REASONS, StopReply, sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { stampPlanePush } from "@fx/core/src/repos/planePushRecord.js";
import { planePushPairingRun, planePushReportRun, planePushTokenRun, toResponse, type PlanePushHostedPort, type RunnerCloudDeps, type RunnerLeaseOps } from "@fx/runner-cloud";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { createRunnerPlanePushFacade } from "../src/runnerPlanePush.js";
import { ORIGIN, newKey, signed, type TestKey } from "../../runner-cloud/test/helpers.js";

/**
 * [pg] D#598 P1f-2: the two public-push routes against the real fence (0754), the real run rows, the real `plane_pushes` and
 * `plane_push_attempts` tables and their constraints. The routes, the worker's four methods and the database are all real. GitHub is a
 * recording stand-in (its real calls are exercised over TLS in packages/github/test/planePushHosted.test.ts), so what these tests show is what
 * the hosted side does with each answer: nothing is recorded before GitHub confirms it, and the second request for a lease mints nothing.
 */
describe("plane push token and report: claim -> token -> report [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  const signing = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  let clock = T0;
  let A: SeedRefs;
  let runner: string;
  let key: TestKey;
  let claims: ReturnType<typeof createRunnerClaimFacade>;
  const HEAD = "a".repeat(40);
  const TIP = "b".repeat(40);
  const TOKEN = ["g", "hs", "w".repeat(36)].join("_"); // gitleaks:allow

  // The recording stand-in for GitHub.
  const github = { mints: [] as string[], mintError: null as unknown, pushed: true, pr: { url: "https://github.com/acme/widgets-public/pull/9" } as { url: string } | null, asked: [] as string[] };
  const port: PlanePushHostedPort = {
    mintToken: async (codeRepo) => {
      github.mints.push(codeRepo);
      if (github.mintError) throw github.mintError;
      return { token: TOKEN, expiresAt: new Date(clock + 55 * 60_000) };
    },
    verifyPushed: async () => {
      github.asked.push("pushed");
      return github.pushed;
    },
    verifyPullRequest: async () => {
      github.asked.push("pr");
      return github.pr;
    },
    revokeToken: async () => true,
  };

  let identity: { name: string; email: string } | null = { name: "Fulcrumaxe Bot", email: "bot@example.com" };
  const facade = () => createRunnerPlanePushFacade(writerPool, { now: () => clock });
  const ops = (): RunnerLeaseOps => ({ ...claims, ...facade() }) as unknown as RunnerLeaseOps;
  const deps = (): RunnerCloudDeps => ({ appUserPool: appPool, origin: ORIGIN, failRunnerLeases: null, leases: ops(), planePush: port, planePushIdentity: () => identity, now: () => new Date(clock) });
  const created = () => Math.floor(clock / 1000);
  const token = (body: unknown, nonce?: string) => toResponse(() => planePushTokenRun(deps(), signed(key, PLANE_PUSH_TOKEN_PATH, body, { created: created(), ...(nonce ? { nonce } : {}) })));
  /** A report as the hook sends it: it echoes the digest of the pairing it read (here, the stamp on the record) unless a test says otherwise. */
  const report = async (run: { id: string; generation: number }, body: Record<string, unknown>) => {
    const stamped = (await planeRow())?.pairing_digest as string | undefined;
    return toResponse(() => planePushReportRun(deps(), signed(key, PLANE_PUSH_REPORT_PATH, { run_id: run.id, lease_generation: run.generation, ...(stamped ? { pairing_digest: stamped } : {}), ...body }, { created: created() })));
  };
  const askPairing = (run: { id: string; generation: number }, nonce?: string) =>
    toResponse(() => planePushPairingRun(deps(), signed(key, PLANE_PUSH_PAIRING_PATH, { run_id: run.id, lease_generation: run.generation }, { created: created(), ...(nonce ? { nonce } : {}) })));
  const askToken = (run: { id: string; generation: number }) => token({ run_id: run.id, lease_generation: run.generation });

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    claims = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => clock, randomBetween: (min) => min });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });
  beforeEach(async () => {
    clock = T0;
    identity = { name: "Fulcrumaxe Bot", email: "bot@example.com" };
    github.mints.length = 0;
    github.asked.length = 0;
    github.mintError = null;
    github.pushed = true;
    github.pr = { url: "https://github.com/acme/widgets-public/pull/9" };
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [A.repoId]);
    key = newKey();
    runner = await insertRunner(admin, A.accountId, A.userId, { jwk: key.jwk, jkt: key.jkt, credentialMode: "api_key" });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [runner, [A.repoId]]);
  });

  const pair = (globs: string[] = ["docs/ops/"]) =>
    admin.query(
      `INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', $3)
       ON CONFLICT (repo_id) DO UPDATE SET overlay_globs = EXCLUDED.overlay_globs`,
      [A.repoId, A.accountId, globs],
    );
  /** The build-start stamp, through the real module, as the build step writes it. */
  const stamp = () => withTenant(appPool, A.accountId, (c) => stampPlanePush(c, { accountId: A.accountId, workItemId: A.workItemId, repoId: A.repoId }));
  const planeRow = async () => (await admin.query("SELECT * FROM plane_pushes WHERE work_item_id = $1", [A.workItemId])).rows[0];
  const attempts = async () => (await admin.query("SELECT * FROM plane_push_attempts WHERE account_id = $1 ORDER BY attempt_no", [A.accountId])).rows;

  /** A pending executor runner run with a real signed job, claimed. */
  async function claimedRun(o: { role?: string } = {}): Promise<{ id: string; generation: number }> {
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
      continues: null,
      branch_prefix: "fx/",
      model_hint: null,
      issued_at: new Date(T0 - 1000).toISOString(),
      expires_at: new Date(T0 + 72 * 3_600_000).toISOString(),
      key_id: "k1",
    };
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, initiated_by, created_at)
       VALUES ($1, $2, $3, $4, 'runner', 'pending', 'runner_local', $5, $6::jsonb, $7, to_timestamp($8 / 1000.0))`,
      [id, A.accountId, A.workItemId, job.role, A.repoId, JSON.stringify(signJob(job, signing)), A.userId, T0 - 5000],
    );
    const claimed = await claims.claimRunnerRun({ accountId: A.accountId, runnerId: runner });
    if (claimed.kind !== "claimed" || claimed.runId !== id) throw new Error("not claimed");
    return { id, generation: claimed.leaseGeneration };
  }
  const leaseEnd = async (id: string): Promise<number> => (await admin.query("SELECT lease_expires_at FROM agent_runs WHERE id = $1", [id])).rows[0].lease_expires_at.getTime();
  /** A paired item with a stamped record and a held executor run. */
  async function ready(): Promise<{ id: string; generation: number }> {
    await pair();
    await stamp();
    return claimedRun();
  }

  describe("the token", () => {
    it("a held executor run on a paired item gets 200 { token, expires_at, code_repo, branch, base } from OUR row, no-store, and one attempt row", async () => {
      const run = await ready();
      const before = await leaseEnd(run.id);
      const row = await planeRow();
      const res = await askToken(run);
      expect(res.status).toBe(200);
      const reply = PlanePushTokenReply.parse(res.body);
      expect(reply).toEqual({
        token: TOKEN,
        expires_at: new Date(T0 + 55 * 60_000).toISOString(),
        code_repo: "acme/widgets-public",
        branch: `fx/p-${row.id}`,
        base: "main",
        pr: { title: `Change from fulcrumaxe run ${run.id.slice(0, 8)}`, body: expect.stringContaining(`Run: ${run.id}`) },
        identity: { name: "Fulcrumaxe Bot", email: "bot@example.com" },
      });
      expect(res.headers).toMatchObject({ "cache-control": "no-store" });
      expect(github.mints).toEqual(["acme/widgets-public"]);
      const [attempt, ...rest] = await attempts();
      expect(rest).toEqual([]);
      expect(attempt).toMatchObject({ plane_push_id: row.id, run_id: run.id, lease_generation: run.generation, runtime: "runner", kind: "push", attempt_no: 1, token_revoked: null, finished_at: null, outcome: null });
      expect(attempt.token_issued_at).toBeInstanceOf(Date);
      expect(await leaseEnd(run.id)).toBe(before);
    });

    it("the PR title comes from the item's row, cleaned: a hostile stored title is one clean line with no mention, no reference and no URL, and the body has none of it", async () => {
      const run = await ready();
      await admin.query("UPDATE work_items SET title = $2 WHERE id = $1", [A.workItemId, "Fixes #12 @victim https://evil.example/x\nsecond line"]);
      const res = await askToken(run);
      expect(res.status).toBe(200);
      const reply = PlanePushTokenReply.parse(res.body);
      expect(reply.pr.title).toBe("Fixes victim second line");
      expect(reply.pr.body).not.toMatch(/victim|evil|second/);
    });

    it("a missing identity setting is 503 not_configured BEFORE any attempt row: the row count is unchanged, GitHub is not asked, and after the setting is restored the same run still gets its one grant", async () => {
      const run = await ready();
      identity = null;
      const before = (await attempts()).length;
      const res = await askToken(run);
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: { code: "not_configured" } });
      expect((await attempts()).length).toBe(before);
      expect(github.mints).toEqual([]);
      identity = { name: "Platform Bot", email: "platform@example.org" };
      const ok = await askToken(run);
      expect(ok.status).toBe(200);
      expect(PlanePushTokenReply.parse(ok.body).identity).toEqual({ name: "Platform Bot", email: "platform@example.org" });
      expect(await attempts()).toHaveLength(before + 1);
    });

    it("an UPPERCASE run id gets its one grant, one attempt row and a 200 (the id is lowercased before the grant), and nothing is minted twice", async () => {
      const run = await ready();
      const res = await token({ run_id: run.id.toUpperCase(), lease_generation: run.generation });
      expect(res.status).toBe(200);
      expect(PlanePushTokenReply.parse(res.body).pr.body).toContain(`Run: ${run.id}`);
      expect(await attempts()).toHaveLength(1);
      expect(github.mints).toHaveLength(1);
      expect((await askToken(run)).body).toMatchObject({ error: { code: "already_issued" } });
    });

    it("the same signed request replayed is 409 nonce_reused; a fresh request for the same run and generation is 409 already_issued; neither mints", async () => {
      const run = await ready();
      const nonce = randomBytes(16).toString("base64url");
      expect((await token({ run_id: run.id, lease_generation: run.generation }, nonce)).status).toBe(200);
      const replay = await token({ run_id: run.id, lease_generation: run.generation }, nonce);
      expect(replay.status).toBe(409);
      expect(replay.body).toMatchObject({ error: { code: "nonce_reused" } });
      const again = await askToken(run);
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ error: { code: "already_issued" } });
      expect(JSON.stringify(again.body)).not.toContain(TOKEN);
      expect(github.mints).toHaveLength(1);
      expect(await attempts()).toHaveLength(1);
    });

    it("is 403 not_paired for a run that is not an executor's, and for an item with no record; nothing is minted or written", async () => {
      await pair();
      await stamp();
      const reviewer = await claimedRun({ role: "code-reviewer" });
      const res = await askToken(reviewer);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: "not_paired" } });
      await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [reviewer.id]);
      await admin.query("DELETE FROM plane_pushes WHERE work_item_id = $1", [A.workItemId]);
      const bare = await claimedRun();
      const none = await askToken(bare);
      expect(none.status).toBe(403);
      expect(none.body).toMatchObject({ error: { code: "not_paired" } });
      expect(github.mints).toEqual([]);
      expect(await attempts()).toEqual([]);
    });

    it("is 409 pairing_changed when the pairing's digest no longer matches, or the pairing was removed; nothing is minted or written", async () => {
      const run = await ready();
      await pair(["docs/ops/", "scripts/private/"]);
      const edited = await askToken(run);
      expect(edited.status).toBe(409);
      expect(edited.body).toMatchObject({ error: { code: "pairing_changed" } });
      await admin.query("DELETE FROM repo_pairing WHERE repo_id = $1", [A.repoId]);
      const removed = await askToken(run);
      expect(removed.status).toBe(409);
      expect(removed.body).toMatchObject({ error: { code: "pairing_changed" } });
      expect(github.mints).toEqual([]);
      expect(await attempts()).toEqual([]);
    });

    it("a stale generation, an expired lease and a finished run are the 409 { continue: false } a heartbeat gives, and the lease's expiry is unchanged", async () => {
      const run = await ready();
      const before = await leaseEnd(run.id);
      const stale = await askToken({ id: run.id, generation: run.generation + 1 });
      expect(stale.status).toBe(409);
      expect(stale.body).toEqual({ continue: false, reason: "stale_generation" });
      expect(await leaseEnd(run.id)).toBe(before);
      const unknown = await askToken({ id: randomUUID(), generation: 1 });
      expect(unknown.body).toEqual({ continue: false, reason: "stale_generation" });
      clock = before + 1000;
      const expired = await askToken(run);
      expect(expired.body).toEqual({ continue: false, reason: "lease_expired" });
      clock = T0;
      await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [run.id]);
      const ended = await askToken(run);
      expect(ended.body).toEqual({ continue: false, reason: "run_terminal" });
      expect(github.mints).toEqual([]);
      expect(await attempts()).toEqual([]);
    });

    it("a record that already has three push attempts is 409 attempts_exhausted", async () => {
      const run = await ready();
      const row = await planeRow();
      for (const n of [1, 2, 3]) await admin.query(`INSERT INTO plane_push_attempts (account_id, plane_push_id, runtime, kind, attempt_no) VALUES ($1, $2, 'hosted', 'push', $3)`, [A.accountId, row.id, n]);
      const res = await askToken(run);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: "attempts_exhausted" } });
      expect(github.mints).toEqual([]);
    });

    it("attempts are numbered per kind (0882): PR-open rows on the record do not use up the runner's push attempts", async () => {
      const run = await ready();
      const row = await planeRow();
      for (const n of [1, 2, 3]) await admin.query(`INSERT INTO plane_push_attempts (account_id, plane_push_id, runtime, kind, attempt_no) VALUES ($1, $2, 'hosted', 'pr_open', $3)`, [A.accountId, row.id, n]);
      const res = await askToken(run);
      expect(res.status).toBe(200);
      expect((await attempts()).filter((a) => a.kind === "push").map((a) => a.attempt_no)).toEqual([1]);
    });

    it("a mint GitHub refuses spends the grant: 409 app_not_installed, the attempt records why and has no token, and a second request is already_issued", async () => {
      const run = await ready();
      github.mintError = Object.assign(new Error("x"), { code: "app_not_installed" });
      const res = await askToken(run);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: "app_not_installed" } });
      const [attempt] = await attempts();
      expect(attempt).toMatchObject({ token_issued_at: null, outcome: "app_not_installed" });
      expect(attempt.finished_at).toBeInstanceOf(Date);
      github.mintError = null;
      expect((await askToken(run)).body).toMatchObject({ error: { code: "already_issued" } });
      expect(github.mints).toHaveLength(1);
    });

    it("a run id this account does not have is a stop, not a token", async () => {
      const run = await ready();
      const other = await seedAccount(admin, randomUUID());
      const foreign = await token({ run_id: other.workItemId, lease_generation: run.generation });
      expect(foreign.status).toBe(409);
      expect(foreign.body).toEqual({ continue: false, reason: "stale_generation" });
      expect(github.mints).toEqual([]);
    });
  });

  describe("the report", () => {
    async function granted() {
      const run = await ready();
      expect((await askToken(run)).status).toBe(200);
      return run;
    }

    it("records scanning, then the verified push, then the verified pull request, and finishes the attempt with the token's revocation", async () => {
      const run = await granted();
      const row = await planeRow();
      expect((await report(run, { phase: "building" })).status).toBe(200);
      expect((await planeRow()).state).toBe("building");
      expect((await report(run, { phase: "scanning" })).status).toBe(200);
      expect((await planeRow()).state).toBe("scanning");
      expect((await report(run, { phase: "pushed", branch: row.branch, head_sha: HEAD, tip_sha: TIP })).status).toBe(200);
      expect(await planeRow()).toMatchObject({ state: "pushed", head_sha: HEAD, tip_sha: TIP, pr_number: null });
      expect((await attempts())[0].finished_at).toBeNull();
      const opened = await report(run, { phase: "pr_opened", head_sha: HEAD, tip_sha: TIP, pr_number: 9, token_revoked: true });
      expect(opened.status).toBe(200);
      expect(opened.body).toEqual({ recorded: true });
      expect(await planeRow()).toMatchObject({ state: "pr_opened", pr_number: 9, pr_url: "https://github.com/acme/widgets-public/pull/9", code: null });
      const [attempt] = await attempts();
      expect(attempt).toMatchObject({ token_revoked: true, outcome: "pr_opened" });
      expect(attempt.finished_at).toBeInstanceOf(Date);
      expect(github.asked).toEqual(["pushed", "pushed", "pr"]);
      // A late report from the same attempt cannot move a settled item back.
      expect((await report(run, { phase: "scanning" })).status).toBe(200);
      expect((await planeRow()).state).toBe("pr_opened");
    });

    it("bounded work: once the attempt has finished, a push report is free (no GitHub read, nothing recorded); a repeated `pushed` is free after the first", async () => {
      const run = await granted();
      expect((await report(run, { phase: "pushed", head_sha: HEAD, tip_sha: TIP })).status).toBe(200);
      expect(github.asked).toEqual(["pushed"]);
      expect((await attempts())[0]).toMatchObject({ outcome: "pushed", finished_at: null });
      expect((await report(run, { phase: "pushed", head_sha: HEAD, tip_sha: TIP })).status).toBe(200);
      expect(github.asked).toEqual(["pushed"]);
      expect((await report(run, { phase: "pr_opened", head_sha: HEAD, tip_sha: TIP, pr_number: 9 })).status).toBe(200);
      expect(github.asked).toEqual(["pushed", "pushed", "pr"]);
      const settled = await planeRow();
      expect(settled.state).toBe("pr_opened");
      for (const body of [{ phase: "pushed" }, { phase: "pr_failed" }, { phase: "pr_opened", pr_number: 10 }]) {
        expect((await report(run, { head_sha: "c".repeat(40), tip_sha: TIP, ...body })).status).toBe(200);
      }
      expect(github.asked).toEqual(["pushed", "pushed", "pr"]);
      expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: HEAD, pr_number: 9 });
    });

    it("a mismatch finishes the attempt, so a runner repeating the same false report costs GitHub nothing the second time", async () => {
      const run = await granted();
      github.pushed = false;
      await report(run, { phase: "pushed", head_sha: HEAD, tip_sha: TIP });
      await report(run, { phase: "pushed", head_sha: HEAD, tip_sha: TIP });
      expect(github.asked).toEqual(["pushed"]);
    });

    it("settling an attempt that is already finished or gone matches no row (false), so the route can revoke instead of handing the token out", async () => {
      const run = await granted();
      const [attempt] = await attempts();
      const f = facade();
      const lease = { accountId: A.accountId, runnerId: runner, runId: run.id, leaseGeneration: run.generation };
      expect(await f.planePushSettleGrant({ ...lease, attemptId: attempt.id, issued: true })).toBe(false);
      expect(await f.planePushSettleGrant({ ...lease, attemptId: randomUUID(), issued: false, code: "mint_failed" })).toBe(false);
    });

    it("a pushed report whose head the fake GitHub does not show records refused / report_mismatch and stores no branch or sha", async () => {
      const run = await granted();
      github.pushed = false;
      const res = await report(run, { phase: "pushed", head_sha: HEAD, tip_sha: TIP });
      expect(res.status).toBe(200);
      expect(await planeRow()).toMatchObject({ state: "refused", code: "report_mismatch", head_sha: null, tip_sha: null, pr_number: null, pr_url: null });
      expect((await attempts())[0]).toMatchObject({ outcome: "report_mismatch" });
    });

    it("a pr_opened report for a pull request GitHub does not show as asked records the mismatch and no pull request", async () => {
      const run = await granted();
      github.pr = null;
      await report(run, { phase: "pr_opened", head_sha: HEAD, tip_sha: TIP, pr_number: 9 });
      expect(await planeRow()).toMatchObject({ state: "refused", code: "report_mismatch", pr_number: null, pr_url: null, head_sha: null });
    });

    it("a push reported by a run that never got a token is a mismatch, and GitHub is not even asked", async () => {
      const run = await ready();
      await report(run, { phase: "pushed", head_sha: HEAD, tip_sha: TIP });
      expect(github.asked).toEqual([]);
      expect(await planeRow()).toMatchObject({ state: "refused", code: "report_mismatch", head_sha: null });
    });

    it("a refusal is recorded with its code and its place-plus-rule-key entries only, and the attempt notes a token that was not confirmed revoked", async () => {
      const run = await granted();
      const refusals = [{ kind: "identifier", place: "src/a.ts:12", rule_key: "ident.internal-name" }];
      expect((await report(run, { phase: "refused", code: "scan_refused", refusals })).status).toBe(200);
      expect(await planeRow()).toMatchObject({ state: "refused", code: "scan_refused", refusals });
      expect((await attempts())[0]).toMatchObject({ outcome: "scan_refused", token_revoked: false });
    });

    it("a pairing that moved after the build started can still record its pairing_changed refusal (only the token route checks the digest)", async () => {
      const run = await ready();
      await pair(["docs/ops/", "elsewhere/"]);
      expect((await askToken(run)).status).toBe(409);
      expect((await report(run, { phase: "refused", code: "pairing_changed" })).status).toBe(200);
      expect(await planeRow()).toMatchObject({ state: "refused", code: "pairing_changed" });
    });

    it("no_change records no public change", async () => {
      const run = await ready();
      expect((await report(run, { phase: "no_change" })).status).toBe(200);
      expect(await planeRow()).toMatchObject({ state: "no_public_change", code: null });
    });

    it("a fenced run's report is the stop reply and records nothing (a cancelled or lost run reports nothing)", async () => {
      const run = await ready();
      await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [run.id]);
      const res = await report(run, { phase: "refused", code: "push_failed" });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ continue: false, reason: "run_terminal" });
      expect((await planeRow()).state).toBe("building");
    });

    it("GitHub unreachable: 503 and nothing recorded", async () => {
      const run = await granted();
      port.verifyPushed = async () => {
        throw Object.assign(new Error("down"), { code: "public_unavailable" });
      };
      try {
        const res = await report(run, { phase: "pushed", head_sha: HEAD, tip_sha: TIP });
        expect(res.status).toBe(503);
        expect((await planeRow()).state).toBe("building");
      } finally {
        port.verifyPushed = async () => {
          github.asked.push("pushed");
          return github.pushed;
        };
      }
    });
  });
  describe("the pairing route (D#598 P1f-2b)", () => {
    // The digest of acme/widgets-public with globs ["docs/ops/"] and no rule paths, computed outside this code:
    //   printf '%s' '["acme/widgets-public",["docs/ops/"],null,null]' | sha256sum
    const PLAIN = "0b3654573286a23ed56daef0a50f90a3baee835cae43d146654316cb6d2c8046";
    // And with globs ["docs/ops/","scripts/private/"], identifier rules "rules/ids.txt" and plan-data rules "rules/plan.json":
    //   printf '%s' '["acme/widgets-public",["docs/ops/","scripts/private/"],"rules/ids.txt","rules/plan.json"]' | sha256sum
    const FULL = "76845459453f9a88ccb656f0d4d986c666aaa7d6d01da0a35333078dae3606a3";
    const fullPairing = (over: { code_repo?: string; globs?: string[]; ids?: string | null; plan?: string | null } = {}) =>
      admin.query(
        `INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs, identifier_rules_path, plan_data_rules_path) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (repo_id) DO UPDATE SET code_repo = EXCLUDED.code_repo, overlay_globs = EXCLUDED.overlay_globs, identifier_rules_path = EXCLUDED.identifier_rules_path, plan_data_rules_path = EXCLUDED.plan_data_rules_path`,
        [A.repoId, A.accountId, over.code_repo ?? "acme/widgets-public", over.globs ?? ["docs/ops/", "scripts/private/"], over.ids === undefined ? "rules/ids.txt" : over.ids, over.plan === undefined ? "rules/plan.json" : over.plan],
      );
    async function readyFull(): Promise<{ id: string; generation: number }> {
      await fullPairing();
      await stamp();
      return claimedRun();
    }
    const spent = async () => ({ attempts: (await attempts()).length, mints: github.mints.length, asked: github.asked.length });

    it("answers a valid signed request 200, no-store, with the row and its digest; the digest equals the stamp and the independently computed value; GitHub sees nothing and no attempt row is written", async () => {
      const run = await ready();
      const res = await askPairing(run);
      expect(res.status).toBe(200);
      expect(res.headers).toMatchObject({ "cache-control": "no-store" });
      expect(res.body).toEqual({ code_repo: "acme/widgets-public", overlay_globs: ["docs/ops/"], identifier_rules_path: null, plan_data_rules_path: null, pairing_digest: PLAIN });
      expect(PlanePushPairingReply.safeParse(res.body).success).toBe(true);
      expect((await planeRow()).pairing_digest).toBe(PLAIN);
      expect(github.mints).toEqual([]);
      expect(github.asked).toEqual([]);
      expect(await attempts()).toEqual([]);
    });

    it("reads the whole row, rule paths included, and the reply parses (the digest recomputes)", async () => {
      const run = await readyFull();
      const res = await askPairing(run);
      expect(res.status).toBe(200);
      const reply = PlanePushPairingReply.parse(res.body);
      expect(reply).toMatchObject({ overlay_globs: ["docs/ops/", "scripts/private/"], identifier_rules_path: "rules/ids.txt", plan_data_rules_path: "rules/plan.json" });
      expect(reply.pairing_digest).toBe((await planeRow()).pairing_digest);
      expect(reply.pairing_digest).toBe(FULL);
    });

    it("can be asked again and again (the hook asks twice by design), while the same signed request replayed is 409 nonce_reused and a spent lease is not extended", async () => {
      const run = await ready();
      const before = await leaseEnd(run.id);
      const nonce = randomBytes(16).toString("base64url");
      expect((await askPairing(run, nonce)).status).toBe(200);
      expect((await askPairing(run)).status).toBe(200);
      expect((await askPairing(run)).status).toBe(200);
      const replay = await askPairing(run, nonce);
      expect(replay.status).toBe(409);
      expect(replay.body).toMatchObject({ error: { code: "nonce_reused" } });
      expect(await leaseEnd(run.id)).toBe(before);
      expect(await attempts()).toEqual([]);
    });

    it("a stale generation, an unknown run, an expired lease and a finished run are the 409 stop a heartbeat gives, with the lease's expiry unchanged", async () => {
      const run = await ready();
      const before = await leaseEnd(run.id);
      const stale = await askPairing({ id: run.id, generation: run.generation + 1 });
      expect(stale.status).toBe(409);
      expect(StopReply.parse(stale.body)).toEqual({ continue: false, reason: "stale_generation" });
      expect((await askPairing({ id: randomUUID(), generation: 1 })).body).toEqual({ continue: false, reason: "stale_generation" });
      clock = before + 1000;
      expect((await askPairing(run)).body).toEqual({ continue: false, reason: "lease_expired" });
      clock = T0;
      expect(await leaseEnd(run.id)).toBe(before);
      await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [run.id]);
      expect((await askPairing(run)).body).toEqual({ continue: false, reason: "run_terminal" });
      expect(STOP_REASONS).toContain("run_terminal");
    });

    it("is 403 not_paired for a run that is not an executor's and for an item with no record", async () => {
      await pair();
      await stamp();
      const reviewer = await claimedRun({ role: "code-reviewer" });
      const res = await askPairing(reviewer);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: "not_paired" } });
      await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [reviewer.id]);
      await admin.query("DELETE FROM plane_pushes WHERE work_item_id = $1", [A.workItemId]);
      const bare = await claimedRun();
      const none = await askPairing(bare);
      expect(none.status).toBe(403);
      expect(none.body).toMatchObject({ error: { code: "not_paired" } });
    });

    it("another account's run id is a stop, not a pairing", async () => {
      const run = await ready();
      const other = await seedAccount(admin, randomUUID());
      const foreign = await toResponse(() => planePushPairingRun(deps(), signed(key, PLANE_PUSH_PAIRING_PATH, { run_id: other.workItemId, lease_generation: run.generation }, { created: created() })));
      expect(foreign.status).toBe(409);
      expect(foreign.body).toEqual({ continue: false, reason: "stale_generation" });
    });

    describe("after the build started, each edit is 409 pairing_changed with no pairing in the body", () => {
      const cases: Array<[string, () => Promise<unknown>]> = [
        ["a glob added", () => fullPairing({ globs: ["docs/ops/", "scripts/private/", "extra/"] })],
        ["a glob removed", () => fullPairing({ globs: ["docs/ops/"] })],
        ["the order of globs changed", () => fullPairing({ globs: ["scripts/private/", "docs/ops/"] })],
        ["a rule path changed", () => fullPairing({ ids: "rules/other.txt" })],
        ["a rule path cleared", () => fullPairing({ plan: null })],
        ["code_repo changed to a different repo", () => fullPairing({ code_repo: "acme/another-public" })],
        ["the pairing row deleted", () => admin.query("DELETE FROM repo_pairing WHERE repo_id = $1", [A.repoId])],
      ];
      it.each(cases)("%s", async (_label, edit) => {
        const run = await readyFull();
        expect((await askPairing(run)).status).toBe(200);
        await edit();
        const res = await askPairing(run);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ error: { code: "pairing_changed" } });
        for (const field of ["overlay_globs", "docs/ops", "scripts/private", "rules/", "acme/"]) expect(JSON.stringify(res.body), field).not.toContain(field);
        expect(await attempts()).toEqual([]);
        expect(github.mints).toEqual([]);
      });

      it("changing only the letter case of code_repo still answers 200 (the digest case-folds the repo name)", async () => {
        const run = await readyFull();
        await fullPairing({ code_repo: "ACME/Widgets-Public" });
        const res = await askPairing(run);
        expect(res.status).toBe(200);
        expect(PlanePushPairingReply.parse(res.body).code_repo).toBe("ACME/Widgets-Public");
      });

      it("an edit between the first and the second call is seen by the second, and putting the pairing back makes it 200 again (derived from the row each time)", async () => {
        const run = await readyFull();
        expect((await askPairing(run)).status).toBe(200);
        await fullPairing({ globs: ["docs/ops/"] });
        expect((await askPairing(run)).status).toBe(409);
        await fullPairing();
        expect((await askPairing(run)).status).toBe(200);
      });

      it("the token route says the same, spends no attempt and mints nothing", async () => {
        const run = await readyFull();
        await fullPairing({ globs: ["docs/ops/"] });
        const before = await spent();
        const res = await askToken(run);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ error: { code: "pairing_changed" } });
        expect(await spent()).toEqual(before);
      });
    });
  });

  describe("the report echoes the pairing digest (D#598 P1f-2b)", () => {
    async function granted() {
      const run = await ready();
      expect((await askToken(run)).status).toBe(200);
      return run;
    }

    it.each(["pushed", "pr_failed", "pr_opened"])("a %s report without pairing_digest is 400 and records nothing", async (phase) => {
      const run = await granted();
      const res = await report(run, { phase, head_sha: HEAD, tip_sha: TIP, ...(phase === "pr_opened" ? { pr_number: 9 } : {}), pairing_digest: undefined });
      expect(res.status).toBe(400);
      expect((await planeRow()).state).toBe("building");
      expect(github.asked).toEqual([]);
    });

    it.each(["pushed", "pr_failed", "pr_opened"])("a %s report with a digest that differs from the stamp records refused / report_mismatch, stores no branch, sha or pull request, and GitHub is not asked", async (phase) => {
      const run = await granted();
      const res = await report(run, { phase, head_sha: HEAD, tip_sha: TIP, ...(phase === "pr_opened" ? { pr_number: 9 } : {}), pairing_digest: "e".repeat(64) });
      expect(res.status).toBe(200);
      expect(await planeRow()).toMatchObject({ state: "refused", code: "report_mismatch", head_sha: null, tip_sha: null, pr_number: null, pr_url: null });
      expect((await attempts())[0]).toMatchObject({ outcome: "report_mismatch" });
      expect(github.asked).toEqual([]);
    });

    it("with the stamped digest it records as before, and a pairing edited after the token does not change that (the stamp is what a report is compared with)", async () => {
      const run = await granted();
      await pair(["docs/ops/", "scripts/private/", "later/"]);
      expect((await report(run, { phase: "pushed", head_sha: HEAD, tip_sha: TIP })).status).toBe(200);
      expect(await planeRow()).toMatchObject({ state: "pushed", head_sha: HEAD, tip_sha: TIP });
      expect((await report(run, { phase: "pr_opened", head_sha: HEAD, tip_sha: TIP, pr_number: 9 })).status).toBe(200);
      expect(await planeRow()).toMatchObject({ state: "pr_opened", pr_number: 9 });
    });
  });
});
