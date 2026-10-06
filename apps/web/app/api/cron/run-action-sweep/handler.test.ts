import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { RunActionsWorker } from "@fx/pipeline";
import { runActionSweepHandler, type RunActionSweepHandlerDeps } from "./handler";

/**
 * D#2 H14c-3b: the sweep cron's route layer, no database (the sweep's own database cases are
 * packages/pipeline/test/runActions.pg.test.ts). Same auth cases as cron/api-sweep.
 */
const SECRET = "test-cron-secret";

function fakeWorker(ids: string[] = []): RunActionsWorker {
  return {
    claimRunAction: vi.fn(),
    settleRunAction: vi.fn(),
    listDueRunActions: vi.fn(async () => ids),
    purgeRunActions: vi.fn(async () => 0),
    performCancelRun: vi.fn(),
    performCancelWorkItem: vi.fn(),
  } as unknown as RunActionsWorker;
}

function deps(over: Partial<RunActionSweepHandlerDeps> = {}) {
  const log = vi.fn();
  const startWorkflow = vi.fn(async () => {});
  const getWorker = vi.fn(async () => null as RunActionsWorker | null);
  return { log, startWorkflow, getWorker, deps: { cronSecret: SECRET, getWorker, startWorkflow, log, ...over } satisfies RunActionSweepHandlerDeps };
}

function requestWithAuth(authorization: string | null): NextRequest {
  const headers = new Headers();
  if (authorization !== null) headers.set("authorization", authorization);
  return new NextRequest("https://example.test/api/cron/run-action-sweep", { method: "GET", headers });
}

/** A stand-in request: a real NextRequest trims "Bearer " to "Bearer", so only this reaches the empty-secret guard. */
function rawAuthRequest(authorization: string): NextRequest {
  return { headers: { get: (name: string) => (name.toLowerCase() === "authorization" ? authorization : null) } } as unknown as NextRequest;
}

describe("GET /api/cron/run-action-sweep: auth", () => {
  it.each([
    ["no Authorization header", null, SECRET],
    ["a wrong secret", "Bearer wrong-secret", SECRET],
    ["a customer API token", "Bearer fxat_notarealcronsecretatall000000000000000", SECRET],
    ["an unset CRON_SECRET with a blank bearer", "Bearer ", ""],
    ["an unset CRON_SECRET with an empty header", "", ""],
  ])("401s with %s, and builds no worker and starts nothing", async (_name, header, secret) => {
    const d = deps({ cronSecret: secret });
    const res = await runActionSweepHandler(requestWithAuth(header), d.deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expect(d.getWorker).not.toHaveBeenCalled();
    expect(d.startWorkflow).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/run-action-sweep: the secret guard itself", () => {
  it.each([
    ["an empty", ""],
    ["an unset", undefined as unknown as string],
  ])("401s with %s CRON_SECRET and the untrimmed header 'Bearer ', building no worker", async (_name, secret) => {
    const req = rawAuthRequest("Bearer ");
    expect(req.headers.get("authorization")).toHaveLength(7);
    const d = deps({ cronSecret: secret });
    const res = await runActionSweepHandler(req, d.deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expect(d.getWorker).not.toHaveBeenCalled();
    expect(d.startWorkflow).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });

  it.each([
    ["first", `X${SECRET.slice(1)}`],
    ["last", `${SECRET.slice(0, -1)}X`],
  ])("401s a wrong secret of the right length that differs in its %s byte", async (_name, wrong) => {
    expect(wrong).toHaveLength(SECRET.length);
    expect(wrong).not.toBe(SECRET);
    const d = deps();
    const res = await runActionSweepHandler(requestWithAuth(`Bearer ${wrong}`), d.deps);
    expect(res.status).toBe(401);
    expect(d.getWorker).not.toHaveBeenCalled();
    expect(d.startWorkflow).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/run-action-sweep: the sweep", () => {
  it("with no worker configured it logs exactly 'run actions: worker not configured' and returns 200", async () => {
    const d = deps();
    const res = await runActionSweepHandler(requestWithAuth(`Bearer ${SECRET}`), d.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: false, started: 0 });
    expect(d.log.mock.calls).toEqual([["run actions: worker not configured"]]);
    expect(d.startWorkflow).not.toHaveBeenCalled();
  });

  it("with a worker it lists, starts one workflow per id and purges", async () => {
    const worker = fakeWorker(["a", "b"]);
    const d = deps({ getWorker: async () => worker });
    const res = await runActionSweepHandler(requestWithAuth(`Bearer ${SECRET}`), d.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, listed: 2, started: 2, purged: 0 });
    expect(d.startWorkflow.mock.calls).toEqual([["a"], ["b"]]);
    expect(worker.listDueRunActions).toHaveBeenCalledWith(30, 100);
    expect(worker.purgeRunActions).toHaveBeenCalledWith(7_776_000, 1000);
    expect(d.log).not.toHaveBeenCalled();
  });
});
