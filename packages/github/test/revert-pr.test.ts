import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { InstallationTokenCache, type AccessTokenRequester } from "../src/installationToken.js";
import { createInstallationHttp } from "../src/installationHttp.js";
import { openRevertPullRequest, REVERT_PR_DOCUMENT } from "../src/revertPr.js";
import { ghError, type GhReply } from "./helpers/strictGithub.js";
import { startRevertFake, type FakePull, type RevertFake } from "./helpers/revertGithubFake.js";

/**
 * D#7 DP7-2w criteria 3, 4 and 6: `openRevertPullRequest` over the real `revert_pr` client and the real minter, against a strict HTTPS fake of GitHub (real TLS through
 * Node's connection path, a bearer token, a User-Agent, a JSON body with `query` and `variables`, and GraphQL errors arriving as HTTP 200).
 * What cannot be faked faithfully: GitHub's revert algorithm (a conflict is declared by the test), its rate limits and the wording of its errors.
 */
const REPO = { id: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
let privateKeyPem: string;
const fakes: RevertFake[] = [];
beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

async function run(pulls: FakePull[], prNumber: number, opts: { noInstallation?: boolean; reply?: GhReply } = {}) {
  const f = await startRevertFake("acme", "widgets", pulls);
  fakes.push(f);
  if (opts.reply) f.override.reply = opts.reply;
  const requester: AccessTokenRequester = async (p) => ({ token: "ghs_faketoken", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...(p.permissions as Record<string, string>) }, ...(p.repositories ? { repositories: p.repositories } : {}) });
  const open = createInstallationHttp({
    resolveInstallation: async () => (opts.noInstallation ? null : { installationId: 9, appKind: "team" }),
    appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }),
    requester,
    cache: new InstallationTokenCache(),
    fetchImpl: f.fetchImpl,
  });
  const result = await openRevertPullRequest({ open }, { repo: REPO, prNumber });
  return { result, fake: f };
}

const merged: FakePull = { number: 7, nodeId: "PR_kwDOAAAAAc4AAAAH", merged: true };

describe("openRevertPullRequest", () => {
  it("opens a draft revert of a merged pull request and returns its number and url, then revokes the token", async () => {
    const { result, fake: f } = await run([merged], 7);
    expect(result).toEqual({ ok: true, number: 901, url: "https://github.com/acme/widgets/pull/901" });
    expect(f.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /repos/acme/widgets/pulls/7", "POST /graphql"]);
    expect(f.mutations).toEqual([{ pullRequestId: merged.nodeId, draft: true, title: expect.any(String), body: expect.any(String) }]);
    expect(f.state.revoked).toBe(1);
  });

  it("refuses an unmerged pull request with not_merged and sends no mutation", async () => {
    const { result, fake: f } = await run([{ ...merged, merged: false }], 7);
    expect(result).toEqual({ ok: false, code: "not_merged" });
    expect(f.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /repos/acme/widgets/pulls/7"]);
    expect(f.mutations).toEqual([]);
  });

  it("answers revert_refused, with no GitHub text, when the revert conflicts (an errors array on HTTP 200)", async () => {
    const { result, fake: f } = await run([{ ...merged, conflicts: true }], 7);
    expect(result).toEqual({ ok: false, code: "revert_refused" });
    expect(JSON.stringify(result)).not.toMatch(/could not be reverted|UNPROCESSABLE/);
    expect(f.mutations).toEqual([]);
  });

  it("answers revert_refused for an unprocessable HTTP 422 too, and unavailable for an upstream failure, without GitHub text", async () => {
    const refused = (await run([merged], 7, { reply: ghError(422, "Unprocessable Entity: secret detail") })).result;
    expect(refused).toEqual({ ok: false, code: "revert_refused" });
    const down = (await run([merged], 7, { reply: ghError(502, "Bad Gateway private text") })).result;
    expect(down).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify([refused, down])).not.toMatch(/secret detail|private text/);
  });

  it("answers fixed codes for a missing pull request and a missing installation", async () => {
    expect((await run([merged], 99)).result).toEqual({ ok: false, code: "pr_unreadable" });
    expect((await run([merged], 7, { noInstallation: true })).result).toEqual({ ok: false, code: "unavailable" });
  });
});

describe("the fake keeps GitHub's contract (criterion 4)", () => {
  async function raw(headers: Record<string, string>, body: string) {
    const f = await startRevertFake("acme", "widgets", [merged]);
    fakes.push(f);
    const res = await f.fetchImpl("https://api.github.com/graphql", { method: "POST", headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...headers }, body });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }
  const doc = JSON.stringify({ query: REVERT_PR_DOCUMENT, variables: { pullRequestId: merged.nodeId, draft: true, title: "t", body: "b" } });

  it("needs a bearer token, a JSON body with query and variables, and reports GraphQL failures as HTTP 200 with errors", async () => {
    expect((await raw({ "content-type": "application/json" }, doc)).status).toBe(401);
    expect((await raw({ authorization: "Bearer t", "content-type": "application/json" }, "not json")).status).toBe(400);
    expect((await raw({ authorization: "Bearer t", "content-type": "application/json" }, JSON.stringify({ variables: {} }))).status).toBe(400);
    const missing = await raw({ authorization: "Bearer t", "content-type": "application/json" }, JSON.stringify({ query: REVERT_PR_DOCUMENT, variables: {} }));
    expect(missing.status).toBe(200);
    expect(missing.json["data"]).toBeNull();
    expect(Array.isArray(missing.json["errors"])).toBe(true);
    const ok = await raw({ authorization: "Bearer t", "content-type": "application/json" }, doc);
    expect(ok.status).toBe(200);
    expect(ok.json["errors"]).toBeUndefined();
  });
});

