import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PLANE_MERGE_LEASE_SECONDS, PLANE_MERGE_MAX_ATTEMPTS, PLANE_MERGE_ORDER_DEADLINE_MINUTES } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { pairingDigest } from "@fx/core/src/repos/planePushRecord.js";
import { PLANE_MERGE_CODES, createRunnerPlaneMergeStore, type PlaneMergeOrder, type RunnerPlaneMergeStore } from "../src/runnerPlaneMerge.js";

/**
 * [pg] D#6 PUBLIC-MERGE PR2a: the order store against the real table (0910), the real `plane_pushes` record, the real runner rows and their trust
 * (registered by an owner or admin who still is one), scope, settings and capability rows. The clock is the test's own, so expiry, lease lapse and
 * replay are exercised by moving it. There is no GitHub here and nothing is minted: the store neither calls nor issues anything.
 */
describe("plane merge order store [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  let clock = T0;
  let store: RunnerPlaneMergeStore;
  let A: SeedRefs;
  let B: SeedRefs;
  let runner: string;
  const HEAD = "a".repeat(40);
  const REVIEWED = "b".repeat(40);
  const GLOBS = ["docs/ops/"];

  const advance = (ms: number) => (clock += ms);
  const minutes = (n: number) => n * 60_000;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    store = createRunnerPlaneMergeStore(appPool, { now: () => clock });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool]) await p.end();
  });
  beforeEach(async () => {
    clock = T0;
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [A.repoId]);
    await pair(A);
    runner = await mkRunner(A);
  });

  async function pair(who: SeedRefs, globs: string[] = GLOBS): Promise<void> {
    await admin.query(
      `INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', $3)
       ON CONFLICT (repo_id) DO UPDATE SET overlay_globs = EXCLUDED.overlay_globs`,
      [who.repoId, who.accountId, globs],
    );
  }
  /** A runner of the account that can take a merge order: registered by an owner, in scope of the repo, and advertising the capability. */
  async function mkRunner(who: SeedRefs, o: { registeredBy?: string; scope?: string[]; caps?: string[] | null; revoked?: boolean; paused?: boolean; draining?: boolean } = {}): Promise<string> {
    const id = await insertRunner(admin, who.accountId, o.registeredBy ?? who.userId);
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [id, o.scope ?? [who.repoId]]);
    if (o.caps !== null) await admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[])", [id, who.accountId, o.caps ?? ["plane_merge_v1"]]);
    if (o.revoked) await admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [id]);
    if (o.paused || o.draining) await admin.query("INSERT INTO runner_settings (runner_id, account_id, paused_at, draining) VALUES ($1, $2, $3, $4)", [id, who.accountId, o.paused ? new Date() : null, o.draining ?? false]);
    return id;
  }
  /** A work item with a pushed public pull request (the record the gate reads), optionally with other heads. */
  async function item(who: SeedRefs, o: { head?: string; source?: string; state?: string; managed?: boolean; noPr?: boolean } = {}): Promise<string> {
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [itemId, who.accountId, who.repoId]);
    const digest = pairingDigest({ codeRepo: "acme/widgets-public", overlayGlobs: GLOBS, identifierRulesPath: null, planDataRulesPath: null });
    await admin.query(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, state, head_sha, tip_sha, pr_number, pr_url, source_head, managed_by_person_at, code)
       VALUES ($1, $2, $3, 'acme/widgets-public', $4, $5, $6, $6, $7, $8, $9, $10, $11)`,
      [who.accountId, itemId, who.repoId, digest, o.state ?? "pr_opened", o.head ?? HEAD, o.noPr ? null : 7, o.noPr ? null : "https://github.com/acme/widgets-public/pull/7", o.source ?? REVIEWED, o.managed ? new Date() : null, o.state === "refused" ? "overlay_path" : null],
    );
    return itemId;
  }
  const place = (who: SeedRefs, workItemId: string, o: { head?: string; reviewed?: string } = {}) => store.placeOrder({ accountId: who.accountId, workItemId, expectedPublicHead: o.head ?? HEAD, reviewedHead: o.reviewed ?? REVIEWED });
  const placed = async (who: SeedRefs, workItemId: string): Promise<PlaneMergeOrder> => {
    const r = await place(who, workItemId);
    if (r.kind !== "placed") throw new Error(`not placed: ${r.kind}`);
    return r.order;
  };
  const claim = async (who: SeedRefs, runnerId: string = runner) => store.claimNext({ accountId: who.accountId, runnerId });
  const claimed = async (who: SeedRefs = A, runnerId: string = runner) => {
    const r = await claim(who, runnerId);
    if (r.kind !== "claimed") throw new Error("not claimed");
    return r.order;
  };
  const lease = (o: PlaneMergeOrder, runnerId: string = runner, who: SeedRefs = A) => ({ accountId: who.accountId, runnerId, orderId: o.id, leaseGeneration: o.leaseGeneration });
  const row = async (id: string) => (await admin.query("SELECT * FROM plane_merge_orders WHERE id = $1", [id])).rows[0];

  describe("placeOrder", () => {
    it("places one pending order whose facts are the push record's, with a 60-minute deadline", async () => {
      const w = await item(A);
      const r = await place(A, w);
      expect(r.kind).toBe("placed");
      if (r.kind !== "placed") return;
      expect(r.order).toMatchObject({ accountId: A.accountId, workItemId: w, repoId: A.repoId, codeRepo: "acme/widgets-public", prNumber: 7, expectedPublicHead: HEAD, reviewedHead: REVIEWED, state: "pending", runnerId: null, leaseGeneration: 0, attempts: 0, tokenPurpose: "app_installation_single_use" });
      expect(r.order.deadlineAt.getTime()).toBe(T0 + minutes(PLANE_MERGE_ORDER_DEADLINE_MINUTES));
      expect(r.superseded).toEqual([]);
      expect((await row(r.order.id)).plane_push_id).toBe(r.order.planePushId);
    });

    it("is idempotent for the same heads and pairing: the open order is returned, nothing is added", async () => {
      const w = await item(A);
      const first = await placed(A, w);
      const again = await place(A, w);
      expect(again).toMatchObject({ kind: "unchanged", order: { id: first.id } });
      expect((await admin.query("SELECT 1 FROM plane_merge_orders WHERE work_item_id = $1", [w])).rows).toHaveLength(1);
    });

    it("supersedes the open order when new heads are cleared (a pending one, a claimed one and an authorized one alike)", async () => {
      for (const upTo of ["pending", "claimed", "authorized"] as const) {
        const w = await item(A);
        const old = await placed(A, w);
        let held: PlaneMergeOrder | null = null;
        if (upTo !== "pending") {
          const c = await claimed();
          expect(c.id).toBe(old.id);
          held = c;
          if (upTo === "authorized") expect((await store.authorize(lease(c))).kind).toBe("authorized");
        }
        const next = "c".repeat(40);
        await admin.query("UPDATE plane_pushes SET head_sha = $2 WHERE work_item_id = $1", [w, next]);
        const r = await place(A, w, { head: next });
        expect(r.kind, upTo).toBe("placed");
        if (r.kind !== "placed") return;
        expect(r.superseded).toEqual([old.id]);
        expect(r.order.id).not.toBe(old.id);
        expect(await row(old.id)).toMatchObject({ state: "superseded", outcome_code: PLANE_MERGE_CODES.superseded });
        expect(r.order.expectedPublicHead).toBe(next);
        // The superseded order's runner is fenced out from then on.
        if (held) expect(await store.fence(lease(held))).toEqual({ kind: "fenced", reason: "order_terminal" });
        await admin.query("UPDATE plane_merge_orders SET state = 'expired', outcome_code = 'x', finished_at = now() WHERE id = $1 AND state IN ('pending')", [r.order.id]);
      }
    });

    it("refuses what the push record does not say: heads that differ, a record that is not an open platform-managed pull request, another tenant's item, no record", async () => {
      expect(await place(A, await item(A), { head: "d".repeat(40) })).toEqual({ kind: "push_changed" });
      expect(await place(A, await item(A), { reviewed: "d".repeat(40) })).toEqual({ kind: "push_changed" });
      expect(await place(A, await item(A, { state: "refused" }))).toEqual({ kind: "push_not_open" });
      expect(await place(A, await item(A, { state: "pr_merged" }))).toEqual({ kind: "push_not_open" });
      expect(await place(A, await item(A, { managed: true }))).toEqual({ kind: "push_not_open" });
      const other = await item(B);
      expect(await place(A, other)).toEqual({ kind: "not_paired" });
      const bare = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [bare, A.accountId, A.repoId]);
      expect(await place(A, bare)).toEqual({ kind: "not_paired" });
      expect((await admin.query("SELECT 1 FROM plane_merge_orders WHERE account_id = ANY($1)", [[A.accountId, B.accountId]])).rows).toHaveLength(0);
    });

    it("replaces an order whose deadline passed instead of handing it back", async () => {
      const w = await item(A);
      const old = await placed(A, w);
      advance(minutes(PLANE_MERGE_ORDER_DEADLINE_MINUTES) + 1);
      const r = await place(A, w);
      expect(r.kind).toBe("placed");
      if (r.kind === "placed") expect(r.superseded).toEqual([old.id]);
    });
  });

  describe("claimNext", () => {
    it("hands the oldest pending order to an eligible runner, leased for ten minutes, with the facts the reply needs", async () => {
      const w1 = await item(A);
      const first = await placed(A, w1);
      await placed(A, await item(A));
      const r = await claim(A);
      expect(r.kind).toBe("claimed");
      if (r.kind !== "claimed") return;
      expect(r.order).toMatchObject({ id: first.id, state: "claimed", runnerId: runner, leaseGeneration: 1, attempts: 1 });
      expect(r.order.leaseExpiresAt!.getTime()).toBe(T0 + PLANE_MERGE_LEASE_SECONDS * 1000);
      expect(r.facts).toEqual({ publicBranch: `fx/p-${r.order.planePushId}`, privateOwner: "acme", privateName: "widgets", overlayGlobs: GLOBS });
    });

    it("gives nothing when nothing is waiting", async () => {
      expect(await claim(A)).toEqual({ kind: "none" });
    });

    it("refuses a runner that is not eligible, one reason at a time, and an eligible one still gets the order afterwards", async () => {
      const w = await item(A);
      const order = await placed(A, w);
      const member = randomUUID();
      await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [member, `${member}@example.test`]);
      await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [A.accountId, member]);
      const adminUser = randomUUID();
      await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [adminUser, `${adminUser}@example.test`]);
      await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')", [A.accountId, adminUser]);
      const otherRepo = randomUUID();
      const refused: Record<string, string> = {
        "registered by a plain member": await mkRunner(A, { registeredBy: member }),
        "registrant no longer in the account": await mkRunner(A, { registeredBy: B.userId }),
        revoked: await mkRunner(A, { revoked: true }),
        "repository out of scope": await mkRunner(A, { scope: [otherRepo] }),
        "empty scope": await mkRunner(A, { scope: [] }),
        paused: await mkRunner(A, { paused: true }),
        draining: await mkRunner(A, { draining: true }),
        "no capability row": await mkRunner(A, { caps: null }),
        "other capabilities only": await mkRunner(A, { caps: ["proposal_verifier", "wake_v1"] }),
        "another account's runner": await mkRunner(B),
      };
      for (const [why, id] of Object.entries(refused)) {
        const who = why === "another account's runner" ? B : A;
        expect(await claim(who, id), why).toEqual({ kind: "none" });
      }
      // Calling with the other account's id and this account's runner finds nothing either: the tenant is the runner's, never the caller's say.
      expect(await claim(B, runner)).toEqual({ kind: "none" });
      expect((await row(order.id)).state).toBe("pending");
      // An admin registrant is trusted like an owner.
      const viaAdmin = await mkRunner(A, { registeredBy: adminUser });
      expect((await claim(A, viaAdmin)).kind).toBe("claimed");
    });

    it("leaves an order past its deadline alone", async () => {
      await placed(A, await item(A));
      advance(minutes(PLANE_MERGE_ORDER_DEADLINE_MINUTES) + 1);
      expect(await claim(A)).toEqual({ kind: "none" });
    });

    it("two runners asking at once: exactly one gets the order", async () => {
      await placed(A, await item(A));
      const second = await mkRunner(A);
      const results = await Promise.all([claim(A, runner), claim(A, second)]);
      expect(results.map((r) => r.kind).sort()).toEqual(["claimed", "none"]);
      expect((await admin.query("SELECT 1 FROM plane_merge_orders WHERE account_id = $1 AND state = 'claimed'", [A.accountId])).rows).toHaveLength(1);
    });

    it("a second claim by the same runner does not take the leased order again", async () => {
      await placed(A, await item(A));
      await claimed();
      expect(await claim(A)).toEqual({ kind: "none" });
    });

    it("finishes an order whose pairing changed since it was placed (blocked) and tries the next one", async () => {
      const w1 = await item(A);
      const stale = await placed(A, w1);
      const w2 = await item(A);
      const good = await placed(A, w2);
      // Both orders share the repository's pairing: change it, then restore the second order's digest by placing it again under the new pairing.
      await pair(A, ["docs/ops/", "scripts/private/"]);
      expect((await claim(A)).kind).toBe("none");
      expect(await row(stale.id)).toMatchObject({ state: "blocked", outcome_code: PLANE_MERGE_CODES.pairingChanged });
      expect(await row(good.id)).toMatchObject({ state: "blocked", outcome_code: PLANE_MERGE_CODES.pairingChanged });
    });

    it("finishes an order whose push record moved on (a new head, a person's takeover, a closed pull request) as superseded, and claims the next", async () => {
      const moved = await placed(A, await item(A));
      const taken = await placed(A, await item(A));
      const closed = await placed(A, await item(A));
      const fine = await placed(A, await item(A));
      await admin.query("UPDATE plane_pushes SET head_sha = $2 WHERE id = $1", [moved.planePushId, "e".repeat(40)]);
      await admin.query("UPDATE plane_pushes SET managed_by_person_at = now() WHERE id = $1", [taken.planePushId]);
      await admin.query("UPDATE plane_pushes SET state = 'pr_closed' WHERE id = $1", [closed.planePushId]);
      const got = await claimed();
      expect(got.id).toBe(fine.id);
      for (const o of [moved, taken, closed]) expect(await row(o.id)).toMatchObject({ state: "superseded", outcome_code: PLANE_MERGE_CODES.headMoved });
    });
  });

  describe("leases", () => {
    it("the fence names the runner, the generation, the lease and the deadline, and asking never extends the lease", async () => {
      await placed(A, await item(A));
      const o = await claimed();
      const other = await mkRunner(A);
      expect((await store.fence(lease(o))).kind).toBe("ok");
      expect(await store.fence(lease(o, other))).toEqual({ kind: "fenced", reason: "unknown" });
      expect(await store.fence({ ...lease(o), leaseGeneration: o.leaseGeneration + 1 })).toEqual({ kind: "fenced", reason: "stale_generation" });
      expect(await store.fence({ ...lease(o), orderId: randomUUID() })).toEqual({ kind: "fenced", reason: "unknown" });
      expect(await store.fence({ ...lease(o), accountId: B.accountId })).toEqual({ kind: "fenced", reason: "unknown" });
      advance(PLANE_MERGE_LEASE_SECONDS * 1000 - 1);
      expect((await store.fence(lease(o))).kind).toBe("ok");
      expect((await row(o.id)).lease_expires_at.getTime()).toBe(T0 + PLANE_MERGE_LEASE_SECONDS * 1000);
      advance(1);
      expect(await store.fence(lease(o))).toEqual({ kind: "fenced", reason: "lease_expired" });
    });

    it("a lapsed lease returns the order to pending, and the next claim is a new generation that fences the old holder out", async () => {
      await placed(A, await item(A));
      const first = await claimed();
      advance(PLANE_MERGE_LEASE_SECONDS * 1000);
      expect(await store.reapLeases(A.accountId)).toEqual({ requeued: 1, failed: 0 });
      expect(await row(first.id)).toMatchObject({ state: "pending", runner_id: null, lease_expires_at: null, lease_generation: 1, attempts: 1 });
      const second = await mkRunner(A);
      const again = await claimed(A, second);
      expect(again).toMatchObject({ id: first.id, leaseGeneration: 2, attempts: 2, runnerId: second });
      expect(await store.fence(lease(first))).toEqual({ kind: "fenced", reason: "unknown" });
      expect(await store.fence(lease(first, second))).toEqual({ kind: "fenced", reason: "stale_generation" });
      expect((await store.fence(lease(again, second))).kind).toBe("ok");
    });

    it("the claim itself reaps a lapsed lease, so the same runner can take the order again after a crash", async () => {
      await placed(A, await item(A));
      const first = await claimed();
      advance(PLANE_MERGE_LEASE_SECONDS * 1000);
      const again = await claimed();
      expect(again).toMatchObject({ id: first.id, leaseGeneration: 2 });
    });

    it("the third lapse fails the order with runner_merge_failed, and it is never claimed a fourth time", async () => {
      const w = await item(A);
      const o = await placed(A, w);
      for (let i = 1; i <= PLANE_MERGE_MAX_ATTEMPTS; i++) {
        expect((await claimed()).attempts).toBe(i);
        advance(PLANE_MERGE_LEASE_SECONDS * 1000);
        if (i < PLANE_MERGE_MAX_ATTEMPTS) expect(await store.reapLeases(A.accountId)).toEqual({ requeued: 1, failed: 0 });
      }
      expect(await store.reapLeases(A.accountId)).toEqual({ requeued: 0, failed: 1 });
      expect(await row(o.id)).toMatchObject({ state: "failed", outcome_code: PLANE_MERGE_CODES.failed, attempts: 3 });
      expect(await claim(A)).toEqual({ kind: "none" });
      // The item can have a new order once this one is over.
      await admin.query("UPDATE plane_pushes SET head_sha = $2 WHERE work_item_id = $1", [w, "f".repeat(40)]);
      expect((await place(A, w, { head: "f".repeat(40) })).kind).toBe("placed");
    });
  });

  describe("grantReadToken", () => {
    it("is issued once per order and lease generation", async () => {
      await placed(A, await item(A));
      const o = await claimed();
      expect((await store.grantReadToken(lease(o))).kind).toBe("granted");
      expect(await store.grantReadToken(lease(o))).toEqual({ kind: "already_issued" });
      expect((await row(o.id)).read_token_generation).toBe(1);
      // A later generation (after a lapse) may be granted again.
      advance(PLANE_MERGE_LEASE_SECONDS * 1000);
      const again = await claimed();
      expect((await store.grantReadToken(lease(again))).kind).toBe("granted");
      expect((await row(o.id)).read_token_generation).toBe(2);
    });
    it("is fenced like every other call, and not offered once the order is authorized", async () => {
      await placed(A, await item(A));
      const o = await claimed();
      expect(await store.grantReadToken({ ...lease(o), leaseGeneration: 9 })).toEqual({ kind: "fenced", reason: "stale_generation" });
      expect(await store.grantReadToken(lease(o, await mkRunner(A)))).toEqual({ kind: "fenced", reason: "unknown" });
      await store.authorize(lease(o));
      expect(await store.grantReadToken(lease(o))).toEqual({ kind: "already_issued" });
    });
  });

  describe("authorize", () => {
    it("moves claimed to authorized and stamps the single issue time of the write credential", async () => {
      await placed(A, await item(A));
      const o = await claimed();
      const r = await store.authorize(lease(o));
      expect(r.kind).toBe("authorized");
      if (r.kind !== "authorized") return;
      expect(r.order).toMatchObject({ state: "authorized", runnerId: runner });
      expect(r.order.writeTokenIssuedAt!.getTime()).toBe(T0);
    });
    it("a second authorize (a replay) is already_issued and changes nothing", async () => {
      await placed(A, await item(A));
      const o = await claimed();
      await store.authorize(lease(o));
      advance(1000);
      const before = await row(o.id);
      expect(await store.authorize(lease(o))).toEqual({ kind: "already_issued" });
      expect((await row(o.id)).write_token_issued_at).toEqual(before.write_token_issued_at);
    });
    it("two parallel authorizes: exactly one wins", async () => {
      await placed(A, await item(A));
      const o = await claimed();
      const results = await Promise.all([store.authorize(lease(o)), store.authorize(lease(o)), store.authorize(lease(o))]);
      expect(results.map((r) => r.kind).sort()).toEqual(["already_issued", "already_issued", "authorized"]);
    });
    it("is refused for the wrong runner, a stale generation, another tenant, an expired lease, an expired deadline, and an order that is over", async () => {
      await placed(A, await item(A));
      const o = await claimed();
      expect(await store.authorize(lease(o, await mkRunner(A)))).toEqual({ kind: "fenced", reason: "unknown" });
      expect(await store.authorize({ ...lease(o), leaseGeneration: 2 })).toEqual({ kind: "fenced", reason: "stale_generation" });
      expect(await store.authorize({ ...lease(o), accountId: B.accountId })).toEqual({ kind: "fenced", reason: "unknown" });
      expect((await row(o.id)).write_token_issued_at).toBeNull();
      advance(PLANE_MERGE_LEASE_SECONDS * 1000);
      expect(await store.authorize(lease(o))).toEqual({ kind: "fenced", reason: "lease_expired" });
      expect((await row(o.id)).state).toBe("claimed");
      // Deadline: a fresh order claimed late, whose lease outlives the deadline, is still refused.
      const w = await item(A);
      const late = await placed(A, w);
      await admin.query("UPDATE plane_merge_orders SET state = 'superseded', outcome_code = 'x', finished_at = now() WHERE id = $1 AND state = 'claimed'", [o.id]);
      advance(minutes(PLANE_MERGE_ORDER_DEADLINE_MINUTES) - 1000);
      const l = await claimed();
      expect(l.id).toBe(late.id);
      advance(1000);
      expect(await store.authorize(lease(l))).toEqual({ kind: "fenced", reason: "order_expired" });
      // Over: finished orders refuse everything.
      await store.expireDue({ accountId: A.accountId, orderId: l.id });
      expect(await store.authorize(lease(l))).toEqual({ kind: "fenced", reason: "order_terminal" });
    });
    it("an order that was never claimed cannot be authorized", async () => {
      const o = await placed(A, await item(A));
      expect(await store.authorize({ accountId: A.accountId, runnerId: runner, orderId: o.id, leaseGeneration: 1 })).toEqual({ kind: "fenced", reason: "unknown" });
    });
  });

  describe("finish", () => {
    it("lets the runner end a claimed order as blocked, head_moved, superseded or failed, and an authorized one as merged, head_moved or failed", async () => {
      for (const to of ["blocked", "head_moved", "superseded", "failed"] as const) {
        await placed(A, await item(A));
        const o = await claimed();
        const r = await store.finish({ accountId: A.accountId, orderId: o.id, to, code: "some_reason", actor: { by: "runner", runnerId: runner, leaseGeneration: o.leaseGeneration } });
        expect(r.kind, to).toBe("finished");
        expect(await row(o.id), to).toMatchObject({ state: to, outcome_code: "some_reason" });
        expect((await row(o.id)).finished_at.getTime()).toBe(T0);
      }
      for (const to of ["merged", "head_moved", "failed"] as const) {
        await placed(A, await item(A));
        const o = await claimed();
        await store.authorize(lease(o));
        const r = await store.finish({ accountId: A.accountId, orderId: o.id, to, code: to === "merged" ? PLANE_MERGE_CODES.merged : "x_code", actor: { by: "runner", runnerId: runner, leaseGeneration: o.leaseGeneration } });
        expect(r.kind, to).toBe("finished");
        expect((await row(o.id)).state).toBe(to);
      }
    });
    it("does not let a runner merge a claimed order (no go yet), end a pending one, or expire any", async () => {
      await placed(A, await item(A));
      const o = await claimed();
      const run = { by: "runner" as const, runnerId: runner, leaseGeneration: o.leaseGeneration };
      for (const to of ["merged", "expired"] as const) expect(await store.finish({ accountId: A.accountId, orderId: o.id, to, code: "x_code", actor: run }), to).toEqual({ kind: "not_allowed", from: "claimed" });
      const authorized = await store.authorize(lease(o));
      expect(authorized.kind).toBe("authorized");
      for (const to of ["blocked", "superseded", "expired"] as const) expect(await store.finish({ accountId: A.accountId, orderId: o.id, to, code: "x_code", actor: run }), to).toEqual({ kind: "not_allowed", from: "authorized" });
      expect((await row(o.id)).state).toBe("authorized");
    });
    it("a replayed finish finds the order over: the runner is fenced, the cloud is told not_allowed, and the first outcome stands", async () => {
      await placed(A, await item(A));
      const o = await claimed();
      const run = { by: "runner" as const, runnerId: runner, leaseGeneration: o.leaseGeneration };
      await store.finish({ accountId: A.accountId, orderId: o.id, to: "blocked", code: "ci_not_green", actor: run });
      expect(await store.finish({ accountId: A.accountId, orderId: o.id, to: "failed", code: "other_code", actor: run })).toEqual({ kind: "fenced", reason: "order_terminal" });
      expect(await store.finish({ accountId: A.accountId, orderId: o.id, to: "failed", code: "other_code", actor: { by: "cloud" } })).toEqual({ kind: "not_allowed", from: "blocked" });
      expect(await row(o.id)).toMatchObject({ state: "blocked", outcome_code: "ci_not_green" });
    });
    it("refuses a runner that is not the holder, a stale generation, a lapsed lease and another tenant", async () => {
      await placed(A, await item(A));
      const o = await claimed();
      const base = { accountId: A.accountId, orderId: o.id, to: "blocked" as const, code: "x_code" };
      expect(await store.finish({ ...base, actor: { by: "runner", runnerId: await mkRunner(A), leaseGeneration: 1 } })).toEqual({ kind: "fenced", reason: "unknown" });
      expect(await store.finish({ ...base, actor: { by: "runner", runnerId: runner, leaseGeneration: 5 } })).toEqual({ kind: "fenced", reason: "stale_generation" });
      expect(await store.finish({ ...base, accountId: B.accountId, actor: { by: "cloud" } })).toEqual({ kind: "not_found" });
      advance(PLANE_MERGE_LEASE_SECONDS * 1000);
      expect(await store.finish({ ...base, actor: { by: "runner", runnerId: runner, leaseGeneration: 1 } })).toEqual({ kind: "fenced", reason: "lease_expired" });
      expect((await row(o.id)).state).toBe("claimed");
    });
    it("lets the cloud end any open order along the table, and rejects a code that is not a fixed code", async () => {
      const pending = await placed(A, await item(A));
      expect((await store.finish({ accountId: A.accountId, orderId: pending.id, to: "superseded", code: "x_code", actor: { by: "cloud" } })).kind).toBe("finished");
      await placed(A, await item(A));
      const c = await claimed();
      expect((await store.finish({ accountId: A.accountId, orderId: c.id, to: "expired", code: "runner_merge_timeout", actor: { by: "cloud" } })).kind).toBe("finished");
      await expect(store.finish({ accountId: A.accountId, orderId: c.id, to: "failed", code: "Free text", actor: { by: "cloud" } })).rejects.toThrow("bad code");
      expect(await store.finish({ accountId: A.accountId, orderId: c.id, to: "merged", code: "merged", actor: { by: "cloud" } })).toEqual({ kind: "not_allowed", from: "expired" });
    });
  });

  describe("time", () => {
    it("expireDue ends open orders past their deadline as runner_merge_timeout, from any open state, and nothing else", async () => {
      await placed(A, await item(A));
      const cl = await claimed();
      await placed(A, await item(A));
      const au = await claimed();
      await store.authorize(lease(au));
      const pend = await placed(A, await item(A));
      advance(minutes(PLANE_MERGE_ORDER_DEADLINE_MINUTES) - 1);
      expect(await store.expireDue({ accountId: A.accountId })).toEqual([]);
      advance(1);
      const done = await store.expireDue({ accountId: A.accountId });
      expect(done.map((o) => o.id).sort()).toEqual([pend.id, cl.id, au.id].sort());
      for (const o of done) expect(o).toMatchObject({ state: "expired", outcomeCode: PLANE_MERGE_CODES.timeout });
      expect(await store.expireDue({ accountId: A.accountId })).toEqual([]);
    });
    it("expireDue for one order touches only that order, and not another tenant's", async () => {
      const mine = await placed(A, await item(A));
      const theirs = await placed(B, await item(B));
      const another = await placed(A, await item(A));
      advance(minutes(PLANE_MERGE_ORDER_DEADLINE_MINUTES));
      expect((await store.expireDue({ accountId: A.accountId, orderId: mine.id })).map((o) => o.id)).toEqual([mine.id]);
      expect((await row(another.id)).state).toBe("pending");
      expect((await row(theirs.id)).state).toBe("pending");
      expect(await store.expireDue({ accountId: A.accountId, orderId: theirs.id })).toEqual([]);
    });
    it("a late runner gets a fence answer on every call after expiry, and cannot finish or authorize", async () => {
      await placed(A, await item(A));
      const o = await claimed();
      advance(minutes(PLANE_MERGE_ORDER_DEADLINE_MINUTES));
      await store.expireDue({ accountId: A.accountId });
      expect(await store.fence(lease(o))).toEqual({ kind: "fenced", reason: "order_terminal" });
      expect(await store.authorize(lease(o))).toEqual({ kind: "fenced", reason: "order_terminal" });
      expect(await store.grantReadToken(lease(o))).toEqual({ kind: "fenced", reason: "order_terminal" });
      expect(await store.finish({ accountId: A.accountId, orderId: o.id, to: "blocked", code: "x_code", actor: { by: "runner", runnerId: runner, leaseGeneration: 1 } })).toEqual({ kind: "fenced", reason: "order_terminal" });
    });
    it("an authorized order whose lease lapsed is listed, never re-authorized or re-claimed, and the cloud ends it after its own read", async () => {
      await placed(A, await item(A));
      const o = await claimed();
      await store.authorize(lease(o));
      expect(await store.lapsedAuthorized(A.accountId)).toEqual([]);
      advance(PLANE_MERGE_LEASE_SECONDS * 1000);
      expect((await store.lapsedAuthorized(A.accountId)).map((x) => x.id)).toEqual([o.id]);
      expect(await store.reapLeases(A.accountId)).toEqual({ requeued: 0, failed: 0 });
      expect(await claim(A)).toEqual({ kind: "none" });
      expect(await store.authorize(lease(o))).toEqual({ kind: "fenced", reason: "lease_expired" });
      expect((await store.finish({ accountId: A.accountId, orderId: o.id, to: "failed", code: PLANE_MERGE_CODES.failed, actor: { by: "cloud" } })).kind).toBe("finished");
      expect(await store.lapsedAuthorized(A.accountId)).toEqual([]);
    });
  });

  describe("latestForItem", () => {
    it("returns the newest order of the item whatever its state, null for none, and nothing across tenants", async () => {
      const w = await item(A);
      expect(await store.latestForItem({ accountId: A.accountId, workItemId: w })).toBeNull();
      const first = await placed(A, w);
      expect((await store.latestForItem({ accountId: A.accountId, workItemId: w }))?.id).toBe(first.id);
      await store.finish({ accountId: A.accountId, orderId: first.id, to: "superseded", code: "x_code", actor: { by: "cloud" } });
      await admin.query("UPDATE plane_pushes SET head_sha = $2 WHERE work_item_id = $1", [w, "9".repeat(40)]);
      const second = await place(A, w, { head: "9".repeat(40) });
      expect(second.kind).toBe("placed");
      expect((await store.latestForItem({ accountId: A.accountId, workItemId: w }))?.state).toBe("pending");
      expect(await store.latestForItem({ accountId: B.accountId, workItemId: w })).toBeNull();
    });
  });
});
