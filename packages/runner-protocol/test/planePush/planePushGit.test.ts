import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanPlanePush, MAX_SCAN_BYTES, type PlanePushInput } from "../../src/planePush/planePush.js";
import { gitCommitSource } from "../../src/planePush/planePushGit.js";
import { assertSafeLocalConfig } from "../../src/planePush/planePushTransport.js";

/**
 * The scan over a real repository: every case builds commits with git itself and
 * reads them back through `gitCommitSource`, so what is tested is what git reports.
 * Fixture values are invented.
 */

let dir: string;
const git = (...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
const put = (path: string, content: string | Buffer): void => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const commit = (message: string): string => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};

const RULES = "=== FORBIDDEN_PATTERNS_START ===\nacme-internal-host\n=== FORBIDDEN_PATTERNS_END ===\n";
const PLAN = JSON.stringify({ priceUsdPerMonth: 7391 });
const rules: Record<string, string> = { "rules/ids.txt": RULES, "rules/plan.json": PLAN };

function scan(base: string, head: string, over: Partial<PlanePushInput> = {}) {
  return scanPlanePush({
    overlay: ["docs/ops/"],
    ruleFiles: { identifierRules: "rules/ids.txt", planData: "rules/plan.json" },
    readRuleFile: async (p) => (p in rules ? new TextEncoder().encode(rules[p]) : null),
    source: gitCommitSource({ repoDir: dir, commit: head, base }),
    ...over,
  });
}

