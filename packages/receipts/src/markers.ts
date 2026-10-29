/**
 * The marker writer (D#7 DP6a, C22 B4): replaces only the text between the receipt block's two marker lines in a pull request body.
 *
 * A marker counts only when it is the whole line apart from 0 to 3 leading spaces and trailing spaces or tabs, and the line is outside a fenced
 * code block. Fences follow CommonMark: a run of 3 or more backticks or tildes opens one (a backtick run whose info string holds a backtick is not
 * a fence), and a run of the same character at least as long, with nothing after it, closes it. A fence may be indented any amount, so a fence
 * nested in a list item hides what is inside it; that errs toward "this is code", which only ever leaves quoted examples alone. Where a start marker
 * is followed by another start before any end, the pair begins at the later one. Every byte outside the pair is left as it was. With no pair, a fresh
 * one is appended, after closing any fence the body left open. A write is refused unless the result holds exactly the new pair where it was put.
 */
export const BLOCK_START = "<!-- fx:receipts:start -->";
export const BLOCK_END = "<!-- fx:receipts:end -->";

/** Thrown when the result of a write would not hold exactly the new pair; the body is then left alone. */
export class BlockPlacementError extends Error {
  constructor() {
    super("block_unplaceable");
    this.name = "BlockPlacementError";
  }
}

interface Line {
  start: number;
  end: number;
  text: string;
}

function lines(body: string): Line[] {
  const out: Line[] = [];
  let at = 0;
  while (at <= body.length) {
    const nl = body.indexOf("\n", at);
    const end = nl === -1 ? body.length : nl;
    out.push({ start: at, end, text: body.slice(at, end).replace(/\r$/, "") });
    if (nl === -1) break;
    at = nl + 1;
  }
  return out;
}

const START_LINE = /^ {0,3}<!-- fx:receipts:start -->[ \t]*$/;
const END_LINE = /^ {0,3}<!-- fx:receipts:end -->[ \t]*$/;

interface Scan {
  found: { from: number; to: number } | null;
  /** The fence still open at the end of the body, if any. */
  openFence: { char: string; len: number } | null;
}

function scan(body: string): Scan {
  let fence: { char: string; len: number } | null = null;
  let from = -1;
  for (const l of lines(body)) {
    const f = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(l.text);
    if (fence === null) {
      if (f && !(f[1]![0] === "`" && f[2]!.includes("`"))) {
        fence = { char: f[1]![0]!, len: f[1]!.length };
        continue;
      }
    } else {
      if (f && f[1]![0] === fence.char && f[1]!.length >= fence.len && f[2]!.trim() === "") fence = null;
      continue;
    }
    if (START_LINE.test(l.text)) from = l.start;
    else if (from !== -1 && END_LINE.test(l.text)) return { found: { from, to: l.end }, openFence: null };
  }
  return { found: null, openFence: fence };
}

/** The first real marker pair, as the offsets of the start marker line's start and the end marker line's end; null when there is none. */
export function findBlock(body: string): { from: number; to: number } | null {
  return scan(body).found;
}

/** The body with the block between the markers replaced (or appended when no pair is there). Throws BlockPlacementError when the result is not exactly the new pair. */
export function replaceBlock(body: string, block: string): string {
  const fresh = `${BLOCK_START}\n${block}\n${BLOCK_END}`;
  const s = scan(body);
  let next: string;
  let at: number;
  if (s.found) {
    at = s.found.from;
    next = body.slice(0, at) + fresh + body.slice(s.found.to);
  } else if (body.trim() === "") {
    at = 0;
    next = fresh;
  } else {
    // Nothing already in the body is touched: a closing run for an open fence, then the separator, are added after it.
    const close = s.openFence ? `${body.endsWith("\n") ? "" : "\n"}${s.openFence.char.repeat(s.openFence.len)}\n` : "";
    const sep = close !== "" ? "\n" : body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
    at = body.length + close.length + sep.length;
    next = body + close + sep + fresh;
  }
  const check = findBlock(next);
  if (check === null || check.from !== at || next.slice(check.from, check.to) !== fresh) throw new BlockPlacementError();
  return next;
}
