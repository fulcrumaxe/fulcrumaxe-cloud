/**
 * Strict parsers for the Hetzner Cloud API responses (https://docs.hetzner.cloud/ , the published OpenAPI spec at https://docs.hetzner.cloud/cloud.spec.json).
 * Each parser reads only the fields the cloud uses, refuses a missing or wrongly typed one, and ignores the rest. A create response's `root_password` is never
 * read: the parsed type has no such field, so it cannot leak through a log, a stamp or an audit row.
 */
export class ShapeError extends Error {}

type Rec = Record<string, unknown>;
const fail = (at: string, want: string): never => {
  throw new ShapeError(`${at}: expected ${want}`);
};
const rec = (v: unknown, at: string): Rec => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : fail(at, "an object"));
const str = (v: unknown, at: string): string => (typeof v === "string" ? v : fail(at, "a string"));
const num = (v: unknown, at: string): number => (typeof v === "number" && Number.isFinite(v) ? v : fail(at, "a number"));
const int = (v: unknown, at: string): number => (Number.isSafeInteger(v) ? (v as number) : fail(at, "an integer"));
const bool = (v: unknown, at: string): boolean => (typeof v === "boolean" ? v : fail(at, "a boolean"));
const arr = (v: unknown, at: string): unknown[] => (Array.isArray(v) ? v : fail(at, "an array"));
const dec = (v: unknown, at: string): string => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? v : fail(at, "a decimal string"));
const orNull = <T>(v: unknown, f: (x: unknown, at: string) => T, at: string): T | null => (v === null || v === undefined ? null : f(v, at));
export const list = <T>(v: unknown, at: string, f: (x: unknown, at: string) => T): T[] => arr(v, at).map((x, i) => f(x, `${at}[${i}]`));
const labels = (v: unknown, at: string): Record<string, string> => Object.fromEntries(Object.entries(rec(v, at)).map(([k, x]) => [k, str(x, `${at}.${k}`)]));

/** Prices stay decimal strings: money is never turned into a float here. */
export interface Price { location: string; hourlyNet: string; hourlyGross: string; monthlyNet: string; monthlyGross: string }
export interface Location { id: number; name: string; description: string; country: string; city: string; networkZone: string }
export interface ServerType { id: number; name: string; description: string; cores: number; memory: number; disk: number; architecture: string; cpuType: string; prices: Price[]; locations: Array<{ id: number; name: string; available: boolean }> }
export interface Pricing { currency: string; vatRate: string; serverTypes: Array<{ id: number; name: string; prices: Price[] }>; primaryIps: Array<{ type: string; prices: Array<{ location: string; hourlyNet: string; hourlyGross: string; monthlyNet: string; monthlyGross: string }> }> }
export type ServerStatus = "running" | "initializing" | "starting" | "stopping" | "off" | "deleting" | "migrating" | "rebuilding" | "unknown";
export interface Server { id: number; name: string; status: ServerStatus; created: string; ipv4: string | null; ipv6: string | null; labels: Record<string, string>; serverType: { id: number; name: string }; location: { id: number; name: string }; firewalls: Array<{ id: number; status: string }> }
export interface Action { id: number; command: string; status: "running" | "success" | "error"; progress: number; started: string; finished: string | null; error: { code: string; message: string } | null }
export interface Page<T> { items: T[]; nextPage: number | null }

const STATUSES = new Set(["running", "initializing", "starting", "stopping", "off", "deleting", "migrating", "rebuilding", "unknown"]);

const price = (v: unknown, at: string): Price => {
  const o = rec(v, at);
  const h = rec(o.price_hourly, `${at}.price_hourly`);
  const m = rec(o.price_monthly, `${at}.price_monthly`);
  return { location: str(o.location, `${at}.location`), hourlyNet: dec(h.net, `${at}.price_hourly.net`), hourlyGross: dec(h.gross, `${at}.price_hourly.gross`), monthlyNet: dec(m.net, `${at}.price_monthly.net`), monthlyGross: dec(m.gross, `${at}.price_monthly.gross`) };
};

export const parseLocation = (v: unknown, at = "location"): Location => {
  const o = rec(v, at);
  return { id: int(o.id, `${at}.id`), name: str(o.name, `${at}.name`), description: str(o.description, `${at}.description`), country: str(o.country, `${at}.country`), city: str(o.city, `${at}.city`), networkZone: str(o.network_zone, `${at}.network_zone`) };
};

