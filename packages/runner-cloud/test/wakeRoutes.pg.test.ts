import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ClaimReply, HelloReply } from "@fulcrumaxe/runner-protocol";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { BACKSTOP_MS, setPendingHooks, type PendingStore } from "@fx/core/src/pendingWork.js";
import { removeMember } from "@fx/core/src/tenancy/membership.js";
import { WAKE_PATH } from "@fulcrumaxe/runner-protocol";
import {
  CLAIM_PATH,
  HELLO_PATH,
  ROTATE_PATH,
  REVOKE_PATH,
  claimRun,
  removeRunner,
  revokeAllRunners,
  revokeRunner,
  rotateRunnerKey,
  runnerHello,
  runnerWake,
  selfRevokeRunner,
  verifyWakeToken,
  wakeSafetyRetryAfterSeconds,
  type RunnerLeaseOps,
} from "../src/index.js";
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
    // D#6 RUNNER-WAKE R3b: holding a grant, "nothing queued" is the slot-aligned safety claim, not 60 s.
    expect(body).toMatchObject({ wake: { poll_s: 20, transport: "poll" } });
    const retryAfter = (body as { retry_after: number }).retry_after;
    expect(retryAfter).toBeGreaterThan(0);
    expect(Math.abs(retryAfter - wakeSafetyRetryAfterSeconds(id, new Date()))).toBeLessThanOrEqual(1);
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

/** D#6 RUNNER-WAKE R3b: the safety claim, and every revoke path refusing the wake check on its next call, through the real definers. */
describe("wake check against the real revoke paths [pg]", () => {
  let h: Harness;
  let store: Map<string, unknown>;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());
  beforeEach(() => {
    store = new Map();
    const pending: PendingStore = { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v), delete: async (k) => void store.delete(k) };
    setPendingHooks({ store: pending });
  });
  afterEach(() => setPendingHooks(null));

  const failAll = async () => ({ runIds: [], complete: true });
  const deps = () => h.deps({ wakeKey: () => KEY, failRunnerLeases: failAll });
  /** Hello with wake_v1, returning the minted token. */
  const tokenFor = async (key: ReturnType<typeof newKey>): Promise<string> => {
    const res = await respond(() => runnerHello(deps(), signed(key, HELLO_PATH, { ...HELLO, capabilities: ["wake_v1"] })));
    return HelloReply.parse(res.body).wake!.token;
  };
  const wake = (key: ReturnType<typeof newKey>, token: string) => {
    const req = signed(key, WAKE_PATH, undefined, { method: "GET", rawBody: Buffer.alloc(0) });
    return runnerWake({ origin: h.deps().origin, wakeKey: () => KEY }, { ...req, headers: { ...req.headers, authorization: `Bearer ${token}`, accept: "application/json" } });
  };
  const setup = async () => {
    const f = await seedF2(h.admin);
    const key = newKey();
    const id = await registerKey(h.admin, f.accountId, f.m1, key);
    const token = await tokenFor(key);
    expect((await wake(key, token)).status).toBe(200);
    return { f, key, id, token };
  };

  it("claim: a grant holder's idle answer is aligned to the slot; queued-but-blocked keeps its short answer; no grant keeps 60", async () => {
    const { f, key, id } = await setup();
    const now = new Date();
    const idle = await respond(() => claimRun(h.deps({ wakeKey: () => KEY, leases: idleLeases(), now: () => now }), signed(key, CLAIM_PATH, {})));
    const body = ClaimReply.parse(idle.body) as { retry_after: number };
    expect(body.retry_after).toBe(wakeSafetyRetryAfterSeconds(id, now));
    expect(idle.headers?.["retry-after"]).toBe(String(body.retry_after));
    const boundary = (Math.floor(now.getTime() / BACKSTOP_MS) + 1) * BACKSTOP_MS;
    expect(now.getTime() + body.retry_after * 1000).toBeGreaterThanOrEqual(boundary);
    expect(body.retry_after).toBeLessThanOrEqual(2100);

    await new Promise((r) => setTimeout(r, 4100));
    const blocked = { claimRunnerRun: async () => ({ kind: "idle" as const, retryAfter: 10 }) } as unknown as RunnerLeaseOps;
    expect((await respond(() => claimRun(h.deps({ wakeKey: () => KEY, leases: blocked }), signed(key, CLAIM_PATH, {})))).body).toMatchObject({ retry_after: 10 });

    const plain = newKey();
    await registerKey(h.admin, f.accountId, f.m1, plain);
    await respond(() => runnerHello(deps(), signed(plain, HELLO_PATH, HELLO)));
    expect((await respond(() => claimRun(h.deps({ wakeKey: () => KEY, leases: idleLeases() }), signed(plain, CLAIM_PATH, {})))).body).toEqual({ retry_after: 60 });
  });

  it("fail closed: with the allow record gone the wake check is 503; the runner's next granted claim writes it again", async () => {
    const { key, token } = await setup();
    store.clear();
    expect((await wake(key, token)).status).toBe(503);
    expect((await respond(() => claimRun(h.deps({ wakeKey: () => KEY, leases: idleLeases() }), signed(key, CLAIM_PATH, {})))).status).toBe(200);
    expect((await wake(key, token)).status).toBe(200);
  });

  it("a member's revoke: refused (503, fail closed) on the next wake call", async () => {
    const { f, key, id, token } = await setup();
    expect((await respond(() => revokeRunner(deps(), { accountId: f.accountId, userId: f.o1 }, id))).status).toBe(200);
    expect((await wake(key, token)).status).toBe(503);
  });

  it("the runner's own revoke: refused (503, fail closed) on the next wake call", async () => {
    const { key, token } = await setup();
    expect((await respond(() => selfRevokeRunner(deps(), signed(key, REVOKE_PATH, {})))).status).toBe(200);
    expect((await wake(key, token)).status).toBe(503);
  });

  it("remove: refused (503, fail closed) on the next wake call", async () => {
    const { f, key, id, token } = await setup();
    expect((await respond(() => removeRunner(deps(), { accountId: f.accountId, userId: f.o1 }, id))).status).toBe(200);
    expect((await wake(key, token)).status).toBe(503);
  });

  it("rotate: the old key's token is refused; a token for the new key works", async () => {
    const { key, token } = await setup();
    const next = newKey();
    expect((await respond(() => rotateRunnerKey(deps(), signed(key, ROTATE_PATH, { public_key_jwk: next.jwk })))).status).toBe(200);
    expect((await wake(key, token)).status).toBe(503);
    expect((await wake(next, await tokenFor(next))).status).toBe(200);
  });

  it("revoke-all: every runner's token is refused, and a runner registered afterwards can still use the check", async () => {
    const { f, key, token } = await setup();
    const second = newKey();
    await registerKey(h.admin, f.accountId, f.a1, second);
    const secondToken = await tokenFor(second);
    expect((await respond(() => revokeAllRunners(deps(), { accountId: f.accountId, userId: f.o1 }))).status).toBe(200);
    expect((await wake(key, token)).status).toBe(503);
    expect((await wake(second, secondToken)).status).toBe(503);
    const later = newKey();
    await registerKey(h.admin, f.accountId, f.a1, later);
    expect((await wake(later, await tokenFor(later))).status).toBe(200);
  });

  it("the registrant leaves the account (membership trigger): refused (503, fail closed) on the next wake call", async () => {
    const { f, key, token } = await setup();
    await removeMember(h.appPool, f.accountId, f.o1, f.m1, { failRunnerLeases: async () => ({ complete: true }) });
    expect((await wake(key, token)).status).toBe(503);
  });
});
