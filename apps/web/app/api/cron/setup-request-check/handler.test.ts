import net from "node:net";
import tls from "node:tls";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { markWorkPending, setPendingHooks } from "@fx/core/src/pendingWork";
import { sweepSetupRequestChecks } from "@fx/core/src/setup-requests/checkSweep";
import { sweepPlaneParity } from "@fx/core/src/repos/planeParityChecks";
import type { VercelEnvSource } from "@fx/core/src/setup-requests/checks";
import { productionVercelEnvSource } from "../../../../lib/setupRequestEnvSource";
import { makeRegion, storeOf, type FakeRegion } from "../../../../test/support/runtimeCacheFake";
import { setupRequestCheckHandler, type SetupRequestCheckHandlerDeps } from "./handler";

/**
 * D#598 P8b-L3 and P8b-L4: the cron's route layer behind the pending-work marker. The sweep itself runs for real over a counting pool (the
 * database cases are packages/core/test/setup-requests/checkSweep.pg.test.ts and packages/db/test/setup-request-lister.pg.test.ts).
 */
const SECRET = "test-cron-secret";
const KEY = "pending:setup-request-check";
const clock = { value: Date.parse("2026-10-18T12:00:00Z") };
let region: FakeRegion;

/** A pool that records every statement and answers the due list with `rows`. */
function countingPool(rows: Array<{ account_id: string; setup_request_id: string; kind: string }> = []) {
  const statements: string[] = [];
  const pool = { query: vi.fn(async (sql: string) => (statements.push(sql), { rows })) } as unknown as Pool;
  return { pool, statements };
}

function setup(over: Partial<SetupRequestCheckHandlerDeps> = {}, pool = countingPool(), envSource: VercelEnvSource = productionVercelEnvSource) {
  const sourceSpy = vi.fn(envSource.listEnvNames.bind(envSource));
  const source: VercelEnvSource = { available: envSource.available, listEnvNames: sourceSpy };
  const sweepSetupRequestChecksSpy = vi.fn((input: { envSource: VercelEnvSource }) => sweepSetupRequestChecks({ pool: pool.pool, envSource: input.envSource, now: () => clock.value, log: () => undefined }));
  const getWorker = vi.fn(async () => ({ sweepSetupRequestChecks: sweepSetupRequestChecksSpy }));
  const log = vi.fn();
  return { ...pool, sourceSpy, getWorker, log, deps: { cronSecret: SECRET, getWorker, envSource: source, log, now: () => clock.value, ...over } satisfies SetupRequestCheckHandlerDeps };
}
const req = (authorization: string | null) => new NextRequest("https://example.test/api/cron/setup-request-check", { method: "GET", headers: authorization === null ? {} : { authorization } });
const marker = (): number | null => {
  const e = region.entries.get(KEY);
  return e ? (JSON.parse(e.json) as number) : null;
};

/** Anything that would leave the process: the global fetch and a raw socket connect (the net-guard's pinned connector sits on these). */
let outbound: Array<() => void>;
let outboundCalls: number;
beforeEach(() => {
  region = makeRegion(clock);
  setPendingHooks({ store: storeOf(region) });
  region.entries.set("lastrun:setup-request-check", { json: JSON.stringify(clock.value), expiresAt: clock.value + 3_600_000 });
  outboundCalls = 0;
  const count = () => {
    outboundCalls += 1;
    throw new Error("outbound call in a test that must make none");
  };
  outbound = [
    () => vi.spyOn(globalThis, "fetch").mockImplementation(count as never) && undefined,
    () => vi.spyOn(net.Socket.prototype, "connect").mockImplementation(count as never) && undefined,
    () => vi.spyOn(tls, "connect").mockImplementation(count as never) && undefined,
  ];
  for (const arm of outbound) arm();
});
afterEach(() => {
  setPendingHooks(null);
  vi.restoreAllMocks();
});

