import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setPendingHooks } from "@fx/core/src/pendingWork.js";
import { ClaimReply, DEPLOY_ORDER_CLAIM_PATH, DEPLOY_ORDER_LEASE_SECONDS, DEPLOY_ORDER_REPORT_PATH, DeployOrderClaimReply, DeployOrderReportReply } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { seedVerifyRow } from "@fx/db/test/helpers/verifyRows.js";
import { CLAIM_PATH, claimRun, deployOrderClaimRun, deployOrderReportRun, toResponse, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerLeaseOps } from "../src/index.js";
import { harness, newKey, registerKey, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#749 V2a: the deploy order routes against the real table, its guard trigger and the real runner rows. Pinned: the signature and its single-use nonce, the strict
 * messages, who may take an order (a live runner of the account whose latest hello listed deploy_order_v1, the repository in its list, its registrant an owner or admin,
 * not paused), that the reply names the repository and the commit and nothing else, the lease and its takeover, the fence on a report, and the hint on a claim reply.
 */
describe("deploy order routes [pg]", () => {
  let h: Harness;
  let A: SeedRefs;
  let B: SeedRefs;
  let key: TestKey;
  let runnerId: string;
  const SHA = "a".repeat(40);
  const unused = async (): Promise<never> => {
    throw new Error("not used by these tests");
  };
  const idleLeases = (): RunnerLeaseOps => ({
    claimRunnerRun: async () => ({ kind: "idle", retryAfter: 60 }),
    heartbeatRunnerRun: unused, ingestRunnerEvents: unused, beginRunnerDone: unused, finishRunnerDone: unused, gitTicketContext: unused, signGitTicket: unused,
  });
  const deps = (): RunnerCloudDeps => h.deps({ leases: idleLeases() });
  const nonce = (): string => `deploy-order-${randomUUID()}`;
  const claimReq = (k: TestKey = key, body: unknown = {}): RunnerHttpRequest => signed(k, DEPLOY_ORDER_CLAIM_PATH, body, { nonce: nonce() });
  const reportReq = (body: unknown, k: TestKey = key): RunnerHttpRequest => signed(k, DEPLOY_ORDER_REPORT_PATH, body, { nonce: nonce() });
  const claim = (k: TestKey = key, body: unknown = {}) => toResponse(() => deployOrderClaimRun(deps(), claimReq(k, body)));
  const report = (body: unknown, k: TestKey = key) => toResponse(() => deployOrderReportRun(deps(), reportReq(body, k)));
  /** The claim route throttles one claim per 4 seconds per runner; each call here starts after a cleared stamp. */
  const claimReply = async (k: TestKey = key) => {
    await h.admin.query("DELETE FROM runner_claim_stamps WHERE runner_id = $1", [runnerId]);
    return toResponse(() => claimRun(deps(), signed(k, CLAIM_PATH, {}, { nonce: nonce() })));
  };
  const OK = (orderId: string, lease_generation = 1, over: Record<string, unknown> = {}) => ({ order_id: orderId, lease_generation, result: "succeeded", exit_code: 0, ...over });

  async function place(who: SeedRefs, over: { sha?: string; deadline?: Date } = {}): Promise<string> {
    const { rows } = await h.admin.query<{ id: string }>(
      `INSERT INTO verify_deploy_orders (account_id, repo_id, verify_row_id, merge_sha, deadline_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [who.accountId, who.repoId, await seedVerifyRow(h.admin, who), over.sha ?? randomUUID().replaceAll("-", "") + "abcdef01", over.deadline ?? new Date(Date.now() + 3_600_000)],
    );
    return rows[0]!.id;
  }
  const row = async (id: string) => (await h.admin.query("SELECT * FROM verify_deploy_orders WHERE id = $1", [id])).rows[0];
  async function makeRunner(k: TestKey, o: { caps?: string[]; repos?: string[]; registeredBy?: string; accountId?: string } = {}): Promise<string> {
    const id = await registerKey(h.admin, o.accountId ?? A.accountId, o.registeredBy ?? A.userId, k);
    await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [id, o.repos ?? [A.repoId]]);
    await h.admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[])", [id, o.accountId ?? A.accountId, o.caps ?? ["deploy_order_v1"]]);
    return id;
  }

  beforeAll(async () => {
    h = await harness();
    A = await seedAccount(h.admin, randomUUID());
    B = await seedAccount(h.admin, randomUUID());
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [A.repoId]);
    await h.admin.query("UPDATE repos SET gh_owner = 'other', gh_name = 'gadgets' WHERE id = $1", [B.repoId]);
    key = newKey();
    runnerId = await makeRunner(key);
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    // Every case starts with no open order for the account, a live runner and no pause.
    await h.admin.query("UPDATE verify_deploy_orders SET state = 'cancelled', finished_at = now() WHERE state IN ('pending', 'claimed')");
    await h.admin.query("UPDATE runners SET revoked_at = NULL, allowed_repo_ids = ARRAY[$2]::uuid[] WHERE id = $1", [runnerId, A.repoId]);
    await h.admin.query("UPDATE runner_capabilities SET capabilities = '{deploy_order_v1}' WHERE runner_id = $1", [runnerId]);
    await h.admin.query("DELETE FROM runner_settings WHERE runner_id = $1", [runnerId]);
  });

  it("the paths are the constants /api/runner/deploy-order-claim and -report", () => {
    expect([DEPLOY_ORDER_CLAIM_PATH, DEPLOY_ORDER_REPORT_PATH]).toEqual(["/api/runner/deploy-order-claim", "/api/runner/deploy-order-report"]);
  });

  describe("claim", () => {
    it("with nothing waiting is 200 retry_after, no-store", async () => {
      const res = await claim();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ retry_after: 60 });
      expect(res.headers).toMatchObject({ "cache-control": "no-store" });
    });

    it("hands out the repository and the commit and nothing else, leases the order and counts the attempt", async () => {
      const id = await place(A, { sha: SHA });
      const res = await claim();
      expect(res.status).toBe(200);
      expect(DeployOrderClaimReply.safeParse(res.body).success).toBe(true);
      expect(Object.keys(res.body as object).sort()).toEqual(["lease_expires_at", "lease_generation", "order_id", "repo", "sha"]);
      expect(res.body).toMatchObject({ order_id: id, lease_generation: 1, repo: { owner: "acme", name: "widgets" }, sha: SHA });
      const stored = await row(id);
      expect(stored).toMatchObject({ state: "claimed", runner_id: runnerId, lease_generation: 1, attempts: 1 });
      const lease = new Date((res.body as { lease_expires_at: string }).lease_expires_at).getTime();
      expect(lease).toBe(stored.lease_expires_at.getTime());
      expect(Math.abs(lease - Date.now() - DEPLOY_ORDER_LEASE_SECONDS * 1000)).toBeLessThan(60_000);
      // Nothing is left for a second claim by the same runner while the lease is live.
      expect((await claim()).body).toEqual({ retry_after: 60 });
    });

    it("gives the oldest order first, one at a time", async () => {
      const first = await place(A);
      const second = await place(A);
      expect((await claim()).body).toMatchObject({ order_id: first });
      expect((await claim()).body).toMatchObject({ order_id: second });
      expect((await claim()).body).toEqual({ retry_after: 60 });
    });

    it("two concurrent claims for one order give it to exactly one", async () => {
      const k2 = newKey();
      await makeRunner(k2);
      const id = await place(A);
      const results = await Promise.all([claim(key), claim(k2)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(results.filter((r) => "order_id" in (r.body as object))).toHaveLength(1);
      expect((await row(id)).lease_generation).toBe(1);
    });

    it("offers nothing to a runner that may not take it: no deploy_order_v1, a repository outside its list, revoked, paused, draining, its registrant not an owner or admin", async () => {
      const id = await place(A);
      await h.admin.query("UPDATE runner_capabilities SET capabilities = '{browser_chrome_v1,wake_v1}' WHERE runner_id = $1", [runnerId]);
      expect((await claim()).body, "no capability").toEqual({ retry_after: 60 });
      await h.admin.query("UPDATE runner_capabilities SET capabilities = '{deploy_order_v1}' WHERE runner_id = $1", [runnerId]);
      await h.admin.query("UPDATE runners SET allowed_repo_ids = '{}' WHERE id = $1", [runnerId]);
      expect((await claim()).body, "repository not in its list").toEqual({ retry_after: 60 });
      await h.admin.query("UPDATE runners SET allowed_repo_ids = ARRAY[$2]::uuid[] WHERE id = $1", [runnerId, A.repoId]);
      await h.admin.query("INSERT INTO runner_settings (runner_id, account_id, paused_at) VALUES ($1, $2, now())", [runnerId, A.accountId]);
      expect((await claim()).body, "paused").toEqual({ retry_after: 60 });
      await h.admin.query("UPDATE runner_settings SET paused_at = NULL, draining = true WHERE runner_id = $1", [runnerId]);
      expect((await claim()).body, "draining").toEqual({ retry_after: 60 });
      await h.admin.query("DELETE FROM runner_settings WHERE runner_id = $1", [runnerId]);
      const outsider = randomUUID();
      await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [outsider, `${outsider}@example.test`]);
      const k2 = newKey();
      const member = await makeRunner(k2, { registeredBy: outsider });
      await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [A.accountId, outsider]);
      expect((await claim(k2)).body, "a registrant who is only a member").toEqual({ retry_after: 60 });
      expect(member).toBeTruthy();
      expect((await row(id)).state).toBe("pending");
      // The revoked runner is refused at the door, before any order is looked at.
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runnerId]);
      expect((await claim()).status).toBe(401);
      expect((await row(id)).state).toBe("pending");
    });

    it("never offers another account's order", async () => {
      const theirs = await place(B);
      expect((await claim()).body).toEqual({ retry_after: 60 });
      expect((await row(theirs)).state).toBe("pending");
    });

    it("does not offer an order past its deadline, or one that has used its three attempts", async () => {
      await place(A, { deadline: new Date(Date.now() - 1000) });
      expect((await claim()).body).toEqual({ retry_after: 60 });
      const id = await place(A);
      const k2 = newKey();
      const second = await makeRunner(k2);
      for (let i = 0; i < 3; i++) {
        const res = await claim(i % 2 === 0 ? key : k2);
        expect(res.body, `attempt ${i + 1}`).toMatchObject({ order_id: id, lease_generation: i + 1 });
        await h.admin.query("ALTER TABLE verify_deploy_orders DISABLE TRIGGER verify_deploy_orders_guard");
        await h.admin.query("UPDATE verify_deploy_orders SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [id]);
        await h.admin.query("ALTER TABLE verify_deploy_orders ENABLE TRIGGER verify_deploy_orders_guard");
      }
      expect(second).toBeTruthy();
      expect(await row(id)).toMatchObject({ attempts: 3, state: "claimed" });
      expect((await claim()).body).toEqual({ retry_after: 60 });
      expect((await claim(k2)).body).toEqual({ retry_after: 60 });
      expect((await row(id)).lease_generation).toBe(3);
    });

    it("takes over a lapsed lease with the next generation, and the first holder's report is then fenced", async () => {
      const k2 = newKey();
      await makeRunner(k2);
      const id = await place(A);
      expect((await claim(key)).body).toMatchObject({ lease_generation: 1 });
      await h.admin.query("ALTER TABLE verify_deploy_orders DISABLE TRIGGER verify_deploy_orders_guard");
      await h.admin.query("UPDATE verify_deploy_orders SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [id]);
      await h.admin.query("ALTER TABLE verify_deploy_orders ENABLE TRIGGER verify_deploy_orders_guard");
      expect((await claim(k2)).body).toMatchObject({ order_id: id, lease_generation: 2 });
      const late = await report(OK(id, 1));
      expect(late.status).toBe(409);
      expect(late.body).toMatchObject({ error: { code: "fenced" }, reason: "not_yours" });
      expect((await row(id)).state).toBe("claimed");
      expect((await report(OK(id, 2), k2)).status).toBe(200);
      expect((await row(id)).state).toBe("succeeded");
    });

    it("refuses an unsigned request, a replayed nonce and a message with anything in it", async () => {
      expect((await toResponse(() => deployOrderClaimRun(deps(), { method: "POST", headers: {}, body: Buffer.from("{}") }))).status).toBe(401);
      const once = signed(key, DEPLOY_ORDER_CLAIM_PATH, {}, { nonce: "deploy-order-nonce-0001" });
      expect((await toResponse(() => deployOrderClaimRun(deps(), once))).status).toBe(200);
      expect((await toResponse(() => deployOrderClaimRun(deps(), once))).status).not.toBe(200);
      const id = await place(A);
      for (const body of [{ repo_id: A.repoId }, { sha: SHA }, { command: "deploy" }]) expect((await claim(key, body)).status, JSON.stringify(body)).toBe(400);
      expect((await row(id)).state).toBe("pending");
    });
  });

  describe("report", () => {
    async function held(): Promise<string> {
      const id = await place(A);
      await claim();
      return id;
    }

    it("records a success with its exit status and the lines it sent, and a repeat is fenced", async () => {
      const id = await held();
      const res = await report(OK(id, 1, { output_tail: ["built", "deployed"] }));
      expect(res.status).toBe(200);
      expect(DeployOrderReportReply.safeParse(res.body).success).toBe(true);
      expect(await row(id)).toMatchObject({ state: "succeeded", exit_code: 0, failure_code: null, output_tail: "built\ndeployed", runner_id: runnerId });
      expect((await row(id)).finished_at).toBeInstanceOf(Date);
      const again = await report(OK(id, 1));
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ reason: "not_claimed" });
    });

    it("records each failure code, and an exit status only with exit_nonzero", async () => {
      for (const body of [{ failure_code: "not_configured" }, { failure_code: "script_refused" }, { failure_code: "spawn_failed" }, { failure_code: "timeout" }, { failure_code: "exit_nonzero", exit_code: 3 }]) {
        const id = await held();
        const res = await report({ order_id: id, lease_generation: 1, result: "failed", ...body });
        expect(res.status, JSON.stringify(body)).toBe(200);
        expect(await row(id)).toMatchObject({ state: "failed", failure_code: body.failure_code, exit_code: body.exit_code ?? null });
      }
    });

    it("fences a stale generation, another runner, an unknown order, another account's order and an order that was never claimed", async () => {
      const id = await held();
      const stale = await report(OK(id, 2));
      expect([stale.status, (stale.body as { reason: string }).reason]).toEqual([409, "stale_generation"]);
      const k2 = newKey();
      await makeRunner(k2);
      const other = await report(OK(id, 1), k2);
      expect([other.status, (other.body as { reason: string }).reason]).toEqual([409, "not_yours"]);
      const unknown = await report(OK(randomUUID(), 1));
      expect([unknown.status, (unknown.body as { reason: string }).reason]).toEqual([409, "not_yours"]);
      const theirs = await place(B);
      expect(((await report(OK(theirs, 1))).body as { reason: string }).reason).toBe("not_yours");
      const waiting = await place(A);
      expect(((await report(OK(waiting, 1))).body as { reason: string }).reason).toBe("not_yours");
      expect((await row(id)).state).toBe("claimed");
      expect((await row(theirs)).state).toBe("pending");
      expect((await row(waiting)).state).toBe("pending");
    });

    it("fences a report after the lease has ended", async () => {
      const id = await held();
      await h.admin.query("ALTER TABLE verify_deploy_orders DISABLE TRIGGER verify_deploy_orders_guard");
      await h.admin.query("UPDATE verify_deploy_orders SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [id]);
      await h.admin.query("ALTER TABLE verify_deploy_orders ENABLE TRIGGER verify_deploy_orders_guard");
      const res = await report(OK(id, 1));
      expect([res.status, (res.body as { reason: string }).reason]).toEqual([409, "lease_expired"]);
      expect((await row(id)).state).toBe("claimed");
    });

    it("an order the cloud cancelled is final: the holder's report is fenced and changes nothing (the undo path)", async () => {
      const id = await held();
      await h.admin.query("UPDATE verify_deploy_orders SET state = 'cancelled', finished_at = now() WHERE id = $1", [id]);
      const res = await report(OK(id, 1));
      expect([res.status, (res.body as { reason: string }).reason]).toEqual([409, "not_claimed"]);
      expect((await row(id)).state).toBe("cancelled");
    });

    describe("wakes the proposal-verify sweep (push, not poll)", () => {
      const writes = new Map<string, number>();
      beforeEach(() => {
        writes.clear();
        setPendingHooks({ store: { get: async (k) => writes.get(k) ?? null, set: async (k, v) => void writes.set(k, v), delete: async (k) => void writes.delete(k) } });
      });
      afterEach(() => setPendingHooks(null));
      const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

      it("a recorded success, and a recorded failure, set the sweep's marker", async () => {
        const id = await held();
        expect((await report(OK(id, 1))).status).toBe(200);
        await flush();
        expect(writes.has("pending:proposal-verify-sweep")).toBe(true);
        writes.clear();
        const failed = await held();
        expect((await report({ order_id: failed, lease_generation: 1, result: "failed", failure_code: "timeout" })).status).toBe(200);
        await flush();
        expect(writes.has("pending:proposal-verify-sweep")).toBe(true);
      });

      it("a fenced, a refused or an unsigned report sets nothing", async () => {
        const id = await held();
        expect((await report(OK(id, 2))).status).toBe(409);
        expect((await report(OK(id, 1, { exit_code: 1 }))).status).toBe(400);
        expect((await toResponse(() => deployOrderReportRun(deps(), { method: "POST", headers: {}, body: Buffer.from("{}") }))).status).toBe(401);
        await flush();
        expect(writes.has("pending:proposal-verify-sweep")).toBe(false);
        expect((await report(OK(id, 1))).status).toBe(200);
        expect((await report(OK(id, 1))).status).toBe(409);
      });
    });

    it("refuses what the strict message refuses, before the database, and an unsigned request", async () => {
      const id = await held();
      const bad: unknown[] = [
        OK(id, 1, { exit_code: 1 }),
        OK(id, 1, { repo: "acme/widgets" }),
        OK(id, 1, { command: "bash deploy.sh" }),
        OK(id, 1, { output_tail: ["a\nb"] }),
        OK(id, 1, { output_tail: Array.from({ length: 21 }, () => "x") }),
        { order_id: id, lease_generation: 1, result: "failed" },
        { order_id: "nope", lease_generation: 1, result: "succeeded", exit_code: 0 },
      ];
      for (const body of bad) expect((await report(body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect((await toResponse(() => deployOrderReportRun(deps(), { method: "POST", headers: {}, body: Buffer.from("{}") }))).status).toBe(401);
      expect((await row(id)).state).toBe("claimed");
    });
  });

  describe("the hint on a claim reply", () => {
    it("is deploy_order: true exactly while an order waits for a runner that may take it, and the reply parses", async () => {
      const idle = await claimReply();
      expect(idle.body).toEqual({ retry_after: 60 });
      const id = await place(A);
      const hinted = await claimReply();
      expect(hinted.body).toEqual({ retry_after: 60, deploy_order: true });
      expect(ClaimReply.safeParse(hinted.body).success).toBe(true);
      // Claiming the order takes the hint away; ending an unclaimed order does too (the undo path).
      await claim();
      expect((await claimReply()).body).toEqual({ retry_after: 60 });
      const next = await place(A);
      expect((await claimReply()).body).toEqual({ retry_after: 60, deploy_order: true });
      await h.admin.query("UPDATE verify_deploy_orders SET state = 'cancelled', finished_at = now() WHERE id = $1", [next]);
      expect((await claimReply()).body).toEqual({ retry_after: 60 });
      expect(id).toBeTruthy();
    });

    it("is never sent to a runner without deploy_order_v1, with the repository outside its list, or held by a person", async () => {
      await place(A);
      await h.admin.query("UPDATE runner_capabilities SET capabilities = '{browser_chrome_v1}' WHERE runner_id = $1", [runnerId]);
      expect((await claimReply()).body).toEqual({ retry_after: 60 });
      await h.admin.query("UPDATE runner_capabilities SET capabilities = '{deploy_order_v1}' WHERE runner_id = $1", [runnerId]);
      await h.admin.query("UPDATE runners SET allowed_repo_ids = '{}' WHERE id = $1", [runnerId]);
      expect((await claimReply()).body).toEqual({ retry_after: 60 });
      await h.admin.query("UPDATE runners SET allowed_repo_ids = ARRAY[$2]::uuid[] WHERE id = $1", [runnerId, A.repoId]);
      await h.admin.query("INSERT INTO runner_settings (runner_id, account_id, paused_at) VALUES ($1, $2, now())", [runnerId, A.accountId]);
      expect((await claimReply()).body).toEqual({ retry_after: 300 });
    });

    it("a lapsed lease with attempts left is waiting again; with none left it is not", async () => {
      const id = await place(A);
      await claim();
      expect((await claimReply()).body).toEqual({ retry_after: 60 });
      await h.admin.query("ALTER TABLE verify_deploy_orders DISABLE TRIGGER verify_deploy_orders_guard");
      await h.admin.query("UPDATE verify_deploy_orders SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [id]);
      expect((await claimReply()).body).toEqual({ retry_after: 60, deploy_order: true });
      await h.admin.query("UPDATE verify_deploy_orders SET attempts = 3, lease_generation = 3 WHERE id = $1", [id]);
      await h.admin.query("ALTER TABLE verify_deploy_orders ENABLE TRIGGER verify_deploy_orders_guard");
      expect((await claimReply()).body).toEqual({ retry_after: 60 });
    });
  });
});
