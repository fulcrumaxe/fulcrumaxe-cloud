import { HetznerError, type HetznerClient, type HetznerCode } from "./client.js";
import type { Server } from "./parse.js";

/**
 * The provider seam. A machine provider is anything that can price, create, look up, list and delete a server and manage the firewalls around it.
 * The types here carry no provider's field names, so another provider can sit behind the same interface. Ids are opaque strings. Hetzner Cloud is the only implementation.
 */
export interface MachineQuote { type: string; location: string; currency: string; hourlyNet: string; hourlyGross: string; monthlyNet: string; monthlyGross: string; available: boolean }
export interface MachineSpec {
  name: string; type: string; location: string; image: string;
  labels?: Record<string, string>; userData?: string; sshKeys?: readonly string[]; firewallIds?: readonly string[];
  /** The same key for the same intent: a repeat finds the machine the first call made instead of making another. */
  idempotencyKey: string;
}
export type MachineState = "starting" | "running" | "stopped" | "deleting" | "unknown";
export interface Machine { id: string; name: string; state: MachineState; type: string; location: string; ipv4: string | null; ipv6: string | null; labels: Record<string, string> }
export interface FirewallRuleSpec { direction: "in" | "out"; protocol: "tcp" | "udp" | "icmp"; port?: string; cidrs: readonly string[]; description?: string }
export interface MachineFirewall { id: string; name: string; labels: Record<string, string> }

/** The closed set of errors a provider shows the caller. A provider's own code goes in `extra.providerCode`; callers switch on `code` only. */
export type MachineErrorCode = "unavailable" | "not_found" | "conflict" | "rate_limited" | "invalid_input" | "unauthorized" | "in_use" | "mismatch";
export class MachineProviderError extends Error {
  readonly name = "MachineProviderError";
  constructor(
    readonly code: MachineErrorCode,
    message: string,
    readonly extra: { providerCode?: string; status?: number; retryAfter?: number; ambiguous?: boolean } = {},
  ) {
    super(message);
  }
}

/** Every method throws a `MachineProviderError` (or a programming error), never a provider's own error type. */
export interface MachineProvider {
  readonly kind: string;
  /** The price of one machine, or null when the type or location is unknown. `available: false` means it cannot be created there now. */
  quote(type: string, location: string): Promise<MachineQuote | null>;
  /** Idempotent by key. `reused` means the machine already existed; `settled` is false while the provider is still building it. */
  create(spec: MachineSpec): Promise<{ machine: Machine; reused: boolean; settled: boolean }>;
  get(id: string): Promise<Machine | null>;
  /** True when a machine was there to delete. */
  delete(id: string): Promise<boolean>;
  listByLabel(selector: string): Promise<Machine[]>;
  createFirewall(i: { name: string; labels?: Record<string, string>; rules: readonly FirewallRuleSpec[] }): Promise<MachineFirewall>;
  listFirewalls(selector?: string): Promise<MachineFirewall[]>;
  /** True when a firewall was there to delete. A firewall still applied to a machine is refused with `in_use`. */
  deleteFirewall(id: string): Promise<boolean>;
}

const STATE: Record<string, MachineState> = { initializing: "starting", starting: "starting", running: "running", off: "stopped", stopping: "stopped", deleting: "deleting" };
const machine = (s: Server): Machine => ({ id: String(s.id), name: s.name, state: STATE[s.status] ?? "unknown", type: s.serverType.name, location: s.location.name, ipv4: s.ipv4, ipv6: s.ipv6, labels: s.labels });
const num = (id: string): number => (/^[1-9][0-9]{0,15}$/.test(id) ? Number(id) : (() => { throw new HetznerError("invalid_input", "An id is not valid for this provider."); })());

