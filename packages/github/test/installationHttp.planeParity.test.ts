import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { InstallationTokenCache, type AccessTokenRequester } from "../src/installationToken.js";
import { createInstallationHttp, InstallationHttpError, planeParityAllowed } from "../src/installationHttp.js";
import { ghError, type GhReply, type GhRequest } from "./helpers/strictGithub.js";
import { httpsRoundTrip, startStrictGithubServer, type LocalTlsServer } from "./helpers/localTlsServer.js";

/**
 * D#598 P1d-2: the read-only `plane_parity` installation HTTP kind. Its token holds `contents: read`, so the exact path list is the security boundary.
 * Served over Node's real TLS connect path against the strict GitHub server (User-Agent required, bearer credentials, JSON error bodies).
 *
 * Not faked faithfully: that GitHub narrows a token to the permissions named at mint time (the `greedy` requester plays a GitHub that ignored them).
 */
const TARGET = { repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
const A = "a".repeat(40);
const B = "b".repeat(40);
const BASE = "/repos/acme/widgets";

let appKeyPem: string;
beforeAll(() => {
  appKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});
const json = (status: number, body: unknown): GhReply => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
let server: LocalTlsServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(opts: { greedy?: boolean } = {}) {
  server = await startStrictGithubServer((req: GhRequest) => {
    if (req.method === "DELETE" && req.path === "/installation/token") return { status: 204, headers: {}, body: "" };
    if (req.method === "GET" && req.path.startsWith(BASE)) return json(200, { ok: true });
    return ghError(404, "Not Found");
  });
  const s = server;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const r = await httpsRoundTrip(
      {
        host: "api.github.com", port: s.port, path: url.pathname + url.search, method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, ca: s.ca, servername: "api.github.com",
        lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never,
      },
      init?.body as string | undefined,
    );
    return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
  }) as typeof fetch;
  const minted: Array<Parameters<AccessTokenRequester>[0]> = [];
  const requester: AccessTokenRequester = async (p) => {
    minted.push(p);
    return { token: "ghs_parity1", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: (opts.greedy ? { metadata: "read", contents: "write" } : { metadata: "read", ...p.permissions }) as Record<string, string>, repositories: p.repositories ?? [] };
  };
  const open = createInstallationHttp({
    resolveInstallation: async () => ({ installationId: 42, appKind: "team" }),
    appCredentials: () => ({ appId: "12345", privateKeyPem: appKeyPem, webhookSecret: "unused" }),
    requester,
    cache: new InstallationTokenCache(),
    fetchImpl,
  });
  return { open, minted, seen: () => s.seen.map((r) => `${r.method} ${r.path}${r.query ? `?${r.query}` : ""}`), server: s };
}

