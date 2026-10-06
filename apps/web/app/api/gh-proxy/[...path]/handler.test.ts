import { generateKeyPairSync } from "node:crypto";
import https from "node:https";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, calculateJwkThumbprint, type JWK } from "jose";
import {
  InstallationTokenCache,
  MintTimeoutError,
  decideProxyRequest,
  defaultSandboxRunResolver,
  type ProxyDecisionInput,
  type ProxyDecisionResult,
} from "@fx/github";
import { NetGuardError } from "@fx/net-guard";
// Relative on purpose: the strict-GitHub and real-connect-path helpers live with the @fx/github tests (no openssl in the dev shell either).
import { ghError } from "../../../../../../packages/github/test/helpers/strictGithub.js";
import { httpsRoundTrip, startLocalTlsServer, startStrictGithubServer, type LocalTlsServer } from "../../../../../../packages/github/test/helpers/localTlsServer.js";
import {
  ghProxyHandler,
  buildPinnedRequestOptions,
  buildAccessTokenRequester,
  createNodeHttpsPinnedRequester,
  withPinnedTimeouts,
  UpstreamTimeoutError,
  MINT_TIMEOUT_MS,
  UPSTREAM_HEADERS_TIMEOUT_MS,
  UPSTREAM_IDLE_TIMEOUT_MS,
  type GhProxyHandlerDeps,
  type PinnedRequester,
  type PinnedResponse,
} from "./handler";

/**
 * D#2 H13, O2-O4 fixture tests exactly as D#66's "H13 obligations"
 * describe them, plus the route-layer half of body criterion 3/6. The
 * decide()/token-mint logic itself is @fx/github's own
 * (proxyDecision.test.ts, installationToken.test.ts) -- this file injects
 * a fake `decide` (same pattern as H13a's `handle` injection) and stays a
 * thin route-layer test with no real socket, DNS query or Postgres.
 */

const CONFIG_HOST = "gh-proxy.fulcrumaxe.app";
const OIDC_ISSUER = "https://oidc.vercel.com/test-team";

let oidcPrivateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let oidcJwks: ReturnType<typeof createLocalJWKSet>;
/** A REAL RSA PEM (mintAppJwt/getInstallationToken need one to sign the App JWT) -- only tests that go through the real decideProxyRequest/getInstallationToken pipeline need this; every other test's fake `decide` never reaches it. */
let realPrivateKeyPem: string;

beforeAll(async () => {
  realPrivateKeyPem = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey as unknown as string;
  const pair = await generateKeyPair("RS256");
  oidcPrivateKey = pair.privateKey;
  const jwk: JWK = await exportJWK(pair.publicKey);
  jwk.alg = "RS256";
  jwk.kid = await calculateJwkThumbprint(jwk);
  oidcJwks = createLocalJWKSet({ keys: [jwk] });
});

/** D#2 C28 §2: matches `githubProxyForwardUrl({ host: CONFIG_HOST, ... })` exactly, so every fixture below that doesn't care about the audience specifically still verifies. */
const EXPECTED_AUD = `https://${CONFIG_HOST}/api/gh-proxy`;

async function signOidc(claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    sub: "sandbox:1",
    team_id: "team_1",
    project_id: "prj_1",
    sandbox_name: "rn-8-executor-run-1",
    aud: EXPECTED_AUD,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer(OIDC_ISSUER)
    .sign(oidcPrivateKey);
}