describe("the mutation is named in one source file (criterion 6)", () => {
  it("finds the revert mutation's name only in packages/github/src/revertPr.ts", () => {
    const root = path.join(__dirname, "..", "..", "..");
    const skip = new Set(["node_modules", ".next", "dist", "build", "coverage", ".turbo", "test", "tests", "__tests__"]);
    const word = new RegExp(["revert", "PullRequest"].join(""));
    // What git tracks (plus untracked, not-ignored files), so build output on disk never counts as a source.
    const listed = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "apps", "packages"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
      .split("\0")
      .filter((f) => f !== "" && !f.split("/").some((d) => skip.has(d)));
    const named = listed.filter((f) => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f) && !/\.(?:test|spec)\.[a-z]+$/.test(path.basename(f)) && existsSync(path.join(root, f)) && word.test(readFileSync(path.join(root, f), "utf8")));
    expect(named).toEqual(["packages/github/src/revertPr.ts"]);
  });
});

const NODE = merged.nodeId;

describe("openRevertPullRequest malformed answers and thrown errors (close() always runs)", () => {
  const mk = (http: { get?: unknown; post?: unknown; throwOnPost?: boolean; throwOpen?: boolean }) => {
    const calls: string[] = [];
    const closed = { n: 0 };
    return {
      calls,
      closed,
      deps: {
        open: async () => {
          if (http.throwOpen) throw new Error("ghs_secret text from github");
          return {
            request: async (r: { method: string }) => {
              calls.push(r.method);
              if (r.method === "GET") return http.get as never;
              if (http.throwOnPost) throw new Error("ghs_secret text from github");
              return http.post as never;
            },
            close: async () => { closed.n++; },
          };
        },
      },
    };
  };
  const okGet = { status: 200, body: { merged: true, node_id: NODE } };
  const input = { repo: { id: "i", owner: "acme", name: "widgets" }, prNumber: 7 };
  it.each([
    ["GET 200 without merged", { status: 200, body: { node_id: NODE } }, "pr_unreadable"],
    ["GET merged true without node_id", { status: 200, body: { merged: true } }, "pr_unreadable"],
    ["GET node_id with bad characters", { status: 200, body: { merged: true, node_id: "a b;c" } }, "pr_unreadable"],
    ["GET body not an object", { status: 200, body: "x" }, "pr_unreadable"],
    ["GET 500", { status: 500, body: {} }, "pr_unreadable"],
  ])("%s -> %s and no mutation", async (_n, get, code) => {
    const m = mk({ get });
    expect(await openRevertPullRequest(m.deps as never, input)).toEqual({ ok: false, code });
    expect(m.calls).toEqual(["GET"]);
    expect(m.closed.n).toBe(1);
  });
  it.each([
    ["no data", { status: 200, body: {} }],
    ["data null", { status: 200, body: { data: null } }],
    ["revertPullRequest null", { status: 200, body: { data: { revertPullRequest: null } } }],
    ["number as string", { status: 200, body: { data: { revertPullRequest: { revertPullRequest: { number: "9", url: "https://github.com/a/b/pull/9" } } } } }],
    ["number 0", { status: 200, body: { data: { revertPullRequest: { revertPullRequest: { number: 0, url: "https://github.com/a/b/pull/0" } } } } }],
    ["url on another host", { status: 200, body: { data: { revertPullRequest: { revertPullRequest: { number: 9, url: "https://evil.example/a/b/pull/9" } } } } }],
    ["url with trailing text", { status: 200, body: { data: { revertPullRequest: { revertPullRequest: { number: 9, url: "https://github.com/a/b/pull/9/files" } } } } }],
    ["non-200 non-422 (403)", { status: 403, body: { message: "secret text" } }],
    ["200 body not an object", { status: 200, body: "x" }],
  ])("mutation answer: %s -> unavailable", async (_n, post) => {
    const m = mk({ get: okGet, post });
    expect(await openRevertPullRequest(m.deps as never, input)).toEqual({ ok: false, code: "unavailable" });
  });
  it("errors array alongside data still refuses; empty errors array with data succeeds", async () => {
    const good = { data: { revertPullRequest: { revertPullRequest: { number: 9, url: "https://github.com/acme/widgets/pull/9" } } } };
    expect(await openRevertPullRequest(mk({ get: okGet, post: { status: 200, body: { ...good, errors: [{ message: "x" }] } } }).deps as never, input)).toEqual({ ok: false, code: "revert_refused" });
    expect(await openRevertPullRequest(mk({ get: okGet, post: { status: 200, body: { ...good, errors: [] } } }).deps as never, input)).toEqual({ ok: true, number: 9, url: "https://github.com/acme/widgets/pull/9" });
  });
  it("a throw on open or on POST gives unavailable with no thrown text, and close still runs", async () => {
    const a = mk({ throwOpen: true });
    const ra = await openRevertPullRequest(a.deps as never, input);
    expect(ra).toEqual({ ok: false, code: "unavailable" });
    const b = mk({ get: okGet, throwOnPost: true });
    const rb = await openRevertPullRequest(b.deps as never, input);
    expect(rb).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify([ra, rb])).not.toMatch(/ghs_|github/);
    expect(b.closed.n).toBe(1);
  });
});
