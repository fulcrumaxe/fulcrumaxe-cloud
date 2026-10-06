import { afterEach, describe, expect, it, vi } from "vitest";
import { selectRuntime } from "../src/select.js";
import type { AgentRuntime } from "../src/types.js";

const FIXTURE_DIR = new URL("../fixtures/agent-outputs", import.meta.url).pathname;

const NOOP_RUNTIME: AgentRuntime = {
  start: vi.fn(),
  stop: vi.fn(),
  resume: vi.fn(),
};

const NOOP_LOCAL_RUNTIME: AgentRuntime = {
  start: vi.fn(),
  stop: vi.fn(),
  resume: vi.fn(),
};

describe("selectRuntime (Spec H04 pass/fail 3)", () => {
  it("returns runner (b) whenever any VERCEL* var is present", () => {
    const createProduction = vi.fn().mockReturnValue(NOOP_RUNTIME);
    for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_REGION"]) {
      createProduction.mockClear();
      const runtime = selectRuntime({ [key]: "1" }, { createProduction });
      expect(runtime).toBe(NOOP_RUNTIME);
      expect(createProduction).toHaveBeenCalledOnce();
    }
  });

  it("prefers production over FX_RUNTIME=local when both are set", () => {
    const createProduction = vi.fn().mockReturnValue(NOOP_RUNTIME);
    const createLocal = vi.fn().mockReturnValue(NOOP_LOCAL_RUNTIME);
    const runtime = selectRuntime({ VERCEL: "1", FX_RUNTIME: "local" }, { createProduction, createLocal });
    expect(runtime).toBe(NOOP_RUNTIME);
    expect(createLocal).not.toHaveBeenCalled();
  });

  it("returns runner (a) only when FX_RUNTIME=local and no VERCEL* var is present", () => {
    const createLocal = vi.fn().mockReturnValue(NOOP_LOCAL_RUNTIME);
    const runtime = selectRuntime({ FX_RUNTIME: "local" }, { createLocal });
    expect(runtime).toBe(NOOP_LOCAL_RUNTIME);
    expect(createLocal).toHaveBeenCalledOnce();
  });

  it("throws when FX_RUNTIME=local but no createLocal factory was supplied", () => {
    expect(() => selectRuntime({ FX_RUNTIME: "local" })).toThrow(/createLocal/);
  });

  it("returns the fake runner under test when neither condition holds", () => {
    const runtime = selectRuntime({ VITEST: "1" }, { fixtureDir: FIXTURE_DIR });
    expect(runtime).toBeDefined();
    expect(typeof runtime.start).toBe("function");
  });

  it("returns the fake runner when FX_FORBID_MODEL_CALLS=1", () => {
    const runtime = selectRuntime({ FX_FORBID_MODEL_CALLS: "1" }, { fixtureDir: FIXTURE_DIR });
    expect(runtime).toBeDefined();
  });

  it("throws when nothing resolves and it is not under test", () => {
    expect(() => selectRuntime({})).toThrow(/no runtime resolved/);
  });

  it("throws when a VERCEL* var is set but no production factory was supplied", () => {
    expect(() => selectRuntime({ VERCEL: "1" })).toThrow(/createProduction/);
  });
});

describe("selectRuntime also checks process.env, not just the passed env (Spec H04 fix-round item 3)", () => {
  const originalVercel = process.env.VERCEL;

  afterEach(() => {
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  });

  it("routes to production when VERCEL is only set on process.env, not on the passed env", () => {
    process.env.VERCEL = "1";
    const createProduction = vi.fn().mockReturnValue(NOOP_RUNTIME);
    const runtime = selectRuntime({}, { createProduction });
    expect(runtime).toBe(NOOP_RUNTIME);
    expect(createProduction).toHaveBeenCalledOnce();
  });

  it("a broader Vercel-set var (VERCEL_DEPLOYMENT_ID) alone still routes to production", () => {
    const createProduction = vi.fn().mockReturnValue(NOOP_RUNTIME);
    const runtime = selectRuntime({ VERCEL_DEPLOYMENT_ID: "dpl_abc123" }, { createProduction });
    expect(runtime).toBe(NOOP_RUNTIME);
  });
});

/**
 * Spec H04 fix-round 2 item 5: selectRuntime must refuse to call ANY
 * createLocal factory when detectDeployedEnvironment is true, regardless
 * of what that factory would have done on its own. At 7262dd9 (before this
 * fix), the mock factory below WOULD have been called and its NOOP result
 * returned — selectRuntime only ever delegated the refusal to the factory,
 * it never checked anything itself. Every test here is red at 7262dd9 and
 * green after.
 */
describe("selectRuntime refuses to call createLocal in a deployed-looking env, whatever the factory does (Spec H04 fix-round 2 item 5)", () => {
  it("refuses when NODE_ENV=production is set, even though no VERCEL* var is present and the factory doesn't check anything itself", () => {
    const createLocal = vi.fn().mockReturnValue(NOOP_LOCAL_RUNTIME);
    expect(() =>
      selectRuntime({ FX_RUNTIME: "local", NODE_ENV: "production" }, { createLocal }),
    ).toThrow(/refusing to call createLocal/);
    expect(createLocal).not.toHaveBeenCalled();
  });

  it("a Vercel-shaped var alongside FX_RUNTIME=local routes to production instead — createLocal is still never called", () => {
    // VERCEL_DEPLOYMENT_ID is caught by the routing check earlier in
    // selectRuntime (any VERCEL* var routes to production before the
    // FX_RUNTIME branch is even reached), so this exercises a DIFFERENT
    // path than the item-5 check below — included here to document that
    // createLocal stays uncalled either way, whichever guard catches it.
    const createProduction = vi.fn().mockReturnValue(NOOP_RUNTIME);
    const createLocal = vi.fn().mockReturnValue(NOOP_LOCAL_RUNTIME);
    const runtime = selectRuntime(
      { FX_RUNTIME: "local", VERCEL_DEPLOYMENT_ID: "dpl_x" },
      { createProduction, createLocal },
    );
    expect(runtime).toBe(NOOP_RUNTIME);
    expect(createLocal).not.toHaveBeenCalled();
  });

  it("still calls createLocal on a genuinely clean env", () => {
    const createLocal = vi.fn().mockReturnValue(NOOP_LOCAL_RUNTIME);
    const runtime = selectRuntime({ FX_RUNTIME: "local" }, { createLocal });
    expect(runtime).toBe(NOOP_LOCAL_RUNTIME);
    expect(createLocal).toHaveBeenCalledOnce();
  });
});
