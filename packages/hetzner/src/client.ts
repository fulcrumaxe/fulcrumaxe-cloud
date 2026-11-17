import net from "node:net";
import { request as httpsRequest } from "node:https";
import { isBlockedAddress, resolveChecked, type HostLookup } from "@fx/net-guard";
import * as P from "./parse.js";

/**
 * Hetzner Cloud API client (H1 only: standard-tier Cloud servers; no dedicated servers, no Robot API). Contract, from Hetzner's own docs:
 *   https://docs.hetzner.cloud/reference/cloud   (the published OpenAPI spec: https://docs.hetzner.cloud/cloud.spec.json)
 * Auth is `Authorization: Bearer <token>`; errors are `{error:{code,message,details}}`; lists page with `page`/`per_page` (max 50) and `meta.pagination`;
 * `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (a UNIX time) come on responses, and 429 is `rate_limit_exceeded`.
 *
 * The token lives only in this closure. It is never logged, never put in a thrown error (every message is scrubbed of it), and the client logs nothing.
 */
const HOST = "api.hetzner.cloud";
const BASE = "/v1";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 20;
const USER_DATA_MAX_BYTES = 32 * 1024;
export const CLIENT_VERSION = "0.1.0";
export const CREATE_KEY_LABEL = "fx-create-key";

/** The closed set of codes the cloud shows copy for, plus `not_found`. Any other code Hetzner sends, and every network, TLS, timeout or shape failure, is `unavailable`. */
export type HetznerCode = "unauthorized" | "forbidden" | "resource_limit_exceeded" | "resource_unavailable" | "placement_error" | "rate_limit_exceeded" | "uniqueness_error" | "invalid_input" | "server_error" | "unavailable" | "not_found";
const KNOWN = new Set<string>(["unauthorized", "forbidden", "resource_limit_exceeded", "resource_unavailable", "placement_error", "rate_limit_exceeded", "uniqueness_error", "invalid_input", "server_error", "unavailable", "not_found"]);

export class HetznerError extends Error {
  readonly name = "HetznerError";
  constructor(
    readonly code: HetznerCode,
    message: string,
    readonly extra: { status?: number; hetznerCode?: string; retryAfter?: number; resetAt?: number; ambiguous?: boolean; reason?: string } = {},
  ) {
    super(message);
  }
  get status(): number | undefined { return this.extra.status; }
  /** Seconds to wait before the next request (set on `rate_limit_exceeded`). */
  get retryAfter(): number | undefined { return this.extra.retryAfter; }
  /** True when the request may or may not have taken effect (a timeout, a dropped connection, a 5xx). */
  get ambiguous(): boolean { return this.extra.ambiguous === true; }
}

export interface HetznerOptions {
  token: string;
  /** The version in `User-Agent: fulcrumaxe-cloud/<version>`. */
  version?: string;
  /** Per attempt. Default 15 s. */
  timeoutMs?: number;
  /** Retries after the first attempt, for network errors, 5xx and 429. Default 2. */
  maxRetries?: number;
  /** The longest the client will sleep for a rate limit; a longer wait is thrown as `rate_limit_exceeded` instead. Default 15 s. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Test only (refused unless NODE_ENV is exactly "test"): answers the DNS query so a local TLS fake can stand in; the certificate is still verified against `ca`. */
  testTarget?: { lookup: HostLookup; port: number; ca: string };
}

interface RawResponse { status: number; headers: Record<string, string>; json: unknown }
type Query = Record<string, string | number | readonly string[] | undefined>;

