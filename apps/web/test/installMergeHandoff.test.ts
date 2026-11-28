import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const finishNow = vi.fn();
const installPrNow = vi.fn();
vi.mock("../lib/onboardingHandoff", async (orig) => ({ ...(await orig<typeof import("../lib/onboardingHandoff")>()), finishNow, installPrNow }));

/** D#845 Ruling 122: the install merge route's hand-off is wired to the finish pass. Removing the `afterInstallMerge` line from the route deps makes this go red. */
describe("the install merge hand-off wiring", () => {
  const KEYS = ["DATABASE_URL_PLATFORM_OPS", "DATABASE_URL_APP_USER", "FX_APP_ORIGIN"] as const;
  const saved = KEYS.map((key) => [key, process.env[key]] as const);
  beforeAll(() => {
    process.env.DATABASE_URL_PLATFORM_OPS = "postgres://unused:unused@127.0.0.1:1/unused";
    process.env.DATABASE_URL_APP_USER = "postgres://unused:unused@127.0.0.1:1/unused";
    process.env.FX_APP_ORIGIN = "https://app.example.test";
  });
  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("a merged install starts the finish pass, and a push report still starts the install pull request pass", async () => {
    const { runnerDeps } = await import("../lib/runnerRoutes");
    const deps = runnerDeps();
    expect(deps.afterInstallMerge).toBeTypeOf("function");
    deps.afterInstallMerge!("0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e");
    expect(finishNow).toHaveBeenCalledOnce();
    // the pass is for this setup alone
    expect(finishNow).toHaveBeenCalledWith(undefined, "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e");
    expect(installPrNow).not.toHaveBeenCalled();
    deps.afterSetupPush!("0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e");
    expect(installPrNow).toHaveBeenCalledOnce();
  });
});
