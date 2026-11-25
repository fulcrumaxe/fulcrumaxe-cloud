/**
 * D#587 B-7a: what the runner tells the cloud about its sandboxes, as the optional `sandboxes` block of a claim.
 *
 * The block is metadata only (name, state, times, bytes, counts). It is sent when its fingerprint differs from the last one the cloud accepted, and at least every
 * `SANDBOX_INVENTORY_MAX_QUIET_SECONDS` otherwise, so a poll that has nothing new stays light and the cloud's last-seen time never goes stale for long.
 * A send counts only once the cloud answered 200: a failed or rate-limited claim leaves the state as it was, so the same block goes out again.
 */
import { SANDBOX_INVENTORY_MAX_QUIET_SECONDS, SandboxInventory, type SandboxInventoryRow } from "@fulcrumaxe/runner-protocol";

/** Where the list comes from. The VM helper's implementation arrives with the helper; until then a runner has none. */
export interface InventorySource {
  list(): Promise<readonly SandboxInventoryRow[]>;
}

/** The default: a host with no VM sandboxes. */
export const emptyInventorySource: InventorySource = { list: async () => [] };

/**
 * What "the list changed" means: the list's exact text, in name order, so the order the source listed it in does not matter. It is at most 200 short rows, so the text itself is the
 * fingerprint: nothing can collide, and no built-in module is needed.
 */
export function inventoryFingerprint(rows: readonly SandboxInventoryRow[]): string {
  const sorted = [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.stringify(sorted);
}

export interface PendingInventory {
  rows: SandboxInventory;
  /** Call after the cloud answered 200 to the claim that carried `rows`. */
  commit(): void;
}

export interface InventoryReporter {
  /** The block to put on the next ordinary claim, or undefined when nothing is due. Never throws: a source that fails or lists something the schema refuses sends nothing. */
  next(): Promise<PendingInventory | undefined>;
}

export function createInventoryReporter(config: { source: InventorySource; now: () => Date; maxQuietSeconds?: number; /** D#845 ON-13c3: true while the runner holds an engine session lease. Every ordinary claim and every heartbeat that can carry the block then carries it (no quiet window), because the cloud renews a lease only from a block that lists the running session. */ every?: () => boolean }): InventoryReporter {
  const quietMs = (config.maxQuietSeconds ?? SANDBOX_INVENTORY_MAX_QUIET_SECONDS) * 1000;
  let sentHash: string | undefined;
  let sentAtMs = 0;
  return {
    async next() {
      let listed: readonly SandboxInventoryRow[];
      try {
        listed = await config.source.list();
      } catch {
        // fx-swallow-ok: a source that fails reports nothing this time; the claim itself goes on without the block
        return undefined;
      }
      const parsed = SandboxInventory.safeParse(listed);
      if (!parsed.success) return undefined;
      const hash = inventoryFingerprint(parsed.data);
      const nowMs = config.now().getTime();
      if (hash === sentHash && nowMs - sentAtMs < quietMs && config.every?.() !== true) return undefined;
      return {
        rows: parsed.data,
        commit() {
          sentHash = hash;
          sentAtMs = nowMs;
        },
      };
    },
  };
}
