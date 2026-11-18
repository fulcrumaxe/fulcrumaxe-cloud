/**
 * EB-12c: the asks the host has already sent an answer for, kept in `engine-host-answered.json` of the engine's state directory (0600, written through a
 * temp file and a rename, read without following a link). A second `answer_ask` for the same ask is refused (`already_answered`) and never reaches the engine,
 * also after a restart. An entry is made when the answer is sent to the host, not when it is claimed: an answer that was refused or expired first leaves no entry.
 * Entries older than 7 days are dropped whenever the file is read or written, and the oldest go first when the file would grow past its cap.
 *
 * A file that is missing is an empty record. A file that exists but cannot be read safely (not JSON, not the expected shape, a link, a wrong mode or owner,
 * over the size cap, any read error) is `unknown`: the store then answers "unknown" for every ask it has no memory of, so the ticker holds the answer back
 * instead of guessing, and it never writes over a file it could not read (`mark` keeps the entry in memory only).
 */
import { readJsonNoFollow, writeJsonAtomic } from "../engineBridge/stateFiles.js";

export const ANSWERED_FILE = "engine-host-answered.json";
export const ANSWERED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** The state files are capped at 16 KiB (`stateFiles.ts`). */
const FILE_MAX_BYTES = 16 * 1024;
/** One entry as written: a 16-character ask id in quotes, a colon, a 13-digit millisecond time and a comma is 34 bytes; rounded up for headroom. */
const ENTRY_BYTES = 40;
/** 400 entries take about 13600 bytes as written and 16000 at the rounded-up size, so the file always fits with headroom. */
export const ANSWERED_MAX_ENTRIES = 400;
if (ANSWERED_MAX_ENTRIES * ENTRY_BYTES > FILE_MAX_BYTES) throw new Error("the answered-asks cap does not fit the state file cap");

export interface AnsweredStore {
  /** True when an answer for this ask was already sent, false when it was not, "unknown" when the record cannot be read. Never throws. */
  has(askId: string, now: number): boolean | "unknown";
  /** Records that an answer for this ask was sent. Never throws. A write that fails, or a record that cannot be read, leaves the entry in memory for this process only. */
  mark(askId: string, now: number): void;
}

export function openAnsweredStore(dir: string, uid: number, log?: (line: string) => void): AnsweredStore {
  const memory = new Map<string, number>();
  const say = (line: string): void => {
    try {
      log?.(line);
    } catch {
      // fx-swallow-ok: a log that cannot be written must not stop an answer from being judged
    }
  };
  function load(now: number): { all: Map<string, number>; unreadable: boolean } {
    const all = new Map<string, number>();
    let unreadable = false;
    try {
      const raw = readJsonNoFollow(dir, ANSWERED_FILE, uid);
      if (raw !== undefined) {
        const asks = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as { asks?: unknown }).asks : undefined;
        if (typeof asks !== "object" || asks === null || Array.isArray(asks)) unreadable = true;
        else {
          for (const [id, at] of Object.entries(asks)) {
            if (typeof at === "number" && Number.isFinite(at)) all.set(id, at);
            else unreadable = true;
          }
        }
      }
    } catch {
      // fx-swallow-ok: a file that cannot be read safely is "unknown", never "empty"; the ticker holds the answer back and says so in one fixed line
      unreadable = true;
    }
    for (const [id, at] of memory) all.set(id, Math.max(at, all.get(id) ?? 0));
    for (const [id, at] of all) if (now - at > ANSWERED_KEEP_MS) all.delete(id);
    return { all, unreadable };
  }
  return {
    has(askId, now) {
      const { all, unreadable } = load(now);
      if (all.has(askId)) return true;
      return unreadable ? "unknown" : false;
    },
    mark(askId, now) {
      const { all, unreadable } = load(now);
      all.set(askId, now);
      memory.set(askId, now);
      if (unreadable) {
        say("the answered-asks record could not be read; the answer is remembered until this host stops");
        return;
      }
      const sorted = [...all].sort((a, b) => b[1] - a[1]);
      const kept = sorted.slice(0, ANSWERED_MAX_ENTRIES);
      if (sorted.length > kept.length) {
        for (const [id] of sorted.slice(ANSWERED_MAX_ENTRIES)) memory.delete(id);
        say("the answered-asks record is full; its oldest entries were dropped");
      }
      try {
        writeJsonAtomic(dir, ANSWERED_FILE, { asks: Object.fromEntries(kept) }, uid);
      } catch {
        // fx-swallow-ok: the entry stays in memory for this process and misses only a restart; the failure is said in fixed words, never with the error text
        say("the answered-asks record could not be written; the answer is remembered until this host stops");
      }
    },
  };
}
