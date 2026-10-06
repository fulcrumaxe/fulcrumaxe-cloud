import type { PendingStore } from "@fx/core/src/pendingWork";

/**
 * D#454 H3c: a fake of Vercel Runtime Cache that is no kinder than the real one (see apps/web/lib/pendingWorkStore.ts
 * for the documented behaviour it mirrors, and pendingWorkStore.test.ts, which runs the real @vercel/functions client
 * against a local server). It is REGIONAL (a store belongs to one region and never sees another's entries), values
 * go through JSON, entries end at their TTL or when evicted, and a failing call does NOT throw: the real client
 * swallows errors and answers "not found" for a read and nothing for a write. Use `throwing` to also exercise our own
 * defence against a store that does throw.
 */
export interface FakeRegion {
  now: { value: number };
  entries: Map<string, { json: string; expiresAt: number }>;
  /** While true every call fails the way the real client does: reads answer null, writes are lost. */
  failing: boolean;
  /** While true every call throws (not what the real client does; for our own defence). */
  throwing: boolean;
  /** Counts of calls, for asserting a tick made none that it should not. */
  calls: { get: number; set: number; delete: number };
}

export function makeRegion(now: { value: number }): FakeRegion {
  return { now, entries: new Map(), failing: false, throwing: false, calls: { get: 0, set: 0, delete: 0 } };
}

export function storeOf(region: FakeRegion): PendingStore {
  const guard = (): void => {
    if (region.throwing) throw new Error("cache down");
  };
  return {
    async get(key) {
      region.calls.get += 1;
      guard();
      if (region.failing) return null;
      const entry = region.entries.get(key);
      if (!entry || entry.expiresAt <= region.now.value) return null;
      return JSON.parse(entry.json) as unknown;
    },
    async set(key, value, ttlSeconds) {
      region.calls.set += 1;
      guard();
      if (region.failing) return;
      region.entries.set(key, { json: JSON.stringify(value), expiresAt: region.now.value + ttlSeconds * 1000 });
    },
    async delete(key) {
      region.calls.delete += 1;
      guard();
      if (region.failing) return;
      region.entries.delete(key);
    },
  };
}
