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
    expect(res.body).toEqual({ ok: true, config: "ok", planData: "ok", outside_meter: "off", deploy_env: null });
    expect(res.cache).toBe("no-store");
  });

  it("reports outside_meter on only for exactly 'on'; unset or anything else is off, and no value is echoed", async () => {
    for (const [v, want] of [["on", "on"], [undefined, "off"], ["", "off"], ["off", "off"], ["ON", "off"], ["1", "off"], ["true", "off"], ["on ", "off"]] as const) {
      const res = await call({ ...completeEnv("production"), FX_OUTSIDE_METER: v });
      expect(res.body.outside_meter, String(v)).toBe(want);
    }
    expect(JSON.stringify((await call({ FX_OUTSIDE_METER: "on" })).body)).not.toContain("FX_OUTSIDE_METER");
  });

  it("reports planData missing, without any value, when FX_PLAN_DATA is unset; the verdict itself is unchanged", async () => {
    const saved = process.env.FX_PLAN_DATA;
    try {
      delete process.env.FX_PLAN_DATA;
      resetPlanDataCache();
      const res = await call(completeEnv("production"));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, config: "ok", planData: "missing", outside_meter: "off", deploy_env: null });
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
    expect(res.body).toEqual({ ok: false, config: "incomplete", planData: "ok", outside_meter: "off", deploy_env: null });
    expect(JSON.stringify(res.body)).not.toContain("FX_CURSOR_KEY");
  });

  it("gives an anonymous caller nothing more when the bearer token is wrong, blank, or the wrong scheme", async () => {
    const env: Env = { ...completeEnv("staging"), CRON_SECRET: OPERATOR_SECRET };
    delete env.FX_CURSOR_KEY_V1;
    for (const auth of [bearer("wrong"), bearer(""), OPERATOR_SECRET, `Basic ${OPERATOR_SECRET}`, bearer(`${OPERATOR_SECRET}x`)]) {
      expect((await call(env, auth)).body, auth).toEqual({ ok: false, config: "incomplete", planData: "ok", outside_meter: "off", deploy_env: null });
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

  describe("deployment identity", () => {
    const ids = { VERCEL_PROJECT_ID: "prj_StagingAbc123", VERCEL_GIT_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567" };

    it("on staging gives deploy_env, project_id and commit, to an anonymous caller too", async () => {
      const res = await call({ ...completeEnv("staging"), FX_DEPLOY_ENV: "staging", ...ids });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, config: "ok", planData: "ok", outside_meter: "off", deploy_env: "staging", project_id: ids.VERCEL_PROJECT_ID, commit: ids.VERCEL_GIT_COMMIT_SHA });
    });

    it("on staging reports a field Vercel did not set as null, so a reader can fail closed", async () => {
      const res = await call({ ...completeEnv("staging"), FX_DEPLOY_ENV: "staging" });
      expect(res.body).toMatchObject({ deploy_env: "staging", project_id: null, commit: null });
    });

    it("on production gives deploy_env only: no project id and no commit, even when the platform sets them", async () => {
      const res = await call({ ...completeEnv("production"), FX_DEPLOY_ENV: "production", ...ids });
      expect(res.body).toEqual({ ok: true, config: "ok", planData: "ok", outside_meter: "off", deploy_env: "production" });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(ids.VERCEL_PROJECT_ID);
      expect(text).not.toContain(ids.VERCEL_GIT_COMMIT_SHA);
    });

    it("anywhere else (unset, blank, another value, wrong case) gives no project id or commit, and the operator detail does not add them", async () => {
      for (const value of [undefined, "", "local", "Staging", "staging "]) {
        const env: Env = { ...completeEnv("production"), CRON_SECRET: OPERATOR_SECRET, FX_DEPLOY_ENV: value, ...ids };
        for (const auth of [null, bearer(OPERATOR_SECRET)]) {
          const body = (await call(env, auth)).body;
          expect(body, String(value)).not.toHaveProperty("project_id");
          expect(body, String(value)).not.toHaveProperty("commit");
          expect(body.deploy_env, String(value)).toBe(value === undefined || value === "" ? null : value);
        }
      }
    });

    it("the operator on staging gets the identity next to the detail", async () => {
      const res = await call({ ...completeEnv("staging"), CRON_SECRET: OPERATOR_SECRET, FX_DEPLOY_ENV: "staging", ...ids }, bearer(OPERATOR_SECRET));
      expect(res.body).toMatchObject({ deploy_env: "staging", project_id: ids.VERCEL_PROJECT_ID, deploy_kind: "staging" });
    });

    it("the route reads the three variables from the live environment", async () => {
      for (const [key, value] of Object.entries({ ...completeEnv("staging"), FX_DEPLOY_ENV: "staging", ...ids })) vi.stubEnv(key, value);
      expect(await GET(new NextRequest("https://example.test/api/health")).json()).toMatchObject({ deploy_env: "staging", project_id: ids.VERCEL_PROJECT_ID, commit: ids.VERCEL_GIT_COMMIT_SHA });
      vi.stubEnv("FX_DEPLOY_ENV", "production");
      expect(Object.keys((await GET(new NextRequest("https://example.test/api/health")).json()) as Record<string, unknown>).sort()).toEqual(["config", "deploy_env", "ok", "outside_meter", "planData"]);
    });
  });

  it("the route reads the live environment and the Authorization header", async () => {
    for (const [key, value] of Object.entries({ ...completeEnv("staging"), CRON_SECRET: OPERATOR_SECRET })) vi.stubEnv(key, value);
    vi.stubEnv("FX_CURSOR_KEY_V1", "");
    const anonymous = GET(new NextRequest("https://example.test/api/health"));
    expect(anonymous.status).toBe(503);
    expect(await anonymous.json()).toEqual({ ok: false, config: "incomplete", planData: "ok", outside_meter: "off", deploy_env: null });
    const operator = GET(new NextRequest("https://example.test/api/health", { headers: { authorization: bearer(OPERATOR_SECRET) } }));
    expect(await operator.json()).toMatchObject({ missing: ["FX_CURSOR_KEY_V1"] });
  });
});
