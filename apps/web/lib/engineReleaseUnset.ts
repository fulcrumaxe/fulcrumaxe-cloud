import { createPool } from "@fx/db/src/pool";

/**
 * D#845 ON-8b: true when no engine release a setup could use is published (no row, or every row withdrawn). Read only for the operator's detailed health call, with the platform_ops login
 * (engine_releases is a platform table). A missing login or a failed read answers false: health must not fail because it could not look.
 */
export async function readEngineReleaseUnset(): Promise<boolean> {
  const url = process.env.DATABASE_URL_PLATFORM_OPS;
  if (!url) return false;
  const pool = createPool(url);
  try {
    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM engine_releases WHERE withdrawn_at IS NULL");
    return rows[0]?.n === 0;
  } catch {
    // fx-swallow-ok: a failed look is "not known to be unset"; the health answer stays what it was
    return false;
  } finally {
    await pool.end();
  }
}
