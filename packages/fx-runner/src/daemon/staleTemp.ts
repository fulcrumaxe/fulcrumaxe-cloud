/**
 * Leftovers a crashed run can leave next to the job ledger (D#6 R4a-2b, correction C26 section 2 item 6): a half-written
 * `<ledger>.<12 hex>.tmp` and a lock taken over and not removed, `<ledger>.lock.stale-<12 hex>`. Removed at start, before the
 * lock is taken, and only when the entry is a regular file (lstat, so never a link), is a direct child of the ledger's own
 * directory, matches one of those two names exactly, and is more than ten minutes old. Everything else is left alone.
 */
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

export const STALE_TEMP_AGE_MS = 10 * 60_000;

const TEMP = /^[0-9a-f]{12}\.tmp$/;
const STALE_LOCK = /^lock\.stale-[0-9a-f]{12}$/;

/** Removes the stale leftovers of the ledger at `ledgerFile` and returns how many. A directory that is not there has none. */
export function removeStaleLedgerTemp(ledgerFile: string, now: Date): number {
  const dir = path.dirname(ledgerFile);
  const prefix = `${path.basename(ledgerFile)}.`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    if (!TEMP.test(rest) && !STALE_LOCK.test(rest)) continue;
    const target = path.join(dir, name);
    try {
      const info = lstatSync(target);
      if (!info.isFile() || now.getTime() - info.mtimeMs <= STALE_TEMP_AGE_MS) continue;
      unlinkSync(target);
      removed++;
    } catch {
      // fx-swallow-ok: an entry that vanished or cannot be removed is simply left; the ledger does not depend on it
    }
  }
  return removed;
}
