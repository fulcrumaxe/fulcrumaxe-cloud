import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PLAN_READ_PERMISSIONS, PLAN_READ_USER_AGENT, type AccessTokenRequester, type PlanReadDeps } from "@fx/github";
import { createVerifyHost, MAX_BODY_BYTES, RATE_COOLDOWN_MS, type PlaneTarget } from "./verifyHost";

/**
 * D#749 V3a-2: the verify stage's production host adapter, run through the REAL read-only plan client (token mint, headers, rate-limit mapping, body cap, no redirect)
 * against a strict stand-in for GitHub's REST API. The stand-in answers what GitHub answers (the contract fixtures under fixtures/verify-host are trimmed copies of
 * GitHub's documented pull request, commit list and compare replies) and refuses what GitHub refuses: no User-Agent is 403, a bad Authorization form is 401, anything but
 * GET is 404, and a path or query it does not know is 404. It does NOT fake: GitHub's real TLS edge, redirects, abuse-detection timing, or a real installation.
 */
const fixture = (name: string): Record<string, unknown> | unknown[] => JSON.parse(readFileSync(new URL(`./fixtures/verify-host/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
const MERGE = "3f786850e387550fdab836ed7e6dc881de23001b";
const SYNC = "c".repeat(40);
const NAMED = "d".repeat(40);
const BASE = "89abcdef0123456789abcdef0123456789abcdef";

let privateKeyPem: string;
beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});

const A = { repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
const B = { repoId: "22222222-2222-4222-8222-222222222222", owner: "other", name: "gadgets" };
const INSTALLATION: Record<string, number> = { [A.repoId]: 111, [B.repoId]: 222 };

interface Reply {
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}
interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
}

function setup(route: (url: URL, seen: Seen) => Reply | undefined, opts: { now?: () => number; fail?: boolean; deadlineMs?: number; hangMint?: boolean } = {}) {
  const seen: Seen[] = [];
  const mints: Array<{ installationId: number; repositories: readonly string[] | null; permissions: unknown }> = [];
  const requester: AccessTokenRequester = async (p) => {
    if (opts.hangMint) await new Promise(() => undefined);
    mints.push({ installationId: p.installationId, repositories: p.repositories, permissions: p.permissions });
    return { token: `ghs_${p.installationId}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { ...PLAN_READ_PERMISSIONS }, repositories: p.repositories === null ? [] : [...p.repositories] };
  };
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    if (opts.fail) throw new Error("socket hang up https://api.github.com/secret");
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const s: Seen = { method: init?.method ?? "GET", url, headers };
    seen.push(s);
    let r: Reply;
    if (url.origin !== "https://api.github.com") r = { status: 404, body: { message: "Not Found" } };
    else if (!headers["user-agent"]) r = { status: 403, text: "Request forbidden by administrative rules." };
    else if (!/^Bearer ghs_\d+$/.test(headers["authorization"] ?? "")) r = { status: 401, body: { message: "Bad credentials" } };
    else if (s.method !== "GET" || init?.redirect !== "error") r = { status: 404, body: { message: "Not Found" } };
    else r = route(url, s) ?? { status: 404, body: { message: "Not Found" } };
    const text = r.text ?? JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
  const deps: PlanReadDeps = {
    resolveInstallation: async (repoId) => (INSTALLATION[repoId] === undefined ? null : { installationId: INSTALLATION[repoId]!, appKind: "team_readonly" }),
    appCredentials: () => ({ appId: "123", privateKeyPem, webhookSecret: "unused-unused-unused-unused-unused" }),
    requester,
    fetchImpl,
  };
  const calls = () => seen.filter((s) => s.url.pathname.startsWith("/repos/"));
  return { host: createVerifyHost(deps, { ...(opts.now ? { now: opts.now } : {}), ...(opts.deadlineMs ? { deadlineMs: opts.deadlineMs } : {}) }), seen, calls, mints };
}