function req(opts: {
  path?: string;
  method?: string;
  host?: string | null;
  xForwardedHost?: string | null;
  oidcToken?: string | null;
  body?: string;
}): NextRequest {
  const headers = new Headers();
  if (opts.host !== null) headers.set("host", opts.host ?? CONFIG_HOST);
  if (opts.xForwardedHost !== undefined && opts.xForwardedHost !== null) {
    headers.set("x-forwarded-host", opts.xForwardedHost);
  }
  if (opts.oidcToken !== null) headers.set("vercel-sandbox-oidc-token", opts.oidcToken ?? "");
  return new NextRequest(`https://example.test/api/gh-proxy${opts.path ?? "/repos/acme/widgets/issues/5"}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body,
  });
}

function fakeDeps(overrides: Partial<GhProxyHandlerDeps> = {}): GhProxyHandlerDeps {
  return {
    githubForward: { host: CONFIG_HOST, suffix: "fulcrumaxe.app" } as GhProxyHandlerDeps["githubForward"],
    coldStartCheck: Promise.resolve({ ok: true }),
    oidcJwks,
    oidcIssuer: OIDC_ISSUER,
    oidcTeamId: "team_1",
    oidcProjectId: "prj_1",
    resolveUpstream: vi.fn(async () => ["140.82.112.3"]),
    forwardPinned: vi.fn(async (): Promise<PinnedResponse> => ({ status: 200, headers: {}, bodyStream: null })),
    resolveSandboxRun: vi.fn(async () => null),
    appCredentials: () => ({ appId: "app-1", privateKeyPem: "unused-in-these-tests", webhookSecret: "unused-in-these-tests" }),
    tokenCache: new InstallationTokenCache(),
    accessTokenRequester: vi.fn(),
    ...overrides,
  };
}

function allowDecide(
  upstreamHost: "github.com" | "api.github.com" = "api.github.com",
  query: Record<string, string> = {},
  forwardContentEncoding = false,
): () => Promise<ProxyDecisionResult> {
  return async () => ({ allow: true, upstreamHost, installationToken: "ghs_forwarded", query, forwardContentEncoding });
}
function denyDecide(status: 403 = 403, reason = "policy_denied"): () => Promise<ProxyDecisionResult> {
  return async () => ({ allow: false, status, reason });
}

describe("O2: host binding", () => {
  it("421s a mismatched Host, with no upstream request", async () => {
    const forwardPinned = vi.fn();
    const res = await ghProxyHandler(req({ host: "attacker.example" }), fakeDeps({ forwardPinned }), denyDecide());
    expect(res.status).toBe(421);
    expect(forwardPinned).not.toHaveBeenCalled();
  });

  it("421s a mismatched X-Forwarded-Host even when Host itself matches", async () => {
    const res = await ghProxyHandler(
      req({ host: CONFIG_HOST, xForwardedHost: "attacker.example" }),
      fakeDeps(),
      denyDecide(),
    );
    expect(res.status).toBe(421);
  });

  it("421s a trailing-dot Host", async () => {
    const res = await ghProxyHandler(req({ host: `${CONFIG_HOST}.` }), fakeDeps(), denyDecide());
    expect(res.status).toBe(421);
  });

  it("421s an upper-case Host", async () => {
    const res = await ghProxyHandler(req({ host: CONFIG_HOST.toUpperCase() }), fakeDeps(), denyDecide());
    expect(res.status).toBe(421);
  });

  it("passes a matching Host with no X-Forwarded-Host at all", async () => {
    const res = await ghProxyHandler(
      req({ host: CONFIG_HOST, oidcToken: await signOidc() }),
      fakeDeps({ resolveSandboxRun: vi.fn(async () => null) }),
      denyDecide(403, "sandbox_not_resolved"),
    );
    expect(res.status).toBe(403);
  });
});

describe("O4: cold-start self-check", () => {
  it("503s every request once the cold-start resolveChecked has failed, without reaching OIDC verification", async () => {
    const res = await ghProxyHandler(
      req({ host: CONFIG_HOST, oidcToken: null }),
      fakeDeps({ coldStartCheck: Promise.resolve({ ok: false }) }),
      denyDecide(),
    );
    expect(res.status).toBe(503);
  });

  it("passes through when the cold-start check succeeded", async () => {
    const res = await ghProxyHandler(
      req({ host: CONFIG_HOST, oidcToken: await signOidc() }),
      fakeDeps({ coldStartCheck: Promise.resolve({ ok: true }) }),
      denyDecide(403, "sandbox_not_resolved"),
    );
    expect(res.status).toBe(403);
  });
});

describe("OIDC verification (route layer)", () => {
  it("401s a missing token", async () => {
    const res = await ghProxyHandler(req({ host: CONFIG_HOST, oidcToken: null }), fakeDeps(), denyDecide());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing_oidc_token" });
  });

  it("401s a token signed by an untrusted key", async () => {
    const otherPair = await generateKeyPair("RS256");
    const bad = await new SignJWT({ team_id: "team_1", project_id: "prj_1", sandbox_name: "rn-1", sub: "x" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer(OIDC_ISSUER)
      .sign(otherPair.privateKey);
    const res = await ghProxyHandler(req({ host: CONFIG_HOST, oidcToken: bad }), fakeDeps(), denyDecide());
    expect(res.status).toBe(401);
  });
});

describe("allow path: forwarding and O3 pinning", () => {
  it("resolves and pins the upstream connection, and never buffers the response (streams a non-null body through untouched)", async () => {
    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("pack-data"));
        controller.close();
      },
    });
    const forwardPinned = vi.fn(async (): Promise<PinnedResponse> => ({
      status: 200,
      headers: { "content-type": "application/x-git-upload-pack-result" },
      bodyStream,
    }));
    const resolveUpstream = vi.fn(async () => ["140.82.112.3", "140.82.112.4"]);
    const res = await ghProxyHandler(
      req({ host: CONFIG_HOST, path: "/acme/widgets.git/git-upload-pack", method: "POST", oidcToken: await signOidc() }),
      fakeDeps({ forwardPinned, resolveUpstream }),
      allowDecide("github.com"),
    );
    expect(res.status).toBe(200);
    expect(forwardPinned).toHaveBeenCalledWith(
      expect.objectContaining({ host: "github.com", address: "140.82.112.3" }),
    );
    // Stream, not buffer: NextResponse was constructed from the SAME
    // stream object forwardPinned returned (tee'd, never awaited-and-
    // re-sent), so the body is still readable here.
    expect(res.body).not.toBeNull();
  });

  it("O3: a resolveChecked failure on the upstream host yields 502 with no pinned connection attempted", async () => {
    const forwardPinned = vi.fn();
    const resolveUpstream = vi.fn(async () => {
      throw new NetGuardError("blocked_address", "github.com");
    });
    const res = await ghProxyHandler(
      req({ host: CONFIG_HOST, oidcToken: await signOidc() }),
      fakeDeps({ forwardPinned, resolveUpstream }),
      allowDecide("api.github.com"),
    );
    expect(res.status).toBe(502);
    expect(forwardPinned).not.toHaveBeenCalled();
  });

  it("replaces Authorization with the minted token and never forwards the sandbox's own oidc header", async () => {
    let capturedHeaders: Record<string, string> = {};
    const forwardPinned = vi.fn(async (params: { headers: Record<string, string> }): Promise<PinnedResponse> => {
      capturedHeaders = params.headers;
      return { status: 200, headers: {}, bodyStream: null };
    });
    const oidcToken = await signOidc();
    await ghProxyHandler(
      req({ host: CONFIG_HOST, oidcToken, path: "/repos/acme/widgets/issues/5" }),
      fakeDeps({ forwardPinned }),
      allowDecide("api.github.com"),
    );
    expect(capturedHeaders["authorization"]).toBe("Bearer ghs_forwarded");
    expect(capturedHeaders["vercel-sandbox-oidc-token"]).toBeUndefined();
    expect(JSON.stringify(capturedHeaders)).not.toContain(oidcToken);
  });

  it("uses Basic x-access-token auth for a git target and Bearer for a REST target", async () => {
    let gitHeaders: Record<string, string> = {};
    const forwardPinned = vi.fn(async (params: { headers: Record<string, string> }): Promise<PinnedResponse> => {
      gitHeaders = params.headers;
      return { status: 200, headers: {}, bodyStream: null };
    });
    await ghProxyHandler(
      req({ host: CONFIG_HOST, oidcToken: await signOidc(), path: "/acme/widgets.git/info/refs", method: "GET" }),
      fakeDeps({ forwardPinned }),
      allowDecide("github.com"),
    );
    expect(gitHeaders["authorization"]).toMatch(/^Basic /);
  });
});

describe("FC1 (D#2 Correction C27): end to end, real decide + real default resolver", () => {
  it("denies a validly-signed request with no mint, no upstream call, and a logged reason", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mintSpy = vi.fn();
    const forwardPinned = vi.fn();
    const deps = fakeDeps({
      resolveSandboxRun: defaultSandboxRunResolver,
      accessTokenRequester: mintSpy,
      forwardPinned,
    });

    const res = await ghProxyHandler(
      req({ host: CONFIG_HOST, oidcToken: await signOidc(), path: "/repos/acme/widgets/issues/5" }),
      deps,
      decideProxyRequest,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "denied" });
    expect(mintSpy).not.toHaveBeenCalled();
    expect(forwardPinned).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("gh-proxy: denied", expect.objectContaining({ reason: "sandbox_not_resolved" }));

    warnSpy.mockRestore();
  });
});

describe("O3, pure half: buildPinnedRequestOptions", () => {
  it("pins the lookup to the given address while keeping servername/hostname/Host as the logical GitHub host", async () => {
    const options = buildPinnedRequestOptions({
      host: "api.github.com",
      address: "140.82.112.3",
      method: "GET",
      path: "/repos/acme/widgets",
      headers: { accept: "application/json" },
      body: null,
    });
    expect(options.hostname).toBe("api.github.com");
    expect(options.servername).toBe("api.github.com");
    expect(options.headers).toMatchObject({ host: "api.github.com" });

    const calls: unknown[] = [];
    await new Promise<void>((resolve) => {
      options.lookup!("api.github.com", {} as never, (...args: unknown[]) => {
        calls.push(args);
        resolve();
      });
    });
    expect(calls[0]).toEqual([null, "140.82.112.3", 4]);
  });

  it("picks family 6 for an IPv6 pinned address", () => {
    const options = buildPinnedRequestOptions({
      host: "github.com",
      address: "2606:4700:4700::1111",
      method: "GET",
      path: "/",
      headers: {},
      body: null,
    });
    let captured: unknown[] = [];
    options.lookup!("github.com", {} as never, (...args: unknown[]) => {
      captured = args;
    });
    expect(captured).toEqual([null, "2606:4700:4700::1111", 6]);
  });

  it("answers a { all: true } lookup (what Node's autoSelectFamily connect path sends) with an array holding the one pinned address", () => {
    for (const [address, family] of [
      ["140.82.112.3", 4],
      ["2606:4700:4700::1111", 6],
    ] as const) {
      const options = buildPinnedRequestOptions({ host: "api.github.com", address, method: "GET", path: "/", headers: {}, body: null });
      let captured: unknown[] = [];
      options.lookup!("api.github.com", { all: true } as never, (...args: unknown[]) => {
        captured = args;
      });
      expect(captured).toEqual([null, [{ address, family }]]);
    }
  });
});

describe("buildPinnedRequestOptions: a real https.request over the real connect path", () => {
  it("reaches a local TLS server through the pinned lookup, with certificate and name checks on, sending the logical Host and SNI name", async () => {
    // The server's certificate is for api.github.com and handed to the client as its explicit CA: nothing is skipped.
    const server = await startLocalTlsServer({ dnsNames: ["api.github.com"] }, () => ({ status: 200, headers: { "content-type": "text/plain" }, body: "pinned-ok" }));
    try {
      const res = await httpsRoundTrip({
        ...buildPinnedRequestOptions({ host: "api.github.com", address: "127.0.0.1", method: "GET", path: "/zen", headers: {}, body: null }),
        port: server.port,
        ca: server.ca,
      });
      expect(res.body).toBe("pinned-ok");
      expect(server.seen[0]!.headers.host).toBe("api.github.com");
      expect(server.seen[0]!.servername).toBe("api.github.com");
    } finally {
      await server.close();
    }
  });

  it("fails the TLS check when the pinned address presents a certificate for another name (nothing is skipped)", async () => {
    const server = await startLocalTlsServer({ dnsNames: ["not-github.example"] }, () => ({ status: 200, body: "x" }));
    try {
      await expect(
        httpsRoundTrip({
          ...buildPinnedRequestOptions({ host: "api.github.com", address: "127.0.0.1", method: "GET", path: "/", headers: {}, body: null }),
          port: server.port,
          ca: server.ca,
        }),
      ).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    } finally {
      await server.close();
    }
  });

  it("answers a { all: true } lookup on the real connect path (a lookup that returned a bare string would fail with ERR_INVALID_IP_ADDRESS)", async () => {
    const server = await startLocalTlsServer({ dnsNames: ["api.github.com"] }, () => ({ status: 204 }));
    try {
      const options = {
        ...buildPinnedRequestOptions({ host: "api.github.com", address: "127.0.0.1", method: "GET", path: "/", headers: {}, body: null }),
        port: server.port,
        ca: server.ca,
      };
      // The same request with the old single-address-only lookup: the real connect path rejects it.
      const oldLookup = ((_h: string, _o: unknown, cb: (...a: unknown[]) => void) => cb(null, "127.0.0.1", 4)) as unknown as https.RequestOptions["lookup"];
      await expect(httpsRoundTrip({ ...options, lookup: oldLookup })).rejects.toMatchObject({ code: "ERR_INVALID_IP_ADDRESS" });
      expect((await httpsRoundTrip(options)).status).toBe(204);
    } finally {
      await server.close();
    }
  });
});

describe("the installation-token mint, through the real pinned transport against a strict GitHub", () => {
  const JWT_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  async function appJwt(over: { exp?: number } = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuedAt(now - 60).setExpirationTime(over.exp ?? now + 540).setIssuer("7").sign(JWT_KEY);
  }
  const github = () =>
    startStrictGithubServer((req) =>
      req.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(req.path)
        ? { status: 201, headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "ghs_real", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {}, repository_selection: "all" }) }
        : ghError(404, "Not Found"),
    );
  const requesterFor = (server: LocalTlsServer, tweak?: (p: Parameters<PinnedRequester>[0]) => Parameters<PinnedRequester>[0]) => {
    const transport = createNodeHttpsPinnedRequester({ port: server.port, ca: server.ca });
    return buildAccessTokenRequester({
      resolveUpstream: async () => ["127.0.0.1"],
      forwardPinned: (p) => transport(tweak ? tweak(p) : p),
    });
  };

  it("mints with the production headers: TLS verified, pinned lookup, User-Agent, bearer JWT, JSON body", async () => {
    const server = await github();
    try {
      const minted = await requesterFor(server)({ installationId: 9, appJwt: await appJwt(), repositories: ["widgets"], permissions: { contents: "read" } });
      expect(minted.token).toBe("ghs_real");
      expect(server.seen).toHaveLength(1);
      expect(server.seen[0]!.headers["user-agent"]).toBe("fulcrumaxe-cloud");
      expect(server.seen[0]!.headers["accept"]).toBe("application/vnd.github+json");
      expect(JSON.parse(server.seen[0]!.body)).toEqual({ repositories: ["widgets"], permissions: { contents: "read" } });
    } finally {
      await server.close();
    }
  });

  it("a mint sent without a User-Agent is refused with GitHub's plain-text 403 (the lenient fake used to accept it)", async () => {
    const server = await github();
    try {
      const noUa = requesterFor(server, (p) => {
        const headers = { ...p.headers };
        delete headers["user-agent"];
        return { ...p, headers };
      });
      const err = (await noUa({ installationId: 9, appJwt: await appJwt(), repositories: null, permissions: { metadata: "read" } }).catch((e) => e)) as Error & { status?: number; ghMessage?: string };
      expect(err.message).toBe("access_token_mint_failed");
      expect(err.status).toBe(403);
      expect(err.ghMessage).toMatch(/^Request forbidden by administrative rules/);
      expect(server.seen[0]!.headers["user-agent"]).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("a JWT that is valid for longer than ten minutes is refused, as GitHub does", async () => {
    const server = await github();
    try {
      const long = await appJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
      const err = (await requesterFor(server)({ installationId: 9, appJwt: long, repositories: null, permissions: { metadata: "read" } }).catch((e) => e)) as Error & { status?: number };
      expect(err.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

/** A ResolvedSandboxRun-shaped stub matching /repos/acme/widgets/... paths, for tests that exercise the REAL decideProxyRequest end to end. */
const RESOLVED_RUN = { role: "executor", product: "team" as const, installationId: 99, appKind: "team", owner: "acme", repo: "widgets" };
function successfulMint() {
  return vi.fn(async () => ({ token: "ghs_ok", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
}

describe("D#2 Correction C28 §2: OIDC audience, end to end (route/handler layer)", () => {
  it("a token minted for a DIFFERENT forwardURL gets 401 oidc_audience, with zero mint calls and zero forward calls", async () => {
    const mintSpy = vi.fn();
    const forwardPinned = vi.fn();
    const oidcToken = await signOidc({ aud: "https://attacker.example/api/gh-proxy" });
    const res = await ghProxyHandler(
      req({ host: CONFIG_HOST, oidcToken, path: "/repos/acme/widgets/issues/5" }),
      fakeDeps({ resolveSandboxRun: vi.fn(async () => RESOLVED_RUN), accessTokenRequester: mintSpy, forwardPinned }),
      decideProxyRequest,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "oidc_audience" });
    expect(mintSpy).not.toHaveBeenCalled();
    expect(forwardPinned).not.toHaveBeenCalled();
  });

  it("a token with the expected audience reaches the forward spy", async () => {
    const forwardPinned = vi.fn(async (): Promise<PinnedResponse> => ({ status: 200, headers: {}, bodyStream: null }));
    const res = await ghProxyHandler(
      req({ host: CONFIG_HOST, oidcToken: await signOidc(), path: "/repos/acme/widgets/issues/5" }),
      fakeDeps({ resolveSandboxRun: vi.fn(async () => RESOLVED_RUN), accessTokenRequester: successfulMint(), appCredentials: () => ({ appId: "app-1", privateKeyPem: realPrivateKeyPem, webhookSecret: "unused-in-these-tests" }), forwardPinned }),
      decideProxyRequest,
    );
    expect(res.status).toBe(200);
    expect(forwardPinned).toHaveBeenCalledTimes(1);
  });

  it.each(["team_readonly", "sitekit"])(
    "H13e: a %s installation gets 403 installation_not_writable, with zero mint calls and zero forward calls",
    async (appKind) => {
      const mintSpy = vi.fn();
      const forwardPinned = vi.fn();
      const res = await ghProxyHandler(
        req({ host: CONFIG_HOST, oidcToken: await signOidc(), path: "/repos/acme/widgets/issues/5" }),
        fakeDeps({
          resolveSandboxRun: vi.fn(async () => ({ ...RESOLVED_RUN, appKind })),
          accessTokenRequester: mintSpy,
          forwardPinned,
        }),
        decideProxyRequest,
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "installation_not_writable" });
      expect(mintSpy).not.toHaveBeenCalled();
      expect(forwardPinned).not.toHaveBeenCalled();
    },
  );
});

describe("D#2 Correction C28 §3 item 4: headers are forwarded by allowlist", () => {
  it("forwards only accept, content-type, user-agent, x-github-api-version, git-protocol, and never cookie/proxy-authorization/x-http-method-override/x-forwarded-for/transfer-encoding/the oidc header/vercel-forwarded-host/an arbitrary header", async () => {
    // content-encoding is deliberately NOT exercised here -- as of D#2 fix
    // round 1, sending it on a non-upload-pack request (this one is a plain
    // REST GET) denies the WHOLE request before any mint or forward, so it
    // can no longer share this "everything else forwards, this doesn't"
    // fixture. See the dedicated describe block below for its own coverage.
    let captured: Record<string, string> = {};
    const forwardPinned = vi.fn(async (params: { headers: Record<string, string> }): Promise<PinnedResponse> => {
      captured = params.headers;
      return { status: 200, headers: {}, bodyStream: null };
    });
    const headers = new Headers();
    headers.set("host", CONFIG_HOST);
    headers.set("vercel-sandbox-oidc-token", await signOidc());
    headers.set("accept", "application/vnd.github+json");
    headers.set("content-type", "application/json");
    headers.set("user-agent", "fx-sandbox/1");
    headers.set("x-github-api-version", "2022-11-28");
    headers.set("git-protocol", "version=2");
    headers.set("cookie", "session=attacker");
    headers.set("proxy-authorization", "Basic x");
    headers.set("x-http-method-override", "DELETE");
    headers.set("x-forwarded-for", "1.2.3.4");
    headers.set("transfer-encoding", "chunked");
    headers.set("vercel-forwarded-host", "attacker.example");
    headers.set("x-anything", "whatever");

    const request = new NextRequest(`https://example.test/api/gh-proxy/repos/acme/widgets/issues/5`, {
      method: "GET",
      headers,
    });

    await ghProxyHandler(
      request,
      fakeDeps({ resolveSandboxRun: vi.fn(async () => RESOLVED_RUN), accessTokenRequester: successfulMint(), appCredentials: () => ({ appId: "app-1", privateKeyPem: realPrivateKeyPem, webhookSecret: "unused-in-these-tests" }), forwardPinned }),
      decideProxyRequest,
    );

    expect(forwardPinned).toHaveBeenCalledTimes(1);
    expect(captured["accept"]).toBe("application/vnd.github+json");
    expect(captured["content-type"]).toBe("application/json");
    expect(captured["user-agent"]).toBe("fx-sandbox/1");
    expect(captured["x-github-api-version"]).toBe("2022-11-28");
    expect(captured["git-protocol"]).toBe("version=2");
    for (const denied of [
      "cookie",
      "proxy-authorization",
      "x-http-method-override",
      "x-forwarded-for",
      "transfer-encoding",
      "vercel-sandbox-oidc-token",
      "vercel-forwarded-host",
      "x-anything",
    ]) {
      expect(captured[denied]).toBeUndefined();
    }
  });
});

