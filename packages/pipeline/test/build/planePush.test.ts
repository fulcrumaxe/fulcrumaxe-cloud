import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_SCAN_BYTES,
  compileOverlay,
  malformedPathReason,
  parseIdentifierRules,
  parsePlanData,
  scanPlanePush,
  scanText,
  SourceRefusal,
  type ChangedPath,
  type PlanePushInput,
} from "../../src/build/planePush.js";

/**
 * The pure pre-push scan, against an in-memory commit view. The git adapter has
 * its own file (planePushGit.test.ts) that runs the same scan over real objects.
 * Fixture values are invented; none is a real identifier or plan figure.
 */

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const IDENTIFIER_RULES = `# example rules
=== FORBIDDEN_PATTERNS_START ===
acme-internal-host
corp\\.example/private-repo([^-A-Za-z0-9_]|$)
=== FORBIDDEN_PATTERNS_END ===
=== PATH_EXEMPT_START ===
corp\\.example/private-repo([^-A-Za-z0-9_]|$)\tdb/migrations/\tapplied migrations are checksummed
=== PATH_EXEMPT_END ===
`;
const PLAN_DATA = JSON.stringify({ plans: { basic: { priceUsdPerMonth: 7391, rate: 0.4375, tiers: [8123] } } });

function file(path: string, text: string, over: Partial<ChangedPath> = {}): { change: ChangedPath; blob: Uint8Array } {
  const lines = text.split("\n").length;
  return {
    change: { path, mode: "100644", deleted: false, existedAtBase: false, binary: false, size: text.length, addedLines: Array.from({ length: lines }, (_, i) => i + 1), ...over },
    blob: enc(text),
  };
}

function input(files: Array<{ change: ChangedPath; blob: Uint8Array }>, over: Partial<PlanePushInput> = {}, rules: Record<string, string> = {}): PlanePushInput {
  return {
    overlay: ["docs/ops/", ".team/**", "private.txt"],
    readRuleFile: async (p) => (p in rules ? enc(rules[p] as string) : null),
    source: { changes: async () => files.map((f) => f.change), readBlob: async (i) => files[i]?.blob ?? new Uint8Array() },
    ...over,
  };
}

const kinds = (r: Awaited<ReturnType<typeof scanPlanePush>>): string[] => r.refusals.map((x) => x.kind);

describe("overlay list", () => {
  it("is required: an empty or malformed list refuses before anything is scanned", async () => {
    for (const overlay of [[], ["/abs/"], ["a/../b"], [" pad"], ["a\\b"], [""]]) {
      const r = await scanPlanePush(input([file("src/a.ts", "x")], { overlay }));
      expect(r.ok).toBe(false);
      expect(kinds(r)).toEqual(["overlay_list_invalid"]);
      expect(r.scans.files).toBe(0);
    }
  });

  it("matches prefix, exact and glob entries, ignoring case, and lets other paths through", () => {
    const o = compileOverlay(["docs/ops/", "private.txt", "src/**/secret.ts", "*.local", "a/?.md"]);
    if ("error" in o) throw new Error(o.error);
    const hit = ["docs/ops/a.md", "DOCS/Ops/x/y", "private.txt", "src/secret.ts", "src/a/b/secret.ts", "x.local", "d/x.local", "a/b.md", "a/&.md"];
    const miss = ["docs/opsx/a.md", "private.txt.bak", "sub/private.txt", "src/a/secret.tsx", "d/x.local.bak", "a/bc.md", "docs/ops"];
    for (const p of hit) expect(o.match(p), p).toBe(true);
    for (const p of miss) expect(o.match(p), p).toBe(false);
  });

  it("globs follow shell case rules: * and ? cross a slash, and a bracket expression is rejected", () => {
    const o = compileOverlay(["a/*.md", "x?y"]);
    if ("error" in o) throw new Error(o.error);
    expect(o.match("a/b/c.md")).toBe(true);
    expect(o.match("x/y")).toBe(true);
    for (const bad of ["a/[bc].md", "a/b]"]) expect(compileOverlay([bad])).toHaveProperty("error");
  });

  it("refuses an overlay path by name, including a deletion, and a clean path passes", async () => {
    const r = await scanPlanePush(input([file("docs/ops/plan.md", "x"), file(".team/a/b", "x", { deleted: true, size: 0 }), file("src/ok.ts", "fine")]));
    expect(kinds(r)).toEqual(["overlay_path", "overlay_path"]);
    expect(r.refusals.map((x) => x.path)).toEqual(["docs/ops/plan.md", ".team/a/b"]);
    expect((await scanPlanePush(input([file("src/ok.ts", "fine")]))).ok).toBe(true);
  });
});

