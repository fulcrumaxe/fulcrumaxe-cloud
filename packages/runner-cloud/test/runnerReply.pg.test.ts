import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { markRunnerWork, setPendingHooks, type PendingStore } from "@fx/core/src/pendingWork.js";
import { checkRunner, listRunners } from "../src/index.js";
import { harness, respond, type Harness } from "./helpers.js";

/**
 * [pg] D#6 RUNNER-PING: "Check runner now" and the automatic "Not responding", on real Postgres with the real read model. The no-database store is a
 * map that keeps TTLs and answers null for a miss, as Runtime Cache does; the clock is fake, and "the runner claimed" is its `last_seen_at` moving,
 * which is what the claim's throttle definer writes.
 */
const T0 = new Date("2026-10-23T12:00:00.000Z").getTime();
const at = (s: number): Date => new Date(T0 + s * 1000);

function ttlStore(clock: { now: number }): PendingStore {
  const values = new Map<string, { value: number; until: number }>();
  return {
    get: async (key) => {
      const hit = values.get(key);
      return hit && hit.until > clock.now ? hit.value : null;
    },
    set: async (key, value, ttlSeconds) => {
      if (!Number.isFinite(value) || !(ttlSeconds > 0)) throw new Error("the cache refuses this entry");
      values.set(key, { value, until: clock.now + ttlSeconds * 1000 });
    },
    delete: async (key) => void values.delete(key),
  };
}

