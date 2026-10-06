// apps/workspace/import/tar.mjs
//
// Minimal POSIX ustar / PAX tar reader for `git archive --format=tar` output.
// Node 22 built-ins only -- no npm runtime dependency (D#37 WS-A1 criterion 7).
//
// Understands:
//   - plain ustar headers (100-byte name, optional 155-byte "prefix" that git
//     uses to split long paths instead of a pax "path" record)
//   - a pax GLOBAL extended header (typeflag 'g', name "pax_global_header"),
//     which `git archive` uses to record the source commit id as a "comment"
//     PAX record: "<len> comment=<40-hex-sha>\n". Archiving a tree object
//     instead of a commit omits this record entirely.
//   - a pax LOCAL extended header (typeflag 'x'), which overrides fields
//     (name, size, ...) of the single entry that immediately follows it.
//
// Does not understand GNU base-256 sizes (not produced by `git archive` for
// files of the size this project ships) or old-style GNU long-name/long-link
// headers ('L'/'K') -- `git archive` uses ustar prefix-splitting and pax
// instead.

const BLOCK_SIZE = 512;

// W3 (security review): resource caps, all overridable per-call so tests can
// exercise the cap-exceeded path without building multi-gigabyte fixtures.
// The defaults are generous relative to what a real import handles (the
// review measured 200k entries in 5.1s and a 64 MiB PAX record in 0.12s,
// both linear with no amplification) -- they exist to bound worst case
// memory/time, not to constrain a normal import.
export const DEFAULT_MAX_ENTRIES = 100_000;
export const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const DEFAULT_MAX_PAX_HEADER_SIZE = 1024 * 1024; // 1 MiB per PAX record block

function trimField(buf) {
  const nul = buf.indexOf(0);
  const raw = nul === -1 ? buf : buf.subarray(0, nul);
  return raw.toString("utf8");
}

// E1 (security review): a tar-controlled size field previously accepted a
// leading sign and fed the result straight to parseInt(str, 8), so a field
// of "-1000" parsed to -512 -- paddedSize went negative, offset stopped
// advancing, and the read loop spun forever pushing a new entry every pass
// (CWE-835/CWE-400: a 2.5 KB tar OOM'd the process in ~3.4s). Only
// `/^[0-7]+$/` (after trimming the field's NUL/space padding) is accepted;
// anything else -- a sign, a non-octal digit, or a value that overflows a
// safe integer -- refuses the whole archive rather than coercing to 0 or a
// wrapped number.
function parseOctal(buf, fieldName) {
  const raw = buf.toString("latin1").replace(/\0+$/, "");
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  if (!/^[0-7]+$/.test(trimmed)) {
    throw new Error(
      `readTar: invalid octal ${fieldName} field (expected only octal digits, no sign): ${JSON.stringify(trimmed)}`,
    );
  }
  const n = parseInt(trimmed, 8);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`readTar: ${fieldName} field out of range: ${trimmed}`);
  }
  return n;
}

