import type { Pool, PoolClient } from "pg";
import { CATALOGUE_VERSION } from "@fx/decisions";
import { withTenant } from "@fx/db/src/withTenant.js";
import { decisionsBlock, decisionsSectionOf, swapDecisionsBlock } from "@fx/pipeline";
import type { ContextSection, ContextSpill } from "@fx/runner";
import { resolveDecisionOffer, writeDecisionSnapshot, type DecisionOffer } from "./decisionSnapshot.js";

/**
 * D#7 DP4b-3b: what a run that is not a first build is told it may decide, and the snapshot that backs it.
 *
 * A fix round (review or check) and a run resumed after an answered ask used to get neither, so any decision they tried was refused
 * `decision_snapshot_missing`. Each now resolves its offer at its own create, from the dials and the catalogue as they stand then (never copied from the parent
 * run: a dial changed in between applies), writes the snapshot in the run's create transaction, and puts the matching block in its prompt, replacing the one a
 * retained prompt carries from the earlier run so the keys and instructions the run reads are the ones in its own row.
 *
 * Fails closed: an item with no repository, or one that is not this account's, is offered nothing (an empty snapshot, which refuses every request as an unknown
 * key). A dial or catalogue read that fails throws, so no run starts without a snapshot its prompt agrees with. The repository is read from the item, never taken
 * from the caller, and every read goes through `withTenant` for the account.
 */
export interface DecisionStart {
  offer: DecisionOffer;
  /** `prompt` with this run's block in place of any earlier one (none when the run is offered nothing). */
  prompt(prompt: string): string;
  /** The ledger sections with this run's `decisions` section in place of any earlier one, before the output section. Absent stays absent. */
  sections<T extends readonly ContextSection[] | undefined>(sections: T): T;
  /** The same for a spill's uncut prompt and its sections. */
  spill<T extends ContextSpill | undefined>(spill: T): T;
  /** The create-transaction step that writes the snapshot, chained after `others` (they run first, in order). */
  inCreateTransaction(...others: Array<((client: PoolClient, runId: string) => Promise<void>) | undefined>): (client: PoolClient, runId: string) => Promise<void>;
}

/** The offer for the item's repository, now. An item with no repository is offered nothing. */
export async function decisionOfferForItem(pool: Pool, accountId: string, workItemId: string): Promise<DecisionOffer> {
  return withTenant(pool, accountId, async (client) => {
    const r = await client.query<{ repo_id: string | null }>("SELECT repo_id FROM work_items WHERE id = $1 AND account_id = $2", [workItemId, accountId]);
    const repoId = r.rows[0]?.repo_id ?? null;
    if (repoId === null) return { items: [], snapshot: { catalogue_version: CATALOGUE_VERSION, entries: [] } };
    return resolveDecisionOffer(client, repoId, "executor", (line) => console.warn(line));
  });
}

export async function decisionStartFor(pool: Pool, accountId: string, workItemId: string): Promise<DecisionStart> {
  const offer = await decisionOfferForItem(pool, accountId, workItemId);
  const block = decisionsBlock(offer.items);
  const withoutDecisions = (sections: readonly ContextSection[]): ContextSection[] => sections.filter((s) => s.code !== "decisions");
  const withSection = (sections: readonly ContextSection[]): ContextSection[] => {
    const rest = withoutDecisions(sections);
    if (block === undefined) return rest;
    const at = rest.findIndex((s) => s.code === "output");
    return at < 0 ? [...rest, decisionsSectionOf(block)] : [...rest.slice(0, at), decisionsSectionOf(block), ...rest.slice(at)];
  };
  return {
    offer,
    prompt: (prompt) => swapDecisionsBlock(prompt, block),
    sections: ((sections: readonly ContextSection[] | undefined) => (sections === undefined ? undefined : withSection(sections))) as DecisionStart["sections"],
    spill: ((spill: ContextSpill | undefined) =>
      spill === undefined ? undefined : { ...spill, uncut: { prompt: swapDecisionsBlock(spill.uncut.prompt, block), sections: withSection(spill.uncut.sections) } }) as DecisionStart["spill"],
    inCreateTransaction:
      (...others) =>
      async (client, runId) => {
        for (const step of others) if (step) await step(client, runId);
        await writeDecisionSnapshot(client, runId, offer.snapshot);
      },
  };
}
