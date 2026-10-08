import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { InstallationTokenCache, type AccessTokenRequester } from "../src/installationToken.js";
import { createInstallationHttp, InstallationHttpError, type InstallationHttpLogEntry } from "../src/installationHttp.js";
import { ghError, strictGithubFetch } from "./helpers/strictGithub.js";

/** D#483 P3: the installation-bound HTTP client, against the strict GitHub fetch fake and the real token minter. */
const TARGET = { repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
let privateKeyPem: string;
beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  privateKeyPem = privateKey as unknown as string;
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(route: (url: URL, init: RequestInit | undefined) => Response | undefined, opts: { appKind?: string; noInstallation?: boolean } = {}) {
  const minted: Array<Parameters<AccessTokenRequester>[0]> = [];
  const calls: Array<{ url: string; method: string; auth: string | undefined; body: string | undefined }> = [];
  const log: InstallationHttpLogEntry[] = [];
  const requester: AccessTokenRequester = async (p) => {
    minted.push(p);
    return { token: "ghs_faketoken", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  };
  const fetchImpl = strictGithubFetch((async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), method: init?.method ?? "GET", auth: (init?.headers as Record<string, string> | undefined)?.authorization, body: init?.body as string | undefined });
    const r = route(url, init);
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return r;
  }) as unknown as typeof fetch);
  const open = createInstallationHttp({
    resolveInstallation: async () => (opts.noInstallation ? null : { installationId: 9, appKind: opts.appKind ?? "team" }),
    appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }),
    requester,
    cache: new InstallationTokenCache(),
    fetchImpl,
    log: (e) => log.push(e),
  });
  return { open, minted, calls, log };
}

