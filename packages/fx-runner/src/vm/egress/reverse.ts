import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import path from "node:path";
import { hostAddresses } from "./address.js";
import { parseEgressPolicy, type EgressPolicy, type ReverseRoute } from "./policy.js";
import { assertVsockDir, listenOnSocket, plainHost, resolvePublic, type Lookup } from "./proxy.js";

/**
 * D#587 B-4a-ii: the reverse endpoint for the hosts the CONNECT tunnel refuses (`interception_required`): a model host with a header
 * transform, a host with a `forwardURL`. There is no TLS interception and no CA in the guest. The guest's tool is configured to speak plain
 * HTTP to the policy host's own name (its in-guest shim relays port 80 to this vsock socket, `v.sock_5254`); this endpoint makes the upstream
 * TLS request itself, to the validated `forwardURL` (or to the host), with full certificate verification, and attaches the credentials. The
 * guest never holds a credential, and any credential-shaped header it sends is dropped.
 *
 * Per request, in order, each failure a fixed answer that names the class and never an address: method, framing (conflicting length headers,
 * a second Host, an upgrade), the Host header names a host that has a route in THIS sandbox's policy (a request line naming another host is
 * refused), the path cannot leave the forward prefix, the body is within its cap. Then one lookup per request, every address checked as for
 * the tunnel, and the connect goes to the validated address with the certificate checked against the NAME (resolved once, so DNS cannot
 * rebind between check and use). Request and response bodies stream (SSE included); an idle timer, a total deadline and a body cap bound them.
 */
export const EGRESS_REVERSE_VSOCK_PORT = 5254;
export const DEFAULTS = { maxRequestBytes: 32 * 1024 * 1024, maxResponseBytes: 512 * 1024 * 1024, headersTimeoutMs: 120_000, idleTimeoutMs: 120_000, totalTimeoutMs: 30 * 60_000 };

export type ReverseRefusal = "method_refused" | "bad_framing" | "bad_host" | "host_mismatch" | "not_allowed" | "unsupported_rules" | "bad_path" | "too_large" | "dns_failed" | "blocked_address" | "upstream_failed" | "upstream_timeout";
const STATUS: Record<ReverseRefusal, number> = { method_refused: 405, bad_framing: 400, bad_host: 400, host_mismatch: 400, not_allowed: 403, unsupported_rules: 403, bad_path: 400, too_large: 413, dns_failed: 502, blocked_address: 403, upstream_failed: 502, upstream_timeout: 504 };

export interface ReverseDecision {
  outcome: "allow" | ReverseRefusal;
  /** The Host the guest named when it is a plain DNS name; "-" otherwise. */
  host: string;
}
/** Key for the test-only hooks (where to connect, which CA to trust). Production code never passes it. */
export const TEST_HOOKS: unique symbol = Symbol("fx.egress.reverse.testHooks");
export interface ReverseOptions {
  vsockDir: string;
  sandboxId: string;
  /** The runner's own uid, given by the caller (nothing here reads the process): the vsock directory and any existing listener must belong to it. */
  uid: number;
  /** The sandbox's gid, when the caller knows it: the directory's group must be exactly it. */
  sandboxGid?: number;
  policy: unknown;
  /** Host-side headers added on top of the policy's transform for a host (the runner's own credentials). They are applied last and are never visible to the guest. */
  inject?: (host: string) => Record<string, string> | undefined;
  lookup?: Lookup;
  ownAddresses?: () => Set<string>;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Test-only hooks live behind `TEST_HOOKS`; the plain `target` and `ca` keys are refused. Production connects to the validated address on 443 and trusts the system store. */
  [TEST_HOOKS]?: { target?: (address: string) => { address: string; port: number }; ca?: string };
  onDecision?: (decision: ReverseDecision) => void;
}
export interface ReverseEndpoint {
  socketPath: string;
  close(): Promise<void>;
}

export function reverseSocketPath(vsockDir: string): string {
  return path.join(vsockDir, `v.sock_${EGRESS_REVERSE_VSOCK_PORT}`);
}

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
/** Never forwarded either way: hop-by-hop headers, and the names our own forwarding sets. */
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "expect", "forwarded", "via"]);
/** A guest never supplies a credential: anything credential-shaped it sends is dropped, not just the well-known names. */
const CREDENTIAL = /auth|token|api-?key|secret|credential|cookie|signature|^x-forwarded-|^vercel-/i;

const refusalBody = (reason: ReverseRefusal): string => `egress refused: ${reason}\n`;

