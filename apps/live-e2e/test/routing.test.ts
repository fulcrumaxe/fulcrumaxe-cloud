import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AFFECTED_PATH, AffectedError, loadAffected, type Affected } from "../src/affected.js";
import { main, parseArgs, UsageError } from "../src/cli.js";
import { ledgerGlobTooBroad, loadLedger, validateLedger, LedgerError, type Ledger } from "../src/ledger.js";
import { loadPacks, type Pack } from "../src/manifest.js";
import type { Plan } from "../src/plan.js";
import {
  changedFiles,
  computeRouting,
  fallbackPackIds,
  isSafeRef,
  parseRange,
  reconcileLedger,
  routePaths,
  RouteRangeError,
} from "../src/routing.js";
import { BYPASS_ENV } from "../src/needs.js";
import { makeIo, makePack, PACKAGE_ROOT, scratchRoot, TARGET_ENV, tmpDir } from "./helpers.js";

const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

// Real git repositories are built in several tests; leave room on a loaded runner.
vi.setConfig({ testTimeout: 30_000 });

// The real classifier's matcher and ignore list, loaded once.
const affected: Affected = await loadAffected();

const packs: Pack[] = [
  makePack({ id: "billing", tier: "standard", paths: ["packages/billing/**", "apps/web/app/api/stripe/**"] }),
  makePack({ id: "health", tier: "smoke", paths: ["apps/web/app/api/health/**", "apps/web/middleware.ts"] }),
  makePack({ id: "overlap", tier: "smoke", paths: ["apps/web/app/api/**", "apps/web/app/api/health/**"] }),
  makePack({ id: "deep", tier: "full", paths: ["packages/runner/**"] }),
  makePack({ id: "plain-std", tier: "standard", paths: ["apps/other/**"] }),
];
const emptyLedger: Ledger = { version: 1, entries: [] };
const route = (files: string[], ledger: Ledger = emptyLedger, ps: Pack[] = packs) => routePaths({ files, packs: ps, ledger, affected });

// ---- a real git repository, built with the real git binary -------------------------------------------------

const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_AUTHOR_NAME: "t4",
  GIT_AUTHOR_EMAIL: "t4@example.test",
  GIT_COMMITTER_NAME: "t4",
  GIT_COMMITTER_EMAIL: "t4@example.test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A repo with `base` and `head` commits; `edits` are written (or created) between them. */
function makeRepo(edits: Record<string, string>): { dir: string; base: string; head: string } {
  const dir = tmpDir("t4_live_e2e_repo_");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(dir, "add", "seed.txt");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  for (const [file, text] of Object.entries(edits)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
    git(dir, "add", file);
  }
  git(dir, "commit", "-q", "-m", "head");
  return { dir, base, head: git(dir, "rev-parse", "HEAD") };
}

describe("routePaths: a union, every match recorded", () => {
  it("a file matched by two packs selects both and records every (pack, glob) match", () => {
    const r = route(["apps/web/app/api/health/route.ts"]);
    const rec = r.files[0];
    expect(rec?.disposition).toBe("claimed");
    expect(rec?.selects).toEqual(["health", "overlap"]);
    expect(rec?.matches).toEqual([
      { pack: "health", glob: "apps/web/app/api/health/**", selected: true },
      { pack: "overlap", glob: "apps/web/app/api/**", selected: true },
      { pack: "overlap", glob: "apps/web/app/api/health/**", selected: true },
    ]);
    expect(r.packs).toEqual(["health", "overlap"]);
  });

  it("several files union their packs, deduplicated and sorted", () => {
    const r = route(["packages/billing/src/a.ts", "apps/web/middleware.ts", "packages/billing/src/b.ts"]);
    expect(r.packs).toEqual(["billing", "health"]);
    expect(r.files.map((f) => f.file)).toEqual(["apps/web/middleware.ts", "packages/billing/src/a.ts", "packages/billing/src/b.ts"]);
  });

  it("a duplicate path in the input is judged once", () => {
    expect(route(["apps/web/middleware.ts", "apps/web/middleware.ts"]).files).toHaveLength(1);
  });
});

