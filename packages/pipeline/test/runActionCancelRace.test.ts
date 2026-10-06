import { describe, expect, it } from "vitest";
import { runActionSteps, sweepRunActions, type RunActionsWorker } from "../src/runActions/index.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { runActionsWorld } from "./helpers/runActionsWorld.js";

/**
 * D#2 H14c-3b, C4 [pg]: cancel performers are idempotent by action id. The REAL facade and
 * definers on real Postgres; the fake sandbox's `cancel` is the stop, counted per case.
 * The requests are written by the real `run_action_request` definer (session member, or an
 * API token's creator), never forged.
 */
describe("cancel run actions: exactly once under races and crashes [pg]", () => {
  const db = pgHarness();
  const w = runActionsWorld(db);

  /** Backdates a request so the sweep lists it (it is listed from 30 s of age). */
  const age = (id: string) => db.admin.query("UPDATE run_action_requests SET created_at = now() - interval '2 minutes' WHERE id = $1", [id]);

  async function setup() {
    const a = await w.fresh();
    const runId = await w.run(a);
    const { registry, stops } = w.fakeRegistry();
    const worker = w.facadeFor(registry);
    const id = await w.request(a, "cancel_run", runId);
    return { a, runId, stops, worker, id };
  }

  async function expectDoneOnce(id: string, runId: string, stops: string[]) {
    expect((await w.actionRow(id)).state).toBe("done");
    expect(await w.statusOf(runId)).toBe("cancelled");
    expect(stops).toEqual([runId]); // the sandbox stop, exactly once
    expect(await w.events("run_action.settled", id)).toHaveLength(1);
    expect((await w.events("run.status_changed", runId)).filter((e) => e.payload.to === "cancelled")).toHaveLength(1);
  }

  it("(a) two kicks for one accepted row: one wins the claim, done once, one stop", async () => {
    const { runId, stops, worker, id } = await setup();
    const results = await Promise.all([runActionSteps(worker, id), runActionSteps(worker, id)]);
    expect(results.filter((r) => r !== null)).toEqual([{ id, state: "done" }]);
    await expectDoneOnce(id, runId, stops);
  });

  it("(b) a kick racing the sweep: the sweep lists without leasing, one claim wins, done once, one stop", async () => {
    const { runId, stops, worker, id } = await setup();
    await age(id);
    const fromSweep: Array<Promise<unknown>> = [];
    const [, kicked] = await Promise.all([
      sweepRunActions({ worker, startWorkflow: async (s) => void fromSweep.push(s === id ? runActionSteps(worker, s) : Promise.resolve()), log: () => {} }),
      runActionSteps(worker, id),
    ]);
    await Promise.all(fromSweep);
    expect(kicked === null || kicked.state === "done").toBe(true);
    await expectDoneOnce(id, runId, stops);
    expect((await w.actionRow(id)).attempts).toBe(1); // the sweep's list took no claim of its own
  });

  it("(c) a worker crash between the side effect and the settle: the sweep re-runs it, done once, still one stop", async () => {
    const { runId, stops, worker, id } = await setup();
    const crashing: RunActionsWorker = {
      ...worker,
      settleRunAction: async () => {
        throw new Error("worker died before settle");
      },
    };
    await expect(runActionSteps(crashing, id)).rejects.toThrow("died");
    // The side effect happened; the row is still leased and unsettled.
    expect(await w.statusOf(runId)).toBe("cancelled");
    expect(stops).toEqual([runId]);
    expect((await w.actionRow(id)).state).toBe("claimed");
    expect(await runActionSteps(worker, id)).toBeNull(); // the lease is live: a duplicate kick does nothing

    await db.admin.query("UPDATE run_action_requests SET claimed_until = now() - interval '1 second' WHERE id = $1", [id]);
    const again: Array<Promise<unknown>> = [];
    await sweepRunActions({ worker, startWorkflow: async (s) => void again.push(s === id ? runActionSteps(worker, s) : Promise.resolve()), log: () => {} });
    await Promise.all(again);

    await expectDoneOnce(id, runId, stops);
    expect((await w.actionRow(id)).attempts).toBe(2);
  });

  it("cancelling an already-terminal run settles done and makes no sandbox call", async () => {
    const a = await w.fresh();
    const runId = await w.run(a, "succeeded");
    const { registry, stops } = w.fakeRegistry();
    const id = await w.request(a, "cancel_run", runId);
    expect(await runActionSteps(w.facadeFor(registry), id)).toEqual({ id, state: "done" });
    expect((await w.actionRow(id)).outcome).toMatchObject({ status: "succeeded" });
    expect(stops).toEqual([]);
    expect(await w.statusOf(runId)).toBe("succeeded");
  });

  it("a token-requested cancel_run reaches done and the sandbox stop is called once", async () => {
    const a = await w.fresh();
    const runId = await w.run(a);
    const { registry, stops } = w.fakeRegistry();
    const id = await w.request(a, "cancel_run", runId, await w.token(a));
    expect((await w.actionRow(id)).principal_kind).toBe("token");
    expect(await runActionSteps(w.facadeFor(registry), id)).toEqual({ id, state: "done" });
    await expectDoneOnce(id, runId, stops);
  });

  it("the same token action after the token is revoked (before perform) settles refused principal_not_authorised, with no stop", async () => {
    const a = await w.fresh();
    const runId = await w.run(a);
    const { registry, stops } = w.fakeRegistry();
    const tokenId = await w.token(a);
    const id = await w.request(a, "cancel_run", runId, tokenId);
    await db.admin.query("UPDATE api_tokens SET revoked_at = now() WHERE id = $1", [tokenId]);
    expect(await runActionSteps(w.facadeFor(registry), id)).toEqual({ id, state: "refused" });
    expect(await w.actionRow(id)).toMatchObject({ state: "refused", error_code: "principal_not_authorised" });
    expect(stops).toEqual([]);
    expect(await w.statusOf(runId)).toBe("running");
  });

  it("cancel_work_item over two live runs and one finished run: two stops, done, stage needs_human", async () => {
    const a = await w.fresh();
    const itemId = await w.item(a);
    const live1 = await w.run(a, "running", itemId);
    const live2 = await w.run(a, "pending", itemId);
    const finished = await w.run(a, "succeeded", itemId);
    const { registry, stops } = w.fakeRegistry();
    const id = await w.request(a, "cancel_work_item", itemId);

    expect(await runActionSteps(w.facadeFor(registry), id)).toEqual({ id, state: "done" });

    expect([...stops].sort()).toEqual([live1, live2].sort());
    expect(await w.statusOf(live1)).toBe("cancelled");
    expect(await w.statusOf(live2)).toBe("cancelled");
    expect(await w.statusOf(finished)).toBe("succeeded");
    const row = await w.actionRow(id);
    expect(row.state).toBe("done");
    expect(row.outcome).toMatchObject({ runs_cancelled: 2, stage: "needs_human" });
    expect((await db.admin.query("SELECT stage FROM work_items WHERE id = $1", [itemId])).rows[0].stage).toBe("needs_human");
    expect(await w.events("run_action.settled", id)).toHaveLength(1);
  });
});
