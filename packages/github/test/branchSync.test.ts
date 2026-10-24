import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { InstallationTokenCache, type AccessTokenRequester } from "../src/installationToken.js";
import { createInstallationHttp, InstallationHttpError } from "../src/installationHttp.js";
import { BranchSyncError, createBranchSyncPort } from "../src/branchSync.js";
import { ghError, strictGithubFetch } from "./helpers/strictGithub.js";

/**
 * FIXROUND-BASE-SYNC: the branch sync port over the real `branch_sync` client and the real token minter, against a fake GitHub that keeps a small commit graph and
 * answers the way the real merges endpoint does: 201 with a merge commit (parents: the branch's tip, then the head merged), 204 when the head is already in the
 * branch, 409 on a conflict, 404 for a base or head that does not exist, 422 for a missing field. It sits behind the strict fetch (User-Agent, Accept, API version,
 * Authorization and JSON-body rules). What it cannot fake: GitHub's merge algorithm (a conflict is declared by the test), rate limits and the exact wording of errors.
 */
const REPO = { id: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
const BRANCH = "fx/issue-12";
const hex = (c: string) => c.repeat(40);
let privateKeyPem: string;
beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface World {
  /** commit -> parents */
  parents: Map<string, string[]>;
  refs: Map<string, string>;
  pull: { state: string; headRef: string; baseRef: string; headRepo: number; baseRepo: number; defaultBranch: string | null };
  /** Pairs "branchTip>head" that GitHub would find conflicting. */
  conflicts: Set<string>;
  /** Overrides what the merges endpoint answers, for the failure cases. */
  mergesAnswer?: () => Response;
}

function world(): World {
  const parents = new Map<string, string[]>([[hex("1"), []], [hex("2"), [hex("1")]], [hex("3"), [hex("1")]]]);
  // main moved on (3); the item's branch (2) was cut from 1.
  return { parents, refs: new Map([["main", hex("3")], [BRANCH, hex("2")]]), pull: { state: "open", headRef: BRANCH, baseRef: "main", headRepo: 7, baseRepo: 7, defaultBranch: "main" }, conflicts: new Set() };
}
const ancestors = (w: World, c: string): Set<string> => {
  const seen = new Set<string>();
  const walk = (x: string) => {
    if (seen.has(x)) return;
    seen.add(x);
    for (const p of w.parents.get(x) ?? []) walk(p);
  };
  walk(c);
  return seen;
};

function setup(w: World, mint: Partial<{ permissions: Record<string, string>; repositories: string[] }> = {}) {
  const log: string[] = [];
  const bodies: unknown[] = [];
  const minted: Array<Parameters<AccessTokenRequester>[0]> = [];
  let revoked = 0;
  let nextMerge = 0xa0;
  const fetchImpl = strictGithubFetch((async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    log.push(`${method} ${url.pathname}`);
    if (method === "DELETE" && url.pathname === "/installation/token") {
      revoked += 1;
      return new Response(null, { status: 204 });
    }
    const root = "/repos/acme/widgets";
    if (method === "GET" && url.pathname === `${root}/pulls/12`) {
      return json(200, { number: 12, state: w.pull.state, head: { ref: w.pull.headRef, repo: { id: w.pull.headRepo } }, base: { ref: w.pull.baseRef, repo: { id: w.pull.baseRepo, ...(w.pull.defaultBranch === null ? {} : { default_branch: w.pull.defaultBranch }) } } });
    }
    const ref = /^\/repos\/acme\/widgets\/git\/ref\/heads\/(.+)$/.exec(url.pathname);
    if (method === "GET" && ref) {
      const sha = w.refs.get(decodeURIComponent(ref[1]!));
      return sha ? json(200, { ref: `refs/heads/${ref[1]}`, object: { type: "commit", sha } }) : json(404, { message: "Not Found" });
    }
    if (method === "POST" && url.pathname === `${root}/merges`) {
      const body = JSON.parse(String(init?.body)) as { base?: string; head?: string; commit_message?: string };
      bodies.push(body);
      if (w.mergesAnswer) return w.mergesAnswer();
      if (typeof body.base !== "string" || typeof body.head !== "string") return json(422, { message: "Validation Failed" });
      const tip = w.refs.get(body.base);
      if (!tip) return json(404, { message: "Base does not exist" });
      if (!w.parents.has(body.head)) return json(404, { message: "Head does not exist" });
      if (ancestors(w, tip).has(body.head)) return new Response(null, { status: 204 });
      if (w.conflicts.has(`${tip}>${body.head}`)) return json(409, { message: "Merge conflict" });
      const sha = (nextMerge++).toString(16).repeat(20);
      w.parents.set(sha, [tip, body.head]);
      w.refs.set(body.base, sha);
      return json(201, { sha, parents: [{ sha: tip }, { sha: body.head }], commit: { message: body.commit_message } });
    }
    return json(404, { message: "Not Found" });
  }) as unknown as typeof fetch);
  const requester: AccessTokenRequester = async (p) => {
    minted.push(p);
    return { token: "ghs_faketoken", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: mint.permissions ?? { metadata: "read", contents: "write", pull_requests: "read" }, repositories: mint.repositories ?? ["widgets"] };
  };
  const open = createInstallationHttp({
    resolveInstallation: async () => ({ installationId: 9, appKind: "team" }),
    appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }),
    requester,
    cache: new InstallationTokenCache(),
    fetchImpl,
  });
  return { open, port: createBranchSyncPort(open), log, bodies, minted, revoked: () => revoked };
}
const ask = (port: ReturnType<typeof setup>["port"], branch = BRANCH) => port.sync({ repo: REPO, branch, prNumber: 12 });

