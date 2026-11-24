import net from "node:net";
import { request as httpsRequest } from "node:https";
import { isBlockedAddress, resolveChecked, type HostLookup } from "@fx/net-guard";
import { fakeProviderAllowed } from "./fakeGate.js";
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
/** The longest `waitForAction` may be told to wait, and the shortest gap between its polls. */
export const WAIT_MAX_MS = 30 * 60_000;
const WAIT_MIN_STEP_MS = 500;
const USER_DATA_MAX_BYTES = 32 * 1024;
export const CLIENT_VERSION = "0.1.0";
export const CREATE_KEY_LABEL = "fx-create-key";

/** The closed set of codes the cloud shows copy for, plus `not_found`. Any other code Hetzner sends, and every network, TLS, timeout or shape failure, is `unavailable`. */
export type HetznerCode = "unauthorized" | "forbidden" | "resource_limit_exceeded" | "resource_unavailable" | "placement_error" | "rate_limit_exceeded" | "uniqueness_error" | "invalid_input" | "server_error" | "unavailable" | "not_found" | "locked";
const KNOWN = new Set<string>(["unauthorized", "forbidden", "resource_limit_exceeded", "resource_unavailable", "placement_error", "rate_limit_exceeded", "uniqueness_error", "invalid_input", "server_error", "unavailable", "not_found", "locked"]);

export class HetznerError extends Error {
  readonly name = "HetznerError";
  constructor(
    readonly code: HetznerCode,
    message: string,
    readonly extra: { status?: number; hetznerCode?: string; retryAfter?: number; resetAt?: number; ambiguous?: boolean; reason?: string; /** The message is Hetzner's own text (an error body), which the provider seam replaces. */ remote?: boolean } = {},
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
  /** D#845 MC-13a: an https URL whose path is the fake's root (`https://host/api/_fake/hetzner`; the client adds `/v1`). Refused unless FX_MACHINE_PROVIDER_FAKE=1 and FX_DEPLOY_KIND is staging. Real DNS, real TLS and the address guard still apply. */
  fakeBaseUrl?: string;
}

interface RawResponse { status: number; headers: Record<string, string>; json: unknown }
type Query = Record<string, string | number | readonly string[] | undefined>;

export interface CreateServerInput {
  name: string; serverType: string; location: string;
  /** A name (`ubuntu-24.04`) or, for a snapshot, its numeric id. */
  image: string | number;
  /** Ids go as numbers: Hetzner reads a string as a name. */
  sshKeys?: readonly (string | number)[]; firewalls?: readonly number[]; userData?: string; labels?: Record<string, string>; startAfterCreate?: boolean;
  publicNet?: { enableIpv4?: boolean; enableIpv6?: boolean };
  /** A double click, a retry or a crash between create and stamp makes one server: the same key finds the first one by its label. */
  idempotencyKey: string;
}
export interface CreateSnapshotInput {
  description: string; labels?: Record<string, string>;
  /** The same key finds the snapshot a first call made, by the label `keyLabel` (default `fx-create-key`; a park uses `fx-park-id`). */
  idempotencyKey: string; keyLabel?: string;
}
export interface FirewallRuleInput { direction: "in" | "out"; protocol: "tcp" | "udp" | "icmp" | "esp" | "gre"; port?: string; sourceIps?: readonly string[]; destinationIps?: readonly string[]; description?: string }

const LABEL_KEY = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?$/;
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
  let target = { host: HOST, port: 443, prefix: BASE };
  if (options.fakeBaseUrl !== undefined) {
    let u: URL | undefined;
    try { u = new URL(options.fakeBaseUrl); } catch { /* fx-swallow-ok: an unparsable address is refused just below with a fixed message */ u = undefined; }
    if (!fakeProviderAllowed(process.env) || !u || u.protocol !== "https:" || u.username || u.password) throw fail("unavailable", "The fake provider address is refused.");
    target = { host: u.hostname, port: Number(u.port || 443), prefix: u.pathname.replace(/\/+$/, "") + BASE };
  }

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
      address = test ? (await test.lookup(HOST, { all: true, verbatim: true }))[0]?.address : (await resolveChecked(target.host))[0];
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
          hostname: target.host, port: test ? test.port : target.port, path: target.prefix + path, method, timeout: timeoutMs,
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
    const code: HetznerCode = raw !== undefined && KNOWN.has(raw) ? (raw as HetznerCode) : r.status === 404 ? "not_found" : r.status === 423 ? "locked" : "unavailable";
    return fail(code, message, { status: r.status, remote: true, ...(raw === undefined ? {} : { hetznerCode: raw }), ambiguous: r.status >= 500 });
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
  const gone = async (call: () => Promise<unknown>): Promise<boolean> => {
    try { await call(); return true; } catch (e) {
      if (e instanceof HetznerError && e.code === "not_found") return false;
      throw e;
    }
  };
  const action = (v: unknown): P.Action => P.field(v, "action", P.parseAction);