describe("always-on refusals", () => {
  it("refuses malformed paths without echoing them raw", async () => {
    const bad = ["", "/abs", "a//b", "a/./b", "a/../b", "a/", "x/.GIT/config", 'q"uote', "back\\slash", "ctl\u0007char", "nl\nine"];
    for (const p of bad) expect(malformedPathReason(p), JSON.stringify(p)).not.toBeNull();
    expect(malformedPathReason("src/a b.ts")).toBeNull();
    const r = await scanPlanePush(input([file("ctl\u0007char", "x")]));
    expect(kinds(r)).toEqual(["malformed_path"]);
    expect(JSON.stringify(r)).not.toContain("\u0007");
  });

  it("refuses binary files (flagged or holding a NUL), files over the limit, and submodules; a deletion is not scanned", async () => {
    const r = await scanPlanePush(
      input([
        file("a.bin", "x", { binary: true }),
        { change: file("b.dat", "").change, blob: new Uint8Array([104, 0, 105]) },
        file("big.txt", "x", { size: MAX_SCAN_BYTES + 1 }),
        file("sub", "", { mode: "160000" }),
        file("gone.bin", "", { deleted: true, binary: true, size: 0 }),
        file("edge.txt", "x", { size: MAX_SCAN_BYTES }),
      ]),
    );
    expect(kinds(r)).toEqual(["binary_file", "binary_file", "file_too_large", "submodule"]);
  });

  it("refuses a commit that changes nothing, and a reader that throws", async () => {
    expect(kinds(await scanPlanePush(input([])))).toEqual(["no_changes"]);
    const boom = await scanPlanePush(input([], { source: { changes: async () => { throw new Error("git exploded\nsecond line"); }, readBlob: async () => new Uint8Array() } }));
    expect(boom.ok).toBe(false);
    expect(boom.refusals.at(-1)).toMatchObject({ kind: "scan_failed", message: expect.stringContaining("git exploded") });
    const noBlob = await scanPlanePush(input([file("a.ts", "x")], { source: { changes: async () => [file("a.ts", "x").change], readBlob: async () => { throw new Error("gone"); } } }));
    expect(kinds(noBlob)).toEqual(["scan_failed"]);
  });

  it("with no rule file declared only the always-on refusals run, and the result says so", async () => {
    const r = await scanPlanePush(input([file("src/a.ts", "acme-internal-host 7391")]));
    expect(r.ok).toBe(true);
    expect(r.scans).toMatchObject({ identifierRules: "not_declared", planData: "not_declared", files: 1 });
  });

  it("lists at most 100 refusals and counts the rest", async () => {
    const files = Array.from({ length: 130 }, (_, i) => file(`docs/ops/${i}.md`, "x"));
    const r = await scanPlanePush(input(files));
    expect(r.refusals).toHaveLength(100);
    expect(r.omitted).toBe(30);
    expect(r.ok).toBe(false);
  });
});

