import { describe, expect, it } from "vitest";
import { EngineLease, ENGINE_LEASE_HELLO_CAPABILITY, HeartbeatReply, type HelloMessage } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import { createInventoryReporter } from "../../src/daemon/sandboxInventory.js";
import { createEngineLeaseGuard, createEngineSessionHandlers, createSessionLock, LEASE_CHECK_MS, LEASE_GRACE_MS, lockSessionHandlers, sessionStopperOf } from "../../src/engineSession/lifecycle.js";
import { generateRunnerKey } from "../../src/keys.js";
import { RUNNER_PROTOCOL_VERSION, RUNNER_VERSION } from "../../src/version.js";
import { NAME, SESSION_REPO, sessionRig, start } from "./sessionRig.js";

const T0 = Date.parse("2026-11-24T12:00:00.000Z");
const LEASE_MS = 15 * 60_000;
const HELLO: HelloMessage = { protocol_version: RUNNER_PROTOCOL_VERSION, binary_version: RUNNER_VERSION, model_auth_present: false, isolation: "host_sandbox", capabilities: [ENGINE_LEASE_HELLO_CAPABILITY] };
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The fake clock the whole fake runner reads: the client signs with it, the reporter and the guard judge by it. */
function fakeClock() {
  const clock = { at: T0 };
  return { clock, now: () => new Date(clock.at), advance: (ms: number) => void (clock.at += ms) };
}

/**
 * A cloud at one of two ages. `old` (before ON-13c3): a strict hello, so the one that names `engine_lease_v1` is 400 invalid_message, and no reply ever carries a lease.
 * `new`: lists `engine_lease` on a hello that declared the capability (unless `echo` is off), and, as the real cloud does, renews the 15 minute lease ONLY when the request carries a `running` `fx-engine-<gh>` row;
 * it answers the lease it holds while that has not ended, with `retry_after` 300. `offline` and `drop` fail the request in the network; `limit` answers 429.
 */
function cloud(kind: "old" | "new", now: () => Date) {
  const state = { offline: false, echo: true, drop: 0, limit: 0, leaseUntil: 0 };
  const seen = { claims: 0, withInventory: 0, heartbeats: 0, heartbeatsWithInventory: 0 };
  const hellos: string[][] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    if (state.offline) throw new TypeError("network down");
    const body = JSON.parse(String(init.body)) as { capabilities?: string[]; sandboxes?: Array<{ name: string; state: string }> };
    if (url.endsWith("/api/runner/hello")) {
      const caps = body.capabilities ?? [];
      hellos.push(caps);
      if (kind === "old" && caps.includes(ENGINE_LEASE_HELLO_CAPABILITY)) return json(400, { error: { code: "invalid_message", message: "x" } });
      return json(200, { protocol_version: 1, ...(kind === "new" && state.echo && caps.includes(ENGINE_LEASE_HELLO_CAPABILITY) ? { capabilities: ["engine_lease"] } : {}) });
    }
    if (state.drop > 0) {
      state.drop -= 1;
      throw new TypeError("dropped");
    }
    const claim = url.endsWith("/api/runner/claim");
    if (claim && state.limit > 0) {
      state.limit -= 1;
      return json(429, { retry_after: 60 });
    }
    if (claim) seen.claims += 1;
    else seen.heartbeats += 1;
    if (body.sandboxes !== undefined) {
      if (claim) seen.withInventory += 1;
      else seen.heartbeatsWithInventory += 1;
    }
    if (kind === "new" && (body.sandboxes ?? []).some((s) => s.name === NAME && s.state === "running")) state.leaseUntil = now().getTime() + LEASE_MS;
    const lease = kind === "new" && state.leaseUntil > now().getTime() ? { engine_lease: { repo_gh_id: SESSION_REPO, operate_epoch: 1, until: new Date(state.leaseUntil).toISOString() } } : {};
    if (!claim) return json(200, { continue: true, lease_expires_at: "2026-11-24T12:01:30.000Z", ...(body.sandboxes === undefined ? {} : { sandboxes_recorded: true }), ...lease });
    return json(200, { retry_after: kind === "new" ? 300 : 60, ...lease });
  }) as unknown as typeof fetch;
  return { fetchFn, state, hellos, seen };
}