describe("runner reply: check now and ignored work [pg]", () => {
  let h: Harness;
  const clock = { now: T0 };
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());
  afterEach(() => setPendingHooks(null));

  const wakeKey = () => Buffer.alloc(32, 7);
  const deps = () => h.deps({ now: () => new Date(clock.now), wakeKey });
  const fresh = async (): Promise<F2Fixture> => {
    clock.now = T0;
    setPendingHooks({ store: ttlStore(clock) });
    return seedF2(h.admin);
  };
  async function runner(f: F2Fixture, o: { seen: Date; wake?: boolean }): Promise<string> {
    const id = await insertRunner(h.admin, f.accountId, f.a1);
    await h.admin.query("UPDATE runners SET last_seen_at = $2, protocol_version = 3 WHERE id = $1", [id, o.seen]);
    if (o.wake !== false) await h.admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, ARRAY['wake_v1'])", [id, f.accountId]);
    return id;
  }
  const claims = (id: string, when: Date) => h.admin.query("UPDATE runners SET last_seen_at = $2 WHERE id = $1", [id, when]);
  const check = (f: F2Fixture, user: string, id: string, body: unknown = {}) => respond(() => checkRunner(deps(), { accountId: f.accountId, userId: user }, id, body));
  async function read(f: F2Fixture, s: number) {
    clock.now = at(s).getTime();
    const res = await respond(() => listRunners(deps(), { accountId: f.accountId, userId: f.o1 }));
    type Row = { id: string; state: string; state_note: string | null; check: { status: string; sent_at: string } | null; controls: { check: { allowed: boolean; reason: string | null } } | null };
    return new Map((res.body as { runners: Row[] }).runners.map((r) => [r.id, r]));
  }

  it("check now: a live wake runner reads Checking, then Online · just now once it claims", async () => {
    const f = await fresh();
    const live = await runner(f, { seen: at(-600) });
    const sent = await check(f, f.o1, live);
    expect(sent).toMatchObject({ status: 200, body: { runner_id: live, sent_at: at(0).toISOString() } });
    expect((await read(f, 10)).get(live)).toMatchObject({ state: "online_idle", check: { status: "checking", sent_at: at(0).toISOString() } });
    await claims(live, at(18)); // its next wake check saw the bump
    expect((await read(f, 20)).get(live)).toMatchObject({ state: "online_idle", state_note: "just now", check: { status: "answered" } });
    // Later it is just Online.
    expect((await read(f, 200)).get(live)).toMatchObject({ state: "online_idle", check: { status: "answered" } });
    expect((await read(f, 200)).get(live)!.state_note).not.toBe("just now");
  });

  it("check now: a dead wake runner reads Not responding at 60 s, stays so past its 35-minute window, and clears when next heard from", async () => {
    const f = await fresh();
    const dead = await runner(f, { seen: at(-60) });
    expect((await check(f, f.a1, dead)).status).toBe(200);
    expect((await read(f, 59)).get(dead)).toMatchObject({ state: "online_idle", check: { status: "checking" } });
    expect((await read(f, 60)).get(dead)).toMatchObject({ state: "not_responding", state_note: "no reply in 60 s", check: { status: "no_reply" } });
    expect((await read(f, 3000)).get(dead)).toMatchObject({ state: "not_responding", state_note: "no reply in 60 s" });
    await claims(dead, at(3001));
    expect((await read(f, 3005)).get(dead)).toMatchObject({ state: "online_idle", check: { status: "answered" } });
  });

  it("check now: owners and admins only, a live runner of this account only, a session body only, and a store that takes it", async () => {
    const f = await fresh();
    const g = await seedF2(h.admin);
    const id = await runner(f, { seen: at(-5) });
    const theirs = await insertRunner(h.admin, g.accountId, g.a1);
    expect(await check(f, f.m1, id)).toMatchObject({ status: 403 });
    expect((await check(f, f.o1, theirs)).status).toBe(404);
    expect((await check(f, f.o1, randomUUID())).status).toBe(404);
    expect((await check(f, f.o1, "not-a-uuid")).status).toBe(404);
    expect((await check(f, f.o1, id, { now: true })).status).toBe(400);
    await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [theirs]);
    const gone = await runner(f, { seen: at(-5) });
    await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [gone]);
    expect(await check(f, f.o1, gone)).toMatchObject({ status: 409, body: { error: { code: "runner_revoked" } } });
    setPendingHooks(null);
    expect(await check(f, f.o1, id)).toMatchObject({ status: 503, body: { error: { code: "check_unavailable" } } });
    // The member is told why the button is off; an admin may press it on a wake runner.
    setPendingHooks({ store: ttlStore(clock) });
    const asMember = await respond(() => listRunners(deps(), { accountId: f.accountId, userId: f.m1 }));
    const mine = (asMember.body as { runners: Array<{ id: string; controls: { check: { allowed: boolean; reason: string | null } } }> }).runners.find((r) => r.id === id)!;
    expect(mine.controls.check).toEqual({ allowed: false, reason: "Only an owner or admin can check a runner." });
    expect((await read(f, 0)).get(id)!.controls!.check).toEqual({ allowed: true, reason: null });
  });

  it("a repeat click within 60 s is the same check: same sent_at, no new record and no wake; at 60 s a new one goes out", async () => {
    const f = await fresh();
    const id = await runner(f, { seen: at(-600) });
    const store = ttlStore(clock);
    const writes: string[] = [];
    setPendingHooks({ store: { ...store, set: async (k, v, ttl) => (writes.push(k), store.set(k, v, ttl)) } });
    expect((await check(f, f.o1, id)).body).toMatchObject({ sent_at: at(0).toISOString() });
    await new Promise((r) => setTimeout(r, 0)); // the wake write is fire and forget
    const first = writes.length;
    expect(first).toBeGreaterThan(1); // the record and the epoch
    for (const s of [1, 30, 59]) {
      clock.now = at(s).getTime();
      expect(await check(f, f.o1, id)).toMatchObject({ status: 200, body: { runner_id: id, sent_at: at(0).toISOString() } });
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(writes).toHaveLength(first);
    clock.now = at(60).getTime();
    expect((await check(f, f.o1, id)).body).toMatchObject({ sent_at: at(60).toISOString() });
    await new Promise((r) => setTimeout(r, 0));
    expect(writes.length).toBeGreaterThan(first);
  });

  it("an older runner (no wake_v1) is unaffected: no check status, no Not responding, and the button says why it is not needed", async () => {
    const f = await fresh();
    const old = await runner(f, { seen: at(-5), wake: false });
    expect((await check(f, f.o1, old)).status).toBe(200);
    await markRunnerWork(f.accountId, { now: at(0).getTime() });
    const row = (await read(f, 100)).get(old)!;
    expect(row).toMatchObject({ state: "online_idle", check: null });
    expect(row.controls!.check).toEqual({ allowed: false, reason: "This runner checks in every minute on its own." });
    expect((await read(f, 130)).get(old)).toMatchObject({ state: "offline", check: null });
  });

  it("idle: with no work marked, a quiet wake runner is never Not responding inside its window", async () => {
    const f = await fresh();
    const quiet = await runner(f, { seen: at(-1700) });
    for (const s of [0, 90, 300]) expect((await read(f, s)).get(quiet)).toMatchObject({ state: "online_idle" });
  });

  it("work marked: a dead wake runner flips at 90 s, a live one claims and stays online, a busy one heartbeating is heard", async () => {
    const f = await fresh();
    const dead = await runner(f, { seen: at(-600) });
    const live = await runner(f, { seen: at(-600) });
    const busy = await runner(f, { seen: at(-600) });
    // A busy runner holds a run whose lease its heartbeats keep moving (each to 90 s after the request); it makes no claim meanwhile.
    await h.admin.query(
      "INSERT INTO agent_runs (id, account_id, role, runtime, status, runner_id, lease_expires_at) VALUES ($1, $2, 'executor', 'runner', 'running', $3, $4)",
      [randomUUID(), f.accountId, busy, at(80 + 90)],
    );
    await markRunnerWork(f.accountId, { now: at(0).getTime() });
    await claims(live, at(20));
    const before = await read(f, 89);
    expect(before.get(dead)).toMatchObject({ state: "online_idle" });
    const after = await read(f, 90);
    expect(after.get(dead)).toMatchObject({ state: "not_responding", state_note: "didn't pick up new work within 90 s", check: null });
    expect(after.get(live)).toMatchObject({ state: "online_idle" });
    expect(after.get(busy)).toMatchObject({ state: "busy" });
    // Heard from again (its safety claim): back to online.
    await claims(dead, at(400));
    expect((await read(f, 401)).get(dead)).toMatchObject({ state: "online_idle" });
  });

  it("work marked every 30 s cannot hide a dead runner: the first bump of the run counts", async () => {
    const f = await fresh();
    const dead = await runner(f, { seen: at(-600) });
    const live = await runner(f, { seen: at(-600) });
    for (const s of [0, 30, 60, 90]) {
      await markRunnerWork(f.accountId, { now: at(s).getTime() });
      await claims(live, at(s + 15));
    }
    const rows = await read(f, 106);
    expect(rows.get(dead)).toMatchObject({ state: "not_responding" });
    expect(rows.get(live)).toMatchObject({ state: "online_idle" });
  });
});
