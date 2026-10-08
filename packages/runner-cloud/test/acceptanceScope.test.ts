import { describe, expect, it } from "vitest";
import { MAX_SCOPE_ENTRIES, loadAcceptanceScope, parseAcceptanceScope, pathInScope, pathsOutsideScope, type TenantQueryable } from "../src/acceptanceScope.js";

/** D#6 R2b-3e (C21 section 5): the scope matcher. Three entry forms, nothing else, and anything it cannot read is `unknown`. */
const UNKNOWN = { kind: "unknown" };
const scope = (...entries: string[]) => parseAcceptanceScope(entries);
const inScope = (entries: string[], path: string) => pathInScope(scope(...entries), path);

describe("parseAcceptanceScope", () => {
  it("reads the three forms: an exact path, dir/**, and * inside one segment", () => {
    expect(scope("packages/web/src/page.ts", "docs/**", "src/*.ts")).toEqual({ kind: "known", entries: ["packages/web/src/page.ts", "docs/**", "src/*.ts"] });
  });

  it("reads Next.js route paths as exact paths: groups, dynamic segments and catch-alls", () => {
    expect(scope("apps/web/app/(shop)/[id]/page.tsx", "apps/web/app/api/[...rest]/route.ts", "apps/web/app/[[...slug]]/page.tsx")).toMatchObject({ kind: "known" });
    expect(inScope(["apps/web/app/api/runners/runs/[id]/approve/route.ts"], "apps/web/app/api/runners/runs/[id]/approve/route.ts")).toBe(true);
    // Brackets are literal, never a character class.
    expect(inScope(["src/[ab].ts"], "src/a.ts")).toBe(false);
  });

  it("an entry of any other shape makes the WHOLE scope unknown, not a partly checked one", () => {
    const bad = [
      "", " ", "/abs/path", "dir/", "./a.ts", "a/./b.ts", "a/../b.ts", "..", "**", "**/a.ts", "a/**/b.ts", "a/b**", "a**/b", "a/***",
      "a/?.ts", "a/[ab].ts", "a/[x", "a/x]", "a/[a b]", "a/[..]/b", "a\\b.ts", "a b.ts", "a/b.ts\n", "a/\u0000", "a//b.ts", "a/b.ts#x", "a/b.ts?x", "a/$HOME", "!a.ts", "a,{b}", "~/x", "x".repeat(513),
    ];
    for (const entry of bad) expect(scope("fine/ok.ts", entry), JSON.stringify(entry)).toEqual(UNKNOWN);
  });

  describe("brace groups (C23 section 1)", () => {
    const expandedOf = (...entries: string[]) => (scope(...entries) as unknown as { entries: string[] }).entries;
    const RUNNER = "apps/web/app/api/runner";

    it("the Spec's real entries: one group, two groups, a group next to a Next.js segment, a group in a directory segment", () => {
      const s = scope("test/{fence,probes,pack-lint,manifest}.test.ts");
      for (const name of ["fence", "probes", "pack-lint", "manifest"]) expect(pathInScope(s, `test/${name}.test.ts`), name).toBe(true);
      for (const path of ["test/other.test.ts", "test/fence.test.tsx", "test/fence,probes.test.ts", "test/.test.ts", "test/fence.test.ts/x"]) expect(pathInScope(s, path), path).toBe(false);

      const ops = scope("scripts/ops/live-e2e-owner-setup.{sh,mjs,test.mjs}");
      for (const ext of ["sh", "mjs", "test.mjs"]) expect(pathInScope(ops, `scripts/ops/live-e2e-owner-setup.${ext}`), ext).toBe(true);
      expect(pathInScope(ops, "scripts/ops/live-e2e-owner-setup.js")).toBe(false);

      const two = scope(`${RUNNER}/{register,rotate,revoke,hello}/{route,handler}.ts`);
      expect(expandedOf(`${RUNNER}/{register,rotate,revoke,hello}/{route,handler}.ts`)).toHaveLength(8);
      for (const op of ["register", "rotate", "revoke", "hello"]) for (const file of ["route", "handler"]) expect(pathInScope(two, `${RUNNER}/${op}/${file}.ts`), `${op} ${file}`).toBe(true);
      for (const path of [`${RUNNER}/claim/route.ts`, `${RUNNER}/register/other.ts`, `${RUNNER}/register/route.tsx`, `${RUNNER}/register/route.ts/x`]) expect(pathInScope(two, path), path).toBe(false);

      const dynamic = scope(`${RUNNER}/runs/[id]/{events,done}/route.ts`);
      expect(pathInScope(dynamic, `${RUNNER}/runs/[id]/events/route.ts`)).toBe(true);
      expect(pathInScope(dynamic, `${RUNNER}/runs/[id]/done/route.ts`)).toBe(true);
      expect(pathInScope(dynamic, `${RUNNER}/runs/42/events/route.ts`)).toBe(false);

      const dirs = scope("packages/{a,b}/**");
      expect(pathInScope(dirs, "packages/a/x/y.ts")).toBe(true);
      expect(pathInScope(dirs, "packages/b/z.ts")).toBe(true);
      expect(pathInScope(dirs, "packages/c/z.ts")).toBe(false);
      expect(pathInScope(dirs, "packages/a")).toBe(false);
    });

    it("a two-group entry expands to every combination", () => {
      expect(expandedOf("{register,rotate}/{route,handler}.ts")).toEqual(["register/route.ts", "register/handler.ts", "rotate/route.ts", "rotate/handler.ts"]);
      expect(expandedOf("a/{x,y}-{1,2}-{p,q}.ts")).toHaveLength(8);
      // A group may sit in any segment, the first and the last included, and may be mixed with `*`.
      expect(expandedOf("{src,lib}/*.{ts,js}")).toEqual(["src/*.ts", "src/*.js", "lib/*.ts", "lib/*.js"]);
    });

    it("alternatives are literal text: one that holds a slash, star, question mark, bracket or parenthesis, or is empty, makes the scope unknown", () => {
      for (const entry of ["a/{b,c/d}.ts", "a/{b,*}.ts", "a/{b,c*}.ts", "a/{b,?}.ts", "a/{b,[c]}.ts", "a/{b,(c)}.ts", "a/{b,}.ts", "a/{,b}.ts", "a/{b,,c}.ts", "a/{b,c**}"]) {
        expect(scope(entry), entry).toEqual(UNKNOWN);
      }
    });

    it("still unknown: a one-alternative group, an empty group, an unclosed or stray brace, a nested group, ? and a non-final **", () => {
      for (const entry of ["{a}", "a/{a}.ts", "a/{a,}.ts", "a/{}.ts", "a/{.ts", "a/}.ts", "a/{b,c.ts", "a/b,c}.ts", "a/{b,c}}.ts", "a/{{b,c}}.ts", "a/{b,{c,d}}.ts", "a/{b,c{d,e}}.ts", "a/b?.ts", "a/{b,c}?.ts", "a/**/b.ts", "a/{b,c}/**/d.ts", "**/{b,c}.ts", "a/{b,c}**"]) {
        expect(scope(entry), entry).toEqual(UNKNOWN);
      }
    });

    it("a group inside a Next.js segment is unknown; a group in another segment of the same entry is fine", () => {
      for (const entry of ["app/[{a,b}]/page.tsx", "app/[[...{a,b}]]/page.tsx", "app/({a,b})/page.tsx", "app/[id{a,b}]/page.tsx", "app/({a,b}x)/page.tsx"]) expect(scope(entry), entry).toEqual(UNKNOWN);
      expect(scope("app/[id]/{a,b}/page.tsx")).toMatchObject({ kind: "known" });
      expect(scope("app/{a,b}/(group)/page.tsx")).toMatchObject({ kind: "known" });
    });

    it("every expanded pattern must itself be one of the three forms: one bad product makes the whole scope unknown", () => {
      expect(scope("a/{b,..}/c.ts")).toEqual(UNKNOWN);
      expect(scope("a/{b,.}/c.ts")).toEqual(UNKNOWN);
      expect(scope("{a,}")).toEqual(UNKNOWN);
      expect(scope("a/b/{**,c}")).toEqual(UNKNOWN);
    });

    it("caps: 64 patterns from one entry and 1,024 for the whole list; one over either is unknown", () => {
      const group = (n: number, tag: string) => `{${Array.from({ length: n }, (_, i) => `${tag}${i}`).join(",")}}`;
      // 64 = 8 x 8 is the largest entry; 65 and 2 x 33 are over.
      expect(scope(`a/${group(8, "x")}-${group(8, "y")}.ts`)).toMatchObject({ kind: "known" });
      expect(expandedOf(`a/${group(8, "x")}-${group(8, "y")}.ts`)).toHaveLength(64);
      expect(scope(`a/${group(64, "x")}.ts`)).toMatchObject({ kind: "known" });
      expect(scope(`a/${group(65, "x")}.ts`)).toEqual(UNKNOWN);
      expect(scope(`a/${group(2, "x")}-${group(33, "y")}.ts`)).toEqual(UNKNOWN);
      // A list of 16 full entries is exactly 1,024; one more pattern anywhere is over.
      const full = Array.from({ length: 16 }, (_, i) => `d${i}/${group(64, "f")}.ts`);
      expect(parseAcceptanceScope(full)).toMatchObject({ kind: "known" });
      expect((parseAcceptanceScope(full) as unknown as { entries: string[] }).entries).toHaveLength(1024);
      expect(parseAcceptanceScope([...full, "one.ts"])).toEqual(UNKNOWN);
      expect(parseAcceptanceScope([...full.slice(0, 15), `d15/${group(63, "f")}.ts`, "one.ts"])).toMatchObject({ kind: "known" });
      expect(parseAcceptanceScope([...full.slice(0, 15), `d15/${group(63, "f")}.ts`, "one.ts", "two.ts"])).toEqual(UNKNOWN);
      // The caps count patterns, so many plain entries are held by MAX_SCOPE_ENTRIES instead.
      expect(parseAcceptanceScope(new Array(MAX_SCOPE_ENTRIES).fill("a.ts"))).toMatchObject({ kind: "known" });
    });

    it("the expansion cannot be used to blow up: many groups stop at the cap before anything is built", () => {
      const many = "a/" + Array.from({ length: 80 }, () => "{x,y}").join("") + ".ts";
      expect(many.length).toBeLessThan(513);
      expect(scope(many)).toEqual(UNKNOWN);
    });
  });

  describe("Next.js segment names are literal (C23 section 2)", () => {
    it("(name), [name], [...name] and [[...name]] as a WHOLE segment, name = [A-Za-z0-9_-]+, match only themselves, byte for byte and case sensitive", () => {
      const s = scope("app/(marketing)/[[...slug]]/page.tsx");
      expect(pathInScope(s, "app/(marketing)/[[...slug]]/page.tsx")).toBe(true);
      for (const path of ["app/marketing/[[...slug]]/page.tsx", "app/(Marketing)/[[...slug]]/page.tsx", "app/(marketing)/slug/page.tsx", "app/(marketing)/[[...slug]]/a/page.tsx", "app/(marketing)/x/y/page.tsx"]) expect(pathInScope(s, path), path).toBe(false);
      const t = scope("apps/web/app/api/runner/runs/[id]/{events,done}/route.ts", "app/[slug]/[...rest]/x.ts", "app/(a_b-C1)/y.ts");
      expect(pathInScope(t, "apps/web/app/api/runner/runs/[id]/events/route.ts")).toBe(true);
      expect(pathInScope(t, "apps/web/app/api/runner/runs/42/events/route.ts")).toBe(false);
      expect(pathInScope(t, "app/[slug]/[...rest]/x.ts")).toBe(true);
      expect(pathInScope(t, "app/s/r/x.ts")).toBe(false);
      expect(pathInScope(t, "app/(a_b-C1)/y.ts")).toBe(true);
    });

    it("any other bracket or parenthesis makes the whole scope unknown", () => {
      for (const entry of ["src/a[bc].ts", "src/[ab]c.ts", "src/x[id]", "src/[id", "src/id]", "src/[[id]]", "src/[[...id]", "src/[...]", "src/[]", "src/()", "src/(a", "src/a)", "src/a(b).ts", "src/(a)b", "src/(a b)", "src/[a.b]", "src/(a*)", "src/[*]", "src/[...id*]", "src/((a))", "src/[(a)]", "src/(a,b)", "src/[a,b]"]) {
        expect(scope("fine.ts", entry), entry).toEqual(UNKNOWN);
      }
    });
  });

  it("an absent, empty or malformed list is unknown", () => {
    for (const value of [undefined, null, [], "a.ts", 5, {}, { 0: "a.ts" }, [1], [null], ["a.ts", 5], [["a.ts"]], new Array(MAX_SCOPE_ENTRIES + 1).fill("a.ts")]) {
      expect(parseAcceptanceScope(value), JSON.stringify(value)).toEqual(UNKNOWN);
    }
    expect(parseAcceptanceScope(new Array(MAX_SCOPE_ENTRIES).fill("a.ts"))).toMatchObject({ kind: "known" });
  });
});

