import dns from "node:dns";
import { isBlockedAddress } from "./blockedAddress.js";

/** One resolved address, in the shape `dns.promises.lookup(host, { all: true })`
 * returns it. */
export interface LookupAddress {
  address: string;
  family: number;
}

/** Injectable DNS lookup -- `defaultLookup` below is the real one
 * (`dns.promises.lookup`); tests inject a fake so no test ever makes a
 * real DNS query. */
export type HostLookup = (host: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>;

export const defaultLookup: HostLookup = (host, options) => dns.promises.lookup(host, options);

export type NetGuardErrorCode = "dns_failed" | "blocked_address";

/**
 * Thrown by `resolveChecked`. The message names the host and the CLASS
 * only -- D#31's "class only" rule -- never a resolved address, so the
 * error itself can't be used to probe this deployment's network.
 */
export class NetGuardError extends Error {
  readonly code: NetGuardErrorCode;
  constructor(code: NetGuardErrorCode, host: string) {
    super(`resolveChecked: refused to use "${host}" (${code})`);
    this.name = "NetGuardError";
    this.code = code;
  }
}

/**
 * Resolves `host` (through `lookup`, `defaultLookup` by default) and
 * refuses to return anything unless every returned address is public:
 * throws `NetGuardError` with `code: "dns_failed"` when the lookup throws
 * or returns zero addresses, and `code: "blocked_address"` when ANY
 * returned address is blocked (`isBlockedAddress`). Never caches --
 * every call re-resolves, so a DNS change is caught on the next call.
 */
export async function resolveChecked(host: string, lookup: HostLookup = defaultLookup): Promise<string[]> {
  let results: LookupAddress[];
  try {
    results = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new NetGuardError("dns_failed", host);
  }
  if (!Array.isArray(results) || results.length === 0) {
    throw new NetGuardError("dns_failed", host);
  }
  const addresses = results.map((r) => r.address);
  if (addresses.some((address) => isBlockedAddress(address))) {
    throw new NetGuardError("blocked_address", host);
  }
  return addresses;
}
