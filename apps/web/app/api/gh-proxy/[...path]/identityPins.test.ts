import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT, calculateJwkThumbprint, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { InstallationTokenCache } from "@fx/github";
import { ghProxyHandler, type GhProxyHandlerDeps, type PinnedResponse } from "./handler";
import { ProxyEnvError, loadProxyOidcEnv } from "./proxyEnv";

// resolveChecked would make a real DNS query when the default deps are built.
vi.mock("@fx/net-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fx/net-guard")>()),
  resolveChecked: vi.fn(async () => ["140.82.112.3"]),
}));

const TEAM_ISSUER = "https://oidc.vercel.com/team_1";
const GOOD_ENV = {
  VERCEL_OIDC_ISSUER: TEAM_ISSUER,
  VERCEL_OIDC_JWKS_URL: `${TEAM_ISSUER}/.well-known/jwks`,
  VERCEL_TEAM_ID: "team_1",
  FX_GH_PROXY_SANDBOX_PROJECT_ID: "prj_staging",
};

describe("proxy identity settings fail closed", () => {
  it("accepts the full, well-formed set and returns the sandbox project id from its own variable", () => {
    expect(loadProxyOidcEnv(GOOD_ENV)).toEqual({
      jwksUrl: GOOD_ENV.VERCEL_OIDC_JWKS_URL,
      issuer: TEAM_ISSUER,
      teamId: "team_1",
      sandboxProjectId: "prj_staging",
    });
  });

  it.each(["VERCEL_OIDC_ISSUER", "VERCEL_OIDC_JWKS_URL", "VERCEL_TEAM_ID", "FX_GH_PROXY_SANDBOX_PROJECT_ID"])(
    "refuses when %s is unset or empty",
    (name) => {
      expect(() => loadProxyOidcEnv({ ...GOOD_ENV, [name]: undefined })).toThrow(ProxyEnvError);
      expect(() => loadProxyOidcEnv({ ...GOOD_ENV, [name]: "" })).toThrow(ProxyEnvError);
    },
  );

  it("R5: VERCEL_PROJECT_ID is never a substitute for the sandbox project id", () => {
    const env = { ...GOOD_ENV, FX_GH_PROXY_SANDBOX_PROJECT_ID: undefined, VERCEL_PROJECT_ID: "prj_proxy_itself" };
    expect(() => loadProxyOidcEnv(env)).toThrow(/FX_GH_PROXY_SANDBOX_PROJECT_ID/);
    expect(loadProxyOidcEnv({ ...GOOD_ENV, VERCEL_PROJECT_ID: "prj_proxy_itself" }).sandboxProjectId).toBe("prj_staging");
  });

  it.each([
    "https://oidc.vercel.com", // the global issuer
    "https://oidc.vercel.com/", // empty team slug
    "https://oidc.vercel.com/acme/extra",
    "https://oidc.vercel.com/acme?x=1",
    "http://oidc.vercel.com/acme",
    "https://oidc.vercel.com.evil.example/acme",
    "https://evil.example/acme",
  ])("R6: refuses %s as the issuer", (issuer) => {
    expect(() => loadProxyOidcEnv({ ...GOOD_ENV, VERCEL_OIDC_ISSUER: issuer, VERCEL_OIDC_JWKS_URL: `${issuer}/.well-known/jwks` })).toThrow(
      ProxyEnvError,
    );
  });

  it("refuses the slug-form issuer at start, naming the variable, instead of denying every request", () => {
    const slug = "https://oidc.vercel.com/acme";
    const env = { ...GOOD_ENV, VERCEL_OIDC_ISSUER: slug, VERCEL_OIDC_JWKS_URL: `${slug}/.well-known/jwks` };
    expect(() => loadProxyOidcEnv(env)).toThrow(ProxyEnvError);
    expect(() => loadProxyOidcEnv(env)).toThrow(/VERCEL_OIDC_ISSUER.*VERCEL_TEAM_ID.*not the team slug/);
  });

  it("refuses an issuer for a different team id than VERCEL_TEAM_ID", () => {
    const other = "https://oidc.vercel.com/team_2";
    expect(() =>
      loadProxyOidcEnv({ ...GOOD_ENV, VERCEL_OIDC_ISSUER: other, VERCEL_OIDC_JWKS_URL: `${other}/.well-known/jwks` }),
    ).toThrow(/VERCEL_OIDC_ISSUER/);
  });

  it("R6: refuses a key set that is not the issuer's own", () => {
    for (const jwks of [
      "https://oidc.vercel.com/.well-known/jwks",
      "https://oidc.vercel.com/other/.well-known/jwks",
      `${TEAM_ISSUER}/.well-known/jwks.json`,
      "https://evil.example/.well-known/jwks",
    ]) {
      expect(() => loadProxyOidcEnv({ ...GOOD_ENV, VERCEL_OIDC_JWKS_URL: jwks })).toThrow(/jwks/i);
    }
  });
});

