import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppCredentialsError } from "../src/appCredentials.js";
import { InstallationTokenCache, type AccessTokenRequester } from "../src/installationToken.js";
import { createPublicRepoInspector, PublicRepoInspectError } from "../src/publicRepoInspect.js";
import { ghError, type GhReply, type GhRequest } from "./helpers/strictGithub.js";
import { httpsRoundTrip, startStrictGithubServer, type LocalTlsServer } from "./helpers/localTlsServer.js";

/**
 * D#598 PAIR-DEFAULT-BRANCH-CHECK / PAIR-INSTALL-CHECK: what the pairing screens learn about a repo, over Node's real TLS connect path against the
 * strict GitHub server (User-Agent required, Accept and API version checked). The route table adds what the real service does on these paths:
 * the installation lookup takes only an App JWT (anything else is a 401), the repository read takes no App JWT (a 401), an installation token
 * or nothing (a private repo is a plain 404 to a caller with nothing), and `DELETE /installation/token` takes the token itself.
 *
 * What this cannot fake faithfully: GitHub's unauthenticated rate-limit counting (the 403 below is its shape, not a count), whether a minted
 * token is really narrowed to one repository (the requester below answers what GitHub would, and the `greedy` cases play a GitHub that ignored
 * the request), and the exact wording of its errors.
 */
let privateKeyPem: string;
beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});

const JWT = /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/;
const json = (status: number, body: unknown): GhReply => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
const repo = (full: string, over: Record<string, unknown> = {}) => json(200, { full_name: full, private: false, default_branch: "main", ...over });
const moved = (to: string): GhReply => ({ status: 301, headers: { location: `https://api.github.com/repos/${to}` }, body: "" });
// A token built at run time, so no token-shaped literal sits in the source.
const TOKEN = ["ghs", "pairingread1"].join("_");

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let server: LocalTlsServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

interface Setup {
  routes?: Record<string, GhReply>;
  /** Installations our rows say each account owns (team, live). */
  owned?: Array<[string, number]>;
  requester?: AccessTokenRequester;
  now?: () => number;
}

