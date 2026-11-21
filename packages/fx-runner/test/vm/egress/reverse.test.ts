import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Lookup } from "../../../src/vm/egress/proxy.js";
import { startEgressProxy } from "../../../src/vm/egress/proxy.js";
import { startReverseEndpoint, TEST_HOOKS, type ReverseDecision, type ReverseEndpoint, type ReverseOptions } from "../../../src/vm/egress/reverse.js";
import { generateSelfSignedCert } from "../../helpers/selfSignedCert.js";
import { canBindAsSubordinateUid } from "../../helpers/subordinateUid.js";

const UID = process.getuid!();
const canUseOtherUid = canBindAsSubordinateUid();
const PUBLIC_A = "93.184.216.34";
const SECRET = "sk-test-secret-value";
const NAMES = ["api.example.com", "fwd.example.com", "pkg.example.com"];
const cert = generateSelfSignedCert("api.example.com", 1, { dnsNames: NAMES });
// A valid certificate for a different name, to prove the name is checked and not only the chain.
const otherCert = generateSelfSignedCert("elsewhere.example.com", 1, { dnsNames: ["elsewhere.example.com"] });
const POLICY = {
  allow: {
    "api.example.com": [{ transform: [{ headers: { "x-api-key": SECRET, "ai-reporting-tags": "run:1" } }] }],
    "git.example.com": [{ forwardURL: "https://fwd.example.com/api/fwd" }],
    "pkg.example.com": [],
    "match.example.com": [{ match: "x", transform: [{ headers: { "x-api-key": SECRET } }] }],
    "two.example.com": [{ transform: [{ headers: { "x-a": "1" } }] }, { transform: [{ headers: { "x-b": "2" } }] }],
  },
};
const ANSWERS: Record<string, string[]> = { "api.example.com": [PUBLIC_A], "fwd.example.com": [PUBLIC_A] };

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
let root: string;
let endpoints: ReverseEndpoint[];
let sockets: Set<net.Socket>;
let upstream: https.Server;
let upstreamPort: number;
let seen: Seen[];
let handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

