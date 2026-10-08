import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { INVENTORY_MAX_PAGES_PER_PREFIX, SANDBOX_IDLE_CAP_PER_ACCOUNT, SANDBOX_TOTAL_HIGH, STRAY_RUNNING_GRACE_MS, sandboxInventory, sweepSandboxReap, type SweepSandboxReapInput } from "../src/sandboxReap.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { createVercelSandboxPort } from "../src/vercelSandboxPort.js";
import { sandboxNameFor } from "../src/sandboxNaming.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness, type SandboxTargetTestHarness } from "./helpers/sandboxTargetFakes.js";
import { createReaperSdkFake } from "./helpers/reaperSdkFake.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * D#2 SANDBOX-REAPER-1b, C81 criteria 6, 14 and 15 over real Postgres: the 1-day safety net (settled sandboxes only), the inventory
 * and the alert codes. The kill switch lives in the cron handler (apps/web) and is tested there. [pg]
 */
describe("D#2 SANDBOX-REAPER-1b: the safety net and the inventory [pg]", () => {
  const db = pgHarness();
  let h: SandboxTargetTestHarness;
  let target: SandboxTarget;
  const lines: string[] = [];

  // Every [pg] file shares one database: ephemeral and inventory facts other files left must not reach this file's passes.
  beforeEach(async () => {
    await db.admin.query(`
      INSERT INTO sandbox_reaps (sandbox_name, account_id, run_id, reason, state, claimed_at, done_at)
      SELECT s.sandbox_name, s.account_id, s.run_id, 'ephemeral', 'deleted', now(), now() + interval '1 day'
        FROM sandbox_reap_ephemeral_state(NULL, NULL) s
      ON CONFLICT (sandbox_name) DO UPDATE SET state = 'deleted', done_at = EXCLUDED.done_at`);
    await db.admin.query(`
      INSERT INTO sandbox_reaps (sandbox_name, account_id, run_id, reason, state, claimed_at, done_at)
      SELECT s.sandbox_name, s.account_id, s.run_id, 'terminal', 'deleted', now(), now() + interval '1 day'
        FROM sandbox_reap_ex_state(NULL, NULL) s
      ON CONFLICT (sandbox_name) DO UPDATE SET state = 'deleted', done_at = EXCLUDED.done_at`);
    await db.admin.query(`DELETE FROM sandbox_inventory`);
    h = createSandboxTargetHarness(db.runWriterPool);
    target = new SandboxTarget(h.deps);
    lines.length = 0;
  });

  const deps = (clock?: () => number) => ({ pool: db.runWriterPool, port: h.deps.sandboxPort, stopStray: (run: Parameters<SandboxTarget["stopStraySandbox"]>[0]) => target.stopStraySandbox(run), log: (l: string) => void lines.push(l), ...(clock && { clock }) });
  const sweep = (over: Partial<SweepSandboxReapInput> = {}, clock?: () => number) =>
    sweepSandboxReap(deps(clock), { pass: "ephemeral", mode: "on", now: Date.now(), cursor: null, maxCalls: 60, timeBudgetMs: 600_000, ...over });
  const inventory = () => sandboxInventory({ pool: db.runWriterPool, port: h.deps.sandboxPort, log: (l) => void lines.push(l) }, { now: Date.now() });
  const mutating = () => h.fakeSandbox.state.calls.filter((c) => /^(delete|stop):/.test(c));
  const deletedNames = () => h.fakeSandbox.state.deleted.map((d) => d.sandboxName);
  const logged = (event: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === event);

  interface World { accountId: string; repoId: string }
  async function world(): Promise<World> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    return { accountId, repoId };
  }

  interface RunOpts { status?: string; endedHoursAgo?: number; ledger?: boolean; settleDue?: boolean; reservation?: { budget: string; state: string }; provider?: "stopped" | "running" | "none"; role?: string; recordedName?: string }
  /** A non-executor run that ended `endedHoursAgo` (25) hours ago, with its compute settled, and its sandbox stopped at the provider. */
  async function rnRun(w: World, o: RunOpts = {}): Promise<{ name: string; runId: string }> {
    const runId = randomUUID();
    const role = o.role ?? "project-manager";
    const name = sandboxNameFor({ role: role as never, runId, accountId: w.accountId });
    await db.admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, sandbox_name, created_at, compute_settle_due_at)
       VALUES ($1, $2, $3, 'production', $4, $5, now() - interval '30 hours', CASE WHEN $6::boolean THEN now() ELSE NULL END)`,
      [runId, w.accountId, role, o.status ?? "succeeded", o.recordedName ?? name, o.settleDue ?? false],
    );
    // ended_at is set once by a trigger when a terminal status first lands; the test sets it by hand with the triggers off.
    await db.admin.query(`ALTER TABLE agent_runs DISABLE TRIGGER USER`);
    try {
      await db.admin.query(`UPDATE agent_runs SET ended_at = now() - make_interval(hours => $2::int) WHERE id = $1`, [runId, o.endedHoursAgo ?? 25]);
    } finally {
      await db.admin.query(`ALTER TABLE agent_runs ENABLE TRIGGER USER`);
    }
    if (o.ledger !== false) await db.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'compute', 'sandbox', 0.5, $2, 'foreground_compute')`, [w.accountId, runId]);
    if (o.reservation) await db.admin.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget) VALUES ($1, $2, 1, $3, $4)`, [w.accountId, runId, o.reservation.state, o.reservation.budget]);
    const provider = o.provider ?? "stopped";
    if (provider !== "none") h.fakeSandbox.seedProviderSandbox(o.recordedName ?? name, { status: provider, persistent: false });
    return { name: o.recordedName ?? name, runId };
  }
  const reapRow = async (name: string) => (await db.admin.query(`SELECT state, reason FROM sandbox_reaps WHERE sandbox_name = $1`, [name])).rows[0] as { state: string; reason: string } | undefined;
  const audit = async (name: string) => (await db.admin.query(`SELECT account_id, payload FROM audit_log WHERE action = 'sandbox.reaped' AND payload->>'sandbox_name' = $1`, [name])).rows;

  describe("criterion 6: the 1-day safety net deletes settled sandboxes only", () => {
    it("a settled run that ended 25 hours ago: its stopped sandbox is deleted (snapshots asked for), the claim is deleted and an audit row is written", async () => {
      const w = await world();
      const c = await rnRun(w);
      const result = await sweep();
      expect(result).toMatchObject({ deleted: 1, stopped: 0, skipped: 0, wrapped: true, cursor: null, orphans: 0, alerts: [] });
      expect(result.candidates).toEqual([{ accountId: w.accountId, sandboxName: c.name, reason: "ephemeral" }]);
      expect(deletedNames()).toEqual([c.name]);
      expect(await reapRow(c.name)).toEqual({ state: "deleted", reason: "ephemeral" });
      expect(await audit(c.name)).toEqual([{ account_id: w.accountId, payload: { reason: "ephemeral", sandbox_name: c.name, run_id: c.runId } }]);
    });

    it("a settled run that ended 23 hours ago: not listed, not read at the provider, not deleted", async () => {
      const w = await world();
      const c = await rnRun(w, { endedHoursAgo: 23 });
      expect(await sweep()).toMatchObject({ deleted: 0, candidates: [], alerts: [] });
      expect(h.fakeSandbox.state.calls.filter((x) => x.includes(c.name))).toEqual([]);
      expect(await reapRow(c.name)).toBeUndefined();
    });

    for (const [label, opts] of [
      ["no compute ledger row", { ledger: false }],
      ["a settle still owed", { settleDue: true }],
      ["an open compute reservation", { reservation: { budget: "foreground_compute", state: "open" } }],
    ] as const) {
      it(`an unsettled run (${label}) that ended 25 hours ago: not deleted, no claim, and sandbox_unsettled_stale is reported`, async () => {
        const w = await world();
        const c = await rnRun(w, opts);
        const result = await sweep();
        expect(result).toMatchObject({ deleted: 0, skipped: 1 });
        expect(result.alerts).toEqual(["sandbox_unsettled_stale"]);
        expect(result.candidates).toEqual([{ accountId: w.accountId, sandboxName: c.name, reason: "ephemeral_unsettled" }]); // listed, never acted on
        expect(mutating()).toEqual([]);
        expect(await reapRow(c.name)).toBeUndefined();
        expect(h.fakeSandbox.state.snapshots).toEqual([]);
      });
    }

    it("a settle that completes later lets the next pass delete it", async () => {
      const w = await world();
      const c = await rnRun(w, { settleDue: true });
      await sweep();
      expect(mutating()).toEqual([]);
      await db.admin.query(`ALTER TABLE agent_runs DISABLE TRIGGER USER`);
      try {
        await db.admin.query(`UPDATE agent_runs SET compute_settle_due_at = NULL WHERE id = $1`, [c.runId]);
      } finally {
        await db.admin.query(`ALTER TABLE agent_runs ENABLE TRIGGER USER`);
      }
      const result = await sweep();
      expect(result.alerts).toEqual([]);
      expect(deletedNames()).toEqual([c.name]);
    });

    it("an unsettled run whose sandbox the provider no longer has is nothing to report", async () => {
      const w = await world();
      const c = await rnRun(w, { ledger: false, provider: "none" });
      h.fakeSandbox.scriptComputeState(c.name, "gone");
      expect(await sweep()).toMatchObject({ deleted: 0, skipped: 1, alerts: [] });
      expect(mutating()).toEqual([]);
    });

    it("a live run (pending, running, paused) under the name is never a candidate", async () => {
      const w = await world();
      for (const status of ["pending", "running", "paused"]) await rnRun(w, { status });
      expect(await sweep()).toMatchObject({ deleted: 0, candidates: [], alerts: [] });
      expect(mutating()).toEqual([]);
    });

    it("a sandbox the provider no longer has is done without a delete call; one whose state cannot be read is left for the next pass", async () => {
      const w = await world();
      const gone = await rnRun(w, { provider: "none" });
      const unknown = await rnRun(w);
      h.fakeSandbox.scriptComputeState(gone.name, "gone");
      h.fakeSandbox.scriptComputeState(unknown.name, "unknown");
      expect(await sweep()).toMatchObject({ deleted: 1, skipped: 1 });
      expect(mutating()).toEqual([]);
      expect((await reapRow(gone.name))!.state).toBe("deleted");
      expect(await reapRow(unknown.name)).toBeUndefined();
    });

    it("dry_run: one JSON line per candidate (unsettled ones too, with their reason), nothing mutated at the provider, no claim written", async () => {
      const w = await world();
      const ok = await rnRun(w);
      const owed = await rnRun(w, { ledger: false });
      const result = await sweep({ mode: "dry_run" });
      expect(result.candidates.map((x) => [x.sandboxName, x.reason]).sort()).toEqual([[ok.name, "ephemeral"], [owed.name, "ephemeral_unsettled"]].sort());
      expect(logged("sandbox_reap.candidate").map((l) => [l.name, l.reason, l.account_id]).sort()).toEqual([[ok.name, "ephemeral", w.accountId], [owed.name, "ephemeral_unsettled", w.accountId]].sort());
      expect(result).toMatchObject({ deleted: 0, stopped: 0, alerts: [] });
      expect(mutating()).toEqual([]);
      expect([await reapRow(ok.name), await reapRow(owed.name)]).toEqual([undefined, undefined]);
    });

    it("a sandbox still running a day after its run ended is stopped (no reservation released), then deleted by a later pass", async () => {
      const w = await world();
      const c = await rnRun(w, { provider: "running", reservation: { budget: "model", state: "open" } });
      const later = Date.now() + STRAY_RUNNING_GRACE_MS;
      expect(await sweep({ now: later })).toMatchObject({ stopped: 1, deleted: 0 });
      expect(mutating()).toEqual([`stop:${c.name}`]);
      expect((await db.admin.query(`SELECT state FROM spend_reservations WHERE run_id = $1`, [c.runId])).rows).toEqual([{ state: "open" }]);
      await sweep({ now: later });
      expect(deletedNames()).toEqual([c.name]);
    });
  });

  describe("what is not ours, and the tenant binding", () => {
    it("an rn- sandbox with no run row, an rlr0- one, an ex- one and a foreign name all survive a pass; the orphan count is 1 and only rn- is listed", async () => {
      const w = await world();
      const stranger = `rn-15-project-manager-${randomUUID()}`;
      h.fakeSandbox.seedProviderSandbox(stranger, { snapshot: true });
      h.fakeSandbox.seedProviderSandbox("rlr0-spike-1", { snapshot: true });
      h.fakeSandbox.seedProviderSandbox(`ex-${randomUUID()}-${randomUUID()}-5`, { persistent: true, snapshot: true });
      h.fakeSandbox.seedProviderSandbox("fx-sandbox-foreign-name", { snapshot: true });
      const ours = await rnRun(w);
      for (const mode of ["dry_run", "on"] as const) {
        const result = await sweep({ mode });
        expect(result.orphans, mode).toBe(1);
        expect(result.alerts, mode).toContain("sandbox_orphan_found");
      }
      expect(deletedNames()).toEqual([ours.name]);
      expect(h.fakeSandbox.state.calls.filter((c) => c.startsWith("list:")).every((c) => c === "list:rn-")).toBe(true);
      expect(h.fakeSandbox.state.calls.filter((c) => c.includes("rlr0") || c.includes("foreign") || c.includes(stranger))).toEqual([]);
      expect(await reapRow(stranger)).toBeUndefined();
    });

    it("a recorded name that is not what the run row derives (another run's id) is not touched, and the mismatch is reported", async () => {
      const w = await world();
      const forged = `rn-15-project-manager-${randomUUID()}`;
      await rnRun(w, { recordedName: forged });
      const good = await rnRun(w);
      const result = await sweep();
      expect(result.alerts).toContain("sandbox_name_mismatch");
      expect(result).toMatchObject({ deleted: 1, skipped: 1 });
      expect(deletedNames()).toEqual([good.name]);
      expect(h.fakeSandbox.state.calls.filter((c) => c.includes(forged) && !c.startsWith("list:"))).toEqual([]);
      expect(await reapRow(forged)).toBeUndefined();
    });

    it("a name that two tenants' runs both record is deleted for neither", async () => {
      const a = await world();
      const b = await world();
      const mine = await rnRun(a);
      await rnRun(b, { recordedName: mine.name, provider: "none" }); // forced as the superuser: 0706's trigger refuses it to everyone else
      await sweep();
      expect(mutating()).toEqual([]);
      expect(await reapRow(mine.name)).toBeUndefined();
    });
  });

  describe("budget, cursor, overlap, provider failures and time", () => {
    it("100 candidates against a budget of 60: exactly 60 calls, and the next pass resumes from the cursor (an rn- cursor)", async () => {
      const w = await world();
      const names: string[] = [];
      for (let i = 0; i < 100; i++) names.push((await rnRun(w)).name);
      const first = await sweep({ maxCalls: 60 });
      expect(first.callsUsed).toBe(60);
      expect(first).toMatchObject({ deleted: 30, wrapped: false });
      expect(first.cursor).toMatch(/^rn-/);
      expect(deletedNames()).toEqual(names.slice().sort().slice(0, 30));
      let cursor = first.cursor;
      for (let i = 0; i < 4 && cursor !== null; i++) cursor = (await sweep({ maxCalls: 60, cursor })).cursor;
      expect(deletedNames().sort()).toEqual(names.slice().sort());
      expect(new Set(deletedNames()).size).toBe(100);
    });

    it("two overlapping passes (a lost lease): each name gets at most one delete call", async () => {
      const w = await world();
      const names: string[] = [];
      for (let i = 0; i < 12; i++) names.push((await rnRun(w)).name);
      const [a, b] = await Promise.all([sweep(), sweep()]);
      const deletes = h.fakeSandbox.state.calls.filter((c) => c.startsWith("delete:"));
      expect(new Set(deletes).size).toBe(deletes.length);
      expect(deletedNames().sort()).toEqual(names.slice().sort());
      expect(a.deleted + b.deleted).toBe(12);
    });

    for (const status of [429, 503]) {
      it(`a ${status} on the delete leaves the claim to expire; the next pass after it deletes`, async () => {
        const w = await world();
        const c = await rnRun(w);
        h.fakeSandbox.failDelete(c.name, status);
        expect(await sweep()).toMatchObject({ deleted: 0, skipped: 1 });
        expect((await reapRow(c.name))!.state).toBe("claimed");
        h.fakeSandbox.healDelete(c.name);
        await sweep();
        expect(deletedNames()).toEqual([]);
        await db.admin.query(`UPDATE sandbox_reaps SET claimed_at = now() - interval '11 minutes' WHERE sandbox_name = $1`, [c.name]);
        await sweep();
        expect(deletedNames()).toEqual([c.name]);
      });
    }

    it("a 404 or 410 on the delete is success; any other failure closes the claim as skipped and the name is tried again", async () => {
      const w = await world();
      const a = await rnRun(w);
      const b = await rnRun(w);
      const c = await rnRun(w);
      h.fakeSandbox.failDelete(a.name, 404);
      h.fakeSandbox.failDelete(b.name, 410);
      h.fakeSandbox.failDelete(c.name, 403);
      expect(await sweep()).toMatchObject({ deleted: 2, skipped: 1 });
      expect((await reapRow(a.name))!.state).toBe("deleted");
      expect((await reapRow(c.name))!.state).toBe("skipped");
      expect(await audit(c.name)).toEqual([]);
      h.fakeSandbox.healDelete(c.name);
      await sweep();
      expect(deletedNames()).toContain(c.name);
    });

    it("the reconcile job's 60 s budget still lets a pass work: the time reserve is never more than half the budget", async () => {
      const w = await world();
      const names: string[] = [];
      for (let i = 0; i < 5; i++) names.push((await rnRun(w)).name);
      // Before the fix a 150 s reserve against a 60 s budget stopped the pass before its first candidate.
      expect(await sweep({ timeBudgetMs: 60_000 })).toMatchObject({ deleted: 5 });
      expect(deletedNames().sort()).toEqual(names.slice().sort());
    });

    it("a pass stops starting candidates when the time left cannot cover one (a clock that moves 10 s per read, budget 60 s: 3 of 5)", async () => {
      const w = await world();
      for (let i = 0; i < 5; i++) await rnRun(w);
      let now = 0;
      const result = await sweep({ timeBudgetMs: 60_000, maxCalls: 60 }, () => (now += 10_000));
      expect(result.deleted).toBe(3);
      expect(result.wrapped).toBe(false);
      expect(result.cursor).not.toBeNull();
    });
  });

  describe("criterion 14: the inventory", () => {
    const rowsFor = async (...ids: string[]) =>
      (await db.admin.query(`SELECT account_id, live, stopped_executor, stopped_ephemeral, idle_executor, oldest_idle_at FROM sandbox_inventory WHERE account_id = ANY($1) ORDER BY account_id`, [ids])).rows;
    async function item(w: World, pr: number, stage = "merged"): Promise<string> {
      const id = randomUUID();
      await db.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage) VALUES ($1, $2, $3, 'feature', $4, 'internal', $5)`, [id, w.accountId, w.repoId, pr, stage]);
      return id;
    }
    async function exRun(w: World, pr: number, o: { provider: "stopped" | "running"; status?: string; stage?: string }): Promise<string> {
      const itemId = await item(w, pr, o.stage);
      const name = sandboxNameFor({ role: "executor", runId: randomUUID(), accountId: w.accountId, repoId: w.repoId, pr });
      await db.admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, sandbox_name, dispatch_repo_id, dispatch_pr_number)
         VALUES ($1, $2, $3, 'executor', 'production', $4, $5, $6, $7)`,
        [randomUUID(), w.accountId, itemId, o.status ?? "succeeded", name, w.repoId, pr],
      );
      h.fakeSandbox.seedProviderSandbox(name, { status: o.provider, persistent: true, snapshot: true });
      return name;
    }

    it("two accounts in mixed states: the rows match the hand-computed counts, the totals line and the result agree, and no alert fires", async () => {
      const a = await world();
      const b = await world();
      await exRun(a, 1, { provider: "stopped" });
      await exRun(a, 2, { provider: "stopped" });
      await exRun(a, 3, { provider: "running", status: "running", stage: "in_progress" });
      await rnRun(a); // a stopped rn-
      await rnRun(a, { provider: "running", status: "running" }); // a live rn-
      await exRun(b, 1, { provider: "stopped" });
      await rnRun(b);
      const base = await inventory(); // whatever other tests of this file left is replaced; read back only these two accounts
      expect(await rowsFor(a.accountId)).toEqual([{ account_id: a.accountId, live: 2, stopped_executor: 2, stopped_ephemeral: 1, idle_executor: 2, oldest_idle_at: expect.any(Date) }]);
      expect(await rowsFor(b.accountId)).toEqual([{ account_id: b.accountId, live: 0, stopped_executor: 1, stopped_ephemeral: 1, idle_executor: 1, oldest_idle_at: expect.any(Date) }]);
      expect(base).toEqual({ accounts: 2, live: 2, stoppedExecutor: 3, stoppedEphemeral: 2, orphans: 0, alerts: [] });
      expect(logged("sandbox_inventory")).toEqual([{ event: "sandbox_inventory", accounts: 2, live: 2, stopped_executor: 3, stopped_ephemeral: 2, total: 7, orphans: 0, complete: true }]);
    });

    it("it keeps no history: the second pass replaces the first, and an account whose sandboxes are gone has no row", async () => {
      const w = await world();
      const name = await exRun(w, 1, { provider: "stopped" });
      await inventory();
      expect((await rowsFor(w.accountId)).length).toBe(1);
      await h.deps.sandboxPort.deleteSandbox({ runId: randomUUID(), sandboxName: name });
      await inventory();
      expect(await rowsFor(w.accountId)).toEqual([]);
    });

    it("the listing is fully paged (two to a page), and a name that is not exactly one of ours is neither counted nor sent to the database", async () => {
      h.fakeSandbox.setListPageSize(2);
      const w = await world();
      for (let pr = 1; pr <= 5; pr++) await exRun(w, pr, { provider: "stopped" });
      h.fakeSandbox.seedProviderSandbox("ex-not-a-real-shape", {});
      h.fakeSandbox.seedProviderSandbox("rn-3-x-short", {});
      const result = await inventory();
      expect(result).toMatchObject({ accounts: 1, stoppedExecutor: 5, stoppedEphemeral: 0, orphans: 0, alerts: [] });
      expect(await rowsFor(w.accountId)).toMatchObject([{ stopped_executor: 5, idle_executor: 5 }]);
    });

    it("a provider failure throws and the previous inventory stands", async () => {
      const w = await world();
      await exRun(w, 1, { provider: "stopped" });
      await inventory();
      h.fakeSandbox.failList(503);
      await expect(inventory()).rejects.toMatchObject({ status: 503 });
      expect((await rowsFor(w.accountId)).length).toBe(1);
    });

    it("a list longer than the page cap is incomplete: nothing is written (the previous rows stand) and one incomplete line is logged", async () => {
      const w = await world();
      await exRun(w, 1, { provider: "stopped" });
      await inventory();
      lines.length = 0;
      h.fakeSandbox.setListPageSize(1);
      for (let i = 0; i < INVENTORY_MAX_PAGES_PER_PREFIX + 1; i++) h.fakeSandbox.seedProviderSandbox(`ex-${randomUUID()}-${randomUUID()}-${i + 1}`, {});
      const result = await inventory();
      expect(result.accounts).toBe(0);
      expect(logged("sandbox_inventory.incomplete")).toHaveLength(1);
      expect((await rowsFor(w.accountId)).length).toBe(1);
    });

    it("through the real Vercel port: stopping and snapshotting count as live; stopped, failed and aborted as stopped", async () => {
      const w = await world();
      const sdk = createReaperSdkFake();
      const statuses = ["pending", "running", "stopping", "snapshotting", "stopped", "failed", "aborted"] as const;
      const names: string[] = [];
      for (const [i, status] of statuses.entries()) {
        const name = await exRun(w, i + 1, { provider: "stopped" });
        names.push(name);
        sdk.seed(name, status, { persistent: true });
      }
      sdk.pageLimit = 3;
      const port = createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk: sdk.sdk });
      const result = await sandboxInventory({ pool: db.runWriterPool, port, log: () => undefined }, { now: Date.now() });
      expect(result).toMatchObject({ live: 4, stoppedExecutor: 3, stoppedEphemeral: 0, accounts: 1 });
      expect(await rowsFor(w.accountId)).toMatchObject([{ live: 4, stopped_executor: 3, idle_executor: 3 }]);
      expect(sdk.waking).toEqual([]);
      expect(sdk.calls.every((c) => c.startsWith("list:"))).toBe(true);
    });
  });

  describe("criterion 15: each alert fires on its condition and not otherwise", () => {
    async function idleExecutors(w: World, n: number, from = 1): Promise<void> {
      for (let pr = from; pr < from + n; pr++) {
        const itemId = randomUUID();
        await db.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage) VALUES ($1, $2, $3, 'feature', $4, 'internal', 'merged')`, [itemId, w.accountId, w.repoId, pr]);
        const name = sandboxNameFor({ role: "executor", runId: randomUUID(), accountId: w.accountId, repoId: w.repoId, pr });
        await db.admin.query(
          `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, sandbox_name, dispatch_repo_id, dispatch_pr_number)
           VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', $4, $5, $6)`,
          [randomUUID(), w.accountId, itemId, name, w.repoId, pr],
        );
        h.fakeSandbox.seedProviderSandbox(name, { status: "stopped", persistent: true });
      }
    }

    it("sandbox_cap_exceeded: 21 idle executors in one account fire it; 20 do not", async () => {
      const w = await world();
      await idleExecutors(w, SANDBOX_IDLE_CAP_PER_ACCOUNT);
      expect((await inventory()).alerts).toEqual([]);
      await idleExecutors(w, 1, SANDBOX_IDLE_CAP_PER_ACCOUNT + 1);
      expect((await inventory()).alerts).toEqual(["sandbox_cap_exceeded"]);
    });

    it("sandbox_orphan_found: a listed sandbox no run row owns fires it; an estate with none does not", async () => {
      const w = await world();
      await idleExecutors(w, 1);
      expect((await inventory()).alerts).toEqual([]);
      h.fakeSandbox.seedProviderSandbox(`rn-15-project-manager-${randomUUID()}`, {});
      expect(await inventory()).toMatchObject({ orphans: 1, alerts: ["sandbox_orphan_found"] });
    });

    it("sandbox_total_high: more than 1000 named sandboxes fire it; exactly 1000 do not", async () => {
      for (let i = 0; i < SANDBOX_TOTAL_HIGH; i++) h.fakeSandbox.seedProviderSandbox(`rn-15-project-manager-${randomUUID()}`, {});
      expect((await inventory()).alerts).not.toContain("sandbox_total_high");
      h.fakeSandbox.seedProviderSandbox(`rn-15-project-manager-${randomUUID()}`, {});
      expect((await inventory()).alerts).toContain("sandbox_total_high");
    });
  });
});
