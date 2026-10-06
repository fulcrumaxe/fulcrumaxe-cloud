import type { ApprovalDb, Principal, Refusal } from "./types.js";

/**
 * Owner or admin of the caller's own account, checked against the database
 * (never a role carried on the principal), and only when the transaction is
 * really running as that account and user.
 */
export async function requireAdmin(db: ApprovalDb, p: Principal): Promise<Refusal | null> {
  const s = await db.query<{ a: string | null; u: string | null }>(
    "SELECT NULLIF(current_setting('app.account_id', true), '') AS a, NULLIF(current_setting('app.user_id', true), '') AS u",
  );
  if (s.rows[0]?.a !== p.accountId || s.rows[0]?.u !== p.userId) return { code: "forbidden" };
  const r = await db.query<{ role: string }>("SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2", [
    p.accountId,
    p.userId,
  ]);
  const role = r.rows[0]?.role;
  return role === "owner" || role === "admin" ? null : { code: "forbidden" };
}
