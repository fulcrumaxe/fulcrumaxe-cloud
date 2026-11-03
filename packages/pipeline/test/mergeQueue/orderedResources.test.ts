import { describe, expect, it } from "vitest";
import { checkOrdering, compileGlob, compileKeyPattern, detectResource, hasUnmatchablePath, MAX_KEY_INPUT, parseKey, readOrderedConfig } from "../../src/mergeQueue/orderedResources.js";

/**
 * D#519 MQ5-a: the pure half of the ordered-resource check. The key pattern of a configuration is tenant text, so the first block is the ReDoS bound: a pattern outside the
 * safe subset is refused when the configuration is read, and what is accepted is run on a bounded input.
 */
const entry = (over: Record<string, unknown> = {}) => ({ name: "migrations", pathPattern: "packages/db/migrations/*.sql", keyPattern: "^(\\d{4})_.+\\.sql$", keyKind: "integer", ...over });
const DIR = "packages/db/migrations";
const tip = ["0710_a", "0711_b", "0712_c"].map((n) => `${DIR}/${n}.sql`);

describe("compileKeyPattern: the ReDoS bound", () => {
  it.each([
    ["nested quantifier", "^(a+)+$"],
    ["nested quantifier through a group", "^((\\d)+)*(\\d)$"],
    ["quantified group holding a bounded repeat", "^(?:\\d{1,9}){1,9}(\\d)$"],
    ["alternation", "^(a|aa)$"],
    ["back-reference", "^(a)\\1$"],
    ["look-ahead", "^(?=a)(a)$"],
    ["look-behind", "^(?<=a)(a)$"],
    ["named group", "^(?<k>a)$"],
    ["lazy quantifier", "^(\\d+?)$"],
    ["three unbounded quantifiers (cost over the limit)", "^(\\d+)\\.(\\d+)\\.(\\d+)$"],
    ["repeat count over 64", "^(\\d{1,65})$"],
    ["not anchored at the start", "(\\d{4})_.+"],
    ["no capture group", "^\\d{4}_.+$"],
    ["two capture groups", "^(\\d{4})_(.+)$"],
    ["unclosed group", "^(\\d{4}"],
    ["longer than the bound", `^(${"a".repeat(130)})$`],
    ["not a string", 42],
    ["four-digit repeat count on a quantified group (reviewer 1)", "^((?:\\d+){1,1000})_"],
    ["four-digit range, open lower (reviewer 2)", "^((?:a+){2,1000}x)"],
    ["four-digit exact count (reviewer 3)", "^((?:a+){1000})x"],
    ["huge count", "^(\\d{1,99999999999999999999})"],
    ["a literal brace", "^(a{)"],
    ["a malformed count", "^(a{,5})"],
    ["a stray closing brace", "^(a})"],
  ])("refuses %s", (_what, src) => {
    expect(compileKeyPattern(src)).toBeNull();
  });

  it("accepts the shapes a migration or a version number needs", () => {
    for (const src of ["^(\\d{4})_.+\\.sql$", "^(\\d+)_.*$", "^v(\\d{1,6})-[a-z]+\\.md$", "^(?:\\d{4}_)?(\\d{4})\\.sql$"]) expect(compileKeyPattern(src), src).toBeInstanceOf(RegExp);
  });

  it("the most expensive accepted pattern finishes quickly on the longest input the check allows, and a longer name is never matched at all", () => {
    const re = compileKeyPattern("^(.*).*x$")!;
    expect(re).toBeInstanceOf(RegExp);
    const input = "a".repeat(MAX_KEY_INPUT);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) re.exec(input);
    expect(performance.now() - t0).toBeLessThan(500);
    const rule = readOrderedConfig({ orderedResources: [entry({ pathPattern: "**", keyPattern: "^(.*).*x$", keyKind: "text" })] }).resources[0]!;
    const t1 = performance.now();
    expect(rule.rawKey(`dir/${"a".repeat(200_000)}`)).toBeNull();
    expect(performance.now() - t1).toBeLessThan(50);
  });
});