  /** One write that may land without an answer: after an ambiguous ending, or a uniqueness refusal, `find` decides. Found is success; not found allows exactly one more send. */
  const writeOrFind = async <T, F>(post: () => Promise<T>, find: () => Promise<F | undefined>): Promise<{ made: T } | { found: F }> => {
    // Once any send has ended ambiguously, the first POST may still land: every later HetznerError (the re-send's refusal, a uniqueness refusal, a failed look-up) is rethrown as ambiguous, with its code, status, retryAfter and remote kept.
    let sentAmbiguous = false;
    const ambiguousToo = (x: unknown): unknown => (sentAmbiguous && x instanceof HetznerError && !x.ambiguous ? new HetznerError(x.code, x.message, { ...x.extra, ambiguous: true }) : x);
    for (let attempt = 0; ; attempt++) {
      try { return { made: await post() }; } catch (first) {
        const e = ambiguousToo(first);
        if (!(e instanceof HetznerError) || !(e.ambiguous || e.code === "uniqueness_error")) throw e;
        if (e.ambiguous) sentAmbiguous = true;
        let found: F | undefined;
        try { found = await find(); } catch (lookup) {
          // The write may have landed and the look-up for it failed too (a lock, a rate limit, a revoked token): whatever the look-up's own code says, nobody knows whether the write took effect.
          throw ambiguousToo(lookup);
        }
        if (found !== undefined) return { found };
        if (e.code === "uniqueness_error" || attempt >= Math.min(maxRetries, 1)) throw e;
        await sleep(250 * 2 ** attempt);
      }
    }
  };

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
    rebootServer: async (id: number): Promise<P.Action> => parsed(await send("POST", `/servers/${int(id)}/actions/reboot`, undefined, {}, false), action),
    powerOnServer: async (id: number): Promise<P.Action> => parsed(await send("POST", `/servers/${int(id)}/actions/poweron`, undefined, {}, false), action),
    powerOffServer: async (id: number): Promise<P.Action> => parsed(await send("POST", `/servers/${int(id)}/actions/poweroff`, undefined, {}, false), action),
    renameServer: async (id: number, name: string): Promise<P.Server> => parsed(await send("PUT", `/servers/${int(id)}`, undefined, { name }, false), (v) => P.field(v, "server", P.parseServer)),
    listFirewalls: (f: { labelSelector?: string; name?: string } = {}) => listAll("/firewalls", "firewalls", P.parseFirewall, { ...sel(f.labelSelector), ...(f.name ? { name: f.name } : {}) }),
    getFirewall: async (id: number) => get(`/firewalls/${int(id)}`, (v) => P.field(v, "firewall", P.parseFirewall)),
    createFirewall: async (i: { name: string; labels?: Record<string, string>; rules: readonly FirewallRuleInput[] }): Promise<P.Firewall> => {
      const body = { name: i.name, labels: i.labels ?? {}, rules: i.rules.map((r) => ({ direction: r.direction, protocol: r.protocol, ...(r.port === undefined ? {} : { port: r.port }), source_ips: r.sourceIps ?? [], destination_ips: r.destinationIps ?? [], ...(r.description === undefined ? {} : { description: r.description }) })) };
      return parsed(await send("POST", "/firewalls", undefined, body, false), (v) => P.field(v, "firewall", P.parseFirewall));
    },
    deleteFirewall: (id: number) => gone(() => send("DELETE", `/firewalls/${int(id)}`, undefined, undefined, true)),
    listSshKeys: (f: { labelSelector?: string; name?: string; fingerprint?: string } = {}) => listAll("/ssh_keys", "ssh_keys", P.parseSshKey, { ...sel(f.labelSelector), ...(f.name ? { name: f.name } : {}), ...(f.fingerprint ? { fingerprint: f.fingerprint } : {}) }),
    createSshKey: async (i: { name: string; publicKey: string; labels?: Record<string, string> }): Promise<P.SshKey> =>
      parsed(await send("POST", "/ssh_keys", undefined, { name: i.name, public_key: i.publicKey, labels: i.labels ?? {} }, false), (v) => P.field(v, "ssh_key", P.parseSshKey)),
    deleteSshKey: (id: number) => gone(() => send("DELETE", `/ssh_keys/${int(id)}`, undefined, undefined, true)),
    getAction: async (id: number) => get(`/actions/${int(id)}`, action),
    getActions: (ids: readonly number[]) => get("/actions", (v) => P.field(v, "actions", (x, at) => P.list(x, at, P.parseAction)), { id: ids.map((i) => String(int(i))) }),

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
      if (typeof i.image === "number") int(i.image);
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
        ...(i.sshKeys ? { ssh_keys: i.sshKeys.map((k) => (typeof k === "number" ? int(k) : k)) } : {}), ...(i.firewalls ? { firewalls: i.firewalls.map((firewall) => ({ firewall })) } : {}), ...(i.userData === undefined ? {} : { user_data: i.userData }),
        ...(i.publicNet ? { public_net: { enable_ipv4: i.publicNet.enableIpv4 ?? true, enable_ipv6: i.publicNet.enableIpv6 ?? true } } : {}),
      };
      const out = await writeOrFind(async () => parsed(await send("POST", "/servers", undefined, body, false), P.parseCreated), find);
      return "found" in out ? { server: out.found, action: null, reused: true } : { ...out.made, reused: false };
    },

    /** Starts a server from an image id: the same create path, the same create-key adoption, so a retry or a crash makes one server. */
    createServerFromImage: (i: Omit<CreateServerInput, "image"> & { imageId: number }) => api.createServer({ ...i, image: int(i.imageId) }),

    /**
     * Takes a snapshot of a server (the `create_image` action, type `snapshot`). Idempotent by key: the first call stamps `keyLabel=<key>`; a repeat, or a retry after
     * an ambiguous ending, finds that image by the label (and checks it is the one asked for) instead of sending again. Returns the image and the action to wait on.
     */
    async createSnapshot(serverId: number, i: CreateSnapshotInput): Promise<{ image: P.Image; action: P.Action | null; reused: boolean }> {
      const keyLabel = i.keyLabel ?? CREATE_KEY_LABEL;
      if (!LABEL_VALUE.test(i.idempotencyKey) || !LABEL_KEY.test(keyLabel)) throw fail("invalid_input", "The snapshot key must be 1 to 63 letters, digits, dashes, dots or underscores.");
      const wanted = { ...i.labels, [keyLabel]: i.idempotencyKey };
      const find = async (): Promise<P.Image | undefined> => {
        const found = await api.listImages({ labelSelector: `${keyLabel}=${i.idempotencyKey}` });
        if (found.length > 1) throw fail("uniqueness_error", "More than one snapshot carries this key.", { reason: "create_key_ambiguous" });
        const im = found[0];
        if (!im) return undefined;
        if (im.createdFromId !== serverId || im.description !== i.description || !Object.entries(wanted).every(([k, v]) => im.labels[k] === v)) throw fail("uniqueness_error", "A snapshot with this key differs from the one requested.", { reason: "create_key_mismatch" });
        return im;
      };
      const first = await find();
      if (first) return { image: first, action: null, reused: true };
      const body = { type: "snapshot", description: i.description, labels: wanted };
      const out = await writeOrFind(async () => parsed(await send("POST", `/servers/${int(serverId)}/actions/create_image`, undefined, body, false), P.parseImageCreated), find);
      return "found" in out ? { image: out.found, action: null, reused: true } : { ...out.made, reused: false };
    },

    /** Polls an action to `success`, within a bound, backing off from `intervalMs` (default 2 s) to 15 s. An `error` action or a timeout is `unavailable`; neither carries Hetzner's text. */
    async waitForAction(id: number, o: { timeoutMs?: number; intervalMs?: number } = {}): Promise<P.Action> {
      const timeout = o.timeoutMs ?? 600_000;
      const interval = o.intervalMs ?? 2_000;
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > WAIT_MAX_MS) throw fail("invalid_input", "The wait bound must be a finite time of at most 30 minutes.");
      if (!Number.isFinite(interval) || interval < 0) throw fail("invalid_input", "The poll interval must be a finite, non-negative time.");
      const end = now() + timeout;
      for (let step = Math.max(interval, WAIT_MIN_STEP_MS); ; step = Math.min(step * 1.5, 15_000)) {
        const a = await api.getAction(id);
        if (a.status === "success") return a;
        if (a.status === "error") throw fail("unavailable", "The action failed.", { reason: "action_failed" });
        if (now() >= end) throw fail("unavailable", "The action did not finish in time.", { reason: "action_timeout" });
        await sleep(step);
      }
    },
    /** Images of one type (default `snapshot`), optionally by label selector. */
    listImages: (f: { labelSelector?: string; type?: "snapshot" | "backup" | "system" | "app" } = {}) => listAll("/images", "images", P.parseImage, { type: f.type ?? "snapshot", ...sel(f.labelSelector) }),
    getImage: async (id: number) => get(`/images/${int(id)}`, (v) => P.field(v, "image", P.parseImage)),
    /**
     * Idempotent: true when an image was there to delete, false when it was already gone. A locked image (Hetzner answers 423) throws `locked`.
     * No ownership check: any image id in the project is deleted, so a caller must first check the id against its own records (MC-6a: `machine_snapshots`).
     */
    deleteImage: (id: number) => gone(() => send("DELETE", `/images/${int(id)}`, undefined, undefined, true)),

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