describe("routePaths: never selects a full pack", () => {
  it("a match on a full-tier pack is recorded as not selected", () => {
    const rec = route(["packages/runner/src/x.ts", "apps/web/middleware.ts"]).files.find((f) => f.file.startsWith("packages/runner"));
    expect(rec?.matches).toEqual([{ pack: "deep", glob: "packages/runner/**", selected: false }]);
    expect(rec?.selects).not.toContain("deep");
  });

  it("a file only a full pack claims falls back to the standard packs, not to the full pack", () => {
    const r = route(["packages/runner/src/x.ts"]);
    expect(r.files[0]?.disposition).toBe("fallback-standard");
    expect(r.files[0]?.note).toBe("only a full-tier pack claims this path");
    expect(r.packs).toEqual(["billing", "health", "overlap", "plain-std"]);
    expect(r.packs).not.toContain("deep");
  });

  it("nothing routing returns is above standard, for any input", () => {
    const files = ["packages/runner/a", "x/unknown", "apps/web/app/api/health/r.ts", "packages/billing/z"];
    for (const id of route(files).packs) expect(packs.find((p) => p.id === id)?.tier).not.toBe("full");
  });
});

describe("routePaths: a path nobody claims fails closed to standard", () => {
  it("an unclaimed file under apps/ selects every pack at or below standard", () => {
    const r = route(["apps/web/app/new-feature/page.tsx"]);
    expect(r.files[0]).toMatchObject({ disposition: "fallback-standard", note: "no pack claims this path", matches: [] });
    expect(r.packs).toEqual(fallbackPackIds(packs));
    expect(r.packs).toEqual(["billing", "health", "overlap", "plain-std"]);
  });

  it("so does an unclaimed file under packages/ and one outside both (root config, scripts, workflows)", () => {
    for (const f of ["packages/new/src/a.ts", "pnpm-lock.yaml", "scripts/ci/x.sh", ".github/workflows/ci.yml"]) {
      expect(route([f]).packs, f).toEqual(["billing", "health", "overlap", "plain-std"]);
    }
  });

  it("documentation and Markdown select nothing", () => {
    const r = route(["docs/ops/staging.md", "README.md", "apps/web/NOTES.md", "wiki/Home.md"]);
    expect(r.packs).toEqual([]);
    expect(r.files.every((f) => f.disposition === "ignored" && f.note !== null)).toBe(true);
  });

  it("a ledger entry exempts the path it names, with its reason in the record", () => {
    const ledger: Ledger = { version: 1, entries: [{ glob: "apps/web/public/**/*.svg", reason: "static artwork with no behaviour to test" }] };
    const rec = route(["apps/web/public/img/logo.svg"], ledger).files[0];
    expect(rec).toMatchObject({ disposition: "ledger", selects: [], note: "static artwork with no behaviour to test" });
    // A different path in the same tree is still unclaimed.
    expect(route(["apps/web/public/img/logo.png"], ledger).packs).toEqual(["billing", "health", "overlap", "plain-std"]);
  });

  it("a pack's claim wins over the ignore list and the ledger: routing only adds", () => {
    const claimMd = [makePack({ id: "md-owner", tier: "smoke", paths: ["docs/ops/staging.md"] })];
    expect(route(["docs/ops/staging.md"], emptyLedger, claimMd).packs).toEqual(["md-owner"]);
    const ledger: Ledger = { version: 1, entries: [{ glob: "apps/other/**", reason: "stale entry that a pack now claims" }] };
    expect(route(["apps/other/a.ts"], ledger).files[0]?.disposition).toBe("claimed");
  });

  it("no file at all selects nothing (the tier selection is untouched)", () => {
    expect(route([])).toEqual({ files: [], packs: [] });
  });
});

