import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { effectiveRoleModel } from "@fx/core/src/role-settings/runPrice.js";
import { checkHeadroom, childEnvelopeRoom, envelopeSpentUsd, reserve, settle } from "@fx/spend";
import { childFirstRunUsd } from "../../src/estimate/estimateItem.js";
import { seedAccount } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * [pg] The staging deadlock: a split parent approved with a small item envelope refused every planned PR child with `parent_envelope_reached` right after its
 * panel and Spec had run. Two things were wrong, both in how a run on a subscription is priced and counted:
 *
 *  1. The price of the child's first run (one executor run) is the tenant's median once the role has 10 runs on its model. The median only read ledger rows from
 *     API-key sources, and a run on a person's own machine writes none, so ten executor runs gave a median of $0. A price that is not positive makes the room
 *     check answer "does not fit" with nothing left, whatever the envelope holds.
 *  2. A run on the operator's subscription is charged to its envelope at an estimated price when it starts (15 or 35 dollars a run) and the charge was never
 *     taken back: the finished run counted its estimate and its real, settled figure on top of it.
 */
const h = pgHarness();
const inTenant = <T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> => withTenant(h.pureAppUserPool, accountId, fn);

interface World {
  accountId: string;
  userId: string;
  repoId: string;
  runnerId: string;
  envelopeId: string;
  parent: string;
  child: string;
}

