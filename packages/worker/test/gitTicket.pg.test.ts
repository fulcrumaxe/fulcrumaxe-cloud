import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GIT_TICKET_PATH, GitTicketReply, MAX_CREATED_SKEW_SECONDS, RUNNER_LEASE_SECONDS, redactDeep, redactText, sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { GIT_TICKET_CLOCK_TOLERANCE_SECONDS, GIT_TICKET_LIFETIME_SECONDS, GIT_TICKET_REF_PATTERN, createRunnerGitTicketKeys, verifyRunnerGitTicket } from "@fx/github";
import { RUNNER_RUN_BRANCH, githubProxyForwardUrl, loadGithubForwardConfig } from "@fx/runner";
import { branchOf, gitTicketRun, toResponse, type RunnerCloudDeps, type RunnerLeaseOps } from "@fx/runner-cloud";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { createRunnerGitTicketFacade } from "../src/runnerGitTicket.js";
import { ORIGIN, newKey, signed, type TestKey } from "../../runner-cloud/test/helpers.js";

/**
 * [pg] D#6 R5a-2b (C27 section 1, criteria 1 and 2): the whole path of a ticket request against the real fence (0754), the real run rows and
 * the real signer: the route, the worker's two methods, and the verifier the proxy will use. Nothing here is a stand-in except the clock.
 *
 * STAND-IN FOR MIGRATION 0765 (R5a-2a). A `runner_verified` run cannot exist until 0765 widens `agent_runs_execution_mode_check`. Until that
 * migration is on this branch, `beforeAll` widens the check the same way (add the one value; the one-way runtime check is not needed here) and
 * `afterAll` puts it back, so the other files in this package see the schema they expect. Once 0765 has merged this block is a no-op (the value is
 * already allowed) and should be deleted.
 */
const MODE_CHECK = "agent_runs_execution_mode_check";

