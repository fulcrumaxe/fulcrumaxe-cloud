import type { EnvelopeRaiser } from "@fx/core/src/decisions/envelopeRaise.js";
import { auditEnvelopeChanged, currentEnvelope, EnvelopeWriteError, itemEnvelopeId, writeEnvelopeVersion } from "@fx/spend";
import type { EnvelopeScope } from "@fx/spend";

/**
 * Applies a "raise the limit" answer on the answer's own transaction (the person's session, so the new version's author is that person and the write policy
 * requires an owner or admin).
 *
 * - Bound to the question: it applies only while the item's envelope is still at the version the ask was raised for (the `envelope_pause_asks` row). A limit
 *   lowered, voided or raised since then makes the old question stale (`stale`), so an old ask can never put a limit back.
 * - The write is pinned to that version (`fromVersion`), so an edit that commits between the check and the write collides on the version key and is `conflict`, never overwritten.
 * - It writes exactly the limit the person was shown, never more, through the settings writer, so the account's monthly budget cap applies
 *   (`over_account_budget` rolls the answer back and keeps the ask open).
 * - It writes the same `envelope.changed` audit row a settings edit writes (both versions, both amounts; the actor is the session's).
 * - Losing the race for the next version to a settings edit is `conflict`, not a crash.
 */
export const raiseItemEnvelope: EnvelopeRaiser = async (client, facts) => {
  const envelopeId = await itemEnvelopeId(client, facts.accountId, facts.workItemId);
  const current = envelopeId === null ? null : await currentEnvelope(client, facts.accountId, envelopeId);
  if (envelopeId === null || current === null) return "no_envelope";
  const asked = (
    await client.query<{ envelope_version: number }>("SELECT envelope_version FROM envelope_pause_asks WHERE account_id = $1 AND ask_id = $2 AND work_item_id = $3 AND envelope_id = $4", [facts.accountId, facts.askId, facts.workItemId, envelopeId])
  ).rows[0];
  if (!asked || asked.envelope_version !== current.version) return "stale";
  if (current.amountUsd >= facts.limitUsd) return "already_covered";
  const row = (await client.query<{ scope: EnvelopeScope; repo_id: string | null }>("SELECT scope, repo_id FROM approval_envelopes WHERE account_id = $1 AND id = $2 AND version = $3", [facts.accountId, envelopeId, current.version])).rows[0];
  if (!row) return "no_envelope";
  let written: { version: number };
  try {
    written = await writeEnvelopeVersion(client, { accountId: facts.accountId, envelopeId, scope: row.scope, repoId: row.repo_id, amountUsd: facts.limitUsd, fromVersion: current.version });
  } catch (err) {
    if (err instanceof EnvelopeWriteError && err.code === "over_account_budget") return "over_account_budget";
    if (err instanceof EnvelopeWriteError && err.code === "version_conflict") return "conflict";
    throw err;
  }
  await auditEnvelopeChanged(client, {
    envelope_id: envelopeId,
    scope: row.scope,
    repo_id: row.repo_id,
    from_version: current.version,
    to_version: written.version,
    from: current.amountUsd,
    to: facts.limitUsd,
  });
  return "raised";
};
