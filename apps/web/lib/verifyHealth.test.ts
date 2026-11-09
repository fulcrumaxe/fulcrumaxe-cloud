import { afterEach, describe, expect, it, vi } from "vitest";
import { startLocalTlsServer, type LocalReply, type LocalTlsServer } from "../../../packages/github/test/helpers/localTlsServer.js";
import { createNodeHttpsPinnedRequester } from "../app/api/gh-proxy/[...path]/handler";
import { parseBaseUrl } from "@fx/core/src/verify/settings.js";
import { createVerifyHealthReader, MAX_BODY_BYTES } from "./verifyHealth";

/**
 * D#749 V3a: the verify stage's reader of a deployed app's /api/health, over Node's REAL connection path: a local TLS server with a certificate for the app's name, the
 * client given that certificate as its explicit CA (never `rejectUnauthorized: false`), SNI and Host checked. The server is strict the way the platform is: a request with no
 * User-Agent is refused (403), and anything but GET /api/health is a 404. What this cannot fake: the platform's real edge (redirects to a login wall, rate limits).
 */
const HOST = "staging.example.test";
const COMMIT = "ab".repeat(20);
let server: LocalTlsServer | undefined;

async function start(reply: (path: string) => LocalReply | Promise<LocalReply>): Promise<LocalTlsServer> {
  server = await startLocalTlsServer({ dnsNames: [HOST] }, (req) => {
    if (!req.headers["user-agent"]) return { status: 403, body: "Request forbidden by administrative rules." };
    if (req.method !== "GET" || req.path !== "/api/health") return { status: 404, body: "{}" };
    return reply(req.path);
  });
  return server;
}
const reader = (s: LocalTlsServer, over: Parameters<typeof createVerifyHealthReader>[0] = {}) =>
  createVerifyHealthReader({ resolveUpstream: async () => ["127.0.0.1"], forwardPinned: createNodeHttpsPinnedRequester({ port: s.port, ca: s.ca }), ...over });
