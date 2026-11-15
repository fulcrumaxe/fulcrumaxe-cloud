import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { CLAIM_PATH, claimRun, type RunnerLeaseOps } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#749 VERIFY-SIGNIN-EXPIRY: the claim route keeps the state of the runner's saved verify sign-in (`runners.verify_sign_in`, migration 1020) through the real SECURITY DEFINER function, as the
 * runner login the route uses, with row security forced. What it cannot fake: the runner's own dates (the runner side is in fx-runner's suite).
 */
describe("the claim route keeps the verify sign-in state [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const idle = { claimRunnerRun: async () => ({ kind: "idle" as const, retryAfter: 60 }) } as unknown as RunnerLeaseOps;
  const claim = (key: TestKey, body: unknown) => respond(() => claimRun(h.deps({ leases: idle }), signed(key, CLAIM_PATH, body)));
  const stored = async (id: string) => (await h.admin.query<{ s: string | null; at: Date | null }>("SELECT verify_sign_in AS s, verify_sign_in_at AS at FROM runners WHERE id = $1", [id])).rows[0]!;
  async function runnerAt(f: F2Fixture, protocol: number | null): Promise<{ id: string; key: TestKey }> {
    const key = newKey();
    const id = await registerKey(h.admin, f.accountId, f.m1, key);
    if (protocol !== null) await h.admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [id, protocol]);
    return { id, key };
  }

  it("stores each of the four words with a time for a runner of protocol 18, and the next claim moves it", async () => {
    const f = await seedF2(h.admin);
    const r = await runnerAt(f, 18);
    expect(await stored(r.id)).toEqual({ s: null, at: null });
    for (const state of ["ok", "expiring_soon", "expired", "missing"]) {
      await h.admin.query("UPDATE runner_claim_stamps SET last_claim_at = now() - interval '1 hour' WHERE runner_id = $1", [r.id]);
      expect(await claim(r.key, { verify_sign_in: state })).toMatchObject({ status: 200 });
      const row = await stored(r.id);
      expect(row.s).toBe(state);
      expect(row.at).toBeInstanceOf(Date);
    }
  });

  it("an old runner (protocol 17) that sends nothing keeps nothing and its claim goes on as before; one that sends the field anyway is not recorded", async () => {
    const f = await seedF2(h.admin);
    const old = await runnerAt(f, 17);
    expect(await claim(old.key, {})).toMatchObject({ status: 200, body: { retry_after: 60 } });
    expect(await stored(old.id)).toEqual({ s: null, at: null });
    await h.admin.query("UPDATE runner_claim_stamps SET last_claim_at = now() - interval '1 hour' WHERE runner_id = $1", [old.id]);
    expect(await claim(old.key, { verify_sign_in: "expired" })).toMatchObject({ status: 200 });
    expect(await stored(old.id)).toEqual({ s: null, at: null });
  });

  it("refuses a word that is not one of the four (and any other key) with nothing written; a status poll writes none either", async () => {
    const f = await seedF2(h.admin);
    const r = await runnerAt(f, 18);
    expect(await claim(r.key, { verify_sign_in: "fine" })).toMatchObject({ status: 400 });
    expect(await claim(r.key, { verify_sign_in: "ok", extra: 1 })).toMatchObject({ status: 400 });
    await h.admin.query("UPDATE runner_claim_stamps SET last_claim_at = now() - interval '1 hour' WHERE runner_id = $1", [r.id]);
    expect(await claim(r.key, { sandbox_unavailable: "bwrap_missing", verify_sign_in: "ok" })).toMatchObject({ status: 200 });
    expect(await stored(r.id)).toEqual({ s: null, at: null });
  });

  it("a runner can only write its own row, and the database refuses the closed list's complement and a direct write by the application login", async () => {
    const f = await seedF2(h.admin);
    const mine = await runnerAt(f, 18);
    const other = await runnerAt(f, 18);
    await claim(mine.key, { verify_sign_in: "expired" });
    expect((await stored(mine.id)).s).toBe("expired");
    expect((await stored(other.id)).s).toBeNull();
    await expect(h.admin.query("UPDATE runners SET verify_sign_in = 'fine' WHERE id = $1", [mine.id])).rejects.toMatchObject({ code: "23514" });
    await expect(h.admin.query("UPDATE runners SET verify_sign_in = NULL WHERE id = $1", [mine.id])).rejects.toMatchObject({ code: "23514" });
    await expect(h.appPool.query("UPDATE runners SET verify_sign_in = 'ok', verify_sign_in_at = now() WHERE id = $1", [mine.id])).rejects.toMatchObject({ code: "42501" });
  });
});
