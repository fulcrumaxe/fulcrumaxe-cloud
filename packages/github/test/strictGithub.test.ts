import { generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { GITHUB_UA_REQUIRED_BODY, StrictFakeError, checkGithubRequest, pagedListing, strictGithubFetch } from "./helpers/strictGithub.js";
import { httpsRoundTrip, startStrictGithubServer } from "./helpers/localTlsServer.js";

/**
 * The strict GitHub fake is only worth having if each rule really refuses. These tests pin the rules
 * (docs/testing.md lists them) so a loosened fake turns this file red, not just a downstream suite.
 */
const KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const NOW = 1_800_000_000_000;
const jwt = (claims: { exp: number; iat?: number; iss?: string }, alg = "RS256") =>
  new SignJWT({}).setProtectedHeader({ alg }).setIssuedAt(claims.iat ?? claims.exp - 600).setExpirationTime(claims.exp).setIssuer(claims.iss ?? "7").sign(KEY);
const good = { "user-agent": "fulcrumaxe-cloud", accept: "application/vnd.github+json" };
const req = (path: string, headers: Record<string, string>, over: { method?: string; body?: string } = {}) => ({ method: over.method ?? "GET", path, headers, body: over.body ?? "" });
const errorBody = (r: { body: string }) => JSON.parse(r.body) as { message: string; documentation_url: string; status: string };

describe("checkGithubRequest", () => {
  it("accepts a well-formed request", () => {
    expect(checkGithubRequest(req("/installation/repositories", { ...good, authorization: "Bearer ghs_x" }), NOW)).toBeNull();
  });

  it("403s a request with no User-Agent, in plain text", () => {
    const r = checkGithubRequest(req("/zen", { accept: "application/json" }), NOW)!;
    expect(r.status).toBe(403);
    expect(r.headers["content-type"]).toMatch(/^text\/plain/);
    expect(r.body).toBe(GITHUB_UA_REQUIRED_BODY);
  });

  it("refuses an Accept that cannot be JSON with 415 and a JSON error body", () => {
    const r = checkGithubRequest(req("/zen", { ...good, accept: "application/xml" }), NOW)!;
    expect(r.status).toBe(415);
    expect(errorBody(r)).toMatchObject({ documentation_url: expect.stringMatching(/^https:\/\//), status: "415" });
    for (const ok of ["*/*", "application/json", "application/vnd.github+json", "application/vnd.github.v3+json", "text/html, application/json;q=0.9"]) {
      expect(checkGithubRequest(req("/zen", { ...good, accept: ok }), NOW)).toBeNull();
    }
  });

  it("refuses an API version GitHub does not publish", () => {
    expect(checkGithubRequest(req("/zen", { ...good, "x-github-api-version": "2022-11-28" }), NOW)).toBeNull();
    expect(checkGithubRequest(req("/zen", { ...good, "x-github-api-version": "2021-01-01" }), NOW)!.status).toBe(400);
  });

  it("accepts only `Bearer <t>` and `token <t>` as Authorization", () => {
    for (const a of ["Bearer ghs_x", "token ghs_x", "bearer ghs_x"]) expect(checkGithubRequest(req("/zen", { ...good, authorization: a }), NOW)).toBeNull();
    for (const a of ["ghs_x", "Basic abc", "Bearer", "Bearer a b", "Bearer "]) {
      const r = checkGithubRequest(req("/zen", { ...good, authorization: a }), NOW)!;
      expect(r.status).toBe(401);
      expect(errorBody(r).message).toBe("Bad credentials");
    }
  });

  it("requires credentials on installation and user routes", () => {
    for (const path of ["/installation/repositories", "/user", "/user/installations"]) {
      const r = checkGithubRequest(req(path, good), NOW)!;
      expect(r.status).toBe(401);
      expect(errorBody(r).message).toBe("Requires authentication");
    }
  });

  it("requires a well-formed App JWT on /app routes: RS256, an issuer, an expiry in the future and within ten minutes", async () => {
    const nowSec = NOW / 1000;
    const ok = await jwt({ exp: nowSec + 540, iat: nowSec - 60 });
    expect(checkGithubRequest(req("/app/installations/1", { ...good, authorization: `Bearer ${ok}` }), NOW)).toBeNull();
    const bad = {
      "no token": undefined,
      "not a jwt": "ghs_x",
      expired: await jwt({ exp: nowSec - 1 }),
      "too far ahead": await jwt({ exp: nowSec + 3600 }),
      "wrong algorithm": await new SignJWT({}).setProtectedHeader({ alg: "RS384" }).setIssuer("7").setExpirationTime(nowSec + 100).sign(KEY),
    };
    for (const [name, token] of Object.entries(bad)) {
      const r = checkGithubRequest(req("/app/installations/1", token ? { ...good, authorization: `Bearer ${token}` } : good), NOW)!;
      expect(r.status, name).toBe(401);
      expect(errorBody(r).documentation_url, name).toBeTruthy();
    }
  });

  it("requires a JSON body with a JSON content type", () => {
    const post = (headers: Record<string, string>, body: string) => checkGithubRequest(req("/user/repos", { ...good, authorization: "Bearer ghu_x", ...headers }, { method: "POST", body }), NOW);
    expect(post({ "content-type": "application/json" }, '{"name":"a"}')).toBeNull();
    expect(post({ "content-type": "application/json; charset=utf-8" }, '{"name":"a"}')).toBeNull();
    for (const [headers, body] of [[{ "content-type": "application/json" }, "{nope"], [{}, '{"name":"a"}'], [{ "content-type": "text/plain" }, '{"name":"a"}']] as const) {
      expect(post({ ...headers }, body)!.status).toBe(400);
    }
  });
});

describe("strictGithubFetch", () => {
  const inner = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
  const strict = strictGithubFetch(inner, { now: () => NOW });

  it("adds the User-Agent and Accept real fetch sends, so a bare fetch call passes the way it does in production", async () => {
    expect((await strict("https://api.github.com/zen")).status).toBe(200);
  });

  it("answers a rule break with GitHub's reply and never reaches the fake behind it", async () => {
    let reached = 0;
    const counted = strictGithubFetch((async () => (reached++, Response.json({}))) as unknown as typeof fetch, { now: () => NOW });
    const bad = await counted("https://api.github.com/user", { headers: { authorization: "ghu_x" } });
    expect(bad.status).toBe(401);
    expect((await bad.json()) as { message: string }).toMatchObject({ message: "Bad credentials", documentation_url: expect.any(String) });
    expect((await counted("https://api.github.com/user/repos", { method: "POST", headers: { authorization: "Bearer ghu_x" }, body: "{}" })).status).toBe(400);
    expect(reached).toBe(0);
  });

  it("with explicitUserAgent, a call that sets none is refused (for callers that send their own on purpose)", async () => {
    const explicit = strictGithubFetch(inner, { now: () => NOW, explicitUserAgent: true });
    expect((await explicit("https://api.github.com/zen")).status).toBe(403);
    expect((await explicit("https://api.github.com/zen", { headers: { "user-agent": "me" } })).status).toBe(200);
  });

  it("refuses any other host", async () => {
    await expect(strict("https://example.com/")).rejects.toBeInstanceOf(StrictFakeError);
    await expect(strict("http://api.github.com/")).rejects.toBeInstanceOf(StrictFakeError);
  });

  it("throws when the fake answers a listing without total_count and its array", async () => {
    const lenient = strictGithubFetch((async () => Response.json({ installations: [] })) as unknown as typeof fetch, { now: () => NOW });
    await expect(lenient("https://api.github.com/user/installations", { headers: { authorization: "Bearer ghu_x" } })).rejects.toBeInstanceOf(StrictFakeError);
    const noArray = strictGithubFetch((async () => Response.json({ total_count: 0 })) as unknown as typeof fetch, { now: () => NOW });
    await expect(noArray("https://api.github.com/installation/repositories", { headers: { authorization: "Bearer ghs_x" } })).rejects.toBeInstanceOf(StrictFakeError);
  });
});

describe("pagedListing", () => {
  const all = Array.from({ length: 230 }, (_, i) => ({ id: i + 1 }));
  const page = async (n: number, perPage = 100) => {
    const res = pagedListing("repositories", all, `https://api.github.com/installation/repositories?per_page=${perPage}&page=${n}`);
    return { body: (await res.json()) as { total_count: number; repositories: Array<{ id: number }> }, link: res.headers.get("link") };
  };

  it("sends total_count for the whole set, at most 100 per page, and a next link until the last page", async () => {
    const p1 = await page(1);
    expect(p1.body.total_count).toBe(230);
    expect(p1.body.repositories).toHaveLength(100);
    expect(p1.link).toContain('rel="next"');
    expect((await page(3)).body.repositories).toHaveLength(30);
    expect((await page(3)).link).toBeNull();
  });

  it("caps per_page at 100 and defaults it to 30", async () => {
    expect((await page(1, 500)).body.repositories).toHaveLength(100);
    const dflt = (await pagedListing("repositories", all, "https://api.github.com/installation/repositories").json()) as { repositories: unknown[] };
    expect(dflt.repositories).toHaveLength(30);
  });
});

describe("the strict GitHub TLS server", () => {
  it("applies the rules to the raw request: a client that sets no User-Agent gets the plain-text 403 (nothing is added for it)", async () => {
    const server = await startStrictGithubServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    try {
      const base = { hostname: "api.github.com", servername: "api.github.com", port: server.port, ca: server.ca, method: "GET", path: "/zen", lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never };
      const refused = await httpsRoundTrip({ ...base, headers: { accept: "application/json" } });
      expect(refused.status).toBe(403);
      expect(refused.body).toBe(GITHUB_UA_REQUIRED_BODY);
      const served = await httpsRoundTrip({ ...base, headers: { accept: "application/json", "user-agent": "fulcrumaxe-cloud" } });
      expect(served.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
