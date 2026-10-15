import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { MEMORY_SLOT_DEFAULT_BYTES, parseMemorySlotBytes } from "./assemblePrompt.js";

/**
 * D#600 CX-2: a repository's memory slot size (migration 0796). The row IS the setting; no row means the default, so a reset is a delete
 * and nothing about the default is ever stored. Reading is the account's own RLS-scoped select; writing is the one definer function, which
 * re-derives the caller's role and refuses a size outside 1024..8192 with `invalid_message`.
 */

/** The slot size for a repository: its setting, or the default. */
export async function readMemorySlotBytes(pool: Pool, accountId: string, repoId: string): Promise<number> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ memory_slot_bytes: number }>("SELECT memory_slot_bytes FROM repo_context_settings WHERE account_id = $1 AND repo_id = $2", [accountId, repoId]);
    return rows[0] === undefined ? MEMORY_SLOT_DEFAULT_BYTES : Number(rows[0].memory_slot_bytes);
  });
}

/** Sets the slot size for a repository, or resets it to the default (`null`). Throws `InvalidMessageError` for a size out of range, before the database is asked. */
export async function setMemorySlotBytes(pool: Pool, who: { accountId: string; userId: string }, repoId: string, bytes: number | null): Promise<void> {
  const value = bytes === null ? null : parseMemorySlotBytes(bytes);
  await withTenant(pool, who.accountId, who.userId, async (client) => {
    await client.query("SELECT repo_context_settings_apply($1::uuid, $2::int)", [repoId, value]);
  });
}
