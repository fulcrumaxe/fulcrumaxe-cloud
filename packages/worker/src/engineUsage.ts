import type { PoolClient } from "pg";
import { priceUsageTotals } from "./runnerUsage.js";

/** One agent's or tick's totals as `engine_events_ingest` (migration 1027) answers them. */
export interface EngineUsageSubject {
  subject_kind: "agent" | "tick";
  subject_id: string;
  model: string | null;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
}

/**
 * Engine bridge EB-4: prices the totals an engine batch just stored, on the caller's tenant client in the caller's transaction. The figure is what the
 * cloud's own price tables say (`priceUsageTotals`, the same step a runner run goes through); the engine sends tokens and a model, never a dollar amount.
 * A model with no price row, or no model, keeps its tokens and an empty figure. Information only: nothing here touches spend.
 */
export async function recordEngineUsage(client: PoolClient, input: { accountId: string; sessionId: string; subjects: readonly EngineUsageSubject[] }): Promise<void> {
  for (const s of input.subjects) {
    const priced = priceUsageTotals(s);
    if (priced === null) continue;
    await client.query("SELECT engine_usage_price($1::uuid, $2::uuid, $3::text, $4::text, $5::numeric, $6::text)", [input.accountId, input.sessionId, s.subject_kind, s.subject_id, priced.usd, priced.version]);
  }
}
