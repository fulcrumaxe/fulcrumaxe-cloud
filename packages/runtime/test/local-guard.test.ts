import { afterEach, describe, expect, it } from "vitest";
import { LocalRunnerRefused } from "../src/types.js";
import { createLocalRuntime } from "../src/local/index.js";

// FX_RUNTIME=local baked in so every test below isolates the check it's
// actually about — the opt-in requirement (fix-round 2 item 4) is tested
// separately, with FX_RUNTIME deliberately absent, further down.
const CLEAN_ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin", FX_RUNTIME: "local" };

describe("local runner refusal (Spec H04 pass/fail 1)", () => {
  it.each(["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_REGION"] as const)(
    "refuses to construct when %s is set",
    (key) => {
      expect(() => createLocalRuntime({ ...CLEAN_ENV, [key]: "1" })).toThrow(LocalRunnerRefused);
    },
  );

  it("refuses to construct when NODE_ENV=production", () => {
    expect(() => createLocalRuntime({ ...CLEAN_ENV, NODE_ENV: "production" })).toThrow(
      LocalRunnerRefused,
    );
  });

  it("constructs on a clean, non-Vercel, non-production env with FX_RUNTIME=local", () => {
    expect(() => createLocalRuntime({ ...CLEAN_ENV, NODE_ENV: "development" })).not.toThrow();
  });

  it("an empty-string Vercel var does not refuse construction", () => {
    // A var present but set to "" is how some shells clear an inherited
    // value — treat it the same as unset, not as "present".
    expect(() => createLocalRuntime({ ...CLEAN_ENV, VERCEL: "" })).not.toThrow();
  });
});

describe("local runner refusal is broader than four exact names (Spec H04 fix-round 1 item 3, CWE-693)", () => {
  it.each(["VERCEL_DEPLOYMENT_ID", "VERCEL_TARGET_ENV", "VERCEL_ANYTHING_FUTURE"] as const)(
    "refuses to construct when %s alone is set, even though it isn't one of the four documented names",
    (key) => {
      expect(() => createLocalRuntime({ ...CLEAN_ENV, [key]: "1" })).toThrow(LocalRunnerRefused);
    },
  );

  it.each(["Production", "PRODUCTION", " production", "production "] as const)(
    "refuses to construct when NODE_ENV=%j (case/whitespace variants)",
    (value) => {
      expect(() => createLocalRuntime({ ...CLEAN_ENV, NODE_ENV: value })).toThrow(LocalRunnerRefused);
    },
  );

  it("does not refuse a NODE_ENV that merely contains 'production' as a substring", () => {
    // "production-like" is not "production" — an exact (trimmed, lowercased)
    // match only, not a substring scan, so a custom env name doesn't
    // accidentally trip the guard.
    expect(() => createLocalRuntime({ ...CLEAN_ENV, NODE_ENV: "production-like" })).not.toThrow();
  });
});

