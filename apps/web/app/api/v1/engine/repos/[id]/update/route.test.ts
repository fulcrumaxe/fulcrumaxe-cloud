import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import * as route from "./route";
import { updateEngineHandler } from "./handler";

const ORIGIN = "https://app.example.test";
const REPO = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";

/** D#845 ON-15a: the edge of POST /api/v1/engine/repos/:id/update: POST only, and a session is required (no cookie, a bearer token and a runner signature are all 401). The statuses past the session are in the runner-cloud pg suite. */
describe("POST /api/v1/engine/repos/:id/update", () => {
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
  const post = (headers: Record<string, string> = {}) => new NextRequest(`${ORIGIN}/api/v1/engine/repos/${REPO}/update`, { method: "POST", headers });

  it("exports POST only, on the node runtime, never cached", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "runtime"]);
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
  });

  it("answers 401 without a session, even with an API token or a runner signature", async () => {
    expect((await updateEngineHandler(post(), REPO)).status).toBe(401);
    expect((await updateEngineHandler(post({ authorization: "Bearer fxat_notarealtoken" }), REPO)).status).toBe(401);
    expect((await updateEngineHandler(post({ "signature-input": 'sig1=();keyid="x"', signature: "sig1=:AAAA:" }), REPO)).status).toBe(401);
    expect((await route.POST(post(), { params: Promise.resolve({ id: REPO }) })).status).toBe(401);
  });
});