async function setup(o: Setup = {}) {
  const routes = o.routes ?? {};
  server = await startStrictGithubServer((req: GhRequest) => {
    const auth = req.headers["authorization"];
    if (req.method === "DELETE" && req.path === "/installation/token") return auth === `Bearer ${TOKEN}` ? { status: 204, headers: {}, body: "" } : ghError(401, "Bad credentials");
    if (req.path.endsWith("/installation") && !(auth && JWT.test(auth))) return ghError(401, "A JSON web token could not be decoded");
    if (/^\/repos\/[^/]+\/[^/]+$/.test(req.path) && auth !== undefined && JWT.test(auth)) return ghError(401, "Bad credentials");
    // A private repo is a 404 to a caller with no credential, and to a token that does not cover it.
    if (/^\/repos\/[^/]+\/[^/]+$/.test(req.path) && (auth === undefined || auth !== `Bearer ${TOKEN}`) && routes[`${req.path}#private`]) return ghError(404, "Not Found");
    return routes[req.path] ?? ghError(404, "Not Found");
  });
  const s = server;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    // Real fetch refuses to start once its signal has fired.
    if (init?.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
    const url = new URL(String(input));
    const r = await httpsRoundTrip(
      {
        host: "api.github.com", port: s.port, path: url.pathname + url.search, method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, ca: s.ca, servername: "api.github.com",
        lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => (opts?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never,
      },
      init?.body as string | undefined,
    );
    return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
  }) as typeof fetch;
  const minted: Array<Parameters<AccessTokenRequester>[0]> = [];
  const honest: AccessTokenRequester = async (p) => {
    minted.push(p);
    return { token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read" }, repositories: p.repositories ?? [] };
  };
  const owned = new Set((o.owned ?? []).map(([a, id]) => `${a}:${id}`));
  const inspector = createPublicRepoInspector({
    appCredentials: () => ({ appId: "12345", privateKeyPem, webhookSecret: "unused" }),
    requester: o.requester ?? honest,
    cache: new InstallationTokenCache(),
    ownsTeamInstallation: async (a, id) => owned.has(`${a}:${id}`),
    fetchImpl,
    ...(o.now ? { now: o.now } : {}),
  });
  const seenPaths = () => s.seen.map((x) => `${x.method} ${x.path}`);
  return { inspector, server: s, minted, seenPaths };
}

const INSTALLED = json(200, { id: 42, app_slug: "fulcrumaxe" });
const SITE = { "/repos/acme/site": repo("acme/site"), "/repos/acme/site/installation": INSTALLED };

describe("a repo the caller's own write App serves", () => {
  it("looks the installation up first, then reads with a one-repo metadata token, revokes it, and reports installed", async () => {
    const t = await setup({ routes: SITE, owned: [[ACCOUNT, 42]] });
    await expect(t.inspector.inspect("acme/site", ACCOUNT)).resolves.toEqual({ visibility: "public", defaultBranch: "main", appInstalled: true });
    expect(t.seenPaths()).toEqual(["GET /repos/acme/site/installation", "GET /repos/acme/site", "DELETE /installation/token"]);
    expect(t.minted).toEqual([expect.objectContaining({ installationId: 42, repositories: ["site"], permissions: { metadata: "read" } })]);
    const read = t.server.seen.find((s) => s.path === "/repos/acme/site")!;
    expect(read.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(read.headers["user-agent"]).toBe("fulcrumaxe-cloud");
    expect(read.servername).toBe("api.github.com");
    expect(t.server.seen[0]!.headers["authorization"]).toMatch(JWT);
  });

  it("makes no anonymous read for it, however many times it is asked", async () => {
    const t = await setup({ routes: SITE, owned: [[ACCOUNT, 42]] });
    for (let i = 0; i < 3; i++) await t.inspector.inspect("acme/site", ACCOUNT);
    expect(t.server.seen.filter((s) => s.path === "/repos/acme/site" && s.headers["authorization"] === undefined)).toEqual([]);
    expect(t.minted).toHaveLength(3);
  });

  it("reads a private repo it serves as not public, with no branch and not installed (the same as a missing one)", async () => {
    const t = await setup({ routes: { ...SITE, "/repos/acme/site": repo("acme/site", { private: true }) }, owned: [[ACCOUNT, 42]] });
    await expect(t.inspector.inspect("acme/site", ACCOUNT)).resolves.toEqual({ visibility: "not_public", defaultBranch: null, appInstalled: false });
  });

  it("refuses a token GitHub did not narrow as asked, and revokes it", async () => {
    for (const answer of <Array<{ permissions: Record<string, string>; repositories?: string[] }>>[{ permissions: { metadata: "read", contents: "read" }, repositories: ["site"] }, { permissions: { metadata: "read" }, repositories: ["site", "other"] }, { permissions: { metadata: "read" } }]) {
      const greedy: AccessTokenRequester = async () => ({ token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), ...answer });
      const t = await setup({ routes: SITE, owned: [[ACCOUNT, 42]], requester: greedy });
      await expect(t.inspector.inspect("acme/site", ACCOUNT)).rejects.toMatchObject({ code: "github_unavailable" });
      expect(t.seenPaths()).toContain("DELETE /installation/token");
      expect(t.seenPaths()).not.toContain("GET /repos/acme/site");
      await server?.close();
      server = undefined;
    }
  });

  it("is installation_unusable when the mint is refused, and not_configured when the App has no credentials", async () => {
    const refused = await setup({ routes: SITE, owned: [[ACCOUNT, 42]], requester: async () => { throw Object.assign(new Error("access_token_mint_failed"), { status: 404 }); } });
    await expect(refused.inspector.inspect("acme/site", ACCOUNT)).rejects.toMatchObject({ code: "installation_unusable" });
    const bare = createPublicRepoInspector({ appCredentials: () => { throw new AppCredentialsError("missing"); }, requester: vi.fn(), cache: new InstallationTokenCache(), ownsTeamInstallation: async () => true, fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch });
    await expect(bare.inspect("acme/site", ACCOUNT)).rejects.toMatchObject({ code: "not_configured" });
  });
});

describe("a repo no installation of the caller serves", () => {
  it("reads a public repo with no credential, spends no token, and reports not installed", async () => {
    const t = await setup({ routes: { "/repos/acme/site": repo("acme/site") } });
    await expect(t.inspector.inspect("acme/site", ACCOUNT)).resolves.toEqual({ visibility: "public", defaultBranch: "main", appInstalled: false });
    expect(t.server.seen.find((s) => s.path === "/repos/acme/site")!.headers["authorization"]).toBeUndefined();
    expect(t.minted).toEqual([]);
  });

  it("never reports another account's installation as installed, and never mints with it", async () => {
    const t = await setup({ routes: SITE, owned: [[OTHER, 42]] });
    await expect(t.inspector.inspect("acme/site", ACCOUNT)).resolves.toEqual({ visibility: "public", defaultBranch: "main", appInstalled: false });
    expect(t.minted).toEqual([]);
    expect(t.server.seen.find((s) => s.path === "/repos/acme/site")!.headers["authorization"]).toBeUndefined();
    // The same GitHub answers give the owner true: the difference is only whose rows hold the installation.
    await expect(t.inspector.inspect("acme/site", OTHER)).resolves.toMatchObject({ appInstalled: true });
  });

  it.each([["a private repo", { "/repos/acme/site#private": json(200, {}), "/repos/acme/site": repo("acme/site", { private: true }) }], ["a missing repo", {}]])(
    "reads %s as not public with no branch, and the answer carries nothing of any installation there",
    async (_l, routes) => {
      // The App is installed under ANOTHER account on it; the answer must still be the plain one.
      const t = await setup({ routes: { ...routes, "/repos/acme/site/installation": INSTALLED }, owned: [[OTHER, 42]] });
      await expect(t.inspector.inspect("acme/site", ACCOUNT)).resolves.toEqual({ visibility: "not_public", defaultBranch: null, appInstalled: false });
    },
  );

  it("reads a candidate through the stored installation it came from (either App), still reporting installed only for the write App's own", async () => {
    const t = await setup({ routes: { "/repos/acme/site": repo("acme/site") } });
    await expect(t.inspector.inspect("acme/site", ACCOUNT, { hint: { installationId: 7, appKind: "team_readonly" } })).resolves.toEqual({ visibility: "public", defaultBranch: "main", appInstalled: false });
    expect(t.minted).toEqual([expect.objectContaining({ installationId: 7, repositories: ["site"], permissions: { metadata: "read" } })]);
    expect(t.server.seen.find((s) => s.path === "/repos/acme/site")!.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("remembers anonymous facts for a minute, not an authenticated read, and never remembers a failure", async () => {
    let now = 1_000_000;
    const routes: Record<string, GhReply> = { "/repos/acme/site": ghError(502, "Bad Gateway") };
    const t = await setup({ routes, now: () => now });
    const reads = () => t.server.seen.filter((x) => x.path === "/repos/acme/site").length;
    await expect(t.inspector.inspect("acme/site", ACCOUNT)).rejects.toMatchObject({ code: "github_unavailable" });
    routes["/repos/acme/site"] = repo("acme/site");
    await t.inspector.inspect("acme/site", ACCOUNT);
    await t.inspector.inspect("ACME/Site", ACCOUNT);
    expect(reads()).toBe(2);
    now += 61_000;
    await t.inspector.inspect("acme/site", ACCOUNT);
    expect(reads()).toBe(3);
  });
});

describe("answers that are not clear", () => {
  it("reads the default branch as GitHub names it", async () => {
    const t = await setup({ routes: { "/repos/acme/site": repo("acme/site", { default_branch: "master" }) } });
    await expect(t.inspector.inspect("acme/site", ACCOUNT)).resolves.toMatchObject({ defaultBranch: "master" });
  });

  it.each(["", "-lead", "a b", "feat/../x", "x".repeat(300), "refs\nheads", "bräunch"])("does not pass on the default branch %j (it reads as null, which is never main)", async (branch) => {
    const t = await setup({ routes: { "/repos/acme/site": repo("acme/site", { default_branch: branch }) } });
    await expect(t.inspector.inspect("acme/site", ACCOUNT)).resolves.toMatchObject({ visibility: "public", defaultBranch: null });
  });

  it("accepts a plain branch name with slashes and dots", async () => {
    const t = await setup({ routes: { "/repos/acme/site": repo("acme/site", { default_branch: "release/1.x" }) } });
    await expect(t.inspector.inspect("acme/site", ACCOUNT)).resolves.toMatchObject({ defaultBranch: "release/1.x" });
  });

  it("names a renamed repo on the repository read, and does not follow it", async () => {
    const t = await setup({ routes: { "/repos/acme/site": moved("acme/renamed") } });
    await expect(t.inspector.inspect("acme/site", ACCOUNT)).rejects.toMatchObject({ name: "PublicRepoInspectError", code: "repo_renamed" });
    expect(t.seenPaths().filter((p) => p.includes("renamed"))).toEqual([]);
  });

  it("reads a redirect on the installation lookup as no installation: a private repo the App sees under an old name is just not public", async () => {
    // The App's lookup is redirected; the anonymous read of a private repo is a 404, never a redirect.
    const t = await setup({ routes: { "/repos/acme/site/installation": moved("acme/renamed") }, owned: [[ACCOUNT, 42]] });
    await expect(t.inspector.inspect("acme/site", ACCOUNT)).resolves.toEqual({ visibility: "not_public", defaultBranch: null, appInstalled: false });
    // A public repo behind the same redirect is public and not installed.
    const u = await setup({ routes: { "/repos/acme/site/installation": moved("acme/renamed"), "/repos/acme/site": repo("acme/site") }, owned: [[ACCOUNT, 42]] });
    await expect(u.inspector.inspect("acme/site", ACCOUNT)).resolves.toMatchObject({ visibility: "public", appInstalled: false });
  });

  it.each([403, 404, 422])("is installation_unusable when GitHub refuses the mint from a stored installation (%i), and github_unavailable for a 5xx", async (status) => {
    const refusing = async () => { throw Object.assign(new Error("access_token_mint_failed"), { status, ghMessage: "Forbidden" }); };
    const t = await setup({ routes: { "/repos/acme/site": repo("acme/site") }, requester: refusing });
    await expect(t.inspector.inspect("acme/site", ACCOUNT, { hint: { installationId: 7, appKind: "team_readonly" } })).rejects.toMatchObject({ code: "installation_unusable" });
    const down = await setup({ routes: { "/repos/acme/site": repo("acme/site") }, requester: async () => { throw Object.assign(new Error("access_token_mint_failed"), { status: 502 }); } });
    await expect(down.inspector.inspect("acme/site", ACCOUNT, { hint: { installationId: 7, appKind: "team_readonly" } })).rejects.toMatchObject({ code: "github_unavailable" });
  });

  it("is github_unavailable for anything else that is not a clear answer, and never reads it as not installed", async () => {
    const cases: Array<[string, Record<string, GhReply>]> = [
      ["a rate limit", { "/repos/acme/site": { ...ghError(403, "API rate limit exceeded"), headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" } } }],
      ["a server error", { "/repos/acme/site": ghError(502, "Bad Gateway") }],
      ["a body of the wrong shape", { "/repos/acme/site": json(200, { hello: "world" }) }],
      ["another repository's body", { "/repos/acme/site": repo("evil/other") }],
      ["a body that is not JSON", { "/repos/acme/site": { status: 200, headers: {}, body: "<html>" } }],
      ["a server error on the installation lookup", { "/repos/acme/site": repo("acme/site"), "/repos/acme/site/installation": ghError(500, "Server Error") }],
      ["an installation answer with no id", { "/repos/acme/site": repo("acme/site"), "/repos/acme/site/installation": json(200, {}) }],
    ];
    for (const [label, routes] of cases) {
      const t = await setup({ routes });
      await expect(t.inspector.inspect("acme/site", ACCOUNT), label).rejects.toMatchObject({ name: "PublicRepoInspectError", code: "github_unavailable" });
      await server?.close();
      server = undefined;
    }
  });

  it("is github_unavailable for a transport failure or an expired deadline, and carries nothing of the request", async () => {
    const down = createPublicRepoInspector({ appCredentials: () => ({ appId: "1", privateKeyPem, webhookSecret: "x" }), requester: vi.fn(), cache: new InstallationTokenCache(), ownsTeamInstallation: async () => false, fetchImpl: (async () => { throw new TypeError("fetch failed: https://api.github.com/repos/acme/secret-path"); }) as typeof fetch });
    const err = await down.inspect("acme/site", ACCOUNT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublicRepoInspectError);
    expect(JSON.stringify([String(err), (err as Error).stack])).not.toContain("secret-path");
    // A signal that has already fired stops the call before it reaches GitHub: the picker's one deadline.
    const t = await setup({ routes: SITE });
    await expect(t.inspector.inspect("acme/site", ACCOUNT, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "github_unavailable" });
    expect(t.server.seen).toEqual([]);
  });

  it("does not let a database failure read as not installed", async () => {
    const broken = createPublicRepoInspector({ appCredentials: () => ({ appId: "1", privateKeyPem, webhookSecret: "x" }), requester: vi.fn(), cache: new InstallationTokenCache(), ownsTeamInstallation: async () => { throw new Error("db down"); }, fetchImpl: (async () => new Response(JSON.stringify({ id: 42 }), { status: 200 })) as typeof fetch });
    await expect(broken.inspect("acme/site", ACCOUNT)).rejects.toThrow("db down");
  });

  it.each(["acme", "acme/site/extra", "../site", "acme/..", "ac me/site", "", "acme/site?x=1", "acme/site#frag"])("refuses the repository name %j before any request", async (name) => {
    const t = await setup();
    await expect(t.inspector.inspect(name, ACCOUNT)).rejects.toBeInstanceOf(PublicRepoInspectError);
    expect(t.server.seen).toEqual([]);
  });

  it("refuses an api origin that is not a plain https origin", () => {
    for (const apiOrigin of ["http://api.github.com", "https://user@api.github.com", "https://api.github.com/x", "https://api.github.com/?q=1"]) {
      expect(() => createPublicRepoInspector({ appCredentials: () => ({ appId: "1", privateKeyPem, webhookSecret: "x" }), requester: vi.fn(), cache: new InstallationTokenCache(), ownsTeamInstallation: async () => false, apiOrigin })).toThrow();
    }
  });
});
