import { createPool } from "@fx/db/src/pool";
import { CachedHostResolver, PgHostResolver, type HostResolver } from "@fx/partners/host";

let cached: HostResolver | undefined;

/**
 * The process-wide host resolver: Postgres through the web tier's app_user login (`resolve_host` is a definer function that needs
 * no tenant context), behind the 60-second cache. Built on first use, so a deployment with the partner layer off never needs the
 * login for this and never opens a connection for it. The pool holds a few connections at most.
 */
export function defaultHostResolver(): HostResolver {
  if (!cached) {
    const url = process.env.DATABASE_URL_APP_USER;
    if (!url) throw new Error("DATABASE_URL_APP_USER must be set");
    const pool = createPool(url, { max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 3_000 });
    pool.on("error", () => {
      // fx-swallow-ok: a dropped idle connection is replaced by the next lookup
    });
    cached = new CachedHostResolver(new PgHostResolver(pool));
  }
  return cached;
}

/** A resolver that builds the real one only when asked, so the layer-off path never touches the environment or the database. */
export const lazyHostResolver: HostResolver = {
  resolve: (hostname) => defaultHostResolver().resolve(hostname),
};
