import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { PLANE_PUSH_PAIRING_PATH } from "@fulcrumaxe/runner-protocol";
import { MAX_BODY_BYTES } from "@fx/runner-cloud";
import { runnerDeps } from "../../../../lib/runnerRoutes";
import { planePushPairingHandler } from "./handler";
import * as route from "./route";

const ORIGIN = "https://runner.example.test";
const RUN = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";

/**
 * D#598 P1f-2b: the edge of POST /api/runner/plane-push-pairing. The decisions (fence, rows, the single grant, the check against GitHub) are in packages/runner-cloud
 * and packages/worker, with their own suites; what is pinned here is that this route is wired to them and nothing else: POST only, the runner
 * door, the 256 KiB cap, and the worker methods and GitHub access the runner deps hand over.
 */
describe("POST /api/runner/plane-push-pairing", () => {
  const KEYS = ["DATABASE_URL_PLATFORM_OPS", "DATABASE_URL_APP_USER", "FX_APP_ORIGIN"] as const;
  const saved = KEYS.map((key) => [key, process.env[key]] as const);
  beforeAll(() => {
    // Pools connect lazily; none of these requests reaches a query.
    process.env.DATABASE_URL_PLATFORM_OPS = "postgres://unused:unused@127.0.0.1:1/unused";
    process.env.DATABASE_URL_APP_USER = "postgres://unused:unused@127.0.0.1:1/unused";
    process.env.FX_APP_ORIGIN = ORIGIN;
  });
  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const post = (body: string | Blob = JSON.stringify({ run_id: RUN, lease_generation: 1 }), headers: Record<string, string> = {}) =>
    new NextRequest(`${ORIGIN}${PLANE_PUSH_PAIRING_PATH}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  it("exports POST only, on the node runtime, never cached", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "runtime"]);
    expect(route.POST).toBe(planePushPairingHandler);
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
  });

  it("answers an unsigned request 401 without a query, even with a session cookie or a bearer token", async () => {
    expect((await planePushPairingHandler(post())).status).toBe(401);
    const res = await planePushPairingHandler(post(undefined, { cookie: "fx_session=abc", authorization: "Bearer fxat_notarealtoken" }));
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toMatch(/eyJ/);
  });

  it("answers a body over 256 KiB 413 before anything else", async () => {
    expect((await planePushPairingHandler(post(new Blob([Buffer.alloc(MAX_BODY_BYTES + 10)])))).status).toBe(413);
  });

  it("the runner deps hand the pairing method to the route, and the route is read-only: it is given no GitHub access to use and no identity to read", () => {
    const deps = runnerDeps();
    expect(typeof deps.leases!.planePushPairing).toBe("function");
    // The route function itself never touches the GitHub port or the identity reader (see packages/runner-cloud/test/planePush.pg.test.ts for the
    // call record); here we pin only that the deps carry the pairing method next to the others.
    for (const method of ["planePushGrant", "planePushSettleGrant", "planePushReportContext", "planePushRecordReport"] as const) expect(typeof deps.leases![method]).toBe("function");
  });

  it("the identity reader is wired to the two settings and reads them on every call", () => {
    const keys = ["FX_PLANE_PUSH_IDENTITY_NAME", "FX_PLANE_PUSH_IDENTITY_EMAIL"] as const;
    const was = keys.map((key) => [key, process.env[key]] as const);
    try {
      for (const key of keys) delete process.env[key];
      expect(runnerDeps().planePushIdentity!()).toBeNull();
      process.env.FX_PLANE_PUSH_IDENTITY_NAME = "Fulcrumaxe Bot";
      process.env.FX_PLANE_PUSH_IDENTITY_EMAIL = "bot@example.com";
      expect(runnerDeps().planePushIdentity!()).toEqual({ name: "Fulcrumaxe Bot", email: "bot@example.com" });
      process.env.FX_PLANE_PUSH_IDENTITY_EMAIL = "not an email";
      expect(runnerDeps().planePushIdentity!()).toBeNull();
    } finally {
      for (const [key, value] of was) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
