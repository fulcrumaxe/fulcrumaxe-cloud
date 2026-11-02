import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMergeQueueModeCache, MERGE_QUEUE_MODE_CACHE_MAX, MERGE_QUEUE_MODE_TTL_MS } from "@fx/pipeline";
import { createInstallationHttp, InstallationTokenCache } from "@fx/github";

// The repos row comes from this fake (the tenant wrapper only hands the callback a client); everything else is the real client over a real local HTTP server.
let row: { gh_owner: string | null; gh_name: string | null; execution_mode: string } | undefined;
vi.mock("@fx/core/src/tenancy/withTenant.js", () => ({
  withTenant: async (_pool: unknown, _account: string, fn: (c: unknown) => unknown) =>
    fn({ query: async (_sql: string, args: string[]) => ({ rows: row === undefined ? [] : [{ ...row, gh_name: row.gh_name === "<by-repo>" ? `r${args[1]}` : row.gh_name }] }) }),
}));
const { createMergeQueueModeReader } = await import("./mergeQueueMode");

const ACCOUNT = "acct";
let privateKeyPem: string;
let server: Server;
let port: number;
const calls: string[] = [];
let queue: { graphql: unknown; rules: unknown[]; repo: unknown };

beforeAll(async () => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0]!;
      calls.push(`${req.method} ${path.replace(/\/repos\/acme\/[^/]+/, "/repos/acme/R")}`);
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && path === "/graphql") res.end(JSON.stringify(queue.graphql));
      else if (path.includes("/rules/branches/")) res.end(JSON.stringify(queue.rules));
      else res.end(JSON.stringify(queue.repo));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  calls.length = 0;
  clearMergeQueueModeCache();
  row = { gh_owner: "acme", gh_name: "widgets", execution_mode: "cloud" };
  queue = { repo: { default_branch: "main" }, graphql: { data: { repository: { mergeQueue: null } } }, rules: [] };
});
afterEach(() => vi.useRealTimers());

const reader = (now?: () => number) =>
  createMergeQueueModeReader(
    {} as Pool,
    createInstallationHttp({
      resolveInstallation: async () => ({ installationId: 9, appKind: "team" }),
      appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }),
      requester: async (p) => ({ token: "ghs_" + "a".repeat(30), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: p.permissions as Record<string, string>, ...(p.repositories ? { repositories: p.repositories } : {}) }),
      cache: new InstallationTokenCache(),
      fetchImpl: (async (url: URL, init: RequestInit) => fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init)) as unknown as typeof fetch,
    }),
    now,
  );
const on = () => {
  queue.graphql = { data: { repository: { mergeQueue: { id: "MQ_1" } } } };
  queue.rules = [{ type: "merge_queue", parameters: {} }];
};

describe("D#694 B7-2: the merge queue line's reader", () => {
  it("is on when the queue and the rules agree, off when neither shows one, with three calls on a cold read", async () => {
    on();
    expect(await reader().read({ accountId: ACCOUNT, repoId: "a" })).toBe("on");
    expect(calls).toEqual(["GET /repos/acme/R", "POST /graphql", "GET /repos/acme/R/rules/branches/main"]);
    queue = { repo: { default_branch: "main" }, graphql: { data: { repository: { mergeQueue: null } } }, rules: [] };
    clearMergeQueueModeCache(); // the merge port's own answer for this repository and branch is shared with the merge gate, so it is still "queue" here
    expect(await reader().read({ accountId: ACCOUNT, repoId: "b" })).toBe("off");
  });

  it("makes zero GitHub calls for a second read inside five minutes, and reads again once the entry is older", async () => {
    let t = 1_000_000;
    const r = reader(() => t);
    on();
    expect(await r.read({ accountId: ACCOUNT, repoId: "a" })).toBe("on");
    const cold = calls.length;
    t += MERGE_QUEUE_MODE_TTL_MS - 1;
    expect(await r.read({ accountId: ACCOUNT, repoId: "a" })).toBe("on");
    expect(calls.length).toBe(cold);
    t += 1;
    expect(await r.read({ accountId: ACCOUNT, repoId: "a" })).toBe("on");
    expect(calls.length).toBe(cold * 2);
  });

  it("never answers from a result older than the TTL, even when a second reader re-read the first one's cached answer late", async () => {
    let t = 1_000_000;
    const first = reader(() => t);
    const second = reader(() => t);
    on();
    expect(await first.read({ accountId: ACCOUNT, repoId: "a" })).toBe("on"); // the merge port's cache is filled here, as the merge gate would fill it
    t += MERGE_QUEUE_MODE_TTL_MS - 1;
    expect(await second.read({ accountId: ACCOUNT, repoId: "a" })).toBe("on"); // answered from the port's cache, which is almost expired
    queue = { repo: { default_branch: "main" }, graphql: { data: { repository: { mergeQueue: null } } }, rules: [] }; // GitHub now says off
    t += MERGE_QUEUE_MODE_TTL_MS - 1; // the port's answer is now 2 * TTL - 2 old; the second reader's read must not have extended its life
    expect(await second.read({ accountId: ACCOUNT, repoId: "a" })).toBe("off");
  });

  it("keeps at most 500 answers, the oldest out", async () => {
    row = { gh_owner: "acme", gh_name: "<by-repo>", execution_mode: "cloud" };
    let t = 1_000_000;
    const r = reader(() => t++);
    for (let i = 0; i <= MERGE_QUEUE_MODE_CACHE_MAX; i++) await r.read({ accountId: ACCOUNT, repoId: String(i) });
    const before = calls.length;
    await r.read({ accountId: ACCOUNT, repoId: String(MERGE_QUEUE_MODE_CACHE_MAX) });
    expect(calls.length).toBe(before);
    await r.read({ accountId: ACCOUNT, repoId: "0" });
    expect(calls.length).toBeGreaterThan(before);
  }, 60_000);

  it.each([
    ["the queue and the rules disagree", () => { queue.rules = [{ type: "merge_queue", parameters: {} }]; }],
    ["GitHub refuses the query for want of a permission", () => { queue.graphql = { errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] }; }],
    ["GitHub answers a shape it was not asked for", () => { queue.graphql = { data: {} }; }],
    ["the repository has no default branch", () => { queue.repo = {}; }],
  ])("is unreadable, never off, when %s, and the failure is not cached", async (_n, arrange) => {
    arrange();
    const r = reader();
    expect(await r.read({ accountId: ACCOUNT, repoId: "a" })).toBe("unreadable");
    const first = calls.length;
    expect(await r.read({ accountId: ACCOUNT, repoId: "a" })).toBe("unreadable");
    expect(calls.length).toBeGreaterThan(first);
  });

  it("is runner, with no call, for a runner_local repo (its merge belongs to the customer's runner)", async () => {
    row = { gh_owner: "acme", gh_name: "widgets", execution_mode: "runner_local" };
    expect(await reader().read({ accountId: ACCOUNT, repoId: "a" })).toBe("runner");
    expect(calls).toEqual([]);
  });

  it("is unreadable with no call for a repo with no owner, and a repo that is missing", async () => {
    row = { gh_owner: null, gh_name: null, execution_mode: "cloud" };
    expect(await reader().read({ accountId: ACCOUNT, repoId: "a" })).toBe("unreadable");
    row = undefined;
    expect(await reader().read({ accountId: ACCOUNT, repoId: "a" })).toBe("unreadable");
    expect(calls).toEqual([]);
  });
});
