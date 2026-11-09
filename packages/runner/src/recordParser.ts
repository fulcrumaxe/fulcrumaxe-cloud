import { createHash } from "node:crypto";
import { constants } from "node:os";

/**
 * D#2 RLR-3a (run-log reader design, Round 3 B2/B4, amended by the RLR-0c spike results): reads what the in-VM recorder
 * (`FX_RECORDER_SCRIPT`) wrote. Nothing calls this yet but its tests; the read loop that does is RLR-3b/4.
 *
 * Acceptance rule: from the start of the bytes a read returned, a record is accepted only when its line is complete, ASCII,
 * ends in a check value `c` that matches the line's text before it, is valid JSON, of a known kind, has `s` exactly one past
 * the last accepted `s` and a closing `t` equal to it, and (for `o` and `tail`) `n` equals the byte length of its decoded data.
 * The first line that fails stops the parse.
 *
 * What is guaranteed, and tested over real recorder files: a read that drops or repeats ONE run of bytes (a chunk lost mid-line,
 * a duplicated chunk, a cut) yields the records written before the damage and never a different record: `c` catches damage
 * inside a line (an escape, a digit of `n`, of `bytes` or of the exit code), `s`/`t` catch a splice across two lines. `c` is a
 * 64-bit truncated hash, not a MAC, and the tests cover single damage; they do not claim to cover several separate losses in one
 * read. An attacker with the agent's uid can still rewrite unread records and re-compute `c`, or append a well-formed
 * forgery. The exit cross-check against the recorder's echo is what catches that, and a trailer proves nothing unless
 * `wait()` agrees (RLR-4); this module only gives each case a name.
 */

/** The read argument cap. It must exceed the largest record the recorder can write: 6 bytes of `\u00XX` per byte of a capped line. */
export const RECORD_READ_CAP = 8 * 1024 * 1024;
/** The record file is oversize past this (R7). */
export const RECORD_FILE_MAX_BYTES = 200 * 1024 * 1024;
/** This many reads in a row that fail at their very first record mean the file was changed under the reader. */
export const HEAD_VIOLATION_LIMIT = 3;

/**
 * The read: one fixed script, three positional arguments, no file. It prints up to `cap` bytes from `offset + 1`, then one byte
 * 0xff, `@` and the file's size taken AFTER the tail (so a growing file never looks shrunk). Records are ASCII, so 0xff cannot
 * be taken for data. A missing file leaves the size empty, which `evaluateRead` reports as a failed read (`tail | head` alone
 * exits 0 for a missing file). Cut data ends without a newline, so the cut record is a partial line, not a bad one.
 */
export const READ_SCRIPT = 'tail -c +"$1" -- "$2" 2>/dev/null | head -c "$3"; printf "\\377@%s" "$(stat -c %s -- "$2" 2>/dev/null)"';
/** The argv for one read of `recordPath` from byte `offset` (0-based) of at most `cap` bytes. */
export function readArgv(offset: number, recordPath: string, cap: number = RECORD_READ_CAP): string[] {
  return ["-c", READ_SCRIPT, "fx-read", String(offset + 1), recordPath, String(cap)];
}

const KINDS = new Set(["h", "o", "big", "tail", "x"]);

export interface Trailer {
  seq: number;
  code: number | null;
  sig: string | null;
  lines: number;
  bytes: number;
}
export interface AcceptedRecord {
  seq: number;
  kind: "h" | "o" | "big" | "tail" | "x";
  /** `o` and `tail`: the child's line, byte for byte. `big`: empty. */
  data: Buffer;
  /** The child's byte length (`o`, `tail`, `big`), else 0. */
  n: number;
  /** Bytes this record took in the file, newline included. */
  size: number;
}
export type StopReason =
  | "bad_json"
  | "bad_kind"
  | "bad_seq"
  | "bad_record"
  | "non_ascii"
  | "bad_check"
  | "length_mismatch"
  | "bad_trailer"
  | "after_trailer"
  | "header_misplaced";

