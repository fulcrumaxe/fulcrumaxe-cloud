import type { Pool } from 'pg';
import { applyCustomerOverride, meetsFloor, floorFor } from './floors.js';
import { backendForRole } from './backendAllowlist.js';
import { validateRoutingRows } from './tableSchema.js';
import type { ModelId, RouteInput, RouteResult, RoutingRow, RoutingTable } from './types.js';

/**
 * Pure, synchronous and deterministic: the same RouteInput + RoutingTable
 * always produce the same RouteResult (Spec H22 "Deterministic"). No I/O
 * happens here -- that is loadLiveRoutingTable's job below -- which is
 * what lets test/route.determinism.test.ts call this twice, and the
 * property test call it 1,000 times, with zero model tokens and no
 * database.
 */
export function route(input: RouteInput, table: RoutingTable): RouteResult {
  const row = table.rows.find((r) => r.role === input.role && r.size === input.size);
  if (!row) {
    throw new Error(`no routing row for role "${input.role}", size "${input.size}" in table v${table.version}`);
  }

  let model: ModelId;
  let reason: string;

  // Floored roles are pinned to claude-code + Claude whatever the account
  // default says (D#221 S4).
  const target = backendForRole(floorFor(input.role) !== undefined, input.accountBackend);

  const override = input.repoSettings?.modelOverride;
  if (override !== undefined && applyCustomerOverride(input.role, override, target).accepted) {
    model = override;
    reason = 'customer override';
  } else {
    model = row.model;
    reason = `table v${table.version}: ${input.role}/${input.size}`;
  }

  // Floors always win, whatever the table or the override said (Spec H22
  // "Floors ... whatever the table, the customer override or
  // de-escalation says").
  if (!meetsFloor(input.role, model, target)) {
    model = floorFor(input.role) as ModelId;
    reason = 'floor: security';
  }

  return { model, reason, tableVersion: table.version, backend: target.backend, provider: target.provider };
}

/** Reads ONLY the live routing table version from Postgres (Spec H22:
 * "The router reads only the live version from Postgres"). */
export async function loadLiveRoutingTable(pool: Pool): Promise<RoutingTable> {
  const { rows: tableRows } = await pool.query<{ version: number }>(
    "SELECT version FROM routing_tables WHERE status = 'live'",
  );
  const liveRow = tableRows[0];
  if (!liveRow) {
    throw new Error('no live routing_tables row found');
  }

  const { rows } = await pool.query<RoutingRow>(
    'SELECT role, size, model, rationale FROM routing_rows WHERE table_version = $1',
    [liveRow.version],
  );

  // Security fix round (CWE-693): floor validation used to be exercised
  // only by tests, never called from this function itself, so a
  // platform_ops UPDATE that put a floored role below its floor directly
  // in routing_rows was only ever caught by route()'s own runtime clamp --
  // one line of defense, and the same one escalate() (fixed above) used
  // to bypass entirely. Validating here means a floor-violating live table
  // can never even be loaded.
  validateRoutingRows(rows);

  return { version: liveRow.version, rows };
}

/** Convenience wrapper for callers (H09) that just want "route this run
 * against whatever is live right now" without loading the table
 * themselves first. */
export async function routeForRun(pool: Pool, input: RouteInput): Promise<RouteResult> {
  const table = await loadLiveRoutingTable(pool);
  return route(input, table);
}