/**
 * A runner's pieces over the real session handlers (directory-backed guests): the client with the REAL inventory reporter (its source is the rig's sandbox list), the guard bound to the real stop path, and a session that is up.
 * `every: false` is the cadence the runner had before the lease: the block only on a change or after the quiet window.
 */
async function runner(kind: "old" | "new", o: { every?: boolean } = {}) {
  const rig = sessionRig();
  const time = fakeClock();
  const lines: string[] = [];
  const c = cloud(kind, time.now);
  const guard = createEngineLeaseGuard({ now: time.now, log: (line) => lines.push(line) });
  const reporter = createInventoryReporter({ source: { list: async () => rig.inventory() }, now: time.now, ...(o.every === false ? {} : { every: () => guard.holding() }) });
  const client = createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: time.now, fetchFn: c.fetchFn, engineLease: guard, sandboxInventory: reporter, heartbeatInventory: () => true });
  guard.bind(sessionStopperOf(createEngineSessionHandlers(rig.makeDeps()).engine_session_stop));
  await rig.run(start(rig.repo.commit, false));
  expect(rig.machines.get(NAME)?.state).toBe("running");
  const stops = () => rig.log.filter((l) => l === `stop ${NAME}`).length;
  /** Time passes in the guard's own steps, as it looks every 30 seconds. */
  const pass = async (ms: number) => {
    for (let left = ms; left > 0; left -= LEASE_CHECK_MS) {
      time.advance(Math.min(LEASE_CHECK_MS, left));
      await guard.check();
    }
  };
  /** What the daemon does with every answered hello: the guard hears whether it echoed. */
  const hello = async () => {
    const answer = await client.hello(HELLO);
    if (answer.kind === "ok") guard.echoed(answer.engineLease === true);
    return answer;
  };
  return { rig, ...time, cloud: c, guard, client, hello, lines, stops, pass };
}