describe("declared rule files fail closed", () => {
  const declared = { ruleFiles: { identifierRules: "rules/ids.txt", planData: "rules/plan.json" } };

  it("a declared file that is missing refuses and names the file", async () => {
    const r = await scanPlanePush(input([file("src/a.ts", "ok")], declared, { "rules/plan.json": PLAN_DATA }));
    expect(r.refusals).toEqual([expect.objectContaining({ kind: "rule_file_missing", path: "rules/ids.txt" })]);
    expect(r.scans.planData).toBe("applied");
  });

  it("an unparseable, vacuous or untranslatable file refuses", async () => {
    const bad: Array<[string, string]> = [
      ["{not json", PLAN_DATA],
      ["=== FORBIDDEN_PATTERNS_START ===\n=== FORBIDDEN_PATTERNS_END ===\n", PLAN_DATA],
      ["=== FORBIDDEN_PATTERNS_START ===\n(unclosed\n=== FORBIDDEN_PATTERNS_END ===\n", PLAN_DATA],
      ["=== FORBIDDEN_PATTERNS_START ===\na*\n=== FORBIDDEN_PATTERNS_END ===\n", PLAN_DATA],
      ["=== FORBIDDEN_PATTERNS_START ===\n{SELF_LOGIN}\n=== FORBIDDEN_PATTERNS_END ===\n", PLAN_DATA],
      ["=== FORBIDDEN_PATTERNS_START ===\nx[[=a=]]\n=== FORBIDDEN_PATTERNS_END ===\n", PLAN_DATA],
      [IDENTIFIER_RULES, '{"plans":{"a":{"b":0}},"flag":true}'],
      [IDENTIFIER_RULES, "[1,"],
    ];
    for (const [ids, plan] of bad) {
      const r = await scanPlanePush(input([file("src/a.ts", "ok")], declared, { "rules/ids.txt": ids, "rules/plan.json": plan }));
      expect(r.ok, ids).toBe(false);
      expect(kinds(r)).toEqual(["rule_file_invalid"]);
    }
  });

  it("a reader error on a declared file refuses", async () => {
    const r = await scanPlanePush(input([file("src/a.ts", "ok")], { ...declared, readRuleFile: async () => { throw new Error("EIO"); } }));
    expect(kinds(r)).toEqual(["scan_failed"]);
  });
});