const PULL = (n: number) => `/repos/acme/widgets/pulls/${n}`;
const okRoutes = (url: URL): Reply | undefined => {
  if (url.pathname === PULL(1347)) return { status: 200, body: fixture("pull-merged") };
  if (url.pathname === PULL(1348)) return { status: 200, body: fixture("pull-open") };
  if (url.pathname === "/repos/acme/widgets/commits" && url.searchParams.get("sha") === SYNC && url.searchParams.get("per_page") === "1" && [...url.searchParams.keys()].length === 2) return { status: 200, body: fixture("commits-list") };
  if (url.pathname === `/repos/acme/widgets/compare/${MERGE}...${NAMED}` && url.searchParams.get("per_page") === "1" && [...url.searchParams.keys()].length === 1) return { status: 200, body: fixture("compare-ahead") };
  return undefined;
};

describe("mergeCommit", () => {
  it("reads the merge commit of a merged pull request: one GET with a User-Agent and the read-only token of the repository's own installation", async () => {
    const t = setup(okRoutes);
    expect(await t.host.mergeCommit(A, 1347)).toBe(MERGE);
    expect(t.calls()).toHaveLength(1);
    expect(t.calls()[0]).toMatchObject({ method: "GET" });
    expect(t.calls()[0]!.url.pathname).toBe(PULL(1347));
    expect(t.calls()[0]!.headers["user-agent"]).toBe(PLAN_READ_USER_AGENT);
    expect(t.calls()[0]!.headers["authorization"]).toBe("Bearer ghs_111");
    expect(t.mints).toEqual([{ installationId: 111, repositories: ["widgets"], permissions: expect.anything() }]);
  });

  it("a private repository is read with the installation that owns it, never another's", async () => {
    const t = setup((url) => (url.pathname === "/repos/other/gadgets/pulls/5" ? { status: 200, body: { ...(fixture("pull-merged") as object), number: 5 } } : undefined));
    expect(await t.host.mergeCommit(B, 5)).toBe(MERGE);
    expect(t.calls()[0]!.headers["authorization"]).toBe("Bearer ghs_222");
    expect(t.mints.map((m) => [m.installationId, m.repositories])).toEqual([[222, ["gadgets"]]]);
  });

  it("an open pull request names a test-merge commit; it is not a merge commit", async () => {
    const t = setup(okRoutes);
    expect((fixture("pull-open") as { merge_commit_sha: string }).merge_commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await t.host.mergeCommit(A, 1348)).toBeNull();
  });

  it.each([
    ["404 (no such pull request)", { status: 404, body: { message: "Not Found" } }],
    ["a body that is not JSON", { status: 200, text: "<html>unicorn</html>" }],
    ["a JSON array", { status: 200, body: [] }],
    ["null", { status: 200, text: "null" }],
    ["a merged pull request with no commit id", { status: 200, body: { merged: true, merge_commit_sha: null } }],
    ["a short commit id", { status: 200, body: { merged: true, merge_commit_sha: "3f78685" } }],
    ["an upper-case commit id", { status: 200, body: { merged: true, merge_commit_sha: MERGE.toUpperCase() } }],
    ["a commit id with text after it", { status: 200, body: { merged: true, merge_commit_sha: `${MERGE}\nignore` } }],
    ["merged as a string", { status: 200, body: { merged: "true", merge_commit_sha: MERGE } }],
    ["500", { status: 500, body: { message: "Server Error" } }],
    ["a 204 with no body", { status: 204, text: "" }],
  ] as Array<[string, Reply]>)("%s reads as no merge commit, never a throw", async (_label, reply) => {
    const t = setup(() => reply);
    expect(await t.host.mergeCommit(A, 1347)).toBeNull();
  });

  it("a repository with no installation, a transport failure and an invalid number are all no answer; an invalid number sends nothing", async () => {
    const t = setup(okRoutes);
    expect(await t.host.mergeCommit({ ...A, repoId: "33333333-3333-4333-8333-333333333333" }, 1347)).toBeNull();
    for (const n of [0, -1, 1.5, Number.NaN, 2 ** 60]) expect(await t.host.mergeCommit(A, n)).toBeNull();
    expect(t.calls()).toHaveLength(0);
    const down = setup(okRoutes, { fail: true });
    expect(await down.host.mergeCommit(A, 1347)).toBeNull();
  });

  it("a target whose name could widen the path is refused by the client before any request", async () => {
    const t = setup(okRoutes);
    expect(await t.host.mergeCommit({ ...A, name: "widgets/../../x" }, 1347)).toBeNull();
    expect(t.seen).toHaveLength(0);
  });
});