describe("GET /api/cron/setup-request-check", () => {
  it.each([
    ["no header", null, SECRET],
    ["a wrong secret", "Bearer nope", SECRET],
    ["a customer API token", "Bearer fxat_notarealcronsecretatall000000000000000", SECRET],
    ["an unset secret", "Bearer ", ""],
  ])("L4: answers 401 with %s and does nothing: no worker, no statement, no outbound call, no marker change", async (_n, header, secret) => {
    await markWorkPending("setup-request-check", { since: clock.value });
    const s = setup({ cronSecret: secret });
    const res = await setupRequestCheckHandler(req(header), s.deps);
    expect(res.status).toBe(401);
    expect(s.getWorker).not.toHaveBeenCalled();
    expect(s.statements).toEqual([]);
    expect(s.sourceSpy).not.toHaveBeenCalled();
    expect(outboundCalls).toBe(0);
    expect(marker()).toBe(clock.value);
  });

  it("an idle platform (no marker) builds no worker, runs no SQL statement and makes no outbound call", async () => {
    const s = setup();
    const res = await setupRequestCheckHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(s.getWorker).not.toHaveBeenCalled();
    expect(s.statements).toHaveLength(0);
    expect(s.sourceSpy).not.toHaveBeenCalled();
    expect(outboundCalls).toBe(0);
  });

  it("L3: with a marker and nothing due, one call makes exactly one SQL statement (the due list) and no outbound request, then the marker is cleared", async () => {
    await markWorkPending("setup-request-check", { since: clock.value - 120_000 });
    const s = setup();
    const res = await setupRequestCheckHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: true, listed: 0, passed: 0, notYet: 0, failed: 0 });
    expect(s.statements).toHaveLength(1);
    expect(s.statements[0]).toContain("setup_request_list_due");
    expect(s.sourceSpy).not.toHaveBeenCalled();
    expect(outboundCalls).toBe(0);
    expect(marker()).toBeNull();
  });

  it("a marker younger than its grace is kept even when nothing is due (its writer may not have committed), so the next tick looks again", async () => {
    await markWorkPending("setup-request-check", { since: clock.value });
    const s = setup();
    await setupRequestCheckHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(s.statements).toHaveLength(1);
    expect(marker()).toBe(clock.value);
  });

  const available: VercelEnvSource = { available: true, listEnvNames: async () => ({ ok: false }) };
  const ROWS = [{ account_id: "11111111-1111-4111-8111-111111111111", setup_request_id: "22222222-2222-4222-8222-222222222222", kind: "env_var" }];

  it("when the pass found requests and a source is bound, the marker is set 45 seconds after the pass STARTED, so the request just checked is looked at on the next minute's tick", async () => {
    await markWorkPending("setup-request-check", { since: clock.value });
    // The row is listed but unreadable by the (absent) tenant layer: the pass counts it failed and still asks for the next tick.
    const s = setup({}, countingPool(ROWS), available);
    const res = await setupRequestCheckHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(await res.json()).toMatchObject({ configured: true, listed: 1 });
    expect(marker()).toBe(clock.value + 45_000);
  });

  it("the real interval is one minute: with a list query that takes 300 ms, the tick that fires 60 seconds after the first still connects", async () => {
    await markWorkPending("setup-request-check", { since: clock.value });
    const first = clock.value;
    const slow = countingPool(ROWS);
    const inner = slow.pool.query as unknown as (sql: string) => Promise<unknown>;
    (slow.pool as unknown as { query: unknown }).query = vi.fn(async (sql: string) => {
      clock.value += 300;
      return inner(sql);
    });
    const s = setup({}, slow, available);
    await setupRequestCheckHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(s.statements).toHaveLength(1);
    expect(marker()!).toBeLessThanOrEqual(first + 60_000);
    clock.value = first + 60_000;
    const second = await setupRequestCheckHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(await second.json()).not.toMatchObject({ skipped: true });
    expect(s.statements).toHaveLength(2);
  });

  it("with no source bound a pass returns no next time: the marker clears and the platform can go idle", async () => {
    await markWorkPending("setup-request-check", { since: clock.value - 120_000 });
    const s = setup({}, countingPool(ROWS), productionVercelEnvSource);
    const res = await setupRequestCheckHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(await res.json()).toMatchObject({ configured: true, listed: 1 });
    expect(marker()).toBeNull();
    // and the next tick, with no marker, opens no connection
    const before = s.statements.length;
    expect(await (await setupRequestCheckHandler(req(`Bearer ${SECRET}`), s.deps)).json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(s.statements).toHaveLength(before);
  });

  it("with no database or key configured the production binding never answers a check, so it can never pass one", async () => {
    expect(productionVercelEnvSource.available).toBe(false);
    expect(await productionVercelEnvSource.listEnvNames({ accountId: "a", project: "p" })).toEqual({ ok: false });
  });

  it("an unconfigured worker is reported, not an error", async () => {
    await markWorkPending("setup-request-check", { since: clock.value });
    const s = setup();
    s.getWorker.mockResolvedValueOnce(null as never);
    const res = await setupRequestCheckHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
  });
});

