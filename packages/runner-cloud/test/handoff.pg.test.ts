import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HeartbeatReply } from "@fulcrumaxe/runner-protocol";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { QUEUE_TTL_MS } from "@fx/runner";
import {
  HANDOFF_DEADLINE_MS,
  HANDOFF_PROTOCOL_VERSION,
  RunnerHttpError,
  cancelHandoff,
  heartbeatRun,
  requestHandoff,
  toResponse,
  type HandoffCloudTarget,
  type HandoffDeps,
  type RunnerLeaseOps,
} from "../src/index.js";
import { harness, newKey, registerKey, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#599 HO-2a: the handoff request, its cancel and the heartbeat answer, over real rows with row security forced. The cloud target is a
 * stand-in for apps/web's (which needs the seat resolver): it takes its reservations with the same INSERT `reserveWith` makes, as app_user,
 * through the caller's transaction. What this cannot show is the live spend arithmetic; that is spend's own suite.
 */
describe("run handoff request, cancel and heartbeat [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const LEASE_END = new Date("2026-10-10T12:01:30.000Z");
  const heartbeats: Array<Record<string, unknown>> = [];
  const leases = {
    heartbeatRunnerRun: async (input: Record<string, unknown>) => {
      heartbeats.push(input);
      return { verdict: "ok" as const, leaseExpiresAt: LEASE_END };
    },
  } as unknown as RunnerLeaseOps;

  /** A cloud target whose reservations are the rows `reserve()` inserts (no run yet), or a refusal. */
  const cloud = (outcome: "admit" | "deny" | "unseated" = "admit"): HandoffCloudTarget => ({
    async seat() {
      if (outcome === "unseated") return { ok: false, reason: "no_model" };
      return {
        ok: true,
        reserve: async (client: PoolClient) => {
          if (outcome === "deny") return { ok: false, reason: "model_budget_exceeded" };
          const insert = async (budget: string, usd: number) =>
            (await client.query<{ id: string }>("INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES (current_setting('app.account_id')::uuid, NULL, $1, 'open', $2, 'run') RETURNING id", [usd, budget])).rows[0]!.id;
          return { ok: true, reservations: { modelId: await insert("model", 1.5), computeId: await insert("foreground_compute", 0.25) } };
        },
      };
    },
  });
  const handoffDeps = (over: Partial<HandoffDeps> = {}): HandoffDeps => ({
    appUserPool: h.appPool,
    cloudTarget: cloud(),
    runnerJobsConfigured: () => true,
    repoVisibility: async () => "private",
    ...over,
  });

  interface World {
    f: F2Fixture;
    repo: string;
    item: string;
  }
  async function world(mode = "runner_local", placement: string | null = null): Promise<World> {
    const f = await seedF2(h.admin);
    const repo = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'Acme', 'widgets', $4)", [repo, f.accountId, Math.floor(Math.random() * 1e12), mode]);
    const item = randomUUID();
    await h.admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, placement) VALUES ($1, $2, $3, 'feature', 'internal', $4)", [item, f.accountId, repo, placement]);
    await h.admin.query("INSERT INTO model_connections (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status) VALUES ($1, 'anthropic', $2, $3, $4, 1, $5, 'ok')", [f.accountId, Buffer.from("c"), Buffer.from("n"), Buffer.from("d"), randomUUID().slice(0, 8)]);
    return { f, repo, item };
  }
  async function run(w: World, side: "cloud" | "runner", status = "running", runnerId: string | null = null): Promise<string> {
    const id = randomUUID();
    await h.admin.query(
      "INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, work_item_id, runner_id) VALUES ($1, $2, 'executor', $3, $4, $5, $6, $7, $8)",
      [id, w.f.accountId, side === "runner" ? "runner" : "production", status, side === "runner" ? "runner_local" : "sandbox", w.repo, w.item, runnerId],
    );
    return id;
  }
  /** A runner of the account that lists the repo, heard from `secondsAgo` ago, at a protocol version. */
  async function runner(w: World, o: { secondsAgo?: number; version?: number | null; key?: TestKey } = {}): Promise<string> {
    const id = o.key ? await registerKey(h.admin, w.f.accountId, w.f.o1, o.key) : await insertRunner(h.admin, w.f.accountId, w.f.o1);
    await h.admin.query("UPDATE runners SET protocol_version = $2, last_seen_at = now() - make_interval(secs => $3), allowed_repo_ids = ARRAY[$4::uuid] WHERE id = $1", [id, o.version === undefined ? HANDOFF_PROTOCOL_VERSION : o.version, o.secondsAgo ?? 5, w.repo]);
    return id;
  }
  const rows = async (runId: string) => (await h.admin.query("SELECT * FROM run_handoffs WHERE run_id = $1 ORDER BY created_at", [runId])).rows;
  const reservations = async (accountId: string) => (await h.admin.query("SELECT id, state, run_id, budget FROM spend_reservations WHERE account_id = $1", [accountId])).rows;
  const placement = async (item: string) => (await h.admin.query("SELECT placement FROM work_items WHERE id = $1", [item])).rows[0].placement as string | null;
  const statusOf = async (id: string) => (await h.admin.query("SELECT status FROM agent_runs WHERE id = $1", [id])).rows[0].status as string;
  const audits = async (accountId: string) => (await h.admin.query("SELECT actor, action, payload FROM audit_log WHERE account_id = $1 AND action LIKE ANY (ARRAY['run.handoff.%', 'work_item.placement.%']) ORDER BY created_at, id", [accountId])).rows;
  const as = (f: F2Fixture, userId: string) => ({ accountId: f.accountId, userId });
  const refusal = async (p: Promise<unknown>): Promise<RunnerHttpError> => {
    try {
      await p;
    } catch (error) {
      expect(error).toBeInstanceOf(RunnerHttpError);
      return error as RunnerHttpError;
    }
    throw new Error("expected a refusal");
  };
  /** The refusals' shared promise: the live run keeps running, no handoff row exists, nothing is reserved, the placement is unchanged. */
  async function untouched(w: World, runId: string, placed: string | null = null): Promise<void> {
    expect(await statusOf(runId)).toBe("running");
    expect(await rows(runId)).toEqual([]);
    expect(await reservations(w.f.accountId)).toEqual([]);
    expect(await placement(w.item)).toBe(placed);
    expect(await audits(w.f.accountId)).toEqual([]);
  }

  describe("requesting a move to the cloud", () => {
    it("reserves first, records `requested` with deadline now + 5 min, sets the item's placement and audits both, leaving the run running", async () => {
      const w = await world("runner_local", "runner");
      const r = await run(w, "runner", "running", await runner(w));
      const before = Date.now();
      const res = await requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud");
      const after = Date.now();
      expect(res.status).toBe(202);
      const [row] = await rows(r);
      expect(row).toMatchObject({ run_id: r, item_id: w.item, from_side: "runner", to_side: "cloud", state: "requested", requested_by: w.f.o1, prior_placement: "runner", child_run_id: null });
      expect(res.body).toMatchObject({ handoff_id: row.id, run_id: r, state: "requested", from: "runner", to: "cloud", deadline: row.deadline.toISOString() });
      expect(row.deadline.getTime()).toBeGreaterThanOrEqual(before + HANDOFF_DEADLINE_MS);
      expect(row.deadline.getTime()).toBeLessThanOrEqual(after + HANDOFF_DEADLINE_MS);
      expect(row.reserve_until.getTime() - row.deadline.getTime()).toBe(QUEUE_TTL_MS);
      // two open reservations bound to no run, and the row names them
      const held = await reservations(w.f.accountId);
      expect(held.map((x) => [x.state, x.run_id, x.budget]).sort()).toEqual([["open", null, "foreground_compute"], ["open", null, "model"]]);
      expect([row.reservation_id, row.compute_reservation_id].sort()).toEqual(held.map((x) => x.id).sort());
      expect(await placement(w.item)).toBe("cloud");
      expect(await statusOf(r)).toBe("running");
      expect(await audits(w.f.accountId)).toEqual([
        { actor: w.f.o1, action: "run.handoff.requested", payload: { handoff_id: row.id, run_id: r, item_id: w.item, from: "runner", to: "cloud", prior_placement: "runner" } },
        { actor: w.f.o1, action: "work_item.placement.changed", payload: { item_id: w.item, from: "runner", to: "cloud", cancelled_runs: 0 } },
      ]);
    });

    it("an admin may; an item with no placement of its own records null as the prior value", async () => {
      const w = await world();
      const r = await run(w, "runner", "running", await runner(w));
      expect((await requestHandoff(handoffDeps(), as(w.f, w.f.a1), r, "cloud")).status).toBe(202);
      expect((await rows(r))[0]).toMatchObject({ prior_placement: null, requested_by: w.f.a1 });
    });

    it("a refused spend is 409 refused_spend with the closed reason; the run keeps running and no row, reservation, placement change or audit exists", async () => {
      const w = await world();
      const r = await run(w, "runner", "running", await runner(w));
      const e = await refusal(requestHandoff(handoffDeps({ cloudTarget: cloud("deny") }), as(w.f, w.f.o1), r, "cloud"));
      expect([e.status, e.code, e.extra]).toEqual([409, "refused_spend", { reason: "model_budget_exceeded" }]);
      await untouched(w, r);
    });

    it("an item the cloud cannot seat is 409 target_not_ready, and a missing model key is 409 model_key_required; both leave everything as it was", async () => {
      const w = await world();
      const r = await run(w, "runner", "running", await runner(w));
      const seat = await refusal(requestHandoff(handoffDeps({ cloudTarget: cloud("unseated") }), as(w.f, w.f.o1), r, "cloud"));
      expect([seat.status, seat.code, seat.extra]).toEqual([409, "target_not_ready", { reason: "no_model" }]);
      await h.admin.query("DELETE FROM model_connections WHERE account_id = $1", [w.f.accountId]);
      const key = await refusal(requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud"));
      expect([key.status, key.code]).toEqual([409, "model_key_required"]);
      await untouched(w, r);
    });

    it("a deployment with no cloud target answers 503 handoff_unavailable and writes nothing", async () => {
      const w = await world();
      const r = await run(w, "runner", "running", await runner(w));
      const e = await refusal(requestHandoff(handoffDeps({ cloudTarget: null }), as(w.f, w.f.o1), r, "cloud"));
      expect([e.status, e.code]).toEqual([503, "handoff_unavailable"]);
      await untouched(w, r);
    });
  });


  describe("requesting a move to the runner", () => {
    it("is accepted when a live runner that lists the repo has room; no reservation is taken and the placement becomes runner", async () => {
      const w = await world("runner_local", "cloud");
      const r = await run(w, "cloud");
      await runner(w);
      const res = await requestHandoff(handoffDeps({ cloudTarget: null }), as(w.f, w.f.o1), r, "runner");
      expect(res.status).toBe(202);
      expect((await rows(r))[0]).toMatchObject({ from_side: "cloud", to_side: "runner", state: "requested", prior_placement: "cloud", reservation_id: null, compute_reservation_id: null });
      expect(await reservations(w.f.accountId)).toEqual([]);
      expect(await placement(w.item)).toBe("runner");
    });

    it("names the reason when the runner side is not ready, and writes nothing: no runner, one gone quiet, one that does not list the repo, a full one, a repo not on a runner, a public or unreadable repo, no signing keys", async () => {
      const w = await world();
      const r = await run(w, "cloud");
      const ask = (over: Partial<HandoffDeps> = {}) => refusal(requestHandoff(handoffDeps(over), as(w.f, w.f.o1), r, "runner"));
      expect((await ask()).code).toBe("no_runner_online");
      const quiet = await runner(w, { secondsAgo: 130 });
      expect((await ask()).code).toBe("no_runner_online");
      await h.admin.query("UPDATE runners SET last_seen_at = now() - interval '100 seconds', allowed_repo_ids = '{}' WHERE id = $1", [quiet]);
      expect((await ask()).code).toBe("no_runner_online");
      await h.admin.query("UPDATE runners SET allowed_repo_ids = ARRAY[$2::uuid] WHERE id = $1", [quiet, w.repo]);
      // full: it declares room for one job and holds one (a running run with a live lease)
      await h.admin.query("INSERT INTO runner_capacity (runner_id, account_id, declared, light_limit, heavy_limit) VALUES ($1, $2, true, 0, 1)", [quiet, w.f.accountId]);
      const other = await run(w, "runner", "running", quiet);
      await h.admin.query("UPDATE agent_runs SET lease_expires_at = now() + interval '1 minute' WHERE id = $1", [other]);
      expect((await ask()).code).toBe("no_runner_online");
      await h.admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [other]);
      // ready now: the refusals below are about the repo and the deployment
      expect((await ask({ runnerJobsConfigured: () => false })).code).toBe("handoff_unavailable");
      expect((await ask({ repoVisibility: async () => "public" })).code).toBe("public_repo");
      expect((await ask({ repoVisibility: async () => "unknown" })).code).toBe("repo_visibility_unknown");
      expect(
        (
          await ask({
            repoVisibility: async () => {
              throw new Error("github down");
            },
          })
        ).code,
      ).toBe("repo_visibility_unknown");
      await h.admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [w.repo]);
      expect((await ask()).code).toBe("no_runner_mode");
      expect(await rows(r)).toEqual([]);
      expect(await placement(w.item)).toBeNull();
      expect(await audits(w.f.accountId)).toEqual([]);
    });

    it("a runner-to-runner move (the fleet's drain) excludes the run's own runner, and the route's plain request refuses the same side", async () => {
      const w = await world();
      const source = await runner(w);
      const r = await run(w, "runner", "running", source);
      expect((await refusal(requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "runner"))).code).toBe("already_on_that_side");
      expect((await refusal(requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "runner", { betweenRunners: true }))).code).toBe("no_runner_online");
      await runner(w);
      expect((await requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "runner", { betweenRunners: true })).status).toBe(202);
      expect((await rows(r))[0]).toMatchObject({ from_side: "runner", to_side: "runner", state: "requested" });
      // runner to runner changes no placement of a null item (it is set to runner), so the placement audit is the only extra row
      expect((await audits(w.f.accountId)).map((a) => a.action)).toEqual(["run.handoff.requested", "work_item.placement.changed"]);
    });
  });

  describe("a source runner that cannot be told", () => {
    it("is refused up front with 409 runner_update_required (below the handoff version, or no version on record), before any spend is held", async () => {
      for (const version of [HANDOFF_PROTOCOL_VERSION - 1, null]) {
        const w = await world();
        const r = await run(w, "runner", "running", await runner(w, { version }));
        const e = await refusal(requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud"));
        expect([e.status, e.code], String(version)).toEqual([409, "runner_update_required"]);
        await untouched(w, r);
      }
    });
  });

  describe("who may ask, and of what", () => {
    it("a member is 403 and an outsider's run is 404; neither writes anything", async () => {
      const w = await world();
      const r = await run(w, "runner", "running", await runner(w));
      expect((await refusal(requestHandoff(handoffDeps(), as(w.f, w.f.m1), r, "cloud"))).status).toBe(403);
      const outsider = await world();
      expect((await refusal(requestHandoff(handoffDeps(), as(outsider.f, outsider.f.o1), r, "cloud"))).status).toBe(404);
      expect((await refusal(cancelHandoff(handoffDeps(), as(w.f, w.f.m1), r))).status).toBe(403);
      await untouched(w, r);
    });

    it("only a running run of an item can move, and the target must be cloud or runner", async () => {
      const w = await world();
      for (const status of ["pending", "succeeded", "cancelled", "failed"]) {
        const r = await run(w, "runner", status);
        expect((await refusal(requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud"))).code, status).toBe("run_not_movable");
      }
      const live = await run(w, "runner", "running", await runner(w));
      for (const bad of ["Cloud", "runner_verified", "sandbox", "", null, 7, { to: "cloud" }]) {
        expect((await refusal(requestHandoff(handoffDeps(), as(w.f, w.f.o1), live, bad))).status, JSON.stringify(bad)).toBe(400);
      }
      expect((await refusal(requestHandoff(handoffDeps(), as(w.f, w.f.o1), "not-a-uuid", "cloud"))).status).toBe(404);
      expect((await refusal(requestHandoff(handoffDeps(), as(w.f, w.f.o1), randomUUID(), "cloud"))).status).toBe(404);
      expect(await reservations(w.f.accountId)).toEqual([]);
    });
  });

  describe("one live handoff per run", () => {
    it("a second request is 409 handoff_in_progress and takes no second reservation; a finished handoff does not block a new one", async () => {
      const w = await world();
      const r = await run(w, "runner", "running", await runner(w));
      await requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud");
      const again = await refusal(requestHandoff(handoffDeps(), as(w.f, w.f.a1), r, "cloud"));
      expect([again.status, again.code]).toEqual([409, "handoff_in_progress"]);
      expect(await rows(r)).toHaveLength(1);
      expect(await reservations(w.f.accountId)).toHaveLength(2);
      await cancelHandoff(handoffDeps(), as(w.f, w.f.o1), r);
      expect((await requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud")).status).toBe(202);
      expect((await rows(r)).map((x) => x.state)).toEqual(["cancelled", "requested"]);
    });

    it("two requests at the same moment produce exactly one handoff and one set of reservations", async () => {
      const w = await world();
      const r = await run(w, "runner", "running", await runner(w));
      const outcomes = await Promise.allSettled([requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud"), requestHandoff(handoffDeps(), as(w.f, w.f.a1), r, "cloud")]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const lost = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ status: 409, code: "handoff_in_progress" });
      expect(await rows(r)).toHaveLength(1);
      // the loser's reservations were taken in its own transaction and rolled back with it
      expect(await reservations(w.f.accountId)).toHaveLength(2);
    });

    it("the unique index holds when a row is forced in directly", async () => {
      const w = await world();
      const r = await run(w, "runner", "running", await runner(w));
      await requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud");
      await expect(
        h.admin.query("INSERT INTO run_handoffs (account_id, run_id, item_id, from_side, to_side, deadline, reserve_until, requested_by) VALUES ($1, $2, $3, 'runner', 'cloud', now() + interval '1 minute', now() + interval '2 minutes', $4)", [w.f.accountId, r, w.item, w.f.o1]),
      ).rejects.toMatchObject({ code: "23505", constraint: "run_handoffs_one_live_per_run" });
    });
  });

  describe("cancelling", () => {
    it("in `requested` removes both reservation rows, marks the row cancelled, puts the placement back and audits it; the run keeps running", async () => {
      const w = await world("runner_local", "runner");
      const r = await run(w, "runner", "running", await runner(w));
      await requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud");
      const res = await cancelHandoff(handoffDeps(), as(w.f, w.f.a1), r);
      expect(res).toMatchObject({ status: 200, body: { run_id: r, state: "cancelled", placement_restored: true } });
      // released, never deleted; the cancelled row keeps the ids as its record
      const held = await reservations(w.f.accountId);
      expect(held.map((x) => x.state)).toEqual(["released", "released"]);
      expect((await rows(r))[0]).toMatchObject({ state: "cancelled" });
      expect([(await rows(r))[0].reservation_id, (await rows(r))[0].compute_reservation_id].sort()).toEqual(held.map((x) => x.id).sort());
      expect(await placement(w.item)).toBe("runner");
      expect(await statusOf(r)).toBe("running");
      expect((await audits(w.f.accountId)).map((a) => [a.actor, a.action])).toEqual([
        [w.f.o1, "run.handoff.requested"],
        [w.f.o1, "work_item.placement.changed"],
        [w.f.a1, "run.handoff.cancelled"],
        [w.f.a1, "work_item.placement.changed"],
      ]);
    });

    it("leaves a placement someone else changed since the request alone (last write wins), and says so", async () => {
      const w = await world("runner_local", "runner");
      const r = await run(w, "runner", "running", await runner(w));
      await requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud");
      await h.admin.query("UPDATE work_items SET placement = NULL WHERE id = $1", [w.item]);
      const res = await cancelHandoff(handoffDeps(), as(w.f, w.f.o1), r);
      expect(res.body).toMatchObject({ placement_restored: false });
      expect(await placement(w.item)).toBeNull();
    });

    it("in `checkpointing` is 409 handoff_committed and changes nothing; with no live handoff it is 404", async () => {
      const w = await world();
      const key = newKey();
      const rid = await runner(w, { version: HANDOFF_PROTOCOL_VERSION, key });
      const r = await run(w, "runner", "running", rid);
      expect((await refusal(cancelHandoff(handoffDeps(), as(w.f, w.f.o1), r))).status).toBe(404);
      await requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud");
      const beat = await heartbeatRun(h.deps({ leases }), signed(key, "/api/runner/heartbeat", { run_id: r, lease_generation: 1 }));
      expect(beat.status).toBe(200);
      const e = await refusal(cancelHandoff(handoffDeps(), as(w.f, w.f.o1), r));
      expect([e.status, e.code]).toEqual([409, "handoff_committed"]);
      expect((await rows(r))[0].state).toBe("checkpointing");
      expect(await reservations(w.f.accountId)).toHaveLength(2);
      expect(await placement(w.item)).toBe("cloud");
    });
  });

  describe("the heartbeat answer (R-599-HO1)", () => {
    const beat = (key: TestKey, runId: string) => toResponse(() => heartbeatRun(h.deps({ leases }), signed(key, "/api/runner/heartbeat", { run_id: runId, lease_generation: 1 })));
    const told = (res: { body: unknown }): boolean => "handoff" in (res.body as object);

    it("a runner whose stored version is at the handoff version gets 200 with handoff.deadline equal to the stored one; the lease is extended, the state is checkpointing, and every later heartbeat says it again", async () => {
      const w = await world();
      const key = newKey();
      const r = await run(w, "runner", "running", await runner(w, { version: HANDOFF_PROTOCOL_VERSION, key }));
      const plain = await beat(key, r);
      expect(plain.body).toEqual({ continue: true, lease_expires_at: LEASE_END.toISOString() });
      await requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud");
      const res = await beat(key, r);
      const stored = (await rows(r))[0];
      expect(res.status).toBe(200);
      expect(HeartbeatReply.safeParse(res.body).success).toBe(true);
      expect(res.body).toEqual({ continue: true, lease_expires_at: LEASE_END.toISOString(), handoff: { requested: true, deadline: stored.deadline.toISOString() } });
      expect(stored.state).toBe("checkpointing");
      expect(await statusOf(r)).toBe("running");
      expect((await beat(key, r)).body).toMatchObject({ handoff: { requested: true, deadline: stored.deadline.toISOString() } });
      expect(heartbeats.at(-1)).toMatchObject({ runId: r, leaseGeneration: 1 });
    });

    it("a runner below the handoff version, or with no version on record, gets the plain reply and the request stays `requested`; a newer version is told", async () => {
      for (const [version, expected] of [[HANDOFF_PROTOCOL_VERSION - 1, false], [null, false], [HANDOFF_PROTOCOL_VERSION + 1, true]] as const) {
        const w = await world();
        const key = newKey();
        const id = await runner(w, { version: HANDOFF_PROTOCOL_VERSION, key });
        const r = await run(w, "runner", "running", id);
        await requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud");
        // the request was accepted (the runner could be told); the answer reads the stored version at that moment, so move it
        await h.admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [id, version]);
        const res = await beat(key, r);
        expect(res.status).toBe(200);
        expect(told(res), String(version)).toBe(expected);
        if (!expected) expect(res.body).toEqual({ continue: true, lease_expires_at: LEASE_END.toISOString() });
        expect((await rows(r))[0].state, String(version)).toBe(expected ? "checkpointing" : "requested");
      }
    });

    it("the version is read when the heartbeat is answered: a runner upgraded after the request is told on its next beat", async () => {
      const w = await world();
      const key = newKey();
      const id = await runner(w, { version: HANDOFF_PROTOCOL_VERSION, key });
      const r = await run(w, "runner", "running", id);
      await requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud");
      await h.admin.query("UPDATE runners SET protocol_version = 1 WHERE id = $1", [id]);
      expect(told(await beat(key, r))).toBe(false);
      await h.admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [id, HANDOFF_PROTOCOL_VERSION]);
      expect(told(await beat(key, r))).toBe(true);
    });

    it("only the runner that holds the run is told, and a cancelled handoff is never signalled", async () => {
      const w = await world();
      const [holder, bystander] = [newKey(), newKey()];
      const r = await run(w, "runner", "running", await runner(w, { version: HANDOFF_PROTOCOL_VERSION, key: holder }));
      await runner(w, { version: HANDOFF_PROTOCOL_VERSION, key: bystander });
      await requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud");
      expect(told(await beat(bystander, r))).toBe(false);
      expect((await rows(r))[0].state).toBe("requested");
      await cancelHandoff(handoffDeps(), as(w.f, w.f.o1), r);
      expect(told(await beat(holder, r))).toBe(false);
    });

    it("a run that is no longer running is never signalled, and its handoff is left as it was", async () => {
      const w = await world();
      const key = newKey();
      const r = await run(w, "runner", "running", await runner(w, { version: HANDOFF_PROTOCOL_VERSION, key }));
      await requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud");
      for (const status of ["succeeded", "failed", "cancelled"]) {
        await h.admin.query("UPDATE agent_runs SET status = $2 WHERE id = $1", [r, status]);
        expect(told(await beat(key, r)), status).toBe(false);
        expect((await rows(r))[0].state, status).toBe("requested");
      }
    });

    it("a handoff row of another tenant is never read: a runner of tenant B asking about tenant A's run gets the plain reply", async () => {
      const w = await world();
      const r = await run(w, "runner", "running", await runner(w, { version: HANDOFF_PROTOCOL_VERSION }));
      await requestHandoff(handoffDeps(), as(w.f, w.f.o1), r, "cloud");
      const b = await seedAccount(h.admin, randomUUID());
      const key = newKey();
      const id = await registerKey(h.admin, b.accountId, b.userId, key);
      await h.admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [id, HANDOFF_PROTOCOL_VERSION]);
      expect(told(await beat(key, r))).toBe(false);
      expect((await rows(r))[0].state).toBe("requested");
    });
  });

  describe("the state table", () => {
    it("allows only the listed edges, and a finished row never changes", async () => {
      const w = await world();
      const make = async (): Promise<string> => {
        const id = randomUUID();
        await h.admin.query("INSERT INTO run_handoffs (id, account_id, run_id, item_id, from_side, to_side, deadline, reserve_until, requested_by) VALUES ($1, $2, $3, $4, 'runner', 'cloud', now() + interval '1 minute', now() + interval '2 minutes', $5)", [id, w.f.accountId, await run(w, "runner"), w.item, w.f.o1]);
        return id;
      };
      const set = (id: string, state: string) => h.admin.query("UPDATE run_handoffs SET state = $2 WHERE id = $1", [id, state]);
      const legal = new Set(["requested>checkpointing", "requested>cancelled", "requested>failed", "requested>forced", "checkpointing>handed_off", "checkpointing>forced", "checkpointing>failed"]);
      const path: Record<string, string[]> = { requested: [], checkpointing: ["checkpointing"], handed_off: ["checkpointing", "handed_off"], forced: ["forced"], cancelled: ["cancelled"], failed: ["failed"] };
      for (const from of Object.keys(path)) {
        for (const to of Object.keys(path).filter((s) => s !== from)) {
          const id = await make();
          for (const step of path[from]!) await set(id, step);
          if (legal.has(`${from}>${to}`)) await set(id, to);
          else await expect(set(id, to), `${from} -> ${to}`).rejects.toMatchObject({ code: "23514" });
        }
      }
      await expect(set(await make(), "unheard_of")).rejects.toMatchObject({ code: "23514" });
    });
  });
});
