import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { AGENT_OUTPUT_LIMITS } from "./agentOutput.js";
import { insertAgentOutputLine } from "./runStatusWriter.js";

/**
 * D#2 RLR-1 (run-log reader design, Round 3, B3): the reader's lease and cursor in `run_log_readers` (0697).
 *
 * A reader takes the lease, which raises the row's `epoch`; every later write names that epoch and succeeds only
 * while the lease is still held, so a reader that lost it (a zombie after a crash and takeover) can move nothing.
 * The cursor, the state snapshot, the lease renewal and the `agent.output` rows of one batch are saved in ONE
 * transaction by `commit`: all of it lands, or none. `pool` must be the runner login's pool (a member of
 * app_user and agent_run_writer); no other login can read or write the table.
 *
 * Time is the database's (`clock_timestamp()`), never this process's, so two instances cannot disagree about
 * whether a lease has expired.
 */

/** How long a taken or renewed lease lasts (RL1). */
export const LEASE_TTL_SECONDS = 60;

/** What a reader restores on taking the lease. */
export interface ReaderCursor {
  /** The fencing token this taker holds; pass it to every later call. */
  epoch: number;
  cmdId: string;
  recordPath: string;
  /** The next record seq to accept. */
  nextSeq: number;
  /** The byte offset in the record file of that record. */
  byteOffset: number;
  state: Record<string, unknown>;
  sideEffects: Record<string, unknown>;
  readFailures: number;
}

export interface ReaderCommit {
  accountId: string;
  runId: string;
  epoch: number;
  nextSeq: number;
  byteOffset: number;
  state: Record<string, unknown>;
  sideEffects: Record<string, unknown>;
  readFailures: number;
  /** `agent.output` rows for this batch, keyed by the record line they came from. */
  rows?: ReadonlyArray<{ sourceLine: number; payload: Record<string, unknown> }>;
}

interface CursorRow {
  epoch: string;
  cmd_id: string;
  record_path: string;
  next_seq: string;
  byte_offset: string;
  state: Record<string, unknown>;
  side_effects: Record<string, unknown>;
  read_failures: number;
}

/** Creates the run's reader row at epoch 0 with an already-expired lease. Idempotent: false when the row exists. */
export async function insertReader(pool: Pool, p: { accountId: string; runId: string; cmdId: string }): Promise<boolean> {
  return withTenant(pool, p.accountId, async (client) => {
    const { rowCount } = await client.query(
      `INSERT INTO run_log_readers (run_id, account_id, cmd_id, record_path) VALUES ($1::uuid, $2, $3, '/fx/run/' || $1::text || '.rec')
       ON CONFLICT (run_id) DO NOTHING`,
      [p.runId, p.accountId, p.cmdId],
    );
    return rowCount === 1;
  });
}

/**
 * Takes the lease if it is free or expired, raising the epoch. Returns the cursor to resume from, or null when
 * another reader holds the lease (or the run has no row). Of any number of concurrent takers exactly one gets a
 * cursor: the row lock makes the others re-test the lease against the winner's new expiry.
 */
export async function takeLease(pool: Pool, p: { accountId: string; runId: string }): Promise<ReaderCursor | null> {
  return withTenant(pool, p.accountId, async (client) => {
    const { rows } = await client.query<CursorRow>(
      `UPDATE run_log_readers
          SET epoch = epoch + 1, lease_until = clock_timestamp() + make_interval(secs => $3), updated_at = now()
        WHERE run_id = $1 AND account_id = $2 AND lease_until <= clock_timestamp()
        RETURNING epoch, cmd_id, record_path, next_seq, byte_offset, state, side_effects, read_failures`,
      [p.runId, p.accountId, LEASE_TTL_SECONDS],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      epoch: Number(r.epoch),
      cmdId: r.cmd_id,
      recordPath: r.record_path,
      nextSeq: Number(r.next_seq),
      byteOffset: Number(r.byte_offset),
      state: r.state,
      sideEffects: r.side_effects,
      readFailures: r.read_failures,
    };
  });
}

/** Extends the lease without moving the cursor. False means the lease is lost: stop at once. */
export async function renewLease(pool: Pool, p: { accountId: string; runId: string; epoch: number }): Promise<boolean> {
  return withTenant(pool, p.accountId, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE run_log_readers SET lease_until = clock_timestamp() + make_interval(secs => $4), updated_at = now()
        WHERE run_id = $1 AND account_id = $2 AND epoch = $3 AND lease_until > clock_timestamp()`,
      [p.runId, p.accountId, p.epoch, LEASE_TTL_SECONDS],
    );
    return rowCount === 1;
  });
}

/**
 * The single compare-and-swap: saves the cursor, the state snapshot and the renewed lease, and writes the batch's
 * `agent.output` rows, in one transaction -- only while this epoch still holds the lease. `held: false` means
 * nothing was written (a stale epoch, an expired lease, or a cursor that would move backwards); any error rolls the
 * whole save back. `side_effects` merge instead of overwrite: a flag that is true stays true. Every row payload is
 * held to the same size cap as the live `agent.output` writer, checked before anything is written.
 */
export async function commit(pool: Pool, p: ReaderCommit): Promise<{ held: boolean }> {
  for (const row of p.rows ?? []) {
    if (Buffer.byteLength(JSON.stringify(row.payload), "utf8") > AGENT_OUTPUT_LIMITS.maxPayloadJsonBytes) {
      throw new Error(`agent.output payload for line ${row.sourceLine} is over the size cap`);
    }
  }
  return withTenant(pool, p.accountId, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE run_log_readers
          SET next_seq = $4, byte_offset = $5, state = $6, read_failures = $8,
              side_effects = (SELECT COALESCE(jsonb_object_agg(k.key, CASE WHEN run_log_readers.side_effects -> k.key = 'true'::jsonb
                                                                            THEN 'true'::jsonb
                                                                            ELSE COALESCE($7::jsonb -> k.key, run_log_readers.side_effects -> k.key) END), '{}'::jsonb)
                                FROM jsonb_object_keys(run_log_readers.side_effects || $7::jsonb) AS k(key)),
              lease_until = clock_timestamp() + make_interval(secs => $9), updated_at = now()
        WHERE run_id = $1 AND account_id = $2 AND epoch = $3 AND lease_until > clock_timestamp()
          AND next_seq <= $4 AND byte_offset <= $5`,
      [p.runId, p.accountId, p.epoch, p.nextSeq, p.byteOffset, JSON.stringify(p.state), JSON.stringify(p.sideEffects), p.readFailures, LEASE_TTL_SECONDS],
    );
    if (rowCount !== 1) return { held: false };
    for (const row of p.rows ?? []) {
      await insertAgentOutputLine(client, { accountId: p.accountId, runId: p.runId, sourceLine: row.sourceLine, payload: row.payload });
    }
    return { held: true };
  });
}

/** Gives the lease up early so the next taker need not wait out the TTL. A no-op unless this epoch is current. */
export async function releaseLease(pool: Pool, p: { accountId: string; runId: string; epoch: number }): Promise<boolean> {
  return withTenant(pool, p.accountId, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE run_log_readers SET lease_until = clock_timestamp(), updated_at = now()
        WHERE run_id = $1 AND account_id = $2 AND epoch = $3`,
      [p.runId, p.accountId, p.epoch],
    );
    return rowCount === 1;
  });
}
