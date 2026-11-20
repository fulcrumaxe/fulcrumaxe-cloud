/**
 * The one reader of the archive that carries a job's repository into a microVM (D#587 B-5b). The archive is built on the host from the runner's
 * own mirror, but it is still read here, entry by entry, before a byte of it is sent: whatever the builder was, an entry that could leave the
 * workspace in the guest never gets there.
 *
 *  - A path is relative, has no empty, `.` or `..` segment, no `.git` segment (any case), no control character (NUL and newline included) and no backslash, and is at most `MAX_PATH_BYTES`.
 *  - A symbolic link is allowed only when its target is relative and, resolved lexically from the link's own directory, stays inside the tree.
 *  - A hard link, a device, a FIFO or any other entry type is refused, as is a set-id or sticky mode.
 *  - Sizes are checked as the headers are read (entry count, one body, the total), and every header's checksum is verified.
 *  - Only plain ustar headers and the two pax records (`path`, `linkpath`) are understood. A pax record this reader does not know is ignored, never
 *    obeyed: it cannot change a size, a type or a mode.
 * It reads a buffer the caller already holds and decides nothing about the tree: whether the archive IS the tree is `verifyTree` (the host side).
 */
import path from "node:path";

export type ArchiveRefusal = "archive_malformed" | "archive_path" | "archive_link" | "archive_type" | "archive_mode" | "archive_too_large" | "archive_mismatch";

/** A refusal is a closed code; the message never carries a path, a name or a size from the archive. */
export class ArchiveRefused extends Error {
  constructor(readonly code: ArchiveRefusal) {
    super(code);
    this.name = "ArchiveRefused";
  }
}

export const MAX_PATH_BYTES = 4096;
export const MAX_ENTRIES = 250_000;
const BLOCK = 512;

export interface TarEntry {
  path: string;
  kind: "file" | "dir" | "symlink";
  mode: number;
  size: number;
  /** A symlink's target. */
  target?: string;
  /** A regular file's bytes, a view into the buffer that was read. */
  data?: Buffer;
}

export interface TarLimits {
  maxEntries: number;
  /** The most all file bodies together may hold. */
  maxTotalBytes: number;
}

/** A name this package would write below a workspace: relative, plain segments only. Undefined for anything else. */
export function confinedPath(name: string): string | undefined {
  if (typeof name !== "string" || name === "" || Buffer.byteLength(name) > MAX_PATH_BYTES || /[\u0000-\u001f\u007f\\]/.test(name) || name.startsWith("/")) return undefined;
  const parts = name.replace(/\/$/, "").split("/");
  for (const part of parts) if (part === "" || part === "." || part === ".." || part.toLowerCase() === ".git") return undefined;
  return parts.join("/");
}

/**
 * True when a link at `from` pointing at `target` resolves, lexically, to a place inside the tree. An absolute target, a NUL or an empty target is never inside, and neither is
 * a target with a `.git` part (in any case, written or resolved): no checkout needs a link into a repository's own folder, and a host step that follows a link must not be led there.
 */
export function linkStaysInside(from: string, target: string): boolean {
  if (typeof target !== "string" || target === "" || target.includes("\0") || target.includes("\\") || path.posix.isAbsolute(target)) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
  if (resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) return false;
  const isGit = (part: string): boolean => part.toLowerCase() === ".git";
  return !resolved.split("/").some(isGit) && !target.split("/").some(isGit);
}

