import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { InstallationTokenCache, type AccessTokenRequester } from "../src/installationToken.js";
import { createPlanePushApi, PlanePushApiError } from "../src/planePushApi.js";
import { createHostedPlanePush, PLANE_PUSH_TOKEN_MAX_LIFETIME_MS } from "../src/planePushHosted.js";
import { ghError, type GhReply, type GhRequest } from "./helpers/strictGithub.js";
import { httpsRoundTrip, startStrictGithubServer, type LocalTlsServer } from "./helpers/localTlsServer.js";

/**
 * D#598 P1f-2: the hosted side's reads of the paired public repo, over Node's real TLS connect path against the strict GitHub server, with
 * GitHub's real revoke shape (204 once, then 401 "Bad credentials" for any use of that token).
 *
 * What cannot be faked faithfully: GitHub's own token expiry (the fake mints with the expiry the test chooses), that `compare` answers
 * `behind`/`identical` for exactly the commits in main's history (the fake answers from a table the test writes), and rate limits.
 */
let privateKeyPem: string;
beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});

const json = (status: number, body: unknown): GhReply => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
// Account ACCOUNT owns installation 42, the one the strict server names for acme/widgets.
const OWNS = async (account: string, id: number) => account === ACCOUNT && id === 42;
const HEAD = "a".repeat(40);
const TIP = "b".repeat(40);
const BRANCH = "fx/p-0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";

let server: LocalTlsServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

interface World {
  branchHead?: string | null;
  parents?: string[];
  compare?: string;
  pr?: unknown;
  /** Make the named read answer 500. */
  fail?: "ref" | "commit" | "compare" | "pulls" | "list";
  /** What `GET /pulls?state=open&head=...` answers (a list of pull requests as GitHub shapes them). */
  list?: unknown;
  /** With fail "pulls": answer with the failure only for the first N reads of the pull request, then answer normally (a blip). */
  failFirst?: number;
  /** With fail "pulls": the status to fail with (default 500). */
  failStatus?: number;
  /** How `POST /pulls` answers: created (the default), refused for good (422), or down (503). */
  create?: "ok" | "refused" | "down";
  /** What the mint answer says the token holds, given what was asked (default: exactly what was asked, plus the implicit metadata read). */
  answerPermissions?: (asked: Record<string, string>) => Record<string, string>;
}

async function setup(world: World, expiresInMs = 3_600_000, now?: () => number) {
  const revoked = new Set<string>();
  let pullReads = 0;
  const route = (r: GhRequest): GhReply | undefined => {
    const bearer = /^Bearer (\S+)$/.exec(r.headers["authorization"] ?? "")?.[1];
    if (r.method === "DELETE" && r.path === "/installation/token") {
      if (bearer) revoked.add(bearer);
      return { status: 204, headers: {}, body: "" };
    }
    if (r.path === "/repos/acme/widgets/installation") return json(200, { id: 42 });
    if (bearer !== undefined && revoked.has(bearer)) return ghError(401, "Bad credentials");
    if (r.path === `/repos/acme/widgets/git/ref/heads/${BRANCH}`) {
      if (world.fail === "ref") return ghError(500, "boom");
      return world.branchHead === null || world.branchHead === undefined ? ghError(404, "Not Found") : json(200, { object: { sha: world.branchHead } });
    }
    if (r.path === `/repos/acme/widgets/git/commits/${HEAD}`) return world.fail === "commit" ? ghError(500, "boom") : json(200, { sha: HEAD, parents: (world.parents ?? [TIP]).map((sha) => ({ sha })) });
    if (r.path === `/repos/acme/widgets/compare/main...${TIP}`) return world.fail === "compare" ? ghError(500, "boom") : json(200, { status: world.compare ?? "behind" });
    if (r.method === "POST" && r.path === "/repos/acme/widgets/pulls") {
      if (world.create === "refused") return ghError(422, "Validation Failed");
      if (world.create === "down") return ghError(503, "unavailable");
      return json(201, { number: 9, html_url: "https://github.com/acme/widgets/pull/9" });
    }
    if (r.method === "GET" && r.path === "/repos/acme/widgets/pulls") {
      if (world.fail === "list") return ghError(500, "boom");
      return json(200, world.list ?? []);
    }
    if (r.path === "/repos/acme/widgets/pulls/9") return world.fail === "pulls" && (world.failFirst === undefined || ++pullReads <= world.failFirst) ? ghError(world.failStatus ?? 500, "boom") : world.pr === undefined ? ghError(404, "Not Found") : json(200, world.pr);
    return undefined;
  };
  server = await startStrictGithubServer((req) => route(req) ?? ghError(404, "Not Found"));
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
  let n = 0;
  const mintedTokens: string[] = [];
  const requested: Array<{ permissions: Record<string, string>; repositories: string[] }> = [];
  const requester: AccessTokenRequester = async (p) => {
    const token = `ghs_hosted${++n}`;
    mintedTokens.push(token);
    requested.push({ permissions: { ...(p.permissions as Record<string, string>) }, repositories: [...(p.repositories ?? [])] });
    const asked = { metadata: "read", ...p.permissions } as Record<string, string>;
    return { token, expiresAt: new Date(Date.now() + expiresInMs).toISOString(), permissions: world.answerPermissions ? world.answerPermissions(asked) : asked, repositories: (p.repositories ?? []).map((x) => x) };
  };
  const api = createPlanePushApi({ appCredentials: () => ({ appId: "12345", privateKeyPem, webhookSecret: "unused" }), requester, cache: new InstallationTokenCache(), fetchImpl });
  const hosted = createHostedPlanePush(api, { ...(now ? { now } : {}), ownsInstallation: OWNS });
  /** The order of calls that carried one of the minted tokens, plus the revokes. */
  const trail = () => s.seen.filter((x) => x.path !== "/repos/acme/widgets/installation").map((x) => `${x.method} ${x.path} ${x.headers["authorization"]?.replace("Bearer ", "")}`);
  return { hosted, server: s, mintedTokens, requested, trail, revoked };
}

