import type { Pool } from "pg";
import { STAFF_ID_HEADER, STAFF_SID_HEADER } from "./headers";
import { sessionRevoked } from "./rateLimit";
import { StaffRefusedError, withStaff } from "./withStaff";

/**
 * The staff id middleware verified from the session cookie, re-checked against the sign-out deny-list and the staff row, or null.
 * Every handler and page that needs a signed-in person calls this, so a deactivated person, or a session that was signed out,
 * gets 401 on the next request. A request with a staff id but no session id is refused: middleware always sets both.
 */
export async function requireStaff(headers: Headers, pool: Pool): Promise<{ staffId: string } | null> {
  const staffId = headers.get(STAFF_ID_HEADER);
  const sid = headers.get(STAFF_SID_HEADER);
  if (!staffId || !sid) return null;
  if (await sessionRevoked(sid, pool)) return null;
  try {
    await withStaff(pool, staffId, async () => undefined);
    return { staffId };
  } catch (err) {
    if (err instanceof StaffRefusedError) return null;
    throw err;
  }
}