const json = (body: unknown, status = 200): LocalReply => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("the verify stage's health reader", () => {
  it("reads the commit of a healthy app: one GET /api/health with a User-Agent, SNI and Host the app's name, over verified TLS", async () => {
    const s = await start(() => json({ ok: true, deploy_env: "staging", commit: COMMIT }));
    expect(await reader(s)(`https://${HOST}`)).toEqual({ kind: "ok", commit: COMMIT });
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]).toMatchObject({ method: "GET", path: "/api/health", servername: HOST });
    expect(s.seen[0]!.headers["user-agent"]).toBeTruthy();
    expect(s.seen[0]!.headers.host).toBe(HOST);
    expect(s.seen[0]!.headers.authorization).toBeUndefined();
  });

  it("a 503 (settings incomplete) still carries the identity, so the commit is read from it too", async () => {
    const s = await start(() => json({ ok: false, config: "incomplete", commit: COMMIT }, 503));
    expect(await reader(s)(`https://${HOST}`)).toEqual({ kind: "ok", commit: COMMIT });
  });

  it("a commit that is not a commit id (or none, or a non-string) reads as no commit, and the text is never returned", async () => {
    for (const commit of [null, undefined, "main", "AB".repeat(20), "<b>x</b>", 5, ["x"], "ab".repeat(20) + "0"]) {
      const s = await start(() => json({ ok: true, commit }));
      expect(await reader(s)(`https://${HOST}`), String(commit)).toEqual({ kind: "ok", commit: null });
      await s.close();
      server = undefined;
    }
  });

  it("everything that is not a plain JSON answer from the app is unreachable: a redirect (never followed), a 404, a 500, an HTML wall, an array, bad JSON, an empty body", async () => {
    const cases: Array<[string, LocalReply]> = [
      ["redirect", { status: 302, headers: { location: "https://login.example.test/" } }],
      ["404", { status: 404, body: "{}" }],
      ["500", { status: 500, body: "{}" }],
      ["html", { status: 200, headers: { "content-type": "text/html" }, body: "<html>sign in</html>" }],
      ["array", json([COMMIT])],
      ["null", { status: 200, body: "null" }],
      ["empty", { status: 200, body: "" }],
    ];
    for (const [label, r] of cases) {
      const s = await start(() => r);
      expect(await reader(s)(`https://${HOST}`), label).toEqual({ kind: "unreachable" });
      expect(s.seen, label).toHaveLength(1);
      await s.close();
      server = undefined;
    }
  });

  it("a body past the cap is unreachable, not read to the end", async () => {
    const s = await start(() => ({ status: 200, body: JSON.stringify({ commit: COMMIT, pad: "x".repeat(MAX_BODY_BYTES) }) }));
    expect(await reader(s)(`https://${HOST}`)).toEqual({ kind: "unreachable" });
  });

  it("an app that never answers is unreachable after the timeout", async () => {
    const s = await start(() => new Promise<LocalReply>(() => undefined));
    expect(await reader(s, { timeoutMs: 150 })(`https://${HOST}`)).toEqual({ kind: "unreachable" });
  });

  it("a certificate that does not name the host fails the connection: unreachable", async () => {
    const s = await start(() => json({ commit: COMMIT }));
    expect(await reader(s)("https://other.example.test")).toEqual({ kind: "unreachable" });
    expect(s.seen).toEqual([]);
  });

  it("a base URL that is not a bare https origin is refused before anything is resolved or sent", async () => {
    const resolveUpstream = vi.fn(async () => ["127.0.0.1"]);
    const s = await start(() => json({ commit: COMMIT }));
    const read = reader(s, { resolveUpstream });
    for (const url of [`http://${HOST}`, `https://${HOST}:8443`, `https://${HOST}/app`, `https://u:p@${HOST}`, `https://${HOST}/?a=1`, `https://${HOST}/#x`, "not a url", ""]) {
      expect(await read(url), url).toEqual({ kind: "unreachable" });
    }
    expect(resolveUpstream).not.toHaveBeenCalled();
    expect(s.seen).toEqual([]);
  });

  it("agrees with the settings check on the base URL: whatever the settings refuse (a port, among them) the reader refuses, and every address the settings keep is read", async () => {
    const resolveUpstream = vi.fn(async () => ["127.0.0.1"]);
    const s = await start(() => json({ commit: COMMIT }));
    const read = reader(s, { resolveUpstream });
    const candidates = [`https://${HOST}`, `https://${HOST}/`, `https://${HOST}:8443`, `https://${HOST}:99999`, "https://127.0.0.1:3000", `http://${HOST}`, `https://${HOST}/app`];
    for (const url of candidates) {
      let saved = true;
      try {
        parseBaseUrl(url);
      } catch {
        saved = false;
      }
      const answer = await read(url);
      if (!saved) expect(answer, `${url} is refused by the settings, so it must not be read`).toEqual({ kind: "unreachable" });
      else expect(answer, `${url} is kept by the settings, so it must be read`).toEqual({ kind: "ok", commit: COMMIT });
    }
    expect(parseBaseUrl(`https://${HOST}`)).toBe(`https://${HOST}`);
    expect(() => parseBaseUrl(`https://${HOST}:8443`)).toThrow();
  });

  it("the net guard's own resolver refuses a name that resolves to this machine: nothing is sent", async () => {
    const s = await start(() => json({ commit: COMMIT }));
    const read = createVerifyHealthReader({ forwardPinned: createNodeHttpsPinnedRequester({ port: s.port, ca: s.ca }) });
    expect(await read("https://localhost")).toEqual({ kind: "unreachable" });
    expect(await read("https://127.0.0.1")).toEqual({ kind: "unreachable" });
    expect(s.seen).toEqual([]);
  });

  it("a resolver that answers nothing, or throws, is unreachable", async () => {
    const s = await start(() => json({ commit: COMMIT }));
    expect(await reader(s, { resolveUpstream: async () => [] })(`https://${HOST}`)).toEqual({ kind: "unreachable" });
    expect(await reader(s, { resolveUpstream: async () => { throw new Error("dns"); } })(`https://${HOST}`)).toEqual({ kind: "unreachable" });
    expect(s.seen).toEqual([]);
  });
});
