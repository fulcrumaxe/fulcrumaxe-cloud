import type { PoolClient } from 'pg';
import { PRODUCT_LABEL } from '@fx/core/src/plan/ownerProcess.js';

/** D#483: the `fulcrumaxe:product` label on an issue, as a webhook sees it. The sender's real permission (read from GitHub) decides, never the payload's words. */
export interface ProductLabelDelivery {
  action: 'labeled' | 'unlabeled';
  ghNumber: number;
  /** The sender's login (the permission lookup validates its shape); the permission is read for this login and nobody else. */
  senderLogin: string;
}

/** The label names of an issue payload's `labels` array, or null when it is not one (fail closed). */
function labelNamesOf(labels: unknown): string[] | null {
  if (!Array.isArray(labels)) return null;
  const out: string[] = [];
  for (const l of labels) {
    const name = typeof l === 'string' ? l : l !== null && typeof l === 'object' ? (l as { name?: unknown }).name : undefined;
    if (typeof name === 'string') out.push(name);
  }
  return out;
}

/**
 * An `issues.labeled` delivery for exactly the product label on an OPEN issue, or an `issues.unlabeled` one (a pull request is not an issue). The issue's own `labels` must agree with the action: present for `labeled`, absent for `unlabeled`.
 * Any other label, action, event or shape gives null, so such a delivery costs no permission read.
 */
export function productLabelDelivery(eventName: string, payload: unknown): ProductLabelDelivery | null {
  if (eventName !== 'issues' || payload === null || typeof payload !== 'object') return null;
  const p = payload as { action?: unknown; label?: { name?: unknown } | null; sender?: { login?: unknown } | null; issue?: { number?: unknown; state?: unknown; pull_request?: unknown; labels?: unknown } | null };
  if (p.action !== 'labeled' && p.action !== 'unlabeled') return null;
  if (p.label?.name !== PRODUCT_LABEL) return null;
  const issue = p.issue;
  if (!issue || typeof issue !== 'object' || issue.pull_request != null) return null;
  const n = issue.number;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > 2147483647) return null;
  if (p.action === 'labeled' && issue.state !== 'open') return null;
  // GitHub sends the issue's labels as they are when the delivery is made. A `labeled` that arrives (or is re-delivered) after the label was removed, or an
  // `unlabeled` after it was put back, describes a state that is gone: it must not move an owner. A payload that does not say is not trusted.
  const present = labelNamesOf(issue.labels);
  if (present === null || present.includes(PRODUCT_LABEL) !== (p.action === 'labeled')) return null;
  const login = p.sender?.login;
  if (typeof login !== 'string' || login.length === 0 || login.length > 100) return null;
  return { action: p.action, ghNumber: n, senderLogin: login };
}

/** True when the label should bring the issue in: the repository is attached and no work item or proposal has the number. The opened path's "older than the repository row" refusal is not applied (an explicit hand-over). */
export async function labelNeedsIntake(client: PoolClient, accountId: string, repoId: string, ghNumber: number): Promise<boolean> {
  const { rows } = await client.query<{ needs: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM repos WHERE id = $2 AND installation_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM work_items WHERE account_id = $1 AND repo_id = $2 AND gh_number = $3)
        AND NOT EXISTS (SELECT 1 FROM proposals WHERE repo_id = $2 AND dedupe_key = $4) AS needs`,
    [accountId, repoId, ghNumber, `gh:issue:${ghNumber}`],
  );
  return rows[0]?.needs === true;
}
