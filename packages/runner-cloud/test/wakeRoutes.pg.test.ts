import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaimReply, HelloReply } from "@fulcrumaxe/runner-protocol";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { CLAIM_PATH, HELLO_PATH, claimRun, runnerHello, verifyWakeToken, type RunnerLeaseOps } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness } from "./helpers.js";

const KEY = randomBytes(32);
const HELLO = { protocol_version: 1, binary_version: "0.4.2", model_auth_present: false, isolation: "host_sandbox" };
const idleLeases = (asked: string[] = []): RunnerLeaseOps => ({ claimRunnerRun: async () => (asked.push("claim"), { kind: "idle" as const, retryAfter: 60 }) }) as unknown as RunnerLeaseOps;

/** D#6 RUNNER-WAKE R3a: the wake grant on the real hello and claim routes, with the real definers and the capability row. */
describe("wake grant on hello and claim [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  const hello = (key: ReturnType<typeof newKey>, body: unknown, wakeKey: Buffer | null = KEY) => respond(() => runnerHello(h.deps({ wakeKey: () => wakeKey }), signed(key, HELLO_PATH, body)));
  const claim = (key: ReturnType<typeof newKey>, o: { wakeKey?: Buffer | null; body?: unknown; leases?: RunnerLeaseOps } = {}) =>
    respond(() => claimRun(h.deps({ wakeKey: () => (o.wakeKey === undefined ? KEY : o.wakeKey), leases: o.leases ?? idleLeases() }), signed(key, CLAIM_PATH, o.body ?? {})));
  const capsRow = async (id: string) => ((await h.admin.query("SELECT capabilities FROM runner_capabilities WHERE runner_id = $1", [id])).rows[0]?.capabilities as string[] | undefined) ?? null;

  it("hello: a runner that lists wake_v1 gets a grant naming itself and its account; the capability is stored", async () => {
    const f = await fresh();
    const key = newKey();
    const id = await registerKey(h.admin, f.accountId, f.a1, key);
    const res = await hello(key, { ...HELLO, capabilities: ["proposal_verifier", "wake_v1"] });
    expect(res.status).toBe(200);
    const body = HelloReply.parse(res.body);
    expect(body.wake).toMatchObject({ poll_s: 20, transport: "poll" });
    expect(verifyWakeToken(KEY, body.wake!.token, new Date())).toMatchObject({ v: 1, rid: id, acct: f.accountId, jkt: key.jkt, jwk_x: key.jwk.x });
    expect(await capsRow(id)).toEqual(["proposal_verifier", "wake_v1"]);
  });

  it("hello: no capability, or no key configured, is the reply exactly as before", async () => {
    const f = await fresh();
    const key = newKey();
    await registerKey(h.admin, f.accountId, f.a1, key);
    for (const res of [await hello(key, HELLO), await hello(key, { ...HELLO, capabilities: ["proposal_verifier"] }), await hello(key, { ...HELLO, capabilities: ["wake_v1"] }, null)]) {
      expect(res.status).toBe(200);
      expect(Object.keys(res.body as object)).toEqual(["protocol_version"]);
    }
    // A reader that throws is the same as no key: the hello still succeeds.
    const thrown = await respond(() => runnerHello(h.deps({ wakeKey: () => { throw new Error("unreadable"); } }), signed(key, HELLO_PATH, { ...HELLO, capabilities: ["wake_v1"] })));
    expect(thrown.status).toBe(200);
    expect(Object.keys(thrown.body as object)).toEqual(["protocol_version"]);
  });

  it("hello: a revoked runner is 401 and gets no grant", async () => {
    const f = await fresh();
    const key = newKey();
    const id = await registerKey(h.admin, f.accountId, f.a1, key);
    await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [id]);
    const res = await hello(key, { ...HELLO, capabilities: ["wake_v1"] });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("wake");
  });

  it("claim: the grant follows the capability on the runner's latest hello, and only that runner's", async () => {
    const f = await fresh();
    const key = newKey();
    const id = await registerKey(h.admin, f.accountId, f.a1, key);
    const otherKey = newKey();
    await registerKey(h.admin, f.accountId, f.a1, otherKey);
    await hello(key, { ...HELLO, capabilities: ["wake_v1"] });
    await hello(otherKey, HELLO);

    const res = await claim(key);
    expect(res.status).toBe(200);
    const body = ClaimReply.parse(res.body);
    expect(body).toMatchObject({ retry_after: 60, wake: { poll_s: 20, transport: "poll" } });
    expect(verifyWakeToken(KEY, body.wake!.token, new Date())).toMatchObject({ rid: id, acct: f.accountId, jkt: key.jkt });

    const other = await claim(otherKey);
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ retry_after: 60 });

    // A later hello without the capability (a downgrade) stops the grant on the next claim.
    await hello(key, HELLO);
    await new Promise((r) => setTimeout(r, 4100));
    expect((await claim(key)).body).toEqual({ retry_after: 60 });
  });

  it("claim: no key configured is the reply exactly as before, and the capability row is not needed", async () => {
    const f = await fresh();
    const key = newKey();
    await registerKey(h.admin, f.accountId, f.a1, key);
    await hello(key, { ...HELLO, capabilities: ["wake_v1"] });
    const asked: string[] = [];
    const res = await claim(key, { wakeKey: null, leases: idleLeases(asked) });
    expect(res).toMatchObject({ status: 200, body: { retry_after: 60 } });
    expect(Object.keys(res.body as object)).toEqual(["retry_after"]);
    expect(asked).toEqual(["claim"]);
  });

  it("claim: a sandbox status poll and a person's pause carry the grant too; the 429 never does", async () => {
    const f = await fresh();
    const key = newKey();
    const id = await registerKey(h.admin, f.accountId, f.a1, key);
    await hello(key, { ...HELLO, capabilities: ["wake_v1"] });
    const poll = await claim(key, { body: { sandbox_unavailable: "bwrap_missing" } });
    expect(poll.status).toBe(200);
    expect(ClaimReply.parse(poll.body)).toHaveProperty("wake");
    const limited = await claim(key);
    expect(limited.status).toBe(429);
    expect(Object.keys(limited.body as object)).toEqual(["retry_after"]);

    await h.admin.query("INSERT INTO runner_settings (runner_id, account_id, paused_at) VALUES ($1, $2, now())", [id, f.accountId]);
    await new Promise((r) => setTimeout(r, 4100));
    const paused = await claim(key);
    expect(paused.status).toBe(200);
    expect(ClaimReply.parse(paused.body)).toMatchObject({ retry_after: 300, wake: { transport: "poll" } });
  });
});