describe("pathInScope", () => {
  it("an exact path matches itself only, and is case sensitive", () => {
    expect(inScope(["src/a.ts"], "src/a.ts")).toBe(true);
    for (const path of ["src/A.ts", "src/a.tsx", "src/a.ts/", "src/a", "x/src/a.ts", "src/b/a.ts", "SRC/a.ts"]) expect(inScope(["src/a.ts"], path), path).toBe(false);
  });

  it("dir/** is everything strictly below dir, at any depth, and never dir itself or a sibling that shares a prefix", () => {
    expect(inScope(["docs/**"], "docs/a.md")).toBe(true);
    expect(inScope(["docs/**"], "docs/deep/er/a.md")).toBe(true);
    expect(inScope(["a/b/**"], "a/b/c")).toBe(true);
    for (const path of ["docs", "docs2/a.md", "docs-old/a.md", "x/docs/a.md", "a/b", "a/bc/d"]) expect(inScope(["docs/**", "a/b/**"], path), path).toBe(false);
  });

  it("* matches any run of characters inside one segment, including none, and never crosses a slash", () => {
    const s = ["src/*.ts"];
    for (const path of ["src/a.ts", "src/.ts", "src/long-name.ts", "src/a.b.ts"]) expect(inScope(s, path), path).toBe(true);
    for (const path of ["src/a/b.ts", "src/a.tsx", "src/ats", "other/a.ts", "src/a.ts/x"]) expect(inScope(s, path), path).toBe(false);
    expect(inScope(["a/*/c.ts"], "a/b/c.ts")).toBe(true);
    expect(inScope(["a/*/c.ts"], "a/b/d/c.ts")).toBe(false);
    expect(inScope(["a/*/c.ts"], "a//c.ts")).toBe(false);
    expect(inScope(["*"], "x")).toBe(true);
    expect(inScope(["*"], "x/y")).toBe(false);
    expect(inScope(["pre*mid*post"], "pre-mid-post")).toBe(true);
    expect(inScope(["pre*mid*post"], "premidpost")).toBe(true);
    expect(inScope(["pre*mid*post"], "prepost")).toBe(false);
    expect(inScope(["ab*ba"], "aba")).toBe(false);
    expect(inScope(["ab*ba"], "abba")).toBe(true);
  });

  it("a path with an empty, dot or dot-dot segment is never in scope, and neither is an empty path", () => {
    for (const path of ["", "/src/a.ts", "src//a.ts", "src/./a.ts", "src/../src/a.ts", "../src/a.ts", "docs/../x/a.md"]) expect(inScope(["src/a.ts", "docs/**", "*/*/*.ts"], path), JSON.stringify(path)).toBe(false);
  });

  it("an unknown scope holds no path at all", () => {
    expect(pathInScope(UNKNOWN as never, "src/a.ts")).toBe(false);
    expect(pathsOutsideScope(UNKNOWN as never, ["a", "b"])).toEqual(["a", "b"]);
  });

  it("pathsOutsideScope lists the paths that are not in scope, in order", () => {
    expect(pathsOutsideScope(scope("src/**", "README.md"), ["src/a.ts", ".github/workflows/ci.yml", "README.md", "package.json"])).toEqual([".github/workflows/ci.yml", "package.json"]);
    expect(pathsOutsideScope(scope("src/**"), [])).toEqual([]);
  });
});