const pr = (over: Record<string, unknown> = {}) => ({
  number: 9,
  state: "open",
  merged: false,
  html_url: "https://github.com/acme/widgets/pull/9",
  head: { ref: BRANCH, repo: { full_name: "acme/widgets" } },
  base: { ref: "main" },
  ...over,
});

describe("verifyPushed", () => {
  const ask = (t: Awaited<ReturnType<typeof setup>>, over: Partial<{ headSha: string; tipSha: string }> = {}) => t.hosted.verifyPushed({ accountId: ACCOUNT, codeRepo: "acme/widgets", branch: BRANCH, headSha: HEAD, tipSha: TIP, ...over });

  it("is true when the head is the reported one, has one parent which is the tip, and the tip is in main's history", async () => {
    const t = await setup({ branchHead: HEAD });
    await expect(ask(t)).resolves.toBe(true);
    await expect(ask(await setup({ branchHead: HEAD, compare: "identical" }))).resolves.toBe(true);
  });

  it.each([
    ["the branch does not exist", { branchHead: null }],
    ["the branch head is another commit", { branchHead: "c".repeat(40) }],
    ["the head has two parents", { branchHead: HEAD, parents: [TIP, "c".repeat(40)] }],
    ["the head's parent is not the reported tip", { branchHead: HEAD, parents: ["c".repeat(40)] }],
    ["the head has no parent", { branchHead: HEAD, parents: [] }],
    ["the tip is ahead of main", { branchHead: HEAD, compare: "ahead" }],
    ["the tip has diverged from main", { branchHead: HEAD, compare: "diverged" }],
  ] as Array<[string, World]>)("is false when %s", async (_l, world) => {
    await expect(ask(await setup(world))).resolves.toBe(false);
  });

  it("mints one token, uses it only for its reads, then revokes it: afterwards that token answers 401", async () => {
    const t = await setup({ branchHead: HEAD });
    await ask(t);
    expect(t.mintedTokens).toEqual(["ghs_hosted1"]);
    const trail = t.trail();
    expect(trail.at(-1)).toBe("DELETE /installation/token ghs_hosted1");
    expect(trail.slice(0, -1).every((x) => x.endsWith(" ghs_hosted1"))).toBe(true);
    expect(trail).toHaveLength(4);
    expect(t.revoked.has("ghs_hosted1")).toBe(true);
  });

  it("revokes even when a read fails, and a failed read is a throw (unavailable), never a false", async () => {
    for (const fail of ["ref", "commit", "compare"] as const) {
      const t = await setup({ branchHead: HEAD, fail });
      await expect(ask(t)).rejects.toMatchObject({ code: "public_unavailable" });
      expect(t.trail().at(-1)).toBe("DELETE /installation/token ghs_hosted1");
    }
  });

  it("uses a new token for every call", async () => {
    const t = await setup({ branchHead: HEAD });
    await ask(t);
    await ask(t);
    expect(t.mintedTokens).toEqual(["ghs_hosted1", "ghs_hosted2"]);
  });
});