function hostOf(req: http.IncomingMessage): { host: string } | { refusal: ReverseRefusal } {
  const hosts = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === "host");
  if (hosts.length !== 1) return { refusal: "bad_host" };
  const m = (req.headers.host ?? "").toLowerCase().match(/^([a-z0-9.-]{1,253})(?::80)?$/);
  if (!m || !plainHost(m[1]!)) return { refusal: "bad_host" };
  const target = req.url ?? "";
  if (!target.startsWith("/")) {
    // Absolute form is allowed only when it names the same host over http; anything else is a request for another host.
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      // fx-swallow-ok: a request line that is not a URL is answered with a fixed refusal
      return { refusal: "bad_path" };
    }
    if (url.protocol !== "http:" || url.hostname !== m[1] || url.username !== "" || url.password !== "") return { refusal: "host_mismatch" };
  }
  return { host: m[1]! };
}

/** The path and query to append to the forward prefix; undefined when the guest's path could leave it. */
function tailOf(req: http.IncomingMessage): string | undefined {
  const target = req.url ?? "";
  const rest = target.startsWith("/") ? target : target.replace(/^http:\/\/[^/?#]*/i, "") || "/";
  if (!rest.startsWith("/") || /[\u0000- \u007f#\\]/.test(rest)) return undefined;
  const [pathname = ""] = rest.split("?", 1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // fx-swallow-ok: an undecodable path is answered with a fixed refusal
    return undefined;
  }
  if (decoded.split("/").some((s) => s === "." || s === "..") || /[\u0000-\u001f\\]/.test(decoded)) return undefined;
  return rest;
}

function framingOk(req: http.IncomingMessage): boolean {
  const names = req.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
  const count = (n: string): number => names.filter((x) => x === n).length;
  if (count("content-length") > 1 || count("transfer-encoding") > 1 || count("upgrade") > 0) return false;
  const te = req.headers["transfer-encoding"];
  if (te !== undefined && (req.headers["content-length"] !== undefined || te.toLowerCase() !== "chunked")) return false;
  const cl = req.headers["content-length"];
  return cl === undefined || /^\d{1,15}$/.test(cl);
}

function upstreamHeaders(req: http.IncomingMessage, route: ReverseRoute, host: string, extra: Record<string, string> | undefined): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) if (value !== undefined && !HOP.has(name) && !CREDENTIAL.test(name)) out[name] = value;
  Object.assign(out, route.headers, extra);
  // The body is re-framed here, from the framing Node's own parser accepted (framingOk): the guest's headers are never copied.
  if (req.headers["transfer-encoding"] !== undefined) out["transfer-encoding"] = "chunked";
  else if (req.headers["content-length"] !== undefined) out["content-length"] = req.headers["content-length"];
  else delete out["content-length"];
  // A forward target tells which of the policy's hosts the request was for; it is set here, never taken from the guest.
  if (route.forwardURL) out["x-forwarded-host"] = host;
  return out;
}

export async function startReverseEndpoint(o: ReverseOptions): Promise<ReverseEndpoint> {
  if ("target" in o || "ca" in o) throw new TypeError("reverse endpoint: target and ca are test-only options");
  const hooks = o[TEST_HOOKS];
  const policy: EgressPolicy = parseEgressPolicy(o.policy);
  assertVsockDir(o.vsockDir, o.sandboxId, o.uid, o.sandboxGid);
  const lookup: Lookup = o.lookup ?? ((host, options) => dns.promises.lookup(host, options));
  const own = o.ownAddresses ?? hostAddresses;
  const limits = { ...DEFAULTS, ...Object.fromEntries(Object.entries({ maxRequestBytes: o.maxRequestBytes, maxResponseBytes: o.maxResponseBytes, headersTimeoutMs: o.headersTimeoutMs, idleTimeoutMs: o.idleTimeoutMs, totalTimeoutMs: o.totalTimeoutMs }).filter(([, v]) => v !== undefined)) } as typeof DEFAULTS;
  const sockets = new Set<net.Socket>();

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    let logged = "-";
    let done = false;
    const upstreams = new Set<http.ClientRequest>();
    const refuse = (reason: ReverseRefusal): void => {
      if (done) return;
      done = true;
      o.onDecision?.({ outcome: reason, host: logged });
      for (const u of upstreams) u.destroy();
      if (res.headersSent) return void res.destroy();
      res.writeHead(STATUS[reason], { "content-type": "text/plain", connection: "close" });
      res.end(refusalBody(reason));
    };
    if (!METHODS.has(req.method ?? "")) return refuse("method_refused");
    if (!framingOk(req)) return refuse("bad_framing");
    // A body on HEAD is refused. GET, OPTIONS and DELETE bodies are forwarded, re-framed (upstreamHeaders).
    if (req.method === "HEAD" && (req.headers["transfer-encoding"] !== undefined || (req.headers["content-length"] ?? "0") !== "0")) return refuse("bad_framing");
    const named = hostOf(req);
    if ("refusal" in named) return refuse(named.refusal);
    const host = (logged = named.host);
    const route = policy.routes.get(host);
    if (!route) return refuse(policy.hosts.has(host) ? "unsupported_rules" : "not_allowed");
    const tail = tailOf(req);
    if (tail === undefined) return refuse("bad_path");
    const length = req.headers["content-length"];
    if (length !== undefined && Number(length) > limits.maxRequestBytes) return refuse("too_large");

    const verdict = await resolvePublic(route.forwardURL?.hostname ?? host, lookup, own);
    if ("refusal" in verdict) return refuse(verdict.refusal === "dns_failed" ? "dns_failed" : "blocked_address");
    if (req.destroyed || done) return;
    const address = verdict.addresses[0]!;
    const connectTo = hooks?.target?.(address) ?? { address, port: 443 };
    const upstreamHost = route.forwardURL?.hostname ?? host;
    const prefix = route.forwardURL ? route.forwardURL.pathname.replace(/\/+$/, "") : "";
    const total = setTimeout(() => refuse("upstream_timeout"), limits.totalTimeoutMs);
    let idle: NodeJS.Timeout | undefined;
    const touch = (ms: number): void => {
      clearTimeout(idle);
      idle = setTimeout(() => refuse("upstream_timeout"), ms);
    };
    const finish = (): void => {
      clearTimeout(total);
      clearTimeout(idle);
    };
    res.once("close", () => {
      finish();
      for (const u of upstreams) u.destroy();
      done = true;
    });
    touch(limits.headersTimeoutMs);
    const upstream = https.request({
      host: connectTo.address,
      port: connectTo.port,
      servername: upstreamHost,
      method: req.method,
      path: `${prefix}${tail}`,
      headers: { ...upstreamHeaders(req, route, host, o.inject?.(host)), host: upstreamHost },
      ca: hooks?.ca,
      rejectUnauthorized: true,
      agent: false,
      // The connect cannot re-resolve: the name is only used for the certificate check.
      lookup: (_n, options, cb) => (options.all ? (cb as unknown as (e: null, a: unknown[]) => void)(null, [{ address: connectTo.address, family: connectTo.address.includes(":") ? 6 : 4 }]) : cb(null, connectTo.address, connectTo.address.includes(":") ? 6 : 4)),
    });
    upstreams.add(upstream);
    upstream.once("error", () => refuse("upstream_failed"));
    upstream.once("response", (ures) => {
      if (done) return void ures.destroy();
      touch(limits.idleTimeoutMs);
      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(ures.headers)) if (value !== undefined && !HOP.has(name) && name !== "set-cookie" && !CREDENTIAL.test(name)) headers[name] = value;
      res.writeHead(ures.statusCode ?? 502, ures.statusMessage, headers);
      res.flushHeaders();
      let sent = 0;
      ures.on("data", (chunk: Buffer) => {
        touch(limits.idleTimeoutMs);
        sent += chunk.length;
        if (sent > limits.maxResponseBytes) return refuse("too_large");
        if (!res.write(chunk)) {
          ures.pause();
          res.once("drain", () => ures.resume());
        }
      });
      ures.once("end", () => {
        done = true;
        finish();
        res.end();
      });
      ures.once("error", () => refuse("upstream_failed"));
    });
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      touch(limits.idleTimeoutMs);
      received += chunk.length;
      if (received > limits.maxRequestBytes) return refuse("too_large");
      if (!upstream.write(chunk)) {
        req.pause();
        upstream.once("drain", () => req.resume());
      }
    });
    req.once("end", () => {
      if (!done) {
        touch(limits.headersTimeoutMs);
        upstream.end();
      }
    });
    req.once("error", () => refuse("upstream_failed"));
    o.onDecision?.({ outcome: "allow", host });
  };

  const server = http.createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 15_000, requestTimeout: 0 }, (req, res) => {
    void handle(req, res).catch(() => res.destroy());
  });
  server.maxConnections = 128;
  server.on("connection", (s: net.Socket) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  // CONNECT and upgrades are never served here: the tunnel is the other port's job.
  server.on("connect", (_req, socket: net.Socket) => socket.end("HTTP/1.1 405 method_refused\r\nconnection: close\r\n\r\n"));
  server.on("upgrade", (_req, socket: net.Socket) => socket.end("HTTP/1.1 400 bad_framing\r\nconnection: close\r\n\r\n"));
  const socketPath = reverseSocketPath(o.vsockDir);
  await listenOnSocket(server, socketPath, o.uid);
  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
        server.closeAllConnections();
      }),
  };
}
