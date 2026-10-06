import { ATTESTABLE_KINDS } from "../../../sitekit-claims/src/index.js";
import { requireAdmin } from "./access.js";
import { refuse, type ApprovalDb, type Outcome, type Principal } from "./types.js";

interface VersionRow {
  site_id: string;
  approved_by: string | null;
  approved_at: unknown;
}

async function openVersion(db: ApprovalDb, p: Principal, versionId: string): Promise<VersionRow | null> {
  const r = await db.query<VersionRow>(
    "SELECT site_id, approved_by, approved_at FROM site_versions WHERE id = $1 AND account_id = $2",
    [versionId, p.accountId],
  );
  return r.rows[0] ?? null;
}

/**
 * Criterion 1's explicit attest. Owner or admin only; the claim and the
 * version must both belong to the caller's account and to the same site;
 * only legal, pricing and security claims can be attested; an approved
 * version takes no more attestations. One row per (claim, version).
 */
export async function attest(
  db: ApprovalDb,
  p: Principal,
  claimId: string,
  versionId: string,
): Promise<Outcome<{ created: boolean }>> {
  const denied = await requireAdmin(db, p);
  if (denied) return refuse(denied);
  const v = await openVersion(db, p, versionId);
  const c = await db.query<{ site_id: string; kind: string }>(
    "SELECT site_id, kind FROM claims WHERE id = $1 AND account_id = $2",
    [claimId, p.accountId],
  );
  const claim = c.rows[0];
  if (!v || !claim) return refuse({ code: "not_found" });
  if (claim.site_id !== v.site_id) return refuse({ code: "claim_not_in_site" });
  if (v.approved_by !== null || v.approved_at !== null) return refuse({ code: "already_approved" });
  if (!ATTESTABLE_KINDS.includes(claim.kind as (typeof ATTESTABLE_KINDS)[number])) {
    return refuse({ code: "not_attestable", kind: claim.kind });
  }
  const ins = await db.query(
    "INSERT INTO attestations (account_id, claim_id, version_id, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT (claim_id, version_id) DO NOTHING",
    [p.accountId, claimId, versionId, p.userId],
  );
  return { ok: true, created: ins.rowCount === 1 };
}

/**
 * Carry-forward: a claim counts as attested for a new version only when its
 * source_hash is unchanged since an attestation given on an EARLIER version
 * of the SAME site (attestations.source_hash is stamped by the database at
 * insert time). Each carried claim gets its own new attestations row bound
 * to this version, so a row from another version never satisfies
 * assertRenderable. The claim's embedded text, kind and locale must also be
 * identical in both versions (compared in the query as jsonb), because the
 * tenant can write claims.source_hash; a claim missing from either version's
 * content never carries. "Earlier" is by created_at, which the tenant sets,
 * so ordering is defence in depth and not relied on. The row is written as the calling owner/admin, because
 * the attestations policy pins user_id to the session user: carrying a claim
 * forward is that person's explicit act. A claim with no source_hash is
 * never carried. Returns the claim ids carried.
 */
export async function carryForward(
  db: ApprovalDb,
  p: Principal,
  versionId: string,
): Promise<Outcome<{ carried: string[] }>> {
  const denied = await requireAdmin(db, p);
  if (denied) return refuse(denied);
  const v = await openVersion(db, p, versionId);
  if (!v) return refuse({ code: "not_found" });
  if (v.approved_by !== null || v.approved_at !== null) return refuse({ code: "already_approved" });
  const r = await db.query<{ claim_id: string }>(
    `INSERT INTO attestations (account_id, claim_id, version_id, user_id)
     SELECT c.account_id, c.id, $1, $3 FROM claims c
      CROSS JOIN (SELECT content FROM site_versions WHERE id = $1 AND account_id = $2) nv
      WHERE c.account_id = $2 AND c.site_id = $4 AND c.kind = ANY($5) AND c.source_hash IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM attestations a
            JOIN site_versions pv ON pv.account_id = a.account_id AND pv.id = a.version_id
           WHERE a.claim_id = c.id AND a.account_id = c.account_id AND a.source_hash = c.source_hash
             AND pv.site_id = c.site_id AND pv.id <> $1
             AND pv.created_at < (SELECT created_at FROM site_versions WHERE id = $1)
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(pv.content->'claims') = 'array' THEN pv.content->'claims' ELSE '[]'::jsonb END) o,
                      jsonb_array_elements(CASE WHEN jsonb_typeof(nv.content->'claims') = 'array' THEN nv.content->'claims' ELSE '[]'::jsonb END) n
                WHERE o->>'id' = c.claim_key AND n->>'id' = c.claim_key AND o->>'locale' = c.locale
                  AND o->'text' IS NOT NULL AND o->'kind' IS NOT NULL AND o->'locale' IS NOT NULL
                  AND o->'text' = n->'text' AND o->'kind' = n->'kind' AND o->'locale' = n->'locale'))
     ON CONFLICT (claim_id, version_id) DO NOTHING
     RETURNING claim_id`,
    [versionId, p.accountId, p.userId, v.site_id, [...ATTESTABLE_KINDS]],
  );
  return { ok: true, carried: r.rows.map((x) => x.claim_id) };
}
