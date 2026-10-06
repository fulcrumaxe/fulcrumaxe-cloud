import type { ParsedRefUpdates } from "./types.js";

/**
 * Parse the ref-update commands out of a `git-receive-pack` request body.
 *
 * The body is git's pkt-line framed smart-HTTP payload: each line is a
 * 4-hex-digit length prefix (including itself) followed by that many bytes,
 * and a `0000` flush-pkt ends the ref-update section (the pack data, which
 * we never touch, follows). Each ref-update line looks like:
 *
 *   "<old-sha> <new-sha> <ref-name>\0<capabilities...>\n"
 *
 * on the first line, and without the capabilities list on subsequent
 * lines. We only need `old`, `new` and `ref`, so anything after a NUL is
 * discarded and a trailing newline is trimmed.
 *
 * A client pushing from a shallow clone prefixes the ref-update lines with
 * one `shallow <sha>` line per shallow boundary commit (same pkt-line
 * framing, no capabilities suffix). These are informational, not ref
 * updates — recognized and skipped, never pushed onto `updates` and never
 * treated as a malformed line.
 *
 * Pure and synchronous: no network, no filesystem. Returns `complete: false`
 * (rather than throwing) the instant anything is malformed or the section
 * never reaches a flush-pkt — a bad length, an oversized length, a line that
 * is neither a well-formed `shallow <sha>` line nor exactly 3
 * space-separated fields, or running out of bytes first. Parsing stops
 * immediately at that point: it does NOT skip the bad line and keep going,
 * because a caller that only sees `updates.length` would otherwise read
 * "fewer updates than were actually sent" as "these are all the updates"
 * and could approve a push whose real content it never actually verified.
 * `complete: true` is the only signal that `updates` is the whole,
 * honestly-parsed set — callers (see `decide()`) must deny whenever
 * `complete` is false, not just when `updates` is empty.
 */
// [fix round 3, suggestion] Tightened to git's two real object-id lengths —
// 40 hex chars for SHA-1, 64 for SHA-256 — instead of any 4-64 hex run,
// which accepted plenty of hex strings no real git repository ever emits.
const SHALLOW_LINE_RE = /^shallow ([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

export function parseReceivePackRefUpdates(body: Uint8Array): ParsedRefUpdates {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const updates: ParsedRefUpdates["updates"] = [];
  let offset = 0;

  while (offset + 4 <= body.length) {
    const lenHex = decoder.decode(body.subarray(offset, offset + 4));
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) {
      return { updates, complete: false };
    }
    const len = parseInt(lenHex, 16);

    if (len === 0) {
      // flush-pkt reached cleanly: this is the honest end of the section.
      return { updates, complete: true };
    }
    if (len < 4 || offset + len > body.length) {
      // Length claims more (or fewer) bytes than are actually available.
      return { updates, complete: false };
    }

    const lineBytes = body.subarray(offset + 4, offset + len);
    offset += len;

    const line = decoder.decode(lineBytes);
    const nulIdx = line.indexOf("\0");
    const core = (nulIdx >= 0 ? line.slice(0, nulIdx) : line).replace(/\n$/, "");

    if (SHALLOW_LINE_RE.test(core)) {
      // Informational shallow-boundary line, not a ref update. Skip it.
      continue;
    }

    const parts = core.split(" ");
    if (parts.length !== 3) {
      return { updates, complete: false };
    }
    // `!`: `parts.length !== 3` was already checked above, so all three
    // indices exist. (noUncheckedIndexedAccess, D#2 H13b: this file is now
    // consumed from apps/web's stricter tsconfig, which flags plain array
    // indexing regardless of that length check.)
    const oldSha = parts[0]!;
    const newSha = parts[1]!;
    const ref = parts[2]!;
    updates.push({ old: oldSha, new: newSha, ref });
  }

  // Ran out of bytes before ever reaching a flush-pkt: unterminated.
  return { updates, complete: false };
}
