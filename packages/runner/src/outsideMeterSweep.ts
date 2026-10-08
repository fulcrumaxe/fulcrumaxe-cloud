import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import {
  GATEWAY_PRICES, MAX_READS, MAX_TAGS_PER_QUERY, compareToMeter, effectiveEntitlement, interpretRead, isFinal, mintGatewayTag, nextReadDueAt,
  readGatewayReport, roundUsd, type Entitlement, type ReportRow, type UnavailableReason,
} from "@fx/spend";
import type { DecryptTenantKey, EncryptedTenantKey } from "./firewallPolicy.js";

/** The slice of the runner's model-connection port the sweep reads (the same port dispatch uses). */
export interface OutsideMeterConnectionPort {
  get(accountId: string): Promise<{ provider: string; connectionId: string; encryptedKey: EncryptedTenantKey }>;
}

/**
 * D#221 OM-2b: the outside meter. At admit a run on an `ai_gateway` connection is given an unguessable tag (the firewall adds it
 * to the run's model requests, outside the VM); after finalize this sweep reads the gateway's report for the tag with the
 * connection's own key and compares it with what the runner metered (the pure rules are in @fx/spend's gatewayMeter.ts).
 * Idempotent, no lock or transaction is held across the HTTP read, and a tick stops starting groups when its time is up.
 * It never delays a run's finalize. The key is opened through the runner's existing connection and decrypt ports, the same
 * ones dispatch uses; no new route to a plaintext key exists.
 */

/** What identifies the key a tag was made under: changes when the connection is replaced or its key rotated. */
export const keyRefOf = (connectionId: string, ciphertext: Uint8Array): string =>
  createHash("sha256").update(connectionId).update(":").update(ciphertext).digest("hex");

/** The run's tag: the one already stored (a resume), else a new one stored first-wins. Never throws a second tag for one run. */
export async function ensureReportTag(
  withAccount: <T>(accountId: string, fn: (c: PoolClient) => Promise<T>) => Promise<T>,
  p: { accountId: string; runId: string; connectionId: string; keyRef: string; mint?: () => string },
): Promise<string> {
  // Through a definer: the runner's pool has no SELECT on the tag column.
  const read = (c: PoolClient) => c.query<{ t: string | null }>(`SELECT agent_run_outside_meter_tag($1::uuid, $2::uuid) AS t`, [p.accountId, p.runId]);
  return withAccount(p.accountId, async (c) => {
    const have = (await read(c)).rows[0]?.t;
    if (have) return have;
    const tag = (p.mint ?? mintGatewayTag)();
    await c.query(`SELECT agent_run_outside_meter_start($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6)`, [p.accountId, p.runId, tag, p.accountId, p.connectionId, p.keyRef]);
    return (await read(c)).rows[0]!.t!;
  });
}

/** The connection's entitlement as the tag-minting side sees it (derived: a `no` is forgotten after 7 days or a key change). */
export async function connectionEntitlement(pool: Pool, accountId: string, connectionId: string, keyRef: string, now = new Date()): Promise<Entitlement> {
  const row = await withTenant(pool, accountId, async (c) => {
    const { rows } = await c.query<{ v: Entitlement; at: Date | null; k: string | null }>(
      `SELECT outside_meter_entitlement AS v, outside_meter_entitlement_at AS at, outside_meter_key_ref AS k FROM model_connections WHERE account_id = $1 AND id = $2`,
      [accountId, connectionId],
    );
    return rows[0];
  });
  return row ? effectiveEntitlement({ value: row.v, setAt: row.at }, now, row.k !== null && row.k !== keyRef) : "unknown";
}

interface DueRow {
  account_id: string; run_id: string; tag: string; payer_account_id: string; connection_id: string; key_ref: string; reads: number;
  finalized_at: Date; last_cost: string | null; last_count: number | null; read_share_usd: string; metered_usd: string | null; metered_calls: number | null; started_at: Date;
}

export interface OutsideMeterDeps {
  pool: Pool;
  modelConnection: OutsideMeterConnectionPort;
  decryptTenantKey: DecryptTenantKey;
  /** The `FX_OUTSIDE_METER` switch, read per tick. */
  flagOn: () => boolean;
  /** Tests only: a local fake of the report host. */
  reportBase?: string;
  now?: () => Date;
  clock?: () => number;
  timeBudgetMs?: number;
  onError?: (runId: string | null, err: unknown) => void;
}

