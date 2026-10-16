/**
 * The bounded glob behind action rules (D#7 AAP-a1, R-7-AAP-6): `*` matches any run of characters, `?` matches exactly one UTF-16 code unit,
 * and every other character matches itself. There is no escape syntax and no regular expression anywhere in the rules module. The matcher
 * keeps one backtrack point (the last `*`), so the work is at most pattern length times text length, which is linear in the text for the
 * bounded pattern the validator allows. It returns its step count so the evaluator can charge it to a budget instead of timing it, and it stops at a step limit so one match cannot run past what is left of that budget.
 */
export interface GlobResult {
  readonly matched: boolean;
  readonly steps: number;
  /** True when the matcher stopped because it reached the step limit it was given; `matched` is then meaningless. */
  readonly exhausted?: boolean;
}

export function globMatch(pattern: string, text: string, stepLimit = Number.POSITIVE_INFINITY): GlobResult {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  let steps = 0;
  while (t < text.length) {
    if (steps >= stepLimit) return { matched: false, steps, exhausted: true };
    steps++;
    const c = pattern[p];
    if (c === "*") {
      star = p++;
      mark = t;
    } else if (p < pattern.length && (c === "?" || c === text[t])) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else {
      return { matched: false, steps };
    }
  }
  while (pattern[p] === "*") {
    if (steps >= stepLimit) return { matched: false, steps, exhausted: true };
    p++;
    steps++;
  }
  return { matched: p === pattern.length, steps };
}