describe("findOpenPullRequest (D#6 PLANE-PUSH-REVERIFY-BOUND)", () => {
  const listed = (over: Record<string, unknown> = {}) => ({
    number: 9,
    state: "open",
    html_url: "https://github.com/acme/widgets/pull/9",
    head: { ref: BRANCH, sha: HEAD, repo: { full_name: "acme/widgets" } },
    base: { ref: "main" },
    ...over,
  });
  const ask = (t: Awaited<ReturnType<typeof setup>>, headSha = HEAD) => t.hosted.findOpenPullRequest({ accountId: ACCOUNT, codeRepo: "acme/widgets", branch: BRANCH, headSha });

  it("finds the one open pull request that is exactly the recorded push, with one list read under one token that is then revoked", async () => {
    const t = await setup({ list: [listed()] });
    await expect(ask(t)).resolves.toEqual({ number: 9, url: "https://github.com/acme/widgets/pull/9" });
    const reads = t.server.seen.filter((x) => x.method === "GET" && x.path === "/repos/acme/widgets/pulls");
    expect(reads).toHaveLength(1);
    expect(reads[0]!.query).toContain("state=open");
    expect(reads[0]!.query).toContain(`head=acme%3A${encodeURIComponent(BRANCH)}`);
    expect(t.trail().at(-1)).toBe("DELETE /installation/token ghs_hosted1");
  });

  it.each([
    ["no pull request is open", []],
    ["two pull requests are open on the branch", [listed(), listed({ number: 10, html_url: "https://github.com/acme/widgets/pull/10" })]],
    ["the pull request is from a fork", [listed({ head: { ref: BRANCH, sha: HEAD, repo: { full_name: "evil/widgets" } } })]],
    ["the pull request's repository is gone", [listed({ head: { ref: BRANCH, sha: HEAD, repo: null } })]],
    ["the base is not main", [listed({ base: { ref: "release" } })]],
    ["the head ref is another branch", [listed({ head: { ref: "fx/p-other", sha: HEAD, repo: { full_name: "acme/widgets" } } })]],
    ["the head is another commit than the recorded one", [listed({ head: { ref: BRANCH, sha: "c".repeat(40), repo: { full_name: "acme/widgets" } } })]],
    ["the address is in another repository", [listed({ html_url: "https://github.com/evil/widgets/pull/9" })]],
    ["the address is another pull request's", [listed({ html_url: "https://github.com/acme/widgets/pull/10" })]],
  ] as Array<[string, unknown[]]>)("is null when %s", async (_l, list) => {
    await expect(ask(await setup({ list }))).resolves.toBeNull();
  });

  it("a failed read is a throw (unavailable), never a null, and the token is still revoked", async () => {
    const t = await setup({ fail: "list" });
    await expect(ask(t)).rejects.toMatchObject({ code: "public_unavailable" });
    expect(t.trail().at(-1)).toBe("DELETE /installation/token ghs_hosted1");
  });
});