export interface OutsideMeterResult { listed: number; waiting: number; read: number; final: number; unavailable: number; failed: number; skipped: number }

const TICK_BUDGET_MS = 300_000;
const RUN_COLS = `$1::uuid, $2::uuid, $3, $4, $5::int, $6::timestamptz, $7::numeric, $8::int, $9::text[], $10::numeric, $11::numeric, $12::numeric, $13::numeric`;

export async function sweepOutsideMeter(deps: OutsideMeterDeps): Promise<OutsideMeterResult> {
  const now = deps.now ?? (() => new Date());
  const clock = deps.clock ?? (() => performance.now());
  const began = clock();
  const out: OutsideMeterResult = { listed: 0, waiting: 0, read: 0, final: 0, unavailable: 0, failed: 0, skipped: 0 };
  const { rows } = await deps.pool.query<DueRow>(`SELECT * FROM outside_meter_list_due($1)`, [200]);
  out.listed = rows.length;
  out.waiting = Number((await deps.pool.query<{ n: string }>(`SELECT outside_meter_waiting() AS n`)).rows[0]?.n ?? 0);

  const record = (r: DueRow, v: { state: string; reason?: string | null; reads: number; next?: Date | null; row?: ReportRow; flags?: string[]; share?: number; g?: number | null; trueUp?: number | null; overhead?: number | null }) =>
    withTenant(deps.pool, r.account_id, async (c) => {
      await c.query(`SELECT agent_run_outside_meter_record(${RUN_COLS})`, [
        r.account_id, r.run_id, v.state, v.reason ?? null, v.reads, v.next ?? null, v.row?.totalCost ?? null, v.row?.requestCount ?? null,
        v.flags ?? [], v.share ?? Number(r.read_share_usd), v.g ?? null, v.trueUp ?? null, v.overhead ?? null,
      ]);
    });
  const finish = async (r: DueRow, reason: UnavailableReason, reads: number, flags: string[] = []): Promise<void> => {
    await record(r, { state: "unavailable", reason, reads, flags });
    out.unavailable++;
  };
  const guarded = async (r: DueRow, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      // fx-swallow-ok: counted as failed and handed to onError (the worker logs a fixed code and the run id); the next tick looks again
      out.failed++;
      deps.onError?.(r.run_id, err);
    }
  };

  // Flag off: no reads. A run left pending is closed once its 24 hours have passed, and parked until then.
  if (!deps.flagOn()) {
    for (const r of rows) {
      await guarded(r, async () => {
        const end = new Date(r.finalized_at.getTime() + 24 * 3_600_000);
        if (now() >= end) await finish(r, "flag_off", r.reads);
        else await record(r, { state: "pending", reads: r.reads, next: end, row: r.last_count === null ? undefined : { tag: r.tag, totalCost: Number(r.last_cost), surchargeCost: 0, requestCount: r.last_count } });
      });
    }
    return out;
  }

  const groups = new Map<string, DueRow[]>();
  for (const r of rows) groups.set(`${r.payer_account_id}|${r.connection_id}`, [...(groups.get(`${r.payer_account_id}|${r.connection_id}`) ?? []), r]);

  for (const [, runs] of groups) {
    if (clock() - began > (deps.timeBudgetMs ?? TICK_BUDGET_MS)) {
      out.skipped += runs.length;
      continue;
    }
    const first = runs[0]!;
    // The connection as it is now. A different one (removed, replaced, key rotated) is never read with: api_key_id=self would count its spend.
    let conn: Awaited<ReturnType<OutsideMeterConnectionPort["get"]>> | undefined;
    try {
      conn = await deps.modelConnection.get(first.payer_account_id);
    } catch {
      // fx-swallow-ok: no connection to read with is the connection_changed outcome below, never a read with some other key
      conn = undefined;
    }
    const keyRef = conn ? keyRefOf(conn.connectionId, conn.encryptedKey.ciphertext) : undefined;
    if (!conn || conn.provider !== "ai_gateway") {
      for (const r of runs) await guarded(r, () => finish(r, "connection_changed", r.reads));
      continue;
    }
    const usable = runs.filter((r) => r.key_ref === keyRef && r.connection_id === conn!.connectionId);
    for (const r of runs.filter((x) => !usable.includes(x))) await guarded(r, () => finish(r, "connection_changed", r.reads));
    if (usable.length === 0) continue;
    if ((await connectionEntitlement(deps.pool, first.payer_account_id, conn.connectionId, keyRef!, now())) === "no") {
      for (const r of usable) await guarded(r, () => finish(r, "plan_not_entitled", r.reads));
      continue;
    }
    let apiKey: string;
    try {
      apiKey = await deps.decryptTenantKey(conn.encryptedKey, { accountId: first.payer_account_id, connectionId: conn.connectionId });
    } catch (err) {
      // fx-swallow-ok: counted as failed and handed to onError with no key text; the runs stay pending and the next tick tries again
      out.failed += usable.length;
      deps.onError?.(null, err); // a fixed-code failure; never the key
      continue;
    }

    for (let i = 0; i < usable.length; i += MAX_TAGS_PER_QUERY) {
      const batch = usable.slice(i, i + MAX_TAGS_PER_QUERY);
      const outcome = await readGatewayReport({
        base: deps.reportBase, apiKey, tags: batch.map((r) => r.tag), today: now(),
        startDay: new Date(Math.min(...batch.map((r) => r.started_at.getTime()))),
      });
      out.read += batch.length;
      const share = GATEWAY_PRICES.reportQueryUsd / batch.length;
      for (const r of batch) {
        await guarded(r, async () => {
          const reads = r.reads + 1;
          const last = reads >= MAX_READS;
          const verdict = interpretRead(outcome, last);
          if (verdict.entitlement && outcome.kind !== "contract") {
            await withTenant(deps.pool, first.payer_account_id, (c) => c.query(`SELECT outside_meter_set_entitlement($1::uuid, $2::uuid, $3, $4)`, [first.payer_account_id, conn!.connectionId, verdict.entitlement, keyRef]));
          }
          if (verdict.run === "keep" && outcome.kind === "transient") return; // no state change; the next tick tries again
          const flags = verdict.flag ? [verdict.flag] : [];
          if (typeof verdict.run === "object") return finish(r, verdict.run.unavailable, reads, verdict.run.flag ? ["outside_meter_bad_request"] : flags);
          const next = nextReadDueAt(r.finalized_at, reads);
          if (verdict.run === "keep" || outcome.kind !== "ok") return record(r, { state: "pending", reads, next, flags, share: Number(r.read_share_usd) + share });
          const cur = outcome.rows.get(r.tag);
          const prev = r.last_count === null ? undefined : { tag: r.tag, totalCost: Number(r.last_cost), surchargeCost: 0, requestCount: r.last_count };
          const readShare = Number(r.read_share_usd) + share;
          if (!cur || !isFinal(prev, cur, r.metered_calls)) {
            if (last) return finish(r, cur ? "not_stable" : "no_rows", reads, [...flags, "outside_meter_unavailable"]);
            return record(r, { state: "pending", reads, next, row: cur, flags, share: readShare });
          }
          const cmp = compareToMeter(Number(r.metered_usd ?? 0), cur);
          const overhead = roundUsd(cur.surchargeCost + readShare);
          const f = [...(r.metered_calls === null ? ["outside_meter_no_count"] : []), ...(cmp.disagree ? ["outside_meter_disagree"] : []), ...(cmp.escalate ? ["outside_meter_escalate"] : [])];
          // The lines first (each unique per run, so a repeat is a no-op), then the result: a crash between them re-reads and finds both done.
          await withTenant(deps.pool, r.account_id, async (c) => {
            const line = (usd: number, reason: string) =>
              c.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget, reason) VALUES ($1, 'model', 'customer_gateway', $2, $3, 'model', $4) ON CONFLICT (account_id, run_id, reason) WHERE reason IS NOT NULL DO NOTHING`, [r.account_id, usd, r.run_id, reason]);
            if (cmp.trueUpUsd > 0) await line(cmp.trueUpUsd, "outside_meter");
            if (overhead > 0) await line(overhead, "outside_meter_overhead");
          });
          await record(r, { state: cmp.trueUpUsd > 0 ? "higher" : "matches", reads, row: cur, flags: f, share: readShare, g: cmp.gatewayUsd, trueUp: cmp.trueUpUsd, overhead });
          out.final++;
        });
      }
    }
  }
  return out;
}