describe("the engine session lease: the runner's side (ON-13c3)", () => {
  it("the hello that lists engine_lease_v1 is accepted by a new cloud and says it was echoed, and a reply that carries a lease parses on the claim and the heartbeat", async () => {
    const r = await runner("new");
    expect(await r.hello()).toEqual({ kind: "ok", engineLease: true });
    expect(await r.client.claim()).toMatchObject({ kind: "idle", retryAfter: 300 });
    expect(await r.client.heartbeat(RUN_ID, 1)).toMatchObject({ kind: "ok" });
    expect(EngineLease.safeParse({ repo_gh_id: SESSION_REPO, operate_epoch: 1, until: "2026-11-24T12:15:00.000Z" }).success).toBe(true);
    expect(HeartbeatReply.safeParse({ continue: true, lease_expires_at: "2026-11-24T12:01:30.000Z", engine_lease: { repo_gh_id: 1, operate_epoch: 1, until: "x" } }).success).toBe(false);
    expect(HeartbeatReply.safeParse({ continue: true, lease_expires_at: "2026-11-24T12:01:30.000Z", engine_lease: { repo_gh_id: 1, operate_epoch: 1, until: "2026-11-24T12:15:00.000Z", extra: 1 } }).success).toBe(false);
  });

  it("a hello the cloud answered without the echo says so: no engineLease on the result, even for a runner that declared the capability", async () => {
    const r = await runner("new");
    r.cloud.state.echo = false;
    expect(await r.hello()).toEqual({ kind: "ok" });
  });

  it("offline, then reconnect inside the grace: the session is never stopped, and the renewed lease moves the deadline", async () => {
    const r = await runner("new");
    await r.hello();
    await r.client.claim(); // the block lists the running session: lease until T0 + 15 min
    r.cloud.state.offline = true;
    r.advance(LEASE_MS + LEASE_GRACE_MS); // exactly at the end of the grace: not past it
    await r.guard.check();
    expect(r.rig.machines.get(NAME)?.state).toBe("running");
    r.cloud.state.offline = false;
    expect(await r.client.claim()).toMatchObject({ kind: "idle" }); // the cloud renews: until now + 15 min
    r.advance(LEASE_MS); // past the first lease's grace, inside the second
    await r.guard.check();
    expect(r.rig.machines.get(NAME)?.state).toBe("running");
    expect(r.stops()).toBe(0);
    expect(r.lines).toEqual([]);
  });

  it("offline past the lease and a minute: the runner stops its own session through the real stop path (quiesce, snapshot), logs lease_expired, and stops it once", async () => {
    const r = await runner("new");
    await r.hello();
    await r.client.claim();
    r.cloud.state.offline = true;
    r.advance(LEASE_MS + LEASE_GRACE_MS + 1);
    await r.guard.check();
    expect(r.rig.machines.get(NAME)?.state).toBe("stopped");
    expect(r.rig.snapshots.get(NAME)).toBe(1);
    expect(r.rig.log).toContain(`quiesce ${NAME}`);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("lease_expired");
    expect(r.lines[0]).toContain(String(SESSION_REPO));
    // the next look finds nothing to do, and the reconnect that still echoes the old end does not arm it again
    await r.guard.check();
    r.cloud.state.offline = false;
    r.guard.receive({ repo_gh_id: SESSION_REPO, operate_epoch: 1, until: new Date(T0 + LEASE_MS).toISOString() });
    r.advance(LEASE_MS);
    await r.guard.check();
    expect(r.stops()).toBe(1);
    expect(r.lines).toHaveLength(1);
  });

  it("an old cloud means no self-stop: the hello is retried without the capability, no reply carries a lease, and no clock ever stops the session", async () => {
    const r = await runner("old");
    expect(await r.hello()).toEqual({ kind: "ok", dropped: [ENGINE_LEASE_HELLO_CAPABILITY] });
    expect(r.cloud.hellos).toEqual([[ENGINE_LEASE_HELLO_CAPABILITY], []]);
    expect(await r.client.claim()).toMatchObject({ kind: "idle", retryAfter: 60 });
    await r.client.heartbeat(RUN_ID, 1);
    r.cloud.state.offline = true;
    r.advance(30 * 24 * 3_600_000);
    await r.guard.check();
    expect(r.rig.machines.get(NAME)?.state).toBe("running");
    expect(r.stops()).toBe(0);
    expect(r.lines).toEqual([]);
  });

  it("a runner with no stop path stops nothing, and a lease that cannot be read is ignored", async () => {
    const time = fakeClock();
    const guard = createEngineLeaseGuard({ now: time.now, log: () => undefined });
    guard.echoed(true);
    guard.receive({ repo_gh_id: 5, operate_epoch: 1, until: new Date(T0).toISOString() });
    guard.receive({ repo_gh_id: 6, operate_epoch: 1, until: "not a time" });
    time.advance(24 * 3_600_000);
    await guard.check(); // nothing bound: no throw, nothing to stop with
    const stopped: number[] = [];
    guard.bind(async (repo) => (stopped.push(repo), true));
    await guard.check();
    expect(stopped).toEqual([5]);
  });

  it("a stop that did not end well is tried again on the next look, and one that threw does not lose the lease", async () => {
    const r = await runner("new");
    await r.hello();
    await r.client.claim();
    r.cloud.state.offline = true;
    r.advance(LEASE_MS + LEASE_GRACE_MS + 1);
    r.rig.fail.stop = true;
    await r.guard.check();
    expect(r.rig.machines.get(NAME)?.state).toBe("running");
    expect(r.lines).toHaveLength(1);
    r.rig.fail.stop = false;
    r.advance(LEASE_CHECK_MS);
    await r.guard.check();
    expect(r.rig.machines.get(NAME)?.state).toBe("stopped");
    expect(r.lines).toHaveLength(2);
  });

  it("the look repeats on its own clock: every 30 seconds until it is told to end, and a stop in the middle of a look is not started twice", async () => {
    const r = await runner("new");
    await r.hello();
    await r.client.claim();
    r.cloud.state.offline = true;
    const ended = new AbortController();
    const slept: number[] = [];
    const clock = {
      now: r.now,
      sleep: async (ms: number, signal: AbortSignal) => {
        slept.push(ms);
        r.advance(ms);
        if (slept.length >= 40) ended.abort();
        void signal;
      },
    };
    await r.guard.run(clock, ended.signal);
    expect(new Set(slept)).toEqual(new Set([LEASE_CHECK_MS]));
    expect(r.rig.machines.get(NAME)?.state).toBe("stopped");
    expect(r.stops()).toBe(1);
    const both = await Promise.all([r.guard.check(), r.guard.check()]);
    expect(both).toEqual([undefined, undefined]);
    expect(r.stops()).toBe(1);
  });

  describe("the renewal cadence: a healthy session is never stopped by a late or lost renewal", () => {
    /** 290 s between claims (a claim never lands exactly on the 300 s the cloud asked for), a heartbeat now and then, one claim lost in the network and one answered 429. */
    async function hours(r: Awaited<ReturnType<typeof runner>>, minutes: number, faults: { drop: number; limit: number }) {
      await r.hello();
      let at = 0;
      for (let step = 0; at < minutes * 60_000; step++) {
        if (step === faults.drop) r.cloud.state.drop = 1;
        if (step === faults.limit) r.cloud.state.limit = 1;
        await r.pass(290_000);
        at += 290_000;
        await r.client.claim();
        if (step % 4 === 3) await r.client.heartbeat(RUN_ID, 1);
      }
    }

    it("over 3 hours with a dropped claim and a 429, the real reporter sends the block on every claim and heartbeat, and the session is never stopped", async () => {
      const r = await runner("new");
      await hours(r, 180, { drop: 3, limit: 9 });
      expect(r.rig.machines.get(NAME)?.state).toBe("running");
      expect(r.stops()).toBe(0);
      expect(r.lines).toEqual([]);
      // every request the cloud answered after the first lease carried the block: nothing waited on the 600 s quiet window
      expect(r.cloud.seen.withInventory).toBe(r.cloud.seen.claims);
      expect(r.cloud.seen.heartbeatsWithInventory).toBe(r.cloud.seen.heartbeats);
      expect(r.cloud.seen.claims).toBeGreaterThan(35);
    });

    it("the cadence the runner had before (the block on a change or after 600 s) lets the same 3 hours stop a healthy session, which is the defect this guards", async () => {
      const r = await runner("new", { every: false });
      await hours(r, 180, { drop: 3, limit: 9 });
      expect(r.stops()).toBeGreaterThan(0);
      expect(r.lines.some((line) => line.includes("lease_expired"))).toBe(true);
    });

    it("the fake cloud renews only from a running fx-engine row: a session reported stopped, or not at all, is not renewed and its lease runs out", async () => {
      const r = await runner("new");
      await r.hello();
      await r.client.claim();
      expect(r.cloud.state.leaseUntil).toBe(T0 + LEASE_MS);
      r.rig.machines.get(NAME)!.state = "stopped";
      r.advance(60_000);
      await r.client.claim();
      expect(r.cloud.state.leaseUntil).toBe(T0 + LEASE_MS);
    });
  });

  describe("Ruling 15: the lease is acted on only while the latest answered hello echoed it", () => {
    it("a lease received before any hello echoed is ignored, so a runner that never heard the echo never stops a session", async () => {
      const r = await runner("new");
      await r.client.claim(); // no hello: the reply carries a lease, and nobody has said the cloud speaks it
      expect(r.guard.holding()).toBe(false);
      r.cloud.state.offline = true;
      await r.pass(3 * LEASE_MS);
      expect(r.rig.machines.get(NAME)?.state).toBe("running");
      expect(r.stops()).toBe(0);
    });

    it("a cloud that echoed, then answers a re-hello without the echo: the lease held is withdrawn, and no self-stop follows past its old end", async () => {
      const r = await runner("new");
      expect(await r.hello()).toEqual({ kind: "ok", engineLease: true });
      await r.client.claim();
      expect(r.guard.holding()).toBe(true);
      r.cloud.state.echo = false;
      const again = await r.hello();
      expect(again).toEqual({ kind: "ok" });
      expect(r.guard.holding()).toBe(false);
      await r.client.claim(); // the cloud still sends the lease: it is not taken
      expect(r.guard.holding()).toBe(false);
      r.cloud.state.offline = true;
      await r.pass(LEASE_MS + 5 * LEASE_GRACE_MS);
      expect(r.rig.machines.get(NAME)?.state).toBe("running");
      expect(r.stops()).toBe(0);
      expect(r.lines).toEqual([]);
    });

    it("an unanswered hello changes nothing (the latest ANSWERED one decides), and a later echo takes leases again", async () => {
      const r = await runner("new");
      const guard = r.guard;
      guard.echoed(true);
      await r.client.claim();
      expect(guard.holding()).toBe(true);
      r.cloud.state.offline = true;
      const lost = await r.hello().catch(() => ({ kind: "error" as const }));
      expect(lost.kind).not.toBe("ok"); // the daemon calls `echoed` only for an answer
      expect(guard.holding()).toBe(true);
      r.cloud.state.offline = false;
      guard.echoed(false);
      expect(guard.holding()).toBe(false);
      guard.echoed(true);
      await r.client.claim();
      expect(guard.holding()).toBe(true);
    });
  });

  describe("one lock per session name: the runner's own stop never overlaps a cloud stop, start or delete", () => {
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      return { opened, open };
    };

    it("work for one name runs one at a time in the order it was asked, work for two names does not wait, and a failure does not jam the name", async () => {
      const lock = createSessionLock();
      const order: string[] = [];
      const g = gate();
      const first = lock(1, async () => (order.push("a:start"), await g.opened, order.push("a:end")));
      const second = lock(1, async () => void order.push("b"));
      const other = lock(2, async () => void order.push("c"));
      await other;
      expect(order).toEqual(["a:start", "c"]);
      g.open();
      await Promise.all([first, second]);
      expect(order).toEqual(["a:start", "c", "a:end", "b"]);
      await expect(lock(1, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
      await expect(lock(1, async () => "next")).resolves.toBe("next");
    });

    it("the self-stop waits for a cloud job on the same session, and the cloud's jobs wait for the self-stop: through the real handlers, stop and start never interleave", async () => {
      const rig = sessionRig();
      const lock = createSessionLock();
      const raw = createEngineSessionHandlers(rig.makeDeps());
      const locked = lockSessionHandlers(raw, lock);
      const self = sessionStopperOf(raw.engine_session_stop, lock);
      await rig.run(start(rig.repo.commit, false));
      const g = gate();
      const events: string[] = [];
      // a slow cloud job holds the session (the locked handlers take the same turn the lock gives here); the runner's own stop queues behind it, and a cloud stop queued after that waits for it
      const slow = lock(SESSION_REPO, async () => (events.push("cloud:start"), await g.opened, events.push("cloud:end")));
      const mine = self(SESSION_REPO).then((ok) => events.push(`self:${ok}`));
      const next = locked.engine_session_stop({ job: { v: 1, kind: "engine_session_stop", job_id: "22222222-2222-4222-8222-222222222222", repo_gh_id: SESSION_REPO, args: { reason: "operate_off", operate_epoch: 0 } } as never, reporter: { closed: false, report: async () => "recorded" } as never, signal: new AbortController().signal }).then(() => events.push("cloud:stop"));
      await Promise.resolve();
      expect(events).toEqual(["cloud:start"]);
      g.open();
      await Promise.all([slow, mine, next]);
      expect(events).toEqual(["cloud:start", "cloud:end", "self:true", "cloud:stop"]);
      expect(rig.log.filter((l) => l === `stop ${NAME}`)).toHaveLength(1);
    });

    it("the self-stop asks again when its turn comes: a renewal that arrived while a cloud job held the session cancels it", async () => {
      const lock = createSessionLock();
      const g = gate();
      const ran: number[] = [];
      const stopper = sessionStopperOf((async () => void ran.push(1)) as never, lock);
      const holder = lock(7, async () => await g.opened);
      let due = true;
      const stopping = stopper(7, () => due);
      due = false; // the lease was renewed (or withdrawn) while the session was held
      g.open();
      await holder;
      expect(await stopping).toBe(true);
      expect(ran).toEqual([]);
    });
  });
});
