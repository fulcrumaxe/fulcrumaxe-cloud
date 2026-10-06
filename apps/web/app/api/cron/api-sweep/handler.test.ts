import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SweepSummary } from "@fx/webhooks";
import { apiSweepHandler, notYetImplementedSender, type ApiSweepHandlerDeps } from "./handler";

/**
 * D#31 API-4a criterion 12: route-layer auth test only, matching
 * apps/web/app/api/github/webhook/handler.test.ts's own pattern -- no real
 * Postgres here, a fake `runSweepFn` in its place. The real sweep logic
 * (fan-out/claim/purge/auto-disable) is packages/webhooks's own real-
 * Postgres suite (test/sweep.test.ts).
 */
const SECRET = "test-cron-secret";

function fakeDeps(overrides: Partial<ApiSweepHandlerDeps> = {}): ApiSweepHandlerDeps {
  return { cronSecret: SECRET, platformOpsPool: {} as never, sender: notYetImplementedSender, ...overrides };
}

function requestWithAuth(authorization: string | null): NextRequest {
  const headers = new Headers();
  if (authorization !== null) headers.set("authorization", authorization);
  return new NextRequest("https://example.test/api/cron/api-sweep", { method: "GET", headers });
}

/** A stand-in request: a real NextRequest trims "Bearer " to "Bearer", so only this reaches the empty-secret guard. */
function rawAuthRequest(authorization: string): NextRequest {
  return { headers: { get: (name: string) => (name.toLowerCase() === "authorization" ? authorization : null) } } as unknown as NextRequest;
}

const fakeSummary: SweepSummary = {
  fanOut: { eventsProcessed: 0, deliveriesCreated: 0 },
  sent: { claimed: 0, succeeded: 0, failed: 0, dead: 0 },
  disabledEndpoints: [],
  purged: {},
};

describe("GET /api/cron/api-sweep", () => {
  it("401s with no Authorization header at all", async () => {
    const runSweepFn = vi.fn();
    const res = await apiSweepHandler(requestWithAuth(null), fakeDeps(), runSweepFn);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expect(runSweepFn).not.toHaveBeenCalled();
  });

  it("401s with a wrong secret", async () => {
    const runSweepFn = vi.fn();
    const res = await apiSweepHandler(requestWithAuth("Bearer wrong-secret"), fakeDeps(), runSweepFn);
    expect(res.status).toBe(401);
    expect(runSweepFn).not.toHaveBeenCalled();
  });

  it("401s with a customer API token -- tokens are ignored outside /api/v1", async () => {
    const runSweepFn = vi.fn();
    const res = await apiSweepHandler(requestWithAuth("Bearer fxat_notarealcronsecretatall000000000000000"), fakeDeps(), runSweepFn);
    expect(res.status).toBe(401);
    expect(runSweepFn).not.toHaveBeenCalled();
  });

  it("401s when CRON_SECRET is not configured, even with a matching-looking header", async () => {
    const runSweepFn = vi.fn();
    const res = await apiSweepHandler(requestWithAuth("Bearer "), fakeDeps({ cronSecret: "" }), runSweepFn);
    expect(res.status).toBe(401);
    expect(runSweepFn).not.toHaveBeenCalled();
  });

  it("runs the sweep and returns 200 with its summary when the secret matches exactly", async () => {
    const runSweepFn = vi.fn(async () => fakeSummary);
    const deps = fakeDeps();
    const res = await apiSweepHandler(requestWithAuth(`Bearer ${SECRET}`), deps, runSweepFn);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(fakeSummary);
    expect(runSweepFn).toHaveBeenCalledWith(deps.platformOpsPool, deps.sender);
  });
});

describe("GET /api/cron/api-sweep: the secret guard itself", () => {
  it.each([
    ["an empty", ""],
    ["an unset", undefined as unknown as string],
  ])("401s with %s CRON_SECRET and the untrimmed header 'Bearer ', running no sweep", async (_name, secret) => {
    const req = rawAuthRequest("Bearer ");
    expect(req.headers.get("authorization")).toHaveLength(7);
    const runSweepFn = vi.fn();
    const res = await apiSweepHandler(req, fakeDeps({ cronSecret: secret }), runSweepFn);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expect(runSweepFn).not.toHaveBeenCalled();
  });

  it.each([
    ["first", `X${SECRET.slice(1)}`],
    ["last", `${SECRET.slice(0, -1)}X`],
  ])("401s a wrong secret of the right length that differs in its %s byte", async (_name, wrong) => {
    expect(wrong).toHaveLength(SECRET.length);
    expect(wrong).not.toBe(SECRET);
    const runSweepFn = vi.fn();
    const res = await apiSweepHandler(requestWithAuth(`Bearer ${wrong}`), fakeDeps(), runSweepFn);
    expect(res.status).toBe(401);
    expect(runSweepFn).not.toHaveBeenCalled();
  });
});
