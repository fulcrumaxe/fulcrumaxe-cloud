import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { exportJWK, SignJWT } from "jose";
import { InstallationTokenCache, type AccessTokenRequester } from "../src/installationToken.js";
import { createInstallationHttp } from "../src/installationHttp.js";
import { BRANCH_DELETE_TYP, BranchDeleteTokenError, BranchDeleteUnavailableError, deleteBranchWithToken, mintBranchDeleteToken, redeemBranchDeleteToken, type BranchDeleteGrant } from "../src/branchDeleteToken.js";
import { createRunnerGitTicketKeys, verifyRunnerGitTicket, type RunnerGitTicketSigner } from "../src/runnerGitTicket.js";
import { ghError, type GhReply, type GhRequest } from "./helpers/strictGithub.js";
import { httpsRoundTrip, startStrictGithubServer, type LocalTlsServer } from "./helpers/localTlsServer.js";

/**
 * D#598 P1f-5d: the delete-only token and the branch removal behind it, over Node's real TLS connect path against the strict GitHub server (User-Agent
 * required, Authorization forms, the real status codes: 204 on delete, 404 for a ref that is not there, 422 for a ref that cannot be deleted).
 *
 * What this cannot fake faithfully: that GitHub narrows an installation token to the permissions named at mint time (the `greedy` requester plays a
 * GitHub that ignored them, to prove our check notices), the exact wording of its errors, and the 422 text for a protected branch (the code reads the ref
 * again instead of parsing the message).
 */
const ITEM_BRANCH = "fx/issue-41";
const RUN = "0f7c1b52-4d8a-4c3e-9b1d-2a6e5f8c9d10";
const RUN_BRANCH = `fx/${RUN}-g2`;
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const grant = (over: Partial<BranchDeleteGrant> = {}): BranchDeleteGrant => ({
  accountId: randomUUID(), workItemId: randomUUID(), repo: { id: randomUUID(), owner: "acme", name: "widgets" }, branch: ITEM_BRANCH, sha: HEAD, ...over,
});

let appKeyPem: string;
let signer: RunnerGitTicketSigner;
beforeAll(() => {
  appKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
  signer = { keyId: "ticket-key-1", privateKey: generateKeyPairSync("ed25519").privateKey };
});