describe("ledger: strict load", () => {
  const entry = { glob: "apps/web/public/**", reason: "static artwork with no behaviour to test" };
  it("accepts a valid ledger", () => {
    expect(validateLedger({ version: 1, entries: [entry] }).entries).toEqual([entry]);
  });
  it("rejects unknown keys, wrong version, missing or thin reasons, duplicates and absolute or parent globs", () => {
    expect(() => validateLedger({ version: 1, entries: [], extra: 1 })).toThrow('unknown key "extra"');
    expect(() => validateLedger({ version: 2, entries: [] })).toThrow("version");
    expect(() => validateLedger({ version: 1, entries: [{ ...entry, owner: "x" }] })).toThrow('unknown key "owner"');
    expect(() => validateLedger({ version: 1, entries: [{ glob: entry.glob }] })).toThrow("reason");
    expect(() => validateLedger({ version: 1, entries: [{ glob: entry.glob, reason: "n/a" }] })).toThrow("reason");
    expect(() => validateLedger({ version: 1, entries: [entry, entry] })).toThrow("duplicate");
    expect(() => validateLedger({ version: 1, entries: [{ ...entry, glob: "/etc/**" }] })).toThrow(LedgerError);
    expect(() => validateLedger({ version: 1, entries: [{ ...entry, glob: "apps/../x/**" }] })).toThrow(LedgerError);
  });
  it("rejects a glob broad enough to switch the fail-closed rule off", () => {
    for (const glob of ["**", "*", "**/*", "apps/**", "packages/*", "apps/*/**", "*.ts"]) {
      expect(ledgerGlobTooBroad(glob), glob).toBe(true);
      expect(() => validateLedger({ version: 1, entries: [{ ...entry, glob }] }), glob).toThrow("too broad");
    }
    for (const glob of ["apps/web/public/**", "packages/billing/fixtures/**", "apps/web/robots.txt"]) expect(ledgerGlobTooBroad(glob), glob).toBe(false);
  });
  it("the shipped ledger loads", () => {
    expect(loadLedger(join(PACKAGE_ROOT, "routing-ledger.json")).version).toBe(1);
  });
  it("an unreadable or non-JSON file is a LedgerError", () => {
    expect(() => loadLedger(join(tmpDir(), "missing.json"))).toThrow("unreadable");
    const dir = tmpDir();
    writeFileSync(join(dir, "routing-ledger.json"), "{nope");
    expect(() => loadLedger(join(dir, "routing-ledger.json"))).toThrow("not valid JSON");
  });
});

describe("ledger reconcile", () => {
  const tracked = ["apps/web/public/logo.svg", "apps/other/a.ts", "packages/billing/x.ts"];
  const e = (glob: string): Ledger => ({ version: 1, entries: [{ glob, reason: "static artwork with no behaviour to test" }] });
  it("passes when every entry matches a tracked file that no pack claims", () => {
    expect(reconcileLedger(e("apps/web/public/**"), tracked, packs, affected)).toEqual([]);
  });
  it("fails when an entry now matches a claimed file", () => {
    const problems = reconcileLedger(e("apps/other/**"), tracked, packs, affected);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("now claimed by pack plain-std");
  });
  it("fails when an entry matches nothing any more", () => {
    expect(reconcileLedger(e("apps/gone/dir/**"), tracked, packs, affected)).toEqual(["apps/gone/dir/**: matches no tracked file (remove the entry)"]);
  });
  it("the shipped ledger reconciles with the shipped packs and the real tracked files", () => {
    const files = git(REPO_ROOT, "ls-files", "-z").split("\0").filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    const ledger = loadLedger(join(PACKAGE_ROOT, "routing-ledger.json"));
    expect(reconcileLedger(ledger, files, loadPacks(join(PACKAGE_ROOT, "packs")), affected)).toEqual([]);
  });
});