describe("GET /api/cron/setup-request-check: the plane parity check (D#598 P1d-3)", () => {
  it("passes the parity check to the worker only when one is bound; with none, the worker input names no planeParity", async () => {
    await markWorkPending("setup-request-check", { since: clock.value - 120_000 });
    const seen: Array<Record<string, unknown>> = [];
    const worker = { sweepSetupRequestChecks: vi.fn(async (input: Record<string, unknown>) => (seen.push(input), { listed: 0, passed: 0, notYet: 0, skipped: 0, failed: 0, nextDueAt: null })) };
    const base = { cronSecret: SECRET, getWorker: async () => worker, envSource: productionVercelEnvSource, log: () => undefined, now: () => clock.value };
    await setupRequestCheckHandler(req(`Bearer ${SECRET}`), base as never);
    const compute = vi.fn();
    await markWorkPending("setup-request-check", { since: clock.value - 120_000 });
    await setupRequestCheckHandler(req(`Bearer ${SECRET}`), { ...base, planeParity: compute } as never);
    expect(seen.map((i) => "planeParity" in i)).toEqual([false, true]);
    expect(seen[1]!.planeParity).toBe(compute);
    // One deadline for the whole tick, counted from when the request arrived (the route's 60 s), handed to the worker for the parity pass.
    expect(seen[1]!.deadlineAt).toBe(clock.value + 60_000);
    expect("deadlineAt" in seen[0]!).toBe(false);
  });

  it("with a marker and nothing due, the parity list is one more statement on the same pool, no check runs and no outbound call is made; the marker then clears", async () => {
    await markWorkPending("setup-request-check", { since: clock.value - 120_000 });
    const s = setup();
    const compute = vi.fn();
    const worker = {
      sweepSetupRequestChecks: async (input: { envSource: VercelEnvSource }) => {
        const counts = await sweepSetupRequestChecks({ pool: s.pool, envSource: input.envSource, now: () => clock.value, log: () => undefined });
        const parity = await sweepPlaneParity({ pool: s.pool, compute, now: () => clock.value, log: () => undefined });
        return { ...counts, listed: counts.listed + parity.listed, parity };
      },
    };
    s.getWorker.mockResolvedValueOnce(worker as never);
    const res = await setupRequestCheckHandler(req(`Bearer ${SECRET}`), { ...s.deps, planeParity: compute });
    expect(await res.json()).toMatchObject({ configured: true, listed: 0, parity: { listed: 0, checked: 0 } });
    expect(s.statements.map((q) => /setup_request_list_due|plane_parity_list_due/.exec(q)?.[0])).toEqual(["setup_request_list_due", "plane_parity_list_due"]);
    expect(compute).not.toHaveBeenCalled();
    expect(outboundCalls).toBe(0);
    expect(marker()).toBeNull();
  });
});