describe("createInstallationHttp", () => {
  it("read: GETs with a one-repository token that can read pull requests and nothing else", async () => {
    const t = setup((u) => (u.pathname === "/repos/acme/widgets/pulls/3" ? json(200, { number: 3 }) : undefined));
    const http = await t.open("read", TARGET);
    const res = await http.request({ method: "GET", path: "/repos/acme/widgets/pulls/3" });
    expect(res).toEqual({ status: 200, body: { number: 3 } });
    expect(t.minted[0]).toMatchObject({ repositories: ["widgets"], permissions: { metadata: "read", pull_requests: "read" } });
    expect(t.calls[0]!.auth).toBe("Bearer ghs_faketoken");
  });

  it("read: GETs the repository itself (no trailing slash), for the private flag", async () => {
    const t = setup((u) => (u.pathname === "/repos/acme/widgets" ? json(200, { full_name: "acme/widgets", private: true }) : undefined));
    const http = await t.open("read", TARGET);
    expect(await http.request({ method: "GET", path: "/repos/acme/widgets" })).toEqual({ status: 200, body: { full_name: "acme/widgets", private: true } });
    expect(t.log[0]).toMatchObject({ path: "/repos/:o/:r" });
  });

  it("the bare repository path is GET only, and only for the repository the client was opened for", async () => {
    const t = setup(() => undefined);
    const read = await t.open("read", TARGET);
    const gate = await t.open("merge_gate", TARGET);
    await expect(gate.request({ method: "POST", path: "/repos/acme/widgets", body: {} })).rejects.toThrow("path_refused");
    await expect(gate.request({ method: "PUT", path: "/repos/acme/widgets", body: {} })).rejects.toThrow("path_refused");
    for (const path of ["/repos/acme/other", "/repos/evil/widgets", "/repos/acme/widgets2", "/repos/acme", "/repos/acme/widgets?x=1"]) {
      await expect(read.request({ method: "GET", path }), path).rejects.toThrow("path_refused");
    }
    expect(t.calls).toEqual([]);
  });

  it("read: refuses a write method before any request is made", async () => {
    const t = setup(() => undefined);
    const http = await t.open("read", TARGET);
    await expect(http.request({ method: "POST", path: "/repos/acme/widgets/statuses/" + "a".repeat(40), body: {} })).rejects.toThrow("method_refused");
    expect(t.calls).toEqual([]);
  });

  it("merge_gate: mints the gate's fixed permissions, posts a status with a JSON body, and merges with the sha", async () => {
    const sha = "a".repeat(40);
    const t = setup((u, init) => {
      if (init?.method === "POST" && u.pathname === `/repos/acme/widgets/statuses/${sha}`) return json(201, { state: "success" });
      if (init?.method === "PUT" && u.pathname === "/repos/acme/widgets/pulls/3/merge") return json(200, { merged: true });
      return undefined;
    });
    const http = await t.open("merge_gate", TARGET);
    const st = await http.request({ method: "POST", path: `/repos/acme/widgets/statuses/${sha}`, body: { state: "success", context: "fulcrumaxe/review" } });
    const merge = await http.request({ method: "PUT", path: "/repos/acme/widgets/pulls/3/merge", body: { sha, merge_method: "squash" } });
    expect(st.status).toBe(201);
    expect(merge.body).toEqual({ merged: true });
    expect(t.minted[0]!.permissions).toEqual({ metadata: "read", checks: "read", statuses: "write", administration: "read", contents: "write", pull_requests: "write" });
    expect(JSON.parse(t.calls[0]!.body!)).toEqual({ state: "success", context: "fulcrumaxe/review" });
  });

  it.each([
    ["another repository", "/repos/acme/other/pulls/3"],
    ["another owner", "/repos/evil/widgets/pulls/3"],
    ["a path that climbs out", "/repos/acme/widgets/../other/pulls/3"],
    ["a non-repo path", "/user/repos"],
    ["a query smuggled into the path", "/repos/acme/widgets/pulls?per_page=1"],
    ["a fragment", "/repos/acme/widgets/pulls#x"],
    ["a space", "/repos/acme/widgets/pul ls"],
  ])("refuses %s, with no token used", async (_name, path) => {
    const t = setup(() => undefined);
    const http = await t.open("merge_gate", TARGET);
    await expect(http.request({ method: "GET", path })).rejects.toThrow("path_refused");
    expect(t.calls).toEqual([]);
  });

  it("answers any HTTP status as data, reads a non-JSON body as null, and logs the path with the repository masked", async () => {
    const t = setup((u) => (u.pathname.endsWith("/a") ? new Response(ghError(404, "Not Found").body, { status: 404 }) : new Response("<html>", { status: 502 })));
    const http = await t.open("read", TARGET);
    expect((await http.request({ method: "GET", path: "/repos/acme/widgets/a" })).status).toBe(404);
    expect(await http.request({ method: "GET", path: "/repos/acme/widgets/b" })).toEqual({ status: 502, body: null });
    expect(t.log[0]).toEqual({ method: "GET", path: "/repos/:o/:r/a", status: 404, message: "Not Found" });
    expect(JSON.stringify(t.log)).not.toContain("ghs_");
  });

  it("turns a transport failure into a fixed error that carries no cause", async () => {
    const t = setup(() => {
      throw new Error("socket exploded with ghs_faketoken inside");
    });
    const http = await t.open("read", TARGET);
    const err = await http.request({ method: "GET", path: "/repos/acme/widgets/a" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstallationHttpError);
    expect(String((err as Error).message)).not.toContain("ghs_");
  });

  it("refuses at open: no installation, a read-only App for the gate, and bad coordinates", async () => {
    await expect(setup(() => undefined, { noInstallation: true }).open("read", TARGET)).rejects.toThrow("no_installation");
    await expect(setup(() => undefined, { appKind: "team_readonly" }).open("merge_gate", TARGET)).rejects.toThrow();
    await expect(setup(() => undefined).open("read", { ...TARGET, owner: "-bad" })).rejects.toThrow("invalid_coordinates");
  });

  describe("runner_pr (D#6 R2b-3e)", () => {
    it("mints a one-repository token that can read refs and write pull requests, sends JSON Accept, and reaches /graphql and PATCH", async () => {
      const seen: Array<{ url: string; method: string; accept: string | null; type: string | null }> = [];
      const t = setup((u, init) => {
        const headers = new Headers(init?.headers);
        seen.push({ url: u.toString(), method: init?.method ?? "GET", accept: headers.get("accept"), type: headers.get("content-type") });
        return json(200, { ok: true });
      });
      const http = await t.open("runner_pr", TARGET);
      await http.request({ method: "POST", path: "/graphql", body: { query: "query X { __typename }", variables: {} } });
      await http.request({ method: "PATCH", path: "/repos/acme/widgets/pulls/3", body: { state: "closed" } });
      await http.request({ method: "POST", path: "/repos/acme/widgets/pulls", body: { title: "t" } });
      await http.request({ method: "GET", path: "/repos/acme/widgets/pulls", query: { head: "acme:fx/r-g1", state: "open" } });
      expect(t.minted).toHaveLength(1);
      expect(t.minted[0]).toMatchObject({ repositories: ["widgets"], permissions: { metadata: "read", contents: "read", pull_requests: "write" } });
      expect(seen.map((c) => [c.method, new URL(c.url).pathname])).toEqual([["POST", "/graphql"], ["PATCH", "/repos/acme/widgets/pulls/3"], ["POST", "/repos/acme/widgets/pulls"], ["GET", "/repos/acme/widgets/pulls"]]);
      expect(new URL(seen[0]!.url).origin).toBe("https://api.github.com");
      expect(new URL(seen[3]!.url).search).toBe("?head=acme%3Afx%2Fr-g1&state=open");
      for (const c of seen) expect(c.accept).toBe("application/vnd.github+json");
      expect(seen[0]!.type).toBe("application/json");
    });

    it("keeps /graphql and PATCH to this kind, refuses PUT and any other graphql shape, before a request is made", async () => {
      const t = setup(() => undefined);
      const gate = await t.open("merge_gate", TARGET);
      const read = await t.open("read", TARGET);
      const pr = await t.open("runner_pr", TARGET);
      await expect(gate.request({ method: "POST", path: "/graphql", body: {} })).rejects.toThrow("path_refused");
      await expect(read.request({ method: "POST", path: "/graphql", body: {} })).rejects.toThrow("path_refused");
      await expect(read.request({ method: "PATCH", path: "/repos/acme/widgets/pulls/3", body: {} })).rejects.toThrow("method_refused");
      await expect(gate.request({ method: "PATCH", path: "/repos/acme/widgets/pulls/3", body: {} })).rejects.toThrow("method_refused");
      await expect(pr.request({ method: "PUT", path: "/repos/acme/widgets/pulls/3/merge", body: {} })).rejects.toThrow("path_refused");
      for (const [method, path] of [["GET", "/graphql"], ["POST", "/graphql/x"], ["POST", "/graphql?x=1"], ["POST", "/app/installations/9/access_tokens"], ["POST", "/repos/acme/other/pulls"], ["PATCH", "/repos/acme/widgets/../other/pulls/3"]] as const) {
        await expect(pr.request({ method, path, body: {} }), `${method} ${path}`).rejects.toThrow("path_refused");
      }
      expect(t.calls).toEqual([]);
    });

    it.each([
      ["GET", "/repos/acme/widgets/contents/src/a.ts"],
      ["GET", "/repos/acme/widgets/readme"],
      ["GET", "/repos/acme/widgets/pulls/3/files"],
      ["GET", "/repos/acme/widgets/pulls/3"],
      ["GET", "/repos/acme/widgets/commits/abc123"],
      ["GET", "/repos/acme/widgets/tarball/main"],
      ["GET", "/repos/acme/widgets/git/blobs/abc"],
      ["POST", "/repos/acme/widgets/issues"],
      ["POST", "/repos/acme/widgets/pulls/3"],
      ["POST", "/repos/acme/widgets/contents/x"],
      ["PATCH", "/repos/acme/widgets/pulls"],
      ["PATCH", "/repos/acme/widgets/pulls/3/files"],
      ["PATCH", "/repos/acme/widgets/pulls/x3"],
      ["PATCH", "/repos/acme/widgets/issues/3"],
      ["PUT", "/repos/acme/widgets/pulls"],
      ["PUT", "/repos/acme/widgets/contents/x"],
    ] as const)("refuses %s %s with path_refused, before any request", async (method, path) => {
      const t = setup(() => undefined);
      const pr = await t.open("runner_pr", TARGET);
      await expect(pr.request({ method, path, body: {} })).rejects.toThrow("path_refused");
      expect(t.calls).toEqual([]);
    });

    it("needs the write App: a read-only installation cannot open it", async () => {
      await expect(setup(() => undefined, { appKind: "team_readonly" }).open("runner_pr", TARGET)).rejects.toThrow();
    });
  });
});
