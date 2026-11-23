import type { PoolClient } from "pg";
import { CATALOGUE, PRESETS, decide } from "@fx/decisions";
import type { CatalogueEntry, Disposition, PresetName } from "@fx/decisions";
import { DIAL_DEFAULT_MARKER, getCurrentDialSetting, mapDecisionSettingRow, type DecisionSetting, type DecisionSettingRow } from "./decisions.js";

/**
 * Which D#7 preset a repo's class 2 dials currently match. It lives here, not in the API route, so the runner picker
 * (packages/runner-cloud, which the API package depends on) reads the same logic as GET /api/v1/repos/{id}/decision-settings.
 */

export const CLASS_2 = "human_over_the_loop";
export const classTwo = (): CatalogueEntry[] => CATALOGUE.filter((e) => e.class === CLASS_2);

/** No version, or a "use the default" version: the catalogue's default is in force. */
export const isDefault = (row: DecisionSetting | null): boolean => row === null || row.preset === DIAL_DEFAULT_MARKER;

/** What `decide()` resolves for an entry under a preset: the one definition of "what this preset does". */
export function presetDisposition(entry: CatalogueEntry, preset: PresetName): Disposition {
  return decide(entry, { preset }, { type: entry.id, options: [], proposed: "", rationale: "" }).disposition;
}

/**
 * The dials the runtime reads a missing row as Balanced for (owner ruling 10-25): the three start dials (`startDecide.presetFor`), the fix-round and child-launch
 * dial (`fixRoundGate.presetOf`), and the two types the executor card declares, which the decision snapshot freezes as Balanced (`decisionSnapshot.dispositionForDial`).
 * Pinned against the start path by `decision-settings-start.test.ts`. "Run on a member's plan" is not here: the runner claim keeps its own rule, the catalogue default,
 * which already equals Balanced's value. Neither is the merge dial (`merge_after_reviews`): the merge gate reads it and reads no row, or a "use the default" row,
 * as the catalogue default `act`, so it keeps that value here too (it merges as Balanced's `announce` does, and the executor-card pin would fail if this list said announce).
 * A dial no runtime path reads keeps its catalogue default.
 */
export const RUNTIME_NO_ROW_BALANCED: ReadonlySet<string> = new Set(["start_work_small", "start_work_bug", "start_work_doc", "launch_sub_item", "nonbreaking_refactor_approach", "test_strategy_choice"]);

/** What a dial with no version means: what the runtime does with it (Balanced), never the catalogue's `ask` for a dial the runtime overrides. */
export function noRowDisposition(entry: CatalogueEntry): Disposition {
  return RUNTIME_NO_ROW_BALANCED.has(entry.id) ? presetDisposition(entry, "balanced") : entry.defaultDisposition;
}

/**
 * The start dials. The auto-start sweep (`autoStartSweep.gateOne`) starts a proposal unattended only on a dial row a person WROTE: no row, and a "default"
 * marker row (what Reset writes), start nothing. So a person's explicit choice writes these rows even where the value in force already matches, and
 * skipping the choice writes nothing. Derived from the runtime list above, so a dial added later is not in it until the sweep reads it.
 */
export const START_DIALS: ReadonlySet<string> = new Set([...RUNTIME_NO_ROW_BALANCED].filter((id) => id.startsWith("start_work_")));
export const needsWritten = (entry: CatalogueEntry, row: DecisionSetting | null): boolean => START_DIALS.has(entry.id) && isDefault(row);

/**
 * The merge dial. With no written row the gate reads `act`, which merges exactly as Balanced's `announce` does, so it counts as matching Balanced. But choosing
 * Balanced writes `announce` for it, so the receipt and the screen say what the person chose. The preview then says what is truly written (act to announce).
 */
export const MERGE_DIAL = "merge_after_reviews";
export const writesBalancedMerge = (entry: CatalogueEntry, row: DecisionSetting | null, preset: PresetName): boolean => entry.id === MERGE_DIAL && preset === "balanced" && isDefault(row);

