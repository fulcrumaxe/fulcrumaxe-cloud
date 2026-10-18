import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PlanePushGithubError, createPlanePushGithub } from "../../src/daemon/planePushGithub.js";

/**
 * D#598 P1f-3: the hook's three GitHub calls, through Node's real connection path against a loopback server that behaves as the real host does
 * where these calls touch it: no User-Agent is a 403, a bad bearer is a 401, a revoke is a 204 and then a 401, a redirect is not followed.
 * Not faked: TLS (loopback http is the only place the client allows plain http), rate limits, GitHub's validation of a title or body.
 */
const TOKEN = ["ghs", "githubunittoken00000001"].join("_");

interface Seen { method: string; path: string; authorization?: string; userAgent?: string; body: string }
let server: http.Server | undefined;
let seen: Seen[] = [];
let handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void = (_q, res) => res.writeHead(404).end();

async function start(): Promise<string> {
  seen = [];
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", path: req.url ?? "", ...(req.headers.authorization === undefined ? {} : { authorization: req.headers.authorization }), ...(req.headers["user-agent"] === undefined ? {} : { userAgent: req.headers["user-agent"] }), body });
      if (!req.headers["user-agent"]) return void res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ message: "Request forbidden by administrative rules. Please make sure your request has a User-Agent header." }));
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ message: "Bad credentials" }));
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});
const json = (res: http.ServerResponse, status: number, body: unknown): void => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

describe("branchExists", () => {
  it("is true on a 200 and false on a 404, with a User-Agent, the bearer and the branch path escaped segment by segment", async () => {
    const origin = await start();
    handler = (req, res) => (req.url!.endsWith("/fx/p-1") ? json(res, 200, { object: { sha: "a".repeat(40) } }) : json(res, 404, { message: "Not Found" }));
    const gh = createPlanePushGithub({ apiOrigin: origin });
    expect(await gh.branchExists({ codeRepo: "acme/widgets", branch: "fx/p-1", token: TOKEN })).toBe(true);
    expect(await gh.branchExists({ codeRepo: "acme/widgets", branch: "fx/p-2", token: TOKEN })).toBe(false);
    expect(seen[0]).toMatchObject({ method: "GET", path: "/repos/acme/widgets/git/ref/heads/fx/p-1", authorization: `Bearer ${TOKEN}`, userAgent: "fulcrumaxe-runner" });
  });

  it("anything else (a 401, a 500) is a closed public_unavailable, never a guess that the branch is absent", async () => {
    const origin = await start();
    handler = (_q, res) => json(res, 500, { message: "boom" });
    const gh = createPlanePushGithub({ apiOrigin: origin });
    await expect(gh.branchExists({ codeRepo: "acme/widgets", branch: "fx/p-1", token: TOKEN })).rejects.toMatchObject({ code: "public_unavailable" });
    await expect(gh.branchExists({ codeRepo: "acme/widgets", branch: "fx/p-1", token: "wrong" })).rejects.toMatchObject({ code: "public_unavailable" });
  });

  it("refuses a repo name or branch that is not plain before any request is made", async () => {
    const origin = await start();
    const gh = createPlanePushGithub({ apiOrigin: origin });
    for (const codeRepo of ["acme", "acme/widgets/extra", "../x", "acme/..", "acme/wid gets", "-acme/widgets"]) {
      await expect(gh.branchExists({ codeRepo, branch: "fx/p-1", token: TOKEN }), codeRepo).rejects.toBeInstanceOf(PlanePushGithubError);
    }
    for (const branch of ["", "a..b", "-x", "a b", "x?y"]) await expect(gh.branchExists({ codeRepo: "acme/widgets", branch, token: TOKEN }), branch).rejects.toBeInstanceOf(PlanePushGithubError);
    expect(seen).toEqual([]);
  });
});

