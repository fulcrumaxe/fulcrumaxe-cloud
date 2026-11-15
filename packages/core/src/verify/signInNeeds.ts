import type { PoolClient } from 'pg';

/**
 * D#749 VERIFY-SIGNIN-EXPIRY: the repositories whose post-merge check needs a person to sign the checking account in again on a runner, for the Needs you list. Derived on every read from what is
 * stored (`runners.verify_sign_in` and the rows parked with `needs_sign_in`), never stamped: it leaves the list by itself when a runner reports a good sign-in and the parked rows run again.
 *
 * One entry per repository that has verification on and an address (`verify_settings.base_url`), in the most pressing kind it is in:
 *  - `waiting`: a check of the repository is parked for a new sign-in (`since`: the oldest park);
 *  - `expired` or `missing`: no runner of the account reports a good sign-in and some report this;
 *  - `expiring_soon`: no runner reports `ok`, and some report that under two hours are left.
 * A runner that never reported (an older build, or no verify address set on it) is not counted. Nothing from a page, a model or a runner but the closed state word is read.
 */
export const SIGN_IN_NEED_KINDS = ['waiting', 'expired', 'missing', 'expiring_soon'] as const;
export type SignInNeedKind = (typeof SIGN_IN_NEED_KINDS)[number];
export interface SignInNeed {
  repoId: string;
  /** `owner/name` of the repository, or null when it has none on record. */
  repo: string | null;
  baseUrl: string;
  kind: SignInNeedKind;
  since: Date | null;
}

export const MAX_SIGN_IN_NEEDS = 50;

/** The same shape the `verify_settings_base_url_check` constraint enforces. Checked again here so a value that got past the constraint (a restored dump, a changed constraint) can never reach the command line the card shows. */
const SIGN_IN_BASE_URL = /^https:\/\/[a-z0-9.-]{1,253}(:[0-9]{1,5})?$/;
export const isSignInBaseUrl = (v: unknown): v is string => typeof v === 'string' && SIGN_IN_BASE_URL.test(v);

export async function readSignInNeeds(client: Pick<PoolClient, 'query'>, accountId: string): Promise<SignInNeed[]> {
  const states = (await client.query<{ s: string }>(`SELECT DISTINCT verify_sign_in AS s FROM runners WHERE account_id = $1 AND revoked_at IS NULL AND verify_sign_in IS NOT NULL`, [accountId])).rows.map((r) => r.s);
  const { rows } = await client.query<{ repo_id: string; gh_owner: string | null; gh_name: string | null; base_url: string; parked_since: Date | null }>(
    `SELECT s.repo_id, r.gh_owner, r.gh_name, s.base_url,
            (SELECT min(v.hold_since) FROM verify_rows v WHERE v.account_id = s.account_id AND v.repo_id = s.repo_id AND v.status = 'pending' AND v.hold_reason = 'needs_sign_in') AS parked_since
       FROM verify_settings s JOIN repos r ON r.id = s.repo_id AND r.account_id = s.account_id
      WHERE s.account_id = $1 AND s.enabled AND s.base_url IS NOT NULL
      ORDER BY r.gh_owner, r.gh_name, s.repo_id LIMIT $2::int`,
    [accountId, MAX_SIGN_IN_NEEDS],
  );
  const runnerKind: SignInNeedKind | null = states.includes('ok')
    ? null
    : states.includes('expired')
      ? 'expired'
      : states.includes('missing')
        ? 'missing'
        : states.includes('expiring_soon')
          ? 'expiring_soon'
          : null;
  const out: SignInNeed[] = [];
  for (const r of rows) {
    const kind: SignInNeedKind | null = r.parked_since !== null ? 'waiting' : runnerKind;
    if (kind === null || !isSignInBaseUrl(r.base_url)) continue;
    out.push({ repoId: r.repo_id, repo: r.gh_owner && r.gh_name ? `${r.gh_owner}/${r.gh_name}` : null, baseUrl: r.base_url, kind, since: r.parked_since });
  }
  return out;
}

/** The one command the card shows. The address is the repository's configured one; `readSignInNeeds` drops any that is not the constraint's shape, so nothing else can reach this line. */
export const signInCommand = (baseUrl: string): string => `fx-runner verify-login --base-url ${baseUrl}`;
