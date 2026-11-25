import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import * as route from "./route";
import * as actionRoute from "./[action]/route";
import { draftHandler } from "./handler";

const ORIGIN = "https://app.example.test";
const SETUP = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";

/** D#845 ON-11a: the edge of the plan draft routes: the methods, and a session is required (no cookie, a bearer token and a runner signature are all 401). The statuses past the session are in the runner-cloud pg suite. */
describe("/api/v1/setups/:id/draft", () => {
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
  const req = (method: string, path = "", headers: Record<string, string> = {}) => new NextRequest(`${ORIGIN}/api/v1/setups/${SETUP}/draft${path}`, { method, headers });

  it("exports GET and PUT, and POST on the action route, on the node runtime, never cached", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "PUT", "dynamic", "runtime"]);
    expect(Object.keys(actionRoute).sort()).toEqual(["POST", "dynamic", "runtime"]);
    for (const r of [route, actionRoute]) expect([r.runtime, r.dynamic]).toEqual(["nodejs", "force-dynamic"]);
  });

  it("answers 401 without a session on every route, even with an API token or a runner signature", async () => {
    const forged: Array<Record<string, string>> = [{}, { authorization: "Bearer fxat_notarealtoken" }, { "signature-input": 'sig1=();keyid="x"', signature: "sig1=:AAAA:" }];
    for (const headers of forged) {
      expect((await draftHandler(req("GET", "", headers), SETUP, null)).status).toBe(401);
      expect((await draftHandler(req("PUT", "", headers), SETUP, null)).status).toBe(401);
      for (const action of ["approve", "discard", "blank", "restart"]) expect((await draftHandler(req("POST", `/${action}`, headers), SETUP, action)).status).toBe(401);
    }
    expect((await route.GET(req("GET"), { params: Promise.resolve({ id: SETUP }) })).status).toBe(401);
    expect((await actionRoute.POST(req("POST", "/approve"), { params: Promise.resolve({ id: SETUP, action: "approve" }) })).status).toBe(401);
  });
});