describe("refs are validated before any git command is built", () => {
  const bad = [
    "", "..", "a..", "..b", "a...b", "a..b..c", "--output=/tmp/x..HEAD", "-x..HEAD", "HEAD..--upload-pack=x", "a b..c", "a;rm -rf x..b",
    "$(touch x)..HEAD", "`id`..HEAD", "a|b..c", "a..b\nc", "a..b\0c", "a\\b..c", "HEAD^..HEAD", "HEAD~1..HEAD", "main@{1}..main", "a..b.lock",
    "a//b..c", "a/.hidden..c", "a/..c", "refs/heads/x/..y", "x".repeat(201) + "..HEAD", "abc..def..", ":(top)..HEAD", "a:b..c", "*..HEAD", "a?..b", "a[..b", "~a..b",
  ];
  it("rejects every malformed or hostile range", () => {
    for (const v of bad) expect(() => parseRange(v), JSON.stringify(v)).toThrow(RouteRangeError);
  });
  it("accepts commit ids and plain ref names", () => {
    expect(parseRange("1234567..abcdef0123456789abcdef0123456789abcdef01")).toEqual({
      base: "1234567",
      head: "abcdef0123456789abcdef0123456789abcdef01",
    });
    expect(parseRange("origin/main..feature/x-1.2")).toEqual({ base: "origin/main", head: "feature/x-1.2" });
    expect(isSafeRef("main")).toBe(true);
  });
  it("a hostile range never reaches git: the injected runner is not called", async () => {
    const calls: string[][] = [];
    const spy = (args: string[]): string => {
      calls.push(args);
      return "";
    };
    for (const v of bad) {
      await expect(computeRouting({ changedFrom: v, packs, repoRoot: "/nonexistent", ledgerFile: "/nonexistent", git: spy })).rejects.toThrow(RouteRangeError);
    }
    expect(calls).toEqual([]);
  });
  it("the CLI turns a hostile --changed-from into a usage error (exit 2) and writes no plan", async () => {
    expect(() => parseArgs(["plan", "--target", "staging", "--changed-from", "--output=x..HEAD"])).toThrow("needs a value");
    expect(() => parseArgs(["plan", "--target", "staging", "--changed-from", "$(id)..HEAD"])).toThrow(UsageError);
    const scratch = scratchRoot([]);
    const { io, err } = makeIo(PACKAGE_ROOT);
    io.cwd = scratch;
    expect(await main(["plan", "--target", "staging", "--changed-from", "a;b..c"], io)).toBe(2);
    expect(err.join("\n")).toContain("--changed-from");
    expect(() => readFileSync(join(scratch, "plan.json"))).toThrow();
  });
});

