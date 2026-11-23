import { HetznerError, type HetznerClient } from "@fx/hetzner";
import { MachineOpsError } from "@fx/model-connection";
import { withTenant } from "@fx/db/src/withTenant.js";
import { toApiError, withHetznerClient, type ServerCtx } from "./servers.js";

/**
 * D#845 MC-10b0: the live Hetzner catalog (locations, server types, per-location availability and price) for the "Add a server" picker.
 *
 * Nothing here is a hard-coded size. Small and Medium are the cheapest AVAILABLE x86 shared type that meets a floor, resolved from the live list in the location the
 * person chose; the picker's "Show all types" lists the rest. Prices are Hetzner's own `/pricing` answer (the one the quote and the create read), kept as decimal strings.
 *
 * The answer is cached for at most five minutes per account and per stored credential: a removed or replaced token is a different key, so a cached answer never
 * outlives the token that fetched it, and a removed or invalid token is refused before the cache is read. The cache holds the public catalog only, never the token.
 */
export const CATALOG_TTL_MS = 5 * 60_000;
const CACHE_MAX = 500;

export interface CatalogLocationPrice { location: string; available: boolean; hourly_gross: string; monthly_gross: string; ipv4_monthly_gross: string }
export interface CatalogType { name: string; description: string; cores: number; memory_gb: number; disk_gb: number; architecture: string; cpu_type: string; locations: CatalogLocationPrice[] }
export interface CatalogLocation { name: string; description: string; city: string; country: string }
export interface Catalog { currency: string; locations: CatalogLocation[]; server_types: CatalogType[]; fetched_at: string }
export interface CatalogView extends Catalog { location: string | null; presets: { small: string | null; medium: string | null } }

export const catalogDeps: { now: () => number } = { now: () => Date.now() };
const cache = new Map<string, { at: number; catalog: Catalog }>();
export const clearCatalogCache = (): void => cache.clear();

/** Decimal strings compared exactly, of any length, with no float: the fractions are padded to the longer one and compared as integers. A value that is not a plain decimal sorts last. */
const DECIMAL = /^([0-9]+)(?:\.([0-9]+))?$/;
function compareDecimal(a: string, b: string): number {
  const x = DECIMAL.exec(a);
  const y = DECIMAL.exec(b);
  if (!x || !y) return x ? -1 : y ? 1 : 0;
  const places = Math.max((x[2] ?? "").length, (y[2] ?? "").length);
  const nx = BigInt(x[1]! + (x[2] ?? "").padEnd(places, "0"));
  const ny = BigInt(y[1]! + (y[2] ?? "").padEnd(places, "0"));
  return nx < ny ? -1 : nx > ny ? 1 : 0;
}

const FLOORS = { small: { cores: 4, memory: 8 }, medium: { cores: 8, memory: 16 } } as const;

/** The cheapest available x86 shared type with at least the floor's cores and memory in `location`; ties go to the name. Null when none qualifies. */
export function resolvePreset(types: readonly CatalogType[], location: string, floor: { cores: number; memory: number }): string | null {
  let best: { name: string; price: string } | null = null;
  for (const t of types) {
    if (t.architecture !== "x86" || t.cpu_type !== "shared" || t.cores < floor.cores || t.memory_gb < floor.memory) continue;
    const here = t.locations.find((l) => l.location === location);
    if (!here || !here.available) continue;
    const cmp = best === null ? -1 : compareDecimal(here.monthly_gross, best.price);
    if (best === null || cmp < 0 || (cmp === 0 && t.name < best.name)) best = { name: t.name, price: here.monthly_gross };
  }
  return best?.name ?? null;
}

async function fetchCatalog(client: HetznerClient, now: number): Promise<Catalog> {
  const [locations, types, pricing] = await Promise.all([client.listLocations(), client.listServerTypes(), client.getPricing()]);
  const ipv4 = new Map(pricing.primaryIps.find((p) => p.type === "ipv4")?.prices.map((p) => [p.location, p.monthlyGross]) ?? []);
  return {
    currency: pricing.currency,
    locations: locations.map((l) => ({ name: l.name, description: l.description, city: l.city, country: l.country })),
    server_types: types.map((t) => {
      const prices = new Map(pricing.serverTypes.find((p) => p.name === t.name)?.prices.map((p) => [p.location, p]) ?? []);
      return {
        name: t.name, description: t.description, cores: t.cores, memory_gb: t.memory, disk_gb: t.disk, architecture: t.architecture, cpu_type: t.cpuType,
        // A location with no price or no IPv4 price is not offered: no price is ever guessed.
        locations: t.locations.flatMap((l) => {
          const p = prices.get(l.name);
          const ip = ipv4.get(l.name);
          return p && ip !== undefined ? [{ location: l.name, available: l.available, hourly_gross: p.hourlyGross, monthly_gross: p.monthlyGross, ipv4_monthly_gross: ip }] : [];
        }),
      };
    }),
    fetched_at: new Date(now).toISOString(),
  };
}

/** The account's active credential, read with an explicit account predicate on top of row security. */
async function activeCredential(ctx: ServerCtx): Promise<{ id: string; status: string } | undefined> {
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (c) =>
    (await c.query<{ id: string; status: string }>(`SELECT id, status FROM machine_provider_credentials WHERE account_id = $1 AND provider = 'hetzner_cloud' AND removed_at IS NULL`, [accountId])).rows[0],
  );
}

/** GET catalog. Owner or admin (the route gates it). Any Hetzner failure is the closed `hetzner_*` code with fixed copy; Hetzner's own words are never passed on. */
export async function getCatalog(ctx: ServerCtx, input: { location?: string }): Promise<CatalogView> {
  const cred = await activeCredential(ctx);
  if (!cred) throw new MachineOpsError("not_connected");
  if (cred.status !== "ok") throw new MachineOpsError("credential_invalid");
  const key = `${ctx.principal.accountId}:${cred.id}`;
  const now = catalogDeps.now();
  let hit = cache.get(key);
  if (!hit || now - hit.at >= CATALOG_TTL_MS || now < hit.at) {
    try {
      const catalog = await withHetznerClient(ctx, (client) => fetchCatalog(client, now));
      hit = { at: now, catalog };
    } catch (e) {
      if (e instanceof HetznerError) throw toApiError(e);
      throw e;
    }
    cache.delete(key);
    cache.set(key, hit);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  }
  const { catalog } = hit;
  const where = input.location ?? null;
  const known = where !== null && catalog.locations.some((l) => l.name === where);
  return {
    ...catalog,
    location: where,
    presets: known ? { small: resolvePreset(catalog.server_types, where, FLOORS.small), medium: resolvePreset(catalog.server_types, where, FLOORS.medium) } : { small: null, medium: null },
  };
}
