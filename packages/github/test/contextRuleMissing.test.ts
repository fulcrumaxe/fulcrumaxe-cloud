import https from "node:https";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { InstallationTokenCache, type AccessTokenRequester } from "../src/installationToken.js";
import { createInstallationHttp } from "../src/installationHttp.js";
import { createRepoTreeSource } from "../src/repoTreeSource.js";
import { createMissingResolver, type PinTreeSource } from "@fx/pipeline";
import { ghError, FETCH_DEFAULT_USER_AGENT, type GhReply, type GhRequest } from "./helpers/strictGithub.js";
import { startStrictGithubServer, type LocalTlsServer } from "./helpers/localTlsServer.js";

/**
 * D#600 CX-9b: the tree read behind "Path not found at <sha>", over real TLS (certificate and hostname checked, Node's fetch User-Agent, a one-repository
 * read-only token) against a strict GitHub that can answer `truncated: true`, 404 (a private repository the app cannot read) and 500. What it cannot fake:
 * GitHub's rate limits and the exact 100,000-entry cut. The counts asserted here are requests as the server saw them.
 */
const REPO = { accountId: "00000000-0000-4000-8000-000000000001", repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const B = "3".repeat(40);
let privateKeyPem: string;
beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});
const ok = (body: unknown): GhReply => ({ status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
const blobs = (...paths: string[]) => ({ truncated: false, tree: [{ path: "src", type: "tree", sha: B }, ...paths.map((path) => ({ path, type: "blob", sha: B, size: 1 }))] });

let server: LocalTlsServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** `state` is read on every request, so a test moves the head or the tree between views. */
async function setup(state: { head: string; trees: Record<string, unknown>; repoStatus?: number; treeStatus?: number; bound?: number }, clock: { t: number }) {
  const srv = await startStrictGithubServer((req: GhRequest): GhReply => {
    if (req.path === "/repos/acme/widgets") return state.repoStatus ? ghError(state.repoStatus, "x") : ok({ default_branch: "main" });
    if (req.path === "/repos/acme/widgets/git/ref/heads/main") return ok({ object: { sha: state.head, type: "commit" } });
    const m = /^\/repos\/acme\/widgets\/git\/trees\/([0-9a-f]{40})$/.exec(req.path);
    if (m) return state.treeStatus ? ghError(state.treeStatus, "x") : ok(state.trees[m[1]!]);
    return ghError(404, "Not Found");
  });
  server = srv;
  const requester: AccessTokenRequester = async () => ({ token: "ghs_faketoken", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = { "user-agent": FETCH_DEFAULT_USER_AGENT };
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    return await new Promise<Response>((resolve, reject) => {
      const req = https.request(
        { host: "api.github.com", port: srv.port, method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, headers, ca: srv.ca, servername: "api.github.com",
          lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never },
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
  const open = createInstallationHttp({ resolveInstallation: async () => ({ installationId: 9, appKind: "team" }), appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }), requester, cache: new InstallationTokenCache(), fetchImpl });
  const resolver = createMissingResolver({
    openTree: () => async (r): Promise<PinTreeSource> => createRepoTreeSource(await open("repo_map", r), r),
    now: () => clock.t,
    ...(state.bound ? { boundMs: state.bound } : {}),
  });
  const count = () => srv.seen.filter((s) => !s.path.startsWith("/app/")).length;
  return { resolver, srv, count };
}

describe("the missing-path tree read over real TLS (D#600 CX-9b)", () => {
  it("reads the repository, its default branch and the tree once (3 requests), then none inside the head window", async () => {
    const clock = { t: 1_000 };
    const { resolver, srv, count } = await setup({ head: C1, trees: { [C1]: blobs("src/a.ts") } }, clock);
    const first = await resolver.treeFor(REPO);
    expect(first?.sha).toBe(C1);
    expect(first?.files.has("src/a.ts")).toBe(true);
    expect(first?.files.has("src")).toBe(false); // a folder is not a file a pin can name
    expect(count()).toBe(3);
    for (const c of srv.seen.filter((s) => !s.path.startsWith("/app/"))) {
      expect(c.headers["user-agent"]).toBe(FETCH_DEFAULT_USER_AGENT);
      expect(c.servername).toBe("api.github.com");
    }
    clock.t += 59_000;
    expect((await resolver.treeFor(REPO))?.sha).toBe(C1);
    expect(count()).toBe(3);
  });

  it("after the window re-reads only the head (2 requests) while it is unchanged, and the tree (3) when it moved; the cache is by head sha", async () => {
    const clock = { t: 1_000 };
    const state = { head: C1, trees: { [C1]: blobs("src/a.ts"), [C2]: blobs("src/b.ts") } };
    const { resolver, count } = await setup(state, clock);
    await resolver.treeFor(REPO);
    clock.t += 61_000;
    expect((await resolver.treeFor(REPO))?.files.has("src/a.ts")).toBe(true);
    expect(count()).toBe(5);
    state.head = C2;
    clock.t += 61_000;
    const moved = await resolver.treeFor(REPO);
    expect(moved?.sha).toBe(C2);
    expect(moved?.files.has("src/a.ts")).toBe(false);
    expect(moved?.files.has("src/b.ts")).toBe(true);
    expect(count()).toBe(5 + 3);
  });

  it("a truncated tree says nothing (null), never a false 'missing'", async () => {
    const { resolver } = await setup({ head: C1, trees: { [C1]: { ...blobs("src/a.ts"), truncated: true } } }, { t: 1 });
    expect(await resolver.treeFor(REPO)).toBeNull();
  });

  it("a repository the app cannot read (404) says nothing, and the failure is not retried on the next views inside its window", async () => {
    const clock = { t: 1_000 };
    const { resolver, count } = await setup({ head: C1, trees: {}, repoStatus: 404 }, clock);
    expect(await resolver.treeFor(REPO)).toBeNull();
    const after = count();
    expect(after).toBeGreaterThan(0);
    clock.t += 5_000;
    expect(await resolver.treeFor(REPO)).toBeNull();
    expect(count()).toBe(after);
    clock.t += 30_000;
    await resolver.treeFor(REPO);
    expect(count()).toBeGreaterThan(after);
  });

  it("a GitHub error on the tree says nothing, and a good tree cached earlier survives a later failure", async () => {
    const clock = { t: 1_000 };
    const state: { head: string; trees: Record<string, unknown>; treeStatus?: number } = { head: C1, trees: { [C1]: blobs("src/a.ts") } };
    const { resolver, count } = await setup(state, clock);
    await resolver.treeFor(REPO);
    clock.t += 61_000;
    state.head = C2;
    state.treeStatus = 500;
    expect(await resolver.treeFor(REPO)).toBeNull();
    clock.t += 31_000;
    state.head = C1;
    delete state.treeStatus;
    const before = count();
    expect((await resolver.treeFor(REPO))?.sha).toBe(C1);
    expect(count() - before, "only the head is read: the earlier tree for the same head was kept through the failure").toBe(2);
  });

  it("is bounded: a read slower than the bound answers null at once, and the read it left running fills the cache for the next view", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const resolver = createMissingResolver({
      openTree: () => async () => ({ headSha: async () => (await gate, C1), tree: async () => ({ truncated: false, entries: [{ path: "a", type: "blob" as const }] }) }),
      boundMs: 20,
    });
    const t0 = Date.now();
    expect(await resolver.treeFor(REPO)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect((await resolver.treeFor(REPO))?.files.has("a")).toBe(true);
  });

  it("two views at once share one read", async () => {
    let opened = 0;
    const resolver = createMissingResolver({
      openTree: () => async () => (opened++, { headSha: async () => C1, tree: async () => ({ truncated: false, entries: [] }) }),
    });
    await Promise.all([resolver.treeFor(REPO), resolver.treeFor(REPO)]);
    expect(opened).toBe(1);
  });

  it("no tree reader registered says nothing", async () => {
    expect(await createMissingResolver({ openTree: () => null }).treeFor(REPO)).toBeNull();
  });
});
