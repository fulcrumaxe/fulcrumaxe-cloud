import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runActionSteps, sweepRunActions, type RunActionsWorker } from "../src/runActions/index.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { HASH, runActionsWorld } from "./helpers/runActionsWorld.js";

/**
 * D#2 H14c-3b, C3 and C6 [pg]: the workflow's step bodies and the sweep over the REAL
 * facade and the REAL definers (run_action_claim / _settle / _list_due / _purge), with a
 * fake sandbox registry. Zero model tokens.
 */
describe("run actions end to end on real Postgres [pg]", () => {
  const db = pgHarness();
  const w = runActionsWorld(db);

  it("a done action has exactly one run_action.settled row and one run.status_changed to cancelled", async () => {
    const a = await w.fresh();
    const runId = await w.run(a);
    const { registry, stops } = w.fakeRegistry();
    const id = await w.request(a, "cancel_run", runId);

    expect(await runActionSteps(w.facadeFor(registry), id)).toEqual({ id, state: "done" });

    const row = await w.actionRow(id);
    expect(row.state).toBe("done");
    expect(row.outcome).toEqual({ status: "cancelled", settled_usd: 0.25, released_usd: 0.75 });
    expect(await w.statusOf(runId)).toBe("cancelled");
    expect(stops).toEqual([runId]);
    expect(await w.events("run_action.settled", id)).toHaveLength(1);
    expect(await w.events("run_action.failed", id)).toHaveLength(0);
    const changes = await w.events("run.status_changed", runId);
    expect(changes.filter((e) => e.payload.to === "cancelled")).toHaveLength(1);
    // A second pass over the same id is a duplicate: the claim finds nothing, nothing is written again.
    expect(await runActionSteps(w.facadeFor(registry), id)).toBeNull();
    expect(await w.events("run_action.settled", id)).toHaveLength(1);
    expect(stops).toHaveLength(1);
  });

  it("a policy refusal under lock settles refused once with its code and never retries", async () => {
    const a = await w.fresh();
    const { registry, stops } = w.fakeRegistry();
    const runId = await w.run(a);
    const id = await w.request(a, "cancel_run", runId);
    await db.admin.query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId]);

    expect(await runActionSteps(w.facadeFor(registry), id)).toEqual({ id, state: "refused" });
    const row = await w.actionRow(id);
    expect(row).toMatchObject({ state: "refused", error_code: "principal_not_authorised", outcome: { reason: "principal_not_authorised" } });
    expect(await w.statusOf(runId)).toBe("running");
    expect(stops).toEqual([]);
    expect(await w.events("run_action.settled", id)).toHaveLength(1);
    expect(await w.events("run_action.failed", id)).toHaveLength(0);
  });

  it("a performer that fails 5 times ends failed with exactly one run_action.failed row; the first 4 back off 2^attempts x 5 s", async () => {
    const a = await w.fresh();
    const runId = await w.run(a);
    const { registry, stops } = w.fakeRegistry();
    const real = w.facadeFor(registry);
    const failing: RunActionsWorker = {
      ...real,
      performCancelRun: async () => {
        throw Object.assign(new Error("driver text that must never be stored"), { name: "RunActionUnavailableError" });
      },
    };
    const id = await w.request(a, "cancel_run", runId);

    for (let attempt = 1; attempt <= 4; attempt++) {
      const before = Date.now();
      expect(await runActionSteps(failing, id)).toEqual({ id, state: "accepted" });
      const row = await w.actionRow(id);
      expect(row).toMatchObject({ state: "accepted", attempts: attempt });
      const delayMs = row.not_before.getTime() - before;
      expect(delayMs).toBeGreaterThan(2 ** attempt * 5000 - 2000);
      expect(delayMs).toBeLessThan(2 ** attempt * 5000 + 5000);
      expect(await runActionSteps(failing, id)).toBeNull(); // not due yet: the claim refuses
      await w.makeDue(id);
    }
    expect(await runActionSteps(failing, id)).toEqual({ id, state: "accepted" }); // the 5th attempt reports accepted; the definer decides
    const row = await w.actionRow(id);
    expect(row).toMatchObject({ state: "failed", attempts: 5, error_code: "worker_unavailable" });
    expect(JSON.stringify(row)).not.toContain("driver text");
    expect(await w.events("run_action.failed", id)).toHaveLength(1);
    expect(await w.events("run_action.settled", id)).toHaveLength(1);
    expect(await w.statusOf(runId)).toBe("running");
    expect(stops).toEqual([]);
  });

  describe("C6: the sweep through the real facade", () => {
    /** An accepted row of the given age for a cancel of a run that does not exist (the sweep only needs it listed). */
    async function seedAged(a: { accountId: string; userId: string }, seconds: number, over = "accepted"): Promise<string> {
      const { rows } = await db.admin.query(
        `INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash, state, finished_at)
         VALUES ($1, 'cancel_run', $2, $3, 'session', $4, $5, CASE WHEN $5 = 'accepted' THEN NULL ELSE now() END) RETURNING id`,
        [a.accountId, randomUUID(), `session:${a.userId}`, HASH, over],
      );
      await db.admin.query("UPDATE run_action_requests SET created_at = now() - make_interval(secs => $2) WHERE id = $1", [rows[0].id, seconds]);
      return rows[0].id;
    }

    it("a 31 s-old accepted row is picked up and a 29 s-old one is not; the sweep leases nothing; the started workflow's claim does", async () => {
      const a = await w.fresh();
      const old = await seedAged(a, 31);
      const young = await seedAged(a, 29);
      const { registry } = w.fakeRegistry();
      const real = w.facadeFor(registry);
      const started: string[] = [];

      const result = await sweepRunActions({ worker: real, startWorkflow: async (id) => void started.push(id), log: () => {} });

      expect(started).toContain(old);
      expect(started).not.toContain(young);
      expect(result.configured).toBe(true);
      expect(await w.actionRow(old)).toMatchObject({ state: "accepted", attempts: 0 }); // listed, not leased
      // What the started workflow does next: claim (lease + attempts), perform, settle.
      expect(await runActionSteps(real, old)).toEqual({ id: old, state: "refused" }); // its run does not exist
      expect(await w.actionRow(old)).toMatchObject({ state: "refused", attempts: 1, error_code: "target_not_found" });
    });

    it("an expired lease is listed and re-claimed", async () => {
      const a = await w.fresh();
      const id = await seedAged(a, 120);
      const { registry } = w.fakeRegistry();
      const real = w.facadeFor(registry);
      expect(await real.claimRunAction(id, 60)).toMatchObject({ attempts: 1 });
      await db.admin.query("UPDATE run_action_requests SET claimed_until = now() - interval '1 second' WHERE id = $1", [id]);
      const started: string[] = [];

      await sweepRunActions({ worker: real, startWorkflow: async (s) => void started.push(s), log: () => {} });

      expect(started).toContain(id);
      expect(await real.claimRunAction(id, 60)).toMatchObject({ id, attempts: 2 });
    });

    it("a live lease is not listed", async () => {
      const a = await w.fresh();
      const id = await seedAged(a, 120);
      const { registry } = w.fakeRegistry();
      const real = w.facadeFor(registry);
      await real.claimRunAction(id, 60);
      const started: string[] = [];
      await sweepRunActions({ worker: real, startWorkflow: async (s) => void started.push(s), log: () => {} });
      expect(started).not.toContain(id);
    });

    it("purges a 91-day-old done row and keeps a 91-day-old accepted one (only finished rows are purged)", async () => {
      const a = await w.fresh();
      const done = await seedAged(a, 91 * 86400, "done");
      await db.admin.query("UPDATE run_action_requests SET finished_at = now() - interval '91 days' WHERE id = $1", [done]);
      const accepted = await seedAged(a, 91 * 86400);
      const recent = await seedAged(a, 10 * 86400, "done");
      await db.admin.query("UPDATE run_action_requests SET finished_at = now() - interval '10 days' WHERE id = $1", [recent]);
      const { registry } = w.fakeRegistry();

      const result = await sweepRunActions({ worker: w.facadeFor(registry), startWorkflow: async () => {}, log: () => {} });

      expect(result.purged).toBeGreaterThanOrEqual(1);
      expect(await w.actionRow(done)).toBeUndefined();
      expect(await w.actionRow(accepted)).toBeDefined();
      expect(await w.actionRow(recent)).toBeDefined();
    });
  });
});
