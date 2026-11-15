import type { PoolClient } from 'pg';

/**
 * D#749 VERIFY-SIGNIN-EXPIRY: what the account's runners last said about their saved verify sign-in (migration 1020, `runners.verify_sign_in`), and the one decision made from it: may a
 * post-merge check start now, or does it wait for a new sign-in.
 *
 * A runner says it on its claim (protocol 18 and later) from two dates; a runner that never said (an older build, or no verify address set on it) has none and is not counted. The decision
 * only ever reads the reports: nothing a page, a model or a job wrote is read here.
 */
export type SignInReportState = 'ok' | 'expiring_soon' | 'expired' | 'missing';
export interface SignInReport {
  state: SignInReportState;
  /** When the runner said it (the cloud's clock). */
  at: Date;
}

/** The reports of the account's live runners that have said one. */
export async function readSignInReports(client: Pick<PoolClient, 'query'>, accountId: string): Promise<SignInReport[]> {
  const { rows } = await client.query<{ verify_sign_in: SignInReportState; verify_sign_in_at: Date }>(
    `SELECT verify_sign_in, verify_sign_in_at FROM runners WHERE account_id = $1 AND revoked_at IS NULL AND verify_sign_in IS NOT NULL`,
    [accountId],
  );
  return rows.map((r) => ({ state: r.verify_sign_in, at: r.verify_sign_in_at }));
}

const GOOD: ReadonlySet<SignInReportState> = new Set(['ok', 'expiring_soon']);

/**
 * Pure. `go`: a check may start (or run again). `park`: it waits.
 *  - No hold yet (a check about to start): it parks only when some runner reported a bad state and none reported a good one. No report at all (an older runner, or no address set) is `go`, as before.
 *  - A hold of this kind stands (the check is waiting): it goes once some runner reports a good state NEWER than the hold's start. An older report is the one that was true when the check was parked.
 */
export function signInGate(reports: readonly SignInReport[], hold: { since: Date } | null): 'go' | 'park' {
  if (hold === null) {
    const good = reports.some((r) => GOOD.has(r.state));
    return !good && reports.length > 0 ? 'park' : 'go';
  }
  return reports.some((r) => GOOD.has(r.state) && r.at.getTime() > hold.since.getTime()) ? 'go' : 'park';
}
