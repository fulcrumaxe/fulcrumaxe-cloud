/**
 * routing-ledger.json: the reviewer-checked list of changed paths that are allowed to select no pack even
 * though they sit where product code lives. Every entry says why. Strict: unknown keys, a missing reason or a
 * glob broad enough to swallow a whole top-level tree are load errors, so the ledger cannot quietly turn the
 * fail-closed rule off.
 */
import { readFileSync } from "node:fs";

export interface LedgerEntry {
  glob: string;
  reason: string;
}

export interface Ledger {
  version: 1;
  entries: LedgerEntry[];
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(`routing-ledger.json: ${message}`);
    this.name = "LedgerError";
  }
}

const MIN_REASON_CHARS = 20;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The literal part of the glob before its first wildcard must name at least two path segments (so
 * `apps/live-e2e/**` is fine, `apps/**` and `**` are not), unless the glob has no wildcard at all.
 */
export function ledgerGlobTooBroad(glob: string): boolean {
  const star = glob.search(/[*?]/);
  if (star === -1) return false;
  const literal = glob.slice(0, star);
  const dir = literal.slice(0, literal.lastIndexOf("/") + 1);
  return dir.split("/").filter(Boolean).length < 2;
}

export function validateLedger(raw: unknown): Ledger {
  if (!isRecord(raw)) throw new LedgerError("must be an object");
  for (const key of Object.keys(raw)) {
    if (key !== "version" && key !== "entries") throw new LedgerError(`unknown key "${key}"`);
  }
  if (raw.version !== 1) throw new LedgerError("version must be 1");
  if (!Array.isArray(raw.entries)) throw new LedgerError("entries must be a list");
  const seen = new Set<string>();
  const entries: LedgerEntry[] = [];
  raw.entries.forEach((e: unknown, i) => {
    if (!isRecord(e)) throw new LedgerError(`entry ${i} must be an object`);
    for (const key of Object.keys(e)) {
      if (key !== "glob" && key !== "reason") throw new LedgerError(`entry ${i} has unknown key "${key}"`);
    }
    if (typeof e.glob !== "string" || e.glob.length === 0 || e.glob.startsWith("/") || e.glob.includes("..")) {
      throw new LedgerError(`entry ${i}: "glob" must be a repository-relative path glob`);
    }
    if (typeof e.reason !== "string" || e.reason.trim().length < MIN_REASON_CHARS) {
      throw new LedgerError(`entry ${i} (${e.glob}): "reason" must say why, in at least ${MIN_REASON_CHARS} characters`);
    }
    if (ledgerGlobTooBroad(e.glob)) {
      throw new LedgerError(`entry ${i} (${e.glob}): glob is too broad; name a directory at least two levels deep or a file`);
    }
    if (seen.has(e.glob)) throw new LedgerError(`entry ${i}: duplicate glob ${e.glob}`);
    seen.add(e.glob);
    entries.push({ glob: e.glob, reason: e.reason });
  });
  return { version: 1, entries };
}

export function loadLedger(file: string): Ledger {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new LedgerError(`unreadable (${String(err instanceof Error ? err.message : err).split("\n")[0]})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LedgerError("not valid JSON");
  }
  return validateLedger(raw);
}
