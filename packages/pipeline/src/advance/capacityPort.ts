import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { claimWithinHeadroom, crossesAlertDepth, enqueueForCapacity, readCapacityState, requeueRefused, type EnqueueInput } from "./capacityQueue.js";
import { readCapacityPlace } from "./capacityWait.js";

/**
 * D#483 S5-k3b-2c: the capacity gate's port, built on the queue helper. The worker defines the shape (`CapacityPort` in packages/worker capacityGate.ts) and cannot import this file; the
 * composition root hands it in. Everything here is structural, so the two stay equal by `tsc` at the injection site.
 */

export interface CapacityPortDeps {
  /** The runner login's pool (app_user + agent_run_writer). */
  pool: Pool;
  /** The plan-data reader. It throws when plan data carries no figure; the gate then counts nothing (no hosted start is held back by a missing figure, C23-8). */
  slotTotal: () => number;
  /** The ops alert path: one fixed notice at the depth crossing. A failure to send never changes the answer. */
  alert?: (text: string) => Promise<void>;
  onAlertError?: (err: unknown) => void;
}

/** The text of the single alert at the crossing (fixed words and one count). */
export const capacityAlertText = (depth: number, alertDepth: number): string =>
  `Capacity queue: ${depth} work items are waiting for room on the hosted sandboxes, over the alert depth of ${alertDepth}. Nothing is refused or dropped; they start as room frees.`;

export function createCapacityPort(deps: CapacityPortDeps) {
  const { pool } = deps;

  /** The figure, or null when plan data has none (the reader's own failure is the answer; nothing else about the gate changes). */
  function total(): number | null {
    try {
      return deps.slotTotal();
    } catch {
      // fx-swallow-ok: a missing plan-data figure is the documented case (C23 item 3); health names the key, the start goes ahead
      return null;
    }
  }

  /** Queues the item (a second call keeps its place) and raises the one alert at the crossing. The new entry is not yet asking, so it is not in the depth the state reads. */
  async function enqueue(who: EnqueueInput & { accountId: string }) {
    const out = await enqueueForCapacity(pool, who.accountId, who);
    if (out.entry.created && deps.alert) {
      // Counted as the claim counts: over entries that are asking. The new entry joins once its item writes the waiting fact, so it is added here when it is not yet in the read.
      const place = await readCapacityPlace(pool, who.accountId, who.workItemId);
      const depth = place?.o_skip === "not_waiting" ? out.depth + 1 : out.depth;
      if (crossesAlertDepth(true, depth, out.alertDepth)) await deps.alert(capacityAlertText(depth, out.alertDepth)).catch((err: unknown) => deps.onAlertError?.(err));
    }
    return out;
  }

  return {
    async holds(accountId: string, workItemId: string): Promise<boolean> {
      return withTenant(pool, accountId, async (c) => (await c.query("SELECT 1 FROM capacity_queue WHERE account_id = $1 AND work_item_id = $2 AND ended_at IS NULL AND started_run_id IS NULL", [accountId, workItemId])).rowCount === 1);
    },

    async admit(input: { accountId: string; repoId: string; workItemId: string; runKind: string }) {
      // Case 4: the item's own open entry holds an unexpired claim.
      const own = await withTenant(pool, input.accountId, async (c) =>
        (
          await c.query<{ id: string; attempt: number }>(
            "SELECT id, attempt FROM capacity_queue WHERE account_id = $1 AND work_item_id = $2 AND ended_at IS NULL AND started_run_id IS NULL AND claimed_at IS NOT NULL AND claim_expires_at > clock_timestamp()",
            [input.accountId, input.workItemId],
          )
        ).rows[0],
      );
      if (own) return { kind: "claimed" as const, entryId: own.id, attempt: own.attempt };
      // Case 5: headroom first. With no figure the gate counts nothing and the start goes ahead.
      const slots = total();
      if (slots === null) return { kind: "start" as const };
      const state = await readCapacityState(pool, () => slots);
      if (state.headroom > 0 && state.waiting === 0) return { kind: "start" as const };
      // Case 6: queued (a second call keeps the place); one claim pass; the item's own entry, if that pass took it, is consumed now.
      const { entry } = await enqueue({ repoId: input.repoId, workItemId: input.workItemId, runKind: input.runKind, accountId: input.accountId });
      if (state.headroom > 0) {
        const { claimed } = await claimWithinHeadroom(pool, () => slots, { limit: state.headroom });
        const mine = claimed.find((c) => c.id === entry.id);
        if (mine) return { kind: "claimed" as const, entryId: mine.id, attempt: mine.attempt };
      }
      return { kind: "wait" as const };
    },

    /** Only the 429 path calls this (the re-queue is for a refused claimed start; a direct start is queued with the refusal). */
    async refused(input: { accountId: string; repoId: string; workItemId: string; runKind: string; runId: string; entryId: string | null; status: number; code: string | null }): Promise<void> {
      if (input.entryId !== null && (await requeueRefused(pool, input.entryId, input.runId, { status: input.status, code: input.code }))) return;
      await enqueue({ accountId: input.accountId, repoId: input.repoId, workItemId: input.workItemId, runKind: input.runKind, refusal: { status: input.status, code: input.code } });
    },

    /** One claim pass in fair order, at most as many as there is headroom for (slot release and the reconcile backstop). Nothing when plan data has no figure. */
    async claimPass(): Promise<number> {
      const slots = total();
      if (slots === null) return 0;
      return (await claimWithinHeadroom(pool, () => slots)).claimed.length;
    },
  };
}
