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

/**
 * D#600 CX-10a: how long the cloud took to assemble a run's prompt, and whether that had to build the repository map. `ms` is a whole number of milliseconds from a
 * monotonic clock; `cold` is true when the map was built (a cache miss), false when the cached map was used, and absent when no map was looked up (a review or fix
 * prompt, a runner build): the row then keeps NULL ("Not recorded"), never a guess.
 */
export interface ContextAssembly {
  ms: number;
  cold?: boolean;
}

export interface ContextLedgerInput {
  accountId: string;
  runId: string;
  /** The assembled prompt's sections (CX-2 supplies them); empty until then. */
  sections: readonly ContextSection[];
  measure: ContextLedgerMeasure;
  /** Tokens the memory slot held (D#601 via CX-2); absent = not recorded. */
  memoryTokens?: number;
  /** The cloud's assembly time for the run's prompt (CX-10a). Absent: not recorded. */
  assembly?: ContextAssembly;
}

export async function recordContextLedger(client: PoolClient, input: ContextLedgerInput): Promise<void> {
  const m = input.measure;
  // A figure that is not a whole number cannot be sent as the integer parameter (the cast would fail with another error); it is the same refusal as the database's.
  if (input.assembly !== undefined && !Number.isInteger(input.assembly.ms)) throw new ContextLedgerInvalid();
  try {
    await client.query("SELECT run_context_ledger_record($1::uuid, $2::uuid, $3::jsonb, $4::bigint, $5::bigint, $6::bigint, $7::bigint, $8::bigint, $9::jsonb, $10::integer, $11::text, $12::integer, $13::jsonb, $14::integer, $15::boolean)", [
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
      // D#600 CX-5b: a sandbox command's count of refused tool calls; a measure that carries none (a runner's) leaves the row's null.
      m.denied_tool_calls ?? null,
      // D#600 CX-10a: tool calls by tool (a measure that carries none leaves the row's null), and the cloud's assembly time and whether it built the map.
      m.tool_call_counts === undefined ? null : JSON.stringify(m.tool_call_counts),
      input.assembly?.ms ?? null,
      input.assembly?.cold ?? null,
    ]);
  } catch (err) {
    if ((err as { code?: unknown }).code === "22023" && (err as { message?: unknown }).message === "invalid_message") throw new ContextLedgerInvalid();
    throw err;
  }
}