const json = (status: number, body: unknown): GhReply => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
let server: LocalTlsServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A GitHub holding `refs` (branch to head) on acme/widgets, whose default branch is `main`; `protectedRefs` answer a delete with 422. */
async function setup(opts: { refs?: Record<string, string>; protectedRefs?: string[]; down?: boolean; greedy?: boolean; repoGone?: boolean } = {}) {
  const refs = { ...(opts.refs ?? {}) };
  server = await startStrictGithubServer((req: GhRequest) => {
    if (opts.down) return ghError(503, "Service Unavailable");
    if (req.method === "GET" && req.path === "/repos/acme/widgets" && opts.repoGone) return ghError(404, "Not Found");
    if (req.method === "GET" && req.path === "/repos/acme/widgets") return json(200, { full_name: "acme/widgets", default_branch: "main" });
    const ref = /^\/repos\/acme\/widgets\/git\/refs?\/heads\/(.+)$/.exec(req.path)?.[1];
    if (req.method === "GET" && ref) return ref in refs ? json(200, { ref: `refs/heads/${ref}`, object: { sha: refs[ref], type: "commit" } }) : ghError(404, "Not Found");
    if (req.method === "DELETE" && ref && req.path.includes("/git/refs/heads/")) {
      if (!(ref in refs)) return ghError(422, "Reference does not exist");
      if (opts.protectedRefs?.includes(ref)) return ghError(422, "Cannot delete protected branch");
      delete refs[ref];
      return { status: 204, headers: {}, body: "" };
    }
    if (req.method === "DELETE" && req.path === "/installation/token") return { status: 204, headers: {}, body: "" };
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
    return { token: "ghs_branchdelete1", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: (opts.greedy ? { metadata: "read", contents: "write", pull_requests: "write" } : { metadata: "read", ...p.permissions }) as Record<string, string>, repositories: p.repositories ?? [] };
  };
  const open = createInstallationHttp({
    resolveInstallation: async () => ({ installationId: 42, appKind: "team" }),
    appCredentials: () => ({ appId: "12345", privateKeyPem: appKeyPem, webhookSecret: "unused" }),
    requester,
    cache: new InstallationTokenCache(),
    fetchImpl,
  });
  const seen = () => s.seen.map((r) => `${r.method} ${r.path}`);
  return { deps: { signer, open }, refs, minted, seen, server: s };
}

describe("deleteBranchWithToken", () => {
  it("removes an item branch and a run branch whose head is the recorded one, with a contents-write token for the one repository that is revoked afterwards", async () => {
    const t = await setup({ refs: { [ITEM_BRANCH]: HEAD, [RUN_BRANCH]: HEAD, main: MOVED } });
    for (const branch of [ITEM_BRANCH, RUN_BRANCH]) {
      expect(await deleteBranchWithToken(await mintBranchDeleteToken(grant({ branch }), signer, new Date()), t.deps)).toBe("deleted");
    }
    expect(t.refs).toEqual({ main: MOVED });
    expect(t.minted).toHaveLength(2);
    expect(t.minted[0]).toMatchObject({ repositories: ["widgets"], permissions: { contents: "write" } });
    expect(Object.keys(t.minted[0]!.permissions)).toEqual(["contents"]);
    expect(t.seen()).toEqual([
      "GET /repos/acme/widgets", `GET /repos/acme/widgets/git/ref/heads/${ITEM_BRANCH}`, `DELETE /repos/acme/widgets/git/refs/heads/${ITEM_BRANCH}`, "DELETE /installation/token",
      "GET /repos/acme/widgets", `GET /repos/acme/widgets/git/ref/heads/${RUN_BRANCH}`, `DELETE /repos/acme/widgets/git/refs/heads/${RUN_BRANCH}`, "DELETE /installation/token",
    ]);
    // The strict server refused nothing: every call carried a User-Agent and a Bearer token.
    expect(t.server.seen.every((r) => r.headers["user-agent"] === "fulcrumaxe-cloud" && r.headers["authorization"] === "Bearer ghs_branchdelete1")).toBe(true);
  });

  it("a replay finds the branch gone (404) and deletes nothing twice; a delete that answers 404 or a 422 for a ref that is gone also reads as already gone", async () => {
    const t = await setup({ refs: { [ITEM_BRANCH]: HEAD } });
    const once = () => mintBranchDeleteToken(grant(), signer, new Date()).then((tok) => deleteBranchWithToken(tok, t.deps));
    expect(await once()).toBe("deleted");
    expect(await once()).toBe("already_gone");
    expect(t.seen().filter((c) => c.startsWith("DELETE /repos"))).toHaveLength(1);
  });

  it("leaves a branch whose head is not the recorded one, with no delete call", async () => {
    const t = await setup({ refs: { [ITEM_BRANCH]: MOVED } });
    expect(await deleteBranchWithToken(await mintBranchDeleteToken(grant(), signer, new Date()), t.deps)).toBe("head_changed");
    expect(t.refs).toEqual({ [ITEM_BRANCH]: MOVED });
    expect(t.seen().some((c) => c.startsWith("DELETE /repos"))).toBe(false);
  });

  it("leaves a protected branch (GitHub answers 422 and the ref is still there) and never forces it", async () => {
    const t = await setup({ refs: { [ITEM_BRANCH]: HEAD }, protectedRefs: [ITEM_BRANCH] });
    expect(await deleteBranchWithToken(await mintBranchDeleteToken(grant(), signer, new Date()), t.deps)).toBe("protected");
    expect(t.refs).toEqual({ [ITEM_BRANCH]: HEAD });
  });

  it("answers unavailable (and leaves the branch) when GitHub cannot answer, and revokes its token anyway", async () => {
    const t = await setup({ refs: { [ITEM_BRANCH]: HEAD }, down: true });
    await expect(deleteBranchWithToken(await mintBranchDeleteToken(grant(), signer, new Date()), t.deps)).rejects.toBeInstanceOf(BranchDeleteUnavailableError);
    expect(t.seen().at(-1)).toBe("DELETE /installation/token");
  });

  it("refuses a token GitHub minted wider than contents:write on the one repository, revokes that token at once, and makes no call to the repository", async () => {
    const t = await setup({ refs: { [ITEM_BRANCH]: HEAD }, greedy: true });
    await expect(deleteBranchWithToken(await mintBranchDeleteToken(grant(), signer, new Date()), t.deps)).rejects.toThrow("token_scope_mismatch");
    expect(t.seen()).toEqual(["DELETE /installation/token"]);
    expect(t.server.seen[0]!.headers["authorization"]).toBe("Bearer ghs_branchdelete1");
  });

  it("a repository that is gone (404 on the repository) is a final answer, with no ref call and no delete", async () => {
    const t = await setup({ refs: { [ITEM_BRANCH]: HEAD }, repoGone: true });
    expect(await deleteBranchWithToken(await mintBranchDeleteToken(grant(), signer, new Date()), t.deps)).toBe("repo_gone");
    expect(t.seen()).toEqual(["GET /repos/acme/widgets", "DELETE /installation/token"]);
  });
});

describe("the delete token cannot be used for a push, a second branch or a second time", () => {
  it("(1) a push: it is no git ticket, and the client it opens refuses every write but the one delete", async () => {
    const t = await setup({ refs: { [ITEM_BRANCH]: HEAD, main: MOVED } });
    const token = await mintBranchDeleteToken(grant(), signer, new Date());
    const jwk = { ...(await exportJWK(createPublicKey(signer.privateKey))), kid: signer.keyId };
    await expect(verifyRunnerGitTicket(token, { keys: createRunnerGitTicketKeys({ keys: [jwk] })!, issuer: "https://cloud.example", audience: "https://proxy.example" })).rejects.toMatchObject({ code: "header" });
    const { http } = await redeemBranchDeleteToken(token, t.deps);
    const base = "/repos/acme/widgets";
    for (const req of [
      { method: "POST", path: `${base}/git/refs`, body: { ref: `refs/heads/${ITEM_BRANCH}`, sha: HEAD } },
      { method: "POST", path: `${base}/git/commits`, body: {} },
      { method: "PATCH", path: `${base}/git/refs/heads/${ITEM_BRANCH}`, body: { sha: MOVED, force: true } },
      { method: "PUT", path: `${base}/contents/README.md`, body: {} },
      { method: "POST", path: `${base}/pulls`, body: {} },
      { method: "DELETE", path: `${base}/git/refs/heads/${ITEM_BRANCH}`, body: {} },
    ] as const) {
      await expect(http.request(req), `${req.method} ${req.path}`).rejects.toThrow(/path_refused|method_refused/);
    }
    expect(t.refs).toEqual({ [ITEM_BRANCH]: HEAD, main: MOVED });
    await http.close?.();
  });

  it("(2) a second branch: the client is pinned to the branch the token names, for reads and for the delete (main included)", async () => {
    const t = await setup({ refs: { [ITEM_BRANCH]: HEAD, [RUN_BRANCH]: HEAD, main: MOVED } });
    const { http } = await redeemBranchDeleteToken(await mintBranchDeleteToken(grant(), signer, new Date()), t.deps);
    const base = "/repos/acme/widgets";
    for (const branch of [RUN_BRANCH, "main", "fx/issue-42", ITEM_BRANCH + "x", "fx/issue-41/../main"]) {
      await expect(http.request({ method: "DELETE", path: `${base}/git/refs/heads/${branch}` }), branch).rejects.toThrow("path_refused");
      await expect(http.request({ method: "GET", path: `${base}/git/ref/heads/${branch}` }), branch).rejects.toThrow("path_refused");
    }
    await expect(http.request({ method: "GET", path: "/repos/acme/other" })).rejects.toThrow("path_refused");
    expect(t.refs).toEqual({ [ITEM_BRANCH]: HEAD, [RUN_BRANCH]: HEAD, main: MOVED });
    // The grant itself only names the two shapes: main, a default or an arbitrary name cannot even be signed.
    for (const branch of ["main", "master", "fx/issue-0", "fx/issue-1/x", "fx/p-1", RUN_BRANCH + "x"]) {
      await expect(mintBranchDeleteToken(grant({ branch }), signer, new Date()), branch).rejects.toMatchObject({ code: "claims" });
    }
    await http.close?.();
  });

  it("(3) a second time: the same token redeems once; the client it opened deletes once", async () => {
    const t = await setup({ refs: { [ITEM_BRANCH]: HEAD } });
    const token = await mintBranchDeleteToken(grant(), signer, new Date());
    const { http } = await redeemBranchDeleteToken(token, t.deps);
    await expect(redeemBranchDeleteToken(token, t.deps)).rejects.toMatchObject({ code: "used" });
    await expect(deleteBranchWithToken(token, t.deps)).rejects.toMatchObject({ code: "used" });
    const path = `/repos/acme/widgets/git/refs/heads/${ITEM_BRANCH}`;
    expect((await http.request({ method: "DELETE", path })).status).toBe(204);
    await expect(http.request({ method: "DELETE", path })).rejects.toThrow("already_used");
    await http.close?.();
  });

  it("refuses a token from another key, an expired one, a tampered one, one with another claim and one that is not ours", async () => {
    const t = await setup();
    const g = grant();
    const good = await mintBranchDeleteToken(g, signer, new Date());
    const other: RunnerGitTicketSigner = { keyId: signer.keyId, privateKey: generateKeyPairSync("ed25519").privateKey };
    const sign = (claims: Record<string, unknown>, typ = BRANCH_DELETE_TYP) => new SignJWT(claims).setProtectedHeader({ alg: "EdDSA", typ, kid: signer.keyId }).sign(signer.privateKey);
    const iat = Math.floor(Date.now() / 1000);
    const claims = { acct: g.accountId, item: g.workItemId, repo: g.repo, ref: ITEM_BRANCH, sha: HEAD, jti: randomUUID(), iat, exp: iat + 120 };
    const cases: Array<[string, string, string]> = [
      ["another key", await mintBranchDeleteToken(g, other, new Date()), "signature"],
      ["expired", await mintBranchDeleteToken(g, signer, new Date(Date.now() - 600_000)), "expired"],
      ["tampered", good.slice(0, -4) + (good.endsWith("AAAA") ? "BBBB" : "AAAA"), "signature"],
      ["an extra claim", await sign({ ...claims, admin: true }), "claims"],
      ["a lifetime of its own", await sign({ ...claims, exp: iat + 3600 }), "claims"],
      ["a branch outside the shapes", await sign({ ...claims, ref: "main" }), "claims"],
      ["a git ticket typ", await sign(claims, "fx-git-ticket+jwt"), "header"],
      ["garbage", "not-a-token", "malformed"],
    ];
    for (const [label, token, code] of cases) await expect(redeemBranchDeleteToken(token, t.deps), label).rejects.toEqual(new BranchDeleteTokenError(code as never));
    expect(t.seen()).toEqual([]);
  });
});
