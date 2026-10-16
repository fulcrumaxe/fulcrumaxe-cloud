import https from "node:https";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { InstallationTokenCache, type AccessTokenRequester } from "../src/installationToken.js";
import { createInstallationHttp } from "../src/installationHttp.js";
import { BLOB_MAX_BYTES, createRepoTreeSource } from "../src/repoTreeSource.js";
import { ghError, FETCH_DEFAULT_USER_AGENT, type GhReply, type GhRequest } from "./helpers/strictGithub.js";
import { startStrictGithubServer, type LocalTlsServer } from "./helpers/localTlsServer.js";

/**
 * D#600 CX-3a: the repository map's GitHub reads (a `repo_map` client plus `createRepoTreeSource`) against a strict GitHub served over
 * real TLS: certificate and hostname are checked, the request carries the User-Agent Node's fetch sends, and the trees reply can be
 * `truncated: true`, as GitHub's is for a very large repository. What it cannot fake: GitHub's rate limits and its exact 100,000-entry cut.
 */
const TARGET = { repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
const COMMIT = "1".repeat(40);
const BLOB = "2".repeat(40);
let privateKeyPem: string;
beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  privateKeyPem = privateKey as unknown as string;
});

const ok = (body: unknown): GhReply => ({ status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });

let server: LocalTlsServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(route: (req: GhRequest) => GhReply) {
  const srv = await startStrictGithubServer(route);
  server = srv;
  const minted: Array<Parameters<AccessTokenRequester>[0]> = [];
  const requester: AccessTokenRequester = async (p) => {
    minted.push(p);
    return { token: "ghs_faketoken", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  };
  /** `fetch` over real TLS to the fake. Node's fetch adds `user-agent: node`, so this does too. */
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.github.com") throw new Error(`unexpected target ${url.origin}`);
    const headers: Record<string, string> = { "user-agent": FETCH_DEFAULT_USER_AGENT };
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    return await new Promise<Response>((resolve, reject) => {
      const req = https.request(
        {
          host: "api.github.com",
          port: srv.port,
          method: init?.method ?? "GET",
          path: `${url.pathname}${url.search}`,
          headers,
          ca: srv.ca,
          servername: "api.github.com",
          lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0 })));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }) as typeof fetch;
  const open = createInstallationHttp({
    resolveInstallation: async () => ({ installationId: 9, appKind: "team" }),
    appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }),
    requester,
    cache: new InstallationTokenCache(),
    fetchImpl,
  });
  const http = await open("repo_map", TARGET);
  return { http, source: createRepoTreeSource(http, TARGET), srv, minted };
}

const repoRoutes = (over: Partial<Record<string, GhReply>> = {}) => (req: GhRequest): GhReply => {
  const key = req.path;
  if (over[key]) return over[key]!;
  if (key === "/repos/acme/widgets") return ok({ full_name: "acme/widgets", default_branch: "main" });
  if (key === "/repos/acme/widgets/git/ref/heads/main") return ok({ ref: "refs/heads/main", object: { sha: COMMIT, type: "commit" } });
  if (key === `/repos/acme/widgets/git/trees/${COMMIT}`) return ok({ sha: COMMIT, truncated: false, tree: [{ path: "src", type: "tree", sha: "3".repeat(40) }, { path: "src/a.ts", type: "blob", sha: BLOB, size: 5 }, { path: "bad", type: "weird", sha: BLOB }] });
  if (key === `/repos/acme/widgets/git/blobs/${BLOB}`) return ok({ encoding: "base64", size: 5, content: Buffer.from("hello").toString("base64") });
  return ghError(404, "Not Found");
};

