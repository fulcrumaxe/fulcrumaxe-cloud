import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPlanDataCache } from "@fx/plan-data";
import { completeEnv } from "../../../test/support/envFixtures";
import { healthResponse } from "./handler";
import { GET } from "./route";

const OPERATOR_SECRET = "operator-secret-0123456789-abcdefghij";
const bearer = (secret: string) => `Bearer ${secret}`;
type Env = Record<string, string | undefined>;

async function call(env: Env, auth: string | null = null) {
  const res = healthResponse(env, auth);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cache: res.headers.get("cache-control") };
}

describe("GET /api/health", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("answers 200 {ok:true,config:ok} when nothing is required (local)", async () => {
    expect(await call({})).toMatchObject({ status: 200, body: { ok: true, config: "ok" } });
  });

  it("answers 200 for a complete production environment, with no detail for an anonymous caller", async () => {
    const res = await call(completeEnv("production"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, config: "ok", planData: "ok" });
    expect(res.cache).toBe("no-store");
  });

  it("reports planData missing, without any value, when FX_PLAN_DATA is unset; the verdict itself is unchanged", async () => {
    const saved = process.env.FX_PLAN_DATA;
    try {
      delete process.env.FX_PLAN_DATA;
      resetPlanDataCache();
      const res = await call(completeEnv("production"));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, config: "ok", planData: "missing" });
      expect(JSON.stringify(res.body)).not.toContain("FX_PLAN_DATA");
    } finally {
      if (saved !== undefined) process.env.FX_PLAN_DATA = saved;
      resetPlanDataCache();
    }
  });

  it("answers 503 when a required setting is missing, and names nothing to an anonymous caller", async () => {
    const env: Env = completeEnv("staging");
    delete env.FX_CURSOR_KEY_V1;
    const res = await call(env);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, config: "incomplete", planData: "ok" });
    expect(JSON.stringify(res.body)).not.toContain("FX_CURSOR_KEY");
  });

  it("gives an anonymous caller nothing more when the bearer token is wrong, blank, or the wrong scheme", async () => {
    const env: Env = { ...completeEnv("staging"), CRON_SECRET: OPERATOR_SECRET };
    delete env.FX_CURSOR_KEY_V1;
    for (const auth of [bearer("wrong"), bearer(""), OPERATOR_SECRET, `Basic ${OPERATOR_SECRET}`, bearer(`${OPERATOR_SECRET}x`)]) {
      expect((await call(env, auth)).body, auth).toEqual({ ok: false, config: "incomplete", planData: "ok" });
    }
  });

  it("gives the operator the missing and invalid names, by name and fixed reason", async () => {
    const env: Env = { ...completeEnv("staging"), CRON_SECRET: OPERATOR_SECRET, FX_KEK_V1: "short-and-not-base64" };
    delete env.FX_CURSOR_KEY_V1;
    const res = await call(env, bearer(OPERATOR_SECRET));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      ok: false,
      config: "incomplete",
      deploy_kind: "staging",
      missing: ["FX_CURSOR_KEY_V1"],
      invalid: [{ name: "FX_KEK_V1", reason: "not_base64_32_bytes" }],
    });
  });

  it("reports a cron secret under 32 characters as invalid, by reason only, to the caller holding it", async () => {
    const shortSecret = "short-cron-secret-20";
    const env: Env = { ...completeEnv("staging"), CRON_SECRET: shortSecret };
    const anonymous = await call(env);
    expect(anonymous).toMatchObject({ status: 503, body: { ok: false, config: "incomplete" } });
    expect(JSON.stringify(anonymous.body)).not.toContain("CRON_SECRET");
    const operator = await call(env, bearer(shortSecret));
    expect(operator.status).toBe(503);
    expect(operator.body).toMatchObject({ invalid: [{ name: "CRON_SECRET", reason: "shorter_than_32_chars" }] });
    expect(JSON.stringify(operator.body)).not.toContain(shortSecret);
    // Exactly 32 is long enough.
    expect(await call({ ...completeEnv("staging"), CRON_SECRET: "x".repeat(32) })).toMatchObject({ status: 200 });
  });

  it("reports optional features as disabled to the operator, with the 200 intact", async () => {
    const env = { ...completeEnv("production"), CRON_SECRET: OPERATOR_SECRET };
    const res = await call(env, bearer(OPERATOR_SECRET));
    expect(res.status).toBe(200);
    expect(res.body.disabled).toEqual(expect.arrayContaining([{ name: "FX_API_TOKENS_ENABLED", feature: "Public API tokens" }]));
    expect(res.body.missing).toEqual([]);
  });

  it("never puts a value in the response, for anyone", async () => {
    const wrongKey = "wrong-key-value-should-never-appear-0123456789";
    const env: Env = { ...completeEnv("production"), CRON_SECRET: OPERATOR_SECRET, FX_CURSOR_KEY_V1: wrongKey, FX_SESSION_SECRET: "short-session-value" };
    for (const auth of [null, bearer(OPERATOR_SECRET)]) {
      const text = JSON.stringify((await call(env, auth)).body);
      for (const value of [wrongKey, "short-session-value", OPERATOR_SECRET, completeEnv("production").DATABASE_URL_APP_USER as string]) expect(text).not.toContain(value);
    }
  });

  it("gives nobody detail while CRON_SECRET is unset (fail closed)", async () => {
    const env: Env = completeEnv("staging");
    delete env.CRON_SECRET;
    for (const auth of [null, bearer(""), "Bearer undefined", "Bearer "]) expect((await call(env, auth)).body, String(auth)).not.toHaveProperty("missing");
  });

  it("judges a Vercel Production deployment as production when FX_DEPLOY_KIND is unset", async () => {
    const res = await call({ VERCEL_ENV: "production", CRON_SECRET: OPERATOR_SECRET }, bearer(OPERATOR_SECRET));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ deploy_kind: "production" });
    expect(res.body.missing).toEqual(expect.arrayContaining(["FX_CURSOR_KEY_V1", "FX_SESSION_SECRET"]));
  });

  it("the route reads the live environment and the Authorization header", async () => {
    for (const [key, value] of Object.entries({ ...completeEnv("staging"), CRON_SECRET: OPERATOR_SECRET })) vi.stubEnv(key, value);
    vi.stubEnv("FX_CURSOR_KEY_V1", "");
    const anonymous = GET(new NextRequest("https://example.test/api/health"));
    expect(anonymous.status).toBe(503);
    expect(await anonymous.json()).toEqual({ ok: false, config: "incomplete", planData: "ok" });
    const operator = GET(new NextRequest("https://example.test/api/health", { headers: { authorization: bearer(OPERATOR_SECRET) } }));
    expect(await operator.json()).toMatchObject({ missing: ["FX_CURSOR_KEY_V1"] });
  });
});
