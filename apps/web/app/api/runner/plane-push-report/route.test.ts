import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { PLANE_PUSH_REPORT_PATH } from "@fulcrumaxe/runner-protocol";
import { MAX_BODY_BYTES } from "@fx/runner-cloud";
import { runnerDeps } from "../../../../lib/runnerRoutes";
import { planePushReportHandler } from "./handler";
import * as route from "./route";

const ORIGIN = "https://runner.example.test";
const RUN = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";

/**
 * D#598 P1f-2: the edge of POST /api/runner/plane-push-report. The decisions (fence, rows, the single grant, the check against GitHub) are in packages/runner-cloud
 * and packages/worker, with their own suites; what is pinned here is that this route is wired to them and nothing else: POST only, the runner
 * door, the 256 KiB cap, and the worker methods and GitHub access the runner deps hand over.
 */
describe("POST /api/runner/plane-push-report", () => {
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

  const post = (body: string | Blob = JSON.stringify({ run_id: RUN, lease_generation: 1, phase: "scanning" }), headers: Record<string, string> = {}) =>
    new NextRequest(`${ORIGIN}${PLANE_PUSH_REPORT_PATH}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  it("exports POST only, on the node runtime, never cached", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "runtime"]);
    expect(route.POST).toBe(planePushReportHandler);
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
  });

  it("answers an unsigned request 401 without a query, even with a session cookie or a bearer token", async () => {
    expect((await planePushReportHandler(post())).status).toBe(401);
    const res = await planePushReportHandler(post(undefined, { cookie: "fx_session=abc", authorization: "Bearer fxat_notarealtoken" }));
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toMatch(/eyJ/);
  });

  it("answers a body over 256 KiB 413 before anything else", async () => {
    expect((await planePushReportHandler(post(new Blob([Buffer.alloc(MAX_BODY_BYTES + 10)])))).status).toBe(413);
  });

  it("the runner deps hand the worker's four methods and the GitHub access to the route", () => {
    const deps = runnerDeps();
    for (const method of ["planePushGrant", "planePushSettleGrant", "planePushReportContext", "planePushRecordReport"] as const) expect(typeof deps.leases![method]).toBe("function");
    expect(typeof deps.planePush!.mintToken).toBe("function");
    expect(typeof deps.planePush!.verifyPushed).toBe("function");
    expect(typeof deps.planePush!.verifyPullRequest).toBe("function");
  });
});
