import { CONTEXT_SECTION_CODES, type ContextSection, type ContextSectionCode } from "./contextLedger.js";

/**
 * D#600 CX-4a: the files an over-budget or capped prompt spills its cut text to, and the marker the prompt carries in the cut's place.
 *
 * On the sandbox the file is `/fx/context/<code>.md`, outside the checkout (`git status` never sees it). The path is built ONLY from a code in the
 * closed list below, never from text, so nothing a person or a model wrote can name a path. The Spec section and pinned files are never cut and so
 * have no file. This module is pure: the sandbox port writes the files, and the runner-side writer (CX-4b) is a separate change.
 */

export const CONTEXT_SPILL_DIR = "/fx/context";

/** The sections that can be cut, and so the only codes that have a file. A fixed list: anything else is refused. */
export const CONTEXT_SPILL_CODES = ["findings", "note", "corrections", "memory_item", "map", "memory_stable"] as const satisfies readonly ContextSectionCode[];
export type ContextSpillCode = (typeof CONTEXT_SPILL_CODES)[number];

/** All files together, and the uncut prompt a failed write falls back to (the same bound the worker puts on a fix prompt). */
export const CONTEXT_SPILL_MAX_TOTAL_BYTES = 262_144;
export const CONTEXT_SPILL_MAX_PROMPT_CHARS = 120_000;

export interface ContextSpill {
  /** One file per code, at most. */
  files: Array<{ code: ContextSpillCode; text: string }>;
  /**
   * The same prompt with nothing cut and no marker, and its sections. Used when a file cannot be written: a cut never happens without a readable
   * file and a manifest line, so the section then stays in the prompt in full.
   */
  uncut: { prompt: string; sections: ContextSection[] };
}

const SPILLABLE: ReadonlySet<string> = new Set(CONTEXT_SPILL_CODES);
const ALL_CODES: ReadonlySet<string> = new Set(CONTEXT_SECTION_CODES);

export const isContextSpillCode = (code: unknown): code is ContextSpillCode => typeof code === "string" && SPILLABLE.has(code);

/** The path of a code's file. Throws for any value that is not one of the closed codes. */
export function contextSpillPath(code: ContextSpillCode): string {
  if (!isContextSpillCode(code)) throw new Error("contextSpillPath: not a spill code");
  return `${CONTEXT_SPILL_DIR}/${code}.md`;
}

/** What the prompt says where text was cut. */
export const trimmedMarker = (code: ContextSpillCode): string => `[trimmed: full text at ${contextSpillPath(code)}]`;

/** Strict check of a spill that crossed a boundary (a request body): own keys only, unique closed codes, string texts, the total size cap. */
export function isContextSpill(value: unknown): value is ContextSpill {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== "files,uncut") return false;
  if (!Array.isArray(v.files) || v.files.length < 1 || v.files.length > CONTEXT_SPILL_CODES.length) return false;
  const seen = new Set<string>();
  let total = 0;
  for (const f of v.files) {
    if (f === null || typeof f !== "object" || Array.isArray(f) || Object.keys(f).sort().join() !== "code,text") return false;
    const { code, text } = f as { code: unknown; text: unknown };
    if (!isContextSpillCode(code) || seen.has(code) || typeof text !== "string" || text === "") return false;
    seen.add(code);
    total += Buffer.byteLength(text, "utf8");
  }
  if (total > CONTEXT_SPILL_MAX_TOTAL_BYTES) return false;
  const u = v.uncut as Record<string, unknown> | null;
  if (u === null || typeof u !== "object" || Array.isArray(u) || Object.keys(u).sort().join() !== "prompt,sections") return false;
  if (typeof u.prompt !== "string" || u.prompt === "" || u.prompt.length > CONTEXT_SPILL_MAX_PROMPT_CHARS) return false;
  return Array.isArray(u.sections) && u.sections.length <= 64 && u.sections.every((s) => s !== null && typeof s === "object" && ALL_CODES.has((s as { code?: unknown }).code as string));
}

/** The sandbox writes: `/fx/context/<code>.md`, read only. */
export function contextSpillWrites(spill: ContextSpill): Array<{ path: string; content: string; mode: number }> {
  return spill.files.map((f) => ({ path: contextSpillPath(f.code), content: f.text, mode: 0o444 }));
}