describe("identifier rules", () => {
  const withRules = (files: Array<{ change: ChangedPath; blob: Uint8Array }>) => input(files, { ruleFiles: { identifierRules: "ids" } }, { ids: IDENTIFIER_RULES });

  it("names file, line and rule key on an added line, and never the matched text", async () => {
    const r = await scanPlanePush(withRules([file("src/a.ts", "clean\nconst h = 'acme-internal-host';\n")]));
    expect(r.refusals).toEqual([expect.objectContaining({ kind: "identifier_hit", path: "src/a.ts", line: 2, rule: "identifier-rule#1" })]);
    expect(JSON.stringify(r)).not.toContain("acme-internal-host");
  });

  it("scans only added lines", async () => {
    const r = await scanPlanePush(withRules([file("src/a.ts", "acme-internal-host\nclean", { addedLines: [2] })]));
    expect(r.ok).toBe(true);
  });

  it("translates a negated class that holds the trailing context", async () => {
    const hit = await scanPlanePush(withRules([file("a.md", "see corp.example/private-repo) and corp.example/private-repo")]));
    expect(hit.refusals.map((x) => x.rule)).toEqual(["identifier-rule#2"]);
    const miss = await scanPlanePush(withRules([file("a.md", "see corp.example/private-repo-public and corp.example/private-repo_x")]));
    expect(miss.ok).toBe(true);
  });

  it("translates only what grep -E reads identically, and refuses the rest as an invalid rule file", () => {
    const wrap = (p: string): string => `=== FORBIDDEN_PATTERNS_START ===\n${p}\n=== FORBIDDEN_PATTERNS_END ===\n`;
    const refused = [
      "\\<foo", "foo\\>", "\\bfoo", "\\Bfoo", "\\wfoo", "\\Wfoo", "\\sfoo", "\\Sfoo", "foo\\'", "foo\\`", "(foo)\\1", "foo\\q", "foo\\",
      "a{,3}b", "a{x}", "a{2,1}", "a{99999}", "{2}a", "(a|{2})", "a}", "foo{", "a+?b", "a**", "a*+", "a{2}?", "a{2}{3}", "*a", "(?:foo)", "(?=foo)", "(?<n>foo)", "(foo", "foo)",
    ];
    for (const p of refused) expect(parseIdentifierRules(wrap(p)), p).toHaveProperty("error");
    const kept: Array<[string, string, boolean]> = [
      ["fo{2}x", "foox", true], ["fo{2}x", "fox", false], ["fo{2,}x", "fooox", true], ["fo{1,2}x", "fooox", false],
      ["a\\.b", "a.b", true], ["a\\.b", "axb", false], ["a\\-b", "a-b", true], ["a\\/b", "a/b", true], ["(ab|cd)+e", "xcdabe", true],
      ["^foo$", "foo", true], ["^foo$", "xfoo", false], ["foo(bar)?baz", "foobaz", true], ["a.c", "a c", true],
    ];
    for (const [pattern, line, expected] of kept) {
      const parsed = parseIdentifierRules(wrap(pattern));
      if (!("rules" in parsed)) throw new Error(`${pattern} was refused`);
      expect(parsed.rules[0]?.rx.test(line), `${pattern} on ${JSON.stringify(line)}`).toBe(expected);
    }
  });

  it("a file name that matches a rule refuses once, is named by ordinal, and is never echoed", async () => {
    const files = [file("src/acme-internal-host.ts", "fine"), file("img/acme-internal-host.bin", "x", { binary: true }), file("src/ok.ts", "fine")];
    const r = await scanPlanePush(withRules(files));
    expect(r.refusals.map((x) => `${x.kind} ${x.path} ${x.rule}`)).toEqual([
      "identifier_hit changed path #1 identifier-rule#1",
      "identifier_hit changed path #2 identifier-rule#1",
    ]);
    expect(JSON.stringify(r)).not.toContain("acme-internal-host");
    // A name already public at the base is not a new refusal, but is still never echoed when something else refuses.
    const old = await scanPlanePush(withRules([file("src/acme-internal-host.ts", "x", { existedAtBase: true, binary: true })]));
    expect(old.refusals.map((x) => `${x.kind} ${x.path}`)).toEqual(["binary_file changed path #1"]);
    expect((await scanPlanePush(withRules([file("src/acme-internal-host.ts", "fine", { existedAtBase: true })]))).ok).toBe(true);
  });

  it("PATH_EXEMPT switches a rule off only for a file that already existed at the base", async () => {
    const line = "-- corp.example/private-repo\n";
    expect((await scanPlanePush(withRules([file("db/migrations/0001.sql", line, { existedAtBase: true })]))).ok).toBe(true);
    expect(kinds(await scanPlanePush(withRules([file("db/migrations/0002.sql", line)])))).toEqual(["identifier_hit"]);
    expect(kinds(await scanPlanePush(withRules([file("src/0001.sql", line, { existedAtBase: true })])))).toEqual(["identifier_hit"]);
  });

  it("a PREPUSH_EXEMPT pattern is not enforced, and one naming no declared pattern refuses", () => {
    const base = "=== FORBIDDEN_PATTERNS_START ===\nfoo\nbar\n=== FORBIDDEN_PATTERNS_END ===\n";
    const ok = parseIdentifierRules(`${base}=== PREPUSH_EXEMPT_START ===\nfoo\tdocs only\n=== PREPUSH_EXEMPT_END ===\n`);
    expect("rules" in ok && ok.rules.map((r) => r.key)).toEqual(["identifier-rule#2"]);
    expect(parseIdentifierRules(`${base}=== PREPUSH_EXEMPT_START ===\nnope\twhy\n=== PREPUSH_EXEMPT_END ===\n`)).toHaveProperty("error");
    expect(parseIdentifierRules(`${base}=== PATH_EXEMPT_START ===\nfoo\tdocs\twhy\n=== PATH_EXEMPT_END ===\n`)).toHaveProperty("error");
  });
});

