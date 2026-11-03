import { describe, expect, it } from "vitest";
import { EXCLUDE_MATCH_MAX_STEPS, EXCLUDE_SET_MAX_STEPS, excludeCovers, pinLedgerNotes, splitPinsByExcludes } from "../src/pinRules.js";

/** The matcher this package used before the linear one (a backtracking regular expression built from the glob). Kept only to prove the new one agrees with it. */
function legacyExcludeCovers(pattern: string, path: string): boolean {
  const trimmed = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") return false;
  let re = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const c = trimmed[i]!;
    if (c === "*") {
      if (trimmed[i + 1] === "*") {
        const slash = trimmed[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const close = trimmed.indexOf("]", i + 2);
      if (close === -1) re += "\\[";
      else {
        re += `[${trimmed.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  try {
    if (new RegExp(`^${re}(?:/.*)?$`, "i").test(path)) return true;
    return !trimmed.includes("/") && new RegExp(`^(?:.*/)?${re}(?:/.*)?$`, "i").test(path);
  } catch {
    return true;
  }
}

/** [pattern, path, covered]. A permanent table: both matchers must give the answer in the last column. */
const TABLE: Array<[string, string, boolean]> = [
  ["secret", "secret", true],
  ["secret", "Secret/a.txt", true],
  ["secret", "src/secret/a.txt", true],
  ["secret", "src/notsecret/a.txt", false],
  ["secret", "secrets", false],
  ["/secret/", "secret/a", true],
  ["", "a", false],
  ["///", "a", false],
  ["src/secret", "src/secret/deep/file", true],
  ["src/secret", "x/src/secret", false],
  ["*.env", ".env", true],
  ["*.env", "a/b/prod.env", true],
  ["src/*.ts", "src/a.ts", true],
  ["src/*.ts", "src/a/b.ts", false],
  ["a?c", "abc", true],
  ["a?c", "a/c", false],
  ["a/**", "a/b/c/d", true],
  ["a/**", "a", false],
  ["**/node_modules", "x/y/node_modules/z", true],
  ["**/node_modules", "node_modules", true],
  ["a/**/b", "a/b", true],
  ["a/**/b", "a/x/y/b", true],
  ["a/**/b", "a/x/y/c", false],
  ["a**b", "a/x/b", true],
  ["***", "a/b", true],
  ["[abc].md", "b.md", true],
  ["[abc].md", "d.md", false],
  ["[!abc].md", "d.md", true],
  ["[!abc].md", "a.md", false],
  ["[^abc].md", "d.md", true],
  ["[a-c]x", "Bx", true],
  ["app/[id]/page.tsx", "app/i/page.tsx", true],
  ["app/[id]/page.tsx", "app/[id]/page.tsx", false],
  ["[z-a]", "anything", true],
  ["[a", "[a", true],
  ["[a", "a", false],
  ["a[", "a[", true],
  ["{a,b}", "{a,b}", true],
  ["{a,b}", "a", false],
  ["(x)", "(x)", true],
  ["a.b", "a.b", true],
  ["a.b", "axb", false],
  ["a+b", "a+b", true],
  ["a|b", "a", false],
  ["a\\b", "a\\b", true],
  ["É.md", "é.md", true],
  ["*", "a\nb", true],
  ["a**", "a\nb", false],
  ["a/**", "a/b\nc", false],
  ["x", "a\n/x", false],
];

describe("excludeCovers", () => {
  it("answers the table the same way the old regular-expression matcher did", () => {
    for (const [pattern, path, covered] of TABLE) {
      expect(excludeCovers(pattern, path), `new ${pattern} ~ ${path}`).toBe(covered);
      expect(legacyExcludeCovers(pattern, path), `old ${pattern} ~ ${path}`).toBe(covered);
    }
  });

  it("agrees with the old matcher on thousands of small generated cases", () => {
    const alphabet = ["a", "B", "b", "/", "*", "?", "[", "]", "!", "-", ".", "é", "\\", "x"];
    let seed = 12345;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const make = (max: number) => Array.from({ length: rand(max) + 1 }, () => alphabet[rand(alphabet.length)]!).join("");
    let compared = 0;
    for (let i = 0; i < 30_000; i += 1) {
      const pattern = make(6);
      const path = make(9);
      // A class holding a `]` was a regular-expression injection in the old form (`[]x]` meant an empty class then `x]`); the new matcher covers instead.
      if ([...pattern].some((c, i) => c === "[" && pattern.indexOf("]", i + 2) !== -1 && pattern.slice(i + 1, pattern.indexOf("]", i + 2)).includes("]"))) continue;
      expect(excludeCovers(pattern, path), `${JSON.stringify(pattern)} ~ ${JSON.stringify(path)}`).toBe(legacyExcludeCovers(pattern, path));
      compared += 1;
    }
    expect(compared).toBeGreaterThan(20_000);
  });

  it("a class that would have been an injected expression covers every path (the safe side)", () => {
    expect(excludeCovers("[]x]", "anything")).toBe(true);
  });

  it("hostile repeated `**a` patterns finish in well under a second, where the old matcher took tens of seconds", () => {
    const path = `${"a".repeat(200)}!`;
    for (const repeats of [4, 5, 6, 40, 150]) {
      const started = Date.now();
      const result = excludeCovers("**a".repeat(repeats).slice(0, 512), path);
      expect(Date.now() - started, `${repeats} repeats`).toBeLessThan(1000);
      expect(typeof result).toBe("boolean");
    }
    const started = Date.now();
    expect(splitPinsByExcludes([path, `${"a".repeat(500)}!`], Array.from({ length: 500 }, (_, i) => `**a**a**a**a**a${"?".repeat(i % 5)}b`)).readable).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("the work bound fires: a call over the step limit, and a set past its shared budget, answer covered without matching", () => {
    // Never matches by content (the path has no `z`), so `true` can only come from the bound.
    const longPattern = "a?".repeat(255);
    const longPath = "a".repeat(512);
    expect(excludeCovers(longPattern, longPath)).toBe(false);
    expect((255 * 2 + 1) * 513 < EXCLUDE_MATCH_MAX_STEPS).toBe(true);
    expect(excludeCovers("a?z", "abzq")).toBe(false);
    expect(excludeCovers("a?z", "abzq", { left: 1 })).toBe(true);
    const work = { left: 40 };
    expect(excludeCovers("a?z", "abzq", work)).toBe(false);
    expect(excludeCovers("a?z", "abzq", work)).toBe(false);
    expect(excludeCovers("a?z", "abzq", work)).toBe(true);
    expect(EXCLUDE_SET_MAX_STEPS).toBeGreaterThan(EXCLUDE_MATCH_MAX_STEPS);
    // A path or pattern so large that one call would pass the per-call limit is covered, not matched.
    expect(excludeCovers("?*".repeat(300) + "z", "a".repeat(4999) + "z")).toBe(true);
  });
});

describe("the work budget at a repository's caps", () => {
  // 500 pins at the path length cap (512), spread over 25 vendor trees, and 500 ordinary excludes of the shapes people write.
  const pad = (s: string): string => s + "x".repeat(512 - s.length);
  const pins = Array.from({ length: 500 }, (_, i) => pad(`vendor/pkg${i % 25}/gen${i % 40}/file${i}`));
  const ordinary = Array.from({ length: 500 }, (_, i) => (i % 4 === 0 ? `vendor/**/gen${i % 40}/*.ts` : i % 4 === 1 ? `docs/section${i}/**` : i % 4 === 2 ? `*.min${i}.js` : `secrets${i}`));

  it("(a) 500 ordinary excludes against 500 pins at the caps read every pin that is not truly covered, spending a small part of the budget", () => {
    const work = { left: EXCLUDE_SET_MAX_STEPS };
    const started = Date.now();
    const readable = pins.filter((p) => ![...ordinary].some((e) => excludeCovers(e, p, work)));
    expect(readable).toHaveLength(500);
    expect(Date.now() - started).toBeLessThan(1000);
    const spent = EXCLUDE_SET_MAX_STEPS - work.left;
    console.info(`500x500 ordinary: ${Date.now() - started} ms, ${spent} of ${EXCLUDE_SET_MAX_STEPS} steps`);
    expect(spent).toBeLessThan(EXCLUDE_SET_MAX_STEPS / 10);
    // The expensive ordinary shape: every exclude is `vendor/**/genN/*.ts` and every pin sits in a matching directory but is not a .ts file, so each pair that
    // passes the cheap checks runs the table. Pins of a realistic length, and at the length cap.
    for (const [label, padTo] of [["realistic", 0], ["at the cap", 512]] as const) {
      const heavyPins = Array.from({ length: 500 }, (_, i) => `vendor/pkg${i % 25}/gen${i % 40}/file${i}.ts.bak`.padEnd(padTo, "x"));
      const heavy = Array.from({ length: 500 }, (_, i) => `vendor/**/gen${i % 40}/*.ts`);
      const w = { left: EXCLUDE_SET_MAX_STEPS };
      const t0 = Date.now();
      const split2 = splitPinsByExcludes(heavyPins, heavy);
      for (const e of heavy.slice(0, 3)) excludeCovers(e, heavyPins[0]!, w);
      console.info(`500x500 vendor/**/genN/*.ts ${label}: ${Date.now() - t0} ms, limited ${split2.limited}`);
      // At the 8 Mi budget a cap-length set of this shape reports `pin_match_limit` visibly (the accepted cost of the lower cap); a realistic one reads every pin.
      if (padTo === 0) expect(split2.limited).toBe(0);
      else expect(split2.limited).toBeGreaterThan(0);
      expect(split2.readable.length + split2.limited).toBe(500);
    }
    // The same set with real covers among the pins: exactly those are excluded, none limited.
    const covered = [...pins.slice(0, 10), ...pins.slice(10)];
    const split = splitPinsByExcludes(covered, [...ordinary, "vendor/pkg3"]);
    expect(split.limited).toBe(0);
    expect(split.excluded).toBe(pins.filter((p) => p.startsWith("vendor/pkg3/")).length);
    expect(split.readable.length + split.excluded).toBe(500);
  });

  it("(b) when the bound is reached on hostile input, the pins held back are counted as limited, not as real excludes", () => {
    const hostile = Array.from({ length: 500 }, () => "**a".repeat(8));
    const aPins = Array.from({ length: 500 }, (_, i) => `${"a".repeat(480)}${String(i).padStart(3, "0")}!`);
    const split = splitPinsByExcludes(aPins, hostile);
    expect(split.excluded).toBe(0);
    expect(split.limited).toBeGreaterThan(0);
    expect(split.readable.length + split.limited).toBe(500);
  });

  it("(c) one whole-set call on hostile input at the budget does not hold the event loop for long", () => {
    const hostile = Array.from({ length: 500 }, () => "**a".repeat(8));
    const aPins = Array.from({ length: 500 }, () => `${"a".repeat(511)}!`);
    const started = Date.now();
    const split = splitPinsByExcludes(aPins, hostile);
    console.info(`hostile whole-set call at the budget: ${Date.now() - started} ms`);
    // The bound is the step budget, which does not depend on host load: the shared work is spent to zero and the rest of the pairs are held back as limited.
    const work = { left: EXCLUDE_SET_MAX_STEPS };
    for (const e of hostile) if (aPins.some((p) => excludeCovers(e, p, work)) && work.left <= 0) break;
    expect(work.left).toBeLessThanOrEqual(0);
    expect(EXCLUDE_SET_MAX_STEPS).toBe(8 * 1_048_576);
    expect(split.limited).toBeGreaterThan(0);
    // A sanity bound only, far above any load this runs under.
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});

describe("the ledger tells a limited pin from an excluded one", () => {
  it("reports `pin_match_limit` as its own closed reason, with a count and a fixed hash only", () => {
    const notes = pinLedgerNotes({ items: [], missing: 0, tooLarge: 0, excluded: 2, limited: 3 }, undefined);
    expect(notes.map((n) => [n.trimmed_reason, n.bytes])).toEqual([["pin_excluded", 2], ["pin_match_limit", 3]]);
    expect(notes.every((n) => /^[0-9a-f]{64}$/.test(n.sha256))).toBe(true);
    expect(pinLedgerNotes({ items: [], missing: 0, tooLarge: 0, excluded: 0 }, undefined)).toEqual([]);
  });
});