describe("the default handler deps use the settings above", () => {
  const NAMES = [
    "FX_GH_FORWARD_SUFFIX",
    "FX_GH_FORWARD_HOST",
    "VERCEL_OIDC_ISSUER",
    "VERCEL_OIDC_JWKS_URL",
    "VERCEL_TEAM_ID",
    "FX_GH_PROXY_SANDBOX_PROJECT_ID",
    "VERCEL_PROJECT_ID",
  ];
  const saved = new Map(NAMES.map((name) => [name, process.env[name]] as const));
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function setEnv(overrides: Record<string, string | undefined>): void {
    const values: Record<string, string | undefined> = {
      FX_GH_FORWARD_SUFFIX: "fixture.test",
      FX_GH_FORWARD_HOST: "gh-proxy.fixture.test",
      ...GOOD_ENV,
      VERCEL_PROJECT_ID: "prj_proxy_itself",
      ...overrides,
    };
    for (const name of NAMES) {
      const value = values[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  it("builds with the full set and takes the sandbox project id from FX_GH_PROXY_SANDBOX_PROJECT_ID", async () => {
    setEnv({});
    const { defaultGhProxyHandlerDeps } = await import("./handler");
    expect(defaultGhProxyHandlerDeps().oidcProjectId).toBe("prj_staging");
  });

  it("throws, instead of building, when FX_GH_PROXY_SANDBOX_PROJECT_ID is unset", async () => {
    setEnv({ FX_GH_PROXY_SANDBOX_PROJECT_ID: undefined });
    const { defaultGhProxyHandlerDeps } = await import("./handler");
    expect(() => defaultGhProxyHandlerDeps()).toThrow(/FX_GH_PROXY_SANDBOX_PROJECT_ID/);
  });

  it("throws, instead of building, when the issuer is the global one", async () => {
    setEnv({ VERCEL_OIDC_ISSUER: "https://oidc.vercel.com", VERCEL_OIDC_JWKS_URL: "https://oidc.vercel.com/.well-known/jwks" });
    const { defaultGhProxyHandlerDeps } = await import("./handler");
    expect(() => defaultGhProxyHandlerDeps()).toThrow(ProxyEnvError);
  });
});

describe("the handler holds the pins on a real signed token", () => {
  const HOST = "gh-proxy.fixture.test";
  const AUD = `https://${HOST}/api/gh-proxy`;
  let key: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let jwks: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    key = pair.privateKey;
    const jwk: JWK = await exportJWK(pair.publicKey);
    jwk.alg = "RS256";
    jwk.kid = await calculateJwkThumbprint(jwk);
    jwks = createLocalJWKSet({ keys: [jwk] });
  });

  async function sign(issuer: string, claims: Record<string, unknown> = {}): Promise<string> {
    return new SignJWT({ sub: "sandbox:1", team_id: "team_1", project_id: "prj_staging", sandbox_name: "rn-1", aud: AUD, ...claims })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer(issuer)
      .sign(key);
  }

  function deps() {
    const forwardPinned = vi.fn(async (): Promise<PinnedResponse> => ({ status: 200, headers: {}, bodyStream: null }));
    const d: GhProxyHandlerDeps = {
      githubForward: { host: HOST, suffix: "fixture.test" } as GhProxyHandlerDeps["githubForward"],
      coldStartCheck: Promise.resolve({ ok: true }),
      oidcJwks: jwks,
      oidcIssuer: TEAM_ISSUER,
      oidcTeamId: "team_1",
      oidcProjectId: "prj_staging",
      resolveUpstream: vi.fn(async () => ["140.82.112.3"]),
      forwardPinned,
      resolveSandboxRun: vi.fn(async () => null),
      appCredentials: () => ({ appId: "1", privateKeyPem: "unused", webhookSecret: "unused" }),
      tokenCache: new InstallationTokenCache(),
      accessTokenRequester: vi.fn(),
    };
    return { d, forwardPinned };
  }

  async function call(token: string, d: GhProxyHandlerDeps) {
    const decide = vi.fn(async () => ({ allow: false as const, status: 403 as const, reason: "policy_denied" }));
    const req = new NextRequest("https://gh-proxy.fixture.test/api/gh-proxy/repos/acme/widgets/issues/5", {
      headers: { host: HOST, "vercel-sandbox-oidc-token": token },
    });
    const res = await ghProxyHandler(req, d, decide);
    return { res, decide };
  }

  it("reaches the decision only for the pinned issuer and project", async () => {
    const { d } = deps();
    const { res, decide } = await call(await sign(TEAM_ISSUER), d);
    expect(res.status).toBe(403); // past OIDC, denied by the (fake) policy
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it.each(["https://oidc.vercel.com", "https://oidc.vercel.com/other-team"])("401s a valid signature from issuer %s, with no decision", async (issuer) => {
    const { d, forwardPinned } = deps();
    const { res, decide } = await call(await sign(issuer), d);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "oidc_issuer" });
    expect(decide).not.toHaveBeenCalled();
    expect(forwardPinned).not.toHaveBeenCalled();
  });

  it("logs the fixed reason for a 401, never the token or its claims", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { d } = deps();
    const token = await sign("https://oidc.vercel.com/other-team");
    await call(token, d);
    const logged = JSON.stringify(warn.mock.calls);
    warn.mockRestore();
    expect(logged).toContain("oidc_issuer");
    expect(logged).not.toContain(token.slice(0, 40));
    expect(logged).not.toContain("other-team");
    expect(logged).not.toContain("prj_staging");
  });

  it("a dot-segment path is cleaned once, and the policy input and the upstream request carry the same cleaned path", async () => {
    const { d, forwardPinned } = deps();
    const seen: string[] = [];
    const decide = vi.fn(async (input: { path: string }) => {
      seen.push(input.path);
      return { allow: true as const, upstreamHost: "api.github.com" as const, installationToken: "ghs_x", query: {}, forwardContentEncoding: false };
    });
    const req = new NextRequest("https://gh-proxy.fixture.test/api/gh-proxy/repos/o/r/x/%2e%2e/issues", {
      headers: { host: HOST, "vercel-sandbox-oidc-token": await sign(TEAM_ISSUER) },
    });
    const res = await ghProxyHandler(req, d, decide as unknown as Parameters<typeof ghProxyHandler>[2]);
    expect(res.status).toBe(200);
    const upstream = (forwardPinned.mock.calls[0] as unknown as [{ path: string }])[0].path;
    expect(seen).toEqual(["/repos/o/r/issues"]);
    expect(upstream).toBe("/repos/o/r/issues");
  });

  it("401s a token from the proxy project itself (R5: only the staging project's sandboxes pass)", async () => {
    const { d } = deps();
    const { res, decide } = await call(await sign(TEAM_ISSUER, { project_id: "prj_proxy_itself" }), d);
    expect(res.status).toBe(401);
    expect(decide).not.toHaveBeenCalled();
  });
});