describe("plan data", () => {
  const withPlan = (files: Array<{ change: ChangedPath; blob: Uint8Array }>) => input(files, { ruleFiles: { planData: "plan" } }, { plan: PLAN_DATA });

  it("refuses a figure written next to its key and names the key path, not the figure", async () => {
    for (const text of ["priceUsdPerMonth: 7391", '"priceUsdPerMonth" = 7391.0', "rate: 0.4375", "{ tiers: 8123 }"]) {
      const r = await scanPlanePush(withPlan([file("src/a.ts", `// header\n${text}`, { addedLines: [2] })]));
      expect(kinds(r), text).toContain("plan_data_hit");
      expect(r.refusals[0]).toMatchObject({ path: "src/a.ts", line: 2 });
      expect(JSON.stringify(r)).not.toMatch(/7391|0\.4375|8123/);
    }
  });

  it("refuses the figure in money form, as cents, and as a long bare literal", async () => {
    const cases: Array<[string, string]> = [
      ["costs $7391 a month", "plans.basic.priceUsdPerMonth"],
      ["7391 USD", "plans.basic.priceUsdPerMonth"],
      ["7391/mo", "plans.basic.priceUsdPerMonth"],
      ["739100 cents", "plans.basic.priceUsdPerMonth"],
      ["const x = 7391;", "plans.basic.priceUsdPerMonth"],
      ["const y = 0.4375;", "plans.basic.rate"],
    ];
    for (const [text, kp] of cases) {
      const r = await scanPlanePush(withPlan([file("src/a.ts", text)]));
      expect(r.refusals.map((x) => x.rule), text).toContain(kp);
    }
  });

  it("does not flag small numbers, other numbers, or hits on lines the commit did not add", async () => {
    for (const text of ["retries: 3", "const n = 7390;", "id: 17391", "price: 7391abc", "$1, $2"]) {
      expect((await scanPlanePush(withPlan([file("src/a.ts", text)]))).ok, text).toBe(true);
    }
    expect((await scanPlanePush(withPlan([file("src/a.ts", "priceUsdPerMonth: 7391\nok", { addedLines: [2] })]))).ok).toBe(true);
  });

  it("skips the free-text rules for a lockfile but still applies the key-and-value rule", async () => {
    expect((await scanPlanePush(withPlan([file("pnpm-lock.yaml", "version 7391")]))).ok).toBe(true);
    expect((await scanPlanePush(withPlan([file("pnpm-lock.yaml", "priceUsdPerMonth: 7391")]))).ok).toBe(false);
  });

  it("derives the key of a list element from its parent", () => {
    const plan = parsePlanData(PLAN_DATA);
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.keyed.map((k) => [k.path, k.key])).toContainEqual(["plans.basic.tiers.0", "tiers"]);
  });
});

describe("published text", () => {
  it("scans every line of a title, body or message with the same rules", () => {
    const ids = parseIdentifierRules(IDENTIFIER_RULES);
    const plan = parsePlanData(PLAN_DATA);
    if ("error" in ids || "error" in plan) throw new Error("fixture");
    const hits = scanText("pr-body", "fine\nmentions acme-internal-host\nand $7391 too", { identifierRules: ids, planData: plan });
    expect(hits.map((h) => `${h.path}:${h.line}:${h.rule}`)).toEqual(["pr-body:2:identifier-rule#1", "pr-body:3:plans.basic.priceUsdPerMonth"]);
    expect(scanText("pr-title", "a plain title", { identifierRules: ids, planData: plan })).toEqual([]);
  });

  it("matches a line with its carriage return kept, so a rule ending in a negated class sees CRLF text", () => {
    const ids = parseIdentifierRules("=== FORBIDDEN_PATTERNS_START ===\nsecret-host[^a-z]\n=== FORBIDDEN_PATTERNS_END ===\n");
    if ("error" in ids) throw new Error("fixture");
    // the rule needs one more character after the name; at the end of a CRLF line only the kept \r supplies it
    expect(scanText("pr-body", "see secret-host\r\nnext", { identifierRules: ids }).map((h) => `${h.line}`)).toEqual(["1"]);
    expect(scanText("pr-body", "see secret-host\nnext", { identifierRules: ids })).toEqual([]);
  });
});