export interface Accepted {
  records: AcceptedRecord[];
  /** The run id from the header record, when this parse accepted the header (it starts at seq 0); else null. The caller compares it with the run it expects. */
  run: string | null;
  /** Bytes consumed by the accepted records: the offset advance. */
  bytes: number;
  /** null: every complete line was accepted (a partial last line is not a stop). */
  stop: StopReason | null;
  trailer: Trailer | null;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function trailerOf(r: Record<string, unknown>, seq: number): Trailer | null {
  const { code, sig, lines, bytes } = r;
  if (!(code === null || (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255))) return null;
  if (!(sig === null || (typeof sig === "string" && /^SIG[A-Z0-9]{1,12}$/.test(sig)))) return null;
  if (!isCount(lines) || !isCount(bytes) || lines !== seq - 1) return null;
  return { seq, code, sig, lines, bytes };
}

const CHECK_SUFFIX_LEN = 24; // ,"c":"<16 hex>"}
const CHECK_SUFFIX = /^,"c":"([0-9a-f]{16})"\}$/;
/** True when the line ends in `,"c":"<hex>"}` and the hex is the first 16 digits of the sha256 of everything before that suffix. */
function checkMatches(text: string): boolean {
  if (text.length <= CHECK_SUFFIX_LEN) return false;
  const m = CHECK_SUFFIX.exec(text.slice(-CHECK_SUFFIX_LEN));
  return m !== null && createHash("sha256").update(text.slice(0, -CHECK_SUFFIX_LEN), "latin1").digest("hex").slice(0, 16) === m[1];
}

/** The line's JSON, or undefined when it is not JSON (the caller turns that into the `bad_json` stop). */
function parseLine(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // fx-swallow-ok: a line that is not JSON is the violation itself, reported by the caller as `stop`
    return undefined;
  }
}

/** The B2 rule. `nextSeq` is the seq the first record must carry (0 for the header). */
export function acceptRecords(buf: Buffer, nextSeq: number): Accepted {
  const records: AcceptedRecord[] = [];
  let pos = 0;
  let expect = nextSeq;
  let stop: StopReason | null = null;
  let trailer: Trailer | null = null;
  let run: string | null = null;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    if (trailer) { stop = "after_trailer"; break; }
    const line = buf.subarray(pos, nl);
    if (line.some((b) => b >= 0x80)) { stop = "non_ascii"; break; }
    const text = line.toString("latin1");
    if (!checkMatches(text)) { stop = "bad_check"; break; }
    const r = parseLine(text);
    if (!r || typeof r !== "object" || Array.isArray(r)) { stop = "bad_json"; break; }
    const o = r as Record<string, unknown>;
    if (typeof o.k !== "string" || !KINDS.has(o.k)) { stop = "bad_kind"; break; }
    if (o.s !== expect) { stop = "bad_seq"; break; }
    if (o.t !== o.s) { stop = "bad_record"; break; } // the closing copy of the seq: a head and a tail from different records cannot agree
    const kind = o.k as AcceptedRecord["kind"];
    if ((kind === "h") !== (expect === 0)) { stop = "header_misplaced"; break; }
    let data: Buffer = Buffer.alloc(0);
    let n = 0;
    if (kind === "o" || kind === "tail") {
      if (typeof o.d !== "string" || (o.e !== undefined && o.e !== "b64")) { stop = "bad_record"; break; }
      data = o.e === "b64" ? Buffer.from(o.d, "base64") : Buffer.from(o.d, "utf8");
      if (!isCount(o.n) || o.n !== data.length) { stop = "length_mismatch"; break; }
      n = o.n;
    } else if (kind === "big") {
      if (!isCount(o.n) || o.d !== undefined) { stop = "bad_record"; break; }
      n = o.n;
    } else if (kind === "x") {
      trailer = trailerOf(o, expect);
      if (!trailer) { stop = "bad_trailer"; break; }
    } else if (typeof o.run !== "string" || o.v !== 1) { stop = "bad_record"; break; }
    else run = o.run;
    records.push({ seq: expect, kind, data, n, size: nl + 1 - pos });
    pos = nl + 1;
    expect++;
  }
  return { records, run, bytes: pos, stop, trailer };
}

