import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { TERMINAL_WORK_ITEM_STAGES } from "@fx/core/src/work-items/stages.js";
import { STRAY_RUNNING_GRACE_MS, sweepSandboxReap, type SweepSandboxReapInput } from "../src/sandboxReap.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { createVercelSandboxPort } from "../src/vercelSandboxPort.js";
import { buildExecutionRun } from "../src/startAgentRun.js";
import { sandboxNameFor } from "../src/sandboxNaming.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness, type SandboxTargetTestHarness } from "./helpers/sandboxTargetFakes.js";
import { createReaperSdkFake } from "./helpers/reaperSdkFake.js";
import { pgHarness } from "./helpers/pgHarness.js";

/** D#2 SANDBOX-REAPER-1a, C81 criteria 5, 7, 8, 9, 11 (and 2 through the real port): the end-of-item pass over real Postgres. [pg] */
describe("D#2 SANDBOX-REAPER-1a: the end-of-item pass [pg]", () => {
  const db = pgHarness();
  let h: SandboxTargetTestHarness;
  let target: SandboxTarget;
  const lines: string[] = [];

  // Every [pg] file shares one database: names other tests left as candidates must not reach this file's passes.
  beforeEach(async () => {
    await db.admin.query(`
      INSERT INTO sandbox_reaps (sandbox_name, account_id, run_id, reason, state, claimed_at, done_at)
      SELECT s.sandbox_name, s.account_id, s.run_id, 'terminal', 'deleted', now(), now() + interval '1 day'
        FROM sandbox_reap_ex_state(NULL, NULL) s
       WHERE s.n_accounts = 1 AND NOT s.has_live AND NOT s.has_action AND s.n_items > 0 AND s.n_open = 0
      ON CONFLICT (sandbox_name) DO UPDATE SET state = 'deleted', done_at = EXCLUDED.done_at`);
    h = createSandboxTargetHarness(db.runWriterPool);
    target = new SandboxTarget(h.deps);
    lines.length = 0;
  });

  const deps = () => ({ pool: db.runWriterPool, port: h.deps.sandboxPort, stopStray: (run: Parameters<SandboxTarget["stopStraySandbox"]>[0]) => target.stopStraySandbox(run), log: (l: string) => void lines.push(l) });
  const sweep = (over: Partial<SweepSandboxReapInput> = {}) => sweepSandboxReap(deps(), { pass: "terminal", mode: "on", now: Date.now(), cursor: null, maxCalls: 60, timeBudgetMs: 600_000, ...over });
  const providerCalls = () => h.fakeSandbox.state.calls.filter((c) => !c.startsWith("list:"));
  const mutating = () => h.fakeSandbox.state.calls.filter((c) => /^(delete|stop):/.test(c));

  interface World { accountId: string; repoId: string }
  async function world(): Promise<World> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    return { accountId, repoId };
  }
  const nameOf = (w: World, pr: number) => sandboxNameFor({ role: "executor", runId: randomUUID(), accountId: w.accountId, repoId: w.repoId, pr });
  async function item(w: World, pr: number, stage: string): Promise<string> {
    const id = randomUUID();
    await db.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage) VALUES ($1, $2, $3, 'feature', $4, 'internal', $5)`, [id, w.accountId, w.repoId, pr, stage]);
    return id;
  }
  interface RunOpts { status?: string; createdAt?: string; settleDue?: boolean; role?: string; name?: string }
  async function run(w: World, name: string, pr: number, itemId: string | null, o: RunOpts = {}): Promise<string> {
    const id = randomUUID();
    await db.admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, sandbox_name, dispatch_repo_id, dispatch_pr_number, created_at, compute_settle_due_at)
       VALUES ($1, $2, $3, 'executor', 'production', $4, $5, $6, $7, COALESCE($8::timestamptz, now() - interval '1 hour'), CASE WHEN $9::boolean THEN now() ELSE NULL END)`,
      [id, w.accountId, itemId, o.status ?? "succeeded", name, w.repoId, pr, o.createdAt ?? null, o.settleDue ?? false],
    );
    return id;
  }
  /** The plain case: one finished run, one item at `stage`, and a stopped sandbox with its snapshot at the provider. */
  async function candidate(w: World, pr: number, o: { stage?: string; provider?: "stopped" | "running" | "none" } & RunOpts = {}) {
    const itemId = await item(w, pr, o.stage ?? "merged");
    const name = o.name ?? nameOf(w, pr);
    const runId = await run(w, name, pr, itemId, o);
    const provider = o.provider ?? "stopped";
    if (provider !== "none") h.fakeSandbox.seedProviderSandbox(name, { status: provider, persistent: true, snapshot: true });
    return { name, itemId, runId };
  }
  const reapRow = async (name: string) => (await db.admin.query(`SELECT state, reason FROM sandbox_reaps WHERE sandbox_name = $1`, [name])).rows[0] as { state: string; reason: string } | undefined;
  const audit = async (name: string) => (await db.admin.query(`SELECT account_id, payload FROM audit_log WHERE action = 'sandbox.reaped' AND payload->>'sandbox_name' = $1`, [name])).rows;
  const deletedNames = () => h.fakeSandbox.state.deleted.map((d) => d.sandboxName);

  it("the SQL stage list is the work-item graph's exported terminal list", async () => {
    const { rows } = await db.admin.query(`SELECT sandbox_reap_terminal_stages() AS v`);
    expect(rows[0].v).toEqual([...TERMINAL_WORK_ITEM_STAGES]);
    expect([...TERMINAL_WORK_ITEM_STAGES]).toEqual(expect.arrayContaining(["merged", "closed_unmerged", "closed"]));
  });

  describe("criterion 5: the terminal pass", () => {
    it("merged, closed_unmerged and closed items: the sandbox and its snapshot are deleted, the claim is recorded as deleted, and an audit row is written", async () => {
      const w = await world();
      const c = await candidate(w, 7);
      const u = await candidate(w, 8, { stage: "closed_unmerged" });
      const d = await candidate(w, 9, { stage: "closed" });
      const result = await sweep();
      expect(result).toMatchObject({ deleted: 3, stopped: 0, skipped: 0, wrapped: true, cursor: null, orphans: 0, alerts: [] });
      expect(result.candidates).toContainEqual({ accountId: w.accountId, sandboxName: c.name, reason: "terminal" });
      expect(deletedNames().sort()).toEqual([c.name, u.name, d.name].sort());
      expect(h.fakeSandbox.state.snapshots).toEqual([]);
      expect(await reapRow(c.name)).toEqual({ state: "deleted", reason: "terminal" });
      expect(await audit(c.name)).toEqual([{ account_id: w.accountId, payload: { reason: "terminal", sandbox_name: c.name, run_id: c.runId } }]);
    });

    it("the superseded issue row is closed while its typed twin is open: nothing is deleted or claimed", async () => {
      const w = await world();
      const c = await candidate(w, 9, { stage: "closed" });
      await item(w, 9, "in_progress");
      expect(await sweep()).toMatchObject({ deleted: 0, candidates: [] });
      expect(mutating()).toEqual([]);
      expect(await reapRow(c.name)).toBeUndefined();
    });

    for (const status of ["paused", "pending", "running"]) {
      it(`a live ${status} run: no delete`, async () => {
        const w = await world();
        const c = await candidate(w, 3);
        await run(w, c.name, 3, c.itemId, { status });
        expect(await sweep()).toMatchObject({ deleted: 0, candidates: [] });
        expect(mutating()).toEqual([]);
      });
    }

    it("a queued or leased run action for the item: no delete; once it is done the next pass deletes", async () => {
      const w = await world();
      const c = await candidate(w, 4);
      await db.admin.query(`INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash) VALUES ($1, 'advance_work_item', $2, 'session:x', 'session', 'h')`, [w.accountId, c.itemId]);
      await sweep();
      await db.admin.query(`UPDATE run_action_requests SET state = 'claimed', claimed_until = now() + interval '5 minutes', attempts = 1 WHERE target_id = $1`, [c.itemId]);
      await sweep();
      expect(mutating()).toEqual([]);
      await db.admin.query(`UPDATE run_action_requests SET state = 'done', claimed_until = NULL, finished_at = now() WHERE target_id = $1`, [c.itemId]);
      await sweep();
      expect(deletedNames()).toEqual([c.name]);
    });

    it("a compute settle still owed, or an open compute reservation: the stopped sandbox is not deleted (the settle needs it); settled, the next pass deletes it", async () => {
      const w = await world();
      const c = await candidate(w, 5, { settleDue: true });
      const open = await candidate(w, 6);
      await db.admin.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget) VALUES ($1, $2, 1, 'open', 'foreground_compute')`, [w.accountId, open.runId]);
      const result = await sweep();
      expect(result).toMatchObject({ deleted: 0, skipped: 2 });
      expect(result.candidates).toContainEqual({ accountId: w.accountId, sandboxName: c.name, reason: "terminal_unsettled" });
      expect(mutating()).toEqual([]);
      expect(await reapRow(c.name)).toBeUndefined();
      await db.admin.query(`UPDATE agent_runs SET compute_settle_due_at = NULL WHERE id = $1`, [c.runId]);
      await db.admin.query(`UPDATE spend_reservations SET state = 'settled' WHERE run_id = $1`, [open.runId]);
      await sweep();
      expect(deletedNames().sort()).toEqual([c.name, open.name].sort());
    });

    it("a sandbox the provider no longer has is done without a delete call; one whose state cannot be read is left for the next pass", async () => {
      const w = await world();
      const gone = await candidate(w, 10, { provider: "none" });
      const unknown = await candidate(w, 11);
      h.fakeSandbox.scriptComputeState(gone.name, "gone");
      h.fakeSandbox.scriptComputeState(unknown.name, "unknown");
      expect(await sweep()).toMatchObject({ deleted: 1, skipped: 1 });
      expect(mutating()).toEqual([]);
      expect((await reapRow(gone.name))!.state).toBe("deleted");
      expect(await reapRow(unknown.name)).toBeUndefined();
    });

    it("dry_run: it logs one JSON line per candidate, makes no provider call that changes anything and writes no claim", async () => {
      const w = await world();
      const a = await candidate(w, 12);
      const b = await candidate(w, 13);
      const result = await sweep({ mode: "dry_run" });
      expect(result.candidates.map((x) => x.sandboxName).sort()).toEqual([a.name, b.name].sort());
      expect(result).toMatchObject({ deleted: 0, stopped: 0 });
      expect(lines.map((l) => JSON.parse(l)).filter((l) => l.event === "sandbox_reap.candidate").map((l) => [l.name, l.reason, l.account_id]).sort()).toEqual([[a.name, "terminal", w.accountId], [b.name, "terminal", w.accountId]].sort());
      expect(mutating()).toEqual([]);
      expect([await reapRow(a.name), await reapRow(b.name)]).toEqual([undefined, undefined]);
    });

    it("input it cannot trust is refused: nothing is read either way", async () => {
      for (const bad of [{ cursor: "rn-1-x-2" }, { pass: "ephemeral" as const, cursor: "ex-a" }, { cursor: "ex-a b" }, { maxCalls: -1 }, { maxCalls: 1.5 }, { timeBudgetMs: 0 }, { now: Number.NaN }, { mode: "off" as never }, { pass: "other" as never }]) {
        await expect(sweep(bad), JSON.stringify(bad)).rejects.toThrow(TypeError);
      }
      expect(h.fakeSandbox.state.calls).toEqual([]);
    });
  });

  describe("criterion 7: a running sandbox for an ended run is stopped, never deleted in the same pass", () => {
    it("a cancelled run, sandbox still running, ended more than 10 minutes ago, no newer owner: stopped, and no reservation is released", async () => {
      const w = await world();
      const c = await candidate(w, 20, { status: "cancelled", provider: "running" });
      await db.admin.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget) VALUES ($1, $2, 1, 'open', 'model')`, [w.accountId, c.runId]);
      const later = Date.now() + STRAY_RUNNING_GRACE_MS + 60_000;
      const result = await sweep({ now: later });
      expect(result).toMatchObject({ stopped: 1, deleted: 0 });
      expect(h.fakeSandbox.state.stopped.map((s) => s.sandboxName)).toEqual([c.name]);
      expect(mutating()).toEqual([`stop:${c.name}`]);
      expect((await db.admin.query(`SELECT state FROM spend_reservations WHERE run_id = $1`, [c.runId])).rows).toEqual([{ state: "open" }]);
      // The next pass sees it stopped and deletes it by the normal rules.
      await sweep({ now: later });
      expect(deletedNames()).toEqual([c.name]);
    });

    it("an unsettled compute stays unsettled and unreleased when the stray sandbox is stopped; it is not deleted until settled", async () => {
      const w = await world();
      const c = await candidate(w, 21, { status: "cancelled", provider: "running", settleDue: true });
      await db.admin.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget) VALUES ($1, $2, 1, 'open', 'foreground_compute')`, [w.accountId, c.runId]);
      const later = Date.now() + STRAY_RUNNING_GRACE_MS + 60_000;
      await sweep({ now: later });
      await sweep({ now: later });
      expect(mutating()).toEqual([`stop:${c.name}`]);
      expect((await db.admin.query(`SELECT state FROM spend_reservations WHERE run_id = $1`, [c.runId])).rows).toEqual([{ state: "open" }]);
      expect((await db.admin.query(`SELECT count(*)::int AS n FROM ledger WHERE run_id = $1`, [c.runId])).rows[0].n).toBe(0);
    });

    it("ended less than 10 minutes ago: left alone", async () => {
      const w = await world();
      await candidate(w, 22, { status: "cancelled", provider: "running" });
      expect(await sweep({ now: Date.now() + STRAY_RUNNING_GRACE_MS - 120_000 })).toMatchObject({ stopped: 0, deleted: 0 });
      expect(mutating()).toEqual([]);
    });

    it("a newer live run owns the executor name: the sandbox is not stopped", async () => {
      const w = await world();
      const c = await candidate(w, 23, { status: "cancelled", provider: "running" });
      await run(w, c.name, 23, c.itemId, { status: "running", createdAt: new Date(Date.now() + 1000).toISOString() });
      await sweep({ now: Date.now() + 3_600_000 });
      expect(mutating()).toEqual([]);
    });

    it("the target's own test refuses too: with a newer pending or running run of the same name, stopStraySandbox stops nothing", async () => {
      const w = await world();
      const c = await candidate(w, 24, { status: "cancelled", provider: "running" });
      await run(w, c.name, 24, c.itemId, { status: "pending", createdAt: new Date(Date.now() + 1000).toISOString() });
      const execRun = buildExecutionRun(c.runId, { accountId: w.accountId, role: "executor", repoId: w.repoId, pr: 24, product: "team", roleCard: "", prompt: "", model: "haiku-4.5", capUsd: 5, spend: { plan: "starter" } } as never);
      await expect(target.stopStraySandbox(execRun)).resolves.toBe(false);
      expect(h.fakeSandbox.state.stopped).toEqual([]);
    });
  });

  describe("criterion 8: what is not ours is never deleted", () => {
    it("an ex- sandbox with no run row, an rlr0- sandbox and a foreign name all survive a pass; the orphan count is 1", async () => {
      const w = await world();
      const stranger = `ex-${randomUUID()}-${randomUUID()}-5`;
      h.fakeSandbox.seedProviderSandbox(stranger, { persistent: true, snapshot: true });
      h.fakeSandbox.seedProviderSandbox("rlr0-spike-1", { snapshot: true });
      h.fakeSandbox.seedProviderSandbox("fx-sandbox-foreign-name", { snapshot: true });
      const ours = await candidate(w, 30);
      for (const mode of ["dry_run", "on"] as const) {
        const result = await sweep({ mode });
        expect(result.orphans, mode).toBe(1);
        expect(result.alerts, mode).toContain("sandbox_orphan_found");
      }
      expect(deletedNames()).toEqual([ours.name]);
      expect([...h.fakeSandbox.state.snapshots].sort()).toEqual(["fx-sandbox-foreign-name", "rlr0-spike-1", stranger].sort());
      expect(await reapRow(stranger)).toBeUndefined();
      // The list asked only for the executor prefix, and no call named the other two.
      expect(h.fakeSandbox.state.calls.filter((c) => c.includes("rlr0") || c.includes("foreign"))).toEqual([]);
    });

  });

  describe("criterion 9: the name is re-derived from the run row before any provider call", () => {
    it("a recorded name that embeds another account than the row's account_id is not touched, and the mismatch is reported", async () => {
      const w = await world();
      const other = await world();
      const forged = `ex-${other.accountId}-${w.repoId}-40`;
      const itemId = await item(w, 40, "merged");
      await run(w, forged, 40, itemId); // inserted as the superuser: the 0706 trigger only guards UPDATEs
      h.fakeSandbox.seedProviderSandbox(forged, { persistent: true, snapshot: true });
      const good = await candidate(w, 41);
      const result = await sweep();
      expect(result.alerts).toContain("sandbox_name_mismatch");
      expect(result).toMatchObject({ deleted: 1, skipped: 1 });
      expect(deletedNames()).toEqual([good.name]);
      expect(h.fakeSandbox.state.calls.filter((c) => c.includes(forged))).toEqual([]);
      expect(await reapRow(forged)).toBeUndefined();
    });

  });

  describe("criterion 11: budget, cursor, overlap and provider failures", () => {
    it("100 candidates against a budget of 60: exactly 60 calls, and the next pass resumes from the cursor", async () => {
      const w = await world();
      const names: string[] = [];
      for (let pr = 1; pr <= 100; pr++) names.push((await candidate(w, pr)).name);
      const first = await sweep({ maxCalls: 60 });
      expect(first.callsUsed).toBe(60);
      expect(providerCalls()).toHaveLength(60);
      expect(first).toMatchObject({ deleted: 30, wrapped: false });
      expect(first.cursor).not.toBeNull();
      expect(deletedNames()).toEqual(names.slice().sort().slice(0, 30));
      const second = await sweep({ maxCalls: 60, cursor: first.cursor });
      expect(second.callsUsed).toBe(60);
      expect(deletedNames()).toEqual(names.slice().sort().slice(0, 60));
      const third = await sweep({ maxCalls: 60, cursor: second.cursor });
      const fourth = await sweep({ maxCalls: 60, cursor: third.cursor });
      expect(fourth).toMatchObject({ wrapped: true, cursor: null });
      expect(deletedNames().sort()).toEqual(names.slice().sort());
      expect(new Set(deletedNames()).size).toBe(100);
    });

    it("two overlapping passes (a lost lease): each name gets at most one delete call", async () => {
      const w = await world();
      const names: string[] = [];
      for (let pr = 1; pr <= 12; pr++) names.push((await candidate(w, pr)).name);
      const [a, b] = await Promise.all([sweep(), sweep()]);
      const deletes = h.fakeSandbox.state.calls.filter((c) => c.startsWith("delete:"));
      expect(new Set(deletes).size).toBe(deletes.length);
      expect(deletedNames().sort()).toEqual(names.slice().sort());
      expect(a.deleted + b.deleted).toBe(12);
    });

    for (const status of [429, 503]) {
      it(`a ${status} on the delete leaves the claim to expire: nothing is retried inside the claim window, and the next pass after it deletes`, async () => {
        const w = await world();
        const c = await candidate(w, 50);
        h.fakeSandbox.failDelete(c.name, status);
        expect(await sweep()).toMatchObject({ deleted: 0, skipped: 1 });
        expect((await reapRow(c.name))!.state).toBe("claimed");
        h.fakeSandbox.healDelete(c.name);
        await sweep();
        expect(deletedNames()).toEqual([]);
        await db.admin.query(`UPDATE sandbox_reaps SET claimed_at = now() - interval '11 minutes' WHERE sandbox_name = $1`, [c.name]);
        await sweep();
        expect(deletedNames()).toEqual([c.name]);
        expect((await reapRow(c.name))!.state).toBe("deleted");
      });
    }

    it("a 404 or 410 on the delete is success", async () => {
      const w = await world();
      const a = await candidate(w, 51);
      const b = await candidate(w, 52);
      h.fakeSandbox.failDelete(a.name, 404);
      h.fakeSandbox.failDelete(b.name, 410);
      expect(await sweep()).toMatchObject({ deleted: 2, skipped: 0 });
      expect((await reapRow(a.name))!.state).toBe("deleted");
      expect((await reapRow(b.name))!.state).toBe("deleted");
    });

    it("any other delete failure closes the claim as skipped, and the name is tried again on the next pass", async () => {
      const w = await world();
      const c = await candidate(w, 53);
      h.fakeSandbox.failDelete(c.name, 403);
      expect(await sweep()).toMatchObject({ deleted: 0, skipped: 1 });
      expect((await reapRow(c.name))!.state).toBe("skipped");
      expect(await audit(c.name)).toEqual([]);
      h.fakeSandbox.healDelete(c.name);
      await sweep();
      expect(deletedNames()).toEqual([c.name]);
    });

  });

  describe("criterion 2, through the real port: a pass wakes nothing", () => {
    it("a pass over the real Vercel port and an SDK fake reads state and deletes a stopped sandbox without resuming or running anything", async () => {
      const w = await world();
      const c = await candidate(w, 60, { provider: "none" });
      const sdk = createReaperSdkFake();
      sdk.seed(c.name, "stopped", { persistent: true, snapshot: true });
      sdk.seed(`ex-${randomUUID()}-${randomUUID()}-9`, "stopped"); // an orphan
      const port = createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk: sdk.sdk });
      const result = await sweepSandboxReap({ pool: db.runWriterPool, port, stopStray: async () => false, log: () => undefined }, { pass: "terminal", mode: "on", now: Date.now(), cursor: null, maxCalls: 60, timeBudgetMs: 600_000 });
      expect(result).toMatchObject({ deleted: 1, orphans: 1 });
      expect(sdk.waking).toEqual([]);
      expect(sdk.calls.filter((x) => x.startsWith("get:")).every((x) => x.endsWith("resume=false"))).toBe(true);
      expect(sdk.estate.has(c.name)).toBe(false);
      expect(sdk.snapshots.has(c.name)).toBe(false);
    });
  });
});