async function world(amountUsd: number): Promise<World> {
  const accountId = randomUUID();
  await seedAccount(h.admin, accountId);
  const userId = randomUUID();
  await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')", [accountId, userId]);
  const repoId = randomUUID();
  await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'runner_local', 'acme', $4)`, [repoId, accountId, Math.floor(Math.random() * 1_000_000_000), `d${repoId.slice(0, 8)}`]);
  const runnerId = randomUUID();
  const jkt = runnerId.replace(/-/g, "").padEnd(43, "k");
  await h.admin.query("INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3, $4::jsonb, $5, 'subscription')", [runnerId, accountId, userId, JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jkt }), jkt]);
  const envelopeId = randomUUID();
  await h.admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', $3, 1, $4)`, [envelopeId, accountId, amountUsd, userId]);
  const item = async (stage: string, withEnvelope: boolean): Promise<string> =>
    (await h.admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, envelope_id, stage) VALUES ($1, $2, 'feature', 'internal', $3, $4) RETURNING id`, [accountId, repoId, withEnvelope ? envelopeId : null, stage])).rows[0]!.id;
  return { accountId, userId, repoId, runnerId, envelopeId, parent: await item("spec_ready", true), child: await item("triaged", false) };
}

/** A finished run of a person's own machine: the runner reported tokens and the cloud priced them (the way `recordRunnerUsage` does). No ledger row, no reservation. */
async function runnerRun(w: World, role: string, workItemId: string, apiEquivalentUsd: number | null, status = "succeeded"): Promise<string> {
  const id = randomUUID();
  await h.admin.query(
    `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, execution_mode, status, model, runner_id, dispatch_repo_id) VALUES ($1, $2, $3, $4, 'runner', 'runner_local', $8, $5, $6, $7)`,
    [id, w.accountId, workItemId, role, effectiveRoleModel(role, null), w.runnerId, w.repoId, status],
  );
  await h.admin.query(
    `INSERT INTO runner_run_usage (account_id, run_id, runner_id, credential_mode, model, input_tokens, output_tokens, api_equivalent_usd, price_table_version) VALUES ($1, $2, $3, 'subscription', $4, 1000, 500, $5, $6)`,
    [w.accountId, id, w.runnerId, effectiveRoleModel(role, null), apiEquivalentUsd, apiEquivalentUsd === null ? null : "2026-11-01"],
  );
  return id;
}

const room = async (w: World) => {
  const price = await inTenant(w.accountId, (c) => childFirstRunUsd(c, { accountId: w.accountId, repoId: w.repoId }));
  const r = await inTenant(w.accountId, (c) => childEnvelopeRoom(c, { accountId: w.accountId, envelopeId: w.envelopeId, childId: w.child, firstRunUsd: price }));
  return { price, ...r };
};
const spent = (w: World) => inTenant(w.accountId, (c) => envelopeSpentUsd(c, w.accountId, w.envelopeId));

describe("a split parent's envelope is not used up by its subscription runs", () => {
  it("the staging case: settled panel and Spec runs at about a dollar each and a dozen executor runs on the person's machine leave the envelope room for a child", async () => {
    const w = await world(30);
    for (let i = 0; i < 5; i += 1) await runnerRun(w, i % 2 === 0 ? "technical-architect" : "project-manager", w.parent, 1);
    for (let i = 0; i < 12; i += 1) await runnerRun(w, "executor", w.parent, 1);
    const r = await room(w);
    // The price is the tenant's own median ($1 a run), not $0 (which refused every child) and not the seed (which is for a tenant with no history).
    expect(r.price).toBe(1);
    expect(r).toMatchObject({ fits: true, pendingItems: 0 });
    expect(await spent(w)).toBeCloseTo(17, 6);
    expect(r.remainingUsd).toBeCloseTo(13, 6);
  });

  it("with fewer than ten executor runs the seed prices the child, and a few settled runs at about a dollar each still leave the envelope room for it", async () => {
    const w = await world(30);
    for (let i = 0; i < 5; i += 1) await runnerRun(w, "project-manager", w.parent, 1);
    const r = await room(w);
    expect(r.price).toBeGreaterThan(1);
    expect(await spent(w)).toBeCloseTo(5, 6);
    expect(r.fits).toBe(true);
  });

  it("a run that reported tokens but has no price counts nothing and is not read as a price either", async () => {
    const w = await world(30);
    for (let i = 0; i < 12; i += 1) await runnerRun(w, "executor", w.parent, null);
    const r = await room(w);
    expect(r.price).toBeGreaterThan(0);
    expect(r.fits).toBe(true);
    expect(await spent(w)).toBe(0);
  });

  it("runs without a price are left out of the median, not counted as $0: six priced at $2 and six unpriced are six runs of history, so the seed still prices the child", async () => {
    const w = await world(30);
    for (let i = 0; i < 6; i += 1) await runnerRun(w, "executor", w.parent, 2);
    for (let i = 0; i < 6; i += 1) await runnerRun(w, "executor", w.parent, null);
    const seeded = await room(await world(30));
    expect((await room(w)).price).toBe(seeded.price);
    // At ten priced runs the median is the price.
    for (let i = 0; i < 4; i += 1) await runnerRun(w, "executor", w.parent, 2);
    expect((await room(w)).price).toBe(2);
  });

  it("a median of $0 from runs that booked nothing is no price: the seed prices the child instead", async () => {
    const w = await world(30);
    for (let i = 0; i < 12; i += 1) {
      const id = randomUUID();
      await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, model) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', $4)`, [id, w.accountId, w.parent, effectiveRoleModel("executor", null)]);
      await h.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', 0, $2, 'model')`, [w.accountId, id]);
    }
    expect((await room(w)).price).toBe((await room(await world(30))).price);
  });

  it("a run that holds an estimate and then reports a priced usage counts that figure once", async () => {
    const w = await world(30);
    const runId = await runnerRun(w, "executor", w.parent, 1.5);
    await h.admin.query("INSERT INTO envelope_run_charges (account_id, run_id, envelope_id, usd) VALUES ($1, $2, $3, 35)", [w.accountId, runId, w.envelopeId]);
    expect(await spent(w)).toBeCloseTo(1.5, 6);
  });

  const operatorOpts = { plan: "starter", estimateModelUsd: 0, modelBrokeredBy: "operator_subscription", envelopeFloorUsd: 15, perSpawnCapUsd: 40 } as const;
  const pendingRun = async (w: World, role: string): Promise<string> => {
    const id = randomUUID();
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, $4, 'production', 'pending')`, [id, w.accountId, w.parent, role]);
    return id;
  };

  it("an operator subscription run booked the way the real settle books it ($0 model row) still holds its estimate: ten sequential runs on a small envelope stop after two", async () => {
    const w = await world(30);
    const decisions: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const runId = await pendingRun(w, "technical-architect");
      const taken = await reserve(h.pureAppUserPool, { ...operatorOpts, accountId: w.accountId, runId, workItemId: w.parent });
      decisions.push(taken.decision);
      if (taken.decision !== "admit") continue;
      await h.admin.query(`UPDATE agent_runs SET status = 'running', started_at = now() WHERE id = $1`, [runId]);
      // sandboxTarget.modelLedgerEntry: an operator run books a model row of $0 from the operator_subscription source, through settleWith.
      await settle(h.pureAppUserPool, { accountId: w.accountId, runId, entries: [{ budget: "model", actualUsd: 0, source: "operator_subscription" }] });
      await h.admin.query(`UPDATE agent_runs SET status = 'succeeded', ended_at = now() WHERE id = $1`, [runId]);
    }
    expect(decisions).toEqual(["admit", "admit", ...Array<string>(8).fill("deny")]);
    expect(await spent(w)).toBeCloseTo(30, 6);
  });

  it("a finished run with a positive billed model figure counts that figure once, not its estimate on top; the headroom check and the room check read the same sum", async () => {
    const w = await world(30);
    for (let i = 0; i < 5; i += 1) {
      const runId = await pendingRun(w, "technical-architect");
      expect((await reserve(h.pureAppUserPool, { ...operatorOpts, accountId: w.accountId, runId, workItemId: w.parent })).decision, `run ${i}`).toBe("admit");
      expect(await spent(w)).toBeCloseTo(i + 15, 6);
      await h.admin.query(`UPDATE agent_runs SET status = 'running', started_at = now() WHERE id = $1`, [runId]);
      await h.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_anthropic', 1, $2, 'model')`, [w.accountId, runId]);
      await h.admin.query(`UPDATE agent_runs SET status = 'succeeded', ended_at = now() WHERE id = $1`, [runId]);
      expect(await spent(w)).toBeCloseTo(i + 1, 6);
    }
    expect((await checkHeadroom(h.pureAppUserPool, { ...operatorOpts, accountId: w.accountId, workItemId: w.parent })).decision).toBe("admit");
    expect((await room(w)).fits).toBe(true);
    expect((await reserve(h.pureAppUserPool, { ...operatorOpts, accountId: w.accountId, runId: await pendingRun(w, "executor"), workItemId: w.parent })).decision).toBe("admit");
  });

  it("runner runs still going are left out of the median: a partial figure would pull it down", async () => {
    const w = await world(30);
    for (let i = 0; i < 10; i += 1) await runnerRun(w, "executor", w.parent, 0.01, "running");
    const seeded = await room(await world(30));
    expect((await room(w)).price).toBe(seeded.price);
    for (let i = 0; i < 10; i += 1) await runnerRun(w, "executor", w.parent, 2);
    expect((await room(w)).price).toBe(2);
  });

  it("a run with no price at all still fails closed, and a finished run that never reported a figure keeps its estimate", async () => {
    const w = await world(30);
    const base = { plan: "starter", estimateModelUsd: 0, modelBrokeredBy: "operator_subscription", perSpawnCapUsd: 40 } as const;
    const noPrice = randomUUID();
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'pending')`, [noPrice, w.accountId, w.parent]);
    expect(await reserve(h.pureAppUserPool, { ...base, accountId: w.accountId, runId: noPrice, workItemId: w.parent })).toEqual({ decision: "deny", reason: "envelope_exceeded" });
    expect((await checkHeadroom(h.pureAppUserPool, { ...base, accountId: w.accountId, workItemId: w.parent })).decision).toBe("deny");

    const lost = randomUUID();
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'pending')`, [lost, w.accountId, w.parent]);
    expect((await reserve(h.pureAppUserPool, { ...base, envelopeFloorUsd: 15, accountId: w.accountId, runId: lost, workItemId: w.parent })).decision).toBe("admit");
    await h.admin.query(`UPDATE agent_runs SET status = 'running', started_at = now() WHERE id = $1`, [lost]);
    await h.admin.query(`UPDATE agent_runs SET status = 'failed', ended_at = now() WHERE id = $1`, [lost]);
    // Over, with no ledger row and no usage: nothing says what it really cost, so the estimate stays.
    expect(await spent(w)).toBeCloseTo(15, 6);
  });

  it("a runner run still going counts what it has reported so far", async () => {
    const w = await world(30);
    await runnerRun(w, "executor", w.parent, 2.5, "running");
    expect(await spent(w)).toBeCloseTo(2.5, 6);
  });
});