describe("proxied forwards always carry a User-Agent", () => {
  async function forwardedHeaders(sandboxUserAgent: string | null): Promise<Record<string, string>> {
    let captured: Record<string, string> = {};
    const forwardPinned = vi.fn(async (params: { headers: Record<string, string> }): Promise<PinnedResponse> => {
      captured = params.headers;
      return { status: 200, headers: {}, bodyStream: null };
    });
    const headers = new Headers();
    headers.set("host", CONFIG_HOST);
    headers.set("vercel-sandbox-oidc-token", await signOidc());
    if (sandboxUserAgent !== null) headers.set("user-agent", sandboxUserAgent);
    const request = new NextRequest(`https://example.test/api/gh-proxy/repos/acme/widgets/issues/5`, { method: "GET", headers });
    await ghProxyHandler(
      request,
      fakeDeps({ resolveSandboxRun: vi.fn(async () => RESOLVED_RUN), accessTokenRequester: successfulMint(), appCredentials: () => ({ appId: "app-1", privateKeyPem: realPrivateKeyPem, webhookSecret: "unused-in-these-tests" }), forwardPinned }),
      decideProxyRequest,
    );
    expect(forwardPinned).toHaveBeenCalledTimes(1);
    return captured;
  }

  it("a sandbox client that sends none gets the default, and the sandbox's own value is never overridden", async () => {
    expect((await forwardedHeaders(null))["user-agent"]).toBe("fulcrumaxe-cloud");
    expect((await forwardedHeaders("git/2.50.1"))["user-agent"]).toBe("git/2.50.1");
  });
});