const CODES: Record<HetznerCode, MachineErrorCode> = {
  unauthorized: "unauthorized", forbidden: "unauthorized", resource_limit_exceeded: "unavailable", resource_unavailable: "unavailable", placement_error: "unavailable",
  rate_limit_exceeded: "rate_limited", uniqueness_error: "conflict", invalid_input: "invalid_input", server_error: "unavailable", unavailable: "unavailable", not_found: "not_found",
};
/** Hetzner's code and reason to the neutral code. A create key that finds a different or a second server is `mismatch`; a firewall still applied is `in_use`. */
export function toMachineProviderError(e: unknown): unknown {
  if (!(e instanceof HetznerError)) return e;
  const { hetznerCode, status, retryAfter, reason } = e.extra;
  const code: MachineErrorCode = reason === "create_key_mismatch" || reason === "create_key_ambiguous" ? "mismatch" : hetznerCode === "resource_in_use" ? "in_use" : CODES[e.code];
  return new MachineProviderError(code, e.message, { providerCode: hetznerCode ?? e.code, ...(status === undefined ? {} : { status }), ...(retryAfter === undefined ? {} : { retryAfter }), ...(e.ambiguous ? { ambiguous: true } : {}) });
}
const guarded = async <T>(f: () => Promise<T>): Promise<T> => {
  try { return await f(); } catch (e) { throw toMachineProviderError(e); }
};
export function createHetznerProvider(client: HetznerClient): MachineProvider {
  const p = hetznerMachines(client);
  return {
    kind: p.kind,
    quote: (t, l) => guarded(() => p.quote(t, l)), create: (s) => guarded(() => p.create(s)), get: (id) => guarded(() => p.get(id)), delete: (id) => guarded(() => p.delete(id)),
    listByLabel: (s) => guarded(() => p.listByLabel(s)), createFirewall: (i) => guarded(() => p.createFirewall(i)), listFirewalls: (s) => guarded(() => p.listFirewalls(s)), deleteFirewall: (id) => guarded(() => p.deleteFirewall(id)),
  };
}
function hetznerMachines(client: HetznerClient): MachineProvider {
  return {
    kind: "hetzner",
    async quote(type, location) {
      const [types, pricing] = await Promise.all([client.listServerTypes(), client.getPricing()]);
      const t = types.find((x) => x.name === type);
      const price = t?.prices.find((p) => p.location === location);
      if (!t || !price) return null;
      return { type, location, currency: pricing.currency, hourlyNet: price.hourlyNet, hourlyGross: price.hourlyGross, monthlyNet: price.monthlyNet, monthlyGross: price.monthlyGross, available: t.locations.some((l) => l.name === location && l.available) };
    },
    async create(spec) {
      const { firewallIds, type, ...rest } = spec;
      const r = await client.createServer({ ...rest, serverType: type, ...(firewallIds ? { firewalls: firewallIds.map(num) } : {}) });
      return { machine: machine(r.server), reused: r.reused, settled: r.action !== null && r.action.status === "success" };
    },
    async get(id) {
      try { return machine(await client.getServer(num(id))); } catch (e) {
        if (e instanceof HetznerError && e.code === "not_found") return null;
        throw e;
      }
    },
    async delete(id) {
      const n = num(id);
      try { await client.getServer(n); } catch (e) {
        if (e instanceof HetznerError && e.code === "not_found") return false;
        throw e;
      }
      await client.deleteServer(n);
      return true;
    },
    async listByLabel(selector) { return (await client.listServers({ labelSelector: selector })).map(machine); },
    async createFirewall(i) {
      const f = await client.createFirewall({ name: i.name, ...(i.labels ? { labels: i.labels } : {}), rules: i.rules.map((r) => ({ direction: r.direction, protocol: r.protocol, ...(r.port === undefined ? {} : { port: r.port }), ...(r.direction === "in" ? { sourceIps: r.cidrs } : { destinationIps: r.cidrs }), ...(r.description === undefined ? {} : { description: r.description }) })) });
      return { id: String(f.id), name: f.name, labels: f.labels };
    },
    async listFirewalls(selector) { return (await client.listFirewalls(selector ? { labelSelector: selector } : {})).map((f) => ({ id: String(f.id), name: f.name, labels: f.labels })); },
    deleteFirewall: (id) => client.deleteFirewall(num(id)),
  };
}