describe("verifyPullRequest", () => {
  const ask = (t: Awaited<ReturnType<typeof setup>>) => t.hosted.verifyPullRequest({ accountId: ACCOUNT, codeRepo: "acme/widgets", branch: BRANCH, number: 9 });

  it("answers the address when the head ref and repository and the base match, and revokes its token", async () => {
    const t = await setup({ pr: pr() });
    await expect(ask(t)).resolves.toEqual({ url: "https://github.com/acme/widgets/pull/9" });
    expect(t.trail().at(-1)).toBe("DELETE /installation/token ghs_hosted1");
  });

  it.each([
    ["no such pull request", undefined],
    ["another head branch", pr({ head: { ref: "fx/other", repo: { full_name: "acme/widgets" } } })],
    ["a head in a fork", pr({ head: { ref: BRANCH, repo: { full_name: "evil/widgets" } } })],
    ["a deleted head repository", pr({ head: { ref: BRANCH, repo: null } })],
    ["another base", pr({ base: { ref: "develop" } })],
    ["a closed pull request", pr({ state: "closed" })],
    ["a merged pull request", pr({ state: "closed", merged: true })],
    ["a state GitHub does not say", pr({ state: undefined })],
    ["an address in another repository (pr_url must match the row's code_repo)", pr({ html_url: "https://github.com/evil/widgets/pull/9" })],
    ["an address for another number", pr({ html_url: "https://github.com/acme/widgets/pull/10" })],
  ])("is null for %s", async (_l, body) => {
    await expect(ask(await setup({ pr: body }))).resolves.toBeNull();
  });

  it("matches the repository name case-insensitively, as GitHub does", async () => {
    const t = await setup({ pr: pr({ html_url: "https://github.com/Acme/Widgets/pull/9", head: { ref: BRANCH, repo: { full_name: "Acme/Widgets" } } }) });
    await expect(ask(t)).resolves.toEqual({ url: "https://github.com/Acme/Widgets/pull/9" });
  });

  it("a failed read throws and still revokes", async () => {
    const t = await setup({ pr: pr(), fail: "pulls" });
    await expect(ask(t)).rejects.toMatchObject({ code: "public_unavailable" });
    expect(t.trail().at(-1)).toBe("DELETE /installation/token ghs_hosted1");
  });
});

describe("pullRequestState (D#6 REPUBLISH-CLOSED-PR)", () => {
  const ask = (t: Awaited<ReturnType<typeof setup>>) => t.hosted.pullRequestState({ accountId: ACCOUNT, codeRepo: "acme/widgets", number: 9 });

  it.each([
    ["open", pr(), "open"],
    ["closed without merging", pr({ state: "closed", merged: false }), "closed"],
    ["closed by a merge (GitHub says state closed, merged true)", pr({ state: "closed", merged: true }), "merged"],
    ["a state GitHub does not say", pr({ state: undefined }), "unknown"],
    ["no such pull request (404)", undefined, "unknown"],
  ])("says %s", async (_l, body, want) => {
    const t = await setup({ pr: body });
    await expect(ask(t)).resolves.toBe(want);
    expect(t.trail().at(-1)).toBe("DELETE /installation/token ghs_hosted1");
    expect(t.server.seen.every((r) => r.headers["user-agent"] === "fulcrumaxe-cloud")).toBe(true);
  });

  it("does not ask the head, the base or the address: a pull request of another branch still answers its own state", async () => {
    await expect(ask(await setup({ pr: pr({ state: "closed", head: { ref: "fx/other", repo: { full_name: "evil/widgets" } }, base: { ref: "develop" } }) }))).resolves.toBe("closed");
  });

  it("a 500 and a 200 that is not a pull request throw (never closed), and the token is still revoked", async () => {
    const t = await setup({ pr: pr(), fail: "pulls" });
    await expect(ask(t)).rejects.toMatchObject({ code: "public_unavailable" });
    expect(t.trail().at(-1)).toBe("DELETE /installation/token ghs_hosted1");
    await expect(ask(await setup({ pr: "not an object" }))).rejects.toMatchObject({ code: "public_unavailable" });
  });

  // D#6 REPUBLISH-TRANSIENT-RETRY: counted with the strict server's own request log (one token, N reads of the pull request, one revoke).
  const pullReadsOf = (t: Awaited<ReturnType<typeof setup>>) => t.server.seen.filter((x) => x.path === "/repos/acme/widgets/pulls/9").length;
  it.each([1, 2])("a 5xx that passes after %i failed read(s) answers the real state, on ONE token that is revoked once", async (n) => {
    const t = await setup({ pr: pr({ state: "closed", merged: true }), fail: "pulls", failFirst: n });
    await expect(ask(t)).resolves.toBe("merged");
    expect(pullReadsOf(t)).toBe(n + 1);
    expect(t.mintedTokens).toHaveLength(1);
    expect(t.trail().filter((x) => x.startsWith("DELETE"))).toHaveLength(1);
  });
  it("a 5xx that never passes is read exactly three times, then throws the same public_unavailable (fail closed), token revoked", async () => {
    const t = await setup({ pr: pr(), fail: "pulls" });
    await expect(ask(t)).rejects.toMatchObject({ code: "public_unavailable" });
    expect(pullReadsOf(t)).toBe(3);
    expect(t.mintedTokens).toHaveLength(1);
    expect(t.trail().at(-1)).toBe("DELETE /installation/token ghs_hosted1");
  });
  it.each([401, 403, 422, 429])("a %i is an answer, not a blip: one read, no retry, still public_unavailable", async (status) => {
    const t = await setup({ pr: pr(), fail: "pulls", failStatus: status });
    await expect(ask(t)).rejects.toMatchObject({ code: "public_unavailable" });
    expect(pullReadsOf(t)).toBe(1);
  });
  it("a 404 is unknown after one read", async () => {
    const t = await setup({});
    await expect(ask(t)).resolves.toBe("unknown");
    expect(pullReadsOf(t)).toBe(1);
  });

  it("the existing verifyPullRequest still answers null for a closed or merged pull request", async () => {
    for (const body of [pr({ state: "closed" }), pr({ state: "closed", merged: true })]) {
      await expect((await setup({ pr: body })).hosted.verifyPullRequest({ accountId: ACCOUNT, codeRepo: "acme/widgets", branch: BRANCH, number: 9 })).resolves.toBeNull();
    }
  });

  it("another account's installation is refused before any read", async () => {
    const t = await setup({ pr: pr() });
    await expect(t.hosted.pullRequestState({ accountId: "22222222-2222-4222-8222-222222222222", codeRepo: "acme/widgets", number: 9 })).rejects.toMatchObject({ code: "code_repo_installation_not_owned" });
    expect(t.server.seen.every((r) => r.path === "/repos/acme/widgets/installation")).toBe(true);
  });
});