describe("branch sync: stacked pull requests (R2-c0)", () => {
  const stack = (w: World) => {
    w.parents.set(hex("4"), [hex("1")]);
    w.refs.set("fx/parent", hex("4"));
    w.pull.baseRef = "fx/parent";
  };
  const ask2 = (t: ReturnType<typeof setup>, publicCopy?: boolean) => t.port.sync({ repo: REPO, branch: BRANCH, prNumber: 12, ...(publicCopy === undefined ? {} : { publicCopy }) });

  it("with a public copy to republish, a stacked change is answered before the base is read or anything is merged: no ref read, no POST /merges, the branch unchanged", async () => {
    // Without the flag the same world would get a 201 and a merge commit of the parent branch on the private branch.
    const w = world();
    stack(w);
    const t = setup(w);
    expect(await ask2(t, true)).toEqual({ kind: "stacked", baseRef: "fx/parent" });
    expect(t.log).toEqual([`GET /repos/acme/widgets/pulls/12`, `DELETE /installation/token`]);
    expect(t.bodies).toEqual([]);
    expect(w.refs.get(BRANCH)).toBe(hex("2"));
    expect(t.revoked()).toBe(1);
  });

  it("with no public copy a stacked change syncs as ever, and says it is stacked on every outcome; GitHub not naming the default branch counts as stacked", async () => {
    const merged = world();
    stack(merged);
    const t = setup(merged);
    expect(await ask2(t, false)).toMatchObject({ kind: "merged", baseRef: "fx/parent", stacked: true });
    expect(t.bodies).toHaveLength(1);
    const upToDate = world();
    stack(upToDate);
    upToDate.refs.set(BRANCH, hex("4"));
    expect(await ask2(setup(upToDate))).toMatchObject({ kind: "up_to_date", baseRef: "fx/parent", stacked: true });
    const conflict = world();
    stack(conflict);
    conflict.conflicts.add(`${hex("2")}>${hex("4")}`);
    expect(await ask2(setup(conflict))).toMatchObject({ kind: "conflict", stacked: true });
    const unnamed = world();
    unnamed.pull.defaultBranch = null;
    expect(await ask2(setup(unnamed))).toMatchObject({ kind: "merged", baseRef: "main", stacked: true });
    // A change on the default branch is never refused by the flag.
    expect(await ask2(setup(world()), true)).toMatchObject({ kind: "merged", stacked: false });
  });
});