let base: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "plane-push-"));
  git("init", "-q", "-b", "main");
  put("src/keep.ts", "export const a = 1;\nconst legacy = 'acme-internal-host';\n");
  put("db/old.sql", "-- old\n");
  base = commit("base");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("scan of real git objects", () => {
  it("passes a clean change (an old hit on a line it did not add is ignored) and reports what it covered", async () => {
    put("src/new file.ts", "export const b = 2;\n");
    put("src/keep.ts", "export const a = 1;\nconst legacy = 'acme-internal-host';\nexport const c = 3;\n");
    const head = commit("clean");
    const r = await scan(base, head);
    expect(r.refusals).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.scans).toMatchObject({ identifierRules: "applied", planData: "applied", files: 2, addedLines: 2 });
  });

  it("names a new identifier hit and plan figure by path and line, never by value", async () => {
    const parent = git("rev-parse", "HEAD");
    put("src/leak.ts", "ok\nconst h = 'acme-internal-host';\nconst p = { priceUsdPerMonth: 7391 };\n");
    const r = await scan(parent, commit("leak"));
    expect(r.refusals.map((x) => `${x.kind} ${x.path}:${x.line} ${x.rule}`)).toEqual([
      "identifier_hit src/leak.ts:2 identifier-rule#1",
      "plan_data_hit src/leak.ts:3 priceUsdPerMonth",
    ]);
    expect(JSON.stringify(r)).not.toMatch(/acme-internal-host|7391/);
  });

  it("refuses an overlay path, a binary file, an oversized file and a submodule, each by name", async () => {
    const parent = git("rev-parse", "HEAD");
    put("docs/ops/plan.md", "x\n");
    put("img.dat", Buffer.from([1, 2, 0, 3]));
    put("big.txt", Buffer.alloc(MAX_SCAN_BYTES + 1, 97));
    git("add", "-A");
    git("update-index", "--add", "--cacheinfo", `160000,${parent},vendored`);
    git("commit", "-q", "-m", "refusals");
    const r = await scan(parent, git("rev-parse", "HEAD"));
    expect(r.refusals.map((x) => `${x.kind} ${x.path}`).sort()).toEqual(
      ["binary_file img.dat", "file_too_large big.txt", "overlay_path docs/ops/plan.md", "submodule vendored"].sort(),
    );
  });

  it("reads git objects, not the working tree", async () => {
    const parent = git("rev-parse", "HEAD");
    put("src/clean.ts", "export const z = 1;\n");
    const head = commit("clean again");
    put("src/clean.ts", "const h = 'acme-internal-host';\n"); // modified after the commit
    put("src/untracked.ts", "const h = 'acme-internal-host';\n"); // never committed
    expect((await scan(parent, head)).ok).toBe(true);
    put("src/clean.ts", "export const z = 1;\n");
    rmSync(join(dir, "src/untracked.ts"));
  });

  it("a deleted file is not scanned, and a deleted overlay path is still refused", async () => {
    const parent = git("rev-parse", "HEAD");
    git("rm", "-q", "--", "db/old.sql", "docs/ops/plan.md");
    const r = await scan(parent, commit("deletions"));
    expect(r.refusals.map((x) => `${x.kind} ${x.path}`)).toEqual(["overlay_path docs/ops/plan.md"]);
  });

  it("a missing declared rule file refuses even when the change is clean", async () => {
    const parent = git("rev-parse", "HEAD");
    put("src/ok2.ts", "export const q = 1;\n");
    const r = await scan(parent, commit("ok2"), { readRuleFile: async () => null });
    expect(r.refusals.map((x) => `${x.kind} ${x.path}`)).toEqual(["rule_file_missing rules/ids.txt", "rule_file_missing rules/plan.json"]);
  });

  it("an unresolvable id, or a ref that looks like an option, is a failure and never an empty diff", async () => {
    const head = git("rev-parse", "HEAD");
    const cases: Array<[string, string, string]> = [
      ["0".repeat(40), head, "bad_ancestry"],
      [head, "no-such-ref", "bad_identity"],
      ["--output=/dev/null", head, "bad_identity"],
      [head, "-p", "bad_identity"],
      [head, "ab".repeat(20), "scan_failed"],
    ];
    for (const [b, c, kind] of cases) {
      const r = await scan(b, c);
      expect(r.ok).toBe(false);
      expect(r.refusals.map((x) => x.kind), `${b} ${c}`).toEqual([kind]);
    }
  });

  it("an empty commit refuses", async () => {
    git("commit", "-q", "--allow-empty", "-m", "empty");
    expect((await scan(git("rev-parse", "HEAD~1"), git("rev-parse", "HEAD"))).refusals.map((x) => x.kind)).toEqual(["no_changes"]);
  });

  it("the adapter source does not read the working tree", () => {
    const src = readFileSync(new URL("../../src/planePush/planePushGit.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/node:fs|readFile|ls-files|git["',\s]+(add|status|checkout)/);
  });
});

/**
 * Hostile repository state: everything below is something a repository (or the
 * environment git inherits) can carry that makes git report different content
 * than the push will send. Each case was a clean result for a commit that must
 * be refused.
 */
describe("hostile repository state", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const ID = ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always"];

  function repo() {
    const d = mkdtempSync(join(tmpdir(), "plane-push-h-"));
    dirs.push(d);
    const g = (...args: string[]): string => execFileSync("git", ["-C", d, ...ID, ...args], { encoding: "utf8" }).trim();
    const w = (path: string, content: string): void => {
      mkdirSync(dirname(join(d, path)), { recursive: true });
      writeFileSync(join(d, path), content);
    };
    const c = (message: string): string => {
      g("add", "-A");
      g("commit", "-q", "-m", message);
      return g("rev-parse", "HEAD");
    };
    g("init", "-q", "-b", "main");
    w("src/keep.ts", "export const a = 1;\n");
    const baseSha = c("base");
    const scanIn = (head: string, repoDir = d) =>
      scanPlanePush({
        overlay: ["docs/ops/"],
        ruleFiles: { identifierRules: "rules/ids.txt" },
        readRuleFile: async (p) => (p === "rules/ids.txt" ? new TextEncoder().encode(RULES) : null),
        source: gitCommitSource({ repoDir, commit: head, base: baseSha }),
      });
    return { d, g, w, c, baseSha, scanIn };
  }
  const LEAK = "const h = 'acme-internal-host';\n";
  const kindsOf = (r: Awaited<ReturnType<typeof scanPlanePush>>): string[] => r.refusals.map((x) => x.kind);

  it("a git replace ref on the blob that holds the hit does not hide it", async () => {
    const t = repo();
    t.w("src/leak.ts", LEAK);
    const head = t.c("leak");
    const leakBlob = t.g("rev-parse", `${head}:src/leak.ts`);
    const clean = execFileSync("git", ["-C", t.d, "hash-object", "-w", "--stdin"], { input: "const h = 1;\n", encoding: "utf8" }).trim();
    t.g("replace", leakBlob, clean);
    expect(kindsOf(await t.scanIn(head))).toEqual(["identifier_hit"]);
  });

  it("a git replace ref on the head commit does not scan other content than the push sends", async () => {
    const t = repo();
    t.w("src/leak.ts", "const h = 1;\n");
    const cleanCommit = t.c("clean");
    t.g("reset", "-q", "--hard", t.baseSha);
    t.w("src/leak.ts", LEAK);
    const head = t.c("leak");
    t.g("replace", head, cleanCommit);
    expect(kindsOf(await t.scanIn(head))).toEqual(["identifier_hit"]);
  });

  it("a repo-local diff.ignoreSubmodules=all does not hide a real submodule", async () => {
    const t = repo();
    const inner = mkdtempSync(join(tmpdir(), "plane-push-inner-"));
    dirs.push(inner);
    const gi = (...a: string[]): string => execFileSync("git", ["-C", inner, ...ID, ...a], { encoding: "utf8" }).trim();
    gi("init", "-q", "-b", "main");
    writeFileSync(join(inner, "f"), "x\n");
    gi("add", "-A");
    gi("commit", "-q", "-m", "inner");
    t.g("config", "diff.ignoreSubmodules", "all");
    t.g("submodule", "add", "-q", inner, "vendored");
    t.w("src/ok.ts", "export const b = 2;\n");
    const r = await t.scanIn(t.c("with submodule"));
    expect(r.refusals.map((x) => `${x.kind} ${x.path}`)).toContain("submodule vendored");
  });

  it("a repo-local diff.relative=true with a subdirectory repoDir does not hide paths outside it", async () => {
    const t = repo();
    t.w("sub/ok.txt", "fine\n");
    t.w("src/leak.ts", LEAK);
    t.g("config", "diff.relative", "true");
    const r = await t.scanIn(t.c("two places"), join(t.d, "sub"));
    expect(r.refusals.map((x) => `${x.kind} ${x.path}`)).toEqual(["identifier_hit src/leak.ts"]);
  });

  it("repo-local diff.renames, diff.noprefix, diff.mnemonicPrefix and diff.submodule=log do not change the answer", async () => {
    const t = repo();
    t.g("config", "diff.renames", "copies");
    t.g("config", "diff.noprefix", "true");
    t.g("config", "diff.submodule", "log");
    t.g("config", "diff.mnemonicPrefix", "true");
    t.w("src/leak.ts", LEAK);
    const r = await t.scanIn(t.c("leak"));
    expect(r.refusals.map((x) => `${x.kind} ${x.path}:${x.line}`)).toEqual(["identifier_hit src/leak.ts:1"]);
  });

  it("inherited GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT, GIT_DIR and GIT_WORK_TREE do not change the answer", async () => {
    const t = repo();
    const other = mkdtempSync(join(tmpdir(), "plane-push-other-"));
    dirs.push(other);
    execFileSync("git", ["init", "-q", other]);
    t.w("src/leak.ts", LEAK);
    const head = t.c("leak");
    const saved = { ...process.env };
    try {
      process.env.GIT_CONFIG_PARAMETERS = "'diff.ignoreSubmodules'='all' 'diff.relative'='true'";
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "diff.noprefix";
      process.env.GIT_CONFIG_VALUE_0 = "true";
      process.env.GIT_DIR = join(other, ".git");
      process.env.GIT_WORK_TREE = other;
      expect(kindsOf(await t.scanIn(head))).toEqual(["identifier_hit"]);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("a gitlink whose commit is absent from the repository refuses as a submodule, not as a failed scan", async () => {
    const t = repo();
    t.w("src/ok.ts", "export const b = 2;\n");
    t.g("add", "-A");
    t.g("update-index", "--add", "--cacheinfo", `160000,${"ab".repeat(20)},vendored`);
    t.g("commit", "-q", "-m", "absent gitlink");
    const r = await t.scanIn(t.g("rev-parse", "HEAD"));
    expect(r.refusals.map((x) => `${x.kind} ${x.path}`)).toEqual(["submodule vendored"]);
  });

  it("a file name that matches an identifier rule refuses, and no message echoes the name", async () => {
    const t = repo();
    t.w("src/acme-internal-host.ts", "export const b = 2;\n");
    t.w("img/acme-internal-host.bin", "x\u0000y");
    const r = await t.scanIn(t.c("named"));
    expect(r.ok).toBe(false);
    expect(kindsOf(r).every((k) => k === "identifier_hit")).toBe(true);
    expect(r.refusals).toHaveLength(2);
    expect(JSON.stringify(r)).not.toContain("acme-internal-host");
  });

  // ---- round 3: allowlists and fail-closed identity, each with a real repository ----

  const wb = (d: string, parts: Array<string | number[]>, content: string): void => {
    const path = Buffer.concat(parts.map((x) => Buffer.from(x as string | number[])));
    writeFileSync(Buffer.concat([Buffer.from(`${d}/`), path]), content);
  };
  const scanRange = (t: ReturnType<typeof repo>, head: string, base: string) =>
    scanPlanePush({
      overlay: ["docs/ops/"],
      ruleFiles: { identifierRules: "rules/ids.txt" },
      readRuleFile: async (p) => (p === "rules/ids.txt" ? new TextEncoder().encode(RULES) : null),
      source: gitCommitSource({ repoDir: t.d, commit: head, base }),
    });

  it("two file names that are not valid UTF-8 and decode alike cannot hide a hit: both refuse as malformed_path", async () => {
    const t = repo();
    mkdirSync(join(t.d, "src"), { recursive: true });
    wb(t.d, ["src/", [0xfe], ".ts"], LEAK);
    wb(t.d, ["src/", [0xff], ".ts"], "export const ok = 1;\n");
    const r = await t.scanIn(t.c("two invalid names"));
    expect(r.ok).toBe(false);
    expect(kindsOf(r)).toEqual(["malformed_path", "malformed_path"]);
    expect(r.refusals.map((x) => x.path)).toEqual(["changed path #1", "changed path #2"]);
  });

  it("a single invalid UTF-8 name refuses as malformed_path even when its content is clean", async () => {
    const t = repo();
    mkdirSync(join(t.d, "src"), { recursive: true });
    wb(t.d, ["src/", [0xc3, 0x28], ".ts"], "export const ok = 1;\n");
    expect(kindsOf(await t.scanIn(t.c("bad name")))).toEqual(["malformed_path"]);
  });

  it("two names equal after NFC refuse, and the hit in the decomposed one is still found", async () => {
    const t = repo();
    mkdirSync(join(t.d, "src"), { recursive: true });
    t.w("src/é.ts", "export const ok = 1;\n");
    t.w("src/é.ts", LEAK);
    const r = await t.scanIn(t.c("nfc pair"));
    expect(r.refusals.map((x) => `${x.kind} ${x.path}`).sort()).toEqual(["identifier_hit src/é.ts", "malformed_path changed path #2"].sort());
    expect(r.scans.files).toBe(2);
  });

  it("zero-width, control and bidi characters in a name refuse by ordinal", async () => {
    const t = repo();
    t.w("src/a​b.ts", "export const ok = 1;\n");
    t.w("src/a‮b.ts", "export const ok = 2;\n");
    t.w("src/a\u0007b.ts", "export const ok = 3;\n");
    const r = await t.scanIn(t.c("odd names"));
    expect(kindsOf(r)).toEqual(["malformed_path", "malformed_path", "malformed_path"]);
    expect(JSON.stringify(r)).not.toMatch(/[​‮\u0007]/);
  });

  it("a merge commit that carries a scrubbed side branch is refused as bad_ancestry", async () => {
    const t = repo();
    t.g("checkout", "-q", "-b", "side");
    t.w("src/leak.ts", LEAK);
    t.c("side adds the hit");
    t.g("rm", "-q", "src/leak.ts");
    t.c("side removes it");
    t.g("checkout", "-q", "main");
    t.w("src/m.ts", "export const m = 1;\n");
    t.c("main work");
    t.g("merge", "--no-ff", "-q", "-m", "merge", "side");
    const head = t.g("rev-parse", "HEAD");
    const parents = t.g("rev-list", "--parents", "-n1", head).split(" ");
    expect(parents).toHaveLength(3);
    for (const base of [t.baseSha, parents[1] as string]) {
      const r = await scanRange(t, head, base);
      expect(r.refusals.map((x) => x.kind)).toEqual(["bad_ancestry"]);
      expect(r.refusals[0]?.message).toMatch(/merge commit/);
      expect(r.scanned).toBeUndefined();
    }
  });

  it("a commit whose parent is not the base, and a root commit, are refused as bad_ancestry", async () => {
    const t = repo();
    t.w("src/one.ts", "export const one = 1;\n");
    const one = t.c("one");
    t.w("src/two.ts", "export const two = 2;\n");
    const two = t.c("two");
    const far = await scanRange(t, two, t.baseSha);
    expect(far.refusals.map((x) => x.kind)).toEqual(["bad_ancestry"]);
    expect(far.refusals[0]?.message).toMatch(/parent is not the base/);
    expect((await scanRange(t, two, one)).ok).toBe(true);
    const root = await scanRange(t, t.baseSha, t.baseSha);
    expect(root.refusals.map((x) => x.kind)).toEqual(["bad_ancestry"]);
    expect(root.refusals[0]?.message).toMatch(/no parent/);
  });

  it("a repository with an info/grafts file is refused: a graft would otherwise make a merge look like a single-parent commit", async () => {
    const t = repo();
    t.g("checkout", "-q", "-b", "side");
    t.w("src/clean.ts", "export const side = 1;\n");
    const side = t.c("side");
    t.g("checkout", "-q", "main");
    t.w("src/m.ts", "export const m = 1;\n");
    t.c("main work");
    t.g("merge", "--no-ff", "-q", "-m", "merge", "side");
    const head = t.g("rev-parse", "HEAD");
    const mainParent = t.g("rev-parse", `${head}^1`);
    expect((await scanRange(t, head, mainParent)).refusals.map((x) => x.kind)).toEqual(["bad_ancestry"]);
    // graft the merge down to one parent: git's own rev-list now reports a single parent
    mkdirSync(join(t.d, ".git", "info"), { recursive: true });
    writeFileSync(join(t.d, ".git", "info", "grafts"), `${head} ${mainParent}\n`);
    expect(t.g("rev-list", "--parents", "-n1", head).split(" ")).toHaveLength(2);
    const r = await scanRange(t, head, mainParent);
    expect(r.ok).toBe(false);
    expect(r.refusals.map((x) => x.kind)).toEqual(["bad_ancestry"]);
    expect(r.refusals[0]?.message).toMatch(/grafts/);
    void side;
  });

  it("a CRLF file whose hit needs the kept carriage return (a rule ending in a negated class) is refused", async () => {
    const t = repo();
    t.w("src/crlf.ts", "const h = 'x';\r\nconst n = secret-host\r\nconst z = 1;\r\n");
    const head = t.c("crlf");
    const r = await scanPlanePush({
      overlay: ["docs/ops/"],
      ruleFiles: { identifierRules: "rules/ids.txt" },
      readRuleFile: async () => new TextEncoder().encode("=== FORBIDDEN_PATTERNS_START ===\nsecret-host[^a-z]\n=== FORBIDDEN_PATTERNS_END ===\n"),
      source: gitCommitSource({ repoDir: t.d, commit: head, base: t.baseSha }),
    });
    expect(r.refusals.map((x) => `${x.kind}:${x.line}`)).toEqual(["identifier_hit:2"]);
  });

  it("only full 40-hex ids are accepted: names, refs, short ids, ranges, upper case and tags are bad_identity", async () => {
    const t = repo();
    t.w("src/ok.ts", "export const ok = 1;\n");
    const head = t.c("ok");
    t.g("tag", "-a", "-m", "tag", "annotated", head);
    const tag = t.g("rev-parse", "annotated");
    const refs = ["main", "HEAD", head.slice(0, 12), `${t.baseSha}..${head}`, head.toUpperCase(), `${head}^{commit}`, tag, "--output=/dev/null", "-p", ""];
    for (const ref of refs) {
      const asCommit = await scanRange(t, ref, t.baseSha);
      expect(asCommit.refusals.map((x) => x.kind), `commit ${ref}`).toEqual(["bad_identity"]);
      if (ref === tag) continue; // a tag id is a valid 40-hex base; it is just not the parent
      const asBase = await scanRange(t, head, ref);
      expect(asBase.refusals.map((x) => x.kind), `base ${ref}`).toEqual(["bad_identity"]);
    }
    expect((await scanRange(t, "ab".repeat(20), t.baseSha)).refusals.map((x) => x.kind)).toEqual(["scan_failed"]);
  });

  it("the result names the exact commit that was scanned", async () => {
    const t = repo();
    t.w("src/ok.ts", "export const ok = 1;\n");
    const head = t.c("ok");
    const r = await t.scanIn(head);
    expect(r.ok).toBe(true);
    expect(r.scanned).toEqual({ commit: head, base: t.baseSha });
  });

  it("fullwidth and U+2010 spellings in a file name and in content are caught", async () => {
    const t = repo();
    t.w("src/ａｃｍｅ-internal-host.ts", "export const ok = 1;\n");
    t.w("src/b.ts", "const h = 'acme‐internal‐host';\n");
    const r = await t.scanIn(t.c("variants"));
    expect(r.refusals.map((x) => `${x.kind} ${x.path}`)).toEqual(["identifier_hit src/b.ts", "identifier_hit changed path #2"]);
  });
});

/**
 * D#598 P1f-1 (R-598-P1f-4): the transfer allowlist is what `git init --bare` writes. The hook never uses a clone, so a repository
 * that carries a remote, branch tracking or an identity is refused. Each case is a real repository made with the real tool, and the
 * check runs before any network call (it is called directly, so no server is involved).
 */
describe("the transfer allowlist (assertSafeLocalConfig)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "plane-allow-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  let n = 0;
  const bare = (...extra: string[]): string => {
    const d = join(root, `r${n++}`);
    execFileSync("git", ["init", "-q", "--bare", d], { encoding: "utf8" });
    for (let i = 0; i < extra.length; i += 2) execFileSync("git", ["-C", d, "config", "--local", extra[i]!, extra[i + 1]!], { encoding: "utf8" });
    return d;
  };
  const refusal = async (dir: string): Promise<Error & { code?: string }> => {
    const e = await assertSafeLocalConfig(dir).then(() => undefined, (x: unknown) => x as Error & { code?: string });
    expect(e, "expected a refusal").toBeDefined();
    return e!;
  };

  it("refuses a repository carrying remote.origin.url", async () => {
    const e = await refusal(bare("remote.origin.url", "https://user:s3cret-value@example.test/acme/private.git"));
    expect(e.code).toBe("unsafe_git_config");
  });

  it("refuses a repository carrying only remote.origin.fetch", async () => {
    expect((await refusal(bare("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"))).code).toBe("unsafe_git_config");
  });

  it("refuses a repository carrying branch.main.remote", async () => {
    expect((await refusal(bare("branch.main.remote", "origin"))).code).toBe("unsafe_git_config");
  });

  it("refuses a repository carrying user.name", async () => {
    expect((await refusal(bare("user.name", "Someone"))).code).toBe("unsafe_git_config");
  });

  it("accepts what git init --bare writes, and core.ignorecase / core.precomposeunicode as macOS writes them", async () => {
    await expect(assertSafeLocalConfig(bare())).resolves.toBeUndefined();
    await expect(assertSafeLocalConfig(bare("core.ignorecase", "true", "core.precomposeunicode", "true"))).resolves.toBeUndefined();
  });

  it("names the key in a refusal and never its value", async () => {
    for (const [key, value] of [["remote.origin.url", "https://x:tok-9f2a7c@example.test/p.git"], ["remote.origin.fetch", "+refs/heads/*:refs/remotes/value-9f2a7c/*"], ["branch.main.remote", "value-9f2a7c"], ["user.name", "value-9f2a7c"]] as const) {
      const e = await refusal(bare(key, value));
      expect(e.message).toContain(key);
      expect(e.message).not.toContain("9f2a7c");
    }
  });
});
