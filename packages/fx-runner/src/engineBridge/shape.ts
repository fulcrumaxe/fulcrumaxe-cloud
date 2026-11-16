/**
 * One line of engine-events.jsonl, judged: strict EB-1 schema, then the runner's redaction. Nothing here logs or returns a line's content: a line that
 * fails is only counted, by reason. An event that redaction would change is dropped, never sent altered.
 */
import { EngineEvent, redactDeep } from "@fulcrumaxe/runner-protocol";

/** The reasons a line is left out of an upload; these are the `reason` values `bridge_dropped` allows. */
export type DropReason = "schema" | "oversize" | "redaction" | "partial_line";
export type DropCounts = Record<DropReason, number>;

/** A line longer than this (without its newline) is dropped unread. */
export const MAX_LINE_BYTES = 64 * 1024;

export const emptyDrops = (): DropCounts => ({ schema: 0, oversize: 0, redaction: 0, partial_line: 0 });
export const totalDrops = (drops: DropCounts): number => drops.schema + drops.oversize + drops.redaction + drops.partial_line;

const utf8 = new TextDecoder("utf-8", { fatal: true });

export type LineVerdict = { ok: true; event: EngineEvent } | { ok: false; reason: "schema" | "redaction" };

/** Judges one complete line (no newline). Any failure, including a parser that throws, is a fixed reason with nothing from the line. */
export function judgeLine(line: Uint8Array, secrets: readonly (string | undefined)[]): LineVerdict {
  let value: unknown;
  try {
    value = JSON.parse(utf8.decode(line));
  } catch {
    // fx-swallow-ok: bad bytes, bad JSON or a stack overflow on deep nesting are all one "schema" drop; the parser's words could quote the line
    return { ok: false, reason: "schema" };
  }
  const parsed = EngineEvent.safeParse(value);
  if (!parsed.success) return { ok: false, reason: "schema" };
  const redacted = redactDeep(parsed.data, secrets);
  if (JSON.stringify(redacted) !== JSON.stringify(parsed.data)) return { ok: false, reason: "redaction" };
  return { ok: true, event: parsed.data };
}
