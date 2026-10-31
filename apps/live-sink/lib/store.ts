/**
 * The sink's expiring store. Routes talk to the `Store` interface; the one adapter speaks the Upstash Redis REST
 * protocol (the Vercel Marketplace Upstash integration) with plain `fetch`, so the project adds no dependency.
 * Every delivery list expires one hour after its first entry (EXPIRE ... NX), so there is no cleanup job.
 */
export const TTL_SECONDS = 3600;
export const MAX_BODY_BYTES = 64 * 1024;
/** Most deliveries kept per id; the oldest fall off. */
export const MAX_DELIVERIES = 100;
export const ID_PATTERN = /^[0-9a-f]{32}$/i;

export interface Delivery {
  body: string;
  headers: Record<string, string>;
  receivedAt: string;
}

export interface Store {
  /** Adds a delivery to the id's list; the list expires TTL_SECONDS after its first entry. */
  append(id: string, delivery: Delivery): Promise<void>;
  /** Returns every delivery for the id, oldest first, and deletes them: a read happens once. */
  drain(id: string): Promise<Delivery[]>;
}

export function createRedisStore(opts: { url: string; token: string; fetch?: typeof fetch }): Store {
  const key = (id: string): string => `sink:${id.toLowerCase()}`;
  // One MULTI/EXEC round trip. Errors name only the status, never the commands or values sent.
  async function transaction(commands: string[][]): Promise<unknown[]> {
    const res = await (opts.fetch ?? fetch)(`${opts.url.replace(/\/$/, "")}/multi-exec`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
      body: JSON.stringify(commands),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`store answered ${res.status}`);
    const results = (await res.json()) as { result?: unknown; error?: string }[];
    if (!Array.isArray(results) || results.some((r) => r.error !== undefined)) throw new Error("store command failed");
    return results.map((r) => r.result);
  }
  return {
    async append(id, delivery) {
      const k = key(id);
      await transaction([
        ["RPUSH", k, JSON.stringify(delivery)],
        ["EXPIRE", k, String(TTL_SECONDS), "NX"],
        ["LTRIM", k, String(-MAX_DELIVERIES), "-1"],
      ]);
    },
    async drain(id) {
      const [items] = await transaction([["LRANGE", key(id), "0", "-1"], ["DEL", key(id)]]);
      return (items as string[]).map((item) => JSON.parse(item) as Delivery);
    },
  };
}

let override: Store | undefined;
/** Test seam: routes use this store instead of the environment's. */
export function setStoreForTests(store: Store | undefined): void {
  override = store;
}

/** The store the environment configures (the Marketplace integration's `KV_REST_API_*`), or undefined when it is not set. */
export function getStore(env: Record<string, string | undefined> = process.env): Store | undefined {
  if (override) return override;
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? createRedisStore({ url, token }) : undefined;
}
