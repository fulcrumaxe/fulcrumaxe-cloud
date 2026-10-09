import type { PoolClient } from 'pg';
import { CATALOGUE_VERSION, getCatalogueEntry, getPreset, type Disposition, type PresetName } from '@fx/decisions';
import { getCurrentDialSetting, type DecisionSetting } from './decisions.js';

/**
 * The dial for `runner_run_on_member_plan` (D#6 R2b-4a, C31 section 2.1): whether a runner run that uses another member's Claude
 * plan waits for a click (`ask`), is approved at claim with a notice (`announce`) or approved at claim (`act`). One row per
 * `(repo, decision type)` in `decision_settings`, as every dial; no row means the catalogue's default.
 *
 * The claim and the read model do not use this file for the decision itself. Both ask the database (`runner_plan_auto_approvable`,
 * migration 0767), which reads the same row and treats no row as `announce`; a test pins that constant to the catalogue. This file
 * is what the dial's own route shows and writes.
 */
export const RUNNER_RUN_DECISION_TYPE = 'runner_run_on_member_plan';

/** The catalogue version this build resolves with, stamped on a claim's receipt. Re-exported so a package that does not depend on the catalogue can pass it. */
export const RUNNER_RUN_CATALOGUE_VERSION = CATALOGUE_VERSION;

export type RunnerPlanDialSource = 'preset' | 'override' | 'default';

export interface RunnerPlanDial {
  disposition: Disposition;
  source: RunnerPlanDialSource;
  /** The preset the current version adopted; null for an override or the default. */
  preset: PresetName | null;
  /** The current version, or null when no row exists and the default applies. */
  version: number | null;
}

const PRESET_NAMES: readonly string[] = ['cautious', 'balanced', 'autonomous'];
export const isPresetName = (value: unknown): value is PresetName => typeof value === 'string' && PRESET_NAMES.includes(value);

/** What this decision does under a named preset: the preset's class 2 disposition, clamped to what the entry allows. */
export function dispositionForPreset(name: PresetName): Disposition {
  const entry = getCatalogueEntry(RUNNER_RUN_DECISION_TYPE);
  if (!entry) throw new Error('runner_run_on_member_plan is not in the catalogue');
  const proposed = getPreset(name).dispositions[entry.class];
  return entry.allowedDispositions.includes(proposed) ? proposed : entry.defaultDisposition;
}

/** Pure. The dial a stored row means, or the catalogue's default for none. A stored disposition the entry does not allow fails closed to `ask`. */
export function resolveStoredDial(row: Pick<DecisionSetting, 'disposition' | 'preset' | 'version'> | null): RunnerPlanDial {
  const entry = getCatalogueEntry(RUNNER_RUN_DECISION_TYPE);
  if (!entry) throw new Error('runner_run_on_member_plan is not in the catalogue');
  if (row === null) return { disposition: entry.defaultDisposition, source: 'default', preset: null, version: null };
  const stored = row.disposition as Disposition;
  const disposition: Disposition = entry.allowedDispositions.includes(stored) ? stored : 'ask';
  const preset = isPresetName(row.preset) ? row.preset : null;
  return { disposition, source: row.preset !== null ? 'preset' : 'override', preset, version: row.version };
}

/** The repo's current dial. `client` must come from `withTenant`. */
export async function readRunnerPlanDial(client: PoolClient, repoId: string): Promise<RunnerPlanDial> {
  return resolveStoredDial(await getCurrentDialSetting(client, repoId, RUNNER_RUN_DECISION_TYPE));
}
