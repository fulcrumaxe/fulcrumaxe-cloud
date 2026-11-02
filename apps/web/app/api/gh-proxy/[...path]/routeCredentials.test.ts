import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Staging probe: a session cookie, a bogus bearer and a customer API token all got an empty 500 here, because the route built the
 * handler's dependencies (which need the proxy's own settings, absent on the main app) before it read a header. Only a runner's
 * ticket or a sandbox's OIDC token may get that far.
 */
describe("gh-proxy route.ts: callers with no proxy credential are refused before any work", () => {
  const SAVED = process.env.DATABASE_URL_GH_PROXY;
  beforeEach(() => {
    vi.resetModules();
    delete process.env.DATABASE_URL_GH_PROXY;
  });
  afterEach(() => {
    if (SAVED === undefined) delete process.env.DATABASE_URL_GH_PROXY;
    else process.env.DATABASE_URL_GH_PROXY = SAVED;
    vi.restoreAllMocks();
    vi.doUnmock("@fx/db/src/pool");
    vi.doUnmock("@fx/github");
    vi.doUnmock("@fx/runner");
    vi.doUnmock("./handler");
  });

  async function load() {
    const loadGithubForwardConfig = vi.fn(() => ({}));
    const defaultGhProxyHandlerDeps = vi.fn(() => ({}));
    const ghProxyHandler = vi.fn(async () => new Response("handled", { status: 200 }));
    const createPool = vi.fn(() => "pool" as unknown);
    vi.doMock("@fx/runner", () => ({ loadGithubForwardConfig }));
    vi.doMock("@fx/github", () => ({
      createRunResolver: vi.fn(),
      createRunnerGitResolver: vi.fn(),
      createRunnerCloneBudget: vi.fn(),
      createRunnerBoundBranchResolver: vi.fn(),
      createPublishTargetResolver: vi.fn(),
      createPublishInstallationOwnership: vi.fn(),
      createPlatformPushRecorder: vi.fn(),
    }));
    vi.doMock("@fx/db/src/pool", () => ({ createPool }));
    vi.doMock("./handler", () => ({ defaultGhProxyHandlerDeps, ghProxyHandler }));
    const route = await import("./route");
    return { route, loadGithubForwardConfig, defaultGhProxyHandlerDeps, ghProxyHandler, createPool };
  }
  const req = (headers: Record<string, string>) => ({ headers: new Headers(headers) }) as unknown as NextRequest;

  const refused: Array<[string, Record<string, string>]> = [
    ["no credentials", {}],
    ["a session cookie", { cookie: "__Host-fx_session=abc" }],
    ["a customer API token", { authorization: "Bearer fxat_customer_token" }],
    ["a bogus bearer", { authorization: "Bearer not-a-real-token" }],
  ];
  for (const [name, headers] of refused) {
    it(`${name}: 401 missing_credentials; no configuration is read, no database is touched, the handler does not run`, async () => {
      const m = await load();
      const res = await m.route.GET(req(headers));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "missing_credentials" });
      expect(m.loadGithubForwardConfig).not.toHaveBeenCalled();
      expect(m.defaultGhProxyHandlerDeps).not.toHaveBeenCalled();
      expect(m.createPool).not.toHaveBeenCalled();
      expect(m.ghProxyHandler).not.toHaveBeenCalled();
    });
  }

  it("a runner ticket, and a sandbox OIDC token, on a configured deployment reach the handler", async () => {
    process.env.DATABASE_URL_GH_PROXY = "postgres://fx_gh_proxy@example.test/db";
    const m = await load();
    expect((await m.route.GET(req({ "fx-git-ticket": "a-ticket" }))).status).toBe(200);
    expect((await m.route.POST(req({ "vercel-sandbox-oidc-token": "a-token" }))).status).toBe(200);
    expect(m.ghProxyHandler).toHaveBeenCalledTimes(2);
  });

  it("a ticket or an OIDC token on a deployment without the proxy settings is 503 gh_proxy_not_configured, not an empty 500", async () => {
    const m = await load();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const carrying: Array<Record<string, string>> = [{ "fx-git-ticket": "a-ticket" }, { "vercel-sandbox-oidc-token": "a-token" }];
    for (const headers of carrying) {
      const res = await m.route.GET(req(headers));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "gh_proxy_not_configured" });
    }
    expect(m.ghProxyHandler).not.toHaveBeenCalled();
  });
});