export const parseServerType = (v: unknown, at = "server_type"): ServerType => {
  const o = rec(v, at);
  return {
    id: int(o.id, `${at}.id`), name: str(o.name, `${at}.name`), description: str(o.description, `${at}.description`),
    cores: num(o.cores, `${at}.cores`), memory: num(o.memory, `${at}.memory`), disk: num(o.disk, `${at}.disk`),
    architecture: str(o.architecture, `${at}.architecture`), cpuType: str(o.cpu_type, `${at}.cpu_type`),
    prices: list(o.prices, `${at}.prices`, price),
    locations: list(o.locations, `${at}.locations`, (x, p) => { const l = rec(x, p); return { id: int(l.id, `${p}.id`), name: str(l.name, `${p}.name`), available: bool(l.available, `${p}.available`) }; }),
  };
};

export const parsePricing = (v: unknown): Pricing => {
  const o = rec(rec(v, "body").pricing, "pricing");
  return {
    currency: str(o.currency, "pricing.currency"), vatRate: dec(o.vat_rate, "pricing.vat_rate"),
    serverTypes: list(o.server_types, "pricing.server_types", (x, p) => { const s = rec(x, p); return { id: int(s.id, `${p}.id`), name: str(s.name, `${p}.name`), prices: list(s.prices, `${p}.prices`, price) }; }),
    primaryIps: list(o.primary_ips, "pricing.primary_ips", (x, p) => { const s = rec(x, p); return { type: str(s.type, `${p}.type`), prices: list(s.prices, `${p}.prices`, price) }; }),
  };
};

export const parseAction = (v: unknown, at = "action"): Action => {
  const o = rec(v, at);
  const status = str(o.status, `${at}.status`);
  if (status !== "running" && status !== "success" && status !== "error") fail(`${at}.status`, "running, success or error");
  const e = orNull(o.error, rec, `${at}.error`);
  return {
    id: int(o.id, `${at}.id`), command: str(o.command, `${at}.command`), status: status as Action["status"], progress: int(o.progress, `${at}.progress`),
    started: str(o.started, `${at}.started`), finished: orNull(o.finished, str, `${at}.finished`),
    error: e ? { code: str(e.code, `${at}.error.code`), message: str(e.message, `${at}.error.message`) } : null,
  };
};

export const parseServer = (v: unknown, at = "server"): Server => {
  const o = rec(v, at);
  const net = rec(o.public_net, `${at}.public_net`);
  const type = rec(o.server_type, `${at}.server_type`);
  const loc = rec(o.location, `${at}.location`);
  const status = str(o.status, `${at}.status`);
  return {
    id: int(o.id, `${at}.id`), name: str(o.name, `${at}.name`), status: (STATUSES.has(status) ? status : "unknown") as ServerStatus, created: str(o.created, `${at}.created`),
    ipv4: orNull(net.ipv4, (x, p) => str(rec(x, p).ip, `${p}.ip`), `${at}.public_net.ipv4`),
    ipv6: orNull(net.ipv6, (x, p) => str(rec(x, p).ip, `${p}.ip`), `${at}.public_net.ipv6`),
    labels: labels(o.labels, `${at}.labels`),
    serverType: { id: int(type.id, `${at}.server_type.id`), name: str(type.name, `${at}.server_type.name`) },
    location: { id: int(loc.id, `${at}.location.id`), name: str(loc.name, `${at}.location.name`) },
    firewalls: list(net.firewalls ?? [], `${at}.public_net.firewalls`, (x, p) => { const f = rec(x, p); return { id: int(f.id, `${p}.id`), status: str(f.status, `${p}.status`) }; }),
  };
};

/** The create response: the server and its action. `root_password` and `next_actions` are deliberately not read. */
export const parseCreated = (v: unknown): { server: Server; action: Action } => {
  const o = rec(v, "body");
  return { server: parseServer(o.server), action: parseAction(o.action) };
};

/** One page of a list: `key` names the array, and `meta.pagination.next_page` says whether another follows. */
export const parsePage = <T>(v: unknown, key: string, f: (x: unknown, at: string) => T): Page<T> => {
  const o = rec(v, "body");
  const p = o.meta === undefined ? null : rec(rec(o.meta, "meta").pagination, "meta.pagination");
  return { items: list(o[key], key, f), nextPage: p && p.next_page !== null && p.next_page !== undefined ? int(p.next_page, "meta.pagination.next_page") : null };
};

export const field = <T>(v: unknown, key: string, f: (x: unknown, at: string) => T): T => f(rec(v, "body")[key], key);
