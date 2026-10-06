/**
 * D#483 S3 (level 1): which merged pull requests count toward a task. Pure.
 *
 * A pull request's REFERENCE LINE is its title plus the first line of its body that contains `D#<n>`. A pull request names
 * the task `D#<n>:<id>` when that text holds `D#<n>` and the token `<id>` with no letter, digit or hyphen on either side
 * (so `H14a` is not found inside `H14a-2` or `xH14a`, and lines after the first `D#<n>` line are never read).
 *
 * Naming is not enough (TL correction, 2026-10-05). A pull request counts toward a task only when it DECLARES that it
 * completes it. A task named as something else (a dependency, a follow-up, a "blocked by" or "see also", or in passing in a
 * sentence about other work) must not count: four tasks the plain naming rule would have marked done were still remaining.
 * Declared means one of:
 *   - the title holds both `D#<n>` and the task, in a clause with no dependency word;
 *   - the task is named in the title, or in the first `D#<n>` line, and that line is a DECLARATION LINE: it begins, after
 *     list and heading marks, with a lead-in such as "Part of", "Closes", "Refs", "Implements", "For" or `D#<n>` itself;
 *   - and in every case the clause that holds the task (from the last sentence break before it to a few words after it)
 *     has no dependency word.
 * A long paragraph that mentions `D#4 P03` in the middle of a sentence is not a declaration line.
 */
const DEPENDENCY_WORDS =
  /\b(?:depends?\s+on|dependent\s+on|depending\s+on|follow[- ]?ups?|followups?|blocked\s+by|blocks|blocking|see\s+also|builds?\s+on|built\s+on|needs|needed\s+by|requires?|required\s+by|prerequisites?|unblocks?|waits?\s+(?:for|on)|belongs?\s+to|stays?|first\s+caller|caller|consumer|after|before|until|once|later|next|instead\s+of|except|not)\b/i;

const LEAD_IN =
  /^(?:part\s+of|parts?\s+of|closes?|closed|fix(?:es|ed)?|resolves?|resolved|refs?|references?|implements?|implemented|completes?|completed|delivers?|delivered|finish(?:es|ed)?|addresses|task|tasks|for|d#)/i;

/** Marks that may precede a declaration lead-in: quote, list and heading marks, bold, numbering, whitespace. */
const LEADING_MARKS = /^[\s>*_#\-••]*(?:\d+[.)]\s*)?[\s*_]*/;

export function parseTaskKey(key: string): { discussion: number; token: string } | null {
  const m = /^D#(\d+):(.+)$/.exec(key);
  if (!m) return null;
  return { discussion: Number(m[1]), token: m[2]! };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The first line (in body order) that contains `D#<n>` not followed by another digit, or '' when none does. */
export function firstDLine(dLines: readonly string[], discussion: number): string {
  const re = new RegExp(`D#${discussion}(?!\\d)`);
  return dLines.find((l) => re.test(l)) ?? "";
}

function tokenRe(token: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9-])${escapeRe(token)}(?![A-Za-z0-9-])`, "g");
}

/** True when `line` begins like a statement that the pull request is for a task. */
export function isDeclarationLine(line: string): boolean {
  const rest = line.replace(LEADING_MARKS, "");
  return LEAD_IN.test(rest);
}

/** The clause that holds the match at `index`: from the last sentence break before it, to a few words after it (never past the next break). */
function clauseAround(text: string, index: number, length: number): string {
  const before = text.slice(0, index);
  const breaks = [before.lastIndexOf(". "), before.lastIndexOf("; "), before.lastIndexOf("\n"), before.lastIndexOf(" - "), before.lastIndexOf(" — ")];
  const start = Math.max(...breaks);
  const from = start === -1 ? 0 : start + 1;
  const afterStart = index + length;
  const window = text.slice(afterStart, afterStart + 40);
  const next = [window.indexOf(". "), window.indexOf("; "), window.indexOf("\n")].filter((i) => i !== -1);
  const to = afterStart + (next.length > 0 ? Math.min(...next) : window.length);
  return text.slice(from, to);
}

/** Does `text` hold the task token as a whole token, in a clause with no dependency word? */
function namesTaskCleanly(text: string, token: string): boolean {
  const re = tokenRe(token);
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (!DEPENDENCY_WORDS.test(clauseAround(text, m.index, m[0].length))) return true;
  }
  return false;
}

export interface ReferencedPull {
  title: string;
  dLines: readonly string[];
}

/** Does the pull request name the task at all (the plain reference-line rule)? Kept for evidence and tests. */
export function referenceLineNames(pr: ReferencedPull, key: string): boolean {
  const k = parseTaskKey(key);
  if (!k) return false;
  const first = firstDLine(pr.dLines, k.discussion);
  const text = `${pr.title}\n${first}`;
  const dRe = new RegExp(`D#${k.discussion}(?!\\d)`);
  return dRe.test(text) && tokenRe(k.token).test(text);
}

/** Does the pull request DECLARE that it completes the task? See the file header. */
export function declaresCompletion(pr: ReferencedPull, key: string): boolean {
  const k = parseTaskKey(key);
  if (!k) return false;
  const dRe = new RegExp(`D#${k.discussion}(?!\\d)`);
  const first = firstDLine(pr.dLines, k.discussion);
  const titleHasD = dRe.test(pr.title);
  const titleHasTask = namesTaskCleanly(pr.title, k.token);
  // A title that names the task only in a dependency clause ("Follow-up to API-6c") settles it, whatever the body says.
  if (!titleHasTask && tokenRe(k.token).test(pr.title)) return false;
  const lineIsDeclaration = first !== "" && isDeclarationLine(first);
  const lineHasTask = first !== "" && namesTaskCleanly(first, k.token);

  // The title says both the discussion and the task.
  if (titleHasD && titleHasTask) return true;
  // The title names the task and the first D# line is a declaration of that discussion.
  if (titleHasTask && lineIsDeclaration) return true;
  // The first D# line is a declaration that names the task (the discussion is in the line, or in the title).
  if (lineIsDeclaration && lineHasTask) return true;
  return false;
}