describe("pullRequestBase (D#6 STACK-THREE-DEEP)", () => {
  const ask = (t: Awaited<ReturnType<typeof setup>>) => t.hosted.pullRequestBase({ accountId: ACCOUNT, codeRepo: "acme/widgets", number: 9 });

  it.each([
    ["merged into the default branch", pr({ state: "closed", merged: true, base: { ref: "main", repo: { default_branch: "main" } } }), { state: "closed", merged: true, baseRef: "main", defaultBranch: "main" }],
    ["merged into another branch", pr({ state: "closed", merged: true, base: { ref: "fx/grandparent", repo: { default_branch: "main" } } }), { state: "closed", merged: true, baseRef: "fx/grandparent", defaultBranch: "main" }],
    ["closed without merging", pr({ state: "closed", merged: false, base: { ref: "main", repo: { default_branch: "main" } } }), { state: "closed", merged: false, baseRef: "main", defaultBranch: "main" }],
    ["open", pr({ base: { ref: "main", repo: { default_branch: "main" } } }), { state: "open", merged: false, baseRef: "main", defaultBranch: "main" }],
    ["a read that does not show the default branch", pr({ state: "closed", merged: true, base: { ref: "main" } }), { state: "closed", merged: true, baseRef: "main", defaultBranch: "" }],
  ])("says %s", async (_l, body, want) => {
    const t = await setup({ pr: body });
    await expect(ask(t)).resolves.toEqual(want);
    expect(t.trail().at(-1)).toBe("DELETE /installation/token ghs_hosted1");
  });

  it("no such pull request answers null; a 500, a body that is not a pull request and a state GitHub does not name throw (never merged), with the token revoked", async () => {
    await expect(ask(await setup({ pr: undefined }))).resolves.toBeNull();
    const t = await setup({ pr: pr(), fail: "pulls" });
    // A 5xx is flagged as a blip (REPUBLISH-TRANSIENT-RETRY reads again); a body that is not a pull request is not.
    await expect(ask(t)).rejects.toMatchObject({ code: "public_unavailable", transient: true });
    expect(t.trail().at(-1)).toBe("DELETE /installation/token ghs_hosted1");
    await expect(ask(await setup({ pr: "not an object" }))).rejects.toMatchObject({ code: "public_unavailable", transient: false });
    await expect(ask(await setup({ pr: pr({ state: undefined }) }))).rejects.toMatchObject({ code: "public_unavailable" });
  });

  it("another account's installation is refused before any read", async () => {
    const t = await setup({ pr: pr() });
    await expect(t.hosted.pullRequestBase({ accountId: "22222222-2222-4222-8222-222222222222", codeRepo: "acme/widgets", number: 9 })).rejects.toMatchObject({ code: "code_repo_installation_not_owned" });
    expect(t.server.seen.every((r) => r.path === "/repos/acme/widgets/installation")).toBe(true);
  });
});

