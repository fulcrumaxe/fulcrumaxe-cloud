import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jwkThumbprint, signRequest, type Ed25519Jwk } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { REVOKE_PATH, revokeAllRunners, revokeRunner, selfRevokeRunner, toResponse, type RunnerCloudDeps } from "@fx/runner-cloud";
import { createRunnerLeaseFacade, type RunnerLeaseFacade } from "../src/runnerLeases.js";

/**
 * D#6 R2a criteria 4 and 7 end to end: the runner routes' revoke and the membership demotion, with the REAL worker
 * facade on the run-writer login, leave the runner's live runs `failed` with `runner_revoked` by the time the call returns.
 */
describe("revoking a runner fails its leases through the worker [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let facade: RunnerLeaseFacade;
  const ORIGIN = "https://runner.example.test";

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    facade = createRunnerLeaseFacade(writerPool);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool, writerPool, appPool].map((p) => p.end()));
  });

  const deps = (): RunnerCloudDeps => ({ appUserPool: appPool, origin: ORIGIN, failRunnerLeases: (input) => facade.failRunnerLeases(input) });
  async function run(f: F2Fixture, runnerId: string, status: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, runner_id) VALUES ($1, $2, 'executor', 'runner', $3, $4)`, [id, f.accountId, status, runnerId]);
    return id;
  }
  const status = async (id: string): Promise<string> => (await admin.query("SELECT status FROM agent_runs WHERE id = $1", [id])).rows[0].status as string;
  const reason = async (id: string): Promise<unknown> => (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed'", [id])).rows[0]?.payload?.failureReason;

  /** A runner of the fixture's account with a live, a queued and a paused run, and a bystander's running run. */
  async function scene(f: F2Fixture, registrant: string) {
    const key = generateKeyPairSync("ed25519");
    const jwk = key.publicKey.export({ format: "jwk" }) as Ed25519Jwk;
    const runner = await insertRunner(admin, f.accountId, registrant, { jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x }, jkt: jwkThumbprint(jwk) });
    const bystander = await insertRunner(admin, f.accountId, f.o2);
    return {
      key,
      jkt: jwkThumbprint(jwk),
      runner,
      running: await run(f, runner, "running"),
      pending: await run(f, runner, "pending"),
      paused: await run(f, runner, "paused"),
      other: await run(f, bystander, "running"),
    };
  }
  const expectFailed = async (s: Awaited<ReturnType<typeof scene>>) => {
    expect([await status(s.running), await status(s.pending)]).toEqual(["failed", "failed"]);
    expect([await reason(s.running), await reason(s.pending)]).toEqual(["runner_revoked", "runner_revoked"]);
    expect([await status(s.paused), await status(s.other)]).toEqual(["paused", "running"]);
  };

  it("a runner's own signed revoke", async () => {
    const f = await seedF2(admin);
    const s = await scene(f, f.a1);
    const body = Buffer.from("{}");
    const headers = signRequest({ method: "POST", url: `${ORIGIN}${REVOKE_PATH}`, body, privateKey: s.key.privateKey, keyid: s.jkt, nonce: randomBytes(16).toString("base64url"), created: Math.floor(Date.now() / 1000) });
    const res = await toResponse(() => selfRevokeRunner(deps(), { method: "POST", headers: { ...headers }, body }));
    expect(res).toMatchObject({ status: 200, body: { revoked: true, runs_failed: 2 } });
    await expectFailed(s);
  });

  it("a member's revoke and revoke-all", async () => {
    const f = await seedF2(admin);
    const one = await scene(f, f.a1);
    expect((await toResponse(() => revokeRunner(deps(), { accountId: f.accountId, userId: f.o1 }, one.runner))).status).toBe(200);
    await expectFailed(one);
    const all = await scene(f, f.a2);
    expect((await toResponse(() => revokeAllRunners(deps(), { accountId: f.accountId, userId: f.a1 }))).status).toBe(200);
    // Revoke-all takes every active runner of the account, the bystanders' included, and never a paused run.
    for (const id of [all.running, all.pending, all.other, one.other]) expect(await status(id), id).toBe("failed");
    expect(await status(all.paused)).toBe("paused");
  });
});