describe("changedFiles against a real git repository", () => {
  it("lists the files that differ between two commits, including a deletion, as paths with odd characters", () => {
    const { dir, base, head } = makeRepo({ "apps/web/a b.ts": "1\n", "packages/billing/x.ts": "2\n", "newline\nname.txt": "3\n" });
    const r = changedFiles(dir, { base, head });
    expect(r).toEqual({ ok: true, files: expect.arrayContaining(["apps/web/a b.ts", "packages/billing/x.ts", "newline\nname.txt"]) });
    expect(r.ok && r.files).toHaveLength(3);
  });

  it("accepts abbreviated ids and branch names", () => {
    const { dir, base, head } = makeRepo({ "apps/web/a.ts": "1\n" });
    expect(changedFiles(dir, { base: base.slice(0, 8), head: "main" })).toEqual({ ok: true, files: ["apps/web/a.ts"] });
    expect(head.length).toBe(40);
  });

  it("a commit that does not exist is a fallback reason, not a crash", () => {
    const { dir, head } = makeRepo({ "apps/web/a.ts": "1\n" });
    const r = changedFiles(dir, { base: "0".repeat(40), head });
    expect(r).toEqual({ ok: false, reason: `cannot resolve ${"0".repeat(40)} to a commit` });
  });

  it("a directory that is not a repository is a fallback reason", () => {
    const r = changedFiles(tmpDir(), { base: "abc1234", head: "def5678" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("not a repository");
  });

  it("a shallow clone is a fallback reason even when both commits are present", () => {
    const { dir } = makeRepo({ "apps/web/a.ts": "1\n" });
    const clone = join(tmpDir("t4_live_e2e_clone_"), "c");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${dir}`, clone], { env: GIT_ENV, stdio: "ignore" });
    expect(git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
    const head = git(clone, "rev-parse", "HEAD");
    const r = changedFiles(clone, { base: head, head });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toContain("shallow clone");
  });

  it("does not follow a GIT_DIR left in the environment by a hook", () => {
    const a = makeRepo({ "apps/web/a.ts": "1\n" });
    const b = makeRepo({ "packages/billing/b.ts": "1\n" });
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = join(b.dir, ".git");
    try {
      expect(changedFiles(a.dir, { base: a.base, head: a.head })).toEqual({ ok: true, files: ["apps/web/a.ts"] });
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev;
    }
  });
});

describe("computeRouting end to end", () => {
  const ledgerFile = join(PACKAGE_ROOT, "routing-ledger.json");

  it("routes the real diff of a real repo", async () => {
    const { dir, base, head } = makeRepo({ "packages/billing/x.ts": "1\n", "docs/a.md": "x\n" });
    const r = await computeRouting({ changedFrom: `${base}..${head}`, packs, repoRoot: dir, ledgerFile });
    expect(r.fallback).toBeNull();
    expect(r.packs).toEqual(["billing"]);
    expect(r.files.map((f) => [f.file, f.disposition])).toEqual([["docs/a.md", "ignored"], ["packages/billing/x.ts", "claimed"]]);
  });

  it("an unclaimed changed file falls back to every pack at or below standard", async () => {
    const { dir, base, head } = makeRepo({ "apps/web/app/brand-new/page.tsx": "1\n" });
    const r = await computeRouting({ changedFrom: `${base}..${head}`, packs, repoRoot: dir, ledgerFile });
    expect(r.packs).toEqual(fallbackPackIds(packs));
  });

  it("a git failure, a shallow clone, an unreadable ledger and a broken classifier each fall back, never to fewer packs", async () => {
    const { dir, base, head } = makeRepo({ "docs/a.md": "x\n" });
    const want = fallbackPackIds(packs);
    const range = `${base}..${head}`;
    const unknown = await computeRouting({ changedFrom: `${"1".repeat(40)}..${head}`, packs, repoRoot: dir, ledgerFile });
    expect(unknown).toMatchObject({ fallback: expect.stringContaining("cannot resolve"), packs: want, files: [] });
    const noLedger = await computeRouting({ changedFrom: range, packs, repoRoot: dir, ledgerFile: join(tmpDir(), "nope.json") });
    expect(noLedger).toMatchObject({ fallback: expect.stringContaining("routing-ledger.json"), packs: want });
    const noClassifier = await computeRouting({
      changedFrom: range,
      packs,
      repoRoot: dir,
      ledgerFile,
      loadAffectedFn: () => loadAffected(join(tmpDir(), "affected.mjs")),
    });
    expect(noClassifier).toMatchObject({ fallback: expect.stringContaining("classifier unreadable"), packs: want });
    const clone = join(tmpDir("t4_live_e2e_clone_"), "c");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${dir}`, clone], { env: GIT_ENV, stdio: "ignore" });
    const h = git(clone, "rev-parse", "HEAD");
    const shallow = await computeRouting({ changedFrom: `${h}..${h}`, packs, repoRoot: clone, ledgerFile });
    expect(shallow).toMatchObject({ fallback: expect.stringContaining("shallow"), packs: want });
  });

  it("an empty diff routes nothing and is not a fallback", async () => {
    const { dir, head } = makeRepo({ "docs/a.md": "x\n" });
    expect(await computeRouting({ changedFrom: `${head}..${head}`, packs, repoRoot: dir, ledgerFile })).toEqual({
      changed_from: `${head}..${head}`,
      files: [],
      packs: [],
      fallback: null,
    });
  });
});