describe("branchHead (the record module's port)", () => {
  it("reads through a fresh token that is revoked after, and answers null for no branch", async () => {
    const t = await setup({ branchHead: HEAD });
    await expect(t.hosted.branchHead({ accountId: ACCOUNT, codeRepo: "acme/widgets", branch: BRANCH })).resolves.toBe(HEAD);
    expect(t.trail().at(-1)).toBe("DELETE /installation/token ghs_hosted1");
    const none = await setup({ branchHead: null });
    await expect(none.hosted.branchHead({ accountId: ACCOUNT, codeRepo: "acme/widgets", branch: BRANCH })).resolves.toBeNull();
  });
});

describe("revokeToken", () => {
  it("revokes a token mintToken handed out: GitHub then answers 401 for it", async () => {
    const t = await setup({}, 3_600_000, () => Date.now());
    const minted = await t.hosted.mintToken("acme/widgets", ACCOUNT);
    await expect(t.hosted.revokeToken(minted.token)).resolves.toBe(true);
    expect(t.revoked.has(minted.token)).toBe(true);
    expect(t.trail().at(-1)).toBe(`DELETE /installation/token ${minted.token}`);
  });
});

describe("mintToken", () => {
  const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);

  it("hands out a token and does NOT revoke it (the runner holds it); no delete reaches GitHub", async () => {
    const t = await setup({}, 3_600_000, () => T0);
    const minted = await t.hosted.mintToken("acme/widgets", ACCOUNT);
    expect(minted.token).toBe("ghs_hosted1");
    expect(t.server.seen.some((s) => s.method === "DELETE")).toBe(false);
  });

  it("expires at the smaller of GitHub's expiry minus 5 minutes and 55 minutes from now", async () => {
    const full = await setup({}, 3_600_000, () => Date.now());
    const a = await full.hosted.mintToken("acme/widgets", ACCOUNT);
    expect(Math.abs(a.expiresAt.getTime() - (Date.now() + PLANE_PUSH_TOKEN_MAX_LIFETIME_MS))).toBeLessThan(5_000);
    await server?.close();
    const short = await setup({}, 20 * 60_000, () => Date.now());
    const b = await short.hosted.mintToken("acme/widgets", ACCOUNT);
    expect(Math.abs(b.expiresAt.getTime() - (Date.now() + 15 * 60_000))).toBeLessThan(5_000);
  });

  it("passes a mint failure on as its fixed code", async () => {
    server = await startStrictGithubServer(() => ghError(404, "Not Found"));
    const s = server;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const r = await httpsRoundTrip({ host: "api.github.com", port: s.port, path: url.pathname, method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, ca: s.ca, servername: "api.github.com", lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never }, undefined);
      return new Response(r.body, { status: r.status, headers: r.headers });
    }) as typeof fetch;
    const api = createPlanePushApi({ appCredentials: () => ({ appId: "1", privateKeyPem, webhookSecret: "x" }), requester: async () => { throw new Error("unused"); }, cache: new InstallationTokenCache(), fetchImpl });
    await expect(createHostedPlanePush(api, { ownsInstallation: OWNS }).mintToken("acme/widgets", ACCOUNT)).rejects.toMatchObject({ code: "app_not_installed" });
  });
});

