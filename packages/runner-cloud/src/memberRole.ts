import type { PoolClient } from "pg";
import { RunnerHttpError } from "./http.js";

/** Shown where a member has no name on record. Never an email, an id or the word null. */
export const UNNAMED_MEMBER = "A team member";

/**
 * The caller's role in the account, read inside their tenant context. A session route is for a member: the session already names an
 * account the user belongs to, and this keeps the read closed even if a caller ever pairs a user with an account they are not in (403).
 */
export async function requireMemberRole(client: PoolClient): Promise<"owner" | "admin" | "member"> {
  const role = (await client.query<{ role: string | null }>("SELECT current_member_role() AS role")).rows[0]?.role;
  if (role !== "owner" && role !== "admin" && role !== "member") throw new RunnerHttpError(403, "forbidden", "you are not a member of this account");
  return role;
}
