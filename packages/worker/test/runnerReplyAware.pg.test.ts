import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PREFER_HOLD_MAX_SECONDS, RUNNER_HANDOFF_MIN_PROTOCOL_VERSION, runnerIgnoringWork, runnerIgnoringWorkSql, runnerLiveSql, type RunnerReplyFacts } from "@fx/runner";
import { sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { setPendingHooks } from "@fx/core/src/pendingWork.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { createRunnerNoticeSweeper } from "../src/runnerNotices.js";

/**
 * [pg] D#6 PING-CONSUMERS R1-a: the reply-aware liveness rule. The SQL and its TypeScript twin agree on a fixture table, then the two consumers wired
 * here (the waiting notice, the claim's prefer-hold) are driven through their real code on a fake clock. Every instant is set directly.
 */
describe("reply-aware runner liveness [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  const key = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  const SEC = 1000;
  const MIN = 60_000;
  let clock = T0;
  const iso = (ms: number) => new Date(ms).toISOString();
  const gated = () => createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => clock, randomBetween: (min) => min, wakeEnabled: () => true });

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });
  beforeEach(async () => {
    clock = T0;
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    for (const x of [A, B]) await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [x.repoId]);
  });

  async function runner(account: SeedRefs, o: { seenAgo?: number; wake?: boolean } = {}): Promise<string> {
    const id = await insertRunner(admin, account.accountId, account.userId, { credentialMode: "api_key" });
    await admin.query(
      "UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = ARRAY['executor','code-reviewer'], last_seen_at = $3::timestamptz, protocol_version = $4 WHERE id = $1",
      [id, [account.repoId], iso(T0 - (o.seenAgo ?? 0)), RUNNER_HANDOFF_MIN_PROTOCOL_VERSION],
    );
    if (o.wake !== false) await admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, ARRAY['wake_v1'])", [id, account.accountId]);
    return id;
  }
  /** A pending runner run with a real signed job; `since` is its claimable_since, `after` its claimable_after. */
  async function pending(account: SeedRefs, o: { since: number; after?: number }): Promise<string> {
    const id = randomUUID();
    const job: Job = {
      schema_version: 1,
      job_id: randomUUID(),
      run_id: id,
      repo: { id: account.repoId, owner: "acme", name: "app", private: true },
      role: "executor",
      mode: "local",
      spec: null,
      task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") },
      role_card: { text: "c", sha256: sha256Text("c") },
      role_tools_sha256: "a".repeat(64),
      continues: null,
      branch_prefix: "fx/",
      model_hint: null,
      issued_at: iso(T0 - 1000),
      expires_at: iso(T0 + 72 * 3_600_000),
      key_id: "k1",
    };
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, initiated_by, created_at, claimable_since, claimable_after)
       VALUES ($1, $2, $3, 'executor', 'runner', 'pending', 'runner_local', $4, $5::jsonb, $6, $7::timestamptz, $7::timestamptz, $8::timestamptz)`,
      [id, account.accountId, account.workItemId, account.repoId, JSON.stringify(signJob(job, key)), account.userId, iso(o.since), o.after === undefined ? null : iso(o.after)],
    );
    return id;
  }
  const status = async (id: string) => (await admin.query("SELECT status, runner_id FROM agent_runs WHERE id = $1", [id])).rows[0];

  describe("SQL and TypeScript agree", () => {
    interface Fixture {
      name: string;
      /** Seconds before `now` the runner was last stamped; null = never heard. */
      stamp: number | null;
      /** The pending run's claimable_since, seconds before now; null = no pending run. */
      anchor?: number | null;
      /** claimable_after, seconds before now (negative = future). */
      after?: number;
      /** A running run of the runner whose lease ends at this many seconds before now (negative = future). */
      lease?: number;
      wake?: boolean;
      sandboxDown?: boolean;
      limitedBy?: "usage_limit" | "paused";
      otherAccount?: boolean;
    }
    const fixtures: Fixture[] = [
      { name: "anchor 89 s old, stamp before it", stamp: 600, anchor: 89 },
      { name: "anchor 90 s old counts (inclusive)", stamp: 600, anchor: 90 },
      { name: "anchor 91 s old", stamp: 600, anchor: 91 },
      { name: "stamp after the anchor", stamp: 100, anchor: 200 },
      { name: "stamp equal to the anchor is an answer", stamp: 200, anchor: 200 },
      { name: "lease extended after the anchor (lease ends now, so heard 90 s ago)", stamp: 600, anchor: 200, lease: 0 },
      { name: "lease extended before the anchor", stamp: 600, anchor: 200, lease: 400 },
      { name: "claimable_after in the future", stamp: 600, anchor: 500, after: -60 },
      { name: "claimable_after 89 s ago", stamp: 600, anchor: 500, after: 89 },
      { name: "claimable_after 90 s ago", stamp: 600, anchor: 500, after: 90 },
      { name: "sandbox reported down", stamp: 600, anchor: 200, sandboxDown: true },
      { name: "usage limit", stamp: 600, anchor: 200, limitedBy: "usage_limit" },
      { name: "paused", stamp: 600, anchor: 200, limitedBy: "paused" },
      { name: "not a wake runner", stamp: 600, anchor: 200, wake: false },
      { name: "never heard from", stamp: null, anchor: 200 },
      { name: "no pending run", stamp: 600, anchor: null },
      { name: "the only pending run belongs to another account", stamp: 600, anchor: 200, otherAccount: true },
    ];
    it.each(fixtures)("$name", async (f) => {
      const id = await runner(A, { wake: f.wake });
      await admin.query("UPDATE runners SET last_seen_at = $2::timestamptz WHERE id = $1", [id, f.stamp === null ? null : iso(T0 - f.stamp * SEC)]);
      if (f.sandboxDown) await admin.query("INSERT INTO runner_sandbox_status (runner_id, account_id, reason) VALUES ($1, $2, 'bwrap_missing')", [id, A.accountId]);
      if (f.limitedBy) await admin.query("INSERT INTO runner_capacity (runner_id, account_id, declared, light_limit, heavy_limit, limited_by) VALUES ($1, $2, true, 1, 1, $3)", [id, A.accountId, f.limitedBy]);
      const pendingRuns: RunnerReplyFacts["pending"][number][] = [];
      if (f.anchor !== null && f.anchor !== undefined) {
        const owner = f.otherAccount ? B : A;
        await pending(owner, { since: T0 - f.anchor * SEC, ...(f.after === undefined ? {} : { after: T0 - f.after * SEC }) });
        if (!f.otherAccount) pendingRuns.push({ claimableSince: new Date(T0 - f.anchor * SEC), claimableAfter: f.after === undefined ? null : new Date(T0 - f.after * SEC) });
      }
      if (f.lease !== undefined) {
        await admin.query(
          "INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, runner_id, lease_generation, lease_expires_at, started_at) VALUES ($1, $2, 'executor', 'runner', 'running', 'runner_local', $3, 1, $4::timestamptz, now())",
          [randomUUID(), A.accountId, id, iso(T0 - f.lease * SEC)],
        );
      }
      const facts: RunnerReplyFacts = {
        lastSeenAt: f.stamp === null ? null : new Date(T0 - f.stamp * SEC),
        latestLeaseExpiresAt: f.lease === undefined ? null : new Date(T0 - f.lease * SEC),
        wakeCapable: f.wake !== false,
        sandboxDown: f.sandboxDown === true,
        heldBack: f.limitedBy !== undefined,
        pending: pendingRuns,
      };
      const viaSql = await withTenant(writerPool, A.accountId, async (client) => {
        const { rows } = await client.query<{ v: boolean | null }>(`SELECT ${runnerIgnoringWorkSql({ runner: "r", now: "$2" })} AS v FROM runners r WHERE r.id = $1`, [id, new Date(T0)]);
        return rows[0]?.v;
      });
      expect(viaSql).toBe(runnerIgnoringWork(facts, new Date(T0)));
    });

    it("the rule is a plain true/false for every fixture (a NULL would drop the runner from the live test)", async () => {
      const id = await runner(A);
      await admin.query("UPDATE runners SET last_seen_at = NULL WHERE id = $1", [id]);
      const v = await withTenant(writerPool, A.accountId, async (client) => (await client.query(`SELECT ${runnerIgnoringWorkSql({ runner: "r", now: "$2" })} AS v FROM runners r WHERE r.id = $1`, [id, new Date(T0)])).rows[0].v);
      expect(v).toBe(false);
    });

    it("wake gate closed: the predicate is the plain 120 s test whatever the runs say", async () => {
      const id = await runner(A, { seenAgo: 60 * SEC });
      await pending(A, { since: T0 - 300 * SEC });
      const live = (wakeEnabled: boolean, replyAware: boolean) =>
        withTenant(writerPool, A.accountId, async (client) =>
          (await client.query(`SELECT ${runnerLiveSql({ runner: "r", now: "$2", wakeEnabled, replyAware })} AS v FROM runners r WHERE r.id = $1`, [id, new Date(T0)])).rows[0].v as boolean);
      expect(await live(true, false)).toBe(true);
      expect(await live(true, true)).toBe(true); // heard 60 s ago, after the anchor
      await admin.query("UPDATE runners SET last_seen_at = $2::timestamptz WHERE id = $1", [id, iso(T0 - 400 * SEC)]);
      expect(await live(true, false)).toBe(true); // wake window
      expect(await live(true, true)).toBe(false);
      expect(await live(false, true)).toBe(false); // plain 120 s: 400 s old
      await admin.query("UPDATE runners SET last_seen_at = $2::timestamptz WHERE id = $1", [id, iso(T0 - 100 * SEC)]);
      expect(await live(false, true)).toBe(true);
    });
  });

  describe("waiting notice", () => {
    const sweeper = () => createRunnerNoticeSweeper(writerPool, { now: () => clock, wakeEnabled: () => true });
    const kinds = async (id: string) => (await admin.query("SELECT kind FROM run_events WHERE run_id = $1 AND kind LIKE 'runner.%' ORDER BY seq", [id])).rows.map((r) => r.kind as string);

    it("AC2: a wake runner quiet for 10 minutes no longer holds the notice back; it is written at the first tick at or after 15 minutes", async () => {
      // Dispatched at T0; the runner's last stamp is 10 minutes before that. Nothing has been heard since.
      const id = await pending(A, { since: T0 });
      await admin.query("UPDATE agent_runs SET created_at = $2::timestamptz WHERE id = $1", [id, iso(T0)]);
      await runner(A, { seenAgo: 10 * MIN });
      clock = T0 + 15 * MIN - SEC;
      expect(await sweeper().sweepRunnerNotices()).toMatchObject({ waitingEmitted: 0 });
      clock = T0 + 15 * MIN;
      expect(await sweeper().sweepRunnerNotices()).toMatchObject({ waitingEmitted: 1, failed: 0 });
      expect(await kinds(id)).toEqual(["runner.waiting"]);
    });

    it("AC3: the same runner made an idle claim after the anchor, so no notice is written and the run is looked at again in 5 minutes", async () => {
      const id = await pending(A, { since: T0 });
      await admin.query("UPDATE agent_runs SET created_at = $2::timestamptz WHERE id = $1", [id, iso(T0)]);
      const wake = await runner(A, { seenAgo: 10 * MIN });
      clock = T0 + 15 * MIN;
      await admin.query("UPDATE runners SET last_seen_at = $2::timestamptz WHERE id = $1", [wake, iso(T0 + 2 * MIN)]);
      expect(await sweeper().sweepRunnerNotices()).toMatchObject({ waitingEmitted: 0, nextDueAt: clock + 5 * MIN });
      expect(await kinds(id)).toEqual([]);
    });
  });

  describe("claim routing", () => {
    async function setup(preferSeenAgo: number) {
      const desktop = await runner(A, { seenAgo: preferSeenAgo });
      const laptop = await runner(A);
      await admin.query("UPDATE repos SET runner_routing = $2::jsonb WHERE id = $1", [A.repoId, JSON.stringify({ prefer: [desktop] })]);
      return { desktop, laptop };
    }
    const keepHeard = (id: string, at: number) => admin.query("UPDATE runners SET last_seen_at = $2::timestamptz WHERE id = $1", [id, iso(at)]);

    it("AC4: a preferred runner that is not answering stops holding the run at claimable_since + 90 s, and not 1 ms before", async () => {
      const { desktop, laptop } = await setup(10 * MIN);
      const id = await pending(A, { since: T0 });
      const facade = gated();
      clock = T0 + 90 * SEC - 1;
      await keepHeard(laptop, clock);
      expect((await facade.claimRunnerRun({ accountId: A.accountId, runnerId: laptop })).kind).toBe("idle");
      clock = T0 + 90 * SEC;
      await keepHeard(laptop, clock);
      expect(await facade.claimRunnerRun({ accountId: A.accountId, runnerId: laptop })).toMatchObject({ kind: "claimed", runId: id });
      expect((await status(id)).runner_id).toBe(laptop);
      expect(desktop).not.toBe(laptop);
    });

    it("AC4: with the preferred runner answering (polled after the anchor and left the run), the hold is the usual 120 s", async () => {
      const { desktop, laptop } = await setup(1000);
      const id = await pending(A, { since: T0 });
      const facade = gated();
      // Desktop is heard just after the anchor, so it is answering; it never takes the run (a pure hold test), so the hold runs to its maximum.
      clock = T0 + 90 * SEC;
      await keepHeard(desktop, T0 + 5 * SEC);
      await keepHeard(laptop, clock);
      expect((await facade.claimRunnerRun({ accountId: A.accountId, runnerId: laptop })).kind).toBe("idle");
      clock = T0 + PREFER_HOLD_MAX_SECONDS * SEC - 1;
      await keepHeard(laptop, clock);
      expect((await facade.claimRunnerRun({ accountId: A.accountId, runnerId: laptop })).kind).toBe("idle");
      clock = T0 + PREFER_HOLD_MAX_SECONDS * SEC;
      await keepHeard(laptop, clock);
      expect(await facade.claimRunnerRun({ accountId: A.accountId, runnerId: laptop })).toMatchObject({ kind: "claimed", runId: id });
    });

    it("AC5: the polling runner is never removed by its own rule: a wake runner whose stamp is older than a pending anchor still gets that run", async () => {
      const solo = await runner(A, { seenAgo: 10 * MIN });
      const id = await pending(A, { since: T0 - 200 * SEC });
      expect(await gated().claimRunnerRun({ accountId: A.accountId, runnerId: solo })).toMatchObject({ kind: "claimed", runId: id });
    });

    it("AC5: the polling runner is itself the preferred one, meets the rule, and still takes the run over an answering peer", async () => {
      const { desktop, laptop } = await setup(10 * MIN);
      const id = await pending(A, { since: T0 - 200 * SEC });
      await keepHeard(laptop, T0);
      expect(await gated().claimRunnerRun({ accountId: A.accountId, runnerId: desktop })).toMatchObject({ kind: "claimed", runId: id });
      expect((await status(id)).runner_id).toBe(desktop);
    });

    it("AC6: two claims racing as the preferred runner comes back: exactly one running row", async () => {
      const { desktop, laptop } = await setup(10 * MIN);
      const id = await pending(A, { since: T0 });
      clock = T0 + 90 * SEC;
      await keepHeard(laptop, clock);
      const results = await Promise.all([desktop, laptop].map((runnerId) => gated().claimRunnerRun({ accountId: A.accountId, runnerId })));
      const claimed = results.filter((r) => r.kind === "claimed");
      expect(claimed).toHaveLength(1);
      expect((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE id = $1 AND status = 'running'", [id])).rows[0].n).toBe(1);
    });
  });

  describe("cost (AC8)", () => {
    /** A pool whose every statement (pool-level or on a checked-out client) is counted. */
    function counting(pool: Pool): { pool: Pool; count: () => number } {
      let n = 0;
      const spy = {
        query: (...a: unknown[]) => ((n += 1), (pool.query as (...x: unknown[]) => unknown)(...a)),
        connect: async () => {
          const client = await pool.connect();
          const q = client.query.bind(client) as (...x: unknown[]) => unknown;
          (client as unknown as { query: unknown }).query = (...a: unknown[]) => ((n += 1), q(...a));
          return client;
        },
      } as unknown as Pool;
      return { pool: spy, count: () => n };
    }
    /** Installs a counting Runtime Cache for the duration of `work` and returns how many calls it saw. */
    async function cacheCalls(work: () => Promise<unknown>): Promise<number> {
      let calls = 0;
      const store = { get: async () => ((calls += 1), null), set: async () => void (calls += 1), delete: async () => void (calls += 1) };
      setPendingHooks({ store });
      try {
        await work();
      } finally {
        setPendingHooks(null);
      }
      return calls;
    }
    const keepHeard = (id: string, at: number) => admin.query("UPDATE runners SET last_seen_at = $2::timestamptz WHERE id = $1", [id, iso(at)]);
    async function claimCost(o: { removedPeer: boolean }): Promise<{ statements: number; cache: number; claimed: boolean }> {
      A = await seedAccount(admin, randomUUID());
      await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
      // Desktop is preferred. In one fixture it never answered (the rule removes it); in the other it answered just after the anchor (the rule keeps it).
      // Past 120 s the hold has ended either way, so both fixtures end in the same claim.
      const desktop = await runner(A, { seenAgo: 10 * MIN });
      const laptop = await runner(A);
      await admin.query("UPDATE repos SET runner_routing = $2::jsonb WHERE id = $1", [A.repoId, JSON.stringify({ prefer: [desktop] })]);
      await pending(A, { since: T0 });
      clock = T0 + 130 * SEC;
      await keepHeard(laptop, clock);
      if (!o.removedPeer) await keepHeard(desktop, T0 + 5 * SEC);
      const spy = counting(writerPool);
      const facade = createRunnerClaimFacade(spy.pool, { visibility: { visibility: async () => "private" }, now: () => clock, randomBetween: (min) => min, wakeEnabled: () => true });
      let result: { kind: string } | undefined;
      const cache = await cacheCalls(async () => {
        result = await facade.claimRunnerRun({ accountId: A.accountId, runnerId: laptop });
      });
      return { statements: spy.count(), cache, claimed: result?.kind === "claimed" };
    }

    it("claim path: a peer the rule removes costs the same statements and cache calls as a peer it keeps, with the same outcome", async () => {
      const removed = await claimCost({ removedPeer: true });
      const kept = await claimCost({ removedPeer: false });
      expect(removed.claimed).toBe(true);
      expect(kept.claimed).toBe(true);
      expect(removed.statements).toBeGreaterThan(0);
      expect(removed.statements).toBe(kept.statements);
      expect(removed.cache).toBe(kept.cache);
    });

    it("claim path: an answering preferred peer holds the run the same way, at the same cost, with the wake gate open or closed", async () => {
      const run = async (wakeEnabled: boolean) => {
        A = await seedAccount(admin, randomUUID());
        await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
        const desktop = await runner(A, { seenAgo: 30 * SEC });
        const laptop = await runner(A);
        await admin.query("UPDATE repos SET runner_routing = $2::jsonb WHERE id = $1", [A.repoId, JSON.stringify({ prefer: [desktop] })]);
        await pending(A, { since: T0 - 60 * SEC });
        const spy = counting(writerPool);
        const facade = createRunnerClaimFacade(spy.pool, { visibility: { visibility: async () => "private" }, now: () => clock, randomBetween: (min) => min, wakeEnabled: () => wakeEnabled });
        let kind = "";
        const cache = await cacheCalls(async () => {
          kind = (await facade.claimRunnerRun({ accountId: A.accountId, runnerId: laptop })).kind;
        });
        return { kind, statements: spy.count(), cache };
      };
      const closed = await run(false);
      const open = await run(true);
      expect(open.kind).toBe("idle");
      expect(open.kind).toBe(closed.kind);
      expect(open.statements).toBe(closed.statements);
      expect(open.cache).toBe(closed.cache);
    });

    it("notice path: the rule is evaluated for an answering wake runner at the same statement count as the plain test, and adds no cache call", async () => {
      const run = async (wakeEnabled: boolean) => {
        // The sweep lists every account's waiting runs, so each side starts with only its own.
        await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
        A = await seedAccount(admin, randomUUID());
        await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
        const id = await pending(A, { since: T0 });
        await admin.query("UPDATE agent_runs SET created_at = $2::timestamptz WHERE id = $1", [id, iso(T0)]);
        // Heard 30 s ago: live by both tests, and after the anchor, so the rule reads false. Both sweeps look again in 5 minutes.
        await runner(A, { seenAgo: 0 });
        clock = T0 + 20 * MIN;
        await admin.query("UPDATE runners SET last_seen_at = $2::timestamptz WHERE account_id = $1", [A.accountId, iso(clock - 30 * SEC)]);
        const spy = counting(writerPool);
        let result: Awaited<ReturnType<ReturnType<typeof createRunnerNoticeSweeper>["sweepRunnerNotices"]>> | undefined;
        const cache = await cacheCalls(async () => {
          result = await createRunnerNoticeSweeper(spy.pool, { now: () => clock, wakeEnabled: () => wakeEnabled }).sweepRunnerNotices();
        });
        return { waiting: result?.waitingEmitted, statements: spy.count(), cache };
      };
      const closed = await run(false);
      const open = await run(true);
      expect(open.waiting).toBe(0);
      expect(open.waiting).toBe(closed.waiting);
      expect(open.statements).toBeGreaterThan(0);
      expect(open.statements).toBe(closed.statements);
      expect(open.cache).toBe(0);
      expect(closed.cache).toBe(0);
    });
  });
});
