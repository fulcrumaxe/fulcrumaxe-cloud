import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PLANE_PUSH_PAIRING_PATH, PLANE_PUSH_REPORT_PATH, PLANE_PUSH_TOKEN_PATH, PlanePushPairingReply, PlanePushTokenReply, STOP_REASONS, StopReply, sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { stampPlanePush } from "@fx/core/src/repos/planePushRecord.js";
import { raiseBranchPushedByPerson } from "@fx/core/src/setup-requests/branchPushed.js";
import { keepBranch, replaceBranch } from "@fx/core/src/setup-requests/branchPushedAnswer.js";
import { statusSentence } from "@fx/core/src/setup-requests/copy.js";
import { listSetupRequests } from "@fx/core/src/setup-requests/store.js";
import { getWorkItemActivity } from "@fx/core/src/work-items/activity.js";
import { FIX_ROUND_STOP_SENTENCE, REPUBLISH_BRANCH_MOVED_SENTENCE, REPUBLISH_FAILED_SENTENCE, REPUBLISH_NO_CHANGE_SENTENCE, REPUBLISH_REPLACE_NO_CHANGE_SENTENCE, REPUBLISH_REPLACE_FAILED_SENTENCE, REPUBLISH_PAIRING_OFF_SENTENCE, REPUBLISH_TIP_MOVED_SENTENCE } from "@fx/core/src/work-items/baseSync.js";
import { planePushPairingRun, planePushReportRun, planePushTokenRun, toResponse, type PlanePushHostedPort, type RunnerCloudDeps, type RunnerLeaseOps } from "@fx/runner-cloud";
import { mergeQueue } from "@fx/pipeline";
import { RUNNER_REPLACE_ROUND_KIND, insertRunEvent } from "@fx/runner";
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
  const github = { mints: [] as string[], mintedFor: [] as string[], mintError: null as unknown, pushed: true, pr: { url: "https://github.com/acme/widgets-public/pull/9" } as { url: string } | null, asked: [] as string[], mainTip: "9".repeat(40) as string | null, heads: [] as string[] };
  const port: PlanePushHostedPort = {
    mintToken: async (codeRepo, accountId) => {
      await duringMint?.();
      github.mints.push(codeRepo);
      github.mintedFor.push(accountId);
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
    revokeToken: async (t) => (revoked.push(t), true),
    // The real port reads one branch of the repository in the request (its own token, revoked after).
    branchHead: async ({ codeRepo, branch }) => {
      github.heads.push(`${codeRepo}@${branch}`);
      return branch === "main" ? github.mainTip : null;
    },
  };

  /** Runs between the grant and the token: what a person can do while the runner waits for its token. */
  let duringMint: (() => Promise<void>) | null = null;
  const revoked: string[] = [];
  let identity: { name: string; email: string } | null = { name: "Fulcrumaxe Bot", email: "bot@example.com" };
  const facade = () => createRunnerPlanePushFacade(writerPool, { now: () => clock, publicHead: (i) => port.branchHead!(i) });
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
    duringMint = null;
    revoked.length = 0;
    identity = { name: "Fulcrumaxe Bot", email: "bot@example.com" };
    github.mints.length = 0;
    github.mintedFor.length = 0;
    github.asked.length = 0;
    github.heads.length = 0;
    github.mainTip = "9".repeat(40);
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
  // attempt_no counts from 1 per kind (migration 0882), so a push and a fix_round can both be 1: order by creation,
  // with attempt_no then id as tiebreaks so rows created in one instant still come back in a fixed order.
  const attempts = async () => (await admin.query("SELECT * FROM plane_push_attempts WHERE account_id = $1 ORDER BY created_at, attempt_no, id", [A.accountId])).rows;

  /** A pending executor runner run with a real signed job, claimed. */
  async function claimedRun(o: { role?: string; continues?: { baseSha?: string } } = {}): Promise<{ id: string; generation: number }> {
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
      continues: o.continues ? { parent_run_id: randomUUID(), session_id: "sess-1", branch: `fx/${randomUUID()}-g1`, ...(o.continues.baseSha ? { base_sha: o.continues.baseSha } : {}) } : null,
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

    describe("the pairing's pull request footer", () => {
      const BASE_BODY = (id: string) => `This change was prepared by a fulcrumaxe run and checked against the paired repository's rules before it was sent.\n\nRun: ${id}\n`;
      const setFooter = (footer: string | null) => admin.query("UPDATE repo_pairing SET pr_footer = $2 WHERE repo_id = $1", [A.repoId, footer]);
      const setIssue = (n: number | null) => admin.query("UPDATE work_items SET gh_number = $2 WHERE id = $1", [A.workItemId, n]);
      const events = async (runId: string) => (await admin.query("SELECT kind, payload FROM run_events WHERE run_id = $1 AND kind = 'plane.pr_footer_skipped'", [runId])).rows;

      it("off by default: no footer set gives today's body and no notice", async () => {
        const run = await ready();
        const reply = PlanePushTokenReply.parse((await askToken(run)).body);
        expect(reply.pr.body).toBe(BASE_BODY(run.id));
        expect(await events(run.id)).toEqual([]);
      });

      it("renders a literal footer, {issue_number} and {run_id} into the token reply's body, after a blank line", async () => {
        const run = await ready();
        await setIssue(77);
        await setFooter("Refs D#6 / issue {issue_number} / run {run_id}");
        const reply = PlanePushTokenReply.parse((await askToken(run)).body);
        expect(reply.pr.body).toBe(`${BASE_BODY(run.id)}\nRefs D#6 / issue 77 / run ${run.id}\n`);
      });

      it("a footer whose placeholder has no value (no issue number) is left off, the body is today's, and the run records a notice line", async () => {
        const run = await ready();
        await setIssue(null);
        await setFooter("Refs D#{issue_number}");
        const reply = PlanePushTokenReply.parse((await askToken(run)).body);
        expect(reply.pr.body).toBe(BASE_BODY(run.id));
        expect(await events(run.id)).toEqual([{ kind: "plane.pr_footer_skipped", payload: { reason: "no_issue_number" } }]);
      });

      it("editing the footer after the build started does not invalidate the build: the token is still granted, with the new footer", async () => {
        const run = await ready();
        await setFooter("Refs D#9");
        const res = await askToken(run);
        expect(res.status).toBe(200);
        expect(PlanePushTokenReply.parse(res.body).pr.body).toBe(`${BASE_BODY(run.id)}\nRefs D#9\n`);
      });

      it("the pairing reply to the hook does not carry the footer", async () => {
        const run = await ready();
        await setFooter("Refs D#9");
        const res = await askPairing(run);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain("Refs D#9");
      });
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
      expect(await planeRow()).toMatchObject({ state: "pr_opened", pr_number: 9, pr_url: "https://github.com/acme/widgets-public/pull/9", code: null, source_head: null });
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

  describe("a fix round updates the open public pull request (FIXROUND-REPUBLISH R2-c1)", () => {
    const BASE = "c".repeat(40);
    const NEW_HEAD = "d".repeat(40);
    const NEW_TIP = "e".repeat(40);
    /** A paired item whose first publication is done: its public pull request is open and the stamp is the head the platform pushed. */
    async function open(): Promise<void> {
      await pair();
      await stamp();
      await admin.query("UPDATE plane_pushes SET state = 'pr_opened', head_sha = $2, tip_sha = $3, pr_number = 9, pr_url = 'https://github.com/acme/widgets-public/pull/9' WHERE work_item_id = $1", [A.workItemId, HEAD, TIP]);
      await admin.query("UPDATE work_items SET stage = 'changes_requested' WHERE id = $1", [A.workItemId]);
    }
    const stageOf = async () => (await admin.query("SELECT stage FROM work_items WHERE id = $1", [A.workItemId])).rows[0].stage as string;
    const facts = async () => (await admin.query("SELECT kind, code FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq", [A.workItemId])).rows;
    const finish = (id: string) => admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [id]);

    it("a fix round signed with a base is granted a token that names the head the platform pushed, as an attempt of its own kind", async () => {
      await open();
      const run = await claimedRun({ continues: { baseSha: BASE } });
      const res = await askToken(run);
      expect(res.status).toBe(200);
      expect(PlanePushTokenReply.parse(res.body).replaces_head).toBe(HEAD);
      const [attempt, ...rest] = await attempts();
      expect(rest).toEqual([]);
      expect(attempt).toMatchObject({ run_id: run.id, kind: "fix_round", attempt_no: 1 });
    });

    it("D#598 P1g-3a: after a confirmed Replace the token names the head the person was shown (no runner capability needed), and a round with no authorization still names the stamp", async () => {
      await open();
      const SHOWN = "b".repeat(40);
      await admin.query("UPDATE plane_pushes SET replace_authorized_head = $2 WHERE work_item_id = $1", [A.workItemId, SHOWN]);
      const first = await claimedRun({ continues: { baseSha: BASE } });
      const res = await askToken(first);
      expect(res.status).toBe(200);
      expect(PlanePushTokenReply.parse(res.body).replaces_head).toBe(SHOWN);
      await finish(first.id);
      await admin.query("UPDATE plane_pushes SET replace_authorized_head = NULL WHERE work_item_id = $1", [A.workItemId]);
      const again = await askToken(await claimedRun({ continues: { baseSha: BASE } }));
      expect(PlanePushTokenReply.parse(again.body).replaces_head).toBe(HEAD);
    });

    describe("a Keep that arrives during a round whose lease is on the person's head (D#598 P1g-3a)", () => {
      const THEIRS = "7".repeat(40);
      const person = { accountId: () => A.accountId, userId: () => A.userId };
      /** A person pushed, the request was raised, and they confirmed Replace: the round's lease is on their head. Returns the request id. */
      async function replaced(): Promise<string> {
        await open();
        const [req] = await withTenant(appPool, A.accountId, async (c) => {
          const raised = await raiseBranchPushedByPerson(c, { workItemId: A.workItemId, seenHead: THEIRS });
          return raised.kind === "not_applicable" ? [] : [raised.request];
        });
        await replaceBranch({ pool: appPool }, { accountId: person.accountId(), userId: person.userId(), id: req!.id, shownHead: THEIRS });
        return req!.id;
      }
      const keep = (id: string) => keepBranch({ pool: appPool }, { accountId: person.accountId(), userId: person.userId(), id });

      it("between the grant and the token: no token is handed out, the attempt ends with a fixed code, nothing is pushed, and Keep's managed state stands with the stamp untouched", async () => {
        const id = await replaced();
        duringMint = async () => void (await keep(id));
        const run = await claimedRun({ continues: { baseSha: BASE } });
        const res = await askToken(run);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ error: { code: "branch_managed_by_person" } });
        expect(res.body).not.toHaveProperty("token");
        // The token that had been minted was revoked, never issued; the attempt is finished and says why.
        expect(revoked).toEqual([TOKEN]);
        const [attempt] = await attempts();
        expect(attempt).toMatchObject({ kind: "fix_round", token_issued_at: null, outcome: "managed_after_grant" });
        expect(attempt.finished_at).toBeInstanceOf(Date);
        expect(await planeRow()).toMatchObject({ state: "managed_by_person", head_sha: HEAD, replace_authorized_head: null });
        expect((await planeRow()).managed_by_person_at).not.toBeNull();
        // The row is the person's now: a second request for the same run is told there is nothing to push to, and nothing is minted.
        expect((await askToken(run)).body).toMatchObject({ error: { code: "not_paired" } });
        expect(github.mints).toHaveLength(1);
      });

      it("a spent authorization between the grant and the token (the branch was put back) refuses the token the same way, with its own fixed code: nothing is pushed", async () => {
        await replaced();
        duringMint = async () => void (await admin.query("UPDATE plane_pushes SET replace_authorized_head = NULL WHERE work_item_id = $1", [A.workItemId]));
        const res = await askToken(await claimedRun({ continues: { baseSha: BASE } }));
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ error: { code: "update_lease_changed" } });
        expect(revoked).toEqual([TOKEN]);
        expect((await attempts())[0]).toMatchObject({ token_issued_at: null, outcome: "lease_changed_after_grant" });
        expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: HEAD });
      });

      it("after the token: the push lands, the update is recorded on the managed row with its new head and a fixed-code event, and the managed line names both commits", async () => {
        const id = await replaced();
        const run = await claimedRun({ continues: { baseSha: BASE } });
        const res = await askToken(run);
        expect(res.status).toBe(200);
        expect(PlanePushTokenReply.parse(res.body).replaces_head).toBe(THEIRS);
        await keep(id);
        expect((await report(run, { phase: "updated", head_sha: NEW_HEAD, tip_sha: NEW_TIP, branch: (await planeRow()).branch })).status).toBe(200);
        expect(await planeRow()).toMatchObject({ state: "managed_by_person", head_sha: NEW_HEAD, tip_sha: NEW_TIP, replace_authorized_head: null });
        expect((await planeRow()).managed_by_person_at).not.toBeNull();
        expect((await attempts())[0]).toMatchObject({ outcome: "updated" });
        const events = (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'plane.updated_after_keep'", [run.id])).rows;
        expect(events).toEqual([{ payload: { code: "updated_after_keep", head: NEW_HEAD, replaced: THEIRS } }]);
        const [line] = (await withTenant(appPool, A.accountId, (c) => listSetupRequests(c, { state: "needs_you" }))).requests;
        const said = statusSentence(line!, { checksAvailable: false })!;
        expect(said).toContain("before your Keep was seen");
        expect(said).toContain(THEIRS.slice(0, 7));
        expect(said).toContain(NEW_HEAD.slice(0, 7));
      });

      it("a Replace that nobody answered with Keep is unchanged: the token is issued, the update lands, the authorization is spent and the row stays open", async () => {
        await replaced();
        const run = await claimedRun({ continues: { baseSha: BASE } });
        expect((await askToken(run)).status).toBe(200);
        expect((await report(run, { phase: "updated", head_sha: NEW_HEAD, tip_sha: NEW_TIP, branch: (await planeRow()).branch })).status).toBe(200);
        expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: NEW_HEAD, replace_authorized_head: null, managed_by_person_at: null });
        expect((await admin.query("SELECT 1 FROM run_events WHERE run_id = $1 AND kind = 'plane.updated_after_keep'", [run.id])).rowCount).toBe(0);
      });
    });

    it("every fix round has its attempt: the three of a first publish are not a limit on them, and they are numbered on their own", async () => {
      await open();
      for (let round = 1; round <= 5; round++) {
        const run = await claimedRun({ continues: { baseSha: BASE } });
        expect((await askToken(run)).status, `round ${round}`).toBe(200);
        await finish(run.id);
      }
      expect((await attempts()).map((a) => [a.kind, a.attempt_no])).toEqual([1, 2, 3, 4, 5].map((n) => ["fix_round", n]));
    });

    it("a fix round with no signed base is refused republish_base_missing: no token is minted, no attempt is spent", async () => {
      await open();
      const run = await claimedRun({ continues: {} });
      const res = await askToken(run);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: "republish_base_missing" } });
      expect(github.mints).toEqual([]);
      expect(await attempts()).toEqual([]);
    });

    it("D#598 P1g-1: a closed or merged public pull request, or a pairing that is off, is refused at the token in words: no token minted, no attempt, the item paused with the fixed sentence", async () => {
      const cases: Array<[string, string, string, string]> = [
        ["push row merged", "UPDATE plane_pushes SET state = 'pr_merged' WHERE work_item_id = $1", "republish_pr_merged", "Public PR already merged"],
        ["push row closed", "UPDATE plane_pushes SET state = 'pr_closed' WHERE work_item_id = $1", "republish_pr_closed", "Public PR closed"],
        ["item merged", "UPDATE work_items SET stage = 'merged' WHERE id = $1", "republish_pr_merged", "Public PR already merged"],
        ["item closed unmerged", "UPDATE work_items SET stage = 'closed_unmerged' WHERE id = $1", "republish_pr_closed", "Public PR closed"],
      ];
      for (const [name, sql, code, words] of cases) {
        await admin.query("DELETE FROM work_item_driver_events WHERE work_item_id = $1", [A.workItemId]);
        await admin.query("DELETE FROM plane_pushes WHERE work_item_id = $1", [A.workItemId]);
        await open();
        await admin.query(sql, [A.workItemId]);
        const run = await claimedRun({ continues: { baseSha: BASE } });
        const res = await askToken(run);
        expect(res.status, name).toBe(409);
        expect(res.body, name).toMatchObject({ error: { code } });
        expect(await facts(), name).toEqual([{ kind: "escalated", code }]);
        expect(FIX_ROUND_STOP_SENTENCE[code]!.startsWith(words), name).toBe(true);
        await finish(run.id);
      }
      expect(github.mints).toEqual([]);
      expect(await attempts()).toEqual([]);
    });

    it("D#598 P1g-1: a runner's follow-up report after a stop-class token refusal (an old runner says public_unavailable, a new one the stop's own code) does not overwrite the stop", async () => {
      const cases: Array<[string, string, string]> = [
        ["pairing off", "SELECT $1::uuid", "republish_pairing_off"],
        ["push row closed", "UPDATE plane_pushes SET state = 'pr_closed' WHERE work_item_id = $1", "republish_pr_closed"],
        ["push row merged", "UPDATE plane_pushes SET state = 'pr_merged' WHERE work_item_id = $1", "republish_pr_merged"],
      ];
      for (const [name, sql, code] of cases) {
        for (const reported of ["public_unavailable", code]) {
          await admin.query("DELETE FROM work_item_driver_events WHERE work_item_id = $1", [A.workItemId]);
          await admin.query("DELETE FROM plane_pushes WHERE work_item_id = $1", [A.workItemId]);
          await admin.query("DELETE FROM repo_pairing WHERE repo_id = $1", [A.repoId]);
          await open();
          await admin.query(sql, [A.workItemId]);
          if (code === "republish_pairing_off") await admin.query("DELETE FROM repo_pairing WHERE repo_id = $1", [A.repoId]);
          const run = await claimedRun({ continues: { baseSha: BASE } });
          expect((await askToken(run)).status, name).toBe(409);
          expect((await report(run, { phase: "refused", code: reported })).status, `${name} / ${reported}`).toBe(200);
          expect(await facts(), `${name} / ${reported}`).toEqual([{ kind: "escalated", code }]);
          expect(await stageOf(), name).toBe("needs_human");
          expect((await getWorkItemActivity({ pool: adminPool, principal: { accountId: A.accountId, userId: A.userId } }, A.workItemId)).notice, `${name} / ${reported}`).toEqual({ kind: "public_update_stopped", reason: FIX_ROUND_STOP_SENTENCE[code] });
          await finish(run.id);
        }
      }
    });

    it("D#598 P1g-1: a pairing that is gone while the public pull request is open: republish_pairing_off at the token, the item in Needs a person with its sentence", async () => {
      await open();
      await admin.query("DELETE FROM repo_pairing WHERE repo_id = $1", [A.repoId]);
      const run = await claimedRun({ continues: { baseSha: BASE } });
      const res = await askToken(run);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: "republish_pairing_off" } });
      expect(await facts()).toEqual([{ kind: "escalated", code: "republish_pairing_off" }]);
      expect(await stageOf()).toBe("needs_human");
      expect((await getWorkItemActivity({ pool: adminPool, principal: { accountId: A.accountId, userId: A.userId } }, A.workItemId)).notice).toEqual({ kind: "public_update_stopped", reason: REPUBLISH_PAIRING_OFF_SENTENCE });
      expect(github.mints).toEqual([]);
      expect(await attempts()).toEqual([]);
    });

    it("D#598 P1g-1: the hook's second 'public main moved' refusal is recorded as republish_tip_moved with the fixed sentence; the stamp stays", async () => {
      await open();
      const run = await claimedRun({ continues: { baseSha: BASE } });
      await askToken(run);
      expect((await report(run, { phase: "refused", code: "public_tip_moved" })).status).toBe(200);
      expect(await facts()).toEqual([{ kind: "escalated", code: "republish_tip_moved" }]);
      expect(await stageOf()).toBe("needs_human");
      expect((await getWorkItemActivity({ pool: adminPool, principal: { accountId: A.accountId, userId: A.userId } }, A.workItemId)).notice).toEqual({ kind: "public_update_stopped", reason: REPUBLISH_TIP_MOVED_SENTENCE });
      expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: HEAD });
    });

    it("an unsigned fix round on an open pull request is refused at the token, and its refusal report puts the item in Needs a person", async () => {
      await open();
      const run = await claimedRun({ continues: {} });
      expect((await askToken(run)).status).toBe(409);
      expect((await report(run, { phase: "refused", code: "republish_base_missing" })).status).toBe(200);
      expect(await facts()).toEqual([{ kind: "escalated", code: "republish_base_missing" }]);
      expect(await stageOf()).toBe("needs_human");
      expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: HEAD });
    });

    it("a fix round on an item whose pull request a person took over, or whose branch is pushed without a pull request, is told it has nothing to push to", async () => {
      await open();
      await admin.query("UPDATE plane_pushes SET managed_by_person_at = now() WHERE work_item_id = $1", [A.workItemId]);
      const managed = await claimedRun({ continues: { baseSha: BASE } });
      expect((await askToken(managed)).status).toBe(403);
      await finish(managed.id);
      await admin.query("UPDATE plane_pushes SET managed_by_person_at = NULL, state = 'pushed', pr_number = NULL, pr_url = NULL WHERE work_item_id = $1", [A.workItemId]);
      const pushed = await claimedRun({ continues: {} });
      expect((await askToken(pushed)).status).toBe(403);
      expect(github.mints).toEqual([]);
    });

    it("an update goes through the same mint as a first push, for the runner's own account: a pairing whose installation is another account's is refused app_not_installed, with nothing minted or issued", async () => {
      await open();
      const run = await claimedRun({ continues: { baseSha: BASE } });
      github.mintError = Object.assign(new Error("refused"), { code: "code_repo_installation_not_owned" });
      const res = await askToken(run);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: "app_not_installed" } });
      expect(github.mintedFor).toEqual([A.accountId]);
      const [attempt] = await attempts();
      expect(attempt).toMatchObject({ kind: "fix_round", token_issued_at: null, outcome: "code_repo_installation_not_owned" });
      expect(await planeRow()).toMatchObject({ head_sha: HEAD });
    });

    // D#598 P1g-3a-3: the round a person's confirmed Replace started adds nothing and publishes the branch tip. The marker is the cloud's own run event, written in the round's create transaction (startFix);
    // here it is written the same way. A runner can only ASK (`at_tip`), and only a runner that listed `tip_publish_v1` is ever answered.
    describe("the branch tip is granted to the marked round only (tip_publish_v1)", () => {
      const SHOWN = "b".repeat(40);
      const capable = (caps: string[] = ["tip_publish_v1"]) => admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[]) ON CONFLICT (runner_id) DO UPDATE SET capabilities = EXCLUDED.capabilities", [runner, A.accountId, caps]);
      const mark = (id: string) => withTenant(writerPool, A.accountId, (c) => insertRunEvent(c, A.accountId, id, RUNNER_REPLACE_ROUND_KIND, {}));
      const askTip = (run: { id: string; generation: number }, extra: Record<string, unknown> = {}) => token({ run_id: run.id, lease_generation: run.generation, at_tip: true, ...extra });
      const eventsOf = async (id: string, kind: string) => (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = $2", [id, kind])).rows.map((r) => r.payload);
      const nothingWritten = async (id: string) => {
        expect(await attempts()).toEqual([]);
        expect(github.mints).toEqual([]);
        expect(await eventsOf(id, "plane.update_lease")).toEqual([]);
      };

      it("the marked round of a runner that listed the capability is granted an update with the lease on the head the person was shown; the report then moves the stamp and spends the authorization", async () => {
        await open();
        await admin.query("UPDATE plane_pushes SET replace_authorized_head = $2 WHERE work_item_id = $1", [A.workItemId, SHOWN]);
        await capable();
        const run = await claimedRun({ continues: { baseSha: BASE } });
        await mark(run.id);
        const res = await askTip(run);
        expect(res.status).toBe(200);
        expect(PlanePushTokenReply.parse(res.body).replaces_head).toBe(SHOWN);
        expect(await eventsOf(run.id, "plane.update_lease")).toEqual([{ head: SHOWN }]);
        const [attempt, ...rest] = await attempts();
        expect(rest).toEqual([]);
        expect(attempt).toMatchObject({ run_id: run.id, kind: "fix_round", attempt_no: 1 });
        expect((await report(run, { phase: "updated", head_sha: NEW_HEAD, tip_sha: NEW_TIP, branch: (await planeRow()).branch })).status).toBe(200);
        expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: NEW_HEAD, tip_sha: NEW_TIP, replace_authorized_head: null });
        expect((await attempts())[0]).toMatchObject({ outcome: "updated" });
      });

      it("an ordinary round that asks for the tip is refused no_changes with nothing written: no attempt, no mint, no lease event, and the item is left as it was", async () => {
        await open();
        await capable();
        const run = await claimedRun({ continues: { baseSha: BASE } });
        const res = await askTip(run);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ error: { code: "no_changes" } });
        await nothingWritten(run.id);
        expect(await facts()).toEqual([]);
        expect(await stageOf()).toBe("changes_requested");
        // The same round, asking the ordinary way, is still granted exactly as before.
        expect((await askToken(run)).status).toBe(200);
      });

      it("the marked round of a runner that did NOT list the capability (an older daemon, a lapsed hello) is refused the same way", async () => {
        await open();
        const run = await claimedRun({ continues: { baseSha: BASE } });
        await mark(run.id);
        for (const caps of [null, [], ["plane_merge_v1", "ordered_facts_v1"]]) {
          await admin.query("DELETE FROM runner_capabilities WHERE runner_id = $1", [runner]);
          if (caps !== null) await capable(caps);
          const res = await askTip(run);
          expect(res.status, JSON.stringify(caps)).toBe(409);
          expect(res.body).toMatchObject({ error: { code: "no_changes" } });
        }
        await nothingWritten(run.id);
      });

      it("a runner cannot make a round the marked one: only `at_tip: true` is accepted, and a key that names the marker, a head or a branch is a strict-parse 400", async () => {
        await open();
        await capable();
        const run = await claimedRun({ continues: { baseSha: BASE } });
        for (const extra of [{ replace_round: true }, { marker: "plane.replace_round" }, { head_sha: HEAD }, { replaces_head: SHOWN }, { at_tip: false }, { at_tip: "true" }]) {
          const res = await askTip(run, extra);
          expect(res.status, JSON.stringify(extra)).toBe(400);
        }
        // The claim in the message changes nothing: the unmarked round is refused, whatever it said.
        expect((await askTip(run)).status).toBe(409);
        await nothingWritten(run.id);
        // And a run event a runner could post (the `runner.event` kind) is not the marker.
        await withTenant(writerPool, A.accountId, (c) => insertRunEvent(c, A.accountId, run.id, "runner.event", { type: RUNNER_REPLACE_ROUND_KIND }));
        expect((await askTip(run)).status).toBe(409);
      });

      it("an older daemon (no request) on the marked round: the round is reported as no change and the item stops for a person with the fixed sentence; nothing is minted or published", async () => {
        await open();
        await capable();
        const run = await claimedRun({ continues: { baseSha: BASE } });
        await mark(run.id);
        expect((await report(run, { phase: "no_change" })).status).toBe(200);
        await nothingWritten(run.id);
        // The Replace round has its own sentence: it does not say to build again (the Replace is spent and a rebuild is refused while the pull request is open).
        expect(await facts()).toEqual([{ kind: "escalated", code: "republish_replace_no_change" }]);
        expect(await stageOf()).toBe("needs_human");
        expect((await getWorkItemActivity({ pool: adminPool, principal: { accountId: A.accountId, userId: A.userId } }, A.workItemId)).notice).toEqual({ kind: "needs_human", reason: REPUBLISH_REPLACE_NO_CHANGE_SENTENCE });
        expect(REPUBLISH_REPLACE_NO_CHANGE_SENTENCE).not.toMatch(/Build again/);
        expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: HEAD });
      });

      it("a head that moved since the person confirmed (the remote refuses the lease) is reported refused public_branch_moved: the stale authorization is cleared and the request is raised again with the head seen", async () => {
        const PERSON = "7".repeat(40);
        await open();
        await admin.query("UPDATE plane_pushes SET replace_authorized_head = $2 WHERE work_item_id = $1", [A.workItemId, SHOWN]);
        await capable();
        const run = await claimedRun({ continues: { baseSha: BASE } });
        await mark(run.id);
        expect((await askTip(run)).status).toBe(200);
        const original = port.branchHead;
        try {
          port.branchHead = async () => PERSON;
          expect((await report(run, { phase: "refused", code: "public_branch_moved" })).status).toBe(200);
        } finally {
          port.branchHead = original;
        }
        expect(await facts()).toEqual([{ kind: "escalated", code: "republish_branch_moved" }]);
        // The stale authorization is cleared and the record waits for a new answer; nothing was published.
        expect(await planeRow()).toMatchObject({ state: "waiting_person_pushed", head_sha: HEAD, replace_authorized_head: null });
        const raised = await admin.query("SELECT seen_head FROM setup_requests WHERE account_id = $1 AND kind = 'branch_pushed_by_person' AND state = 'open'", [A.accountId]);
        expect(raised.rows).toEqual([{ seen_head: PERSON }]);
      });

      // D#598 P1g-3a-3: a refusal that is not about the branch (GitHub could not be reached) must not strand a person whose Replace it just spent: the question is asked again, with the branch as it is now.
      describe("a refusal that maps to republish_failed", () => {
        const PERSON = "7".repeat(40);
        const openRequests = async () => (await admin.query("SELECT seen_head FROM setup_requests WHERE account_id = $1 AND kind = 'branch_pushed_by_person' AND state = 'open'", [A.accountId])).rows;
        const roundsOf = async () => Number((await admin.query("SELECT (SELECT count(*) FROM agent_runs WHERE work_item_id = $1) + (SELECT count(*) FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'fix_round_started') AS n", [A.workItemId])).rows[0].n);
        const refuse = async (run: { id: string; generation: number }) => {
          const original = port.branchHead;
          try {
            port.branchHead = async () => PERSON;
            return await report(run, { phase: "refused", code: "public_unavailable" });
          } finally {
            port.branchHead = original;
          }
        };

        it("on the round a person's Replace started: the authorization is spent, one request is open with the live head, no round is started, and the sentence does not say to build again", async () => {
          await open();
          await admin.query("UPDATE plane_pushes SET replace_authorized_head = $2 WHERE work_item_id = $1", [A.workItemId, SHOWN]);
          await capable();
          const run = await claimedRun({ continues: { baseSha: BASE } });
          await mark(run.id);
          expect((await askTip(run)).status).toBe(200);
          const rounds = await roundsOf();
          expect((await refuse(run)).status).toBe(200);
          expect(await facts()).toEqual([{ kind: "escalated", code: "republish_replace_failed" }]);
          expect(await stageOf()).toBe("needs_human");
          expect(await planeRow()).toMatchObject({ state: "waiting_person_pushed", head_sha: HEAD, replace_authorized_head: null });
          expect(await openRequests()).toEqual([{ seen_head: PERSON }]);
          expect(await roundsOf()).toBe(rounds);
          const notice = (await getWorkItemActivity({ pool: adminPool, principal: { accountId: A.accountId, userId: A.userId } }, A.workItemId)).notice;
          expect(notice).toEqual({ kind: "needs_human", reason: REPUBLISH_REPLACE_FAILED_SENTENCE });
          expect(REPUBLISH_REPLACE_FAILED_SENTENCE).not.toMatch(/Build again/);
          // The same refusal said again raises nothing new: still one open request.
          expect((await refuse(run)).status).toBe(200);
          expect(await openRequests()).toEqual([{ seen_head: PERSON }]);
        });

        // D#598 P1g-3a-3: the same rule for every end of a marked round that is not a landed update.
        it.each([
          ["a round that made no change", { phase: "no_change" }, "republish_replace_no_change"],
          ["the public main moving twice", { phase: "refused", code: "public_tip_moved" }, "republish_replace_tip_moved"],
        ])("on the round a person's Replace started, %s: recorded as %s's code, one request is open with the live head, and the sentence does not say to build again", async (_label, body, code) => {
          await open();
          await admin.query("UPDATE plane_pushes SET replace_authorized_head = $2 WHERE work_item_id = $1", [A.workItemId, SHOWN]);
          await capable();
          const run = await claimedRun({ continues: { baseSha: BASE } });
          await mark(run.id);
          const original = port.branchHead;
          try {
            port.branchHead = async () => PERSON;
            expect((await report(run, body)).status).toBe(200);
          } finally {
            port.branchHead = original;
          }
          expect(await facts()).toEqual([{ kind: "escalated", code }]);
          expect(await planeRow()).toMatchObject({ state: "waiting_person_pushed", replace_authorized_head: null });
          expect(await openRequests()).toEqual([{ seen_head: PERSON }]);
          expect(FIX_ROUND_STOP_SENTENCE[code]).toBeDefined();
          expect(FIX_ROUND_STOP_SENTENCE[code]).not.toMatch(/Build again/);
          expect((await getWorkItemActivity({ pool: adminPool, principal: { accountId: A.accountId, userId: A.userId } }, A.workItemId)).notice).toMatchObject({ reason: FIX_ROUND_STOP_SENTENCE[code] });
        });

        it("on an ordinary round (no marker) it stays as it was: the old sentence, nothing raised, the record still follows the pull request", async () => {
          await open();
          const run = await claimedRun({ continues: { baseSha: BASE } });
          expect((await askToken(run)).status).toBe(200);
          expect((await refuse(run)).status).toBe(200);
          expect(await facts()).toEqual([{ kind: "escalated", code: "republish_failed" }]);
          expect(await openRequests()).toEqual([]);
          expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: HEAD });
          expect((await getWorkItemActivity({ pool: adminPool, principal: { accountId: A.accountId, userId: A.userId } }, A.workItemId)).notice).toEqual({ kind: "needs_human", reason: REPUBLISH_FAILED_SENTENCE });
        });
      });
    });

    it("a fresh run (not a continuation) is granted as it always was: no head to replace, a push attempt", async () => {
      await open();
      const run = await claimedRun();
      const reply = PlanePushTokenReply.parse((await askToken(run)).body);
      expect(reply.replaces_head).toBeUndefined();
      expect((await attempts())[0]).toMatchObject({ kind: "push", attempt_no: 1 });
    });

    it("the update report moves the stamp to the verified head and tip, keeps the pull request, and ends the attempt; GitHub is asked first", async () => {
      await open();
      const run = await claimedRun({ continues: { baseSha: BASE } });
      await askToken(run);
      await admin.query("UPDATE plane_pushes SET source_head = $1 WHERE state = 'pr_opened'", ["e".repeat(40)]);
      expect((await report(run, { phase: "updated", head_sha: NEW_HEAD, tip_sha: NEW_TIP, branch: (await planeRow()).branch })).status).toBe(200);
      expect(github.asked).toEqual(["pushed"]);
      expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: NEW_HEAD, tip_sha: NEW_TIP, source_head: null, pr_number: 9 });
      expect((await attempts())[0]).toMatchObject({ outcome: "updated" });
      expect(await stageOf()).toBe("changes_requested");
    });

    it("an update GitHub does not confirm, or one reported for a pull request that is not open, changes no stamp: the item goes to a person with the fixed failure sentence", async () => {
      await open();
      const run = await claimedRun({ continues: { baseSha: BASE } });
      await askToken(run);
      github.pushed = false;
      expect((await report(run, { phase: "updated", head_sha: NEW_HEAD, tip_sha: NEW_TIP })).status).toBe(200);
      expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: HEAD, tip_sha: TIP });
      expect(await facts()).toEqual([{ kind: "escalated", code: "republish_failed" }]);
      expect(await stageOf()).toBe("needs_human");
      expect((await getWorkItemActivity({ pool: adminPool, principal: { accountId: A.accountId, userId: A.userId } }, A.workItemId)).notice).toEqual({ kind: "needs_human", reason: REPUBLISH_FAILED_SENTENCE });
    });

    it("a refusal because the public branch moved is recorded as republish_branch_moved and puts the item in Needs a person; the stamp stays", async () => {
      await open();
      const run = await claimedRun({ continues: { baseSha: BASE } });
      await askToken(run);
      expect((await report(run, { phase: "refused", code: "public_branch_moved" })).status).toBe(200);
      expect(await facts()).toEqual([{ kind: "escalated", code: "republish_branch_moved" }]);
      expect(await stageOf()).toBe("needs_human");
      expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: HEAD });
      // The card says so in the fixed words, read the way a person reads it.
      expect((await getWorkItemActivity({ pool: adminPool, principal: { accountId: A.accountId, userId: A.userId } }, A.workItemId)).notice).toEqual({ kind: "needs_human", reason: REPUBLISH_BRANCH_MOVED_SENTENCE });
      // The same report again records nothing new (one fact per round).
      await report(run, { phase: "refused", code: "public_branch_moved" });
      expect(await facts()).toHaveLength(1);
    });

    it("D#598 P1g-2: the same refusal on the runner path asks a person: the branch is read, one request holds the head seen, nothing is overwritten; an unreadable branch raises nothing", async () => {
      const PERSON = "7".repeat(40);
      await open();
      const run = await claimedRun({ continues: { baseSha: BASE } });
      await askToken(run);
      const original = port.branchHead;
      try {
        port.branchHead = async () => {
          throw new Error("public_unavailable");
        };
        expect((await report(run, { phase: "refused", code: "public_branch_moved" })).status).toBe(200);
        expect((await admin.query("SELECT 1 FROM setup_requests WHERE account_id = $1 AND kind = 'branch_pushed_by_person'", [A.accountId])).rowCount).toBe(0);
        port.branchHead = async () => PERSON;
        await report(run, { phase: "refused", code: "public_branch_moved" });
      } finally {
        port.branchHead = original;
      }
      const rows = (await admin.query<{ state: string; origin: string; created_by: string | null; seen_head: string }>("SELECT state, origin, created_by, seen_head FROM setup_requests WHERE account_id = $1 AND kind = 'branch_pushed_by_person'", [A.accountId])).rows;
      expect(rows).toEqual([{ state: "open", origin: "derived", created_by: null, seen_head: PERSON }]);
      expect(await planeRow()).toMatchObject({ state: "waiting_person_pushed", head_sha: HEAD });
    });

    it("only the run that was granted an update may move the stamp: an update report from a fresh run (a push attempt) records nothing", async () => {
      await open();
      const run = await claimedRun();
      await askToken(run);
      await report(run, { phase: "updated", head_sha: NEW_HEAD, tip_sha: NEW_TIP, branch: (await planeRow()).branch });
      expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: HEAD, tip_sha: TIP });
      // A continuation that never asked for a token has no grant either.
      await finish(run.id);
      const other = await claimedRun({ continues: { baseSha: BASE } });
      await report(other, { phase: "updated", head_sha: NEW_HEAD, tip_sha: NEW_TIP, branch: (await planeRow()).branch });
      expect(await planeRow()).toMatchObject({ head_sha: HEAD });
    });

    it("an update with nothing to publish is recorded and escalated with its own fixed sentence, so the public pull request does not go stale unseen", async () => {
      await open();
      const run = await claimedRun({ continues: { baseSha: BASE } });
      await askToken(run);
      expect((await report(run, { phase: "no_change" })).status).toBe(200);
      expect(await facts()).toEqual([{ kind: "escalated", code: "republish_no_change" }]);
      expect(await stageOf()).toBe("needs_human");
      expect((await getWorkItemActivity({ pool: adminPool, principal: { accountId: A.accountId, userId: A.userId } }, A.workItemId)).notice).toEqual({ kind: "needs_human", reason: REPUBLISH_NO_CHANGE_SENTENCE });
      expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: HEAD });
    });

    it("a first publication that changed nothing is unchanged: no escalation", async () => {
      await pair();
      await stamp();
      const run = await claimedRun();
      await askToken(run);
      await report(run, { phase: "no_change" });
      expect(await planeRow()).toMatchObject({ state: "no_public_change" });
      expect(await facts()).toEqual([]);
    });

    it("a refusal of a first publication is unchanged: recorded on the row, no escalation", async () => {
      await pair();
      await stamp();
      const run = await claimedRun();
      await askToken(run);
      await report(run, { phase: "refused", code: "scan_refused" });
      expect(await planeRow()).toMatchObject({ state: "refused", code: "scan_refused" });
      expect(await facts()).toEqual([]);
    });
  });

  describe("a fix round of an item whose first round never published creates the public pull request", () => {
    const BASE = "c".repeat(40);
    const finish = (id: string) => admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [id]);

    it.each([["no signed base", {}], ["a signed base", { baseSha: BASE }]])("a continuation with %s is granted a push, as a first publish: no head to replace, a push attempt", async (_label, continues) => {
      await pair();
      await stamp();
      const run = await claimedRun({ continues });
      const res = await askToken(run);
      expect(res.status).toBe(200);
      expect(PlanePushTokenReply.parse(res.body).replaces_head).toBeUndefined();
      expect((await attempts())[0]).toMatchObject({ run_id: run.id, kind: "push", attempt_no: 1 });
      expect(github.mints).toEqual(["acme/widgets-public"]);
    });

    it.each(["building", "refused", "scanning", "no_public_change"])("a record in the %s state that a person has taken over gets no first publish, with or without a base", async (state) => {
      await pair();
      await stamp();
      await admin.query("UPDATE plane_pushes SET state = $2, code = CASE WHEN $2 = 'refused' THEN 'scan_refused' END, managed_by_person_at = now() WHERE work_item_id = $1", [A.workItemId, state]);
      for (const continues of [{}, { baseSha: BASE }]) {
        const run = await claimedRun({ continues });
        expect((await askToken(run)).status).toBe(403);
        await finish(run.id);
      }
      expect(github.mints).toEqual([]);
      expect(await attempts()).toEqual([]);
    });

    it("its reports create the pull request exactly as a first round's do, and the item's record ends open (a stuck item recovers this way)", async () => {
      await pair();
      await stamp();
      const run = await claimedRun({ continues: {} });
      await askToken(run);
      expect((await report(run, { phase: "pushed", head_sha: HEAD, tip_sha: TIP })).status).toBe(200);
      expect(await planeRow()).toMatchObject({ state: "pushed", head_sha: HEAD });
      expect((await report(run, { phase: "pr_opened", head_sha: HEAD, tip_sha: TIP, pr_number: 9 })).status).toBe(200);
      expect(await planeRow()).toMatchObject({ state: "pr_opened", pr_number: 9, head_sha: HEAD });
      // The next fix round of the now-published item updates it, as today.
      await finish(run.id);
      const next = await claimedRun({ continues: { baseSha: BASE } });
      expect(PlanePushTokenReply.parse((await askToken(next)).body).replaces_head).toBe(HEAD);
      expect((await attempts()).map((a) => a.kind)).toEqual(["push", "fix_round"]);
    });

    it("a refused earlier attempt may be tried again by a later fix round, and the three push attempts of a record are still the limit", async () => {
      await pair();
      await stamp();
      for (let n = 1; n <= 3; n++) {
        const run = await claimedRun({ continues: {} });
        expect((await askToken(run)).status, `attempt ${n}`).toBe(200);
        await report(run, { phase: "refused", code: "scan_refused" });
        expect((await planeRow()).state).toBe("refused");
        await finish(run.id);
      }
      const fourth = await claimedRun({ continues: {} });
      const res = await askToken(fourth);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: "attempts_exhausted" } });
    });

    it("a pairing edited since the build started still stops it, and a continuation that already has a grant is not granted twice", async () => {
      await pair();
      await stamp();
      const run = await claimedRun({ continues: {} });
      expect((await askToken(run)).status).toBe(200);
      expect((await askToken(run)).status).toBe(409);
      await finish(run.id);
      await pair(["docs/ops/", "later/"]);
      const next = await claimedRun({ continues: {} });
      const res = await askToken(next);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: "pairing_changed" } });
    });
  });

  // D#519 MQ4-E1-B-RUNNER-ROUND-END: the end of a runner's merge-conflict round on a public copy, read from the platform's own rows.
  describe("a conflict round's republish is judged like a sandbox round's (C15-1 to C15-6)", () => {
    const BASE = "c".repeat(40);
    const NEW_HEAD = "d".repeat(40);
    const NEW_TIP = "e".repeat(40);
    const OLD_MAIN = "8".repeat(40);
    const MAIN = "9".repeat(40);
    async function open(): Promise<void> {
      await pair();
      await stamp();
      await admin.query("UPDATE plane_pushes SET state = 'pr_opened', head_sha = $2, tip_sha = $3, pr_number = 9, pr_url = 'https://github.com/acme/widgets-public/pull/9' WHERE work_item_id = $1", [A.workItemId, HEAD, TIP]);
      await admin.query("UPDATE work_items SET stage = 'changes_requested' WHERE id = $1", [A.workItemId]);
    }
    /** A claimed continuation signed with a base; with `conflict`, the item's round row names it (the marker). */
    async function round(conflict: boolean, base: string | null = BASE) {
      const run = await claimedRun({ continues: base === null ? {} : { baseSha: base } });
      if (conflict) {
        const started = await mergeQueue.startEntrylessConflictRound(admin as never, { accountId: A.accountId, workItemId: A.workItemId, fromSha: HEAD, baseSha: BASE, baseRef: "main", conflictFiles: ["a.txt"] });
        if (!started.ok) throw new Error("no round");
        await mergeQueue.recordRoundRun(admin as never, { accountId: A.accountId, roundId: started.round.id, runId: run.id });
      }
      return run;
    }
    const roundTips = async (id: string) => (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'plane.round_tip'", [id])).rows.map((r) => r.payload);
    const readOutcome = (id: string) => mergeQueue.readRepublishOutcome(admin as never, { accountId: A.accountId, runId: id } as never);
    const outcomeOf = async (id: string) => {
      await admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [id]);
      return readOutcome(id);
    };
    const updated = (run: { id: string; generation: number }, tip: string) => report(run, { phase: "updated", head_sha: NEW_HEAD, tip_sha: tip });

    it("C15-1: the grant of a conflict round records the public main tip it read (main of the paired repository only); a review round records none and reads nothing", async () => {
      await open();
      const r = await round(true);
      expect((await askToken(r)).status).toBe(200);
      expect(github.heads).toEqual(["acme/widgets-public@main"]);
      expect(await roundTips(r.id)).toEqual([{ tip: MAIN }]);
      await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [r.id]);
      const review = await round(false);
      expect((await askToken(review)).status).toBe(200);
      expect(github.heads).toHaveLength(1);
      expect(await roundTips(review.id)).toEqual([]);
    });

    it("C15-2: a republish on the recorded tip is accepted though main has moved since; it moves the stamp and the round reads done", async () => {
      await open();
      const r = await round(true);
      await askToken(r);
      github.mainTip = NEW_TIP;
      expect((await updated(r, MAIN)).status).toBe(200);
      expect(await planeRow()).toMatchObject({ head_sha: NEW_HEAD, tip_sha: MAIN });
      expect(await outcomeOf(r.id)).toBe("done");
    });

    it("C15-2: with no tip recorded (the grant could not read one), only the main tip read at the report is accepted", async () => {
      await open();
      const r = await round(true);
      github.mainTip = null;
      await askToken(r);
      expect(await roundTips(r.id)).toEqual([]);
      github.mainTip = OLD_MAIN;
      expect((await updated(r, OLD_MAIN)).status).toBe(200);
      expect(await outcomeOf(r.id)).toBe("done");
    });

    it("C15-4/-5: a tip that is neither the recorded one nor main's now ends history_rewritten, whatever the hook says; the stamp stays and the item goes to a person", async () => {
      await open();
      const r = await round(true);
      await askToken(r);
      github.mainTip = NEW_TIP;
      expect((await updated(r, OLD_MAIN)).status).toBe(200);
      expect(github.asked).toEqual([]);
      expect(await planeRow()).toMatchObject({ head_sha: HEAD, tip_sha: TIP });
      expect((await attempts())[0]).toMatchObject({ outcome: "history_rewritten" });
      expect(await outcomeOf(r.id)).toBe("history_rewritten");
      expect((await admin.query("SELECT stage FROM work_items WHERE id = $1", [A.workItemId])).rows[0].stage).toBe("needs_human");
    });

    it("C15-4: a head GitHub does not confirm (two parents, or not the branch head) ends history_rewritten even on the right tip", async () => {
      await open();
      const r = await round(true);
      await askToken(r);
      github.pushed = false;
      expect((await updated(r, MAIN)).status).toBe(200);
      expect(github.asked).toEqual(["pushed"]);
      expect(await planeRow()).toMatchObject({ head_sha: HEAD });
      expect(await outcomeOf(r.id)).toBe("history_rewritten");
    });

    it("C15-6: a review round is judged as before: any tip is only checked by GitHub, no main read, no history label", async () => {
      await open();
      const r = await round(false);
      await askToken(r);
      expect((await updated(r, OLD_MAIN)).status).toBe(200);
      expect(github.heads).toEqual([]);
      expect(await planeRow()).toMatchObject({ head_sha: NEW_HEAD });
      await admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [r.id]);
      github.pushed = false;
      const again = await round(false);
      await askToken(again);
      await updated(again, OLD_MAIN);
      expect((await attempts()).at(-1)).toMatchObject({ outcome: "report_mismatch" });
    });

    it("C15-3: the hook's lease refusal (public_branch_moved) reads branch_moved for a conflict round, with nothing moved on GitHub; a review round's attempt keeps its label", async () => {
      await open();
      const r = await round(true);
      await askToken(r);
      expect((await report(r, { phase: "refused", code: "public_branch_moved" })).status).toBe(200);
      expect(github.asked).toEqual([]);
      expect(await planeRow()).toMatchObject({ head_sha: HEAD, tip_sha: TIP });
      expect(await outcomeOf(r.id)).toBe("branch_moved");
      const review = await round(false);
      await askToken(review);
      await report(review, { phase: "refused", code: "public_branch_moved" });
      expect((await attempts()).at(-1)).toMatchObject({ outcome: "public_branch_moved" });
    });

    it("any other failure reads failed, and a round the hook has not reported on reads pending", async () => {
      await open();
      const waiting = await round(true);
      await askToken(waiting);
      expect(await outcomeOf(waiting.id)).toBe("pending");
      await admin.query("UPDATE agent_runs SET status = 'running' WHERE id = $1", [waiting.id]);
      await report(waiting, { phase: "refused", code: "scan_refused" });
      expect(await outcomeOf(waiting.id)).toBe("failed");
    });

    it("a runner round whose job carries no base is no republishing round: none", async () => {
      await open();
      const run = await round(true, null);
      expect(await outcomeOf(run.id)).toBe("none");
    });
  });
});
