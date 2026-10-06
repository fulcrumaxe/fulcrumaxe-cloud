import { describe, expect, it } from "vitest";
import { buildConfig } from "../pw/config.js";
import { DEFAULT_WORKERS, MAX_WORKERS, resolveWorkers, TARGET_ENV_NAME, WORKERS_ENV_NAME } from "../src/limits.js";
import { PACKAGE_ROOT, TARGET_ENV } from "./helpers.js";

const cfg = (target: string, extra: Record<string, string> = {}) => buildConfig({ ...TARGET_ENV, [TARGET_ENV_NAME]: target, ...extra }, PACKAGE_ROOT);

describe("resolved config on live targets", () => {
  for (const target of ["staging", "production"]) {
    it(`${target}: trace and video off, no HAR, service workers blocked, base URL is the target origin`, () => {
      const config = cfg(target);
      expect(config.use?.trace).toBe("off");
      expect(config.use?.video).toBe("off");
      expect(config.use).not.toHaveProperty("recordHar");
      expect(config.use?.serviceWorkers).toBe("block");
      expect(config.use?.baseURL).toBe(TARGET_ENV[`LIVE_E2E_${target.toUpperCase()}_ORIGIN`]);
      for (const p of config.projects ?? []) {
        // A project must not turn any of it back on.
        expect(p.use ?? {}).not.toHaveProperty("trace");
        expect(p.use ?? {}).not.toHaveProperty("video");
        expect(p.use ?? {}).not.toHaveProperty("recordHar");
        expect(p.use ?? {}).not.toHaveProperty("serviceWorkers");
      }
    });
  }

  it("has the three device projects and no web server", () => {
    const config = cfg("staging");
    expect(config.projects?.map((p) => p.name)).toEqual(["desktop", "phone", "tablet"]);
    expect(config).not.toHaveProperty("webServer");
    expect(config.forbidOnly).toBe(true);
  });

  it("an environment variable cannot switch a recording on", () => {
    const config = cfg("staging", { PWTEST_TRACE: "on", LIVE_E2E_TRACE: "on", LIVE_E2E_VIDEO: "on" });
    expect(config.use?.trace).toBe("off");
    expect(config.use?.video).toBe("off");
  });

  it("fails naming the variable when the target or its address is not set", () => {
    expect(() => buildConfig({}, PACKAGE_ROOT)).toThrow(TARGET_ENV_NAME);
    expect(() => buildConfig({ [TARGET_ENV_NAME]: "staging" }, PACKAGE_ROOT)).toThrow("LIVE_E2E_STAGING_ORIGIN");
    expect(() => cfg("nowhere")).toThrow("unknown target");
  });
});

describe("workers are capped", () => {
  it("never exceeds MAX_WORKERS (4), whatever is asked", () => {
    expect(MAX_WORKERS).toBe(4);
    for (const raw of ["1", "2", "4", "5", "99", "1000000", "4.9", "Infinity"]) {
      const n = resolveWorkers(raw);
      expect(n, raw).toBeLessThanOrEqual(MAX_WORKERS);
      expect(n, raw).toBeGreaterThanOrEqual(1);
    }
    expect(resolveWorkers("99")).toBe(4);
    expect(resolveWorkers("0")).toBe(1);
    expect(resolveWorkers("-3")).toBe(1);
  });

  it("falls back to the default for an unset, empty or non-numeric value", () => {
    for (const raw of [undefined, "", " ", "many"]) expect(resolveWorkers(raw)).toBe(DEFAULT_WORKERS);
  });

  it("the resolved config carries the cap", () => {
    expect(cfg("staging", { [WORKERS_ENV_NAME]: "64" }).workers).toBe(4);
    expect(cfg("staging").workers).toBe(DEFAULT_WORKERS);
  });
});