/**
 * A dial that is not in the list above and nobody has set keeps its catalogue default and never keeps a repo from reading Balanced: a dial no runtime path reads
 * has no opinion, and the merge dial is read by the gate as `act`, which merges as Balanced does (Balanced is then written for it only by a person's choice, see
 * `writesBalancedMerge`). A dial added to the catalogue later is treated like the first kind until the runtime reads it and it joins the list.
 */
export const unreadDefault = (entry: CatalogueEntry, row: DecisionSetting | null): boolean => !RUNTIME_NO_ROW_BALANCED.has(entry.id) && isDefault(row);
/**
 * The dials no preset moves (D#601 MEM-10). Auto-approving memory puts text into later prompts, so a person raises it on purpose, per repository, and
 * choosing Balanced, Autonomous or Cautious neither raises it nor lowers it. Every preset therefore matches it at any value (it never decides which preset
 * is active), and a preset that would have moved it lists it as held with the sentence below, so a raised dial is not mistaken for one Cautious turned
 * off. With no version it reads as the catalogue default (`ask`): it is not in the runtime Balanced list above, because nothing reads a missing row as
 * anything else.
 */
export const PRESET_FIXED: ReadonlySet<string> = new Set(["memory_auto_approve"]);

export const atPreset = (entry: CatalogueEntry, row: DecisionSetting | null, preset: PresetName): boolean =>
  PRESET_FIXED.has(entry.id) || effective(entry, row) === presetDisposition(entry, preset) || (preset === "balanced" && unreadDefault(entry, row));

/** The disposition in force: the current version, else what no version means. A stored value the entry does not allow fails closed to `ask`. */
export function effective(entry: CatalogueEntry, row: DecisionSetting | null): Disposition {
  if (row === null) return noRowDisposition(entry);
  const stored = row.disposition as Disposition;
  return entry.allowedDispositions.includes(stored) ? stored : "ask";
}

export function activePreset(rows: Map<string, DecisionSetting | null>): PresetName | null {
  const match = PRESETS.find((p) => classTwo().every((e) => atPreset(e, rows.get(e.id) ?? null, p.name)));
  return match ? match.name : null;
}

export async function currentRows(client: PoolClient, repoId: string): Promise<Map<string, DecisionSetting | null>> {
  const rows = new Map<string, DecisionSetting | null>();
  for (const entry of classTwo()) rows.set(entry.id, await getCurrentDialSetting(client, repoId, entry.id));
  return rows;
}

/**
 * `activePreset` for many repos of one account in a single read (the runner picker). The current version of every class 2 dial of each repo, named by the account on top of row
 * security; a repo with no row for a dial reads as null for it, exactly as `currentRows` does. A repo id that is not the account's has no rows, so its map is all null.
 */
export async function activePresetsFor(client: PoolClient, accountId: string, repoIds: readonly string[]): Promise<Map<string, PresetName | null>> {
  const ids = classTwo().map((e) => e.id);
  const byRepo = new Map<string, Map<string, DecisionSetting | null>>(repoIds.map((r) => [r, new Map(ids.map((id) => [id, null]))]));
  if (repoIds.length > 0) {
    const { rows } = await client.query<DecisionSettingRow>(
      `SELECT DISTINCT ON (repo_id, decision_type) * FROM decision_settings
        WHERE account_id = $1 AND repo_id = ANY($2::uuid[]) AND decision_type = ANY($3::text[])
        ORDER BY repo_id, decision_type, version DESC`,
      [accountId, [...repoIds], ids],
    );
    for (const row of rows) byRepo.get(row.repo_id)?.set(row.decision_type, mapDecisionSettingRow(row));
  }
  return new Map([...byRepo].map(([repoId, rows]) => [repoId, activePreset(rows)]));
}