describe("mintMergeToken (a merge order's two credentials)", () => {
  it("read: one repository, contents read and nothing else; write: contents write ONLY (no pull requests write); neither is revoked by the hosted side (the runner holds it)", async () => {
    const t = await setup({});
    const read = await t.hosted.mintMergeToken("acme/widgets", ACCOUNT, "read");
    const write = await t.hosted.mintMergeToken("acme/widgets", ACCOUNT, "write");
    expect(read.token).not.toBe(write.token);
    expect(t.requested).toEqual([
      { permissions: { metadata: "read", contents: "read" }, repositories: ["widgets"] },
      { permissions: { contents: "write" }, repositories: ["widgets"] },
    ]);
    expect(t.server.seen.some((x) => x.method === "DELETE")).toBe(false);
    // Each call is a new mint, never a cached token.
    const again = await t.hosted.mintMergeToken("acme/widgets", ACCOUNT, "write");
    expect(again.token).not.toBe(write.token);
  });

  it("refuses a read token made wider than asked, and a write token that carries an extra permission, and hands out neither", async () => {
    const wide = await setup({ answerPermissions: (a) => ({ ...a, contents: "write" }) });
    await expect(wide.hosted.mintMergeToken("acme/widgets", ACCOUNT, "read")).rejects.toMatchObject({ code: "token_scope_mismatch" });
    const extra = await setup({ answerPermissions: (a) => ({ ...a, issues: "write" }) });
    await expect(extra.hosted.mintMergeToken("acme/widgets", ACCOUNT, "write")).rejects.toMatchObject({ code: "token_scope_mismatch" });
  });

  it("mints nothing for an account that does not own the installation", async () => {
    const t = await setup({});
    await expect(t.hosted.mintMergeToken("acme/widgets", "22222222-2222-4222-8222-222222222222", "write")).rejects.toMatchObject({ code: "code_repo_installation_not_owned" });
    await expect(t.hosted.mintMergeToken("acme/widgets", "22222222-2222-4222-8222-222222222222", "read")).rejects.toMatchObject({ code: "code_repo_installation_not_owned" });
    expect(t.mintedTokens).toEqual([]);
  });

  it("expires at the smaller of GitHub's expiry minus 5 minutes and 55 minutes from now, like the push token", async () => {
    const short = await setup({}, 20 * 60_000, () => Date.now());
    const b = await short.hosted.mintMergeToken("acme/widgets", ACCOUNT, "write");
    expect(Math.abs(b.expiresAt.getTime() - (Date.now() + 15 * 60_000))).toBeLessThan(5_000);
  });
});

describe("installation ownership", () => {
  const OTHER = "22222222-2222-4222-8222-222222222222";

  it("mints nothing for an account that does not own the repository's installation, on every path that mints", async () => {
    const t = await setup({ branchHead: HEAD });
    await expect(t.hosted.mintToken("acme/widgets", OTHER)).rejects.toMatchObject({ code: "code_repo_installation_not_owned" });
    await expect(t.hosted.branchHead({ accountId: OTHER, codeRepo: "acme/widgets", branch: BRANCH })).rejects.toMatchObject({ code: "code_repo_installation_not_owned" });
    await expect(t.hosted.verifyPushed({ accountId: OTHER, codeRepo: "acme/widgets", branch: BRANCH, headSha: HEAD, tipSha: TIP })).rejects.toMatchObject({ code: "code_repo_installation_not_owned" });
    await expect(t.hosted.verifyPullRequest({ accountId: OTHER, codeRepo: "acme/widgets", branch: BRANCH, number: 9 })).rejects.toMatchObject({ code: "code_repo_installation_not_owned" });
    await expect(t.hosted.openPullRequest({ accountId: OTHER, codeRepo: "acme/widgets", branch: BRANCH, title: "t", body: "b" })).rejects.toMatchObject({ code: "code_repo_installation_not_owned" });
    expect(t.mintedTokens).toEqual([]);
    expect(t.server.seen.every((s) => s.path === "/repos/acme/widgets/installation")).toBe(true);
  });

  it("works for the owning account", async () => {
    const t = await setup({ branchHead: HEAD });
    await expect(t.hosted.branchHead({ accountId: ACCOUNT, codeRepo: "acme/widgets", branch: BRANCH })).resolves.toBe(HEAD);
    expect(t.mintedTokens).toHaveLength(1);
  });
});