describe("branch sync: the merges call and what comes back", () => {
  it("201: main moved, no conflict: one merge commit whose parents are the branch tip and the base tip; the branch moved to it", async () => {
    const w = world();
    const t = setup(w);
    const out = await ask(t.port);
    expect(out).toMatchObject({ kind: "merged", baseSha: hex("3"), baseRef: "main", stacked: false, parents: [hex("2"), hex("3")] });
    expect(w.refs.get(BRANCH)).toBe((out as { sha: string }).sha);
    // The merged commit is the exact commit read, not a branch name; the message is fixed text.
    expect(t.bodies).toEqual([{ base: BRANCH, head: hex("3"), commit_message: `Bring ${BRANCH} up to date with main` }]);
    expect(t.log).toEqual([`GET /repos/acme/widgets/pulls/12`, `GET /repos/acme/widgets/git/ref/heads/main`, `POST /repos/acme/widgets/merges`, `DELETE /installation/token`]);
    // The token: one repository, contents write and pull requests read, and revoked after use.
    expect(t.minted[0]).toMatchObject({ repositories: ["widgets"], permissions: { contents: "write", pull_requests: "read" } });
    expect(t.revoked()).toBe(1);
    // Criterion 6: one token, for the private repository only; no other repository's token is minted on this path.
    expect(t.minted).toHaveLength(1);
  });

  it("204: main did not move: nothing is written", async () => {
    const w = world();
    w.refs.set(BRANCH, hex("3"));
    const t = setup(w);
    expect(await ask(t.port)).toEqual({ kind: "up_to_date", baseSha: hex("3"), baseRef: "main", stacked: false });
    expect(w.refs.get(BRANCH)).toBe(hex("3"));
  });

  it("409: a conflict is an answer, not an error, and the branch is unchanged", async () => {
    const w = world();
    w.conflicts.add(`${hex("2")}>${hex("3")}`);
    const t = setup(w);
    expect(await ask(t.port)).toEqual({ kind: "conflict", baseSha: hex("3"), baseRef: "main", stacked: false });
    expect(w.refs.get(BRANCH)).toBe(hex("2"));
    expect(t.revoked()).toBe(1);
  });

  it("a stacked item merges its parent branch (the pull request's base), not main", async () => {
    const w = world();
    w.parents.set(hex("4"), [hex("1")]);
    w.refs.set("fx/issue-5", hex("4"));
    w.pull.baseRef = "fx/issue-5";
    const t = setup(w);
    expect(await ask(t.port)).toMatchObject({ kind: "merged", baseRef: "fx/issue-5", baseSha: hex("4") });
    expect(t.log).toContain("GET /repos/acme/widgets/git/ref/heads/fx/issue-5");
    expect(t.bodies).toEqual([{ base: BRANCH, head: hex("4"), commit_message: `Bring ${BRANCH} up to date with fx/issue-5` }]);
  });

  it.each([
    ["403 from the merges call", () => ghError(403, "Resource not accessible by integration").body, 403],
    ["404 from the merges call", () => ghError(404, "Base does not exist").body, 404],
    ["500 from the merges call", () => ghError(500, "Server Error").body, 500],
    ["422 from the merges call", () => ghError(422, "Validation Failed").body, 422],
  ])("%s throws (never read as up to date)", async (_name, body, status) => {
    const w = world();
    w.mergesAnswer = () => new Response(body(), { status, headers: { "content-type": "application/json" } });
    const t = setup(w);
    await expect(ask(t.port)).rejects.toThrow(BranchSyncError);
    expect(w.refs.get(BRANCH)).toBe(hex("2"));
    expect(t.revoked()).toBe(1);
  });

  it.each([
    ["a 201 with no body", () => new Response(null, { status: 201 })],
    ["a 201 with a short sha", () => json(201, { sha: "abc", parents: [{ sha: hex("2") }, { sha: hex("3") }] })],
    ["a 201 with no parents", () => json(201, { sha: hex("a") })],
    ["a 201 with three parents", () => json(201, { sha: hex("a"), parents: [{ sha: hex("2") }, { sha: hex("3") }, { sha: hex("1") }] })],
    ["a 200", () => json(200, { sha: hex("a"), parents: [{ sha: hex("2") }, { sha: hex("3") }] })],
    ["a 202", () => json(202, {})],
  ])("%s throws", async (_name, answer) => {
    const w = world();
    w.mergesAnswer = answer;
    await expect(ask(setup(w).port)).rejects.toThrow(BranchSyncError);
  });

  it("a pull request that is closed, on another branch, from a fork, or unreadable is not synced", async () => {
    for (const change of [{ state: "closed" }, { headRef: "fx/issue-99" }, { headRepo: 8 }, { baseRef: BRANCH }, { baseRef: "bad ref" }]) {
      const w = world();
      Object.assign(w.pull, change);
      const t = setup(w);
      await expect(ask(t.port), JSON.stringify(change)).rejects.toThrow(BranchSyncError);
      expect(t.log.some((l) => l.startsWith("POST"))).toBe(false);
    }
  });

  it("a base branch GitHub cannot show is not synced", async () => {
    const w = world();
    w.refs.delete("main");
    const t = setup(w);
    await expect(ask(t.port)).rejects.toThrow("base_unreadable");
    expect(t.log.some((l) => l.startsWith("POST"))).toBe(false);
  });
});