// ---------------------------------------------------------------------------
// D#2 fix round 1, must-fix 1 -- the review comment on PR 160:
// "Clone and fetch are broken because content-encoding is stripped." Git
// gzips any upload-pack request body over 1 KiB, so dropping the header
// while still forwarding the (now-misread) compressed bytes broke every
// real clone/fetch over that size. Ruling: forward content-encoding: gzip,
// and ONLY gzip, only on POST git-upload-pack. Everywhere else, a request
// that carries the header is DENIED outright, not stripped-and-forwarded.
// ---------------------------------------------------------------------------

function gitUploadPackReq(opts: { oidcToken: string; contentEncoding?: string; body?: Uint8Array | string }): NextRequest {
  const headers = new Headers();
  headers.set("host", CONFIG_HOST);
  headers.set("vercel-sandbox-oidc-token", opts.oidcToken);
  if (opts.contentEncoding !== undefined) headers.set("content-encoding", opts.contentEncoding);
  return new NextRequest(`https://example.test/api/gh-proxy/acme/widgets.git/git-upload-pack`, {
    method: "POST",
    headers,
    body: opts.body,
  });
}

describe("D#2 fix round 1, must-fix 1: content-encoding is forwarded ONLY on POST git-upload-pack, denied everywhere else", () => {
  it("a REST GET carrying content-encoding: gzip is denied with 403, zero mint, zero forward", async () => {
    const mintSpy = vi.fn();
    const forwardPinned = vi.fn();
    const headers = new Headers();
    headers.set("host", CONFIG_HOST);
    headers.set("vercel-sandbox-oidc-token", await signOidc());
    headers.set("content-encoding", "gzip");
    const request = new NextRequest(`https://example.test/api/gh-proxy/repos/acme/widgets/issues/5`, {
      method: "GET",
      headers,
    });
    const res = await ghProxyHandler(
      request,
      fakeDeps({ resolveSandboxRun: vi.fn(async () => RESOLVED_RUN), accessTokenRequester: mintSpy, forwardPinned }),
      decideProxyRequest,
    );
    expect(res.status).toBe(403);
    expect(mintSpy).not.toHaveBeenCalled();
    expect(forwardPinned).not.toHaveBeenCalled();
  });

  it("a POST git-receive-pack carrying content-encoding: gzip is denied (git never compresses receive-pack bodies), zero mint, zero forward", async () => {
    const mintSpy = vi.fn();
    const forwardPinned = vi.fn();
    const headers = new Headers();
    headers.set("host", CONFIG_HOST);
    headers.set("vercel-sandbox-oidc-token", await signOidc());
    headers.set("content-encoding", "gzip");
    const request = new NextRequest(`https://example.test/api/gh-proxy/acme/widgets.git/git-receive-pack`, {
      method: "POST",
      headers,
      body: new Uint8Array([0]),
    });
    const res = await ghProxyHandler(
      request,
      fakeDeps({ resolveSandboxRun: vi.fn(async () => RESOLVED_RUN), accessTokenRequester: mintSpy, forwardPinned }),
      decideProxyRequest,
    );
    expect(res.status).toBe(403);
    expect(mintSpy).not.toHaveBeenCalled();
    expect(forwardPinned).not.toHaveBeenCalled();
  });

  it("a non-gzip content-encoding is denied even on POST git-upload-pack", async () => {
    const mintSpy = vi.fn();
    const forwardPinned = vi.fn();
    const request = gitUploadPackReq({ oidcToken: await signOidc(), contentEncoding: "deflate", body: new Uint8Array([1]) });
    const res = await ghProxyHandler(
      request,
      fakeDeps({ resolveSandboxRun: vi.fn(async () => RESOLVED_RUN), accessTokenRequester: mintSpy, forwardPinned }),
      decideProxyRequest,
    );
    expect(res.status).toBe(403);
    expect(mintSpy).not.toHaveBeenCalled();
    expect(forwardPinned).not.toHaveBeenCalled();
  });

  it("content-encoding: gzip on GET info/refs?service=git-upload-pack (right encoding, wrong endpoint/method) is denied", async () => {
    const mintSpy = vi.fn();
    const forwardPinned = vi.fn();
    const headers = new Headers();
    headers.set("host", CONFIG_HOST);
    headers.set("vercel-sandbox-oidc-token", await signOidc());
    headers.set("content-encoding", "gzip");
    const request = new NextRequest(
      `https://example.test/api/gh-proxy/acme/widgets.git/info/refs?service=git-upload-pack`,
      { method: "GET", headers },
    );
    const res = await ghProxyHandler(
      request,
      fakeDeps({ resolveSandboxRun: vi.fn(async () => RESOLVED_RUN), accessTokenRequester: mintSpy, forwardPinned }),
      decideProxyRequest,
    );
    expect(res.status).toBe(403);
    expect(mintSpy).not.toHaveBeenCalled();
    expect(forwardPinned).not.toHaveBeenCalled();
  });

  it("a POST git-upload-pack with content-encoding: gzip is ALLOWED and the header is forwarded exactly", async () => {
    let capturedHeaders: Record<string, string> = {};
    const forwardPinned = vi.fn(async (params: { headers: Record<string, string> }): Promise<PinnedResponse> => {
      capturedHeaders = params.headers;
      return { status: 200, headers: {}, bodyStream: null };
    });
    const request = gitUploadPackReq({ oidcToken: await signOidc(), contentEncoding: "gzip", body: new Uint8Array([1, 2, 3]) });
    const res = await ghProxyHandler(
      request,
      fakeDeps({
        resolveSandboxRun: vi.fn(async () => RESOLVED_RUN),
        accessTokenRequester: successfulMint(),
        appCredentials: () => ({ appId: "app-1", privateKeyPem: realPrivateKeyPem, webhookSecret: "unused-in-these-tests" }),
        forwardPinned,
      }),
      decideProxyRequest,
    );
    expect(res.status).toBe(200);
    expect(capturedHeaders["content-encoding"]).toBe("gzip");
  });

  it("live-shaped: a >1 KiB gzipped upload-pack body round-trips byte-identical, with content-encoding forwarded", async () => {
    // Mirrors what a real `git fetch`/`git clone` sends once its pkt-line
    // request body crosses 1 KiB: git gzips it and sets Content-Encoding.
    // This proves the proxy neither strips the header nor otherwise
    // mutates the (still-compressed) body it forwards.
    const rawWant = "0032want " + "a".repeat(40) + " multi_ack_detailed\n".repeat(80); // > 1 KiB before gzip
    expect(rawWant.length).toBeGreaterThan(1024);
    const gzipped = gzipSync(Buffer.from(rawWant, "utf8"));

    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Uint8Array | null = null;
    const forwardPinned = vi.fn(async (params: { headers: Record<string, string>; body: Uint8Array | null }): Promise<PinnedResponse> => {
      capturedHeaders = params.headers;
      capturedBody = params.body;
      return { status: 200, headers: {}, bodyStream: null };
    });
    const request = gitUploadPackReq({ oidcToken: await signOidc(), contentEncoding: "gzip", body: gzipped });
    const res = await ghProxyHandler(
      request,
      fakeDeps({
        resolveSandboxRun: vi.fn(async () => RESOLVED_RUN),
        accessTokenRequester: successfulMint(),
        appCredentials: () => ({ appId: "app-1", privateKeyPem: realPrivateKeyPem, webhookSecret: "unused-in-these-tests" }),
        forwardPinned,
      }),
      decideProxyRequest,
    );

    expect(res.status).toBe(200);
    expect(capturedHeaders["content-encoding"]).toBe("gzip");
    const body: Uint8Array | null = capturedBody;
    if (body === null) throw new Error("forwardPinned was never called with a body");
    expect(Buffer.from(body).equals(gzipped)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D#2 fix round 1, ALSO REQUIRED -- the conditions under which the Team Lead
// accepted the reviewer's ruling on criterion (d) (raw-target judging is
// impossible under Next's own path normalisation; see D#2 C28 §3 item 5 and
// the H13d executor's reply). Condition 4: "A regression test pins that the
// path given to decide() and the path given to forwardPinned are the same
// value" -- never rebuilt from req.url, route params, x-matched-path, or any
// other raw request data.
// ---------------------------------------------------------------------------

describe("D#2 fix round 1, ALSO REQUIRED: the path handed to decide() is the exact same value handed to forwardPinned", () => {
  it("pins path identity end to end for an API target", async () => {
    let decidedPath = "";
    let forwardedPath = "";
    const pinningDecide = async (input: ProxyDecisionInput): Promise<ProxyDecisionResult> => {
      decidedPath = input.path;
      return { allow: true, upstreamHost: "api.github.com", installationToken: "ghs_x", query: {}, forwardContentEncoding: false };
    };
    const forwardPinned = vi.fn(async (params: { path: string }): Promise<PinnedResponse> => {
      forwardedPath = params.path;
      return { status: 200, headers: {}, bodyStream: null };
    });
    await ghProxyHandler(
      req({ host: CONFIG_HOST, oidcToken: await signOidc(), path: "/repos/acme/widgets/issues/5" }),
      fakeDeps({ forwardPinned }),
      pinningDecide,
    );
    expect(decidedPath).toBe("/repos/acme/widgets/issues/5");
    // forwardPinned's path may carry a validated `?query` suffix decide()
    // itself approved (decision.query) -- strip it before comparing; the
    // PATH portion up to that point must be byte-identical to what decide()
    // judged, never re-derived from req.url a second time.
    expect(forwardedPath.split("?")[0]).toBe(decidedPath);
  });

  it("pins path identity end to end for a git target", async () => {
    let decidedPath = "";
    let forwardedPath = "";
    const pinningDecide = async (input: ProxyDecisionInput): Promise<ProxyDecisionResult> => {
      decidedPath = input.path;
      return { allow: true, upstreamHost: "github.com", installationToken: "ghs_x", query: {}, forwardContentEncoding: false };
    };
    const forwardPinned = vi.fn(async (params: { path: string }): Promise<PinnedResponse> => {
      forwardedPath = params.path;
      return { status: 200, headers: {}, bodyStream: null };
    });
    await ghProxyHandler(
      req({ host: CONFIG_HOST, oidcToken: await signOidc(), path: "/acme/widgets.git/git-upload-pack", method: "POST" }),
      fakeDeps({ forwardPinned }),
      pinningDecide,
    );
    expect(decidedPath).toBe("/acme/widgets.git/git-upload-pack");
    expect(forwardedPath.split("?")[0]).toBe(decidedPath);
  });
});

describe("D#2 Correction C28 §3 item 2: repeated query keys / validated-query forwarding (route/handler layer)", () => {
  it("a REST request with a repeated query key is denied with 403, before any mint or forward call", async () => {
    const mintSpy = vi.fn();
    const forwardPinned = vi.fn();
    const res = await ghProxyHandler(
      req({ host: CONFIG_HOST, oidcToken: await signOidc(), path: "/repos/acme/widgets/issues?page=1&page=2" }),
      fakeDeps({ resolveSandboxRun: vi.fn(async () => RESOLVED_RUN), accessTokenRequester: mintSpy, forwardPinned }),
      decideProxyRequest,
    );
    expect(res.status).toBe(403);
    expect(mintSpy).not.toHaveBeenCalled();
    expect(forwardPinned).not.toHaveBeenCalled();
  });

  it("forwards exactly the validated (non-duplicated) query string -- never url.searchParams.toString()'s raw form -- proving pagination (criterion f)", async () => {
    let capturedPath = "";
    const forwardPinned = vi.fn(async (params: { path: string }): Promise<PinnedResponse> => {
      capturedPath = params.path;
      return { status: 200, headers: {}, bodyStream: null };
    });
    await ghProxyHandler(
      req({ host: CONFIG_HOST, oidcToken: await signOidc(), path: "/repos/acme/widgets/issues?page=2&per_page=50" }),
      fakeDeps({ resolveSandboxRun: vi.fn(async () => RESOLVED_RUN), accessTokenRequester: successfulMint(), appCredentials: () => ({ appId: "app-1", privateKeyPem: realPrivateKeyPem, webhookSecret: "unused-in-these-tests" }), forwardPinned }),
      decideProxyRequest,
    );
    expect(capturedPath).toBe("/repos/acme/widgets/issues?page=2&per_page=50");
  });
});

describe("D#2 Correction C28 §3 item 8: upstream timeouts (route/handler layer)", () => {
  it("a headers-timeout on the proxied forward gives 504 upstream_timeout, logged", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const forwardPinned = vi.fn(async (): Promise<PinnedResponse> => {
      throw new UpstreamTimeoutError("headers");
    });
    const res = await ghProxyHandler(req({ host: CONFIG_HOST, oidcToken: await signOidc() }), fakeDeps({ forwardPinned }), allowDecide());
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "upstream_timeout" });
    expect(warnSpy).toHaveBeenCalledWith("gh-proxy: upstream timeout", expect.objectContaining({ reason: "headers" }));
    warnSpy.mockRestore();
  });

  it("a mint-timeout decision (502 upstream_unavailable) is answered with the upstream_unavailable body, not the generic denied one", async () => {
    const res = await ghProxyHandler(
      req({ host: CONFIG_HOST, oidcToken: await signOidc() }),
      fakeDeps(),
      async () => ({ allow: false, status: 502, reason: "upstream_unavailable" }),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_unavailable" });
  });
});

describe("D#2 Correction C28 §3 item 8: withPinnedTimeouts (fake timers, no real sleeps)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects with UpstreamTimeoutError('headers') when inner doesn't resolve within headersTimeoutMs", async () => {
    const inner: PinnedRequester = () => new Promise(() => {}); // never resolves
    const wrapped = withPinnedTimeouts(inner, { headersTimeoutMs: UPSTREAM_HEADERS_TIMEOUT_MS, idleTimeoutMs: UPSTREAM_IDLE_TIMEOUT_MS });
    const promise = wrapped({ host: "github.com", address: "1.2.3.4", method: "GET", path: "/", headers: {}, body: null });
    const assertion = expect(promise).rejects.toBeInstanceOf(UpstreamTimeoutError);
    await vi.advanceTimersByTimeAsync(UPSTREAM_HEADERS_TIMEOUT_MS);
    await assertion;
  });

  it("resolves normally when inner resolves well before the headers timeout", async () => {
    const inner: PinnedRequester = async () => ({ status: 200, headers: {}, bodyStream: null });
    const wrapped = withPinnedTimeouts(inner, { headersTimeoutMs: UPSTREAM_HEADERS_TIMEOUT_MS, idleTimeoutMs: UPSTREAM_IDLE_TIMEOUT_MS });
    const result = await wrapped({ host: "github.com", address: "1.2.3.4", method: "GET", path: "/", headers: {}, body: null });
    expect(result.status).toBe(200);
  });

  it("an idle timeout mid-stream errors the body stream after idleTimeoutMs of silence between chunks", async () => {
    let enqueueSecondChunk: (() => void) | undefined;
    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first-chunk"));
        // Never enqueue a second chunk or close -- simulates a stalled upstream.
        enqueueSecondChunk = () => controller.close();
      },
    });
    const inner: PinnedRequester = async () => ({ status: 200, headers: {}, bodyStream });
    const wrapped = withPinnedTimeouts(inner, { headersTimeoutMs: UPSTREAM_HEADERS_TIMEOUT_MS, idleTimeoutMs: UPSTREAM_IDLE_TIMEOUT_MS });
    const result = await wrapped({ host: "github.com", address: "1.2.3.4", method: "GET", path: "/", headers: {}, body: null });

    const reader = result.bodyStream!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    const readPromise = reader.read();
    // Attach the rejection assertion BEFORE advancing timers -- advancing
    // is what makes readPromise actually reject, and a handler attached
    // only AFTER that point produces a spurious
    // "PromiseRejectionHandledWarning" even though the assertion itself
    // still passes (same pattern the headers-timeout test above uses).
    const assertion = expect(readPromise).rejects.toBeInstanceOf(UpstreamTimeoutError);
    await vi.advanceTimersByTimeAsync(UPSTREAM_IDLE_TIMEOUT_MS);
    await assertion;
    void enqueueSecondChunk;
  });
});

