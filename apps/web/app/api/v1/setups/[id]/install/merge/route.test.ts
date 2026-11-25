import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import * as merge from "./route";
import { mergeInstallHandler } from "./handler";
import * as summary from "../summary/route";
import { installSummaryHandler } from "../summary/handler";

const ORIGIN = "https://app.example.test";
const SETUP = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const SIGNATURE = { "signature-input": 'sig1=();keyid="x"', signature: "sig1=:AAAA:" };

/**
 * D#845 ON-20a: the edge of POST /api/v1/setups/:id/install/merge and GET .../install/summary. Each takes one method on the node runtime, never cached, and only a session: no cookie, an API token and a
 * runner's signature are all 401 and reach nothing (the owner-or-admin check and the rest are in the runner-cloud pg suite).
 */
describe("the install merge and summary routes", () => {
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
  const call = (method: string, tail: string, headers: Record<string, string> = {}) => new NextRequest(`${ORIGIN}/api/v1/setups/${SETUP}/install/${tail}`, { method, headers });
  const params = { params: Promise.resolve({ id: SETUP }) };

  it("export one method each, on the node runtime, never cached", () => {
    expect(Object.keys(merge).sort()).toEqual(["POST", "dynamic", "runtime"]);
    expect(Object.keys(summary).sort()).toEqual(["GET", "dynamic", "runtime"]);
    for (const r of [merge, summary]) {
      expect(r.runtime).toBe("nodejs");
      expect(r.dynamic).toBe("force-dynamic");
    }
  });

  it("answer 401 without a session, even with an API token or a runner signature", async () => {
    const heads: Array<Record<string, string>> = [{}, { authorization: "Bearer fxat_notarealtoken" }, SIGNATURE];
    for (const headers of heads) {
      expect((await mergeInstallHandler(call("POST", "merge", headers), SETUP)).status, JSON.stringify(headers)).toBe(401);
      expect((await installSummaryHandler(call("GET", "summary", headers), SETUP)).status, JSON.stringify(headers)).toBe(401);
    }
    expect((await merge.POST(call("POST", "merge"), params)).status).toBe(401);
    expect((await summary.GET(call("GET", "summary"), params)).status).toBe(401);
  });
});