describe("the classifier adapter (one copy of the glob matcher and the ignore list)", () => {
  it("reads the ignore list from scripts/ci/full-run-triggers.json, not from a copy", () => {
    const file = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "ci", "full-run-triggers.json"), "utf8")) as { ignore: { glob: string }[] };
    expect(affected.ignoreGlobs).toEqual(file.ignore.map((i) => i.glob));
    expect(affected.ignoreGlobs).toContain("docs/**");
  });
  it("uses the classifier's own matcher", () => {
    expect(affected.globToRegExp("apps/web/next.config.*").test("apps/web/next.config.ts")).toBe(true);
    expect(affected.globToRegExp("apps/web/**").test("apps/web/a/b/c.ts")).toBe(true);
    expect(affected.globToRegExp("apps/web/*").test("apps/web/a/b.ts")).toBe(false);
  });
  it("routing has no glob-to-regexp of its own", () => {
    for (const f of ["routing.ts", "ledger.ts", "affected.ts"]) {
      expect(readFileSync(join(PACKAGE_ROOT, "src", f), "utf8"), f).not.toMatch(/new RegExp\(|replace\(\s*\/\\\*/);
    }
  });
  it("a missing classifier is an AffectedError", async () => {
    await expect(loadAffected(join(tmpDir(), "affected.mjs"))).rejects.toThrow(AffectedError);
    expect(AFFECTED_PATH.endsWith(join("scripts", "ci", "affected.mjs"))).toBe(true);
  });
});

describe("the real executable with --changed-from", () => {
  const bin = join(PACKAGE_ROOT, "bin", "live-e2e.mjs");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", ...TARGET_ENV };

  it("a hostile range exits 2 and creates nothing", () => {
    const marker = join(tmpDir(), "pwned");
    const run = (range: string) => {
      try {
        execFileSync(process.execPath, [bin, "plan", "--target", "staging", "--changed-from", range, "--out", join(tmpDir(), "plan.json")], { env, encoding: "utf8", stdio: "pipe" });
        return { status: 0, stderr: "" };
      } catch (err) {
        const e = err as { status: number; stderr: string };
        return { status: e.status, stderr: String(e.stderr) };
      }
    };
    const reason = "--changed-from base is not a valid commit id or ref name";
    const first = run(`$(touch ${marker})..HEAD`);
    expect(first.status).toBe(2);
    expect(first.stderr).toContain(reason);
    const second = run(`a;touch ${marker};..HEAD`);
    expect(second.status).toBe(2);
    expect(second.stderr).toContain(reason);
    expect(() => readFileSync(marker)).toThrow();
  }, 60_000);

  /**
   * A throwaway checkout with the executable's own layout (apps/live-e2e plus the CI classifier), committed
   * with real history. The binary diffs the checkout it lives in, so running this copy keeps the test
   * independent of the depth of the checkout the suite itself runs in.
   */
  function makeCheckout(): { dir: string; bin: string; base: string; head: string } {
    const dir = tmpDir("t4_live_e2e_checkout_");
    const pkg = join(dir, "apps", "live-e2e");
    for (const name of ["bin", "src", "packs", "targets", "routing-ledger.json", "package.json", "tsconfig.json"]) {
      cpSync(join(PACKAGE_ROOT, name), join(pkg, name), { recursive: true });
    }
    symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(pkg, "node_modules"), "dir");
    for (const name of ["affected.mjs", "full-run-triggers.json"]) {
      mkdirSync(join(dir, "scripts", "ci"), { recursive: true });
      cpSync(join(PACKAGE_ROOT, "..", "..", "scripts", "ci", name), join(dir, "scripts", "ci", name));
    }
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    const base = git(dir, "rev-parse", "HEAD");
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "only.md"), "x\n");
    git(dir, "add", "docs/only.md");
    git(dir, "commit", "-q", "-m", "head");
    return { dir, bin: join(pkg, "bin", "live-e2e.mjs"), base, head: git(dir, "rev-parse", "HEAD") };
  }

  it("a real range in a real repository is routed through the real binary", () => {
    const co = makeCheckout();
    expect(git(co.dir, "rev-parse", "--is-shallow-repository")).toBe("false");
    const out = join(tmpDir(), "plan.json");
    const stdout = execFileSync(process.execPath, [co.bin, "plan", "--target", "staging", "--changed-from", `${co.base}..${co.head}`, "--out", out], {
      env: { ...env, HOME: tmpDir() },
      cwd: co.dir,
      encoding: "utf8",
    });
    const p = JSON.parse(readFileSync(out, "utf8")) as Plan;
    expect(stdout).toContain("platform: SKIPPED-NEED bypass");
    expect(p.changed_from).toBe(`${co.base}..${co.head}`);
    expect(p.routing_fallback).toBeNull();
  }, 60_000);

  it("a ref that does not exist in the repository falls back and says it cannot resolve it", () => {
    const co = makeCheckout();
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const out = join(tmpDir(), "plan.json");
    execFileSync(process.execPath, [co.bin, "plan", "--target", "staging", "--changed-from", `${missing}..${co.head}`, "--out", out], {
      env: { ...env, HOME: tmpDir() },
      cwd: co.dir,
      encoding: "utf8",
    });
    const p = JSON.parse(readFileSync(out, "utf8")) as Plan;
    expect(p.routing_fallback).toContain("cannot resolve");
  }, 60_000);
});

