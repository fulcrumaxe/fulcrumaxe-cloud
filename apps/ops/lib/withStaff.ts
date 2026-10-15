import type { Pool, PoolClient } from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The staff id does not name an active staff member (or is not an id at all). */
export class StaffRefusedError extends Error {
  static readonly fixedMessage = "no active staff member for this session";
  constructor() {
    super(StaffRefusedError.fixedMessage);
  }
}

/**
 * Runs `fn` in one transaction on the ops_console pool with `app.staff_id` set for that transaction only (the SET LOCAL
 * form), after `ops_current_staff()` has confirmed the staff member exists and is active. So every use re-checks the staff
 * row: deactivating a person ends their next request. This is the only module in apps/ops that opens a transaction.
 */
export async function withStaff<T>(pool: Pool, staffId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!UUID.test(staffId)) throw new StaffRefusedError();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.staff_id', $1, true)", [staffId]);
      try {
        await client.query("SELECT ops_current_staff()");
      } catch (err) {
        if ((err as { code?: unknown }).code === "42501") throw new StaffRefusedError();
        throw err;
      }
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}
