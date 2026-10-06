import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CreateWorkerOptions, Worker } from "@fx/worker";
import { setWorkerWiringForTests } from "../../../../lib/worker";
import { computeSettleSweepHandler, type ComputeSettleSweepHandlerDeps } from "./handler";
import { GET } from "./route";

/** D#2 CS-2b-2: the compute-settle cron's route layer, no database (the sweep's own cases are packages/runner/test/computeSettleSweep.pg.test.ts). */
const SECRET = "test-cron-secret";
const COUNTS = { listed: 3, settled: 2, deleted: 2, failed: 1, skipped: 0 };

function deps(over: Partial<ComputeSettleSweepHandlerDeps> = {}) {
  const log = vi.fn();
  const sweepComputeSettle = vi.fn(async () => COUNTS);
  const getWorker = vi.fn(async (): Promise<{ sweepComputeSettle: typeof sweepComputeSettle } | null> => ({ sweepComputeSettle }));
  return { log, sweepComputeSettle, getWorker, deps: { cronSecret: SECRET, getWorker, log, ...over } satisfies ComputeSettleSweepHandlerDeps };
}

function requestWithAuth(authorization: string | null): NextRequest {
  const headers = new Headers();
  if (authorization !== null) headers.set("authorization", authorization);
  return new NextRequest("https://example.test/api/cron/compute-settle-sweep", { method: "GET", headers });
}

/** A stand-in request: a real NextRequest trims "Bearer " to "Bearer", so only this reaches the empty-secret guard. */
function rawAuthRequest(authorization: string): NextRequest {
  return { headers: { get: (name: string) => (name.toLowerCase() === "authorization" ? authorization : null) } } as unknown as NextRequest;
}

afterEach(() => {
  vi.unstubAllEnvs();
  setWorkerWiringForTests();
});

describe("GET /api/cron/compute-settle-sweep: auth", () => {
  it.each([
    ["no Authorization header", null, SECRET],
    ["a wrong secret", "Bearer wrong-secret", SECRET],
    ["a customer API token", "Bearer fxat_notarealcronsecretatall000000000000000", SECRET],
    ["an unset CRON_SECRET with a blank bearer", "Bearer ", ""],
    ["an unset CRON_SECRET with an empty header", "", ""],
  ])("401s with %s, and builds no worker and sweeps nothing", async (_name, header, secret) => {
    const d = deps({ cronSecret: secret });
    const res = await computeSettleSweepHandler(requestWithAuth(header), d.deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expect(d.getWorker).not.toHaveBeenCalled();
    expect(d.sweepComputeSettle).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/compute-settle-sweep: the secret guard itself", () => {
  it.each([
    ["an empty", ""],
    ["an unset", undefined as unknown as string],
  ])("401s with %s CRON_SECRET and the untrimmed header 'Bearer ', building no worker", async (_name, secret) => {
    const req = rawAuthRequest("Bearer ");
    expect(req.headers.get("authorization")).toHaveLength(7);
    const d = deps({ cronSecret: secret });
    const res = await computeSettleSweepHandler(req, d.deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expect(d.getWorker).not.toHaveBeenCalled();
    expect(d.sweepComputeSettle).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });

  it.each([
    ["first", `X${SECRET.slice(1)}`],
    ["last", `${SECRET.slice(0, -1)}X`],
  ])("401s a wrong secret of the right length that differs in its %s byte", async (_name, wrong) => {
    expect(wrong).toHaveLength(SECRET.length);
    expect(wrong).not.toBe(SECRET);
    const d = deps();
    const res = await computeSettleSweepHandler(requestWithAuth(`Bearer ${wrong}`), d.deps);
    expect(res.status).toBe(401);
    expect(d.getWorker).not.toHaveBeenCalled();
    expect(d.sweepComputeSettle).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/compute-settle-sweep: the sweep", () => {
  it("with no worker configured it logs exactly 'compute settle: worker not configured' and returns 200", async () => {
    const d = deps({ getWorker: async () => null });
    const res = await computeSettleSweepHandler(requestWithAuth(`Bearer ${SECRET}`), d.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, listed: 0, settled: 0, deleted: 0, failed: 0, skipped: 0 });
    expect(d.log.mock.calls).toEqual([["compute settle: worker not configured"]]);
  });

  it("with a worker it runs one tick and reports the counts", async () => {
    const d = deps();
    const res = await computeSettleSweepHandler(requestWithAuth(`Bearer ${SECRET}`), d.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, ...COUNTS });
    expect(d.sweepComputeSettle).toHaveBeenCalledTimes(1);
    expect(d.log).not.toHaveBeenCalled();
  });
});

describe("the counts pass through unchanged", () => {
  const DISTINCT = { listed: 7, settled: 3, deleted: 2, failed: 1, skipped: 4 };

  it("reports every count, all nonzero and distinct", async () => {
    const d = deps();
    d.sweepComputeSettle.mockResolvedValueOnce(DISTINCT);
    const res = await computeSettleSweepHandler(requestWithAuth(`Bearer ${SECRET}`), d.deps);
    expect(await res.json()).toEqual({ configured: true, ...DISTINCT });
  });

  it("reports the same distinct counts through the route", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const worker = { sweepComputeSettle: vi.fn(async () => DISTINCT) } as unknown as Worker;
    setWorkerWiringForTests({
      provider: () => ({ vercel: { teamId: "t", projectId: "p", getToken: async () => "tok" }, ports: {} }) as unknown as CreateWorkerOptions,
      createWorker: async () => worker,
    });
    expect(await (await GET(requestWithAuth(`Bearer ${SECRET}`))).json()).toEqual({ configured: true, ...DISTINCT });
  });

  it.each(["listed", "settled", "deleted", "failed", "skipped"] as const)("reports a lone nonzero %s", async (field) => {
    const d = deps();
    d.sweepComputeSettle.mockResolvedValueOnce({ listed: 0, settled: 0, deleted: 0, failed: 0, skipped: 0, [field]: 5 });
    const res = await computeSettleSweepHandler(requestWithAuth(`Bearer ${SECRET}`), d.deps);
    expect(await res.json()).toMatchObject({ configured: true, [field]: 5 });
  });
});

describe("the route wiring", () => {
  it("runs the sweep through the worker facade, with the CRON_SECRET from the environment", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const sweepComputeSettle = vi.fn(async () => COUNTS);
    const worker = { sweepComputeSettle } as unknown as Worker;
    setWorkerWiringForTests({
      provider: () => ({ vercel: { teamId: "t", projectId: "p", getToken: async () => "tok" }, ports: {} }) as unknown as CreateWorkerOptions,
      createWorker: async () => worker,
    });
    const res = await GET(requestWithAuth(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, ...COUNTS });
    expect(sweepComputeSettle).toHaveBeenCalledTimes(1);
    expect((await GET(requestWithAuth("Bearer wrong"))).status).toBe(401);
    expect(sweepComputeSettle).toHaveBeenCalledTimes(1);
  });
});