describe("round 3: names, identity, exact regex, normalisation", () => {
  const withRules = (files: Array<{ change: ChangedPath; blob: Uint8Array }>, over: Partial<PlanePushInput> = {}) => input(files, { ruleFiles: { identifierRules: "ids" }, ...over }, { ids: IDENTIFIER_RULES });
  const wrap = (p: string): string => `=== FORBIDDEN_PATTERNS_START ===\n${p}\n=== FORBIDDEN_PATTERNS_END ===\n`;
  const compiled = (p: string): RegExp => {
    const parsed = parseIdentifierRules(wrap(p));
    if (!("rules" in parsed)) throw new Error(`${p} was refused`);
    return (parsed.rules[0] as { rx: RegExp }).rx;
  };

  it("file names are an allowlist of printable characters; anything else is malformed_path", async () => {
    for (const p of ["a​b.ts", "a b.ts", "a‮b.ts", "a b", "ab", "a\ud800b", "a\u0085b", "a\tb"]) expect(malformedPathReason(p), JSON.stringify(p)).not.toBeNull();
    for (const p of ["src/é/日本語.ts", "src/emoji\u{1f600}.ts", "src/a b.ts", "src/Ωmega-x_y+z.ts"]) expect(malformedPathReason(p), p).toBeNull();
    const r = await scanPlanePush(input([file("src/a​b.ts", "x")]));
    expect(kinds(r)).toEqual(["malformed_path"]);
    expect(JSON.stringify(r)).not.toContain("​");
  });

  it("an entry whose name is not valid UTF-8 refuses by ordinal, is never read, and its placeholder is not echoed", async () => {
    let reads = 0;
    const bad = file("placeholder", "x", { nameInvalid: true });
    const r = await scanPlanePush(input([bad], { source: { changes: async () => [bad.change], readBlob: async () => (reads++, bad.blob) } }));
    expect(r.refusals).toEqual([expect.objectContaining({ kind: "malformed_path", path: "changed path #1" })]);
    expect(JSON.stringify(r)).not.toContain("placeholder");
    expect(reads).toBe(0);
  });

  it("two entries with one name after NFC refuse, and each blob is still read by its own index", async () => {
    const clean = file("src/é.ts", "clean");
    const leak = file("src/é.ts", "const h = 'acme-internal-host';");
    const r = await scanPlanePush(withRules([clean, leak]));
    expect(r.refusals.map((x) => `${x.kind} ${x.path}`)).toEqual(["malformed_path changed path #2", "identifier_hit changed path #2"]);
    expect(r.scans.files).toBe(2);
    const reversed = await scanPlanePush(withRules([leak, clean]));
    expect(kinds(reversed).sort()).toEqual(["identifier_hit", "malformed_path"]);
  });

  it("the result carries the scanned commit when the source reports one, and a named source refusal is kept", async () => {
    const f = file("src/a.ts", "fine");
    const sha = "a".repeat(40);
    const ok = await scanPlanePush(input([f], { source: { changes: async () => [f.change], readBlob: async () => f.blob, scanned: () => ({ commit: sha, base: "b".repeat(40) }) } }));
    expect(ok.scanned).toEqual({ commit: sha, base: "b".repeat(40) });
    expect((await scanPlanePush(input([f]))).scanned).toBeUndefined();
    const refused = await scanPlanePush(input([f], { source: { changes: async () => { throw new SourceRefusal("bad_ancestry", "merge commit"); }, readBlob: async () => f.blob } }));
    expect(refused.refusals).toEqual([{ kind: "bad_ancestry", message: "merge commit" }]);
    expect(refused.scanned).toBeUndefined();
  });

  it("compiles with the u flag: . and a negated class consume one astral character", () => {
    const dot = compiled("acme.internal");
    expect(dot.test("acme\u{1f600}internal")).toBe(true);
    expect(dot.test("acme\u{1f600}\u{1f600}internal")).toBe(false);
    expect(compiled("acme[^a-z]internal").test("acme\u{1f600}internal")).toBe(true);
    expect(compiled("acme\u{1f600}+x").test("acme\u{1f600}\u{1f600}x")).toBe(true);
  });

  it("POSIX classes: only the locale-independent ones translate; the others refuse", () => {
    for (const c of ["alpha", "alnum", "upper", "lower", "punct", "space", "blank", "cntrl", "graph", "print"]) expect(parseIdentifierRules(wrap(`a[[:${c}:]]b`)), c).toHaveProperty("error");
    expect(compiled("a[[:digit:]]b").test("a7b")).toBe(true);
    expect(compiled("a[[:digit:]]b").test("a٣b")).toBe(false);
    expect(compiled("a[[:xdigit:]]b").test("aFb")).toBe(true);
    expect(compiled("a[^[:digit:]]b").test("aéb")).toBe(true);
  });

  it("a rule that is not NFKC-stable refuses", () => {
    expect(parseIdentifierRules(wrap("acme-ﬁle"))).toHaveProperty("error");
  });

  it("matches fullwidth, U+2010 and NFD spellings in names and in lines", async () => {
    const variants = ["ａｃｍｅ-internal-host", "acme‐internal‐host", "acme‑internal-host", "acme－internal-host"];
    for (const v of variants) {
      const named = await scanPlanePush(withRules([file(`src/${v}.ts`, "fine")]));
      expect(kinds(named), `name ${JSON.stringify(v)}`).toEqual(["identifier_hit"]);
      const lined = await scanPlanePush(withRules([file("src/a.ts", `const h = '${v}';`)]));
      expect(kinds(lined), `line ${JSON.stringify(v)}`).toEqual(["identifier_hit"]);
    }
    const nfd = "=== FORBIDDEN_PATTERNS_START ===\ncafé-host\n=== FORBIDDEN_PATTERNS_END ===\n";
    const r = await scanPlanePush(input([file("src/a.ts", "x = 'café-host'")], { ruleFiles: { identifierRules: "ids" } }, { ids: nfd }));
    expect(kinds(r)).toEqual(["identifier_hit"]);
    expect(kinds(await scanPlanePush(input([file("src/café-host.ts", "x")], { ruleFiles: { identifierRules: "ids" } }, { ids: nfd })))).toEqual(["identifier_hit"]);
    const ids = parseIdentifierRules(IDENTIFIER_RULES);
    if ("error" in ids) throw new Error("fixture");
    expect(scanText("pr-body", "mentions ａｃｍｅ-internal-host", { identifierRules: ids }).map((h) => h.kind)).toEqual(["identifier_hit"]);
  });

  it("size and binary checks use the original bytes", async () => {
    const f = file("src/a.ts", "x");
    const r = await scanPlanePush(withRules([{ change: f.change, blob: new Uint8Array([97, 0, 98]) }]));
    expect(kinds(r)).toEqual(["binary_file"]);
  });
});

describe("module shape", () => {
  it("the pure module imports nothing, so it reads no file and runs no process", () => {
    const src = readFileSync(new URL("../../src/build/planePush.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(|process\.|import\.meta|__dirname/);
  });
});
