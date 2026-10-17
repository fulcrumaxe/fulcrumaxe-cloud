import type { Pool } from "pg";
import { raiseAsk } from "@fx/db/src/decisionAsks.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { currentEnvelope, envelopeSpentUsd, itemEnvelopeId, recordEnvelopePauseAsk } from "@fx/spend";

/**
 * D#483 S5-d: the `spend_past_envelope` ask. When a run's start is denied because it would pass its item's spend envelope, the person is asked once per item
 * per envelope version: raise the limit, or stop the item. A new version of the envelope (a raise) is a new question, so a second denial after a raise that
 * was still too small asks again; a second denial under the same version does not.
 *
 * Runs on the RECEIPT login's pool (the only login that may call the ask definer), inside one tenant transaction: the "already asked" row and the ask commit or
 * roll back together, and a lock on (item, envelope, version) makes two denials at once raise one ask. The ask is anchored on the item's latest finished
 * run (DP11b can only answer an ask that has one); an item with none yet (a limit below its first run is refused when the envelope is written) is not asked.
 * Nothing in it is customer text: the rationale and the two labels are fixed words and figures.
 */

export type EnvelopeAskOutcome = "raised" | "already_asked" | "no_envelope" | "no_run";

const FINISHED = ["succeeded", "failed", "timed_out", "killed_spend"];
const cents = (usd: number): string => `$${(Math.ceil(usd * 100 - 1e-9) / 100).toFixed(2)}`;

export function createEnvelopeAsk(receiptPool: Pool) {
  /** `runUsd` is what the denied run would have reserved: the labelled new limit is what covers it on top of what the envelope has already spent or holds. */
  return async function raiseEnvelopeAskOnce(input: { accountId: string; workItemId: string; runUsd: number }): Promise<EnvelopeAskOutcome> {
    const { accountId, workItemId } = input;
    return withTenant(receiptPool, accountId, async (client) => {
      const envelopeId = await itemEnvelopeId(client, accountId, workItemId);
      const envelope = envelopeId === null ? null : await currentEnvelope(client, accountId, envelopeId);
      if (envelopeId === null || envelope === null) return "no_envelope";
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${accountId}:envelope_ask:${workItemId}:${envelopeId}:${envelope.version}`]);
      const asked = await client.query("SELECT 1 FROM envelope_pause_asks WHERE account_id = $1 AND work_item_id = $2 AND envelope_id = $3 AND envelope_version = $4", [accountId, workItemId, envelopeId, envelope.version]);
      if (asked.rows.length > 0) return "already_asked";
      const run = (
        await client.query<{ id: string }>(
          "SELECT id FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND status = ANY($3::text[]) ORDER BY COALESCE(ended_at, created_at) DESC, id DESC LIMIT 1",
          [accountId, workItemId, FINISHED],
        )
      ).rows[0];
      if (!run) return "no_run";
      const spent = await envelopeSpentUsd(client, accountId, envelopeId);
      const askId = await raiseAsk(client, {
        class: "human_in_the_loop",
        decisionType: "spend_past_envelope",
        workItemId,
        runId: run.id,
        options: [
          { id: "raise_limit", label: `Raise the limit to ${cents(spent + Math.max(0, input.runUsd))}` },
          { id: "stop_item", label: "Stop this item" },
        ],
        proposed: "raise_limit",
        rationale: `This item has used ${cents(spent)} of its ${cents(envelope.amountUsd)} limit, and its next step needs about ${cents(Math.max(0, input.runUsd))} more. Nothing more starts until you raise the limit or stop the item.`,
        quotedInputs: [],
      });
      // envelope_pause_ask_record (0865) is the only writer and refuses unless the ask just raised exists, so the memory never stands without its ask.
      await recordEnvelopePauseAsk(client, { workItemId, envelopeId, version: envelope.version, askId });
      return "raised";
    });
  };
}

export type RaiseEnvelopeAsk = ReturnType<typeof createEnvelopeAsk>;