describe("Vercel CLI auth/link vars never trip the guard (regression: real dev shell has these set)", () => {
  it.each(["VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "VERCEL_TOKEN"] as const)(
    "%s alone does not refuse construction",
    (key) => {
      expect(() => createLocalRuntime({ ...CLEAN_ENV, [key]: "some-value" })).not.toThrow();
    },
  );

  it("all three CLI vars together still do not refuse construction", () => {
    expect(() =>
      createLocalRuntime({
        ...CLEAN_ENV,
        VERCEL_ORG_ID: "team_x",
        VERCEL_PROJECT_ID: "prj_y",
        VERCEL_TOKEN: "vcp_z",
      }),
    ).not.toThrow();
  });

  it("a genuine runtime var (VERCEL_DEPLOYMENT_ID) alongside the CLI vars still refuses", () => {
    expect(() =>
      createLocalRuntime({
        ...CLEAN_ENV,
        VERCEL_ORG_ID: "team_x",
        VERCEL_PROJECT_ID: "prj_y",
        VERCEL_TOKEN: "vcp_z",
        VERCEL_DEPLOYMENT_ID: "dpl_z",
      }),
    ).toThrow(LocalRunnerRefused);
  });
});

describe("local runner refusal also checks the real process.env (Spec H04 fix-round 1 item 3)", () => {
  const originalVercel = process.env.VERCEL;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFxRuntime = process.env.FX_RUNTIME;

  afterEach(() => {
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalFxRuntime === undefined) delete process.env.FX_RUNTIME;
    else process.env.FX_RUNTIME = originalFxRuntime;
  });

  it("createLocalRuntime({}) still refuses when process.env.VERCEL is set", () => {
    process.env.VERCEL = "1";
    expect(() => createLocalRuntime({})).toThrow(LocalRunnerRefused);
  });

  it("createLocalRuntime({}) still refuses when process.env.NODE_ENV=production", () => {
    process.env.NODE_ENV = "production";
    expect(() => createLocalRuntime({})).toThrow(LocalRunnerRefused);
  });

  it("an explicit clean env passed in does not shadow a deployed process.env", () => {
    process.env.VERCEL = "1";
    // Even a caller that builds a deliberately "clean-looking" env object
    // cannot use it to dodge the check — the real process is still deployed.
    expect(() => createLocalRuntime({ NODE_ENV: "development", FX_RUNTIME: "local" })).toThrow(
      LocalRunnerRefused,
    );
  });
});

/**
 * Spec H04 fix-round 2 item 4: an explicit opt-in (`FX_RUNTIME=local`) is
 * now REQUIRED in addition to passing the deployed-environment checks — the
 * deny-list above can miss a real deployment (Vercel's System Environment
 * Variables are opt-in per project setting), so the local runner must not
 * rely on that deny-list as its only gate. At 7262dd9 (before this fix),
 * `createLocalRuntime({ PATH: "/usr/bin" })` — a plain clean env, no
 * FX_RUNTIME at all — constructed successfully; every test below is red
 * against that commit and green after.
 */
describe("local runner requires an explicit FX_RUNTIME=local opt-in (Spec H04 fix-round 2 item 4)", () => {
  const originalFxRuntime = process.env.FX_RUNTIME;

  afterEach(() => {
    if (originalFxRuntime === undefined) delete process.env.FX_RUNTIME;
    else process.env.FX_RUNTIME = originalFxRuntime;
  });

  it("refuses a clean, non-deployed env when FX_RUNTIME=local was never set anywhere", () => {
    delete process.env.FX_RUNTIME;
    expect(() => createLocalRuntime({ PATH: "/usr/bin" })).toThrow(LocalRunnerRefused);
  });

  it("the refusal reason names the opt-in requirement specifically, not a deployed-environment reason", () => {
    delete process.env.FX_RUNTIME;
    expect(() => createLocalRuntime({ PATH: "/usr/bin" })).toThrow(/FX_RUNTIME=local/);
  });

  it("FX_RUNTIME=production (present, but not 'local') still refuses", () => {
    delete process.env.FX_RUNTIME;
    expect(() => createLocalRuntime({ PATH: "/usr/bin", FX_RUNTIME: "production" })).toThrow(
      LocalRunnerRefused,
    );
  });

  it("succeeds when FX_RUNTIME=local is set on the passed env", () => {
    delete process.env.FX_RUNTIME;
    expect(() => createLocalRuntime({ PATH: "/usr/bin", FX_RUNTIME: "local" })).not.toThrow();
  });

  it("succeeds via process.env fallback when the passed env omits FX_RUNTIME", () => {
    process.env.FX_RUNTIME = "local";
    expect(() => createLocalRuntime({ PATH: "/usr/bin" })).not.toThrow();
  });

  it("the deployed-environment check still runs first: VERCEL=1 refuses even with FX_RUNTIME=local", () => {
    expect(() =>
      createLocalRuntime({ PATH: "/usr/bin", FX_RUNTIME: "local", VERCEL: "1" }),
    ).toThrow(/is set/);
  });
});
