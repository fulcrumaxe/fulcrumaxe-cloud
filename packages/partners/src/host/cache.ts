import type { HostResolver, ResolvedHost } from "./resolver.js";

export const HOST_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 1_000;

export interface CachedHostResolverOptions {
  ttlMs?: number;
  /** Injected so a test can move the clock. */
  now?: () => number;
  /** Bound on distinct hostnames held; a flood of made-up Host values cannot grow the cache past it. */
  maxEntries?: number;
}

/**
 * An in-memory cache in front of any `HostResolver`, keyed by the normalised hostname (the caller normalises, so a port or a
 * trailing dot never makes a second entry and two hosts never share one). Every answer is held for the same short time, the
 * unknown ones included, so a branding approval, a revoke, a detach or a suspension shows up within `ttlMs` (60 s). An error from
 * the inner resolver is never stored.
 */
export class CachedHostResolver implements HostResolver {
  private readonly entries = new Map<string, { value: ResolvedHost; expires: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(private readonly inner: HostResolver, options: CachedHostResolverOptions = {}) {
    this.ttlMs = options.ttlMs ?? HOST_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async resolve(hostname: string): Promise<ResolvedHost> {
    const hit = this.entries.get(hostname);
    if (hit && hit.expires > this.now()) return hit.value;
    const value = await this.inner.resolve(hostname);
    this.entries.delete(hostname);
    if (this.entries.size >= this.maxEntries) {
      // Oldest first: a Map iterates in insertion order.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(hostname, { value, expires: this.now() + this.ttlMs });
    return value;
  }
}