describe("D#2 Correction C28 §3 item 8: buildAccessTokenRequester's own, tighter mint timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects with MintTimeoutError when the mint forward doesn't resolve within MINT_TIMEOUT_MS", async () => {
    const resolveUpstream = vi.fn(async () => ["140.82.112.3"]);
    const forwardPinned: PinnedRequester = () => new Promise(() => {}); // never resolves
    const requester = buildAccessTokenRequester({ resolveUpstream, forwardPinned });
    const promise = requester({ installationId: 1, appJwt: "jwt", repositories: ["widgets"], permissions: { contents: "write" } });
    const assertion = expect(promise).rejects.toBeInstanceOf(MintTimeoutError);
    await vi.advanceTimersByTimeAsync(MINT_TIMEOUT_MS);
    await assertion;
  });

  it("mints normally when the forward resolves well within the mint timeout", async () => {
    const resolveUpstream = vi.fn(async () => ["140.82.112.3"]);
    const forwardPinned: PinnedRequester = vi.fn(async (): Promise<PinnedResponse> => ({
      status: 201,
      headers: {},
      bodyStream: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ token: "ghs_x", expires_at: new Date().toISOString() })));
          controller.close();
        },
      }),
    }));
    const requester = buildAccessTokenRequester({ resolveUpstream, forwardPinned });
    const result = await requester({ installationId: 1, appJwt: "jwt", repositories: ["widgets"], permissions: { contents: "write" } });
    expect(result.token).toBe("ghs_x");
  });
});

