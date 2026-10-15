import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiClientUsageError, buildRequest, request } from "../src/index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "api", "fixtures", "v1");
const fixture = (id: string, file: string): string => readFileSync(path.join(fixtures, id, file), "utf8");

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}
let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let reply: (req: Seen) => { status: number; body?: string; headers?: Record<string, string> };

// A real loopback HTTP server read by Node's real global fetch: no fetch double anywhere.
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() };
      seen.push(s);
      const r = reply(s);
      res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
      res.end(r.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen = [];
  reply = () => ({ status: 500 });
});

const cfg = () => ({ baseUrl, token: "tok-canary-123" }); // gitleaks:allow

describe("request", () => {
  it("sends the bearer token, the path, the query and reads a recorded fixture", async () => {
    reply = () => ({ status: 200, body: fixture("listRepos", "200-page.json") });
    const res = await request(cfg(), "listRepos", { query: { limit: "5" } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.data[0]?.full_name).toBe("acme/widgets");
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.url).toBe("/api/v1/repos?limit=5");
    expect(seen[0]?.headers.authorization).toBe("Bearer tok-canary-123");
  });

  it("encodes path parameters", async () => {
    reply = () => ({ status: 200, body: fixture("getRepo", "200-installed.json") });
    await request(cfg(), "getRepo", { path: { id: "a/b c" } });
    expect(seen[0]?.url).toBe("/api/v1/repos/a%2Fb%20c");
  });

  it("sends a JSON body with an Idempotency-Key", async () => {
    reply = () => ({ status: 202, body: "{}" });
    await request(cfg(), "cancelRun", { path: { id: "r1" } }, { idempotencyKey: "k-1" });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers["idempotency-key"]).toBe("k-1");
    await request(cfg(), "createToken", { body: { scopes: ["read"] } });
    expect(seen[1]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(seen[1]?.body ?? "")).toEqual({ scopes: ["read"] });
  });

  it("returns an error status as a result with the parsed API error", async () => {
    reply = () => ({ status: 404, body: fixture("getRepo", "404-not_found.json") });
    const res = await request(cfg(), "getRepo", { path: { id: "x" } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(404);
      expect(res.error?.error.code).toBe("not_found");
    }
  });

  it("returns a 429 with its Retry-After header and does not retry", async () => {
    reply = () => ({ status: 429, body: "{}", headers: { "retry-after": "7" } });
    const res = await request(cfg(), "listRuns");
    expect(res.ok).toBe(false);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(seen.length).toBe(1);
  });

  it("reads a 204 as null data and a non-JSON body as an error result with the text", async () => {
    reply = () => ({ status: 204, body: "" });
    const gone = await request(cfg(), "deleteToken", { path: { id: "t1" } });
    expect(gone).toMatchObject({ ok: true, status: 204, data: null });
    reply = () => ({ status: 200, body: "<html>" });
    const odd = await request(cfg(), "listRuns");
    expect(odd).toMatchObject({ ok: false, status: 200, error: null, text: "<html>" });
  });

  it("does not follow a redirect", async () => {
    reply = () => ({ status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } });
    const res = await request(cfg(), "listRuns");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(302);
    expect(seen.length).toBe(1);
  });

  it("rejects when no response arrives", async () => {
    await expect(request({ baseUrl: "http://127.0.0.1:1", token: "t" }, "listRuns")).rejects.toThrow();
  });
});

describe("buildRequest", () => {
  const c = { baseUrl: "https://example.test", token: "t" };
  it("refuses an unusable call before any request", () => {
    expect(() => buildRequest(c, "getRepo", {} as never)).toThrow(ApiClientUsageError);
    expect(() => buildRequest(c, "listRuns", { query: { nope: "1" } } as never)).toThrow(/no query parameter/);
    expect(() => buildRequest(c, "listRuns", undefined, { idempotencyKey: "k" })).toThrow(/does not accept/);
    expect(() => buildRequest(c, "retryRun", { path: { id: "r" } })).toThrow(/requires an Idempotency-Key/);
    expect(() => buildRequest({ ...c, token: "" }, "listRuns")).toThrow(/token is empty/);
  });
  it.each([".", ".."])("refuses %s as a path parameter instead of letting the URL resolve it away", (v) => {
    expect(() => buildRequest(c, "retryRun", { path: { id: v } }, { idempotencyKey: "k" })).toThrow(/not a valid identifier/);
    expect(buildRequest(c, "retryRun", { path: { id: "a.b" } }, { idempotencyKey: "k" }).url).toContain("/a.b");
  });
  it("lets the caller replace Accept, for streams", () => {
    const { init, url } = buildRequest(c, "listEvents", undefined, { headers: { Accept: "text/event-stream" } });
    expect((init.headers as Record<string, string>).accept).toBe("text/event-stream");
    expect(url).toBe("https://example.test/api/v1/events");
  });
});