describe("plan with --changed-from", () => {
  const std = makePack({ id: "std-bill", tier: "standard", paths: ["packages/billing/**"] });
  const smoke = makePack({ id: "smoke-one", tier: "smoke", paths: ["apps/web/middleware.ts"] });
  const full = makePack({ id: "full-deep", tier: "full", paths: ["packages/runner/**"], model_spend: true });
  const fixture = [std, smoke, full];

  async function plan(args: string[], files: Record<string, string>, env: Record<string, string> = { [BYPASS_ENV]: "x" }) {
    const root = scratchRoot(fixture);
    writeFileSync(join(root, "routing-ledger.json"), JSON.stringify({ version: 1, entries: [] }));
    const repo = makeRepo(files);
    const { io, out, err } = makeIo(root, env);
    io.repoRoot = repo.dir;
    const code = await main(["plan", "--target", "staging", "--changed-from", `${repo.base}..${repo.head}`, ...args], io);
    const p = JSON.parse(readFileSync(join(root, "plan.json"), "utf8")) as Plan;
    return { code, out, err, plan: p, range: `${repo.base}..${repo.head}` };
  }

  it("adds the routed pack to the default smoke tier and records every match in plan.json", async () => {
    const r = await plan([], { "packages/billing/x.ts": "1\n" });
    expect(r.code).toBe(0);
    expect(r.plan.packs.map((p) => p.id)).toEqual(["smoke-one", "std-bill"]);
    expect(r.plan.changed_from).toBe(r.range);
    expect(r.plan.routing_fallback).toBeNull();
    expect(r.plan.routing).toEqual([
      { file: "packages/billing/x.ts", disposition: "claimed", matches: [{ pack: "std-bill", glob: "packages/billing/**", selected: true }], selects: ["std-bill"], note: null },
    ]);
  });

  it("routing only adds: the tier's and the named packs stay selected when the diff routes elsewhere or nowhere", async () => {
    const r = await plan(["--tier", "smoke", "--pack", "full-deep", "--trigger", "dispatch"], { "docs/a.md": "x\n" });
    expect(r.plan.packs.map((p) => p.id)).toEqual(["full-deep", "smoke-one"]);
    expect(r.plan.named).toEqual(["full-deep"]);
    const t = await plan(["--tier", "standard"], { "docs/a.md": "x\n" });
    expect(t.plan.packs.map((p) => p.id)).toEqual(["smoke-one", "std-bill"]);
  });

  it("a diff that touches a path only the full pack claims does not select the full pack", async () => {
    const r = await plan([], { "packages/runner/a.ts": "1\n" });
    expect(r.plan.packs.map((p) => p.id)).toEqual(["smoke-one", "std-bill"]);
    expect(r.plan.routing[0]).toMatchObject({ disposition: "fallback-standard" });
  });

  it("a git failure falls back to the standard tier, says so, and still exits 0", async () => {
    const root = scratchRoot(fixture);
    writeFileSync(join(root, "routing-ledger.json"), JSON.stringify({ version: 1, entries: [] }));
    const { io, out } = makeIo(root, { [BYPASS_ENV]: "x" });
    io.repoRoot = tmpDir();
    expect(await main(["plan", "--target", "staging", "--changed-from", "abc1234..def5678"], io)).toBe(0);
    const p = JSON.parse(readFileSync(join(root, "plan.json"), "utf8")) as Plan;
    expect(p.packs.map((x) => x.id)).toEqual(["smoke-one", "std-bill"]);
    expect(p.routing_fallback).toContain("not a repository");
    expect(p.routing).toEqual([]);
    expect(out[0]).toContain("routing fell back to every pack at or below standard");
  });

  it("--tag still narrows the union, and an empty result is still EMPTY-SELECTION (exit 1)", async () => {
    const tagged = makePack({ id: "tagged", tier: "smoke", tags: ["@api"], paths: ["packages/billing/**"] });
    const other = makePack({ id: "other", tier: "smoke", tags: ["@ui"], projects: ["desktop", "phone", "tablet"], paths: ["apps/x/y/**"] });
    const root = scratchRoot([tagged, other]);
    writeFileSync(join(root, "routing-ledger.json"), JSON.stringify({ version: 1, entries: [] }));
    const repo = makeRepo({ "packages/billing/x.ts": "1\n" });
    const range = `${repo.base}..${repo.head}`;
    const ok = makeIo(root, { [BYPASS_ENV]: "x" });
    ok.io.repoRoot = repo.dir;
    const okCode = await main(["plan", "--target", "staging", "--changed-from", range, "--tag", "@api"], ok.io);
    expect(ok.err).toEqual([]);
    expect(okCode).toBe(0);
    const written = JSON.parse(readFileSync(join(root, "plan.json"), "utf8")) as Plan;
    expect(written.packs.map((x) => x.id)).toEqual(["tagged"]);
    const none = makeIo(root, { [BYPASS_ENV]: "x" });
    none.io.repoRoot = repo.dir;
    expect(await main(["plan", "--target", "staging", "--changed-from", range, "--tag", "@nothing"], none.io)).toBe(1);
    expect(none.err.join("\n")).toContain("EMPTY-SELECTION");
  });

  it("without --changed-from the plan carries an empty routing list and no range", async () => {
    const root = scratchRoot(fixture);
    const { io } = makeIo(root, { [BYPASS_ENV]: "x" });
    expect(await main(["plan", "--target", "staging"], io)).toBe(0);
    const p = JSON.parse(readFileSync(join(root, "plan.json"), "utf8")) as Plan;
    expect(p).toMatchObject({ changed_from: null, routing: [], routing_fallback: null });
  });

  it("a corrupt ledger in the package falls back rather than failing the deploy check", async () => {
    const root = scratchRoot(fixture);
    writeFileSync(join(root, "routing-ledger.json"), "{broken");
    const repo = makeRepo({ "docs/a.md": "x\n" });
    const { io } = makeIo(root, { [BYPASS_ENV]: "x" });
    io.repoRoot = repo.dir;
    expect(await main(["plan", "--target", "staging", "--changed-from", `${repo.base}..${repo.head}`], io)).toBe(0);
    const p = JSON.parse(readFileSync(join(root, "plan.json"), "utf8")) as Plan;
    expect(p.routing_fallback).toContain("routing-ledger.json");
    expect(p.packs.map((x) => x.id)).toEqual(["smoke-one", "std-bill"]);
  });
});
