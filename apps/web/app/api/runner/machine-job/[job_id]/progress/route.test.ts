import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { machineJobProgressPath } from "@fulcrumaxe/runner-protocol";
import { MAX_BODY_BYTES } from "@fx/runner-cloud";
import { machineJobProgressHandler } from "./handler";
import * as route from "./route";

const ORIGIN = "https://runner.example.test";
const JOB = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";

/**
 * D#845 ON-13a0: the edge of POST /api/runner/machine-job/:job_id/progress. The decisions (the fence, the sequence, the write, the replies) are in packages/runner-cloud with a pg suite; what is pinned here is that
 * this route is wired to them and nothing else: POST only, the runner door (a signature, no session), and the 256 KiB cap.
 */
describe("POST /api/runner/machine-job/:job_id/progress", () => {
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

  const post = (payload: string | Blob = JSON.stringify({}), headers: Record<string, string> = {}) =>
    new NextRequest(`${ORIGIN}${machineJobProgressPath(JOB)}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload });

  it("exports POST only, on the node runtime, never cached", async () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "runtime"]);
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect((await route.POST(post(), { params: Promise.resolve({ job_id: JOB }) })).status).toBe(401);
  });

  it("answers an unsigned request 401 without a query, even with a session cookie or a bearer token, and whatever the id", async () => {
    expect((await machineJobProgressHandler(post(), JOB)).status).toBe(401);
    expect((await machineJobProgressHandler(post(), "not-an-id")).status).toBe(401);
    const res = await machineJobProgressHandler(post(undefined, { cookie: "fx_session=abc", authorization: "Bearer fxat_notarealtoken" }), JOB);
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toMatch(/eyJ/);
  });

  it("answers a body over 256 KiB 413 before anything else", async () => {
    expect((await machineJobProgressHandler(post(new Blob([Buffer.alloc(MAX_BODY_BYTES + 10)])), JOB)).status).toBe(413);
  });
});
