import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { ALLOWED_METHODS } from "@fx/gh-policy";

/**
 * Fix round 1 (suggestion, D#2 C27): route.ts's own `deps()` caching
 * logic in isolation -- every real dependency (config load, resolver,
 * pool, handler) is mocked, so this only exercises the bug: a missing
 * DATABASE_URL_GH_PROXY used to throw on the FIRST request and then
 * silently degrade to a stale, incompletely-wired `cachedDeps` on every
 * request after, with no further log. `handler.test.ts` already covers
 * the real route/host/OIDC/resolver behavior with no database -- this
 * file never touches that surface.
 */
describe("gh-proxy route.ts: DATABASE_URL_GH_PROXY fail-closed caching (fix round 1)", () => {
  const ORIGINAL_ENV = process.env.DATABASE_URL_GH_PROXY;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.DATABASE_URL_GH_PROXY;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.DATABASE_URL_GH_PROXY;
    else process.env.DATABASE_URL_GH_PROXY = ORIGINAL_ENV;
    vi.restoreAllMocks();
    vi.doUnmock("@fx/db/src/pool");
    vi.doUnmock("@fx/github");
    vi.doUnmock("@fx/runner");
    vi.doUnmock("./handler");
  });

  function fakeReq(): NextRequest {
    // Never read before deps() throws (test 1) or by the mocked
    // ghProxyHandler (test 2) -- an opaque stand-in is enough.
    return {} as unknown as NextRequest;
  }

  it("logs loudly and fails closed on EVERY request while the env var stays unset -- not just the first", async () => {
    vi.doMock("@fx/runner", () => ({ loadGithubForwardConfig: vi.fn(() => ({})) }));
    vi.doMock("@fx/github", () => ({ createRunResolver: vi.fn() }));
    vi.doMock("@fx/db/src/pool", () => ({ createPool: vi.fn() }));
    vi.doMock("./handler", () => ({
      defaultGhProxyHandlerDeps: vi.fn(() => ({})),
      ghProxyHandler: vi.fn(),
    }));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const route = await import("./route");

    await expect(route.GET(fakeReq())).rejects.toThrow("DATABASE_URL_GH_PROXY must be set");
    await expect(route.GET(fakeReq())).rejects.toThrow("DATABASE_URL_GH_PROXY must be set");

    // The bug this fixes: the second call used to skip the throw (and the
    // log) entirely, because `cachedDeps` was already truthy from the
    // first call's partially-built assignment.
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("never caches a partially-built deps object -- createPool/resolver are wired exactly once, after the env var is present", async () => {
    process.env.DATABASE_URL_GH_PROXY = "postgres://fx_gh_proxy@example.test/db";

    const loadGithubForwardConfig = vi.fn(() => ({ someConfig: true }));
    const createRunResolver = vi.fn(() => "resolver" as unknown);
    const createRunnerGitResolver = vi.fn(() => "runner-resolver" as unknown);
    const createRunnerCloneBudget = vi.fn(() => "budget" as unknown);
    const createPool = vi.fn(() => "pool" as unknown);
    const ghProxyHandler = vi.fn(async () => new Response(null));
    const defaultGhProxyHandlerDeps = vi.fn(() => ({}) as Record<string, unknown>);

    vi.doMock("@fx/runner", () => ({ loadGithubForwardConfig }));
    vi.doMock("@fx/github", () => ({ createRunResolver, createRunnerGitResolver, createRunnerCloneBudget }));
    vi.doMock("@fx/db/src/pool", () => ({ createPool }));
    vi.doMock("./handler", () => ({ defaultGhProxyHandlerDeps, ghProxyHandler }));

    const route = await import("./route");
    await route.GET(fakeReq());
    await route.GET(fakeReq());

    expect(createPool).toHaveBeenCalledTimes(1);
    expect(createRunResolver).toHaveBeenCalledTimes(1);
    // D#6 R5a-2c: the runner path's lease lookup is built once, on the SAME narrow pool as the sandbox resolver.
    expect(createRunnerGitResolver).toHaveBeenCalledTimes(1);
    expect(createRunnerGitResolver).toHaveBeenCalledWith("pool");
    expect(createRunnerCloneBudget).toHaveBeenCalledWith("pool");
    expect(createRunResolver).toHaveBeenCalledWith("pool");
    expect(defaultGhProxyHandlerDeps).toHaveBeenCalledTimes(1);
    expect(ghProxyHandler).toHaveBeenCalledTimes(2);
  });

  it("does not fall back to the platform_ops URL: with only that set, the pool is never built and the request throws", async () => {
    const saved = process.env.DATABASE_URL_PLATFORM_OPS;
    process.env.DATABASE_URL_PLATFORM_OPS = "postgres://platform_ops@example.test/db";
    try {
      const createPool = vi.fn(() => "pool" as unknown);
      vi.doMock("@fx/runner", () => ({ loadGithubForwardConfig: vi.fn(() => ({})) }));
      vi.doMock("@fx/github", () => ({ createRunResolver: vi.fn() }));
      vi.doMock("@fx/db/src/pool", () => ({ createPool }));
      vi.doMock("./handler", () => ({ defaultGhProxyHandlerDeps: vi.fn(() => ({})), ghProxyHandler: vi.fn() }));
      vi.spyOn(console, "error").mockImplementation(() => {});

      const route = await import("./route");
      await expect(route.GET(fakeReq())).rejects.toThrow("DATABASE_URL_GH_PROXY must be set");
      expect(createPool).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL_PLATFORM_OPS;
      else process.env.DATABASE_URL_PLATFORM_OPS = saved;
    }
  });
});

/**
 * D#2 Correction C28 §3 item 7: "the route exports every method decide()
 * knows" -- pinned against gh-policy's own `ALLOWED_METHODS`, never a
 * second, hand-copied literal that could drift from it.
 */
describe("gh-proxy route.ts: exported methods (D#2 C28 §3 item 7)", () => {
  it("exports exactly the method set gh-policy's decide() recognises -- GET, HEAD, POST, PUT, PATCH, DELETE", async () => {
    vi.resetModules();
    const route = (await import("./route")) as unknown as Record<string, unknown>;
    const exported = new Set(
      ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"].filter(
        (m) => typeof route[m] === "function",
      ),
    );
    expect(exported).toEqual(new Set(ALLOWED_METHODS));
  },
  // The one test here that imports the REAL route, so the whole import graph behind it (handler, the
  // runner and github packages, the pg pool) is transformed cold inside the test. That import measures
  // 0.4-1.7 s and grows with host load; it always completes (it is transform and module evaluation, not a
  // hang), so on a busy machine it can pass vitest's 5 s default. The bound is widened for the import
  // only; the assertion below it is unchanged.
  30_000);
});