describe("createRepoTreeSource over real TLS", () => {
  it("resolves the default branch head, lists the tree (recursive) and reads a blob, with a one-repository contents:read token and a User-Agent", async () => {
    const { source, srv, minted } = await setup(repoRoutes());
    expect(await source.headSha()).toBe(COMMIT);
    const tree = await source.tree(COMMIT);
    expect(tree).toEqual({ truncated: false, entries: [{ path: "src", type: "tree", sha: "3".repeat(40) }, { path: "src/a.ts", type: "blob", sha: BLOB }] });
    expect(await source.blob(BLOB)).toBe("hello");
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({ repositories: ["widgets"], permissions: { metadata: "read", contents: "read" } });
    const calls = srv.seen.filter((s) => !s.path.startsWith("/app/"));
    expect(calls.map((c) => `${c.method} ${c.path}${c.query ? `?${c.query}` : ""}`)).toEqual([
      "GET /repos/acme/widgets",
      "GET /repos/acme/widgets/git/ref/heads/main",
      `GET /repos/acme/widgets/git/trees/${COMMIT}?recursive=1`,
      `GET /repos/acme/widgets/git/blobs/${BLOB}`,
    ]);
    for (const c of calls) {
      expect(c.headers["user-agent"]).toBe(FETCH_DEFAULT_USER_AGENT);
      expect(c.headers["authorization"]).toBe("Bearer ghs_faketoken");
      expect(c.servername).toBe("api.github.com");
    }
  });

  it("passes on `truncated: true` from a very large repository instead of hiding it", async () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.ts`, type: "blob", sha: BLOB }));
    const { source } = await setup(repoRoutes({ [`/repos/acme/widgets/git/trees/${COMMIT}`]: ok({ sha: COMMIT, truncated: true, tree: big }) }));
    const tree = await source.tree(COMMIT);
    expect(tree!.truncated).toBe(true);
    expect(tree!.entries).toHaveLength(50);
  });

  it("answers null for an empty repository, a missing tree and a wrong-shaped reply; throws a fixed message (no token, no body) on a server error", async () => {
    const empty = await setup(repoRoutes({ "/repos/acme/widgets/git/ref/heads/main": ghError(409, "Git Repository is empty.") }));
    expect(await empty.source.headSha()).toBeNull();
    await server?.close();
    const odd = await setup(repoRoutes({ "/repos/acme/widgets": ok({ default_branch: "a b" }), [`/repos/acme/widgets/git/trees/${COMMIT}`]: ok({ tree: "nope" }) }));
    expect(await odd.source.headSha()).toBeNull();
    expect(await odd.source.tree(COMMIT)).toBeNull();
    expect(await odd.source.tree("not-a-sha")).toBeNull();
    await server?.close();
    const down = await setup(repoRoutes({ "/repos/acme/widgets": ghError(500, "boom ghs_secret") }));
    const err = await down.source.headSha().catch((e: unknown) => e as Error);
    expect(String((err as Error).message)).toBe("repoTreeSource: status_500");
  });

  it("reads a blob only when it is small, base64 and UTF-8", async () => {
    const huge = await setup(repoRoutes({ [`/repos/acme/widgets/git/blobs/${BLOB}`]: ok({ encoding: "base64", size: BLOB_MAX_BYTES + 1, content: "AAAA" }) }));
    expect(await huge.source.blob(BLOB)).toBeNull();
    await server?.close();
    const binary = await setup(repoRoutes({ [`/repos/acme/widgets/git/blobs/${BLOB}`]: ok({ encoding: "base64", size: 2, content: Buffer.from([0xff, 0xfe]).toString("base64") }) }));
    expect(await binary.source.blob(BLOB)).toBeNull();
  });
});

describe("the repo_map client's exact path list", () => {
  it.each([
    ["GET", "/repos/acme/widgets/contents/src/a.ts"],
    ["GET", "/repos/acme/widgets/commits/HEAD"],
    ["GET", "/repos/acme/widgets/git/commits/" + "a".repeat(40)],
    ["GET", "/repos/acme/widgets/git/trees/main"],
    ["GET", "/repos/acme/widgets/git/blobs/abc"],
    ["GET", "/repos/acme/widgets/git/ref/tags/v1"],
    ["GET", "/repos/acme/widgets/git/ref/heads/a/../b"],
    ["GET", "/repos/acme/widgets/tarball/main"],
    ["GET", "/repos/acme/widgets/pulls"],
    ["GET", "/repos/acme/other"],
    ["GET", "/graphql"],
    ["POST", "/repos/acme/widgets"],
    ["POST", "/repos/acme/widgets/git/trees/" + "a".repeat(40)],
    ["PATCH", "/repos/acme/widgets"],
    ["PUT", "/repos/acme/widgets/contents/x"],
    ["GET", "/repos/acme/widgets/git/trees/" + "a".repeat(40) + "/"],
    ["GET", "/repos/acme/widgets/git/blobs/" + "a".repeat(40) + "/"],
    ["GET", "/repos/acme/widgets/git/trees/" + "a".repeat(40) + "/x"],
    ["GET", "/repos/acme/widgets/git/blobs/" + "a".repeat(40) + "/x"],
    ["GET", "/repos/acme/widgets/git/trees/" + "a".repeat(40) + ".json"],
    ["GET", "/repos/acme/widgets/git/blobs/" + "a".repeat(40) + ".json"],
  ] as const)("refuses %s %s with path_refused before any token or request", async (method, path) => {
    const { http, srv, minted } = await setup(repoRoutes());
    await expect(http.request({ method, path, body: method === "GET" ? undefined : {} })).rejects.toThrow(/path_refused|method_refused/);
    expect(srv.seen).toEqual([]);
    expect(minted).toHaveLength(1); // the token is minted once when the client opens, and never used for these
  });
});