describe("loadAcceptanceScope", () => {
  const ids = { accountId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222" };
  const queryable = (rows: Array<{ acceptance_files: unknown }>) => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const client: TenantQueryable = { query: async (sql, params) => (seen.push({ sql, params }), { rows: rows as never[] }) };
    return { client, seen };
  };

  it("reads the list from the run's own spec version, by account and run, and parses it", async () => {
    const q = queryable([{ acceptance_files: ["src/**"] }]);
    expect(await loadAcceptanceScope(q.client, ids)).toEqual({ kind: "known", entries: ["src/**"] });
    expect(q.seen[0]!.params).toEqual([ids.accountId, ids.runId]);
    expect(q.seen[0]!.sql).toMatch(/ar\.account_id = \$1 AND ar\.id = \$2/);
    expect(q.seen[0]!.sql).toMatch(/sv\.id = ar\.spec_version_id/);
    expect(q.seen[0]!.sql).toMatch(/sv\.erased_at IS NULL/);
  });

  it("no row (no spec version, an erased one, another account's run), a null list and a bad list are unknown", async () => {
    expect(await loadAcceptanceScope(queryable([]).client, ids)).toEqual(UNKNOWN);
    expect(await loadAcceptanceScope(queryable([{ acceptance_files: null }]).client, ids)).toEqual(UNKNOWN);
    expect(await loadAcceptanceScope(queryable([{ acceptance_files: ["a/{b}"] }]).client, ids)).toEqual(UNKNOWN);
    expect(await loadAcceptanceScope(queryable([{ acceptance_files: ["a.ts"] }, { acceptance_files: ["b.ts"] }]).client, ids)).toEqual(UNKNOWN);
  });
});