describe("compileKeyPattern: fuzz", () => {
  // Random patterns from the alphabet an author would use, with the hostile pieces mixed in. Every accepted one must run quickly on adversarial 256-character names.
  const pieces = ["^", "(", ")", "(?:", "\\d", "\\w", ".", "a", "_", "-", "[a-z]", "[0-9]", "+", "*", "?", "{2}", "{1,9}", "{2,}", "{1,1000}", "{64}", "{65}", "{", "}", "|", "$", "\\."];
  const rng = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  it("every accepted pattern finishes in under 50 ms on a 256-character adversarial name", () => {
    const next = rng(20261102);
    const names = ["0".repeat(MAX_KEY_INPUT), "a".repeat(MAX_KEY_INPUT - 1) + "!", `${"0".repeat(MAX_KEY_INPUT - 1)}.`, "a_".repeat(MAX_KEY_INPUT / 2)];
    let accepted = 0;
    for (let n = 0; n < 40_000; n++) {
      const some = (max: number) => Array.from({ length: Math.floor(next() * max) }, () => pieces[Math.floor(next() * pieces.length)]).join("");
      const src = `^${some(3)}(${some(7)})${some(4)}`;
      const re = compileKeyPattern(src);
      if (!re) continue;
      accepted += 1;
      for (const name of names) {
        const t0 = performance.now();
        re.exec(name);
        expect(performance.now() - t0, src).toBeLessThan(50);
      }
    }
    expect(accepted).toBeGreaterThan(200);
  });
});

