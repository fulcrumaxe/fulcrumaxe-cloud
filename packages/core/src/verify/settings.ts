import type { PoolClient } from 'pg';
import { parseStandingJourneys, VerifyInputError, type StandingJourney } from './journeys.js';

/**
 * D#6 V1: a repository's verify settings (migration 1003). Verification is OFF unless a row says otherwise, so a repository nobody configured costs nothing.
 * The database lets only an owner or admin of the account write a row (the policy joins account_members on the session's user); this module checks the values.
 */
export const ELIGIBILITIES = ['all', 'ui_paths'] as const;
export type Eligibility = (typeof ELIGIBILITIES)[number];
export const DEPLOY_MODES = ['runner_command'] as const;
export type DeployMode = (typeof DEPLOY_MODES)[number];

export interface VerifySettings {
  repoId: string;
  /** False when no row exists. */
  configured: boolean;
  enabled: boolean;
  baseUrl: string | null;
  deployMode: DeployMode;
  standingJourneys: StandingJourney[];
  testAccountLabel: string | null;
  eligibility: Eligibility;
  eligibilityPaths: string[];
  batchSize: number;
  batchWindowMinutes: number | null;
}

export const DEFAULT_VERIFY_SETTINGS: Omit<VerifySettings, 'repoId'> = {
  configured: false,
  enabled: false,
  baseUrl: null,
  deployMode: 'runner_command',
  standingJourneys: [],
  testAccountLabel: null,
  eligibility: 'ui_paths',
  eligibilityPaths: [],
  batchSize: 1,
  batchWindowMinutes: null,
};

interface SettingsRow {
  enabled: boolean;
  base_url: string | null;
  deploy_mode: DeployMode;
  standing_journeys: StandingJourney[];
  test_account_label: string | null;
  eligibility: Eligibility;
  eligibility_paths: string[];
  batch_size: number;
  batch_window_minutes: number | null;
}
const SETTINGS_COLUMNS = 'enabled, base_url, deploy_mode, standing_journeys, test_account_label, eligibility, eligibility_paths, batch_size, batch_window_minutes';

/** The settings of a repository on a tenant-scoped client: the defaults (off) when none were saved. */
export async function readVerifySettings(client: PoolClient, repoId: string): Promise<VerifySettings> {
  const { rows } = await client.query<SettingsRow>(`SELECT ${SETTINGS_COLUMNS} FROM verify_settings WHERE repo_id = $1`, [repoId]);
  const r = rows[0];
  if (r === undefined) return { repoId, ...DEFAULT_VERIFY_SETTINGS };
  return {
    repoId,
    configured: true,
    enabled: r.enabled,
    baseUrl: r.base_url,
    deployMode: r.deploy_mode,
    standingJourneys: r.standing_journeys,
    testAccountLabel: r.test_account_label,
    eligibility: r.eligibility,
    eligibilityPaths: r.eligibility_paths,
    batchSize: r.batch_size,
    batchWindowMinutes: r.batch_window_minutes,
  };
}

/**
 * The origin of the deployed app, or a refusal: https only, a plain lower-case host, no port, no credentials, path, query or fragment. A port is refused here because the
 * health reader (apps/web/lib/verifyHealth.ts) connects to 443 alone; saving one would only end every row `deployment_unreachable`.
 */
export function parseBaseUrl(raw: unknown): string {
  const refuse = (): never => {
    throw new VerifyInputError('verify_base_url_invalid', 'the base URL must be an https origin: a host, with no port');
  };
  if (typeof raw !== 'string' || raw.length > 300) return refuse();
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    // fx-swallow-ok: an unparseable address is the refusal itself, answered with the closed code
    return refuse();
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '' || u.pathname !== '/') return refuse();
  if (raw.trim().replace(/\/$/, '') !== u.origin) return refuse();
  if (u.port !== '' || !/^https:\/\/[a-z0-9.-]{1,253}$/.test(u.origin)) return refuse();
  return u.origin;
}

