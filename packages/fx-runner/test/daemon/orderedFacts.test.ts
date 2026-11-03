import { describe, expect, it } from "vitest";
import type { PlaneMergeOrderedConfig } from "@fulcrumaxe/runner-protocol";
import { orderedCode as part, readOrderedConfig } from "@fulcrumaxe/runner-protocol";
import type { TreeEntry } from "@fulcrumaxe/runner-protocol/planePush";
import { decideOrdered, orderedFactOf, pathsOverlap, resolveResources } from "../../src/daemon/orderedFacts.js";

/**
 * D#483 S5-j2c2: the pure half of the runner's ordering fact. The git reads and the wire are covered in planeMerge.test.ts on real repositories; here the decision
 * is a function of trees and a configuration alone.
 */
const MIG = { name: "migrations", path_pattern: "db/migrations/*.sql", key_pattern: "^(\\d{4})_.+\\.sql$", key_kind: "integer" as const };
const CONFIG: PlaneMergeOrderedConfig = { configured: true, resources: [MIG] };
const entry = (n: number): TreeEntry => ({ mode: "100644", type: "blob", sha: String(n).padStart(40, "0") });
const tree = (paths: string[], salt = 1): Map<string, TreeEntry> => new Map(paths.map((p, i) => [p, entry(i + salt)]));
const TIP = "t".repeat(40);
const BASE = "b".repeat(40);
const TIP_PATHS = ["db/migrations/0001_init.sql", "db/migrations/0002_users.sql", "src/a.ts"];

describe("resolveResources", () => {
  it("compiles the configuration again with the protocol's compiler, and refuses a list it cannot reproduce", () => {
    expect(resolveResources(CONFIG, TIP_PATHS)?.map((r) => r.name)).toEqual(["migrations"]);
    // An entry outside the safe subset (an alternation) is dropped by the compiler: the lists differ, so the runner does not read it as 'in order'.
    expect(resolveResources({ configured: true, resources: [MIG, { ...MIG, name: "bad", key_pattern: "^(a|b)" }] }, TIP_PATHS)).toBeNull();
    expect(resolveResources({ configured: true, resources: [] }, TIP_PATHS)).toEqual([]);
  });

  it("unconfigured: the detected migrations directory (two or more NNNN_*.sql files), else none", () => {
    expect(resolveResources({ configured: false, resources: [] }, TIP_PATHS)?.map((r) => r.name)).toEqual(["migrations"]);
    expect(resolveResources({ configured: false, resources: [] }, ["db/migrations/0001_init.sql", "src/a.ts"])).toEqual([]);
  });

  it("agrees with the cloud's reader: the same entries accepted, in the same order", () => {
    const via = readOrderedConfig({ orderedResources: [{ name: "migrations", pathPattern: MIG.path_pattern, keyPattern: MIG.key_pattern, keyKind: "integer" }] });
    expect(resolveResources(CONFIG, TIP_PATHS)?.map((r) => r.spec)).toEqual(via.resources.map((r) => r.spec));
  });
});

describe("decideOrdered", () => {
  const rules = resolveResources(CONFIG, TIP_PATHS)!;
  it("ok, none, and out_of_order named by part() codes", () => {
    expect(decideOrdered(rules, TIP_PATHS, ["db/migrations/0003_x.sql"])).toEqual({ verdict: "ok" });
    // A pull request that adds no file of an ordered resource is `none` (the cloud frees the order lease on it), not `ok`.
    expect(decideOrdered(rules, TIP_PATHS, ["src/new.ts"])).toEqual({ verdict: "none" });
    expect(decideOrdered(rules, TIP_PATHS, [])).toEqual({ verdict: "none" });
    expect(decideOrdered([], TIP_PATHS, ["db/migrations/0001_x.sql"])).toEqual({ verdict: "none" });
    expect(decideOrdered(rules, TIP_PATHS, ["db/migrations/0002_other.sql"])).toEqual({ verdict: "out_of_order", resource: "resource_migrations", key: "key_0002", highest: "highest_0002" });
    expect(decideOrdered(rules, TIP_PATHS, ["db/migrations/0004_a.sql", "db/migrations/0004_b.sql"])).toMatchObject({ verdict: "out_of_order", key: "key_0004" });
  });

  it("the codes are the merge queue's own: lower case, [a-z0-9_] only, at most 64", () => {
    expect(part("resource", "My Seeds.v2")).toBe("resource_my_seeds_v2");
    expect(part("key", "x".repeat(100))).toHaveLength(64);
  });
});