describe("plane_parity installation HTTP kind", () => {
  it("mints exactly metadata and contents at read for the one repository, sends every allowed read with a User-Agent, and revokes on close", async () => {
    const t = await setup();
    const http = await t.open("plane_parity", TARGET);
    expect(t.minted).toHaveLength(1);
    expect(t.minted[0]).toMatchObject({ repositories: ["widgets"], permissions: { metadata: "read", contents: "read" } });
    expect(Object.keys(t.minted[0]!.permissions).sort()).toEqual(["contents", "metadata"]);
    const reads: Array<[string, Record<string, string | number> | undefined]> = [
      [BASE, undefined],
      [`${BASE}/git/ref/heads/main`, undefined],
      [`${BASE}/git/trees/${A}`, { recursive: "1" }],
      [`${BASE}/commits`, { sha: A, per_page: 30 }],
      [`${BASE}/commits`, { sha: A, per_page: 1 }],
      [`${BASE}/commits`, { sha: A, per_page: 100, page: 1 }],
      [`${BASE}/commits`, { sha: A, per_page: 100, page: 2 }],
    ];
    for (const [path, query] of reads) expect((await http.request({ method: "GET", path, ...(query ? { query } : {}) })).status).toBe(200);
    expect(t.server.seen.every((r) => r.headers["user-agent"] === "fulcrumaxe-cloud" && r.headers.authorization === "Bearer ghs_parity1")).toBe(true);
    await http.close?.();
    expect(t.seen().slice(-1)).toEqual(["DELETE /installation/token"]);
    expect(t.seen()).toHaveLength(reads.length + 1);
  });

  it.each<[string, string, string, Record<string, string | number> | undefined, unknown?]>([
    ["file contents", "GET", `${BASE}/contents/secrets.env`, undefined],
    ["a blob", "GET", `${BASE}/git/blobs/${A}`, undefined],
    ["a blob read with the tree query", "GET", `${BASE}/git/blobs/${A}`, { recursive: "1" }],
    // C21: compare is gone entirely, in every form (its answer carries each changed file's patch whatever per_page says).
    ["a compare of two ids, per_page 1", "GET", `${BASE}/compare/${A}...${B}`, { per_page: 1 }],
    ["a compare of two ids, no query", "GET", `${BASE}/compare/${A}...${B}`, undefined],
    ["a compare of two ids, per_page 2", "GET", `${BASE}/compare/${A}...${B}`, { per_page: 2 }],
    ["a compare naming a branch", "GET", `${BASE}/compare/main...${B}`, { per_page: 1 }],
    ["a compare naming a branch on the right", "GET", `${BASE}/compare/${A}...main`, { per_page: 1 }],
    ["a two-dot compare", "GET", `${BASE}/compare/${A}..${B}`, { per_page: 1 }],
    ["a four-dot compare", "GET", `${BASE}/compare/${A}....${B}`, { per_page: 1 }],
    ["a compare with .diff", "GET", `${BASE}/compare/${A}...${B}.diff`, { per_page: 1 }],
    ["a compare with .patch", "GET", `${BASE}/compare/${A}...${B}.patch`, undefined],
    ["a bare compare path", "GET", `${BASE}/compare`, undefined],
    ["a compare of one id", "GET", `${BASE}/compare/${A}`, { per_page: 1 }],
    ["a compare with percent-encoded dots", "GET", `${BASE}/compare/${A}%2E%2E%2E${B}`, { per_page: 1 }],
    ["a compare with a trailing slash", "GET", `${BASE}/compare/${A}...${B}/`, { per_page: 1 }],
    ["a ref other than main", "GET", `${BASE}/git/ref/heads/develop`, undefined],
    ["a ref of a branch with a slash", "GET", `${BASE}/git/ref/heads/fx/issue-1`, undefined],
    ["a ref named two dots", "GET", `${BASE}/git/ref/heads/..`, undefined],
    ["a ref named one dot", "GET", `${BASE}/git/ref/heads/.`, undefined],
    ["a ref named main with a trailing slash", "GET", `${BASE}/git/ref/heads/main/`, undefined],
    ["a ref in tags", "GET", `${BASE}/git/ref/tags/main`, undefined],
    ["the repository path with a trailing slash", "GET", `${BASE}/`, undefined],
    ["the repository path with two trailing slashes", "GET", `${BASE}//`, undefined],
    ["commits with page 3", "GET", `${BASE}/commits`, { sha: A, per_page: 100, page: 3 }],
    ["commits with page 0", "GET", `${BASE}/commits`, { sha: A, per_page: 100, page: 0 }],
    ["commits with per_page 100 and no page", "GET", `${BASE}/commits`, { sha: A, per_page: 100 }],
    ["commits with a page and per_page 30", "GET", `${BASE}/commits`, { sha: A, per_page: 30, page: 1 }],
    ["commits with per_page 99 and a page", "GET", `${BASE}/commits`, { sha: A, per_page: 99, page: 1 }],
    ["commits with per_page 101 and a page", "GET", `${BASE}/commits`, { sha: A, per_page: 101, page: 1 }],
    ["commits with a page and nothing else", "GET", `${BASE}/commits`, { sha: A, page: 1 }],
    ["commits with page 1.0", "GET", `${BASE}/commits`, { sha: A, per_page: 100, page: "1.0" }],
    ["commits with page 01", "GET", `${BASE}/commits`, { sha: A, per_page: 100, page: "01" }],
    ["commits with a trailing slash", "GET", `${BASE}/commits/`, { sha: A, per_page: 30 }],
    ["a single commit", "GET", `${BASE}/commits/${A}`, undefined],
    ["commits without a sha", "GET", `${BASE}/commits`, { per_page: 30 }],
    ["commits naming a branch", "GET", `${BASE}/commits`, { sha: "main", per_page: 30 }],
    ["commits with per_page 31", "GET", `${BASE}/commits`, { sha: A, per_page: 31 }],
    ["commits with a path filter (a query key that is not allowed)", "GET", `${BASE}/commits`, { sha: A, per_page: 30, path: "secrets.env" }],
    ["commits without per_page", "GET", `${BASE}/commits`, { sha: A }],
    ["a tree without recursive", "GET", `${BASE}/git/trees/${A}`, undefined],
    ["a tree with a query key that is not allowed", "GET", `${BASE}/git/trees/${A}`, { recursive: "1", page: 2 }],
    ["a tree with recursive 0", "GET", `${BASE}/git/trees/${A}`, { recursive: "0" }],
    ["a ref with a query", "GET", `${BASE}/git/ref/heads/main`, { x: 1 }],
    ["traversal", "GET", `${BASE}/git/ref/heads/../../contents/x`, undefined],
    ["traversal inside a sha slot", "GET", `${BASE}/git/trees/${A.slice(0, 38)}../${B}`, { recursive: "1" }],
    ["POST of a ref", "POST", `${BASE}/git/refs`, undefined, { ref: "refs/heads/x", sha: A }],
    ["PUT of contents", "PUT", `${BASE}/contents/x`, undefined, { message: "m", content: "" }],
    ["DELETE of a ref", "DELETE", `${BASE}/git/refs/heads/main`, undefined],
    ["POST on an allowed read path", "POST", `${BASE}/git/trees/${A}`, { recursive: "1" }, {}],
    ["GraphQL", "POST", "/graphql", undefined, { query: "{ viewer { login } }" }],
  ])("refuses %s before a request is sent", async (_name, method, path, query, body) => {
    const t = await setup();
    for (const allowGraphql of [false, true]) {
      const http = await t.open("plane_parity", { ...TARGET, allowGraphql });
      await expect(http.request({ method: method as "GET", path, ...(query ? { query } : {}), ...(body !== undefined ? { body } : {}) })).rejects.toBeInstanceOf(InstallationHttpError);
    }
    expect(t.seen()).toEqual([]);
  });

  it("other kinds keep refusing a path with two dots, and so does this kind, with no exemption", async () => {
    const t = await setup();
    for (const kind of ["read", "repo_map", "plane_parity"] as const) {
      const http = await t.open(kind, TARGET);
      for (const path of [`${BASE}/compare/${A}...${B}`, `${BASE}/git/ref/heads/..`, `${BASE}/git/trees/${A}/..`]) {
        await expect(http.request({ method: "GET", path, query: { per_page: 1 } })).rejects.toThrow("path_refused");
      }
    }
    expect(t.seen()).toEqual([]);
  });

  it("query values are snapshotted to strings once: a value whose toString changes is checked and sent as the same text, or refused", async () => {
    const t = await setup();
    const http = await t.open("plane_parity", TARGET);
    // First answer a sha, then a branch name: one conversion means the check and the send see the sha.
    let n = 0;
    const flip = { toString: () => (++n === 1 ? A : "main") };
    await http.request({ method: "GET", path: `${BASE}/commits`, query: { sha: flip as unknown as string, per_page: 30 } });
    expect(n).toBe(1);
    expect(t.seen()).toEqual([`GET ${BASE}/commits?sha=${A}&per_page=30`]);
    // The other way round: a first answer that fails the check is refused, and nothing further is sent.
    let m = 0;
    const bad = { toString: () => (++m === 1 ? "main" : A) };
    await expect(http.request({ method: "GET", path: `${BASE}/commits`, query: { sha: bad as unknown as string, per_page: 30 } })).rejects.toThrow("path_refused");
    expect(m).toBe(1);
    // A page that is a number still passes as the text "1", and an object that is not a plain string/number is not one of the allowed texts.
    await http.request({ method: "GET", path: `${BASE}/commits`, query: { sha: A, per_page: 100, page: 1 } });
    await expect(http.request({ method: "GET", path: `${BASE}/commits`, query: { sha: A, per_page: 100, page: { toString: () => "1x" } as unknown as number } })).rejects.toThrow("path_refused");
    expect(t.seen()).toHaveLength(2);
  });

  it("a token GitHub made wider than asked for is refused and revoked", async () => {
    const t = await setup({ greedy: true });
    await expect(t.open("plane_parity", TARGET)).rejects.toThrow("token_scope_mismatch");
    expect(t.seen()).toEqual(["DELETE /installation/token"]);
  });

  it("takes no branch, pull request or surface coordinates", async () => {
    const t = await setup();
    await expect(t.open("plane_parity", { ...TARGET, prNumber: 3 })).rejects.toThrow("invalid_coordinates");
    await expect(t.open("plane_parity", { ...TARGET, branch: "fx/issue-1" })).rejects.toThrow("invalid_coordinates");
  });
});