describe("readOrderedConfig", () => {
  it("reads a valid entry and defaults autoRenumber to true", () => {
    const c = readOrderedConfig({ orderedResources: [entry()] });
    expect(c).toMatchObject({ configured: true, autoRenumber: true });
    expect(c.resources.map((r) => [r.name, r.keyKind])).toEqual([["migrations", "integer"]]);
    expect(readOrderedConfig({ orderedResources: [entry()], autoRenumber: false }).autoRenumber).toBe(false);
    expect(readOrderedConfig({ autoRenumber: "no" }).autoRenumber).toBe(true);
  });

  it("an absent key is not configured, whatever else the settings hold or are", () => {
    for (const s of [{}, { other: 1 }, null, undefined, "x", []]) expect(readOrderedConfig(s)).toMatchObject({ configured: false, resources: [] });
  });

  it("ignores an invalid entry whole and applies the rest (a bad regex, a long name, a bad kind, a bad glob, a duplicate name, a non-object)", () => {
    const c = readOrderedConfig({
      orderedResources: [entry({ name: "bad-regex", keyPattern: "^(a+)+$" }), entry({ name: "n".repeat(41) }), entry({ name: "bad-kind", keyKind: "float" }), entry({ name: "Docs", pathPattern: "docs/adr/*.md", keyPattern: "^(\\d{3})-.+\\.md$" }), entry({ name: "Docs" })],
    });
    expect(c.resources.map((r) => r.name)).toEqual(["Docs"]);
    const d = readOrderedConfig({ orderedResources: [entry({ name: "bad-glob", pathPattern: "/abs/*" }), "not an object", null, entry({ name: "ok" })] });
    expect(d.resources.map((r) => r.name)).toEqual(["ok"]);
  });

  it("applies the first five entries and ignores a sixth", () => {
    const c = readOrderedConfig({ orderedResources: Array.from({ length: 6 }, (_, i) => entry({ name: `r${i}` })) });
    expect(c.resources.map((r) => r.name)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  });

  it("a value that is not a list is configured with nothing to check", () => {
    expect(readOrderedConfig({ orderedResources: "migrations" })).toMatchObject({ configured: true, resources: [] });
  });
});

describe("globs and the detected default", () => {
  it("* stays in a segment, ** crosses them, and nothing is a regex of the tenant's", () => {
    const g = compileGlob("db/**/*.sql")!;
    expect(["db/a.sql", "db/x/y/a.sql"].every((p) => g(p))).toBe(true);
    expect(["db/a.txt", "other/db/a.sql"].some((p) => g(p))).toBe(false);
    expect(compileGlob("a.b")!("axb")).toBe(false);
    expect(compileGlob("*/*/*/*/*")).toBeNull();
    expect(compileGlob("a**b/x")).toBeNull();
    expect(compileGlob("db/a?.sql")!("db/a1.sql")).toBe(true);
  });

  it("the worst accepted glob on the longest accepted path finishes at once (no backtracking blow-up), and a longer path never matches", () => {
    const worst = compileGlob("*a*a*a*b")!;
    const t0 = performance.now();
    expect(worst("a".repeat(512))).toBe(false);
    expect(worst(`${"a".repeat(300)}b`)).toBe(true);
    expect(worst("a".repeat(513))).toBe(false);
    const deep = compileGlob("**/*a*a")!;
    expect(deep(`${"x/".repeat(200)}${"a".repeat(100)}`)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(10);
  });

  it("a path past the glob's length bound never matches it, and hasUnmatchablePath says so for a configured resource only", () => {
    const cfg = readOrderedConfig({ orderedResources: [{ name: "docs", pathPattern: "docs/**", keyPattern: "^(\\d+)-.+$", keyKind: "integer" }] });
    const long = `docs/${"a/".repeat(260)}1-x.md`;
    expect(cfg.resources[0]!.matches(long)).toBe(false);
    expect(hasUnmatchablePath(cfg.resources, ["docs/1-a.md", long])).toBe(true);
    expect(hasUnmatchablePath(cfg.resources, ["docs/1-a.md", "a".repeat(512)])).toBe(false);
    expect(hasUnmatchablePath(cfg.resources, ["a".repeat(513)])).toBe(true);
    expect(hasUnmatchablePath([], [long])).toBe(false);
    expect(hasUnmatchablePath([detectResource(["db/0001_a.sql", "db/0002_b.sql"])!], [long])).toBe(false);
  });

  it("detects migrations from the directory with at least two NNNN_*.sql files, keyed on the prefix", () => {
    const rule = detectResource([...tip, "packages/other/0001_only.sql", "README.md"])!;
    expect(rule.name).toBe("migrations");
    expect(rule.keyKind).toBe("integer");
    expect(rule.matches(`${DIR}/0713_x.sql`)).toBe(true);
    expect(rule.matches("packages/other/0002_y.sql")).toBe(false);
    expect(rule.rawKey(`${DIR}/0713_x.sql`)).toBe("0713");
    expect(detectResource([`${DIR}/0710_a.sql`, "x/y.sql"])).toBeNull();
    expect(detectResource([])).toBeNull();
  });
});

describe("checkOrdering", () => {
  const rule = detectResource(tip)!;
  const add = (...names: string[]) => names.map((n) => `${DIR}/${n}.sql`);

  it("a key above the highest passes", () => expect(checkOrdering(rule, add("0713_x"), tip)).toEqual({ ok: true }));
  it("0710 under a highest of 0712 fails and names the key and the highest", () => expect(checkOrdering(rule, add("0710_x"), tip)).toEqual({ ok: false, key: "0710", highest: "0712" }));
  it("a key equal to the highest fails (strictly greater)", () => expect(checkOrdering(rule, add("0712_x"), tip)).toMatchObject({ ok: false, key: "0712" }));
  it("a repeated key within the pull request fails", () => expect(checkOrdering(rule, add("0713_a", "0713_b"), tip)).toMatchObject({ ok: false, key: "0713" }));
  it("a file of the resource with no key is not ordered", () => {
    const loose = readOrderedConfig({ orderedResources: [entry({ keyPattern: "^(\\d{4})_.*$" })] }).resources[0]!;
    expect(checkOrdering(loose, [`${DIR}/readme.sql`], tip)).toMatchObject({ ok: false, key: "readme.sql" });
  });
  it("other paths are not this resource's, and a tip with none of the resource accepts any key", () => {
    expect(checkOrdering(rule, ["docs/a.md"], tip)).toEqual({ ok: true });
    expect(checkOrdering(rule, add("0001_first"), [])).toEqual({ ok: true });
  });
  it("text keys compare as text, and 9 is not above 10 as an integer", () => {
    const text = readOrderedConfig({ orderedResources: [entry({ pathPattern: "n/*", keyPattern: "^([a-z]+)\\.md$", keyKind: "text" })] }).resources[0]!;
    expect(checkOrdering(text, ["n/b.md"], ["n/a.md", "n/c.md"])).toMatchObject({ ok: false, key: "b", highest: "c" });
    expect(parseKey("9", "integer")).toBe(9);
    expect(Number(parseKey("9", "integer")) < Number(parseKey("10", "integer"))).toBe(true);
    expect(parseKey("1e3", "integer")).toBeNull();
    expect(parseKey("", "text")).toBeNull();
  });
});