function parsePaths(raw: unknown): string[] {
  const refuse = (): never => {
    throw new VerifyInputError('verify_setting_invalid', 'eligibility paths are up to 20 relative paths of plain characters');
  };
  if (!Array.isArray(raw) || raw.length > 20) return refuse();
  for (const p of raw) if (typeof p !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(p) || p.includes('..') || p.startsWith('/')) return refuse();
  return [...new Set(raw as string[])];
}

export interface VerifySettingsPatch {
  enabled?: boolean;
  baseUrl?: string | null;
  standingJourneys?: unknown;
  testAccountLabel?: string | null;
  eligibility?: Eligibility;
  eligibilityPaths?: unknown;
}

/** The settings after a patch, checked. Pure; the same function the writer uses. */
export function applySettingsPatch(current: VerifySettings, patch: VerifySettingsPatch): VerifySettings {
  const next: VerifySettings = { ...current };
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new VerifyInputError('verify_setting_invalid', 'enabled is true or false');
    next.enabled = patch.enabled;
  }
  if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl === null ? null : parseBaseUrl(patch.baseUrl);
  if (patch.standingJourneys !== undefined) next.standingJourneys = parseStandingJourneys(patch.standingJourneys);
  if (patch.testAccountLabel !== undefined) {
    const l = patch.testAccountLabel;
    if (l !== null && (typeof l !== 'string' || l.trim().length < 1 || l.length > 100 || /[\u0000-\u001f\u007f]/.test(l))) throw new VerifyInputError('verify_setting_invalid', 'the test account label is 1 to 100 characters');
    next.testAccountLabel = l === null ? null : l.trim();
  }
  if (patch.eligibility !== undefined) {
    if (!ELIGIBILITIES.includes(patch.eligibility)) throw new VerifyInputError('verify_setting_invalid', 'unknown eligibility');
    next.eligibility = patch.eligibility;
  }
  if (patch.eligibilityPaths !== undefined) next.eligibilityPaths = parsePaths(patch.eligibilityPaths);
  if (next.enabled && next.baseUrl === null) throw new VerifyInputError('verify_base_url_required', 'a repository without a base URL cannot be switched on');
  return next;
}

/**
 * Saves a patch (an upsert). The batch columns keep their defaults: only closure by size one is built, so they are not settable yet.
 * Returns the saved settings and whether this call turned an enabled repository off (the caller ends the rows that never started; see `saveVerifySettings`).
 */
export async function writeVerifySettings(client: PoolClient, accountId: string, repoId: string, userId: string, patch: VerifySettingsPatch): Promise<{ settings: VerifySettings; turnedOff: boolean }> {
  const current = await readVerifySettings(client, repoId);
  const next = applySettingsPatch(current, patch);
  await client.query(
    `INSERT INTO verify_settings (account_id, repo_id, enabled, base_url, standing_journeys, test_account_label, eligibility, eligibility_paths, updated_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::text[], $9)
     ON CONFLICT (repo_id) DO UPDATE SET enabled = EXCLUDED.enabled, base_url = EXCLUDED.base_url, standing_journeys = EXCLUDED.standing_journeys,
       test_account_label = EXCLUDED.test_account_label, eligibility = EXCLUDED.eligibility, eligibility_paths = EXCLUDED.eligibility_paths,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    // enabled_since is not written here: the table's trigger stamps it on the off -> on move alone (migration 1005), so a save that changes nothing moves nothing.
    [accountId, repoId, next.enabled, next.baseUrl, JSON.stringify(next.standingJourneys), next.testAccountLabel, next.eligibility, next.eligibilityPaths, userId],
  );
  return { settings: { ...next, configured: true }, turnedOff: current.enabled && !next.enabled };
}

/**
 * Whether a merge that changed `changedPaths` is checked. `all`: every merge. `ui_paths`: a merge that changed a file under one of the eligibility paths (a path
 * matches a whole directory name, so `apps/web` does not match `apps/website`); with no paths configured, none. Unknown paths (null) are checked: not checking is the worse mistake.
 */
export function isEligible(settings: Pick<VerifySettings, 'eligibility' | 'eligibilityPaths'>, changedPaths: readonly string[] | null): boolean {
  if (settings.eligibility === 'all') return true;
  if (changedPaths === null) return true;
  return changedPaths.some((p) => settings.eligibilityPaths.some((prefix) => p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)));
}