describe("orderedFactOf", () => {
  it("behind is whether the tip is past the merge base; overlap is a shared changed path, and only when behind", () => {
    const base = tree([...TIP_PATHS]);
    const head = new Map(base).set("src/a.ts", entry(90));
    const tip = new Map(base).set("src/a.ts", entry(91));
    const input = { config: CONFIG, tip: TIP, mergeBase: BASE, baseTree: base, headTree: head, tipTree: tip };
    expect(orderedFactOf(input)).toEqual({ verdict: "none", tip_sha: TIP, behind: true, overlap: true });
    expect(orderedFactOf({ ...input, tipTree: new Map(base).set("src/z.ts", entry(92)) })).toEqual({ verdict: "none", tip_sha: TIP, behind: true, overlap: false });
    // Not behind: the tip is the merge base, so nothing was gained.
    expect(orderedFactOf({ ...input, mergeBase: TIP, tipTree: base })).toEqual({ verdict: "none", tip_sha: TIP, behind: false, overlap: false });
  });

  it("a pull request adding no ordered file is none, and keeps overlap and behind (the cloud stops on an unreviewed overlap whatever the verdict)", () => {
    const base = tree([...TIP_PATHS]);
    const head = new Map(base).set("src/a.ts", entry(90));
    const tip = new Map(base).set("src/a.ts", entry(91));
    expect(orderedFactOf({ config: CONFIG, tip: TIP, mergeBase: BASE, baseTree: base, headTree: new Map(head).set("src/new.ts", entry(93)), tipTree: tip })).toEqual({ verdict: "none", tip_sha: TIP, behind: true, overlap: true });
  });

  // D#483 S5-j2f: a configured glob never matches a path past 512 characters, so the check cannot see it: the fact says so instead of 'none'.
  it("a path past the matcher's length bound under a configured resource is unknown, whether the pull request adds it or the tip holds it; the detected default is unaffected", () => {
    const docs: PlaneMergeOrderedConfig = { configured: true, resources: [{ name: "docs", path_pattern: "docs/**", key_pattern: "^(\\d{3})-.+\\.md$", key_kind: "integer" }] };
    const long = `docs/${"a/".repeat(260)}005-x.md`;
    const base = tree(["docs/001-a.md", "src/a.ts"]);
    const added = orderedFactOf({ config: docs, tip: TIP, mergeBase: TIP, baseTree: base, headTree: new Map(base).set(long, entry(99)), tipTree: base });
    expect(added).toEqual({ verdict: "unknown", tip_sha: TIP, behind: false, overlap: false });
    const onTip = orderedFactOf({ config: docs, tip: TIP, mergeBase: TIP, baseTree: base, headTree: new Map(base).set("docs/002-b.md", entry(98)), tipTree: new Map(base).set(long, entry(97)) });
    expect(onTip.verdict).toBe("unknown");
    // Short paths: still decided. And a repository with no configuration keeps its detected default, which has no length bound of its own.
    expect(orderedFactOf({ config: docs, tip: TIP, mergeBase: TIP, baseTree: base, headTree: new Map(base).set("docs/002-b.md", entry(96)), tipTree: base }).verdict).toBe("ok");
    const migs = tree(["db/migrations/0001_a.sql", "db/migrations/0002_b.sql", `${"x/".repeat(260)}y.ts`]);
    expect(orderedFactOf({ config: { configured: false, resources: [] }, tip: TIP, mergeBase: TIP, baseTree: migs, headTree: new Map(migs).set("db/migrations/0003_c.sql", entry(95)), tipTree: migs }).verdict).toBe("ok");
  });

  it("an added key is a path in the head tree and not in the merge base's: a changed existing file is not an added key", () => {
    const base = tree(TIP_PATHS);
    const input = { config: CONFIG, tip: TIP, mergeBase: TIP, baseTree: base, tipTree: base };
    expect(orderedFactOf({ ...input, headTree: new Map(base).set("db/migrations/0001_init.sql", entry(77)) }).verdict).toBe("none");
    expect(orderedFactOf({ ...input, headTree: new Map(base).set("db/migrations/0001_new.sql", entry(78)) })).toMatchObject({ verdict: "out_of_order", key: "key_0001", highest: "highest_0002" });
  });

  it("a configuration the runner cannot reproduce is unknown, with no other claim", () => {
    const base = tree(TIP_PATHS);
    const bad = { configured: true, resources: [{ ...MIG, key_pattern: "^(a|b)" }] };
    expect(orderedFactOf({ config: bad, tip: TIP, mergeBase: TIP, baseTree: base, headTree: base, tipTree: base })).toEqual({ verdict: "unknown", tip_sha: TIP, behind: false, overlap: false });
  });

  it("pathsOverlap", () => {
    expect(pathsOverlap(["a", "b"], ["b"])).toBe(true);
    expect(pathsOverlap(["a"], ["b"])).toBe(false);
    expect(pathsOverlap([], ["b"])).toBe(false);
  });
});
