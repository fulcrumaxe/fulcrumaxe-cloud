import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { machineLoginCodePath } from "@fulcrumaxe/runner-protocol";
import { machineLoginCodeHandler } from "./handler";
import * as route from "./route";

const ORIGIN = "https://runner.example.test";
const REQUEST = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";

/**
 * D#845 MC-8a: the edge of GET /api/runner/machine-login/:request_id/code. The decisions (the states, the seal, the one-time take) are in packages/runner-cloud with a pg suite; what is pinned here is that
 * this route is wired to them and nothing else: GET only, the runner door (a signature, no session), and the 256 KiB cap.
 */
describe("GET /api/runner/machine-login/:request_id/code", () => {
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

  const call = (payload?: string | Blob, headers: Record<string, string> = {}) =>
    new NextRequest(`${ORIGIN}${machineLoginCodePath(REQUEST)}`, { method: "GET", headers: { "content-type": "application/json", ...headers }, ...(payload === undefined ? {} : { body: payload }) });

  it("exports GET only, on the node runtime, never cached", async () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "runtime"]);
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect((await route.GET(call(), { params: Promise.resolve({ request_id: REQUEST }) })).status).toBe(401);
  });

  it("answers an unsigned request 401 without a query, even with a session cookie or a bearer token, and whatever the id", async () => {
    expect((await machineLoginCodeHandler(call(), REQUEST)).status).toBe(401);
    expect((await machineLoginCodeHandler(call(), "not-an-id")).status).toBe(401);
    const res = await machineLoginCodeHandler(call(undefined, { cookie: "fx_session=abc", authorization: "Bearer fxat_notarealtoken" }), REQUEST);
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toMatch(/eyJ/);
  });
});