/** A read that did not run, or whose result says the file is not as the reader left it. */
export type ReadFault =
  | "read_failed" //             no size came back (the file is missing or the read did not run), or the file is longer than the offset yet returned nothing: a failed read, never an idle agent
  | "file_truncated" //          the file is shorter than the committed offset, or than what this very read returned
  | "log_oversize" //            the file passed RECORD_FILE_MAX_BYTES
  | "read_exceeds_cap" //        more data came back than the cap allows: the read script cannot do that, so it was replaced
  | "record_exceeds_read_cap"; // a full read cap with no newline and no record: the recorder never writes one, so it is not the recorder

export interface ReadOutcome extends Accepted {
  /** The file size taken after the read, or null when the read failed. */
  size: number | null;
  /** Set when the read itself is faulty; `records` is then empty. `file_truncated`, `log_oversize`, `read_exceeds_cap` and `record_exceeds_read_cap` fail the run at once. */
  fault: ReadFault | null;
  /** A violation at the first record of the read. It can only come from a rewrite, a truncation or a forged duplicate; it is never "re-request". */
  headViolation: boolean;
}

function splitSize(out: Buffer): { data: Buffer; size: number } | null {
  const at = out.lastIndexOf(0xff);
  if (at < 0) return null;
  const tail = out.subarray(at + 1).toString("latin1");
  const m = /^@(\d{1,15})$/.exec(tail);
  return m ? { data: out.subarray(0, at), size: Number(m[1]) } : null;
}

const empty = (): Accepted => ({ records: [], run: null, bytes: 0, stop: null, trailer: null });

/** Judge one read's stdout (the output of `readArgv`). `offset` is the committed byte offset, `nextSeq` the seq the next record must carry. */
export function evaluateRead(out: Buffer, p: { offset: number; nextSeq: number; cap?: number }): ReadOutcome {
  const cap = p.cap ?? RECORD_READ_CAP;
  const fault = (f: ReadFault, size: number | null): ReadOutcome => ({ ...empty(), size, fault: f, headViolation: false });
  const split = splitSize(out);
  if (!split) return fault("read_failed", null);
  const { data, size } = split;
  if (data.length > cap) return fault("read_exceeds_cap", size); // bounds the parser's memory whatever the caller does
  if (size < p.offset || p.offset + data.length > size) return fault("file_truncated", size);
  if (size > RECORD_FILE_MAX_BYTES) return fault("log_oversize", size);
  const acc = acceptRecords(data, p.nextSeq);
  // File bigger than the offset yet nothing came back: the read did not do its job (or the file grew in the instant between tail and stat; three in a row is not that).
  if (data.length === 0 && size > p.offset) return fault("read_failed", size);
  if (acc.records.length === 0 && acc.stop === null && data.length >= cap && data.indexOf(0x0a) < 0) return fault("record_exceeds_read_cap", size);
  return { ...acc, size, fault: null, headViolation: acc.stop !== null && acc.records.length === 0 };
}

/** The consecutive-head-violation count after `o`: a head violation adds one, a fault leaves it, anything else resets it. */
export function nextHeadStreak(prev: number, o: ReadOutcome): number {
  if (o.headViolation) return prev + 1;
  return o.fault ? prev : 0;
}
/** True when the streak says the file was tampered with (flag `record_file_tampered`, then kill). */
export const isTampered = (streak: number, o?: ReadOutcome): boolean => streak >= HEAD_VIOLATION_LIMIT || o?.fault === "file_truncated";

/** The exit code a trailer stands for: the recorder exits with the child's code, or 128 plus the signal number. */
export function trailerExitCode(t: Trailer): number {
  return t.code !== null ? t.code : t.sig ? 128 + (constants.signals[t.sig as keyof typeof constants.signals] ?? 1) : 1;
}
/**
 * True when an accepted trailer's exit code equals `wait()`'s. `lines == last seq` is already enforced by `acceptRecords`.
 * A forged trailer can copy both numbers, so this means something only inside the exit sequence (RLR-4): `wait()` must
 * resolve within seconds of the trailer appearing, and the echo cross-check must agree.
 */
export const trailerMatchesWait = (t: Trailer, waitExitCode: number): boolean => trailerExitCode(t) === waitExitCode;
