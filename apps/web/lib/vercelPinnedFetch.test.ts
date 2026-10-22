import { afterEach, describe, expect, it } from "vitest";
import { NetGuardError, resolveChecked } from "@fx/net-guard";
import { createVercelEnvSource, VERCEL_USER_AGENT } from "@fx/core/src/setup-requests/vercelEnvSource";
import { FakeVercel } from "../../../packages/core/test/support/vercelEnvFake";
import { startLocalTlsServer, type LocalTlsServer } from "../../../packages/github/test/helpers/localTlsServer.js";
import { createNodeHttpsPinnedRequester } from "../app/api/gh-proxy/[...path]/handler";
import { createPinnedVercelFetch } from "./vercelPinnedFetch";

/**
 * D#598 P8d-1 (CWE-918): the Vercel adapter's transport. Refusals are proven with a requester that records what it is given; the real run goes
 * through the production pinned connector over verified TLS to a loopback server whose certificate names api.vercel.com.
 */
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OK = "https://api.vercel.com/v10/projects/cloud-staging/env?decrypt=false&limit=100";
const stream = (text: string) => new Response(text).body;

function recorder(reply: { status: number; body?: string } = { status: 200, body: '{"envs":[]}' }) {
  const resolved: string[] = [];
  const sent: Array<{ host: string; address: string; method: string; path: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = createPinnedVercelFetch({
    resolveUpstream: async (host) => (resolved.push(host), ["76.76.21.21", "76.76.21.22"]),
    forwardPinned: async (params) => {
      sent.push({ ...params });
      return { status: reply.status, headers: {}, bodyStream: reply.body === undefined ? null : stream(reply.body) };
    },
  });
  return { fetchImpl, resolved, sent };
}

describe("createPinnedVercelFetch refusals", () => {
  it("sends GET https://api.vercel.com/v10/projects/<name>/env to the first validated address, with SNI/Host api.vercel.com and the caller's headers", async () => {
    const t = recorder();
    const res = await t.fetchImpl(new URL(OK), { headers: { Authorization: "Bearer tok", "User-Agent": "ua/1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ envs: [] });
    expect(t.resolved).toEqual(["api.vercel.com"]);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ host: "api.vercel.com", address: "76.76.21.21", method: "GET", path: "/v10/projects/cloud-staging/env?decrypt=false&limit=100", body: null });
    expect(t.sent[0]!.headers).toMatchObject({ authorization: "Bearer tok", "user-agent": "ua/1" });
  });

  it("sends the connect-time token check, GET /v10/projects with only limit and teamId, the same way", async () => {
    const t = recorder({ status: 200, body: '{"projects":[]}' });
    const res = await t.fetchImpl(new URL("https://api.vercel.com/v10/projects?limit=1&teamId=team_abc1"), { headers: { Authorization: "Bearer tok" } });
    expect(res.status).toBe(200);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ host: "api.vercel.com", method: "GET", path: "/v10/projects?limit=1&teamId=team_abc1", body: null });
  });

  it("refuses any other host, scheme, port, credentials, fragment, path, method, body or decrypt=true, before resolving or sending anything", async () => {
    const t = recorder();
    const bad: Array<[string, RequestInit?]> = [
      ["https://evil.example/v10/projects/cloud-staging/env"],
      ["https://api.vercel.com.evil.example/v10/projects/cloud-staging/env"],
      ["http://api.vercel.com/v10/projects/cloud-staging/env"],
      ["https://api.vercel.com:8443/v10/projects/cloud-staging/env"],
      ["https://user:pw@api.vercel.com/v10/projects/cloud-staging/env"],
      ["https://api.vercel.com/v10/projects/cloud-staging/env#x"],
      ["https://api.vercel.com/v9/projects/cloud-staging/env"],
      ["https://api.vercel.com/v10/projects/cloud-staging/env/abc"],
      ["https://api.vercel.com/v10/projects/Cloud%20Staging/env"],
      ["https://api.vercel.com/v10/projects/../teams/env"],
      ["https://api.vercel.com/v1/projects/cloud-staging/env/abc"],
      ["https://api.vercel.com/v2/user"],
      ["https://api.vercel.com/v10/projects?limit=1&decrypt=true"],
      ["https://api.vercel.com/v10/projects?limit=1&search=x"],
      ["https://api.vercel.com/v10/projects/"],
      ["https://api.vercel.com/v11/projects?limit=1"],
      ["https://api.vercel.com/v10/projects/cloud-staging/env?decrypt=true"],
      ["https://api.vercel.com/v10/projects/cloud-staging/env?decrypt=false&decrypt=true"],
      [OK, { method: "POST" }],
      [OK, { method: "DELETE" }],
      [OK, { method: "GET", body: "x" }],
      ["not a url"],
    ];
    for (const [url, init] of bad) await expect(t.fetchImpl(url, init), url).rejects.toThrow(/pinned vercel fetch/);
    expect(t.resolved).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it("refuses a host that resolves to a blocked address (private, loopback, link-local, metadata) and sends nothing", async () => {
    for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.1", "::1"]) {
      const sent: unknown[] = [];
      const fetchImpl = createPinnedVercelFetch({
        resolveUpstream: (host) => resolveChecked(host, async () => [{ address, family: address.includes(":") ? 6 : 4 }]),
        forwardPinned: async (p) => (sent.push(p), { status: 200, headers: {}, bodyStream: null }),
      });
      await expect(fetchImpl(OK, { headers: {} }), address).rejects.toBeInstanceOf(NetGuardError);
      expect(sent, address).toEqual([]);
    }
    const none = createPinnedVercelFetch({ resolveUpstream: async () => [], forwardPinned: async () => ({ status: 200, headers: {}, bodyStream: null }) });
    await expect(none(OK, { headers: {} })).rejects.toThrow(/no address/);
  });

  it("never follows a redirect, whatever the status", async () => {
    for (const status of [301, 302, 303, 307, 308]) await expect(recorder({ status }).fetchImpl(OK, { headers: {}, redirect: "error" }), String(status)).rejects.toThrow(/redirect/);
  });

  it("the caller's abort signal ends a call that never answers and a body that stalls", async () => {
    const never = createPinnedVercelFetch({ resolveUpstream: async () => ["76.76.21.21"], forwardPinned: () => new Promise(() => undefined) });
    await expect(never(OK, { headers: {}, signal: AbortSignal.timeout(100) })).rejects.toMatchObject({ name: "TimeoutError" });
    const stalled = createPinnedVercelFetch({
      resolveUpstream: async () => ["76.76.21.21"],
      forwardPinned: async () => ({ status: 200, headers: {}, bodyStream: new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }) }),
    });
    const res = await stalled(OK, { headers: {}, signal: AbortSignal.timeout(100) });
    await expect(res.text()).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("the adapter through the real pinned connector over TLS [loopback]", () => {
  const servers: LocalTlsServer[] = [];
  afterEach(async () => {
    while (servers.length > 0) await servers.pop()!.close();
  });
  const start = async (respond: (req: { method: string; path: string; query?: string; headers: Record<string, string> }) => { status: number; headers?: Record<string, string>; body?: string }) => {
    const server = await startLocalTlsServer({ dnsNames: ["api.vercel.com"], ipAddresses: ["127.0.0.1"] }, respond);
    servers.push(server);
    return server;
  };
  // The production connector with only the port and the trusted CA overridden; the address is the loopback one the test resolves to
  // (the real net guard would refuse it, which the refusal test above proves).
  const fetchFor = (server: LocalTlsServer) =>
    createPinnedVercelFetch({ resolveUpstream: async () => ["127.0.0.1"], forwardPinned: createNodeHttpsPinnedRequester({ port: server.port, ca: server.ca }) });

  it("lists every page with verified TLS (SNI api.vercel.com), the User-Agent, the bearer token and decrypt=false on each request", async () => {
    const fake = new FakeVercel().connect(ACCOUNT).project("cloud-staging", Array.from({ length: 5 }, (_, i) => ({ key: `VAR_${i}`, value: "sk_live_SECRET", target: ["production"] })));
    fake.pageSize = 2;
    const server = await start((req) => {
      const answer = fake.handle({ method: req.method, url: req.query === undefined ? req.path : `${req.path}?${req.query}`, headers: req.headers });
      return { status: answer.status, headers: { "content-type": "application/json" }, body: JSON.stringify(answer.body) };
    });
    const lines: string[] = [];
    const source = createVercelEnvSource({ credentials: fake.resolver(), fetch: fetchFor(server), log: (l) => void lines.push(l) });
    const result = await source.listEnvNames({ accountId: ACCOUNT, project: "cloud-staging" });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.entries).toHaveLength(5);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(server.seen).toHaveLength(3);
    for (const seen of server.seen) {
      expect(seen.servername).toBe("api.vercel.com");
      expect(seen.method).toBe("GET");
      expect(seen.path).toBe("/v10/projects/cloud-staging/env");
      expect(seen.headers["user-agent"]).toBe(VERCEL_USER_AGENT);
      expect(seen.headers.authorization).toBe(`Bearer vtok_${ACCOUNT}`);
      expect(seen.headers.host).toBe("api.vercel.com");
      expect(new URLSearchParams(seen.query).getAll("decrypt")).toEqual(["false"]);
    }
    expect(lines.join("")).not.toMatch(/SECRET|Bearer|vtok_/);
  });

  it("a redirect from the server is refused: one request, a fixed failure, the token goes nowhere else", async () => {
    const server = await start(() => ({ status: 302, headers: { location: "https://evil.example/steal" } }));
    const lines: string[] = [];
    const source = createVercelEnvSource({ credentials: new FakeVercel().connect(ACCOUNT).resolver(), fetch: fetchFor(server), log: (l) => void lines.push(l) });
    expect(await source.listEnvNames({ accountId: ACCOUNT, project: "cloud-staging" })).toEqual({ ok: false });
    expect(server.seen).toHaveLength(1);
    expect(lines.join("")).not.toContain("evil.example");
  });

  it("a certificate that does not name api.vercel.com is not trusted: the call fails closed", async () => {
    const wrong = await startLocalTlsServer({ dnsNames: ["not-vercel.example"], ipAddresses: ["127.0.0.1"] }, () => ({ status: 200, body: '{"envs":[]}' }));
    servers.push(wrong);
    const source = createVercelEnvSource({ credentials: new FakeVercel().connect(ACCOUNT).resolver(), fetch: fetchFor(wrong), log: () => undefined });
    expect(await source.listEnvNames({ accountId: ACCOUNT, project: "cloud-staging" })).toEqual({ ok: false });
  });
});
