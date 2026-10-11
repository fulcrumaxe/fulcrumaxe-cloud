import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createHandoffCloudTarget, runnerJobsConfigured } from "../src/handoffTarget.js";
import { createSeatResolver } from "../src/seat.js";

/**
 * [pg] D#599 HO-2a: the cloud target of a run handoff, on the web tier's own login (app_user), which is the login the request route runs
 * on. The seat resolver was written for the run-writer login, so the first thing shown is that it answers the same seat on this one.
 */
describe("handoff cloud target [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let writerPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, writerPool]) await p.end();
  });

  async function team(budget = 500): Promise<SeedRefs> {
    const refs = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE accounts SET model_budget_usd_month = $2 WHERE id = $1", [refs.accountId, budget]);
    return refs;
  }
  const target = () => createHandoffCloudTarget({ pool: appPool, env: {} });
  const rows = async (accountId: string) => (await admin.query("SELECT budget, state, run_id, purpose, usd_reserved::float AS usd FROM spend_reservations WHERE account_id = $1 AND run_id IS NULL ORDER BY budget", [accountId])).rows;

  it("the seat on the web login is the seat on the run-writer login: same model, caps and spend facts", async () => {
    const a = await team();
    const input = { accountId: a.accountId, role: "code-reviewer", workItemId: a.workItemId };
    const onWriter = await createSeatResolver({ pool: writerPool })(input);
    const seated = await target().seat(input);
    expect(onWriter.ok).toBe(true);
    expect(seated.ok).toBe(true);
    if (!onWriter.ok || !seated.ok) return;
    const taken = await withTenant(appPool, a.accountId, (client) => seated.reserve(client));
    expect(taken.ok).toBe(true);
    const spend = onWriter.seat.spend;
    expect(await rows(a.accountId)).toEqual([
      { budget: "foreground_compute", state: "open", run_id: null, purpose: "run", usd: expect.closeTo(spend.estimateComputeUsd!, 3) },
      { budget: "model", state: "open", run_id: null, purpose: "run", usd: spend.estimateModelUsd },
    ]);
    if (taken.ok) expect(taken.reservations.modelId).not.toBeNull();
    if (taken.ok) expect(taken.reservations.computeId).not.toBeNull();
  });

  it("the reservations belong to no run, count against the month like any open reservation, and a rolled-back transaction leaves none", async () => {
    const a = await team(60);
    const seated = await target().seat({ accountId: a.accountId, role: "code-reviewer", workItemId: a.workItemId });
    if (!seated.ok) throw new Error(`seat refused: ${seated.reason}`);
    await expect(
      withTenant(appPool, a.accountId, async (client) => {
        expect((await seated.reserve(client)).ok).toBe(true);
        throw new Error("a later step of the request failed");
      }),
    ).rejects.toThrow("a later step");
    expect(await rows(a.accountId)).toEqual([]);
    // Kept: the first admitted reservation holds the month's budget, so a second move is refused with spend's own word.
    expect((await withTenant(appPool, a.accountId, (client) => seated.reserve(client))).ok).toBe(true);
    const refused = await withTenant(appPool, a.accountId, (client) => seated.reserve(client));
    expect(refused).toEqual({ ok: false, reason: expect.stringMatching(/^(model_budget_exceeded|work_item_cap_exceeded|compute_cap_exceeded)$/) });
    expect((await rows(a.accountId)).length).toBe(2);
  });

  it("a seat that cannot be made is a fixed word, and nothing is written", async () => {
    const noBudget = await team(0);
    expect(await target().seat({ accountId: noBudget.accountId, role: "code-reviewer", workItemId: noBudget.workItemId })).toEqual({ ok: false, reason: "model_budget_unset" });
    expect(await target().seat({ accountId: noBudget.accountId, role: "no-such-role", workItemId: noBudget.workItemId })).toEqual({ ok: false, reason: "unknown_role" });
    expect(await target().seat({ accountId: randomUUID(), role: "code-reviewer", workItemId: noBudget.workItemId })).toEqual({ ok: false, reason: "account_not_found" });
    expect(await rows(noBudget.accountId)).toEqual([]);
  });
});

describe("runnerJobsConfigured (D#599 HO-2a)", () => {
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  it("is true only for a valid key pair: unset, half-set and a bad key all read as no", () => {
    expect(runnerJobsConfigured({})).toBe(false);
    expect(runnerJobsConfigured({ FX_RUNNER_JOB_SIGNING_KEY_PEM: pem })).toBe(false);
    expect(runnerJobsConfigured({ FX_RUNNER_JOB_SIGNER_ID: "signer-1" })).toBe(false);
    expect(runnerJobsConfigured({ FX_RUNNER_JOB_SIGNING_KEY_PEM: "not a key", FX_RUNNER_JOB_SIGNER_ID: "signer-1" })).toBe(false);
    expect(runnerJobsConfigured({ FX_RUNNER_JOB_SIGNING_KEY_PEM: pem, FX_RUNNER_JOB_SIGNER_ID: "signer-1" })).toBe(true);
  });
});