/**
 * The exact list on its own, with no client, token or network in front of it (the #635 review asked for this layer): every compare form is refused
 * here, so the client's other checks (the generic dot-dot refusal, the path charset) cannot be what keeps a compare out.
 */
describe("planeParityAllowed (the exact list, alone)", () => {
  const P = "/repos/acme/widgets/";
  const ok = (path: string, query?: Record<string, string>) => planeParityAllowed("GET", path, query, P);
  it("refuses compare in every form, and any write", () => {
    for (const rest of [`compare/${A}...${B}`, `compare/${A}..${B}`, `compare/main...${B}`, `compare/${A}`, "compare", "compare/"]) {
      expect(ok(P + rest), rest).toBe(false);
      expect(ok(P + rest, { per_page: "1" }), rest).toBe(false);
    }
    expect(planeParityAllowed("POST", P + "commits", { sha: A, per_page: "30" }, P)).toBe(false);
  });
  it("allows exactly the five reads", () => {
    expect(ok("/repos/acme/widgets")).toBe(true);
    expect(ok(P + "git/ref/heads/main")).toBe(true);
    expect(ok(P + "git/ref/heads/dev")).toBe(false);
    expect(ok(P + `git/trees/${A}`, { recursive: "1" })).toBe(true);
    expect(ok(P + `git/trees/${A}`)).toBe(false);
    expect(ok(P + "commits", { sha: A, per_page: "30" })).toBe(true);
    expect(ok(P + "commits", { sha: A, per_page: "31" })).toBe(false);
    expect(ok(P + "commits", { sha: A, per_page: "100", page: "2" })).toBe(true);
    expect(ok(P + "commits", { sha: A, per_page: "100", page: "3" })).toBe(false);
    expect(ok(P + "commits", { sha: "main", per_page: "30" })).toBe(false);
    expect(ok(P + "contents/README.md")).toBe(false);
    expect(ok(P + `git/blobs/${A}`)).toBe(false);
  });
});