describe("git ticket: claim -> ticket -> verify [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let widened = false;
  const signing = generateKeyPairSync("ed25519").privateKey;
  const ticketKeys = generateKeyPairSync("ed25519");
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  let clock = T0;
  let A: SeedRefs;
  let runner: string;
  let key: TestKey;
  let claims: ReturnType<typeof createRunnerClaimFacade>;
  const env = { FX_GH_FORWARD_HOST: "proxy.example.test", FX_GH_FORWARD_SUFFIX: "example.test" };
  const AUDIENCE = githubProxyForwardUrl(loadGithubForwardConfig(env));
  const jwks = { keys: [{ ...(ticketKeys.publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string }), kid: "tk1" }] };
  const verifyDeps = () => ({ keys: createRunnerGitTicketKeys(jwks)!, issuer: ORIGIN, audience: AUDIENCE, now: () => new Date(clock) });

  const tickets = (over: { signer?: null } = {}) =>
    createRunnerGitTicketFacade(writerPool, { now: () => clock, signer: over.signer === null ? null : { keyId: "tk1", privateKey: ticketKeys.privateKey }, audience: AUDIENCE });
  const ops = (t = tickets()): RunnerLeaseOps => ({ ...claims, gitTicketContext: t.gitTicketContext, signGitTicket: t.signGitTicket }) as RunnerLeaseOps;
  const deps = (t = tickets()): RunnerCloudDeps => ({ appUserPool: appPool, origin: ORIGIN, failRunnerLeases: null, leases: ops(t), now: () => new Date(clock) });
  const ask = (body: unknown, k: TestKey = key, d: RunnerCloudDeps = deps(), nonce?: string) => toResponse(() => gitTicketRun(d, signed(k, GIT_TICKET_PATH, body, { created: Math.floor(clock / 1000), ...(nonce ? { nonce } : {}) })));

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    claims = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => clock, randomBetween: (min) => min });
    const present = await admin.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1 AND conrelid = 'agent_runs'::regclass`, [MODE_CHECK]);
    if (!String(present.rows[0]?.def).includes("runner_verified")) {
      await admin.query(`ALTER TABLE agent_runs DROP CONSTRAINT ${MODE_CHECK}`);
      await admin.query(`ALTER TABLE agent_runs ADD CONSTRAINT ${MODE_CHECK} CHECK (execution_mode IS NULL OR execution_mode IN ('sandbox', 'runner_local', 'runner_verified'))`);
      widened = true;
    }
  });
  afterAll(async () => {
    if (widened) {
      await withoutIdentityTrigger(() => admin.query(`UPDATE agent_runs SET execution_mode = 'runner_local' WHERE execution_mode = 'runner_verified'`));
      await admin.query(`ALTER TABLE agent_runs DROP CONSTRAINT ${MODE_CHECK}`);
      await admin.query(`ALTER TABLE agent_runs ADD CONSTRAINT ${MODE_CHECK} CHECK (execution_mode IS NULL OR execution_mode IN ('sandbox', 'runner_local'))`);
    }
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });
  beforeEach(async () => {
    clock = T0;
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [A.repoId]);
    key = newKey();
    runner = await insertRunner(admin, A.accountId, A.userId, { jwk: key.jwk, jkt: key.jkt, credentialMode: "api_key" });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [runner, [A.repoId]]);
  });

  async function withoutIdentityTrigger(run: () => Promise<unknown>): Promise<void> {
    await admin.query("ALTER TABLE agent_runs DISABLE TRIGGER agent_runs_dispatch_identity_write_once");
    try {
      await run();
    } finally {
      await admin.query("ALTER TABLE agent_runs ENABLE TRIGGER agent_runs_dispatch_identity_write_once");
    }
  }

  /** A pending runner run with a real signed job; claimed; then (optionally) moved to the cloud-verified mode as 0765's runs will be. */
  async function claimedRun(o: { mode?: "runner_local" | "runner_verified"; role?: string; continues?: { branch: string } } = {}): Promise<{ id: string; generation: number }> {
    const id = randomUUID();
    const job: Job = {
      schema_version: 1,
      job_id: randomUUID(),
      run_id: id,
      repo: { id: A.repoId, owner: "acme", name: "widgets", private: true },
      role: (o.role ?? "executor") as Job["role"],
      mode: o.mode === "runner_verified" ? "verified" : "local",
      spec: null,
      task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") },
      role_card: { text: "c", sha256: sha256Text("c") },
      role_tools_sha256: "a".repeat(64),
      continues: o.continues ? { parent_run_id: randomUUID(), session_id: "sess-1", branch: o.continues.branch } : null,
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
    const claimedRun = await claims.claimRunnerRun({ accountId: A.accountId, runnerId: runner });
    if (claimedRun.kind !== "claimed" || claimedRun.runId !== id) throw new Error("not claimed");
    // Until R5b's claim hands out `runner_verified` runs, the only way to hold one claimed is to change the mode after the claim, which the write-once
    // trigger forbids to every login; the owner pauses it for this one statement. The run is then exactly what R5b's claim will leave behind.
    if (o.mode === "runner_verified") await withoutIdentityTrigger(() => admin.query("UPDATE agent_runs SET execution_mode = 'runner_verified' WHERE id = $1", [id]));
    return { id, generation: claimedRun.leaseGeneration };
  }
  const leaseEnd = async (id: string): Promise<number> => (await admin.query("SELECT lease_expires_at FROM agent_runs WHERE id = $1", [id])).rows[0].lease_expires_at.getTime();

  describe("the ticket for a held cloud-verified run", () => {
    it("is accepted by verifyRunnerGitTicket with exactly the ruling's claims, exp - iat = 300, and ref = the fresh run's branch", async () => {
      const { id, generation } = await claimedRun({ mode: "runner_verified" });
      clock = T0 + 20_000;
      const res = await ask({ run_id: id, lease_generation: generation });
      expect(res.status).toBe(200);
      const reply = GitTicketReply.parse(res.body);
      expect(reply.proxy_origin).toBe("https://proxy.example.test");
      const verified = await verifyRunnerGitTicket(reply.ticket, verifyDeps());
      expect(verified).toMatchObject({
        issuer: ORIGIN,
        audience: AUDIENCE,
        runnerId: runner,
        accountId: A.accountId,
        runId: id,
        leaseGeneration: generation,
        repo: { id: A.repoId, owner: "acme", name: "widgets" },
        ref: `fx/${id}-g${generation}`,
      });
      expect(verified.expiresAt - verified.issuedAt).toBe(300);
      expect(verified.issuedAt).toBe(Math.floor(clock / 1000));
      expect(new Date(reply.expires_at).getTime()).toBe(verified.expiresAt * 1000);
      const body = JSON.parse(Buffer.from(reply.ticket.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["acct", "aud", "exp", "gen", "iat", "iss", "jti", "nbf", "ref", "repo", "run", "sub"]);
      expect(AUDIENCE).toBe("https://proxy.example.test/api/gh-proxy");
    });

    it("names a fix round's own branch, the one in its signed job", async () => {
      const earlier = randomUUID();
      const { id, generation } = await claimedRun({ mode: "runner_verified", continues: { branch: `fx/${earlier}-g3` } });
      const res = await ask({ run_id: id, lease_generation: generation });
      expect(res.status).toBe(200);
      expect((await verifyRunnerGitTicket(GitTicketReply.parse(res.body).ticket, verifyDeps())).ref).toBe(`fx/${earlier}-g3`);
    });

    it("does not extend the lease: asking for a ticket is not a sign of life", async () => {
      const { id, generation } = await claimedRun({ mode: "runner_verified" });
      const before = await leaseEnd(id);
      clock = T0 + 30_000;
      expect((await ask({ run_id: id, lease_generation: generation })).status).toBe(200);
      expect(await leaseEnd(id)).toBe(before);
      expect(before).toBe(T0 + RUNNER_LEASE_SECONDS * 1000);
      // And the lease still runs out on its own clock: past its end, the same request is a stop.
      clock = T0 + RUNNER_LEASE_SECONDS * 1000;
      expect((await ask({ run_id: id, lease_generation: generation })).body).toEqual({ continue: false, reason: "lease_expired" });
    });

    it("keeps the run's own mode: switching the repository back to runner_local mid-run does not take the ticket away", async () => {
      const { id, generation } = await claimedRun({ mode: "runner_verified" });
      await admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [A.repoId]);
      expect((await ask({ run_id: id, lease_generation: generation })).status).toBe(200);
    });

    it("is not made for a run whose own mode is runner_local, even when the repository is cloud-verified", async () => {
      const { id, generation } = await claimedRun({ mode: "runner_local" });
      const res = await ask({ run_id: id, lease_generation: generation });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: "not_cloud_verified" } });
      expect(JSON.stringify(res.body)).not.toMatch(/eyJ/);
    });
  });

  describe("the fence (the same 409 reply heartbeat gives)", () => {
    it("a stale generation, another runner's run and an unknown run are 409 stale_generation", async () => {
      const { id, generation } = await claimedRun({ mode: "runner_verified" });
      expect((await ask({ run_id: id, lease_generation: generation + 1 })).body).toEqual({ continue: false, reason: "stale_generation" });
      const otherKey = newKey();
      await insertRunner(admin, A.accountId, A.userId, { jwk: otherKey.jwk, jkt: otherKey.jkt, credentialMode: "api_key" });
      const other = await ask({ run_id: id, lease_generation: generation }, otherKey);
      expect(other.status).toBe(409);
      expect(other.body).toEqual({ continue: false, reason: "stale_generation" });
      expect((await ask({ run_id: randomUUID(), lease_generation: generation })).body).toEqual({ continue: false, reason: "stale_generation" });
    });

    it("an ended run is 409 run_terminal, whichever way it ended", async () => {
      for (const status of ["cancelled", "failed", "succeeded", "timed_out"]) {
        const { id, generation } = await claimedRun({ mode: "runner_verified" });
        await admin.query("UPDATE agent_runs SET status = $2 WHERE id = $1", [id, status]);
        const res = await ask({ run_id: id, lease_generation: generation });
        expect(res.status, status).toBe(409);
        expect(res.body, status).toEqual({ continue: false, reason: "run_terminal" });
        await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [id]);
        clock = T0;
      }
    });

    it("a run past its wall clock is 409 wall_clock_limit", async () => {
      const { id, generation } = await claimedRun({ mode: "runner_verified" });
      const started = (await admin.query("SELECT started_at FROM agent_runs WHERE id = $1", [id])).rows[0].started_at.getTime() as number;
      await admin.query("UPDATE agent_runs SET lease_expires_at = to_timestamp($2 / 1000.0) WHERE id = $1", [id, started + 3 * 3_600_000]);
      clock = started + 7_200_001;
      expect((await ask({ run_id: id, lease_generation: generation })).body).toEqual({ continue: false, reason: "wall_clock_limit" });
    });
  });

  describe("authentication and settings", () => {
    it("a revoked or unknown runner is 401, an unsigned request is 401, and a reused nonce is 409 nonce_reused", async () => {
      const { id, generation } = await claimedRun({ mode: "runner_verified" });
      const body = { run_id: id, lease_generation: generation };
      expect((await ask(body, newKey())).status).toBe(401);
      const unsigned = signed(key, GIT_TICKET_PATH, body);
      const { signature: _s, "signature-input": _i, ...headers } = unsigned.headers;
      expect((await toResponse(() => gitTicketRun(deps(), { ...unsigned, headers }))).status).toBe(401);
      expect((await ask(body, key, deps(), "r".repeat(22))).status).toBe(200);
      const again = await ask(body, key, deps(), "r".repeat(22));
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ error: { code: "nonce_reused" } });
      await admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runner]);
      expect((await ask(body)).status).toBe(401);
    });

    it("with no signing key the route is 503 not_configured and signs nothing", async () => {
      const { id, generation } = await claimedRun({ mode: "runner_verified" });
      const res = await ask({ run_id: id, lease_generation: generation }, key, deps(tickets({ signer: null })));
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: { code: "not_configured" } });
    });

    it("with no forward host (no audience) it is 503 too", async () => {
      const { id, generation } = await claimedRun({ mode: "runner_verified" });
      const noAudience = createRunnerGitTicketFacade(writerPool, { now: () => clock, signer: { keyId: "tk1", privateKey: ticketKeys.privateKey }, audience: null });
      expect((await ask({ run_id: id, lease_generation: generation }, key, deps(noAudience))).status).toBe(503);
    });
  });

  describe("G2 and the constants the two sides must share", () => {
    it("redact removes a minted ticket from text and from a nested value", async () => {
      const { id, generation } = await claimedRun({ mode: "runner_verified" });
      const { ticket } = GitTicketReply.parse((await ask({ run_id: id, lease_generation: generation })).body);
      expect(redactText(`fatal: header fx-git-ticket: ${ticket}`, [])).not.toContain(ticket.split(".")[2]!);
      expect(JSON.stringify(redactDeep({ args: ["fetch", ticket], env: { note: ticket } }, []))).not.toContain(ticket.split(".")[1]!);
    });

    it("the verifier's skew is the signed-request skew, the lifetimes agree, and the ref pattern is the cloud's run-branch shape", () => {
      expect(GIT_TICKET_CLOCK_TOLERANCE_SECONDS).toBe(MAX_CREATED_SKEW_SECONDS);
      expect(GIT_TICKET_LIFETIME_SECONDS).toBe(300);
      for (const ok of [`fx/${randomUUID()}-g1`, `fx/${randomUUID()}-g42`]) {
        expect(GIT_TICKET_REF_PATTERN.test(ok)).toBe(true);
        expect(RUNNER_RUN_BRANCH.test(ok)).toBe(true);
      }
      for (const bad of ["main", `fx/${randomUUID()}-g0`, `fx/${randomUUID()}`, `refs/heads/fx/${randomUUID()}-g1`]) {
        expect(GIT_TICKET_REF_PATTERN.test(bad)).toBe(false);
        expect(RUNNER_RUN_BRANCH.test(bad)).toBe(false);
      }
    });

    it("branchOf is the one source of the ref", () => {
      const job = { continues: null, branch_prefix: "fx/" } as Job;
      expect(branchOf(job, { runId: "r", leaseGeneration: 4 })).toBe("fx/r-g4");
    });
  });
});
