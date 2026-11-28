import { afterEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ causes: [] as Array<string | undefined> }));
vi.mock("@fx/runner-cloud", async (original) => ({
  ...(await original<typeof import("@fx/runner-cloud")>()),
  drainOperateQueue: async () => ({ not_configured: false, issued: 0, results: [] }),
  issueSystemStarts: async (_deps: unknown, scope: { cause?: string }) => {
    seen.causes.push(scope.cause);
    return { not_configured: false, issued: scope.cause === "state_carry" ? 1 : 0, results: scope.cause === "state_carry" ? [{ account_id: "a", repo_id: "r", result: "issued" }] : [] };
  },
}));

const { defaultReconcileDeps } = await import("./handler.js");

/** D#845 MC-9b2d: the start of a move whose carry is sealed rides the 60 s start job, after the first starts and the engine update restarts, on the same time budget. */
describe("the reconcile tick's system starts", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("also runs the state carry pass, and counts what it issued", async () => {
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "postgres://unused.invalid/none");
    const pass = await defaultReconcileDeps().engineSystemStarts!({ msLeft: () => 1000 });
    expect(seen.causes).toEqual([undefined, "engine_update", "state_carry"]);
    expect(pass).toEqual({ not_configured: false, issued: 1, results: [{ account_id: "a", repo_id: "r", result: "issued" }] });
  });
});
