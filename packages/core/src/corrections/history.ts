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
  /**
   * Names the decider and says whether the assistant proposed it; null while proposed. `superseded` reads
   * "replaced by a later correction" with no name. For origin `person`, "via assistant" appears only when
   * `decidedVia` is `'terminal'`; for origin `agent`, `decidedVia` is ignored and the string instead leads with
   * "assistant proposed, ...". Derived on every read.
   */
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
    return {
      correction: c,
      createdByName: nameOf(c.createdBy),
      decidedByName,
      attribution: decidedByName === null ? null : attributionOf(c.status, c.origin, c.decidedVia, decidedByName),
    };
  });
}

function attributionOf(
  status: Correction['status'],
  origin: Correction['origin'],
  decidedVia: Correction['decidedVia'],
  decidedByName: string,
): string {
  if (status === 'superseded') return 'replaced by a later correction';
  const decision = status === 'rejected' ? 'rejected' : 'accepted';
  if (origin === 'agent') return `assistant proposed, ${decidedByName} ${decision}`;
  const viaAssistant = decidedVia === 'terminal';
  return viaAssistant ? `${decidedByName} ${decision} via assistant` : `${decidedByName} ${decision}`;
}