function field(block: Buffer, from: number, length: number): string {
  const raw = block.subarray(from, from + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8");
}

function octal(block: Buffer, from: number, length: number): number {
  const text = field(block, from, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new ArchiveRefused("archive_malformed");
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function checksumOk(block: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (block[i] as number);
  return sum === octal(block, 148, 8);
}

/** The `path` and `linkpath` records of a pax extended header (`<length> <key>=<value>\n` each); anything else is ignored. */
function paxRecords(body: Buffer): { path?: string; linkpath?: string } {
  const out: { path?: string; linkpath?: string } = {};
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space < 0) throw new ArchiveRefused("archive_malformed");
    const len = Number(body.subarray(at, space).toString("ascii"));
    if (!Number.isSafeInteger(len) || len < space - at + 2 || at + len > body.length || body[at + len - 1] !== 0x0a) throw new ArchiveRefused("archive_malformed");
    const record = body.subarray(space + 1, at + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) {
      const key = record.slice(0, eq);
      if (key === "path") out.path = record.slice(eq + 1);
      else if (key === "linkpath") out.linkpath = record.slice(eq + 1);
    }
    at += len;
  }
  return out;
}

/** Every entry of `tar`, checked. Throws `ArchiveRefused` on the first thing that is not allowed; nothing is returned for a partly good archive. */
export function readTar(tar: Buffer, limits: TarLimits): TarEntry[] {
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let at = 0;
  let pax: { path?: string; linkpath?: string } = {};
  let ended = false;
  while (at + BLOCK <= tar.length) {
    const block = tar.subarray(at, at + BLOCK);
    if (block.every((b) => b === 0)) {
      ended = true;
      break;
    }
    if (!checksumOk(block)) throw new ArchiveRefused("archive_malformed");
    const type = String.fromCharCode(block[156] === 0 ? 0x30 : (block[156] as number));
    const size = octal(block, 124, 12);
    const mode = octal(block, 100, 8);
    const bodyAt = at + BLOCK;
    const next = bodyAt + Math.ceil(size / BLOCK) * BLOCK;
    if (size > limits.maxTotalBytes || next > tar.length) throw new ArchiveRefused(size > limits.maxTotalBytes ? "archive_too_large" : "archive_malformed");
    if (type === "x") {
      if (size > 64 * 1024) throw new ArchiveRefused("archive_malformed");
      pax = { ...pax, ...paxRecords(tar.subarray(bodyAt, bodyAt + size)) };
      at = next;
      continue;
    }
    if (type === "g") {
      // the archive-wide pax header (git writes the commit id into it) is checked for shape and then dropped: it changes nothing this reader returns
      if (size > 64 * 1024) throw new ArchiveRefused("archive_malformed");
      paxRecords(tar.subarray(bodyAt, bodyAt + size));
      at = next;
      continue;
    }
    if (entries.length >= limits.maxEntries) throw new ArchiveRefused("archive_too_large");
    const prefix = field(block, 345, 155);
    const named = pax.path ?? (prefix === "" ? field(block, 0, 100) : `${prefix}/${field(block, 0, 100)}`);
    const linked = pax.linkpath ?? field(block, 157, 100);
    pax = {};
    const clean = confinedPath(named);
    if (clean === undefined) throw new ArchiveRefused("archive_path");
    if ((mode & 0o7000) !== 0) throw new ArchiveRefused("archive_mode");
    if (seen.has(clean)) throw new ArchiveRefused("archive_path");
    seen.add(clean);
    if (type === "0") {
      total += size;
      if (total > limits.maxTotalBytes) throw new ArchiveRefused("archive_too_large");
      entries.push({ path: clean, kind: "file", mode: mode & 0o777, size, data: tar.subarray(bodyAt, bodyAt + size) });
    } else if (type === "5") {
      if (size !== 0) throw new ArchiveRefused("archive_malformed");
      entries.push({ path: clean, kind: "dir", mode: mode & 0o777, size: 0 });
    } else if (type === "2") {
      if (size !== 0) throw new ArchiveRefused("archive_malformed");
      if (!linkStaysInside(clean, linked)) throw new ArchiveRefused("archive_link");
      entries.push({ path: clean, kind: "symlink", mode: 0o777, size: 0, target: linked });
    } else if (type === "1") {
      throw new ArchiveRefused("archive_link");
    } else {
      throw new ArchiveRefused("archive_type");
    }
    at = next;
  }
  if (!ended && at !== tar.length) throw new ArchiveRefused("archive_malformed");
  // An entry below a symbolic link would be written through it: a tree made this way is not one a checkout makes, so it is refused whatever the link points at.
  const links = new Set(entries.filter((e) => e.kind === "symlink").map((e) => e.path));
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) if (links.has(parts.slice(0, i).join("/"))) throw new ArchiveRefused("archive_link");
  }
  return entries;
}