export interface CreateServerInput {
  name: string; serverType: string; location: string; image: string;
  sshKeys?: readonly string[]; firewalls?: readonly number[]; userData?: string; labels?: Record<string, string>; startAfterCreate?: boolean;
  publicNet?: { enableIpv4?: boolean; enableIpv6?: boolean };
  /** A double click, a retry or a crash between create and stamp makes one server: the same key finds the first one by its label. */
  idempotencyKey: string;
}
const LABEL_VALUE = /^[A-Za-z0-9]([-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?$/;
const sanitize = (s: string, token: string): string => {
  let out = s.replace(/[\u0000-\u001f\u007f]/g, " ");
  if (token) out = out.split(token).join("[redacted]");
  return out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 300);
};

export function createHetznerClient(options: HetznerOptions) {
  const token = options.token;
  if (typeof token !== "string" || !/^[\x21-\x7e]{8,512}$/.test(token)) throw new HetznerError("unauthorized", "The Hetzner token is missing or malformed.");
  const version = options.version ?? CLIENT_VERSION;
  if (!/^[0-9A-Za-z.+-]{1,40}$/.test(version)) throw new HetznerError("invalid_input", "The client version is malformed.");
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRetries = options.maxRetries ?? 2;
  const maxWaitMs = options.maxWaitMs ?? 15_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const test = options.testTarget;
  const rate: { limit: number | null; remaining: number | null; resetAt: number | null } = { limit: null, remaining: null, resetAt: null };

  const scrub = (s: string): string => sanitize(s, token);
  const fail = (code: HetznerCode, message: string, extra: HetznerError["extra"] = {}): HetznerError => new HetznerError(code, scrub(message), extra);
  if (test && process.env.NODE_ENV !== "test") throw fail("unavailable", "The test target is refused outside tests.");

  /** Seconds until one more request is allowed. The limit refills gradually (RateLimit-Reset is when it is full again), so one request's wait is the time to full over the requests missing. */
  const waitSeconds = (): number => {
    const toFull = rate.resetAt === null ? 1 : Math.max((rate.resetAt - now()) / 1000, 0);
    const missing = rate.limit !== null && rate.remaining !== null ? Math.max(rate.limit - rate.remaining, 1) : 1;
    return Math.min(Math.max(Math.ceil(toFull / missing), 1), Math.max(Math.ceil(toFull), 1));
  };
  const limited = (status?: number): HetznerError =>
    fail("rate_limit_exceeded", "Hetzner's request limit was reached.", { ...(status === undefined ? {} : { status }), retryAfter: waitSeconds(), ...(rate.resetAt === null ? {} : { resetAt: rate.resetAt }), hetznerCode: "rate_limit_exceeded" });

  async function once(method: string, path: string, body: string | undefined): Promise<RawResponse> {
    if (test && process.env.NODE_ENV !== "test") throw fail("unavailable", "The test target is refused outside tests.");
    let address: string | undefined;
    try {
      address = test ? (await test.lookup(HOST, { all: true, verbatim: true }))[0]?.address : (await resolveChecked(HOST))[0];
    } catch {
      // fx-swallow-ok: reduced to a fixed message; the resolver's text names the host only
      throw fail("unavailable", "Hetzner could not be resolved.", { ambiguous: false });
    }
    if (!address || (!test && isBlockedAddress(address))) throw fail("unavailable", "Hetzner resolved to a blocked address.");
    const pinned = address;
    return new Promise<RawResponse>((resolve, reject) => {
      let settled = false;
      const done = (f: () => void): void => { if (!settled) { settled = true; clearTimeout(deadline); f(); } };
      const deadline = setTimeout(() => { req.destroy(); done(() => reject(fail("unavailable", "Hetzner did not answer in time.", { ambiguous: true, reason: "timeout" }))); }, timeoutMs);
      const req = httpsRequest(
        {
          hostname: HOST, port: test ? test.port : 443, path: BASE + path, method, timeout: timeoutMs,
          headers: { Authorization: `Bearer ${token}`, "User-Agent": `fulcrumaxe-cloud/${version}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body).toString() }) },
          ...(test ? { ca: test.ca } : {}),
          lookup: ((_h: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
            const family = net.isIPv6(pinned) ? 6 : 4;
            if (opts?.all) cb(null, [{ address: pinned, family }]);
            else cb(null, pinned, family);
          }) as never,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE_BYTES) { res.destroy(); done(() => reject(fail("unavailable", "Hetzner's answer was too large.", { ambiguous: true }))); } else chunks.push(c);
          });
          res.on("error", () => done(() => reject(fail("unavailable", "The connection to Hetzner dropped.", { ambiguous: true }))));
          res.on("end", () =>
            done(() => {
              const headers: Record<string, string> = {};
              for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
              const text = Buffer.concat(chunks).toString("utf8");
              let json: unknown;
              if (text !== "") {
                try { json = JSON.parse(text); } catch {
                  // fx-swallow-ok: an unreadable body is `unavailable`; the raw body is never kept
                  json = undefined;
                }
              }
              resolve({ status: res.statusCode ?? 0, headers, json });
            }),
          );
        },
      );
      req.on("timeout", () => { req.destroy(); done(() => reject(fail("unavailable", "Hetzner did not answer in time.", { ambiguous: true, reason: "timeout" }))); });
      req.on("error", (e: NodeJS.ErrnoException) => done(() => reject(fail("unavailable", "Could not reach Hetzner securely.", { ambiguous: true, ...(typeof e.code === "string" && /^[A-Z0-9_]{1,60}$/.test(e.code) ? { reason: e.code } : {}) }))));
      req.end(body);
    });
  }

  function noteRate(h: Record<string, string>): void {
    const n = (k: string): number | null => (/^\d{1,12}$/.test(h[k] ?? "") ? Number(h[k]) : null);
    const limit = n("ratelimit-limit"), remaining = n("ratelimit-remaining"), reset = n("ratelimit-reset");
    if (limit !== null) rate.limit = limit;
    if (remaining !== null) rate.remaining = remaining;
    if (reset !== null) rate.resetAt = reset * 1000;
  }

  function asError(r: RawResponse): HetznerError {
    const e = (r.json as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    const raw = typeof e?.code === "string" && /^[a-z_]{1,40}$/.test(e.code) ? e.code : undefined;
    const message = typeof e?.message === "string" && e.message !== "" ? e.message : `Hetzner answered ${r.status}.`;
    if (r.status === 429) return limited(429);
    const code: HetznerCode = raw !== undefined && KNOWN.has(raw) ? (raw as HetznerCode) : r.status === 404 ? "not_found" : "unavailable";
    return fail(code, message, { status: r.status, ...(raw === undefined ? {} : { hetznerCode: raw }), ambiguous: r.status >= 500 });
  }

  /** One logical request. `safe` means it may be repeated after an ambiguous failure (a read or a delete); a 429 is always repeated, because a refused request did nothing. */
  async function send(method: string, path: string, query: Query | undefined, payload: unknown, safe: boolean): Promise<RawResponse> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) for (const x of v === undefined ? [] : Array.isArray(v) ? v : [String(v)]) qs.append(k, x);
    const full = qs.size ? `${path}?${qs}` : path;
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    for (let attempt = 0; ; attempt++) {
      if (rate.remaining === 0 && rate.resetAt !== null && rate.resetAt > now()) {
        const wait = waitSeconds();
        if (wait * 1000 > maxWaitMs) throw limited();
        await sleep(wait * 1000);
        rate.remaining = null;
      }
      let err: HetznerError;
      try {
        const r = await once(method, full, body);
        noteRate(r.headers);
        if (r.status >= 200 && r.status < 300) {
          if (r.status !== 204 && !(r.headers["content-type"] ?? "").startsWith("application/json")) throw fail("unavailable", "Hetzner answered in an unexpected format.", { status: r.status });
          return r;
        }
        err = asError(r);
      } catch (e) {
        if (!(e instanceof HetznerError)) throw e;
        err = e;
      }
      const wait = err.code === "rate_limit_exceeded" ? (err.retryAfter ?? 1) * 1000 : 250 * 2 ** attempt;
      const retry = attempt < maxRetries && (err.code === "rate_limit_exceeded" ? wait <= maxWaitMs : safe && err.ambiguous);
      if (!retry) throw err;
      await sleep(wait);
      if (err.code === "rate_limit_exceeded") rate.remaining = null;
    }
  }

  const parsed = <T>(r: RawResponse, f: (v: unknown) => T): T => {
    try { return f(r.json); } catch (e) {
      if (e instanceof P.ShapeError) throw fail("unavailable", `Hetzner answered in a shape we do not understand (${e.message}).`, { status: r.status });
      throw e;
    }
  };
  const get = async <T>(path: string, f: (v: unknown) => T, query?: Query): Promise<T> => parsed(await send("GET", path, query, undefined, true), f);
  const listAll = async <T>(path: string, key: string, f: (x: unknown, at: string) => T, query: Query = {}): Promise<T[]> => {
    const out: T[] = [];
    for (let page = 1, n = 0; n < MAX_PAGES; n++) {
      const r = parsed(await send("GET", path, { ...query, page, per_page: 50 }, undefined, true), (v) => P.parsePage(v, key, f));
      out.push(...r.items);
      if (r.nextPage === null) return out;
      if (r.nextPage <= page) throw fail("unavailable", "Hetzner's pagination did not advance.");
      page = r.nextPage;
    }
    throw fail("unavailable", "Hetzner's list was longer than we read.");
  };
  const sel = (labelSelector?: string): Query => (labelSelector ? { label_selector: labelSelector } : {});
  const action = (v: unknown): P.Action => P.field(v, "action", P.parseAction);

  const api = {
    /** The cheapest authenticated read (the first page of one server): `unauthorized` means the token was refused. */
    verifyToken: async (): Promise<void> => void (await send("GET", "/servers", { per_page: 1 }, undefined, true)),
    listLocations: () => listAll("/locations", "locations", P.parseLocation),
    listServerTypes: () => listAll("/server_types", "server_types", P.parseServerType),
    getPricing: () => get("/pricing", P.parsePricing),
    listServers: (f: { labelSelector?: string; name?: string } = {}) => listAll("/servers", "servers", P.parseServer, { ...sel(f.labelSelector), ...(f.name ? { name: f.name } : {}) }),
    getServer: async (id: number) => get(`/servers/${int(id)}`, (v) => P.field(v, "server", P.parseServer)),
    deleteServer: async (id: number): Promise<P.Action | null> => {
      // The published reply carries an optional `action`: a successful delete without one is still a success (null), not an unreadable answer.
      try { const r = await send("DELETE", `/servers/${int(id)}`, undefined, undefined, true); return r.json === undefined || (typeof r.json === "object" && r.json !== null && !("action" in r.json)) ? null : parsed(r, action); } catch (e) {
        if (e instanceof HetznerError && e.code === "not_found") return null;
        throw e;
      }
    },
    getAction: async (id: number) => get(`/actions/${int(id)}`, action),

    /**
     * Refuses before any create what the real API would refuse after one: an unknown server type or location, or a type not offered in that location.
     * Reads the live lists; nothing is created.
     */
    async checkPlacement(serverType: string, location: string): Promise<void> {
      const [types, locations] = await Promise.all([api.listServerTypes(), api.listLocations()]);
      const t = types.find((x) => x.name === serverType);
      if (!t) throw fail("invalid_input", `Unknown server type ${sanitize(serverType, token)}.`);
      if (!locations.some((l) => l.name === location)) throw fail("invalid_input", `Unknown location ${sanitize(location, token)}.`);
      if (!t.locations.some((l) => l.name === location && l.available)) throw fail("resource_unavailable", `${sanitize(serverType, token)} is not available in ${sanitize(location, token)}.`);
    },

    /** Idempotent: a repeat with the same key (or a retry after a timeout) finds the server the first call made, by its `fx-create-key` label, and returns it with `reused: true`. */
    async createServer(i: CreateServerInput): Promise<{ server: P.Server; action: P.Action | null; reused: boolean }> {
      if (!LABEL_VALUE.test(i.idempotencyKey)) throw fail("invalid_input", "The idempotency key must be 1 to 63 letters, digits, dashes, dots or underscores.");
      if (i.userData !== undefined && Buffer.byteLength(i.userData) > USER_DATA_MAX_BYTES) throw fail("invalid_input", "user_data is larger than 32 KiB.");
      // A label is not an identity: anything else in the Hetzner project can carry it. Adopt a server only when it is exactly the one this call would have made.
      const wanted = { ...i.labels, [CREATE_KEY_LABEL]: i.idempotencyKey };
      const find = async (): Promise<P.Server | undefined> => {
        const found = await api.listServers({ labelSelector: `${CREATE_KEY_LABEL}=${i.idempotencyKey}` });
        if (found.length > 1) throw fail("uniqueness_error", "More than one server carries this create key.", { reason: "create_key_ambiguous" });
        const s = found[0];
        if (!s) return undefined;
        const same = s.name === i.name && s.serverType.name === i.serverType && s.location.name === i.location && Object.entries(wanted).every(([k, v]) => s.labels[k] === v);
        if (!same) throw fail("uniqueness_error", "A server with this create key differs from the one requested.", { reason: "create_key_mismatch" });
        return s;
      };
      const first = await find();
      if (first) return { server: first, action: null, reused: true };
      const body = {
        name: i.name, server_type: i.serverType, location: i.location, image: i.image, start_after_create: i.startAfterCreate ?? true,
        labels: { ...i.labels, [CREATE_KEY_LABEL]: i.idempotencyKey },
        ...(i.sshKeys ? { ssh_keys: i.sshKeys } : {}), ...(i.firewalls ? { firewalls: i.firewalls.map((firewall) => ({ firewall })) } : {}), ...(i.userData === undefined ? {} : { user_data: i.userData }),
        ...(i.publicNet ? { public_net: { enable_ipv4: i.publicNet.enableIpv4 ?? true, enable_ipv6: i.publicNet.enableIpv6 ?? true } } : {}),
      };
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await send("POST", "/servers", undefined, body, false);
          return { ...parsed(r, P.parseCreated), reused: false };
        } catch (e) {
          if (!(e instanceof HetznerError) || !(e.ambiguous || e.code === "uniqueness_error")) throw e;
          const found = await find();
          if (found) return { server: found, action: null, reused: true };
          if (e.code === "uniqueness_error" || attempt >= maxRetries) throw e;
          await sleep(250 * 2 ** attempt);
        }
      }
    },

    /** Polls a server until `want` (a status, or `deleted`), within a bound, at most every `intervalMs`. Throws `unavailable` on timeout. */
    async waitForServer(id: number, want: "running" | "deleted", o: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
      const end = now() + (o.timeoutMs ?? 300_000);
      for (;;) {
        try {
          if ((await api.getServer(id)).status === want) return;
        } catch (e) {
          if (!(want === "deleted" && e instanceof HetznerError && e.code === "not_found")) throw e;
          return;
        }
        if (now() >= end) throw fail("unavailable", `The server did not reach ${want} in time.`);
        await sleep(o.intervalMs ?? 5_000);
      }
    },
  };
  const int = (n: number): number => (Number.isSafeInteger(n) && n > 0 ? n : (() => { throw fail("invalid_input", "An id must be a positive integer."); })());
  return Object.freeze({ ...api, toString: () => "[HetznerClient]", toJSON: () => ({}) });
}
export type HetznerClient = ReturnType<typeof createHetznerClient>;