async function startUpstream(c = cert): Promise<void> {
  upstream = https.createServer({ key: c.keyPem, cert: c.certPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  upstream.on("connection", (s: net.Socket) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
}

beforeEach(async () => {
  root = mkdtempSync(path.join(existsSync("/tmp") ? "/tmp" : os.tmpdir(), "fx-reverse-"));
  chmodSync(root, 0o711);
  endpoints = [];
  sockets = new Set();
  seen = [];
  handler = (_req, res) => void res.end("ok");
  await startUpstream();
});
afterEach(async () => {
  for (const e of endpoints) await e.close();
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

interface Harness {
  endpoint: ReverseEndpoint;
  lookups: string[];
  targets: string[];
  decisions: ReverseDecision[];
}
async function start(extra: Partial<ReverseOptions> = {}, answers: Record<string, string[]> = ANSWERS, policy: unknown = POLICY, id = "sb1"): Promise<Harness> {
  const dir = path.join(root, id);
  mkdirSync(dir, { mode: 0o1770 });
  chmodSync(dir, 0o1770);
  const h = { lookups: [], targets: [], decisions: [] } as unknown as Harness;
  const lookup: Lookup = async (host) => {
    h.lookups.push(host);
    const list = answers[host];
    if (!list) throw new Error("ENOTFOUND");
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  h.endpoint = await startReverseEndpoint({
    uid: UID,
    vsockDir: dir,
    sandboxId: id,
    policy,
    lookup,
    ownAddresses: () => new Set(["198.51.100.9"]),
    [TEST_HOOKS]: {
      target: (address) => {
        h.targets.push(address);
        return { address: "127.0.0.1", port: upstreamPort };
      },
      ca: cert.certPem,
    },
    onDecision: (d) => h.decisions.push(d),
    ...extra,
  });
  endpoints.push(h.endpoint);
  return h;
}

/** What the in-guest shim does: send these bytes down the Unix socket and read until the endpoint closes. */
function raw(h: Harness, text: string, end = true): Promise<{ status: number; head: string; body: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(h.endpoint.socketPath);
    let data = "";
    socket.on("data", (c) => (data += String(c)));
    socket.once("error", reject);
    socket.once("close", () => {
      const [head = "", ...rest] = data.split("\r\n\r\n");
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0), head, body: rest.join("\r\n\r\n"), socket });
    });
    socket.write(text, () => end && void 0);
  });
}
const get = (h: Harness, host: string, p = "/", extra = ""): Promise<{ status: number; head: string; body: string }> => raw(h, `GET ${p} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`);
const refused = (r: { body: string }): string => /egress refused: (\w+)/.exec(r.body)?.[1] ?? r.body;

describe("reverse endpoint: a transform host", () => {
  it("makes the upstream TLS request itself, adds the credential, and the guest's own credentials never arrive", async () => {
    const h = await start();
    const r = await get(h, "api.example.com", "/v1/messages?beta=true", `Authorization: Bearer guest\r\nx-api-key: guest-key\r\nCookie: a=b\r\nProxy-Authorization: Basic x\r\nx-custom-token: t\r\nx-app-secret: s\r\nx-forwarded-for: 6.6.6.6\r\nanthropic-version: 2023-06-01\r\n`);
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.url).toBe("/v1/messages?beta=true");
    expect(s.headers["x-api-key"]).toBe(SECRET);
    expect(s.headers["ai-reporting-tags"]).toBe("run:1");
    expect(s.headers["anthropic-version"]).toBe("2023-06-01");
    expect(s.headers.host).toBe("api.example.com");
    for (const name of ["authorization", "cookie", "proxy-authorization", "x-custom-token", "x-app-secret", "x-forwarded-for"]) expect(s.headers[name], name).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(h.decisions).toEqual([{ outcome: "allow", host: "api.example.com" }]);
  });
  it("does not relay set-cookie or credential-shaped response headers to the guest", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "set-cookie": "sid=1", "x-session-token": "t", "x-ok": "1" });
      res.end("ok");
    };
    const h = await start();
    const r = await get(h, "api.example.com");
    expect(r.head).toMatch(/x-ok: 1/i);
    expect(r.head).not.toMatch(/set-cookie|x-session-token/i);
  });
  it("accepts :80 on the Host and an absolute-form request line for the same host", async () => {
    const h = await start();
    expect((await get(h, "API.example.com:80")).status).toBe(200);
    expect((await raw(h, "GET http://api.example.com/x?y=1 HTTP/1.1\r\nHost: api.example.com\r\nConnection: close\r\n\r\n")).status).toBe(200);
    expect(seen.map((s) => s.url)).toEqual(["/", "/x?y=1"]);
  });
  it("resolves once per request and connects to that validated address, never the name", async () => {
    const h = await start();
    await get(h, "api.example.com");
    await get(h, "api.example.com");
    expect(h.lookups).toEqual(["api.example.com", "api.example.com"]);
    expect(h.targets).toEqual([PUBLIC_A, PUBLIC_A]);
  });
  it("relays the upstream status and headers unchanged and does not follow a redirect; hop-by-hop headers are dropped", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "https://elsewhere.example.com/", "x-keep": "1", "keep-alive": "timeout=5" });
      res.end();
    };
    const h = await start();
    const r = await get(h, "api.example.com");
    expect(r.status).toBe(302);
    expect(r.head).toMatch(/location: https:\/\/elsewhere\.example\.com\//i);
    expect(r.head).toMatch(/x-keep: 1/i);
    expect(r.head).not.toMatch(/keep-alive/i);
    expect(seen).toHaveLength(1);
  });
});

