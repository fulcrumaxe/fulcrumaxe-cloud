import type { PoolClient } from "pg";
import type { LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import { computeUsd, pricingFetchedAt, priceFor } from "@fx/spend";

/**
 * D#6 R2b-5a (C32 section 5): what a run on a person's own machine would have cost at API prices. INFORMATION, NEVER SPEND: the figure
 * goes to `runner_run_usage` (migration 0768) and nowhere else. This module touches no ledger, no reservation and no `agent_runs.usd`,
 * and nothing it writes is read by a metering, budget, cap or refusal query.
 *
 * The runner's own `usd` is ignored. The cloud adds the token counts the runner reported to the run's row (`runner_usage_add`) and
 * recomputes the figure from the TOTALS with the same price tables the API runs are priced with (`computeUsd`, `priceFor` in
 * packages/spend), so a runner can neither inflate nor deflate it and the sum of two events equals one priced total. A model with no
 * price row keeps its tokens and a NULL figure. The call is made once per event the batch STORED, so a replayed batch adds nothing.
 */

/** The only backend a runner run uses (the Claude Code CLI). */
const BACKEND = "claude-code" as const;

interface Totals {
  model: string | null;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
}

/** Plan data is the one thing that may be absent at run time; its loader names that case with this code. */
const planDataUnavailable = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "plan_data_unavailable";

/**
 * Records the `usage` events among `stored` (the ones this batch newly stored, in order) on the caller's tenant client, in the caller's
 * transaction. Does nothing when there are none. The caller has already held the lease fence.
 */
export async function recordRunnerUsage(client: PoolClient, input: { accountId: string; runId: string; runnerId: string; stored: readonly LocalOnlyEvent[] }): Promise<void> {
  let totals: Totals | undefined;
  for (const event of input.stored) {
    if (event.type !== "usage" || event.usage === undefined) continue;
    const u = event.usage;
    const { rows } = await client.query<Totals>(
      "SELECT model, input_tokens::text, output_tokens::text, cache_read_tokens::text, cache_write_tokens::text FROM runner_usage_add($1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint, $6::bigint, $7::bigint)",
      [input.accountId, input.runId, input.runnerId, u.input ?? 0, u.output ?? 0, u.cache_read ?? 0, u.cache_write ?? 0],
    );
    totals = rows[0];
  }
  if (totals === undefined || totals.model === null) return;
  let usd: number;
  let version: string;
  try {
    const rate = priceFor(BACKEND, totals.model);
    if (rate === undefined) return;
    usd = computeUsd(rate, {
      inputTokens: Number(totals.input_tokens),
      outputTokens: Number(totals.output_tokens),
      cacheReadTokens: Number(totals.cache_read_tokens),
      cacheWriteTokens: Number(totals.cache_write_tokens),
    });
    version = pricingFetchedAt();
  } catch (error) {
    // Without plan data there is no price table: the tokens are kept and the figure stays empty ("no API price"), and the batch is still accepted.
    if (planDataUnavailable(error)) return;
    throw error;
  }
  await client.query("SELECT runner_usage_price($1::uuid, $2::uuid, $3::numeric, $4::text)", [input.accountId, input.runId, usd, version]);
}