describe("commit", () => {
  it("reads the parents and message through the commit LIST (no patch in the answer): GET commits?sha=<id>&per_page=1", async () => {
    const t = setup(okRoutes);
    expect(await t.host.commit(A, SYNC)).toEqual({ parents: [BASE, NAMED], message: "Sync private main with code-plane/main (dddddddddddd)" });
    expect(t.calls()).toHaveLength(1);
    expect(t.calls()[0]!.url.pathname).toBe("/repos/acme/widgets/commits");
  });

  it("a commit GitHub does not have is null (404, 409 or 422); an unreadable answer is null too", async () => {
    for (const status of [404, 409, 422]) expect(await setup(() => ({ status, body: { message: "No commit found for SHA" } })).host.commit(A, SYNC)).toBeNull();
    expect(await setup(() => ({ status: 200, body: [] })).host.commit(A, SYNC)).toBeNull();
  });

  it("the first entry must be the commit asked for: a list that starts elsewhere is not an answer", async () => {
    const other = (fixture("commits-list") as Array<Record<string, unknown>>)[0]!;
    const t = setup(() => ({ status: 200, body: [{ ...other, sha: "9".repeat(40) }] }));
    expect(await t.host.commit(A, SYNC)).toBeNull();
  });

  it.each([
    ["an object, not a list", { not: "a list" }],
    ["an entry with no parents array", [{ sha: SYNC, commit: { message: "m" } }]],
    ["an entry with no message", [{ sha: SYNC, parents: [], commit: {} }]],
    ["a parent with no id", [{ sha: SYNC, parents: [{ url: "x" }], commit: { message: "m" } }]],
    ["a parent id that is not a commit id", [{ sha: SYNC, parents: [{ sha: "main" }], commit: { message: "m" } }]],
    ["a message that is not text", [{ sha: SYNC, parents: [], commit: { message: 7 } }]],
  ] as Array<[string, unknown]>)("a malformed body (%s) is null", async (_label, body) => {
    expect(await setup(() => ({ status: 200, body })).host.commit(A, SYNC)).toBeNull();
  });

  it("a root commit has no parents and that is an answer, not a failure", async () => {
    const t = setup(() => ({ status: 200, body: [{ sha: SYNC, parents: [], commit: { message: "root" } }] }));
    expect(await t.host.commit(A, SYNC)).toEqual({ parents: [], message: "root" });
  });

  it("anything that is not a full lower-case commit id sends nothing (a branch name could be read as a ref)", async () => {
    const t = setup(okRoutes);
    for (const bad of ["main", "HEAD", "abc", SYNC.toUpperCase(), `${SYNC}0`, `${SYNC}&per_page=100`, ""]) expect(await t.host.commit(A, bad), bad).toBeNull();
    expect(t.seen).toHaveLength(0);
  });
});

describe("relation", () => {
  const compareOf = (status: string): Reply => ({ status: 200, body: { ...(fixture("compare-ahead") as object), status } });

  it("reads GitHub's status for base...head: GET compare/<base>...<head>?per_page=1", async () => {
    const t = setup(okRoutes);
    expect(await t.host.relation(A, MERGE, NAMED)).toBe("ahead");
    expect(t.calls()).toHaveLength(1);
    expect(t.calls()[0]!.url.pathname).toBe(`/repos/acme/widgets/compare/${MERGE}...${NAMED}`);
  });

  it.each(["ahead", "behind", "identical", "diverged"])("status %s maps to itself", async (status) => {
    expect(await setup(() => compareOf(status)).host.relation(A, MERGE, NAMED)).toBe(status);
  });

  it.each([
    ["a status GitHub does not define", compareOf("sideways")],
    ["a status that is not text", { status: 200, body: { status: 1 } }],
    ["no status", { status: 200, body: { ahead_by: 1 } }],
    ["a body that is not JSON", { status: 200, text: "nope" }],
    ["a list", { status: 200, body: [] }],
    ["404 (a commit the repository does not have)", { status: 404, body: { message: "Not Found" } }],
    ["500", { status: 500, body: {} }],
  ] as Array<[string, Reply]>)("%s is unknown", async (_label, reply) => {
    expect(await setup(() => reply).host.relation(A, MERGE, NAMED)).toBe("unknown");
  });

  it("a reply over the size cap is unknown, read no further than the cap", async () => {
    const big = JSON.stringify({ status: "ahead", pad: "x".repeat(MAX_BODY_BYTES + 10) });
    expect(await setup(() => ({ status: 200, text: big })).host.relation(A, MERGE, NAMED)).toBe("unknown");
  });

  it("an id that is not a full commit id sends nothing", async () => {
    const t = setup(okRoutes);
    for (const [b, h] of [["main", NAMED], [MERGE, "main"], [`${MERGE}..`, NAMED], [MERGE, `${NAMED}/../x`]] as const) expect(await t.host.relation(A, b, h)).toBe("unknown");
    expect(t.seen).toHaveLength(0);
  });
});