describe("reverse endpoint: a forwardURL host", () => {
  it("sends the request to the forward URL with the guest's path appended, naming the policy host itself", async () => {
    const h = await start({ inject: (host) => (host === "git.example.com" ? { "x-runner-credential": "lease-1" } : undefined) });
    const r = await get(h, "git.example.com", "/org/repo.git/info/refs?service=git-upload-pack", "x-forwarded-host: evil.example.com\r\nVercel-Forwarded-For: 1.1.1.1\r\nAuthorization: Basic guest\r\nX-Api-Key: guest-key\r\n");
    expect(r.status).toBe(200);
    expect(h.lookups).toEqual(["fwd.example.com"]);
    const s = seen[0]!;
    expect(s.url).toBe("/api/fwd/org/repo.git/info/refs?service=git-upload-pack");
    expect(s.headers.host).toBe("fwd.example.com");
    expect(s.headers["x-forwarded-host"]).toBe("git.example.com");
    expect(s.headers["x-runner-credential"]).toBe("lease-1");
    expect(s.headers["vercel-forwarded-for"]).toBeUndefined();
    expect(s.headers.authorization).toBeUndefined();
    expect(s.headers["x-api-key"]).toBeUndefined();
  });
  it("leaves a query string alone, even one that contains dot segments", async () => {
    const h = await start();
    expect((await get(h, "git.example.com", "/r.git/info/refs?next=/../x&a=%2e%2e")).status).toBe(200);
    expect(seen[0]!.url).toBe("/api/fwd/r.git/info/refs?next=/../x&a=%2e%2e");
  });
});

