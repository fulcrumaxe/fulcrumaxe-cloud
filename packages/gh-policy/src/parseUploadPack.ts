/**
 * Parse a `git-upload-pack` request body (already inflated) far enough to
 * tell what kind of request it is and whether it is a "full clone".
 *
 * Pure and synchronous. The caller inflates a gzip body first (with its own
 * output cap); a body that still starts with the gzip magic is not valid
 * pkt-line framing and so comes back `complete: false`.
 *
 * Two framings are understood:
 *   - protocol v2: `command=<name>`, capability lines, an optional delim-pkt
 *     (0001) followed by the argument lines, then a flush-pkt (0000). The body
 *     must end at that flush-pkt.
 *   - v0/v1: `want` lines (the first may carry capabilities), `shallow` /
 *     `deepen` / `filter` lines, a flush-pkt, then `have` lines and an
 *     optional `done`. The body must end at a pkt boundary.
 *
 * `complete: false` means "cannot verify" and is refused by the caller, never
 * read as "not a clone" (same rule as `ParsedRefUpdates`). Parsing stops at the
 * first malformed byte; whatever was gathered up to then is still returned.
 */
export interface ParsedUploadPackRequest {
  complete: boolean;
  /** `null` until a command (v2) or the first `want` (v0/v1) was seen. */
  command: "fetch" | "ls-refs" | "other" | null;
  /** Object ids wanted. A v2 `want-ref <name>` line is counted here too (by name), so it can never hide a want. */
  wants: string[];
  haves: string[];
}

const OID_RE = /^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const V2_COMMAND_RE = /^command=([a-z][a-z0-9-]*)$/;

type Pkt = { kind: "data"; text: string } | { kind: "flush" } | { kind: "delim" };

function hexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

/** Reads one pkt-line at `offset`. Returns null when the framing is bad or the body ends mid-packet. */
function readPkt(body: Uint8Array, offset: number): { pkt: Pkt; next: number } | null {
  if (offset + 4 > body.length) return null;
  let len = 0;
  for (let i = 0; i < 4; i++) {
    const v = hexDigit(body[offset + i]!);
    if (v < 0) return null;
    len = len * 16 + v;
  }
  if (len === 0) return { pkt: { kind: "flush" }, next: offset + 4 };
  if (len === 1) return { pkt: { kind: "delim" }, next: offset + 4 };
  // 2 is response-end (never in a request), 3 is undefined, 4 is an empty data packet: all refused.
  if (len < 5 || offset + len > body.length) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(body.subarray(offset + 4, offset + len));
  return { pkt: { kind: "data", text: text.replace(/\n$/, "") }, next: offset + len };
}

function result(
  complete: boolean,
  command: ParsedUploadPackRequest["command"],
  wants: string[],
  haves: string[],
): ParsedUploadPackRequest {
  return { complete, command, wants, haves };
}

function parseV2(body: Uint8Array, first: string): ParsedUploadPackRequest {
  const name = V2_COMMAND_RE.exec(first)![1]!;
  const command = name === "fetch" || name === "ls-refs" ? name : "other";
  const wants: string[] = [];
  const haves: string[] = [];
  let offset = readPkt(body, 0)!.next;
  let inArgs = false;
  for (;;) {
    const r = readPkt(body, offset);
    if (!r) return result(false, command, wants, haves);
    offset = r.next;
    if (r.pkt.kind === "flush") {
      // The request ends here; anything after it is not part of one request.
      return result(offset === body.length, command, wants, haves);
    }
    if (r.pkt.kind === "delim") {
      if (inArgs) return result(false, command, wants, haves);
      inArgs = true;
      continue;
    }
    if (!inArgs) continue; // capability line (agent=, object-format=, server-option=...)
    const text = r.pkt.text;
    const sp = text.indexOf(" ");
    const key = sp < 0 ? text : text.slice(0, sp);
    const value = sp < 0 ? "" : text.slice(sp + 1);
    if (key === "want" || key === "have") {
      if (!OID_RE.test(value)) return result(false, command, wants, haves);
      (key === "want" ? wants : haves).push(value);
    } else if (key === "want-ref") {
      if (value === "") return result(false, command, wants, haves);
      wants.push(value);
    }
    // Every other argument (done, thin-pack, shallow, deepen, filter, ref-prefix...) changes neither list.
  }
}

const V0_WANT_SECTION_KEYS: ReadonlySet<string> = new Set([
  "shallow",
  "deepen",
  "deepen-since",
  "deepen-not",
  "filter",
]);

function parseV0(body: Uint8Array): ParsedUploadPackRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  let offset = 0;
  let afterFlush = false;
  let done = false;
  for (;;) {
    if (offset === body.length) {
      // Clean end of the body: fine once the want section was closed.
      return result(afterFlush, "fetch", wants, haves);
    }
    if (done) return result(false, "fetch", wants, haves);
    const r = readPkt(body, offset);
    if (!r || r.pkt.kind === "delim") return result(false, "fetch", wants, haves);
    offset = r.next;
    if (r.pkt.kind === "flush") {
      afterFlush = true;
      continue;
    }
    const tokens = r.pkt.text.split(" ");
    const key = tokens[0]!;
    if (!afterFlush) {
      if (key === "want") {
        // Only the very first want may carry capabilities.
        const ok = tokens.length >= 2 && OID_RE.test(tokens[1]!) && (wants.length === 0 || tokens.length === 2);
        if (!ok) return result(false, "fetch", wants, haves);
        wants.push(tokens[1]!);
      } else if (V0_WANT_SECTION_KEYS.has(key) && tokens.length >= 2) {
        // shallow / deepen / filter: informational for our purposes.
      } else {
        return result(false, "fetch", wants, haves);
      }
    } else if (key === "have") {
      if (tokens.length !== 2 || !OID_RE.test(tokens[1]!)) return result(false, "fetch", wants, haves);
      haves.push(tokens[1]!);
    } else if (key === "done" && tokens.length === 1) {
      done = true;
    } else {
      return result(false, "fetch", wants, haves);
    }
  }
}

export function parseUploadPackRequest(body: Uint8Array): ParsedUploadPackRequest {
  const firstRead = readPkt(body, 0);
  if (!firstRead || firstRead.pkt.kind !== "data") return result(false, null, [], []);
  const first = firstRead.pkt.text;
  if (V2_COMMAND_RE.test(first)) return parseV2(body, first);
  if (first.startsWith("want ")) return parseV0(body);
  return result(false, null, [], []);
}

/**
 * True only for a complete fetch with at least one want and no `have`: the
 * shape of a first clone (or a shallow / filtered first fetch). `ls-refs`,
 * every fetch with a `have`, and every incomplete parse are not full clones.
 */
export function isFullCloneRequest(parsed: ParsedUploadPackRequest): boolean {
  return parsed.complete && parsed.command === "fetch" && parsed.wants.length >= 1 && parsed.haves.length === 0;
}
