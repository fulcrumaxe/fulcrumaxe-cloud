import { firstPrFromInstall } from '@fx/stats';
import { ForbiddenError, NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import type { RunActionCtx } from '../runActions/request.js';
import { INSTALLATION_KPI_SELECT, WORK_ITEM_KPI_SELECT, toInstallationKpiRow, toWorkItemKpiRow } from '../stats/read.js';
import { getPreview } from './preview.js';

/** D#2 H17d: the onboarding progress read. Every time comes from a server row; the caller passes nothing but its context. */

export const ONBOARDING_STEPS = ['model_key', 'readonly_app', 'preview', 'pay', 'write_app', 'first_pr'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingProgress {
  /** The account's creation time. */
  started_at: string;
  /**
   * Always the six steps, in ONBOARDING_STEPS order. `completed_at` is an ISO time, or null while the step is open.
   * `skipped` is true only for a step that is not open but was never done: today that is the free preview once the
   * plan is chosen without one. A skipped step has no time (`completed_at` stays null), so a time is never invented.
   */
  steps: { step: OnboardingStep; completed_at: string | null; skipped: boolean }[];
}

/**
 * The steps from what the account has done. Pure, so the table of states is testable without a database.
 * Only the preview can be skipped: once `pay` is done and no preview has finished, it is skipped, which stops it
 * from holding back anything after it. A preview that finished (before or after paying) keeps its real time, and
 * so does a run still in flight at the moment of paying: it reports skipped until it ends, then done.
 */
export function buildSteps(done: Record<OnboardingStep, string | null>): OnboardingProgress['steps'] {
  const skipped = (step: OnboardingStep): boolean => step === 'preview' && done.preview === null && done.pay !== null;
  return ONBOARDING_STEPS.map((step) => ({ step, completed_at: done[step], skipped: skipped(step) }));
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const earliestDate = (times: (Date | null)[]): Date | null =>
  times.filter((t): t is Date => t instanceof Date).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
const earliest = (times: (string | null)[]): string | null => {
  const set = times.filter((t): t is string => t !== null);
  return set.length === 0 ? null : set.reduce((min, t) => (Date.parse(t) < Date.parse(min) ? t : min));
};

/**
 * Where the account is in onboarding. A session member of any role may read it; a token principal is refused
 * before any SQL.
 *
 * Steps 1 and 2 are DERIVED from the current state on every read, not stamped once, so they go back to open when
 * what they stand for goes away:
 *   * `model_key` is done only while a model connection with status 'ok' exists (a removed, broken or not yet
 *     validated key leaves it open). Its time is the account's first-ok mark (0692), else that connection's last check.
 *   * `readonly_app` is done only while a live team_readonly installation exists: one whose installer record is
 *     neither deleted nor suspended (read through the 0699 definer, because app_user cannot read the record).
 *     Its time is the earliest such installation's creation.
 * The preview is skipped once `pay` is done and no preview has finished (see buildSteps); choosing a plan never
 * waits for the key, the app or the preview. The later steps stay milestones: `pay` is the write-once mark, `write_app` and `first_pr` come from the
 * installation and work-item history, and `preview` is read through getPreview, so a void preview never counts
 * and only a run that ended in success does; a failed or cancelled run leaves the step open.
 */
export async function getOnboarding(ctx: RunActionCtx): Promise<OnboardingProgress> {
  const { accountId, userId, tokenId } = ctx.principal;
  if (tokenId) throw new ForbiddenError('onboarding: a token cannot read progress');
  const now = new Date();

  const own = await withTenant(ctx.pool, accountId, userId, async (client) => {
    const account = (await client.query(`SELECT created_at, onboarding_key_ok_at, onboarding_paid_at FROM accounts WHERE id = $1`, [accountId])).rows[0];
    if (!account) throw new NotFoundError('onboarding: account not found');
    // Sequential: one connection cannot run overlapping queries.
    const installations = (await client.query(INSTALLATION_KPI_SELECT)).rows.map(toInstallationKpiRow);
    const items = (await client.query(WORK_ITEM_KPI_SELECT)).rows.map(toWorkItemKpiRow);
    const previewIds = (await client.query(`SELECT id FROM onboarding_previews WHERE state <> 'void'`)).rows.map((r) => r.id as string);
    const okKeys = (await client.query(`SELECT last_validated_at FROM model_connections WHERE status = 'ok'`)).rows;
    const live = new Set((await client.query(`SELECT installation_id FROM onboarding_live_readonly_installations()`)).rows.map((r) => r.installation_id as string));
    const readonly = (await client.query(`SELECT id, created_at FROM installations WHERE app_kind = 'team_readonly'`)).rows;
    return { account, installations, items, previewIds, okKeys, liveReadonly: readonly.filter((r) => live.has(r.id as string)).map((r) => r.created_at as Date) };
  });

  // At most two rows (one per GitHub user and per installation), each read through the preview service.
  const finishes: (string | null)[] = [];
  for (const id of own.previewIds) {
    const pv = await getPreview(ctx, id);
    // Only a run that succeeded finishes the step: a failed or cancelled run ended, but gave the user nothing to move on from.
    finishes.push(pv.run_status === 'succeeded' ? pv.finished_at : null);
  }

  const installedAt = (kind: string): string | null =>
    iso(own.installations.filter((i) => i.app_kind === kind).map((i) => i.created_at).sort((a, b) => a.getTime() - b.getTime())[0]);

  const done: Record<OnboardingStep, string | null> = {
    model_key: own.okKeys.length === 0 ? null : iso(own.account.onboarding_key_ok_at ?? earliestDate(own.okKeys.map((k) => k.last_validated_at)) ?? own.account.created_at),
    readonly_app: iso(own.liveReadonly.sort((a, b) => a.getTime() - b.getTime())[0]),
    preview: earliest(finishes),
    pay: iso(own.account.onboarding_paid_at),
    write_app: installedAt('team'),
    first_pr: firstPrFromInstall(own.items, own.installations, now).first_pr_at,
  };
  return { started_at: own.account.created_at.toISOString(), steps: buildSteps(done) };
}