describe("branch sync: the client keeps to its list", () => {
  it("refuses a branch outside the two shapes the platform pushes, before any token is minted", async () => {
    const t = setup(world());
    await expect(ask(t.port, "main")).rejects.toThrow(InstallationHttpError);
    expect(t.minted).toHaveLength(0);
  });

  it("allows exactly one merge, into the pinned branch, of a commit id, with the three fields", async () => {
    const t = setup(world());
    const http = await t.open("branch_sync", { ...REPO, repoId: REPO.id, branch: BRANCH, prNumber: 12 });
    const post = (body: unknown) => http.request({ method: "POST", path: "/repos/acme/widgets/merges", body });
    await expect(post({ base: "main", head: hex("3"), commit_message: "m" })).rejects.toThrow("path_refused");
    await expect(post({ base: BRANCH, head: "main", commit_message: "m" })).rejects.toThrow("path_refused");
    await expect(post({ base: BRANCH, head: hex("3") })).rejects.toThrow("path_refused");
    await expect(post({ base: BRANCH, head: hex("3"), commit_message: "m", extra: 1 })).rejects.toThrow("path_refused");
    expect((await post({ base: BRANCH, head: hex("3"), commit_message: "m" })).status).toBe(201);
    await expect(post({ base: BRANCH, head: hex("3"), commit_message: "m" })).rejects.toThrow("already_used");
    await http.close?.();
  });

  it("refuses every other path and method: another pull request, file contents, a delete, a push, a force", async () => {
    const t = setup(world());
    const http = await t.open("branch_sync", { ...REPO, repoId: REPO.id, branch: BRANCH, prNumber: 12 });
    for (const req of [
      { method: "GET", path: "/repos/acme/widgets/pulls/13" },
      { method: "GET", path: "/repos/acme/widgets/contents/README.md" },
      { method: "GET", path: "/repos/acme/widgets/commits/main" },
      { method: "GET", path: "/repos/acme/widgets/git/ref/heads/a/../b" },
      { method: "PATCH", path: "/repos/acme/widgets/pulls/12", body: { state: "closed" } },
      { method: "PUT", path: "/repos/acme/widgets/pulls/12/merge" },
      { method: "DELETE", path: `/repos/acme/widgets/git/refs/heads/${BRANCH}` },
      { method: "POST", path: "/repos/acme/widgets/git/refs", body: { ref: "refs/heads/x", sha: hex("3") } },
      { method: "POST", path: "/graphql", body: { query: "{ viewer { login } }" } },
    ] as const) {
      await expect(http.request(req), `${req.method} ${req.path}`).rejects.toThrow(InstallationHttpError);
    }
    await http.close?.();
  });

  it("refuses a token GitHub made wider than asked for, and revokes it", async () => {
    for (const mint of <Array<{ permissions?: Record<string, string>; repositories?: string[] }>>[{ permissions: { metadata: "read", contents: "write", pull_requests: "write" } }, { permissions: { metadata: "read", contents: "write" } }, { permissions: { metadata: "read", contents: "write", pull_requests: "read", issues: "read" } }, { repositories: ["widgets", "other"] }]) {
      const t = setup(world(), mint);
      await expect(ask(t.port), JSON.stringify(mint)).rejects.toThrow("token_scope_mismatch");
      expect(t.revoked()).toBe(1);
      expect(t.log).toEqual([`DELETE /installation/token`]);
    }
  });
});
