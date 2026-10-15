/**
 * The host resolver contract. `resolve` takes a hostname that `normalizeHostname` already produced and answers with exactly one
 * `ResolvedHost`, never an error for a host that is merely unknown: a lookup that misses must look the same as one that found
 * nothing. A thrown error means the lookup itself failed (the database is unreachable); callers do not cache it.
 */

export type HostState = "active" | "suspended" | "unknown";

export interface ResolvedHost {
  partnerId: string | null;
  productName: string | null;
  /** `partner_branding.logo_object_key` as stored. The branding route does not turn it into a URL (see context/envelope.ts). */
  logoUrl: string | null;
  colorPrimary: string | null;
  colorAccent: string | null;
  supportEmail: string | null;
  termsUrl: string | null;
  privacyUrl: string | null;
  state: HostState;
}

export const UNKNOWN_HOST: ResolvedHost = Object.freeze({
  partnerId: null,
  productName: null,
  logoUrl: null,
  colorPrimary: null,
  colorAccent: null,
  supportEmail: null,
  termsUrl: null,
  privacyUrl: null,
  state: "unknown",
});

export interface HostResolver {
  resolve(hostname: string): Promise<ResolvedHost>;
}

/** The slice of `pg.Pool` / `pg.PoolClient` the Postgres resolver and the signup hook use. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