// Parses one PAX record block: repeated "<len> key=value\n" entries, where
// <len> is a decimal ASCII length counting the whole record (length digits,
// the space, the key, "=", the value, and the trailing "\n").
function parsePaxRecords(buf) {
  const records = {};
  let offset = 0;
  while (offset < buf.length) {
    const spaceIdx = buf.indexOf(0x20, offset);
    if (spaceIdx === -1) break;
    const lenStr = buf.subarray(offset, spaceIdx).toString("latin1");
    const len = parseInt(lenStr, 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const recordEnd = offset + len;
    if (recordEnd > buf.length) break;
    const body = buf.subarray(spaceIdx + 1, recordEnd - 1); // strip trailing \n
    const eqIdx = body.indexOf(0x3d); // '='
    if (eqIdx !== -1) {
      const key = body.subarray(0, eqIdx).toString("utf8");
      const value = body.subarray(eqIdx + 1).toString("utf8");
      records[key] = value;
    }
    offset = recordEnd;
  }
  return records;
}

function isZeroBlock(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

/**
 * Parses a tar buffer.
 *
 * @param {Buffer} buffer
 * @param {{ maxEntries?: number, maxTotalBytes?: number, maxPaxHeaderSize?: number }} [limits]
 * @returns {{
 *   globalRecords: Record<string, string>,
 *   entries: Array<{ path: string, type: string, size: number, data: Buffer | null }>
 * }}
 */
export function readTar(buffer, limits = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("readTar: expected a Buffer");
  }

  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxPaxHeaderSize = limits.maxPaxHeaderSize ?? DEFAULT_MAX_PAX_HEADER_SIZE;

  const globalRecords = {};
  const entries = [];

  let offset = 0;
  let pendingPax = null; // records from the most recent 'x' header, applied once
  let zeroBlockRun = 0;
  let entryCount = 0;
  let totalBytes = 0;

  while (offset + BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK_SIZE);

    if (isZeroBlock(header)) {
      zeroBlockRun++;
      offset += BLOCK_SIZE;
      if (zeroBlockRun >= 2) break; // standard end-of-archive marker
      continue;
    }
    zeroBlockRun = 0;

    entryCount++;
    if (entryCount > maxEntries) {
      throw new Error(`readTar: entry count exceeds the maximum allowed (${maxEntries})`);
    }

    const rawName = trimField(header.subarray(0, 100));
    const size = parseOctal(header.subarray(124, 136), "size");
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const prefix = trimField(header.subarray(345, 500));

    totalBytes += size;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`readTar: total entry bytes exceed the maximum allowed (${maxTotalBytes})`);
    }
    if ((typeflag === "g" || typeflag === "x") && size > maxPaxHeaderSize) {
      throw new Error(`readTar: PAX header block exceeds the maximum allowed size (${maxPaxHeaderSize} bytes)`);
    }

    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) {
      throw new Error(
        `readTar: truncated archive -- entry "${rawName}" declares size ${size} past end of buffer`,
      );
    }
    const data = buffer.subarray(dataStart, dataEnd);
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    const nextOffset = dataStart + paddedSize;
    // Backstop (E1): size is now guaranteed non-negative by parseOctal, so
    // nextOffset = offset + BLOCK_SIZE + paddedSize is always strictly
    // greater than offset -- this assertion should be unreachable, and
    // exists only so a future change to the size computation can't
    // reintroduce a non-advancing (or backward) read loop silently.
    if (nextOffset <= offset) {
      throw new Error(`readTar: entry offset did not advance at byte ${offset} -- refusing to loop`);
    }
    offset = nextOffset;

    if (typeflag === "g") {
      Object.assign(globalRecords, parsePaxRecords(data));
      continue;
    }

    if (typeflag === "x") {
      pendingPax = parsePaxRecords(data);
      continue;
    }

    let name = pendingPax && pendingPax.path ? pendingPax.path : rawName;
    if (!(pendingPax && pendingPax.path) && prefix) {
      name = `${prefix}/${rawName}`;
    }
    let entrySize = size;
    if (pendingPax && pendingPax.size !== undefined) {
      const paxSize = parseInt(pendingPax.size, 10);
      if (Number.isFinite(paxSize)) entrySize = paxSize;
    }
    pendingPax = null;

    entries.push({
      path: name,
      type: typeflag,
      size: entrySize,
      data: typeflag === "0" || typeflag === "\0" ? Buffer.from(data) : null,
    });
  }

  return { globalRecords, entries };
}

/** True if `typeflag` denotes a regular file (ustar '0', or the legacy '\0'). */
export function isRegularFile(typeflag) {
  return typeflag === "0" || typeflag === "\0";
}

/**
 * Cheap sniff test: does this buffer look like a ustar-family tar? Checks
 * that it is at least one block long and that the first header's ustar
 * magic field ("ustar", with or without the trailing NUL/version bytes
 * some writers use) is present. Good enough to reject arbitrary non-tar
 * files without fully parsing them.
 */
export function looksLikeTar(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < BLOCK_SIZE) return false;
  const magic = buffer.subarray(257, 263).toString("latin1");
  return magic === "ustar\0" || magic === "ustar ";
}
