import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { setupPlanPath } from "@fulcrumaxe/runner-protocol";
import { setupPlanHandler } from "./handler";
import * as route from "./route";

const ORIGIN = "https://runner.example.test";
const SETUP = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";

/** D#845 ON-8b: the edge of GET /api/runner/setup/:setup_id/plan. The decisions are in packages/runner-cloud (pg suite); here: GET only, the runner door (a signature, no session), the query shape. */
describe("GET /api/runner/setup/:setup_id/plan", () => {
  const KEYS = ["DATABASE_URL_PLATFORM_OPS", "DATABASE_URL_APP_USER", "FX_APP_ORIGIN"] as const;
  const saved = KEYS.map((key) => [key, process.env[key]] as const);
  beforeAll(() => {
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
  const get = (path: string, headers: Record<string, string> = {}) => new NextRequest(`${ORIGIN}${path}`, { method: "GET", headers });

  it("exports GET only, on the node runtime, never cached", async () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "runtime"]);
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect((await route.GET(get(setupPlanPath(SETUP, 1)), { params: Promise.resolve({ setup_id: SETUP }) })).status).toBe(401);
  });

  it("answers an unsigned request 401 whatever the id, even with a session cookie or a bearer token, and a malformed query 400", async () => {
    expect((await setupPlanHandler(get(setupPlanPath(SETUP, 1)), SETUP)).status).toBe(401);
    expect((await setupPlanHandler(get(setupPlanPath("not-an-id", 1)), "not-an-id")).status).toBe(401);
    expect((await setupPlanHandler(get(setupPlanPath(SETUP, 1), { cookie: "fx_session=abc", authorization: "Bearer fxat_notarealtoken" }), SETUP)).status).toBe(401);
    expect((await setupPlanHandler(get(`/api/runner/setup/${SETUP}/plan`), SETUP)).status).toBe(400);
    expect((await setupPlanHandler(get(`/api/runner/setup/${SETUP}/plan?version=0`), SETUP)).status).toBe(400);
  });
});
