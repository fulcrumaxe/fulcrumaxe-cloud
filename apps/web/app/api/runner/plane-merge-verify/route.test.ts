import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { PLANE_MERGE_VERIFY_PATH } from "@fulcrumaxe/runner-protocol";
import { MAX_BODY_BYTES } from "@fx/runner-cloud";
import { runnerDeps } from "../../../../lib/runnerRoutes";
import { planeMergeVerifyHandler } from "./handler";
import * as route from "./route";

const ORIGIN = "https://runner.example.test";
const ORDER = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";

/**
 * D#6 PUBLIC-MERGE PR2b: the edge of POST /api/runner/plane-merge-verify. The decisions (fence, the order store, the gate, the single write grant, the check against
 * GitHub) are in packages/runner-cloud and packages/worker, with their own suites; what is pinned here is that this route is wired to them and nothing else: POST
 * only, the runner door (a signature, no session), the 256 KiB cap, and the merge-order access the runner deps hand over.
 */
describe("POST /api/runner/plane-merge-verify", () => {
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

  const post = (payload: string | Blob = JSON.stringify({ order_id: ORDER, lease_generation: 1 }), headers: Record<string, string> = {}) =>
    new NextRequest(`${ORIGIN}${PLANE_MERGE_VERIFY_PATH}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload });

  it("exports POST only, on the node runtime, never cached", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "runtime"]);
    expect(route.POST).toBe(planeMergeVerifyHandler);
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
  });

  it("answers an unsigned request 401 without a query, even with a session cookie or a bearer token", async () => {
    expect((await planeMergeVerifyHandler(post())).status).toBe(401);
    const res = await planeMergeVerifyHandler(post(undefined, { cookie: "fx_session=abc", authorization: "Bearer fxat_notarealtoken" }));
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toMatch(/eyJ/);
  });

  it("answers a body over 256 KiB 413 before anything else", async () => {
    expect((await planeMergeVerifyHandler(post(new Blob([Buffer.alloc(MAX_BODY_BYTES + 10)])))).status).toBe(413);
  });

  it("the runner deps hand the merge-order store, gate and GitHub access to the route", () => {
    const deps = runnerDeps();
    for (const method of ["claimNext", "grantReadToken", "fence", "authorize", "finish", "getById", "runnerTrusted"] as const) expect(typeof deps.planeMerge!.store[method]).toBe("function");
    for (const method of ["goPhase", "readPublicPull", "recordMerged"] as const) expect(typeof deps.planeMerge![method]).toBe("function");
    expect(typeof deps.planePush!.mintMergeToken).toBe("function");
    expect(typeof deps.planePush!.revokeToken).toBe("function");
  });
});
