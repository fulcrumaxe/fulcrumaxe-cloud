import type { Pool } from 'pg';
import { withTenant } from '@fx/core/src/tenancy/withTenant.js';
import type { BillingCtx } from '../types.js';

export interface SiteListItem {
  id: string;
  domain: string | null;
  status: string;
  repo_full_name: string | null;
  created_at: string;
  billing: {
    setup_paid: boolean;
    sync_status: string | null;
    sync_current_period_end: string | null;
    sync_cancel_at_period_end: boolean;
  };
}

export interface SiteListCursor {
  createdAt: string;
  id: string;
}

interface Row {
  id: string;
  domain: string | null;
  status: string;
  repo_full_name: string | null;
  created_at: Date;
  created_at_cursor: string;
  setup_paid_at: Date | null;
  sync_status: string | null;
  sync_current_period_end: Date | null;
  sync_cancel_at_period_end: boolean | null;
}

/**
 * The account's sites, newest first, each with its site-kit billing state in one
 * read. The account predicate is explicit on the sites read and on both joins;
 * the row policies are the second layer. Only the columns the response carries
 * are selected, so a new column on either table can never reach a caller by default.
 */
export async function listSites(
  appPool: Pool,
  principal: BillingCtx['principal'],
  page: { limit: number; cursor?: SiteListCursor },
): Promise<{ data: SiteListItem[]; nextCursor: SiteListCursor | null }> {
  const { accountId, userId } = principal;
  return withTenant(appPool, accountId, userId, async (client) => {
    const { rows } = await client.query<Row>(
      `SELECT s.id, s.domain, s.status, s.created_at,
              to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
              CASE WHEN r.gh_owner IS NOT NULL AND r.gh_name IS NOT NULL THEN r.gh_owner || '/' || r.gh_name END AS repo_full_name,
              e.setup_paid_at, e.sync_status, e.sync_current_period_end, e.sync_cancel_at_period_end
         FROM sites s
         LEFT JOIN sitekit_entitlements e ON e.site_id = s.id AND e.account_id = s.account_id
         LEFT JOIN repos r ON r.id = s.repo_id AND r.account_id = s.account_id
        WHERE s.account_id = $1
          AND ($2::timestamptz IS NULL OR (s.created_at, s.id) < ($2::timestamptz, $3::uuid))
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT $4`,
      [accountId, page.cursor?.createdAt ?? null, page.cursor?.id ?? null, page.limit + 1],
    );
    const hasMore = rows.length > page.limit;
    const shown = hasMore ? rows.slice(0, page.limit) : rows;
    const last = shown[shown.length - 1];
    return {
      data: shown.map((row) => ({
        id: row.id,
        domain: row.domain,
        status: row.status,
        repo_full_name: row.repo_full_name,
        created_at: row.created_at.toISOString(),
        billing: {
          setup_paid: !!row.setup_paid_at,
          sync_status: row.sync_status,
          sync_current_period_end: row.sync_current_period_end?.toISOString() ?? null,
          sync_cancel_at_period_end: row.sync_cancel_at_period_end ?? false,
        },
      })),
      nextCursor: hasMore && last ? { createdAt: last.created_at_cursor, id: last.id } : null,
    };
  });
}