describe("openPullRequest (D#598 P1f-5c)", () => {
  const open = (t: Awaited<ReturnType<typeof setup>>) => t.hosted.openPullRequest({ accountId: ACCOUNT, codeRepo: "acme/widgets", branch: BRANCH, title: "Add a thing", body: "Body text" });

  it("opens the pull request on the pushed branch against main with one fresh token, then revokes it; nothing is pushed", async () => {
    const t = await setup({});
    await expect(open(t)).resolves.toEqual({ number: 9, url: "https://github.com/acme/widgets/pull/9" });
    const posts = t.server.seen.filter((x) => x.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.body)).toMatchObject({ title: "Add a thing", head: BRANCH, base: "main", body: "Body text", maintainer_can_modify: false });
    expect(t.mintedTokens).toEqual(["ghs_hosted1"]);
    expect(t.trail().at(-1)).toBe("DELETE /installation/token ghs_hosted1");
    // No git smart-http request reached the server: the retry is an API call only.
    expect(t.server.seen.some((x) => /git-(upload|receive)-pack/.test(x.path))).toBe(false);
  });

  it("a refusal is pr_failed and a GitHub that is down is public_unavailable; the token is revoked either way and still answers 401", async () => {
    for (const [create, code] of [["refused", "pr_failed"], ["down", "public_unavailable"]] as const) {
      const t = await setup({ create });
      await expect(open(t)).rejects.toMatchObject({ code });
      expect(t.trail().at(-1)).toBe("DELETE /installation/token ghs_hosted1");
      expect(t.revoked.has("ghs_hosted1")).toBe(true);
      await server?.close();
    }
  });
});

describe("closeRefusedPullRequest (D#6 CHECKFIX-SUCCESS-AS-FAILED)", () => {
  /** The hosted layer over a recording stand-in for the API: what matters here is the token's life (minted for the account's own installation, revoked after the call, whatever it did). */
  function stub(close: () => Promise<unknown>) {
    const trail: string[] = [];
    const api = {
      mintPushToken: async (_repo: string, opts: { ownsInstallation: (id: number) => Promise<boolean> }) => {
        if (!(await opts.ownsInstallation(42))) throw new PlanePushApiError("code_repo_installation_not_owned");
        trail.push("mint");
        return "ghs_close1";
      },
      revokeToken: async (token: string) => (trail.push(`revoke ${token}`), true),
      closeRefusedPullRequest: async (input: Record<string, unknown>) => (trail.push(`close ${String(input.codeRepo)}#${String(input.number)} ${String(input.branch)} ${String(input.token)} ${String(input.comment)}`), close()),
    };
    return { trail, hosted: createHostedPlanePush(api as never, { ownsInstallation: async (accountId, id) => accountId === ACCOUNT && id === 42 }) };
  }
  const input = { accountId: ACCOUNT, codeRepo: "acme/widgets", number: 41, branch: "fx/p-11111111-1111-4111-8111-111111111111", comment: "Closed by the scope check." };

  it("closes with a fresh token for the account's own installation and revokes it before returning", async () => {
    const t = stub(async () => ({ result: "closed", commented: true }));
    await expect(t.hosted.closeRefusedPullRequest(input)).resolves.toEqual({ result: "closed", commented: true });
    expect(t.trail).toEqual(["mint", "close acme/widgets#41 fx/p-11111111-1111-4111-8111-111111111111 ghs_close1 Closed by the scope check.", "revoke ghs_close1"]);
  });

  it("revokes the token when the close throws, and passes the error on unchanged", async () => {
    const t = stub(async () => {
      throw new PlanePushApiError("public_unavailable", true);
    });
    await expect(t.hosted.closeRefusedPullRequest(input)).rejects.toMatchObject({ code: "public_unavailable", transient: true });
    expect(t.trail.at(-1)).toBe("revoke ghs_close1");
  });

  it("another account's installation is refused before any call", async () => {
    const t = stub(async () => ({ result: "not_open" }));
    await expect(t.hosted.closeRefusedPullRequest({ ...input, accountId: "22222222-2222-4222-8222-222222222222" })).rejects.toMatchObject({ code: "code_repo_installation_not_owned" });
    expect(t.trail).toEqual([]);
  });
});
