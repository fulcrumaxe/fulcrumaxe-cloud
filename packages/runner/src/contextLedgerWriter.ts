import type { PoolClient } from "pg";
import type { ContextLedgerMeasure, ContextSection } from "@fulcrumaxe/runner-protocol";

/**
 * D#600 CX-1a: stores one command's context measure (`ContextLedgerCapture`) and the prompt's section list on the run's ledger row,
 * through `run_context_ledger_record` (migration 0792; EXECUTE for the run-writer login only).
 *
 * The caller's client is already inside the tenant's transaction (`app.account_id` set). The function validates everything again
 * (closed section and tool enums, ranges) and refuses with the fixed message `invalid_message` (SQLSTATE 22023); that refusal is
 * surfaced here as `ContextLedgerInvalid` so a caller can tell "the data was refused" from "the database failed".
 * Integers, hashes and enums only: nothing passed here is prompt text, a path or a tool input.
 */

export class ContextLedgerInvalid extends Error {
  readonly code = "invalid_message";
  constructor() {
    super("invalid_message");
    this.name = "ContextLedgerInvalid";
  }
}

export interface ContextLedgerInput {
  accountId: string;
  runId: string;
  /** The assembled prompt's sections (CX-2 supplies them); empty until then. */
  sections: readonly ContextSection[];
  measure: ContextLedgerMeasure;
  /** Tokens the memory slot held (D#601 via CX-2); absent = not recorded. */
  memoryTokens?: number;
}

export async function recordContextLedger(client: PoolClient, input: ContextLedgerInput): Promise<void> {
  const m = input.measure;
  try {
    await client.query("SELECT run_context_ledger_record($1::uuid, $2::uuid, $3::jsonb, $4::bigint, $5::bigint, $6::bigint, $7::bigint, $8::bigint, $9::jsonb, $10::integer, $11::text)", [
      input.accountId,
      input.runId,
      JSON.stringify(input.sections),
      m.first_turn_input_tokens,
      m.peak_context_tokens,
      m.cache_read_tokens,
      m.cache_write_tokens,
      input.memoryTokens ?? null,
      JSON.stringify(m.tool_output_bytes),
      m.compactions,
      m.basis,
    ]);
  } catch (err) {
    if ((err as { code?: unknown }).code === "22023" && (err as { message?: unknown }).message === "invalid_message") throw new ContextLedgerInvalid();
    throw err;
  }
}