describe("buildAccessTokenRequester: the mint request body", () => {
  function harness() {
    const sent: string[] = [];
    const forwardPinned: PinnedRequester = vi.fn(async (p): Promise<PinnedResponse> => {
      sent.push(Buffer.from(p.body ?? new Uint8Array()).toString("utf8"));
      return {
        status: 201,
        headers: {},
        bodyStream: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(JSON.stringify({ token: "ghs_x", expires_at: new Date().toISOString() })));
            c.close();
          },
        }),
      };
    });
    const resolveUpstream = vi.fn(async () => ["140.82.112.3"]);
    return { sent, resolveUpstream, forwardPinned, requester: buildAccessTokenRequester({ resolveUpstream, forwardPinned }) };
  }

  it("a one-repo scope sends exactly repositories:[name] and the permissions", async () => {
    const h = harness();
    await h.requester({ installationId: 1, appJwt: "jwt", repositories: ["widgets"], permissions: { contents: "write" } });
    expect(h.sent).toEqual(['{"repositories":["widgets"],"permissions":{"contents":"write"}}']);
  });

  it("passes on the permissions GitHub reports for the token, unfiltered, so a write cannot vanish on the way to the read-only check", async () => {
    const reply = (permissions: unknown): PinnedRequester =>
      vi.fn(async (): Promise<PinnedResponse> => ({
        status: 201,
        headers: {},
        bodyStream: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(JSON.stringify({ token: "ghs_x", expires_at: new Date().toISOString(), permissions })));
            c.close();
          },
        }),
      }));
    const mint = (permissions: unknown) =>
      buildAccessTokenRequester({ resolveUpstream: vi.fn(async () => ["140.82.112.3"]), forwardPinned: reply(permissions) })({ installationId: 1, appJwt: "jwt", repositories: ["widgets"], permissions: { contents: "read" } });
    expect((await mint({ metadata: "read", contents: "write" })).permissions).toEqual({ metadata: "read", contents: "write" });
    expect((await mint({ metadata: "read", odd: 5 })).permissions).toEqual({ metadata: "read", odd: 5 });
    expect((await mint(undefined)).permissions).toBeUndefined();
    expect((await mint("read")).permissions).toBeUndefined();
  });

  it("sends a User-Agent (the API refuses a request without one), the bearer JWT and the JSON content type", async () => {
    const seen: Array<Record<string, string>> = [];
    const forwardPinned: PinnedRequester = vi.fn(async (p): Promise<PinnedResponse> => {
      seen.push(p.headers);
      return {
        status: 201,
        headers: {},
        bodyStream: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(JSON.stringify({ token: "ghs_x", expires_at: new Date().toISOString() })));
            c.close();
          },
        }),
      };
    });
    const requester = buildAccessTokenRequester({ resolveUpstream: vi.fn(async () => ["140.82.112.3"]), forwardPinned });
    await requester({ installationId: 1, appJwt: "jwt-value", repositories: null, permissions: { metadata: "read" } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["user-agent"]).toBe("fulcrumaxe-cloud");
    expect(seen[0]!["authorization"]).toBe("Bearer jwt-value");
    expect(seen[0]!["content-type"]).toBe("application/json");
  });

  it("a refused mint carries the HTTP status and a letters-only upstream message, and never the JWT", async () => {
    const forwardPinned: PinnedRequester = vi.fn(async (): Promise<PinnedResponse> => ({
      status: 403,
      headers: {},
      bodyStream: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(JSON.stringify({ message: "Request forbidden by administrative rules. See ghs_tok123 at /acme/widgets" })));
          c.close();
        },
      }),
    }));
    const requester = buildAccessTokenRequester({ resolveUpstream: vi.fn(async () => ["140.82.112.3"]), forwardPinned });
    const err = (await requester({ installationId: 1, appJwt: "jwt-value", repositories: null, permissions: { metadata: "read" } }).catch((e) => e)) as Error & {
      status?: number;
      ghMessage?: string;
    };
    expect(err.message).toBe("access_token_mint_failed");
    expect(err.status).toBe(403);
    expect(err.ghMessage).toMatch(/^[A-Za-z ]{1,80}$/);
    expect(err.ghMessage).not.toContain("jwt");
    expect(JSON.stringify([err.message, err.ghMessage])).not.toContain("/");
  });

  it("the installation-wide variant (null) omits repositories", async () => {
    const h = harness();
    await h.requester({ installationId: 1, appJwt: "jwt", repositories: null, permissions: { metadata: "read" } });
    expect(h.sent).toEqual(['{"permissions":{"metadata":"read"}}']);
  });

  it("an empty or multi-repo list without the variant is refused before any lookup or network call", async () => {
    const h = harness();
    for (const repositories of [[], ["a", "b"]] as unknown as [string][]) {
      await expect(h.requester({ installationId: 1, appJwt: "jwt", repositories, permissions: { contents: "read" } })).rejects.toThrow();
    }
    expect(h.resolveUpstream).not.toHaveBeenCalled();
    expect(h.forwardPinned).not.toHaveBeenCalled();
  });
});
