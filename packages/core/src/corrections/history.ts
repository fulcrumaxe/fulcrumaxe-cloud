import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { withTenant } from '../tenancy/withTenant.js';
import { listCorrections, type Correction, type CorrectionCtx } from './index.js';

/** Shown where the person who made or decided a correction is gone. Never null on screen. */
export const FORMER_MEMBER = 'a former member';
const UNNAMED_MEMBER = 'A team member';

export interface CorrectionHistoryEntry {
  correction: Correction;
  createdByName: string;
  /** Null while the correction is still proposed. */
  decidedByName: string | null;
  /** "<name> via assistant" when an assistant proposed it or an assistant's token decided it, else the name; null while proposed. Derived on every read. */
  attribution: string | null;
}

/** A work item's corrections, oldest first, with names. Derived from current rows on every read (nothing here is stored). */
export async function listCorrectionHistory(ctx: CorrectionCtx, workItemId: string): Promise<CorrectionHistoryEntry[]> {
  const items = await listCorrections(ctx, workItemId);
  if (items.length === 0) return [];
  const ids = [...new Set(items.flatMap((c) => [c.createdBy, c.decidedBy]).filter((x): x is string => x !== null))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { accountId, userId } = ctx.principal;
    await withTenant(ctx.pool, accountId, userId, async (client) => {
      await assertActiveMembership(client, accountId, userId);
      const { rows } = await client.query<{ id: string; name: string }>(
        `SELECT id, COALESCE(NULLIF(name, ''), NULLIF(github_login, ''), '${UNNAMED_MEMBER}') AS name FROM users WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      for (const r of rows) names.set(r.id, r.name);
    });
  }
  const nameOf = (id: string | null) => (id === null ? FORMER_MEMBER : (names.get(id) ?? FORMER_MEMBER));
  return items.map((c: Correction) => {
    const decidedByName = c.status === 'proposed' ? null : nameOf(c.decidedBy);
    const viaAssistant = c.origin === 'agent' || c.decidedVia === 'terminal';
    return {
      correction: c,
      createdByName: nameOf(c.createdBy),
      decidedByName,
      attribution: decidedByName === null ? null : viaAssistant ? `${decidedByName} via assistant` : decidedByName,
    };
  });
}