describe("two planes", () => {
  // The shape the stage hands the port: its own VerifyTarget, with the pairing's code repository on it.
  const PAIRED: PlaneTarget = { ...A, codeRepo: { owner: "acme", name: "widgets-public" } };
  const routes = (url: URL): Reply | undefined => {
    const swap = (path: string) => path.replace("/repos/acme/widgets-public/", "/repos/acme/widgets/");
    if (url.pathname.startsWith("/repos/acme/widgets-public/")) return url.pathname.includes("/commits") ? undefined : okRoutes(new URL(swap(url.href)));
    return url.pathname.startsWith("/repos/acme/widgets/") ? (url.pathname.includes("/commits") ? okRoutes(url) : undefined) : undefined;
  };

  it("the merge commit and the comparison are read in the code repository, the deployed sync commit in the private one, each with the item's installation and a token for that one repository", async () => {
    const t = setup(routes);
    expect(await t.host.mergeCommit(PAIRED, 1347)).toBe(MERGE);
    expect(await t.host.commit(PAIRED, SYNC)).toEqual({ parents: [BASE, NAMED], message: "Sync private main with code-plane/main (dddddddddddd)" });
    expect(await t.host.relation(PAIRED, MERGE, NAMED)).toBe("ahead");
    expect(t.calls().map((c) => c.url.pathname.split("/").slice(1, 4).join("/"))).toEqual(["repos/acme/widgets-public", "repos/acme/widgets", "repos/acme/widgets-public"]);
    expect(t.mints.map((m) => [m.installationId, m.repositories])).toEqual([[111, ["widgets-public"]], [111, ["widgets"]], [111, ["widgets-public"]]]);
  });

  it("a repository without a pairing reads everything in its own repository", async () => {
    const t = setup(okRoutes);
    const single: PlaneTarget = { ...A, codeRepo: null };
    await t.host.mergeCommit(single, 1347);
    await t.host.relation(A, MERGE, NAMED);
    expect(t.calls().every((c) => c.url.pathname.startsWith("/repos/acme/widgets/"))).toBe(true);
  });

  it("a code repository under another owner is no answer for each code-plane read: no token mint and no request", async () => {
    const t = setup(okRoutes);
    const foreign: PlaneTarget = { ...A, codeRepo: { owner: "victim", name: "widgets" } };
    expect(await t.host.mergeCommit(foreign, 1347)).toBeNull();
    expect(await t.host.relation(foreign, MERGE, NAMED)).toBe("unknown");
    expect(t.mints).toHaveLength(0);
    expect(t.seen).toHaveLength(0);
  });

  it("the owner comparison ignores case: GitHub owner names are case-insensitive", async () => {
    const t = setup(routes);
    const cased: PlaneTarget = { ...A, codeRepo: { owner: "ACME", name: "widgets-public" } };
    expect(await t.host.mergeCommit(cased, 1347)).toBeNull(); // the stand-in only knows the lower-case path; what matters is that a request was made
    expect(t.mints).toHaveLength(1);
  });

  it("a code repository name that could widen the path is refused before any request", async () => {
    const t = setup(okRoutes);
    const hostile: PlaneTarget = { ...A, codeRepo: { owner: "acme", name: "x/../../widgets" } };
    expect(await t.host.mergeCommit(hostile, 1347)).toBeNull();
    expect(t.seen).toHaveLength(0);
  });
});

