import type { Pool } from 'pg';
import { classifyAuthor, type RepoPermission } from '@fx/trust';
import { withTenant } from '../tenancy/withTenant.js';
import { isEffectivelyInternal, readProvenanceChain, reachesRoot, type ProvenanceChainItem } from '../work-items/provenanceChain.js';

/**
 * D#31 API-6b-3: the H07 `untrusted_author` re-gate for retry.
 *
 * A retry spends the customer's money on text an outside author wrote, so it
 * is re-checked against the author's LIVE repository permission (D#31
 * criterion 7: "live permission, no override"). Nothing is stored at intake
 * and reused: README rule 2 of @fx/trust says permission is re-resolved on
 * every event.
 */

/**
 * Criterion 7 reads "has lost write permission": an external item stays
 * retryable while its author still holds write, maintain or admin (or is
 * allowlisted). That is `classifyAuthor` with `allowWritePermission` fixed on.
 * The stricter intake rule (admin/maintain only) is a one-constant change.
 */
export const RETRY_AUTHOR_WRITE_FLOOR = true;

export interface IssueAuthorRequest {
  repoId: string;
  owner: string;
  name: string;
  number: number;
  /** Aborted when the check's overall deadline passes; a lookup should stop its GitHub calls. */
  signal?: AbortSignal;
}

/** `missing`: the issue does not exist (a definite answer). `found`: its author's login and live permission. */
export type IssueAuthorResult = { status: 'missing' } | { status: 'found'; login: string; permission: RepoPermission };

/**
 * The injected GitHub read. It must THROW on anything that is not a definite
 * answer (5xx, 429, network error, timeout, token mint failure); `checkRetryAuthor`
 * turns a throw into `unavailable`, never into `trusted`.
 */
export type IssueAuthorLookup = (request: IssueAuthorRequest) => Promise<IssueAuthorResult>;

export type RetryAuthorVerdict = 'trusted' | 'untrusted' | 'unavailable';

/** What a registration point hands the check: the GitHub lookup and the allowlist, or null when no check can be built. */
export type AuthorCheckProvider = () => { lookup: IssueAuthorLookup; allowlist: readonly string[] } | null;

/**
 * More external items than this in one chain is `unavailable`, with no GitHub call: a crafted chain
 * must not cost more than 3 x (token mint + 2 reads) requests. A real chain has one external item
 * (an adopted outside issue at its root), so 3 leaves room without opening the door.
 */
export const MAX_AUTHOR_CHECK_ITEMS = 3;

/**
 * The whole check (from its entry) gets this long. The /api/v1 catch-all stops at 30 s and a worker
 * claim lease lasts 60 s, so 20 s leaves room for the rest of the request. Past it: `unavailable`.
 */
export const AUTHOR_CHECK_DEADLINE_MS = 20_000;

export interface CheckRetryAuthorInput {
  /** app_user pool: the chain is read through `withTenant` on it. */
  pool: Pool;
  accountId: string;
  userId: string;
  workItemId: string;
  /** Null when no check is registered; an external chain is then `unavailable`. */
  lookup: IssueAuthorLookup | null;
  /** Logins trusted whatever their permission. Compared case-insensitively. */
  allowlist: readonly string[];
}

/** An external item whose author cannot be looked up: no repo coordinates, or a kind v1 does not fetch. */
function isUncheckable(item: ProvenanceChainItem): boolean {
  return item.kind === 'discussion' || item.repoId === null || item.ghOwner === null || item.ghName === null || item.ghNumber === null;
}

export async function checkRetryAuthor(input: CheckRetryAuthorInput): Promise<RetryAuthorVerdict> {
  const startedAt = Date.now();
  // The chain is read in a short tenant transaction that COMMITS before any GitHub call.
  const chain = await withTenant(input.pool, input.accountId, input.userId, (client) => readProvenanceChain(client, input.workItemId));
  if (isEffectivelyInternal(chain)) return 'trusted';
  if (!input.lookup) return 'unavailable';

  const external = chain.filter((i) => i.provenance !== 'internal');
  // A broken chain (no root, a cycle) has an ancestor we cannot see: fail closed even when no row in it is external.
  if (!reachesRoot(chain) || external.length === 0 || external.some(isUncheckable)) return 'untrusted';
  // The cap comes after the definite answers above (they cost no call) and before any lookup.
  if (external.length > MAX_AUTHOR_CHECK_ITEMS) return 'unavailable';

  const lookup = input.lookup;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('deadline');
    }, Math.max(0, AUTHOR_CHECK_DEADLINE_MS - (Date.now() - startedAt)));
  });
  try {
    for (const item of external) {
      let found: IssueAuthorResult | 'deadline';
      try {
        const request = { repoId: item.repoId!, owner: item.ghOwner!, name: item.ghName!, number: item.ghNumber!, signal: controller.signal };
        // A lookup that ignores the signal still loses the race.
        const pending = lookup(request);
        pending.catch(() => {});
        found = await Promise.race([pending, deadline]);
      } catch {
        return 'unavailable';
      }
      if (found === 'deadline') return 'unavailable';
      if (found.status !== 'found') return 'untrusted';
      const verdict = classifyAuthor({
        login: found.login,
        repoPermission: found.permission,
        allowlist: input.allowlist,
        allowWritePermission: RETRY_AUTHOR_WRITE_FLOOR,
      });
      if (verdict !== 'trusted') return 'untrusted';
    }
    return 'trusted';
  } finally {
    clearTimeout(timer);
  }
}
