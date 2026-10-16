import type { Pool } from "pg";
import { sweepAap, type AapSweepResult } from "@fx/db/src/aap.js";

/**
 * D#7 AAP-d1: the Agent Approval Protocol housekeeping that rides the invariant sweep's tick. One database function (migration 0838,
 * `aap_sweep`) on the RECEIPT pool, whose login must be a member of aap_sweeper: it expires requests past their deadline, nulls sealed arguments 30
 * days after a request left pending, drops replay records past their purge time and removes a deleted instance's record 7 days after deletion.
 * Cross-tenant, nothing in the call names a tenant or a time (the database's clock decides what is due), and nothing in the result is user text.
 *
 * It never throws, and it never fails quietly. If startup found the receipt login is not a member of aap_sweeper (`ready: false`), every tick logs
 * `aap.purge_blocked_no_membership` and does not call the database; a call refused for privileges logs `aap.purge_not_permitted`; any other failure logs
 * `aap.purge_failed`. All are fixed lines (never the error's text, which can carry a host or a user), and the next tick looks again.
 */
export interface AapPurgeDeps {
  pool: Pick<Pool, "query">;
  warn: (line: string) => void;
  /** AAP-1 from startup; undefined means unknown and the call is tried. */
  ready?: boolean;
  limit?: number;
}

const PURGE_FAILED = { expired: 0, argumentsPurged: 0, idempotencyPurged: 0, instancesPurged: 0, failed: true } as const;

export async function purgeAap(deps: AapPurgeDeps): Promise<AapSweepResult & { failed: boolean }> {
  if (deps.ready === false) {
    deps.warn(JSON.stringify({ event: "aap.purge_blocked_no_membership" }));
    return { ...PURGE_FAILED };
  }
  try {
    const r = await sweepAap(deps.pool, deps.limit);
    if (r.expired + r.argumentsPurged + r.idempotencyPurged + r.instancesPurged > 0) deps.warn(JSON.stringify({ event: "aap.purged", ...r }));
    return { ...r, failed: false };
  } catch (err) {
    // fx-swallow-ok: logged as a fixed line (never the error's text); the next tick runs it again
    deps.warn(JSON.stringify({ event: (err as { code?: unknown }).code === "42501" ? "aap.purge_not_permitted" : "aap.purge_failed" }));
    return { ...PURGE_FAILED };
  }
}