describe("deadline", () => {
  it("a call that hangs before it reaches GitHub (the token mint) ends as no answer at the deadline, for each of the three reads", async () => {
    const t = setup(okRoutes, { hangMint: true, deadlineMs: 30 });
    const started = Date.now();
    expect([await t.host.mergeCommit(A, 1347), await t.host.commit(A, SYNC), await t.host.relation(A, MERGE, NAMED)]).toEqual([null, null, "unknown"]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("limits", () => {
  const limited: Array<[string, Reply]> = [
    ["the primary limit (403, remaining 0)", { status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } }],
    ["the secondary limit (403 with retry-after)", { status: 403, body: { message: "You have exceeded a secondary rate limit" }, headers: { "retry-after": "60" } }],
    ["429", { status: 429, body: { message: "rate limited" } }],
  ];

  it.each(limited)("%s ends the call as no answer and the adapter then makes NO call for the cool-down, then resumes", async (_label, reply) => {
    let clock = 1_000_000;
    let limitedNow = true;
    const t = setup((url) => (limitedNow ? reply : okRoutes(url)), { now: () => clock });
    expect(await t.host.mergeCommit(A, 1347)).toBeNull();
    expect(t.calls()).toHaveLength(1);
    limitedNow = false;
    clock += RATE_COOLDOWN_MS - 1;
    expect(await t.host.mergeCommit(A, 1347)).toBeNull();
    expect(await t.host.commit(A, SYNC)).toBeNull();
    expect(await t.host.relation(A, MERGE, NAMED)).toBe("unknown");
    expect(t.calls()).toHaveLength(1);
    clock += 1;
    expect(await t.host.mergeCommit(A, 1347)).toBe(MERGE);
    expect(t.calls()).toHaveLength(2);
  });

  it("a plain 403 (the App lacks a permission) is no answer but starts no cool-down", async () => {
    let denied = true;
    const t = setup((url) => (denied ? { status: 403, body: { message: "Resource not accessible by integration" } } : okRoutes(url)));
    expect(await t.host.mergeCommit(A, 1347)).toBeNull();
    denied = false;
    expect(await t.host.mergeCommit(A, 1347)).toBe(MERGE);
  });

  it("each port call is exactly one GET request", async () => {
    const t = setup(okRoutes);
    await t.host.mergeCommit(A, 1347);
    await t.host.commit(A, SYNC);
    await t.host.relation(A, MERGE, NAMED);
    expect(t.calls().map((c) => c.method)).toEqual(["GET", "GET", "GET"]);
  });

  it("a transport failure never carries the request text out: the answer is plain no answer", async () => {
    const t = setup(okRoutes, { fail: true });
    expect([await t.host.mergeCommit(A, 1347), await t.host.commit(A, SYNC), await t.host.relation(A, MERGE, NAMED)]).toEqual([null, null, "unknown"]);
  });
});

describe("lazy settings", () => {
  it("settings that cannot be read are no answer, not an error at build or in the tick, and are read again on the next call", async () => {
    let ready = false;
    let calls = 0;
    const host = createVerifyHost(() => {
      calls += 1;
      if (!ready) throw new Error("no settings");
      return {
        resolveInstallation: async () => ({ installationId: 111, appKind: "team_readonly" }),
        appCredentials: () => ({ appId: "123", privateKeyPem, webhookSecret: "unused-unused-unused-unused-unused" }),
        requester: async () => ({ token: "ghs_111", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { ...PLAN_READ_PERMISSIONS } }),
        fetchImpl: (async () => new Response(JSON.stringify(fixture("pull-merged")), { status: 200 })) as unknown as typeof fetch,
      };
    });
    expect(calls).toBe(0);
    expect(await host.mergeCommit(A, 1347)).toBeNull();
    ready = true;
    expect(await host.mergeCommit(A, 1347)).toBe(MERGE);
  });
});