describe("openPullRequest", () => {
  const input = { codeRepo: "acme/widgets", branch: "fx/p-1", base: "main", title: "Add the thing", body: "Adds it.", token: TOKEN };

  it("posts the pull request with maintainers locked out and answers its number and github.com address", async () => {
    const origin = await start();
    handler = (_q, res) => json(res, 201, { number: 12, html_url: "https://github.com/acme/widgets/pull/12" });
    expect(await createPlanePushGithub({ apiOrigin: origin }).openPullRequest(input)).toEqual({ number: 12, url: "https://github.com/acme/widgets/pull/12" });
    expect(seen[0]).toMatchObject({ method: "POST", path: "/repos/acme/widgets/pulls" });
    expect(JSON.parse(seen[0]!.body)).toEqual({ title: "Add the thing", head: "fx/p-1", base: "main", body: "Adds it.", maintainer_can_modify: false });
  });

  it("a reply whose address is another repository's, or whose number disagrees, is pr_failed; a 5xx or 429 is public_unavailable", async () => {
    const origin = await start();
    const gh = createPlanePushGithub({ apiOrigin: origin });
    handler = (_q, res) => json(res, 201, { number: 12, html_url: "https://github.com/evil/widgets/pull/12" });
    await expect(gh.openPullRequest(input)).rejects.toMatchObject({ code: "pr_failed" });
    handler = (_q, res) => json(res, 201, { number: 12, html_url: "https://github.com/acme/widgets/pull/13" });
    await expect(gh.openPullRequest(input)).rejects.toMatchObject({ code: "pr_failed" });
    handler = (_q, res) => json(res, 422, { message: "Validation Failed" });
    await expect(gh.openPullRequest(input)).rejects.toMatchObject({ code: "pr_failed" });
    for (const status of [502, 429]) {
      handler = (_q, res) => json(res, status, {});
      await expect(gh.openPullRequest(input), String(status)).rejects.toMatchObject({ code: "public_unavailable" });
    }
  });

  it("no failure carries the token, a header or GitHub's text", async () => {
    const origin = await start();
    handler = (_q, res) => json(res, 422, { message: `leaked ${TOKEN}` });
    const e = await createPlanePushGithub({ apiOrigin: origin }).openPullRequest(input).then(() => undefined, (x: unknown) => x as Error);
    expect(JSON.stringify({ m: e?.message, s: e?.stack, n: e?.name })).not.toContain(TOKEN);
    expect(e?.message).not.toContain("leaked");
  });
});

describe("revokeToken", () => {
  it("is true on 204, then true on the 401 of an already revoked token (nothing is left to revoke)", async () => {
    const origin = await start();
    let live = true;
    handler = (req, res) => {
      if (req.method !== "DELETE" || req.url !== "/installation/token") return json(res, 404, {});
      if (live) {
        live = false;
        return void res.writeHead(204).end();
      }
      return json(res, 401, { message: "Bad credentials" });
    };
    const gh = createPlanePushGithub({ apiOrigin: origin });
    expect(await gh.revokeToken(TOKEN)).toBe(true);
    expect(seen[0]).toMatchObject({ method: "DELETE", path: "/installation/token", authorization: `Bearer ${TOKEN}` });
    handler = (_q, res) => json(res, 401, { message: "Bad credentials" });
    expect(await gh.revokeToken("not-the-live-token")).toBe(true);
  });

  it("is false, and never throws, on a 5xx, a redirect, a hung server and a closed port", async () => {
    const origin = await start();
    const gh = createPlanePushGithub({ apiOrigin: origin, timeoutMs: 150 });
    handler = (_q, res) => json(res, 500, {});
    expect(await gh.revokeToken(TOKEN)).toBe(false);
    handler = (_q, res) => void res.writeHead(302, { location: `${origin}/elsewhere` }).end();
    expect(await gh.revokeToken(TOKEN)).toBe(false);
    expect(seen.filter((s) => s.path === "/elsewhere")).toEqual([]);
    handler = () => undefined;
    expect(await gh.revokeToken(TOKEN)).toBe(false);
    await afterEachClose();
    expect(await gh.revokeToken(TOKEN)).toBe(false);
  });
});

async function afterEachClose(): Promise<void> {
  server!.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
}

describe("the origin", () => {
  it("defaults to api.github.com and accepts only https, or http on loopback, with no credentials, path or query", () => {
    expect(() => createPlanePushGithub()).not.toThrow();
    for (const bad of ["http://api.github.com", "https://user:pw@api.github.com", "https://api.github.com/v3", "https://api.github.com/?x=1", "ftp://api.github.com", "http://192.168.0.5"]) {
      expect(() => createPlanePushGithub({ apiOrigin: bad }), bad).toThrow();
    }
    expect(() => createPlanePushGithub({ apiOrigin: "http://127.0.0.1:8080" })).not.toThrow();
  });

  it("the default client sends to api.github.com, with a User-Agent, and to nowhere else", async () => {
    const calls: Array<{ url: string; ua: string | null }> = [];
    const fetchFn = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), ua: new Headers(init.headers).get("user-agent") });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    expect(await createPlanePushGithub({ fetchFn }).revokeToken(TOKEN)).toBe(true);
    expect(calls).toEqual([{ url: "https://api.github.com/installation/token", ua: "fulcrumaxe-runner" }]);
  });
});
