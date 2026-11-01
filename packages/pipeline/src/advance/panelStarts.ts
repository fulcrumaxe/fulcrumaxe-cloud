import { attemptKey } from "./attemptKeys.js";
import type { AdvanceRunPorts } from "./runPorts.js";

/**
 * D#483 S5-k1e: the panel's seats under a spending limit, and what they share with the other waiting starts: the run key of each attempt and the same key shape as
 * a SQL pattern, so the sweep that resumes a parked panel counts exactly the runs the panel's seats made.
 *
 * A seat's first key is the one it always had, `panel:<discussion>[:g<n>]:r<round>:<role>`. A seat a limit denied left a keyed `refused_spend` run that a replay of the
 * same key would find again, so its next ask is a NEW attempt: `panel:<discussion>[:g<n>]:s<n>:r<round>:<role>` (the attempt goes before the round and the role, because
 * the key ends with the seat). The attempt is chosen PER SEAT from the rows themselves, never from a counter the caller holds: the seats that posted keep the key they
 * have (a replay follows their finished runs and starts nothing), and only a seat whose latest run was refused by a limit gets the next key. That also keeps the Spec
 * step, which enters the panel again, on the keys that really ran.
 */

/** The end of every seat's key: the round and the role. */
export const seatTail = (round: number, role: string): string => `:r${round}:${role}`;

/** The key of one attempt of a seat: attempt 0 is the key as built, `<head>:s<n>` plus the tail after that. A key that does not end in the seat's tail is returned as it was. */
export function seatStep(baseKey: string, round: number, role: string, attempt: number): string {
  const tail = seatTail(round, role);
  return baseKey.endsWith(tail) ? `${attemptKey(baseKey.slice(0, -tail.length), attempt)}${tail}` : baseKey;
}

/** Whether the seat's next ask starts a run (none exists, or the latest was refused by a limit), and the key that ask uses. */
export async function nextSeatStep(ports: Pick<AdvanceRunPorts, "startedAttempts">, baseKey: string, round: number, role: string): Promise<{ step: string; fresh: boolean }> {
  const tail = seatTail(round, role);
  if (ports.startedAttempts === undefined || !baseKey.endsWith(tail)) return { step: baseKey, fresh: true };
  const rows = await ports.startedAttempts(baseKey.slice(0, -tail.length), tail);
  if (rows.length === 0) return { step: baseKey, fresh: true };
  const top = Math.max(...rows.map((r) => r.attempt));
  const latest = rows.filter((r) => r.attempt === top).at(-1)!;
  return latest.status === "refused_spend" ? { step: seatStep(baseKey, round, role, top + 1), fresh: true } : { step: seatStep(baseKey, round, role, top), fresh: false };
}

/** Characters that mean something in a LIKE pattern, escaped with a backslash (the pattern is used with ESCAPE '\'). */
const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The SQL LIKE pattern (`ESCAPE '\'`) of the idempotency keys of every panel seat run of one item (any generation, round, role or attempt). */
export const panelKeyLikes = (workItemId: string): string[] => [`advance:${likeEscape(workItemId)}:panel:%`];

const SEAT_ATTEMPT = /:s(\d{1,6}):r[12]:[a-z][a-z-]*(?::p\d{1,6})?$/;

/** The attempt a seat's key is: 0 for the key as first built, n for `...:s<n>:r<round>:<role>` (a placement generation after the role is read through). */
export function seatAttemptOfKey(key: string): number {
  const m = SEAT_ATTEMPT.exec(key);
  return m ? Number(m[1]) : 0;
}

/** The attempt a restart of the panel begins at: one more than the highest attempt among the seats' keys (0 when there are none). */
export const nextPanelAttempt = (keys: readonly string[]): number => (keys.length === 0 ? 0 : Math.max(...keys.map(seatAttemptOfKey)) + 1);