describe("reverse endpoint: request framing toward the upstream", () => {
  /** A raw TLS upstream that records the exact decrypted bytes of every connection and answers each request it can see. */
  async function rawUpstream(): Promise<{ bytes: () => string; close: () => Promise<void> }> {
    let received = "";
    const conns = new Set<net.Socket>();
    const server = tls.createServer({ key: cert.keyPem, cert: cert.certPem }, (socket) => {
      conns.add(socket);
      socket.on("data", (d) => {
        received += String(d);
        socket.write("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
      });
      socket.on("error", () => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    upstreamPort = (server.address() as net.AddressInfo).port;
    return {
      bytes: () => received,
      close: () => new Promise<void>((resolve) => { for (const c of conns) c.destroy(); server.close(() => resolve()); }),
    };
  }
  const SMUGGLED = "GET /smuggled HTTP/1.1\r\nHost: api.example.com\r\n\r\n";
  it.each(["GET", "OPTIONS", "DELETE"])("%s with a content-length body holding a second request delivers exactly one request", async (method) => {
    const up = await rawUpstream();
    try {
      const h = await start();
      const r = await raw(h, `${method} /ok HTTP/1.1\r\nHost: api.example.com\r\nContent-Length: ${SMUGGLED.length}\r\nConnection: close\r\n\r\n${SMUGGLED}`);
      expect(r.status).toBe(200);
      const [head = "", ...rest] = up.bytes().split("\r\n\r\n");
      expect(head.split("\r\n")[0]).toBe(`${method} /ok HTTP/1.1`);
      expect(head.toLowerCase()).toContain(`content-length: ${SMUGGLED.length}`);
      expect(rest.join("\r\n\r\n")).toBe(SMUGGLED);
    } finally {
      await up.close();
    }
    // And a real HTTP parser on the upstream sees one request whose body is the whole second request, not two requests.
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await startUpstream();
    const h2 = await start({}, ANSWERS, POLICY, "sb2");
    await raw(h2, `${method} /ok HTTP/1.1\r\nHost: api.example.com\r\nContent-Length: ${SMUGGLED.length}\r\nConnection: close\r\n\r\n${SMUGGLED}`);
    expect(seen.map((x) => [x.method, x.url, x.body])).toEqual([[method, "/ok", SMUGGLED]]);
  });
  it("a chunked GET body is re-framed as chunked, so its content is data and not a second request", async () => {
    const up = await rawUpstream();
    try {
      const h = await start();
      const chunk = SMUGGLED.length.toString(16);
      await raw(h, `GET /ok HTTP/1.1\r\nHost: api.example.com\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunk}\r\n${SMUGGLED}\r\n0\r\n\r\n`);
      const [head = "", ...rest] = up.bytes().split("\r\n\r\n");
      expect(head.toLowerCase()).toContain("transfer-encoding: chunked");
      expect(rest.join("\r\n\r\n")).toBe(`${chunk}\r\n${SMUGGLED}\r\n0\r\n\r\n`);
    } finally {
      await up.close();
    }
  });
  it("refuses any body on HEAD and sends nothing upstream", async () => {
    const up = await rawUpstream();
    try {
      const h = await start();
      const r = await raw(h, `HEAD /ok HTTP/1.1\r\nHost: api.example.com\r\nContent-Length: ${SMUGGLED.length}\r\nConnection: close\r\n\r\n${SMUGGLED}`);
      expect(r.status).toBe(400); // a HEAD answer has no body, so the reason is not readable
      expect(up.bytes()).toBe("");
    } finally {
      await up.close();
    }
  });
  it("a host-side injected header cannot add a length to a bodyless request", async () => {
    const up = await rawUpstream();
    try {
      const h = await start({ inject: () => ({ "content-length": "40" }) });
      await get(h, "api.example.com", "/ok");
      expect(up.bytes().toLowerCase()).not.toContain("content-length");
    } finally {
      await up.close();
    }
  });
  it("a bodyless GET carries no length header upstream", async () => {
    const up = await rawUpstream();
    try {
      const h = await start();
      await get(h, "api.example.com", "/ok");
      expect(up.bytes().toLowerCase()).not.toContain("content-length");
      expect(up.bytes().toLowerCase()).not.toContain("transfer-encoding");
    } finally {
      await up.close();
    }
  });
});

describe("reverse endpoint: bodies and streaming", () => {
  it("streams a content-length body and a chunked body to the upstream intact", async () => {
    const h = await start();
    const payload = "x".repeat(300_000);
    await raw(h, `POST /a HTTP/1.1\r\nHost: api.example.com\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n${payload}`);
    await raw(h, `POST /b HTTP/1.1\r\nHost: api.example.com\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n`);
    expect(seen.map((s) => [s.url, s.body.length])).toEqual([["/a", 300_000], ["/b", 11]]);
    expect(seen[1]!.body).toBe("hello world");
  });
  it("passes server-sent events through as they arrive, not at the end", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: one\ndata: 1\n\n");
      void gate.then(() => res.end("event: two\ndata: 2\n\n"));
    };
    const h = await start();
    const socket = net.connect(h.endpoint.socketPath);
    let data = "";
    const firstEvent = new Promise<void>((resolve) =>
      socket.on("data", (c) => {
        data += String(c);
        if (data.includes("event: one")) resolve();
      }),
    );
    socket.write("GET /stream HTTP/1.1\r\nHost: api.example.com\r\nConnection: close\r\n\r\n");
    await firstEvent;
    expect(data).not.toContain("event: two");
    release();
    await new Promise((resolve) => socket.once("close", resolve));
    expect(data).toContain("event: two");
  });
});

describe("reverse endpoint: a host listed with no rules (the policy a job builds, a plain list of hosts)", () => {
  const LIST = { allow: ["api.example.com", "pkg.example.com"] };
  it("serves a listed host as itself: the guest's path, the host's name for the certificate, no header added, and the guest's credentials still dropped", async () => {
    const h = await start({}, ANSWERS, LIST);
    const r = await get(h, "api.example.com", "/v1/messages?beta=true", "Authorization: Bearer guest\r\nx-api-key: guest-key\r\nanthropic-version: 2023-06-01\r\n");
    expect(r.status).toBe(200);
    const s = seen[0]!;
    expect(s.url).toBe("/v1/messages?beta=true");
    expect(s.headers.host).toBe("api.example.com");
    expect(s.headers["anthropic-version"]).toBe("2023-06-01");
    expect(s.headers["x-forwarded-host"]).toBeUndefined();
    for (const name of ["authorization", "x-api-key"]) expect(s.headers[name], name).toBeUndefined();
    expect(h.lookups).toEqual(["api.example.com"]);
    expect(h.decisions).toEqual([{ outcome: "allow", host: "api.example.com" }]);
  });
  it("still refuses a host that is not listed (exact match: a subdomain, a parent and a lookalike are other hosts) and resolves and sends nothing for it", async () => {
    const h = await start({}, ANSWERS, LIST);
    for (const host of ["evil.example.com", "sub.api.example.com", "example.com", "api.example.com.evil.test"]) {
      const r = await get(h, host);
      expect({ host, status: r.status, reason: refused(r) }).toEqual({ host, status: 403, reason: "not_allowed" });
    }
    expect(h.lookups).toEqual([]);
    expect(seen).toEqual([]);
  });
  it("refuses everything under deny-all and under an empty list", async () => {
    for (const policy of ["deny-all", { allow: [] }]) {
      const h = await start({}, ANSWERS, policy, `sb-${JSON.stringify(policy).length}`);
      expect(refused(await get(h, "api.example.com"))).toBe("not_allowed");
      expect(seen).toEqual([]);
    }
  });
  it("applies the same address checks as the tunnel: a listed host that resolves to a private address is refused", async () => {
    const h = await start({}, { "api.example.com": ["10.0.0.5"] }, LIST);
    const r = await get(h, "api.example.com");
    expect({ status: r.status, reason: refused(r) }).toEqual({ status: 403, reason: "blocked_address" });
    expect(seen).toEqual([]);
  });
  it("does not widen a host whose rules it cannot apply: match and two-rule hosts stay refused", async () => {
    const h = await start();
    expect(refused(await get(h, "match.example.com"))).toBe("unsupported_rules");
    expect(refused(await get(h, "two.example.com"))).toBe("unsupported_rules");
  });
});

describe("reverse endpoint: what is refused", () => {
  const cases: Array<[string, string, string, number]> = [
    ["a host not in the policy", "GET / HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n", "not_allowed", 403],
    ["a rule with match", "GET / HTTP/1.1\r\nHost: match.example.com\r\nConnection: close\r\n\r\n", "unsupported_rules", 403],
    ["two rules", "GET / HTTP/1.1\r\nHost: two.example.com\r\nConnection: close\r\n\r\n", "unsupported_rules", 403],
    ["an absolute-form URL for another host", "GET http://evil.example.com/ HTTP/1.1\r\nHost: api.example.com\r\nConnection: close\r\n\r\n", "host_mismatch", 400],
    ["an absolute-form https URL", "GET https://api.example.com/ HTTP/1.1\r\nHost: api.example.com\r\nConnection: close\r\n\r\n", "host_mismatch", 400],
    ["an absolute-form URL with credentials", "GET http://u:p@api.example.com/ HTTP/1.1\r\nHost: api.example.com\r\nConnection: close\r\n\r\n", "host_mismatch", 400],
    ["two Host headers", "GET / HTTP/1.1\r\nHost: api.example.com\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n", "bad_host", 400],
    ["a Host with another port", "GET / HTTP/1.1\r\nHost: api.example.com:8080\r\nConnection: close\r\n\r\n", "bad_host", 400],
    ["an address literal Host", "GET / HTTP/1.1\r\nHost: 169.254.169.254\r\nConnection: close\r\n\r\n", "bad_host", 400],
    ["a request with no Host", "GET / HTTP/1.0\r\n\r\n", "bad_host", 400],
    ["a transfer-encoding that is not chunked", "POST / HTTP/1.1\r\nHost: api.example.com\r\nTransfer-Encoding: gzip, chunked\r\nConnection: close\r\n\r\n0\r\n\r\n", "bad_framing", 400],
    ["an Upgrade header", "GET / HTTP/1.1\r\nHost: api.example.com\r\nUpgrade: h2c\r\nConnection: close\r\n\r\n", "bad_framing", 400],
    ["the TRACE method", "TRACE / HTTP/1.1\r\nHost: api.example.com\r\nConnection: close\r\n\r\n", "method_refused", 405],
    ["a path that climbs out of the forward prefix", "GET /a/../../x HTTP/1.1\r\nHost: git.example.com\r\nConnection: close\r\n\r\n", "bad_path", 400],
    ["an encoded dot-dot", "GET /a/%2e%2e/x HTTP/1.1\r\nHost: git.example.com\r\nConnection: close\r\n\r\n", "bad_path", 400],
    ["an encoded slash before a dot-dot", "GET /a%2f..%2fx HTTP/1.1\r\nHost: git.example.com\r\nConnection: close\r\n\r\n", "bad_path", 400],
    ["a fragment in the path", "GET /a#b HTTP/1.1\r\nHost: git.example.com\r\nConnection: close\r\n\r\n", "bad_path", 400],
    ["a backslash path","GET /a%5c..%5cx HTTP/1.1\r\nHost: git.example.com\r\nConnection: close\r\n\r\n", "bad_path", 400],
  ];
  it.each(cases)("refuses %s, with nothing resolved and nothing sent upstream", async (_name, text, reason, status) => {
    const h = await start();
    const r = await raw(h, text);
    expect({ status: r.status, reason: refused(r) }).toEqual({ status, reason });
    expect(h.lookups).toEqual([]);
    expect(seen).toEqual([]);
  });
  // Node's own parser already rejects these before our handler runs; the handler's check is the second layer, and the test pins the outcome either way.
  const SMUGGLED = [
    "POST / HTTP/1.1\r\nHost: api.example.com\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n",
    "POST / HTTP/1.1\r\nHost: api.example.com\r\nContent-Length: 4\r\nContent-Length: 5\r\nConnection: close\r\n\r\nabcde",
    "POST / HTTP/1.1\r\nHost: api.example.com\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n",
    "POST / HTTP/1.1\r\nHost: api.example.com\r\nTransfer-Encoding : chunked\r\nContent-Length: 4\r\nConnection: close\r\n\r\n0\r\n\r\n",
  ];
  it.each(SMUGGLED)("answers conflicting framing with 400 and sends nothing upstream (%#)", async (text) => {
    const h = await start();
    const r = await raw(h, text);
    expect(r.status).toBe(400);
    expect(seen).toEqual([]);
  });
  it("answers CONNECT and an upgrade handshake without serving them", async () => {
    const h = await start();
    expect((await raw(h, "CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n")).status).toBe(405);
    expect((await raw(h, "GET / HTTP/1.1\r\nHost: api.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")).status).toBe(400);
    expect(seen).toEqual([]);
  });
  const BAD: Array<[string, string[], string, number]> = [
    ["a private address", ["10.0.0.1"], "blocked_address", 403],
    ["metadata", ["169.254.169.254"], "blocked_address", 403],
    ["one blocked answer among public ones", [PUBLIC_A, "127.0.0.1"], "blocked_address", 403],
    ["this host's own address", ["198.51.100.9"], "blocked_address", 403],
    ["a mapped IPv4 address", ["::ffff:7f00:1"], "blocked_address", 403],
  ];
  it.each(BAD)("refuses a name that resolves to %s and never connects", async (_name, addresses, reason, status) => {
    const h = await start({}, { "api.example.com": addresses });
    const r = await get(h, "api.example.com");
    expect({ status: r.status, reason: refused(r) }).toEqual({ status, reason });
    expect(h.targets).toEqual([]);
    expect(seen).toEqual([]);
  });
  it("answers 502 when the name does not resolve", async () => {
    const h = await start({}, {});
    const r = await get(h, "api.example.com");
    expect({ status: r.status, reason: refused(r) }).toEqual({ status: 502, reason: "dns_failed" });
  });
  it("verifies the upstream certificate: an untrusted chain and a valid chain for the wrong name are both refused", async () => {
    const untrusted = await start({ [TEST_HOOKS]: { target: () => ({ address: "127.0.0.1", port: upstreamPort }) } });
    expect(refused(await get(untrusted, "api.example.com"))).toBe("upstream_failed");
    // A certificate the endpoint trusts, but issued for a different name than the one asked for.
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await startUpstream(otherCert);
    const wrongName = await start({ [TEST_HOOKS]: { target: () => ({ address: "127.0.0.1", port: upstreamPort }), ca: otherCert.certPem } }, ANSWERS, POLICY, "sb2");
    expect(refused(await get(wrongName, "api.example.com"))).toBe("upstream_failed");
    expect(seen).toEqual([]);
  });
});

describe("reverse endpoint: size and time limits", () => {
  it("refuses a declared body over the cap before opening the upstream, and aborts a chunked one that grows past it", async () => {
    const h = await start({ maxRequestBytes: 100 });
    const declared = await raw(h, "POST / HTTP/1.1\r\nHost: api.example.com\r\nContent-Length: 101\r\nConnection: close\r\n\r\n");
    expect({ status: declared.status, reason: refused(declared) }).toEqual({ status: 413, reason: "too_large" });
    expect(h.lookups).toEqual([]);
    const chunk = "x".repeat(60);
    const grown = await raw(h, `POST /g HTTP/1.1\r\nHost: api.example.com\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3c\r\n${chunk}\r\n3c\r\n${chunk}\r\n0\r\n\r\n`);
    expect(grown.status).toBe(413);
    expect(seen).toEqual([]);
  });
  it("answers 504 to a guest that declares a body and never sends it", async () => {
    const h = await start({ headersTimeoutMs: 150 });
    const r = await raw(h, "POST / HTTP/1.1\r\nHost: api.example.com\r\nContent-Length: 10\r\nConnection: close\r\n\r\n");
    expect({ status: r.status, reason: refused(r) }).toEqual({ status: 504, reason: "upstream_timeout" });
    expect(seen).toEqual([]);
  });
  it("stops relaying a response that passes the cap", async () => {
    handler = (_req, res) => void res.end("y".repeat(10_000));
    const h = await start({ maxResponseBytes: 1_000 });
    const r = await get(h, "api.example.com");
    expect(r.body.length).toBeLessThan(10_000);
  });
  it("answers 504 when the upstream sends no headers in time", async () => {
    handler = () => void 0;
    const h = await start({ headersTimeoutMs: 150 });
    const r = await get(h, "api.example.com");
    expect({ status: r.status, reason: refused(r) }).toEqual({ status: 504, reason: "upstream_timeout" });
  });
  it("closes a stream that goes quiet past the idle timeout, and one that outlives the total deadline", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: a\n\n");
    };
    const quiet = await start({ idleTimeoutMs: 150 });
    const started = Date.now();
    const r = await get(quiet, "api.example.com");
    expect(r.body).toContain("data: a");
    expect(Date.now() - started).toBeLessThan(3_000);
    handler = (_req, res) => {
      res.writeHead(200);
      const timer = setInterval(() => res.write("."), 40);
      res.once("close", () => clearInterval(timer));
    };
    const long = await start({ idleTimeoutMs: 5_000, totalTimeoutMs: 300 }, ANSWERS, POLICY, "sb2");
    const t0 = Date.now();
    await get(long, "api.example.com");
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});

describe("reverse endpoint: lifecycle and the tunnel's refusal", () => {
  it("refuses a vsock directory that is a symlink or open to others, and a policy it cannot read", async () => {
    const dir = path.join(root, "open");
    mkdirSync(dir, { mode: 0o777 });
    chmodSync(dir, 0o777);
    await expect(startReverseEndpoint({ uid: UID, vsockDir: dir, sandboxId: "open", policy: POLICY })).rejects.toThrow(/vsock directory/);
    await expect(start({}, ANSWERS, "allow-all", "sb9")).rejects.toThrow(/egress policy refused/);
  });
  it("the production constructor refuses the test-only target and ca keys", async () => {
    const dir = path.join(root, "prod");
    mkdirSync(dir, { mode: 0o1770 });
    chmodSync(dir, 0o1770);
    const base = { uid: UID, vsockDir: dir, sandboxId: "prod", policy: POLICY };
    await expect(startReverseEndpoint({ ...base, target: () => ({ address: "127.0.0.1", port: 1 }) } as unknown as ReverseOptions)).rejects.toThrow(/test-only/);
    await expect(startReverseEndpoint({ ...base, ca: "x" } as unknown as ReverseOptions)).rejects.toThrow(/test-only/);
  });
  it("follows the tunnel's socket rules: mode 0666 in a 01770 directory, only an exact-mode directory in the sandbox's group", async () => {
    const h = await start();
    expect(lstatSync(h.endpoint.socketPath).mode & 0o7777).toBe(0o666);
    expect(lstatSync(path.dirname(h.endpoint.socketPath)).mode & 0o7777).toBe(0o1770);
    for (const [name, mode] of [["m710", 0o710], ["m770", 0o770], ["m1771", 0o1771], ["m1777", 0o1777]] as const) {
      const bad = path.join(root, name);
      mkdirSync(bad);
      chmodSync(bad, mode);
      await expect(startReverseEndpoint({ uid: UID, vsockDir: bad, sandboxId: name, policy: POLICY }), name).rejects.toThrow(/mode 1770/);
    }
    const other = path.join(root, "gid");
    mkdirSync(other, { mode: 0o1770 });
    chmodSync(other, 0o1770);
    await expect(startReverseEndpoint({ uid: UID, vsockDir: other, sandboxId: "gid", policy: POLICY, sandboxGid: (process.getgid?.() ?? 0) + 12345 })).rejects.toThrow(/mode 1770/);
  });
  it("replaces a stale socket of this user, and leaves a non-socket alone and refuses to start", async () => {
    const dir = path.join(root, "sb3");
    mkdirSync(dir, { mode: 0o1770 });
    chmodSync(dir, 0o1770);
    const file = path.join(dir, "v.sock_5254");
    writeFileSync(file, "precious");
    await expect(startReverseEndpoint({ uid: UID, vsockDir: dir, sandboxId: "sb3", policy: "deny-all" })).rejects.toThrow(/other than a socket/);
    rmSync(file);
    const stale = net.createServer();
    await new Promise<void>((resolve) => stale.listen(file, resolve));
    const e = await startReverseEndpoint({ uid: UID, vsockDir: dir, sandboxId: "sb3", policy: "deny-all" });
    endpoints.push(e);
    stale.close();
    expect(e.socketPath).toBe(file);
  });
  // Skips only where the host cannot run a child as a subordinate uid and bind as it (SUBORDINATE_UID_SKIP_REASON); hosted CI can, so it runs there.
  it.skipIf(!canUseOtherUid)("leaves another user's socket alone and refuses to start", async () => {
    // Another uid's socket: the runner's uid is read as different after the directory check.
    const dir2 = path.join(root, "sb4");
    mkdirSync(dir2, { mode: 0o1770 });
    chmodSync(dir2, 0o1770);
    chmodSync(dir2, 0o1777);
    // A socket made by another uid: a child in a user namespace with a subordinate uid, in a directory opened for it only while it binds.
    const script = `const s=require("node:net").createServer();s.listen(process.argv[1],()=>{console.log("BOUND");setTimeout(()=>process.exit(0),200)});s.on("error",(e)=>{console.log(e.code);process.exit(0)});`;
    const made = spawnSync("unshare", ["--map-users=auto", "--map-groups=auto", "--setuid=1", "--setgid=1", process.execPath, "-e", script, path.join(dir2, "v.sock_5254")], { encoding: "utf8", timeout: 20_000 });
    chmodSync(dir2, 0o1770);
    expect(made.stdout.trim(), made.stderr).toBe("BOUND");
    const before = lstatSync(path.join(dir2, "v.sock_5254"));
    expect(before.uid).not.toBe(UID);
    await expect(startReverseEndpoint({ uid: UID, vsockDir: dir2, sandboxId: "sb4", policy: "deny-all" })).rejects.toThrow(/of this user/);
    expect(lstatSync(path.join(dir2, "v.sock_5254")).ino).toBe(before.ino);
  });
  it("stops listening on close", async () => {
    const h = await start();
    await h.endpoint.close();
    await expect(get(h, "api.example.com")).rejects.toThrow();
  });
  it("the CONNECT tunnel still refuses a rewritten host and says where it is served instead", async () => {
    const dir = path.join(root, "tunnel");
    mkdirSync(dir, { mode: 0o1770 });
    chmodSync(dir, 0o1770);
    const proxy = await startEgressProxy({ uid: UID, vsockDir: dir, sandboxId: "tunnel", policy: POLICY, lookup: async () => [{ address: PUBLIC_A, family: 4 }] });
    try {
      const head = await new Promise<string>((resolve, reject) => {
        const req = http.request({ socketPath: proxy.socketPath, method: "CONNECT", path: "api.example.com:443" });
        req.once("connect", (res, socket) => {
          socket.destroy();
          resolve(`${res.statusCode} ${res.statusMessage} ${String(res.headers["x-egress-hint"])}`);
        });
        req.once("error", reject);
        req.end();
      });
      expect(head).toBe("403 interception_required use the reverse endpoint, vsock port 5254");
    } finally {
      await proxy.close();
    }
  });
});
