// Run with: node --test scripts/ci/affected.test.mjs
//
// Tests for scripts/ci/affected.mjs against real git repositories built in a temp directory. The package
// manifests in them are the repository's own (copied, not invented), and the expected package sets are
// worked out here by a separate walk over those manifests, so a change to the workspace or to pnpm's
// semantics shows up as a failure rather than being re-derived by the code under test.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classify,
  classifyMergeGroup,
  e2eSkipLine,
  fetchCommitDepth1,
  fetchPrLabels,
  fetchRangeCommits,
  globToRegExp,
  loadTriggers,
  prNumberOfSubject,
  scopeLine,
} from "./affected.mjs";
import { parseList, projectsFor } from "./vitest-projects.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const TRIGGER_FILE = path.join(here, "full-run-triggers.json");
const rules = JSON.parse(readFileSync(TRIGGER_FILE, "utf8"));
const CLI = path.join(here, "affected.mjs");
const execFileAsync = promisify(execFile);

// ---- git fixtures --------------------------------------------------------
const ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];
const git = (dir, ...args) => execFileSync("git", [...ID, "-C", dir, ...args], { encoding: "utf8" }).trim();

/** The repository's own workspace manifests, found without the code under test. */
function realWorkspace() {
  const pkgs = new Map(); // dir -> { name, manifest }
  for (const top of ["apps", "packages"]) {
    for (const d of readdirSync(path.join(repoRoot, top))) {
      const f = path.join(repoRoot, top, d, "package.json");
      if (existsSync(f)) {
        const manifest = JSON.parse(readFileSync(f, "utf8"));
        pkgs.set(`${top}/${d}`, { name: manifest.name, manifest });
      }
    }
  }
  return pkgs;
}
const WORKSPACE = realWorkspace();

/** dir -> Set of dirs it depends on, from `workspace:` entries of dependencies and devDependencies only. */
function declaredEdges() {
  const byName = new Map([...WORKSPACE].map(([dir, p]) => [p.name, dir]));
  const edges = new Map();
  for (const [dir, { manifest }] of WORKSPACE) {
    const out = new Set();
    for (const field of ["dependencies", "devDependencies"]) {
      for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
        if (String(spec).startsWith("workspace:") && byName.has(dep)) out.add(byName.get(dep));
      }
    }
    edges.set(dir, out);
  }
  return edges;
}

/** x plus every package that depends on it, directly or not: a fixed point, not the code under test's walk. */
function expectedSet(x, edges) {
  const set = new Set([x]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [dir, deps] of edges) {
      if (!set.has(dir) && [...deps].some((d) => set.has(d))) {
        set.add(dir);
        grew = true;
      }
    }
  }
  return [...set].sort();
}

const DECLARED = declaredEdges();
// The walk follows declared edges and the extra edges of kind "src". Edges of kind "test" are not walked.
const WITH_SRC = new Map([...DECLARED].map(([k, v]) => [k, new Set(v)]));
for (const e of rules.extra_edges) if (e.kind === "src") WITH_SRC.get(e.from).add(e.to);
const TEST_EDGES = rules.extra_edges.filter((e) => e.kind === "test");

/**
 * The independent answer for a change to `files` inside package `x`: x and its dependents over declared and "src"
 * edges; then each "test" edge whose `to` is in that set adds its `from` (once, no dependents of it); then each
 * repo-wide scan whose watch globs match a changed file.
 */
function expectedAffected(x, files) {
  const walked = expectedSet(x, WITH_SRC);
  const out = new Set(walked);
  for (const e of TEST_EDGES) if (walked.includes(e.to)) out.add(e.from);
  for (const p of scanPackages(files)) out.add(p);
  return [...out].sort();
}

/** The packages whose repo-wide scan watches one of `files`. */
function scanPackages(files) {
  return (rules.repo_wide_scans ?? [])
    .filter((s) => files.some((f) => s.watch.some((g) => globToRegExp(g).test(f))))
    .map((s) => s.package);
}

let fx; // { dir, base }
let aux; // scratch files that must stay out of the fixture repository
before(() => {
  aux = mkdtempSync(path.join(tmpdir(), "d507a-aux-"));
  const dir = mkdtempSync(path.join(tmpdir(), "d507a-affected-"));
  git(dir, "init", "-q", "-b", "main");
  copyFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), path.join(dir, "pnpm-workspace.yaml"));
  for (const d of WORKSPACE.keys()) {
    mkdirSync(path.join(dir, d), { recursive: true });
    copyFileSync(path.join(repoRoot, d, "package.json"), path.join(dir, d, "package.json"));
  }
  writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: 1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  fx = { dir, base: git(dir, "rev-parse", "HEAD") };
});
after(() => {
  rmSync(fx.dir, { recursive: true, force: true });
  rmSync(aux, { recursive: true, force: true });
});

/** Commit `files` ({path: content | null to delete}) on top of the base commit, run classify, return to base. */
function change(files, extra = {}) {
  git(fx.dir, "reset", "-q", "--hard", fx.base);
  for (const [p, content] of Object.entries(files)) {
    const abs = path.join(fx.dir, p);
    if (content === null) rmSync(abs, { force: true });
    else {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  }
  git(fx.dir, "add", "-A");
  git(fx.dir, "commit", "-q", "--allow-empty", "-m", "change");
  const head = git(fx.dir, "rev-parse", "HEAD");
  const result = classify({ repoRoot: fx.dir, base: fx.base, head, ...extra });
  git(fx.dir, "reset", "-q", "--hard", fx.base);
  return result;
}

/** A file path that matches `glob` (and nothing else is promised). */
const sampleFor = (glob) => glob.replace(/\*\*/g, "x/y").replace(/[*?]/g, "x");

function assertShape(r) {
  assert.deepEqual(Object.keys(r).sort(), ["e2e", "lint", "mode", "packages", "reason", "trigger"]);
  assert.ok(r.mode === "full" || r.mode === "affected", `mode ${r.mode}`);
  assert.equal(typeof r.reason, "string");
  assert.ok(r.reason.length > 0);
  assert.ok(r.trigger === null || (typeof r.trigger === "string" && r.trigger.length > 0));
  assert.ok(Array.isArray(r.packages) && r.packages.every((p) => typeof p === "string" && p.length > 0));
  assert.equal(typeof r.e2e, "boolean");
}

// ---- A1, A2: the trigger file --------------------------------------------
test("the trigger file has a version and a list of {glob, reason}", () => {
  assert.ok(Number.isInteger(rules.version));
  assert.ok(Array.isArray(rules.triggers) && rules.triggers.length > 0);
  for (const t of rules.triggers) {
    assert.equal(typeof t.glob, "string");
    assert.ok(t.reason.length > 0, `${t.glob} has no reason`);
  }
  assert.doesNotThrow(() => loadTriggers(TRIGGER_FILE));
  assert.throws(() => loadTriggers(path.join(aux, "missing.json")), /unreadable/);
});

test("the trigger list covers everything the Spec names", () => {
  const have = new Set(rules.triggers.map((t) => t.glob));
  for (const glob of [
    "pnpm-lock.yaml",
    "package.json",
    "pnpm-workspace.yaml",
    "tsconfig*.json",
    "vitest.workspace.ts",
    "eslint.config.*",
    "flake.nix",
    "flake.lock",
    "packages/db/migrations/**",
    ".github/workflows/**",
    "scripts/**",
    "apps/web/app/_generated/**",
    "apps/web/env-manifest.ts",
    "apps/web/scripts/check-env-manifest.mjs",
    "packages/core/**",
    "packages/db/**",
  ]) {
    assert.ok(have.has(glob), `missing trigger ${glob}`);
  }
});

test("no second copy of the trigger list exists under scripts/ or .github/", () => {
  // A file counts as a copy when it spells out most of the globs. Single mentions elsewhere (the hosted
  // pnpm cache key hashes pnpm-lock.yaml, the Gate 1 router names a few workspace files for its own
  // purpose) are not a list.
  const files = git(repoRoot, "ls-files", "--", "scripts", ".github").split("\n").filter(Boolean);
  const allowed = new Set(["scripts/ci/full-run-triggers.json"]);
  const globs = rules.triggers.map((t) => t.glob);
  for (const f of files) {
    if (allowed.has(f) || /\.test\.(mjs|sh)$/.test(f) || /(^|\/)test_[^/]*\.sh$/.test(f)) continue;
    let text;
    try {
      text = readFileSync(path.join(repoRoot, f), "utf8");
    } catch {
      continue;
    }
    const hits = globs.filter((g) => text.includes(g));
    assert.ok(hits.length < 8, `${f} spells out ${hits.length} trigger globs: a second copy of the list`);
  }
});

// ---- A3: output shape ----------------------------------------------------
test("the command line prints the documented JSON shape for every kind of answer", () => {
  const cases = [
    { files: { "packages/env-spec/src/a.ts": "x" } },
    { files: { "pnpm-lock.yaml": "changed\n" } },
    { files: { "docs/notes.md": "x" } },
    { files: { "brand-new-dir/x.txt": "x" } },
  ];
  for (const { files } of cases) {
    git(fx.dir, "reset", "-q", "--hard", fx.base);
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(fx.dir, p)), { recursive: true });
      writeFileSync(path.join(fx.dir, p), c);
    }
    git(fx.dir, "add", "-A");
    git(fx.dir, "commit", "-q", "-m", "c");
    const out = spawnSync(process.execPath, [CLI, "--repo", fx.dir, "--base", fx.base, "--head", "HEAD"], { encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    assertShape(JSON.parse(out.stdout));
  }
  git(fx.dir, "reset", "-q", "--hard", fx.base);
  // A nonsense command line is a full run with a reason, not a crash and not a quiet pass.
  const bad = spawnSync(process.execPath, [CLI, "--bogus"], { encoding: "utf8" });
  const r = JSON.parse(bad.stdout);
  assertShape(r);
  assert.equal(r.mode, "full");
  assert.match(r.reason, /classifier error/);
});

test("the answer comes back in well under 30 seconds on the real repository", () => {
  const t0 = Date.now();
  const out = spawnSync(process.execPath, [CLI, "--base", "HEAD", "--head", "HEAD"], { encoding: "utf8", cwd: repoRoot });
  assert.equal(out.status, 0, out.stderr);
  assertShape(JSON.parse(out.stdout));
  assert.ok(Date.now() - t0 < 30_000);
});

// ---- A4, A5: the leaf and dependent tests --------------------------------
test("the workspace manifests have no workspace edge that the independent walk would miss", () => {
  // The classifier also counts peer and optional dependencies and any dependency that names a workspace
  // package. This keeps the two definitions equal today: if someone adds such an edge, the walk here must
  // learn about it too.
  const names = new Set([...WORKSPACE.values()].map((p) => p.name));
  for (const [dir, { manifest }] of WORKSPACE) {
    for (const field of ["peerDependencies", "optionalDependencies"]) {
      for (const dep of Object.keys(manifest[field] ?? {})) assert.ok(!names.has(dep), `${dir} lists workspace package ${dep} under ${field}`);
    }
    for (const field of ["dependencies", "devDependencies"]) {
      for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
        if (names.has(dep)) assert.ok(String(spec).startsWith("workspace:"), `${dir} depends on ${dep} without workspace:`);
      }
    }
  }
});

test("leaf test: a change to one package selects it and exactly its dependents (packages/env-spec)", () => {
  const r = change({ "packages/env-spec/src/new.ts": "export {};\n" });
  assertShape(r);
  assert.equal(r.mode, "affected");
  const expected = expectedSet("packages/env-spec", DECLARED);
  assert.ok(expected.length > 1, "the fixture must have dependents, or the test proves nothing");
  // The extra edges add nothing for this package, so the declared walk is the whole answer, plus the scan
  // that watches every package's src.
  assert.deepEqual(expectedSet("packages/env-spec", WITH_SRC), expected);
  assert.deepEqual(r.packages, expectedAffected("packages/env-spec", ["packages/env-spec/src/new.ts"]));
});

test("pnpm's own selection agrees with the independent walk", (t) => {
  const probe = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return t.skip("pnpm is not on PATH");
  for (const x of ["packages/env-spec", "packages/billing", "packages/sitekit-claims"]) {
    const out = spawnSync("pnpm", ["ls", "-r", "--depth", "-1", "--json", "--filter", `...${WORKSPACE.get(x).name}`], { encoding: "utf8", cwd: repoRoot });
    assert.equal(out.status, 0, out.stderr);
    const got = JSON.parse(out.stdout).map((p) => path.relative(repoRoot, p.path)).sort();
    assert.deepEqual(got, expectedSet(x, DECLARED), `pnpm --filter ...${x}`);
  }
});

test("every workspace package: the answer is its declared dependents plus the listed extra edges, nothing more or less", () => {
  let checked = 0;
  for (const x of WORKSPACE.keys()) {
    if (rules.triggers.some((t) => globToRegExp(t.glob).test(`${x}/src/probe.ts`))) continue; // a full run, covered below
    const r = change({ [`${x}/src/probe.ts`]: "export {};\n" });
    assert.equal(r.mode, "affected", x);
    assert.deepEqual(r.packages, expectedAffected(x, [`${x}/src/probe.ts`]), x);
    for (const d of expectedSet(x, DECLARED)) assert.ok(r.packages.includes(d), `${x}: declared dependent ${d} is missing`);
    checked += 1;
  }
  assert.ok(checked >= 30, `only ${checked} packages were checked`);
});

test("with the undeclared imports switched off, the Spec's example is exactly the declared set (packages/sitekit-claims)", () => {
  const off = path.join(aux, "no-extra-edges.json");
  writeFileSync(off, JSON.stringify({ ...rules, active_edge_kinds: [] }));
  const r = change({ "packages/sitekit-claims/src/new.ts": "export {};\n" }, { triggerFile: off });
  assert.equal(r.mode, "affected");
  assert.deepEqual(r.packages, [...new Set([...expectedSet("packages/sitekit-claims", DECLARED), ...scanPackages(["packages/sitekit-claims/src/new.ts"])])].sort());
  // ... and with them on, packages that import it by relative path are included.
  const on = change({ "packages/sitekit-claims/src/new.ts": "export {};\n" });
  assert.ok(on.packages.includes("packages/sitekit-publish-gates"));
  for (const d of r.packages) assert.ok(on.packages.includes(d));
  // 'test' edges can be switched off on their own.
  const srcOnly = path.join(aux, "src-edges.json");
  writeFileSync(srcOnly, JSON.stringify({ ...rules, active_edge_kinds: ["src"] }));
  const s = change({ "packages/sitekit-claims/src/new.ts": "export {};\n" }, { triggerFile: srcOnly });
  assert.ok(s.packages.length <= on.packages.length && s.packages.length >= r.packages.length);
});

test("dependent test: a mid-graph package's dependents include apps/web", () => {
  const expected = expectedSet("packages/billing", DECLARED);
  assert.ok(expected.includes("apps/web"), "the fixture package must have apps/web as a dependent");
  const r = change({ "packages/billing/src/new.ts": "export {};\n" });
  assert.equal(r.mode, "affected");
  assert.ok(r.packages.includes("apps/web"));
  assert.ok(r.packages.includes("packages/billing"));
});

test("test edges are not walked: db's tests import packages/api, so an api change selects db but not db's own dependents", () => {
  const edge = TEST_EDGES.find((e) => e.from === "packages/db" && e.to === "packages/api");
  assert.ok(edge, "the fixture edge db -> api must exist");
  const r = change({ "packages/api/src/new.ts": "export {};\n" });
  assert.equal(r.mode, "affected");
  assert.ok(r.packages.includes("packages/db"), "the test edge still selects its `from`");
  const expected = expectedAffected("packages/api", ["packages/api/src/new.ts"]);
  assert.deepEqual(r.packages, expected);
  const only = expectedSet("packages/db", WITH_SRC).filter((d) => !expected.includes(d));
  assert.ok(only.length > 0, "the fixture must have a dependent of db that nothing else reaches, or the test proves nothing");
  for (const d of only) assert.ok(!r.packages.includes(d), `${d} was pulled in through a test edge`);
});

test("test edges do not chain: spend -> runner and runner -> github are both test edges, and a github change stops at runner", () => {
  assert.ok(TEST_EDGES.some((e) => e.from === "packages/spend" && e.to === "packages/runner"));
  assert.ok(TEST_EDGES.some((e) => e.from === "packages/runner" && e.to === "packages/github"));
  assert.ok(!expectedSet("packages/github", WITH_SRC).includes("packages/spend"), "the fixture must not reach spend some other way");
  const r = change({ "packages/github/src/new.ts": "export {};\n" });
  assert.ok(r.packages.includes("packages/runner"));
  assert.ok(!r.packages.includes("packages/spend"));
});

test("repo-wide scan: a source change in any package selects packages/telemetry, a test-only change does not", () => {
  assert.ok(!expectedSet("packages/env-spec", WITH_SRC).includes("packages/telemetry"), "the fixture must not reach telemetry by an edge");
  const src = change({ "packages/env-spec/src/new.ts": "export {};\n" });
  assert.ok(src.packages.includes("packages/telemetry"));
  const web = change({ "apps/web/app/new.ts": "export {};\n" });
  assert.equal(web.mode, "affected");
  assert.ok(web.packages.includes("packages/telemetry"), "apps/web is one of the scanned roots");
  const onlyTests = change({ "packages/env-spec/test/new.test.ts": "export {};\n" });
  assert.equal(onlyTests.mode, "affected");
  assert.ok(!onlyTests.packages.includes("packages/telemetry"));
  assert.deepEqual(onlyTests.packages, expectedAffected("packages/env-spec", ["packages/env-spec/test/new.test.ts"]));
});

test("repo-wide scan: a malformed list, or a package that does not exist, is a full run naming the problem", () => {
  const bad = path.join(aux, "bad-scans.json");
  const good = { package: "packages/telemetry", watch: ["packages/*/src/**"], reason: "x" };
  for (const [name, scans] of [
    ["no watch", [{ package: good.package, reason: "x" }]],
    ["empty watch", [{ ...good, watch: [] }]],
    ["no reason", [{ package: good.package, watch: good.watch }]],
    ["not a list", { ...good }],
  ]) {
    writeFileSync(bad, JSON.stringify({ ...rules, repo_wide_scans: scans }));
    const r = change({ "packages/env-spec/src/a.ts": "x" }, { triggerFile: bad });
    assert.equal(r.mode, "full", name);
    assert.match(r.reason, /repo_wide_scans must be a list/, name);
  }
  writeFileSync(bad, JSON.stringify({ ...rules, repo_wide_scans: [{ ...good, package: "packages/nope" }] }));
  const missing = change({ "packages/env-spec/src/a.ts": "x" }, { triggerFile: bad });
  assert.equal(missing.mode, "full");
  assert.match(missing.reason, /repo_wide_scans names a directory that is not a workspace package/);
  // An absent list is the same as an empty one.
  const without = { ...rules };
  delete without.repo_wide_scans;
  writeFileSync(bad, JSON.stringify(without));
  const none = change({ "packages/env-spec/src/a.ts": "x" }, { triggerFile: bad });
  assert.ok(!none.packages.includes("packages/telemetry"));
});

test("every repo-wide scan names a workspace package, a reason and at least one glob", () => {
  for (const s of rules.repo_wide_scans) {
    assert.ok(WORKSPACE.has(s.package), s.package);
    assert.ok(s.reason.length > 0);
    assert.ok(s.watch.length > 0);
  }
});

// ---- the reach scanner: a test that reads another package must be covered by a rule ---------------------
const SCAN_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SCAN_SKIP = new Set(["node_modules", "dist", ".next", "coverage", "fixtures", "lint-fixtures", ".turbo"]);
const TEST_SUPPORT = /(^|\/)(test|tests|e2e|__tests__)\/|\.(test|spec)\.[a-z]+$|(^|\/)(setup|globalSetup)[^/]*\.[a-z]+$/;

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function walkFiles(dir, rel = "", out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SCAN_SKIP.has(e.name)) walkFiles(path.join(dir, e.name), `${rel}${e.name}/`, out);
    } else if (SCAN_EXT.test(e.name)) out.push(`${rel}${e.name}`);
  }
  return out;
}

/** The workspace package (directory) that owns a repo-relative path, longest match first. */
function ownerOf(repoRel) {
  return [...WORKSPACE.keys()].sort((a, b) => b.length - a.length).find((d) => repoRel === d || repoRel.startsWith(`${d}/`)) ?? null;
}

/**
 * Every other workspace directory that one test-side file reaches: a string literal that climbs out of the
 * package ("../../github/src/x.js", whether imported or read), a literal that names "packages/<x>" or
 * "apps/<x>" from the repository root, or the same split into path.join segments ("packages", "<x>").
 * Returns Map<target dir, first repo-relative path reached>.
 */
function reachesOf(pkgDir, relFile, text) {
  const reached = new Map();
  const note = (repoRel) => {
    const owner = ownerOf(path.posix.normalize(repoRel));
    if (owner && owner !== pkgDir && !reached.has(owner)) reached.set(owner, path.posix.normalize(repoRel));
  };
  const body = stripComments(text);
  const literals = [...body.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2]);
  const fileDir = path.posix.dirname(`${pkgDir}/${relFile}`);
  for (const lit of literals) {
    if (lit.startsWith("../")) note(path.posix.join(fileDir, lit));
    for (const m of lit.matchAll(/(?:^|[\\/.])(packages|apps)\/([A-Za-z0-9_.-]+)(?:\/([^\s"'`$]*))?/g)) note(`${m[1]}/${m[2]}/${m[3] ?? ""}`);
  }
  for (const m of body.matchAll(/["'`](packages|apps)["'`]\s*,\s*["'`]([A-Za-z0-9_.-]+)["'`]((?:\s*,\s*["'`][^"'`,]+["'`])*)/g)) {
    const rest = [...m[3].matchAll(/["'`]([^"'`,]+)["'`]/g)].map((x) => x[1]);
    note([m[1], m[2], ...rest].join("/"));
  }
  return reached;
}

/** Whether a rule makes a change to `target` select `pkg`: a declared or src walk, a test edge, or a scan. */
function reachCovered(pkg, target, repoRelReached) {
  // a change to the reached file is a full run on its own
  const probes = [repoRelReached, `${repoRelReached.replace(/\/$/, "")}/x`];
  if (rules.triggers.some((t) => probes.some((f) => globToRegExp(t.glob).test(f)))) return true;
  if (expectedSet(target, WITH_SRC).includes(pkg)) return true; // pkg depends on target, directly or not
  if (TEST_EDGES.some((e) => e.from === pkg && e.to === target)) return true;
  return (rules.repo_wide_scans ?? []).some(
    (s) => s.package === pkg && s.watch.some((g) => globToRegExp(g).test(repoRelReached) || globToRegExp(g).test(`${repoRelReached.replace(/\/$/, "")}/x`)),
  );
}

/** Reaches that are only a name in a string (an assertion, a message, an expected path), never opened. */
const NAME_ONLY = "the other package's path is only a name in a string (a fixture path, an expected value or a comment); no file of it is opened";
const TEMP_TREE = "the path is written into a temporary directory the test builds, never read from the checkout";
const REACH_MENTION_ONLY = new Map(
  [
    [NAME_ONLY, [
      "apps/live-e2e/test/routing.test.ts -> apps/web",
      "apps/live-e2e/test/routing.test.ts -> packages/billing",
      "apps/workspace/e2e/runs-check.spec.ts -> apps/ops",
      "apps/workspace/test/pipeline-notice-failed-files.test.mjs -> apps/ops",
      "apps/workspace/test/pipeline-notice-failed-files.test.mjs -> packages/api-client",
      "apps/workspace/test/runs-check.test.mjs -> apps/ops",
      "packages/fx-runner/test/daemon/checkStep.test.ts -> apps/ops",
      "packages/fx-runner/test/daemon/checkStepFailedFileNames.test.ts -> packages/worker",
      "packages/fx-runner/test/daemon/derivedFiles.test.ts -> packages/api-client",
      "packages/fx-runner/test/daemon/derivedPinRepro.test.ts -> packages/api",
      "packages/fx-runner/test/daemon/derivedPinRepro.test.ts -> packages/api-client",
      "packages/fx-runner/test/lockfileCheck.test.ts -> apps/gh-proxy",
      "packages/runner-protocol/test/doneCheck.test.ts -> apps/ops",
      "packages/test-guard/test/workspace-coverage.test.ts -> packages/doc-templates",
    ]],
    [TEMP_TREE, [
      "packages/fx-runner/test/checkOfflinePnpm.real.test.ts -> apps/web",
      "packages/fx-runner/test/daemon/checkStep.test.ts -> packages/worker",
      "packages/fx-runner/test/daemon/gitPath.test.ts -> apps/web",
      "packages/fx-runner/test/daemon/gitPathA.test.ts -> apps/web",
      "packages/fx-runner/test/daemon/importScope.test.ts -> packages/worker",
      "packages/fx-runner/test/daemon/lockfileSync.test.ts -> apps/web",
      "packages/fx-runner/test/daemon/resumeClean.test.ts -> apps/web",
      "packages/fx-runner/test/filePermissions.test.ts -> apps/web",
      "packages/test-guard/test/sourceFiles.test.ts -> apps/web",
      "packages/test-guard/test/sourceFiles.test.ts -> packages/api",
      "packages/test-guard/test/sourceFiles.test.ts -> packages/runner",
      "packages/test-guard/test/sourceFiles.test.ts -> packages/worker",
      "packages/test-guard/test/workspace-coverage.test.ts -> apps/web",
    ]],
  ].flatMap(([why, keys]) => keys.map((k) => [k, why])),
);

const WALK_TOKEN = /readdirSync|readdir\(|ls-files|globSync|\bwalk\(|\bsources\(|listSource|collectFiles/;

/** The bare tree roots ("packages", "apps") a test file hands to a directory walk, whatever it then reads. */
function bareRoots(text) {
  const body = stripComments(text);
  if (!WALK_TOKEN.test(body)) return [];
  const roots = new Set();
  for (const m of body.matchAll(/["'`](packages|apps)["'`](?!\s*,\s*["'`][^"'`]+["'`])/g)) roots.add(m[1]);
  return [...roots];
}

/**
 * A walk rooted at the repository root: a directory walker or lister handed the root variable, or a `git ls-files`
 * with no pathspec (everything tracked). Returns a short description of each.
 */
function repoRootWalks(text) {
  const body = stripComments(text);
  const found = [];
  // One argument, the root itself: a walker handed other arguments (a list of directories to read) is not whole-tree.
  if (/\b\w*(?:walk|list|scan|sources|collect)\w*\(\s*(?:REPO_ROOT|ROOT|repoRoot|REPO|root)\s*\)/i.test(body)) found.push("a walk of the repository root");
  if (/readdirSync\(\s*(?:REPO_ROOT|ROOT|repoRoot|REPO)\s*[,)]/.test(body)) found.push("a listing of the repository root");
  for (const m of body.matchAll(/["'`]ls-files["'`]([^)\n]*)/g)) if (!/["'`]--["'`]/.test(m[1])) found.push("a git ls-files with no pathspec");
  return found;
}

/** Whether the package has a repo-wide scan that watches at least one of these sample paths. */
function scanWatchesAny(pkg, samples) {
  return (rules.repo_wide_scans ?? []).some((s) => s.package === pkg && s.watch.some((g) => samples.some((x) => globToRegExp(g).test(x))));
}
const TREE_SAMPLES = {
  packages: ["packages/zzz/src/a.ts", "packages/zzz/vitest.config.ts", "packages/zzz/package.json"],
  apps: ["apps/zzz/a.ts", "apps/zzz/vitest.config.ts", "apps/zzz/package.json"],
};

/**
 * A bare-root walk is covered when the file's own package has a scan entry that watches something in that tree.
 * What a given test reads is not knowable here, so the entry's watch is the author's claim; the test only
 * insists that one exists.
 */
function bareRootCovered(pkg, root) {
  return scanWatchesAny(pkg, TREE_SAMPLES[root]);
}

/** A repo-root walk is covered when the package has a scan entry watching something under packages, apps or docs. */
function repoRootCovered(pkg) {
  return scanWatchesAny(pkg, [...TREE_SAMPLES.packages, ...TREE_SAMPLES.apps, "docs/zzz/a.md"]);
}

/** Test files whose walk is over a temporary or synthetic tree, or the app's own directory, never the checkout's other packages. */
const BARE_ROOT_EXEMPT = new Map([
  ["apps/workspace/test/first-party-build.test.mjs", "walks apps/workspace/apps, the app's own directory"],
  ["apps/workspace/test/lib-helpers.test.mjs", "walks apps/workspace/apps, the app's own directory"],
  ["apps/workspace/test/pipeline-needs-you-entry.test.mjs", "reads named files under packages/api/fixtures; its walk is of the app's own directory"],
  ["packages/fx-runner/test/daemon/lockfileSync.test.ts", "builds its own temporary workspace with a packages directory"],
  ["apps/workspace/test/roles-autonomy-limits.test.mjs", "its root is apps/workspace, the app's own directory"],
  ["packages/fx-runner/test/daemon/checkStepFailedFileNames.test.ts", "lists files of a temporary git repository it builds"],
  ["packages/fx-runner/test/daemon/gitPathA.test.ts", "lists files of a temporary git repository it builds"],
  ["packages/fx-runner/test/daemon/hostReadFollowups.test.ts", "lists files of a temporary git repository it builds"],
  ["packages/fx-runner/test/daemon/jobHandlerMemoryOffer.test.ts", "walks a temporary directory it creates"],
  ["packages/fx-runner/test/daemon/nestedGitCasefold.test.ts", "lists files of a temporary git repository it builds"],
  ["packages/fx-runner/test/selfBuildProbe.test.ts", "walks a temporary directory it creates"],
  ["packages/test-guard/test/sourceFiles.test.ts", "lists synthetic trees it writes into a temporary directory"],
]);

function uncoveredBareWalks() {
  const missing = [];
  for (const pkg of WORKSPACE.keys()) {
    for (const rel of walkFiles(path.join(repoRoot, pkg))) {
      if (!TEST_SUPPORT.test(rel) || BARE_ROOT_EXEMPT.has(`${pkg}/${rel}`)) continue;
      for (const root of bareRoots(readFileSync(path.join(repoRoot, pkg, rel), "utf8"))) {
        if (!bareRootCovered(pkg, root)) missing.push(`${pkg}/${rel} walks the bare "${root}" root`);
      }
      const text = readFileSync(path.join(repoRoot, pkg, rel), "utf8");
      for (const what of repoRootWalks(text)) {
        if (!repoRootCovered(pkg)) missing.push(`${pkg}/${rel} does ${what}`);
      }
    }
  }
  return missing;
}

test("scanner: a test that walks a bare packages or apps root has a repo_wide_scans entry for what it can reach", () => {
  const missing = uncoveredBareWalks();
  assert.deepEqual(missing, [], `these tests walk a whole tree, which no edge can describe (add a repo_wide_scans entry with a watch for it):\n${missing.join("\n")}`);
});

test("scanner: bare-root detection sees a walk over a root and ignores a named package or a file with no walk", () => {
  assert.deepEqual(bareRoots('const a = readdirSync(path.join(root, "packages"));'), ["packages"]);
  assert.deepEqual(bareRoots('walk(join(ROOT, "apps")); walk(join(ROOT, "packages"));').sort(), ["apps", "packages"]);
  assert.deepEqual(bareRoots('readdirSync(path.join(root, "packages", "telemetry", "src"));'), []);
  assert.deepEqual(bareRoots('const a = join(root, "packages");'), []);
  assert.equal(bareRootCovered("packages/env-spec", "packages"), false);
  assert.deepEqual(repoRootWalks('const files = git(REPO_ROOT, "ls-files", "-z").split("\\0");'), ["a git ls-files with no pathspec"]);
  assert.deepEqual(repoRootWalks('git("ls-files", "--", "apps", "packages")'), []);
  assert.deepEqual(repoRootWalks("const files = listFiles(REPO_ROOT).filter(Boolean);"), ["a walk of the repository root"]);
  assert.deepEqual(repoRootWalks('const one = listFiles(path.join(REPO_ROOT, "packages", "x"));'), []);
  assert.equal(repoRootCovered("packages/env-spec"), false);
});

function uncoveredReaches() {
  const missing = [];
  for (const pkg of WORKSPACE.keys()) {
    for (const rel of walkFiles(path.join(repoRoot, pkg))) {
      if (!TEST_SUPPORT.test(rel)) continue;
      const text = readFileSync(path.join(repoRoot, pkg, rel), "utf8");
      for (const [target, reachedPath] of reachesOf(pkg, rel, text)) {
        if (reachCovered(pkg, target, reachedPath)) continue;
        if (REACH_MENTION_ONLY.has(`${pkg}/${rel} -> ${target}`)) continue;
        missing.push(`${pkg}/${rel} -> ${reachedPath}`);
      }
    }
  }
  return missing;
}

test("scanner: every package's test files that import or read another package are covered by a declared dependency, a src or test extra edge, or a repo-wide scan", () => {
  const missing = uncoveredReaches();
  assert.deepEqual(missing, [], `these tests reach another package with no rule that selects them when it changes (add an extra_edges entry or a repo_wide_scans watch):\n${missing.join("\n")}`);
});

test("scanner: every mention-only entry names a test file, a target directory and a reason", () => {
  for (const [key, why] of REACH_MENTION_ONLY) {
    assert.match(key, /^(apps|packages)\/[\w.-]+\/\S+ -> (apps|packages)\/[\w.-]+$/, key);
    assert.ok(why.length > 0, key);
  }
});

test("scanner: it sees an import, a by-path read and a segmented path, and it has teeth", () => {
  const imp = reachesOf("packages/a", "test/x.test.ts", 'import { f } from "../../github/src/x.js";');
  assert.deepEqual([...imp.keys()], ["packages/github"]);
  const read = reachesOf("packages/a", "test/x.test.ts", 'readFileSync(new URL("../../../apps/web/vercel.json", import.meta.url));');
  assert.deepEqual([...read.keys()], ["apps/web"]);
  const seg = reachesOf("packages/a", "test/x.test.ts", 'path.join(ROOT, "packages", "telemetry", "src", "a.ts")');
  assert.deepEqual([...seg.keys()], ["packages/telemetry"]);
  assert.equal(reachesOf("packages/a", "test/x.test.ts", '// "../../github/src/x.js"\nconst a = "../src/y.js";').size, 0);
  // a reach no rule covers is reported: a package with no dependency, edge or scan on its target
  assert.equal(reachCovered("packages/env-spec", "packages/runner-protocol", "packages/runner-protocol/x"), false);
});

test("every extra edge names two workspace packages and a real reason", () => {
  for (const e of rules.extra_edges) {
    assert.ok(WORKSPACE.has(e.from), e.from);
    assert.ok(WORKSPACE.has(e.to), e.to);
    assert.ok(e.kind === "src" || e.kind === "test", `${e.from} -> ${e.to}: kind ${e.kind}`);
    assert.ok(e.reason.length > 0);
    // Targets that already force a full run on their own are not worth an edge.
    assert.ok(!["packages/core", "packages/db", "packages/test-guard"].includes(e.to), `${e.from} -> ${e.to}`);
  }
});

// ---- A6: every trigger ---------------------------------------------------
for (const t of rules.triggers) {
  test(`trigger ${t.glob}: one matching file alone gives a full run naming it`, () => {
    const file = sampleFor(t.glob);
    assert.ok(globToRegExp(t.glob).test(file), `sample ${file} does not match ${t.glob}`);
    const r = change({ [file]: "x\n" });
    assertShape(r);
    assert.equal(r.mode, "full");
    assert.equal(r.trigger, t.glob);
    assert.ok(r.reason.includes(file));
  });
}

test("a trigger beats the ignore list and a package's own files", () => {
  assert.equal(change({ "docs/ops/staging.md": "x\n" }).trigger, "docs/ops/staging.md");
  assert.equal(change({ "packages/core/README.md": "x\n" }).trigger, "packages/core/**");
  assert.equal(change({ "scripts/notes.md": "x\n" }).trigger, "scripts/**");
});

test("globs are anchored at the root: a nested package.json or tsconfig is not the root one", () => {
  assert.equal(change({ "packages/env-spec/tsconfig.json": "{}\n" }).mode, "affected");
  assert.equal(change({ "packages/env-spec/package.json": JSON.stringify(WORKSPACE.get("packages/env-spec").manifest) + "\n" }).mode, "affected");
  assert.equal(change({ "tsconfig.base.json": "{}\n" }).trigger, "tsconfig*.json");
});

// ---- A7: fail closed -----------------------------------------------------
test("a file outside every package, trigger and ignore pattern gives a full run that names it", () => {
  const r = change({ "brand-new-dir/thing.txt": "x\n" });
  assertShape(r);
  assert.equal(r.mode, "full");
  assert.equal(r.trigger, null);
  assert.match(r.reason, /brand-new-dir\/thing\.txt belongs to no workspace package/);
  // one such file among otherwise-fine ones still widens
  assert.equal(change({ "packages/env-spec/src/a.ts": "x", "brand-new-dir/thing.txt": "x" }).mode, "full");
});

test("an unresolvable base SHA gives a full run that says so", () => {
  for (const base of ["0000000000000000000000000000000000000000", "not-a-sha", "deadbeef".repeat(5)]) {
    const r = classify({ repoRoot: fx.dir, base, head: "HEAD" });
    assertShape(r);
    assert.equal(r.mode, "full");
    assert.match(r.reason, /base SHA cannot be resolved/);
  }
  assert.match(classify({ repoRoot: fx.dir, base: undefined, head: "HEAD" }).reason, /base SHA not given/);
  assert.match(classify({ repoRoot: fx.dir, base: fx.base, head: "0".repeat(40) }).reason, /head SHA cannot be resolved/);
});

test("a dependency graph that cannot be read gives a full run that says so", () => {
  const broken = change({ "packages/env-spec/package.json": "{ not json" });
  assert.equal(broken.mode, "full");
  assert.match(broken.reason, /dependency graph unreadable.*packages\/env-spec\/package\.json/);
  const nameless = change({ "packages/env-spec/package.json": "{}\n" });
  assert.equal(nameless.mode, "full");
  assert.match(nameless.reason, /dependency graph unreadable/);
});

test("a trigger file that cannot be read gives a full run that says so", () => {
  const r = change({ "packages/env-spec/src/a.ts": "x" }, { triggerFile: path.join(aux, "nope.json") });
  assert.equal(r.mode, "full");
  assert.match(r.reason, /trigger file unreadable/);
  const bad = path.join(aux, "bad-triggers.json");
  writeFileSync(bad, JSON.stringify({ version: "one", triggers: [] }));
  assert.match(change({ "packages/env-spec/src/a.ts": "x" }, { triggerFile: bad }).reason, /missing integer version/);
  writeFileSync(bad, JSON.stringify({ ...rules, extra_edges: [{ from: "packages/nope", to: "packages/env-spec", kind: "src", reason: "x" }] }));
  assert.match(change({ "packages/env-spec/src/a.ts": "x" }, { triggerFile: bad }).reason, /not a workspace package/);
});

test("the ignore list gives an affected run of no packages", () => {
  for (const file of ["docs/guide.md", "docs/deep/er/x.png", "wiki/index.md", "README.md", "notes/todo.md", ".autonomous-team/PLAN-x.md"]) {
    const r = change({ [file]: "x\n" });
    assertShape(r);
    assert.equal(r.mode, "affected", file);
    assert.deepEqual(r.packages, [], file);
    assert.equal(r.e2e, false, file);
  }
  assert.equal(scopeLine(change({ "docs/guide.md": "x" })), "CI scope: affected — 0 packages (ignored paths only)");
});

test("globs: * and ? stay inside a directory, ** crosses them, everything is anchored", () => {
  const m = (glob, file) => globToRegExp(glob).test(file);
  assert.ok(m("a/*.md", "a/b.md"));
  assert.ok(!m("a/*.md", "a/b/c.md"), "* must not cross a directory");
  assert.ok(!m("a/?.md", "a/bc.md"));
  assert.ok(!m("a/?.md", "a//.md"), "? must not match a slash");
  assert.ok(m("a/**", "a/b/c/d.md"));
  assert.ok(m("a/**/c.md", "a/c.md"), "**/ may match nothing");
  assert.ok(m("a/**/c.md", "a/x/y/c.md"));
  assert.ok(m("**/*.md", "README.md"));
  assert.ok(m("**/*.md", "x/y/README.md"));
  assert.ok(!m("package.json", "packages/x/package.json"), "anchored at the root");
  assert.ok(!m("package.json", "xpackage.json"));
  assert.ok(!m("a.b", "aXb"), "a dot is a dot");
  assert.ok(m("tsconfig*.json", "tsconfig.base.json"));
  assert.ok(!m("tsconfig*.json", "sub/tsconfig.json"));
});

test("an empty range is an affected run of no packages", () => {
  const r = classify({ repoRoot: fx.dir, base: fx.base, head: fx.base });
  assertShape(r);
  assert.match(r.reason, /no changed files/);
  assert.match(change({ "docs/a.md": "x" }).reason, /only ignored paths changed/);
  assert.equal(r.mode, "affected");
  assert.deepEqual(r.packages, []);
  assert.equal(r.e2e, false);
});

test("a deleted or renamed file counts at both its old and new path", () => {
  // Moving a file out of a trigger directory still touches the trigger.
  git(fx.dir, "reset", "-q", "--hard", fx.base);
  mkdirSync(path.join(fx.dir, "scripts"), { recursive: true });
  writeFileSync(path.join(fx.dir, "scripts/tool.sh"), "echo hi\n");
  git(fx.dir, "add", "-A");
  git(fx.dir, "commit", "-q", "-m", "add tool");
  const mid = git(fx.dir, "rev-parse", "HEAD");
  mkdirSync(path.join(fx.dir, "packages/env-spec/src"), { recursive: true });
  git(fx.dir, "mv", "scripts/tool.sh", "packages/env-spec/src/tool.sh");
  git(fx.dir, "commit", "-q", "-m", "move tool");
  const r = classify({ repoRoot: fx.dir, base: mid, head: "HEAD" });
  assert.equal(r.mode, "full");
  assert.equal(r.trigger, "scripts/**");
  git(fx.dir, "reset", "-q", "--hard", fx.base);
});

// ---- A8: the range (D#497 class) ------------------------------------------
test("range test: uncommitted edits to a trigger file are never seen", () => {
  git(fx.dir, "reset", "-q", "--hard", fx.base);
  mkdirSync(path.join(fx.dir, "packages/env-spec/src"), { recursive: true });
  writeFileSync(path.join(fx.dir, "packages/env-spec/src/a.ts"), "export {};\n");
  git(fx.dir, "add", "-A");
  git(fx.dir, "commit", "-q", "-m", "leaf change");
  const head = git(fx.dir, "rev-parse", "HEAD");
  // Tracked file edited but not committed, a staged edit, and an untracked file: none is part of base..head.
  writeFileSync(path.join(fx.dir, "pnpm-lock.yaml"), "lockfileVersion: 2\n");
  writeFileSync(path.join(fx.dir, "flake.nix"), "{}\n");
  git(fx.dir, "add", "flake.nix");
  writeFileSync(path.join(fx.dir, "package.json"), "{}\n");
  const r = classify({ repoRoot: fx.dir, base: fx.base, head });
  assert.equal(r.mode, "affected");
  assert.deepEqual(r.packages, expectedAffected("packages/env-spec", ["packages/env-spec/src/probe.ts"]));
  git(fx.dir, "reset", "-q", "--hard", fx.base);
  rmSync(path.join(fx.dir, "package.json"), { force: true });
});

/** Builds GitHub's synthetic merge of a PR: parent 1 is the base tip, parent 2 the PR head. */
function syntheticMerge({ branchMergesMain }) {
  git(fx.dir, "reset", "-q", "--hard", fx.base);
  git(fx.dir, "checkout", "-q", "-B", "feature", fx.base);
  mkdirSync(path.join(fx.dir, "packages/env-spec/src"), { recursive: true });
  writeFileSync(path.join(fx.dir, "packages/env-spec/src/a.ts"), "export {};\n");
  git(fx.dir, "add", "-A");
  git(fx.dir, "commit", "-q", "-m", "leaf change");
  git(fx.dir, "checkout", "-q", "-B", "main", fx.base);
  writeFileSync(path.join(fx.dir, "pnpm-lock.yaml"), "lockfileVersion: 3 # changed on main\n");
  git(fx.dir, "add", "-A");
  git(fx.dir, "commit", "-q", "-m", "main moves: lockfile");
  if (branchMergesMain) {
    git(fx.dir, "checkout", "-q", "feature");
    git(fx.dir, "merge", "-q", "--no-ff", "--no-edit", "main");
  }
  git(fx.dir, "checkout", "-q", "-B", "synthetic", "main");
  git(fx.dir, "merge", "-q", "--no-ff", "--no-edit", "feature");
  return { synth: git(fx.dir, "rev-parse", "HEAD"), c0: fx.base };
}

test("range test: a branch that already merged main does not widen the scope (HEAD^1..HEAD)", () => {
  const { synth, c0 } = syntheticMerge({ branchMergesMain: true });
  assert.equal(git(fx.dir, "rev-list", "--parents", "-n", "1", synth).split(" ").length, 3, "a two-parent merge commit");
  const right = classify({ repoRoot: fx.dir, base: `${synth}^1`, head: synth });
  assert.equal(right.mode, "affected");
  assert.deepEqual(right.packages, expectedAffected("packages/env-spec", ["packages/env-spec/src/probe.ts"]));
  // The same answer through the command line, spelled as the workflow spells it.
  const cli = spawnSync(process.execPath, [CLI, "--repo", fx.dir, "--base", "HEAD^1", "--head", "HEAD"], { encoding: "utf8", cwd: fx.dir });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).mode, "affected");
  // The wrong range (from the fork point) would have picked up main's lockfile change: that is the bug class.
  const wrong = classify({ repoRoot: fx.dir, base: c0, head: synth });
  assert.equal(wrong.mode, "full");
  assert.equal(wrong.trigger, "pnpm-lock.yaml");
  git(fx.dir, "checkout", "-q", "-B", "main", fx.base);
});

test("range test: the same holds when the branch never merged main", () => {
  const { synth } = syntheticMerge({ branchMergesMain: false });
  const r = classify({ repoRoot: fx.dir, base: `${synth}^1`, head: synth });
  assert.equal(r.mode, "affected");
  assert.deepEqual(r.packages, expectedAffected("packages/env-spec", ["packages/env-spec/src/probe.ts"]));
  git(fx.dir, "checkout", "-q", "-B", "main", fx.base);
});

// ---- A9: e2e relevance -----------------------------------------------------
for (const p of rules.e2e_paths) {
  test(`e2e: a change under ${p.glob} turns e2e on`, () => {
    const file = sampleFor(p.glob);
    assert.ok(globToRegExp(p.glob).test(file));
    const r = change({ [file]: "x\n" });
    // some of these paths are also full-run triggers (the lockfile): e2e is the question here, not the mode
    assert.equal(r.e2e, true);
  });
}

test("e2e: the spec's path list is covered", () => {
  const have = rules.e2e_paths.map((p) => p.glob);
  for (const g of ["apps/workspace/**", "apps/web/**", "packages/api/src/routes/**", "packages/api/openapi.json", "packages/api/fixtures/**"]) {
    assert.ok(have.includes(g), g);
  }
});

test("e2e: a leaf package, a package that only feeds apps/web, and an ignored path leave it off; a full run turns it on", () => {
  assert.equal(change({ "packages/env-spec/src/a.ts": "x" }).e2e, false);
  const feeds = change({ "packages/billing/src/a.ts": "x" });
  assert.ok(feeds.packages.includes("apps/web"));
  assert.equal(feeds.e2e, false);
  assert.equal(change({ "packages/api/src/other/a.ts": "x" }).e2e, false);
  assert.equal(change({ "docs/guide.md": "x" }).e2e, false);
  assert.equal(change({ "pnpm-lock.yaml": "x" }).e2e, true);
});

// ---- A16: the kill switch --------------------------------------------------
test("CI_FORCE_FULL=true and the ci:full label each force a full run, whatever the change", () => {
  const leaf = { "packages/env-spec/src/a.ts": "x" };
  const a = change(leaf, { forceFull: "true" });
  assertShape(a);
  assert.equal(a.mode, "full");
  assert.equal(a.reason, "CI_FORCE_FULL");
  assert.equal(scopeLine(a), "CI scope: full (CI_FORCE_FULL)");
  const b = change(leaf, { labels: ["bug", "ci:full"] });
  assert.equal(b.mode, "full");
  assert.equal(scopeLine(b), "CI scope: full (label ci:full)");
  // ... even for an ignored-only change, and even when the range cannot be resolved
  assert.equal(change({ "docs/x.md": "x" }, { forceFull: "true" }).mode, "full");
  assert.equal(classify({ repoRoot: fx.dir, base: "nope", head: "HEAD", forceFull: "true" }).reason, "CI_FORCE_FULL");
});

test("anything but exactly true leaves the natural mode; so does a label that only looks similar", () => {
  const leaf = { "packages/env-spec/src/a.ts": "x" };
  for (const v of ["", "false", "TRUE", "True", "1", "yes", " true", "true "]) assert.equal(change(leaf, { forceFull: v }).mode, "affected", JSON.stringify(v));
  for (const labels of [[], ["ci:fullish"], ["CI:full"], ["ci-full"], ["full"]]) assert.equal(change(leaf, { labels }).mode, "affected", labels.join());
});

test("the command line takes both inputs", () => {
  const run = (...extra) => JSON.parse(spawnSync(process.execPath, [CLI, "--repo", fx.dir, "--base", fx.base, "--head", fx.base, ...extra], { encoding: "utf8" }).stdout);
  assert.equal(run().mode, "affected");
  assert.equal(run("--force-full", "true").reason, "CI_FORCE_FULL");
  assert.equal(run("--force-full", "").mode, "affected");
  assert.equal(run("--labels", "a, ci:full ,b").reason, "label ci:full");
  assert.equal(run("--labels", "").mode, "affected");
});

// ---- what the PR page shows ---------------------------------------------
test("the scope line and the e2e skip line never print an empty list, undefined or null", () => {
  const results = [
    change({ "pnpm-lock.yaml": "x" }),
    change({ "brand-new-dir/x": "x" }),
    change({ "packages/env-spec/src/a.ts": "x" }),
    change({ "docs/a.md": "x" }),
    change({ "packages/env-spec/src/a.ts": "x" }, { forceFull: "true" }),
    change({ "packages/env-spec/src/a.ts": "x" }, { labels: ["ci:full"] }),
  ];
  for (const r of results) {
    for (const line of [scopeLine(r), e2eSkipLine(r)]) {
      assert.doesNotMatch(line, /undefined|null|\[\]|\(\)|: $|NaN/, line);
    }
    assert.match(scopeLine(r), /^CI scope: (full \(.+\)|affected — \d+ packages(: .+| \(ignored paths only\)))$/);
  }
  assert.equal(scopeLine(results[0]), "CI scope: full (pnpm-lock.yaml)");
  assert.match(scopeLine(results[1]), /^CI scope: full \(brand-new-dir\/x belongs to no workspace package/);
  assert.equal(scopeLine(results[2]), `CI scope: affected — ${results[2].packages.length} packages: ${results[2].packages.join(", ")}`);
  assert.match(e2eSkipLine(results[2]), /^skipped: not affected \(.+\)$/);
});

// ---- the GitHub step: environment, summary, skip line --------------------
function runStep(files, args = []) {
  git(fx.dir, "reset", "-q", "--hard", fx.base);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(fx.dir, p)), { recursive: true });
    writeFileSync(path.join(fx.dir, p), c);
  }
  git(fx.dir, "add", "-A");
  git(fx.dir, "commit", "-q", "-m", "c");
  const envFile = path.join(aux, "env");
  const summary = path.join(aux, "summary");
  writeFileSync(envFile, "");
  writeFileSync(summary, "");
  const out = spawnSync(process.execPath, [CLI, "--repo", fx.dir, "--base", "HEAD^1", "--head", "HEAD", "--github", ...args], {
    encoding: "utf8",
    cwd: fx.dir,
    env: { ...process.env, GITHUB_ENV: envFile, GITHUB_STEP_SUMMARY: summary },
  });
  const env = Object.fromEntries(readFileSync(envFile, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const result = { out, env, summary: readFileSync(summary, "utf8"), stderr: out.stderr };
  rmSync(envFile, { force: true });
  rmSync(summary, { force: true });
  git(fx.dir, "reset", "-q", "--hard", fx.base);
  return result;
}

test("--github: an affected run exports the package list, the scope line and the e2e answer", () => {
  const s = runStep({ "packages/env-spec/README.md": "x" });
  const r = JSON.parse(s.out.stdout);
  assert.equal(s.env.CI_SCOPE_MODE, "affected");
  assert.equal(s.env.FX_CHECK_AFFECTED, r.packages.join(","));
  assert.equal(s.env.CI_SCOPE_E2E, "false");
  assert.equal(s.env.CI_SCOPE_RUNNER_PROTOCOL, "false");
  assert.equal(s.summary.trim(), scopeLine(r));
  assert.ok(s.stderr.includes(scopeLine(r)));
});

test("--github: a full run exports no package list and turns every part on", () => {
  const s = runStep({ "pnpm-lock.yaml": "x" });
  assert.equal(s.env.CI_SCOPE_MODE, "full");
  assert.ok(!("FX_CHECK_AFFECTED" in s.env));
  assert.equal(s.env.CI_SCOPE_E2E, "true");
  assert.equal(s.env.CI_SCOPE_RUNNER_PROTOCOL, "true");
  assert.equal(s.summary.trim(), "CI scope: full (pnpm-lock.yaml)");
});

test("--github: an ignored-only change exports the word none, never an empty list", () => {
  const s = runStep({ "docs/a.md": "x" });
  assert.equal(s.env.FX_CHECK_AFFECTED, "none");
  assert.equal(s.summary.trim(), "CI scope: affected — 0 packages (ignored paths only)");
});

test("--github: the Node 22 step is wanted exactly when runner-protocol or fx-runner is affected", () => {
  assert.equal(runStep({ "packages/runner-protocol/src/a.ts": "x" }).env.CI_SCOPE_RUNNER_PROTOCOL, "true");
  assert.equal(runStep({ "packages/fx-runner/src/a.ts": "x" }).env.CI_SCOPE_RUNNER_PROTOCOL, "true");
  assert.equal(runStep({ "packages/env-spec/README.md": "x" }).env.CI_SCOPE_RUNNER_PROTOCOL, "false");
  // runner-protocol's test walks every package's src, so a src change anywhere selects it
  assert.equal(runStep({ "packages/env-spec/src/a.ts": "x" }).env.CI_SCOPE_RUNNER_PROTOCOL, "true");
});

test("--e2e-step: prints the skip line when the specs are not affected and stays quiet when they are", () => {
  const skipped = runStep({ "packages/env-spec/src/a.ts": "x" }, ["--e2e-step"]);
  assert.match(skipped.stderr, /^skipped: not affected \(.+\)$/m);
  assert.equal(skipped.env.CI_SCOPE_E2E, "false");
  const runs = runStep({ "apps/workspace/shell/x.js": "x" }, ["--e2e-step"]);
  assert.doesNotMatch(runs.stderr, /skipped: not affected/);
  assert.equal(runs.env.CI_SCOPE_E2E, "true");
});

test("--github: a file name with a newline cannot inject a variable into the environment file", () => {
  const s = runStep({ "weird\nINJECTED=1.txt": "x" });
  assert.equal(s.env.CI_SCOPE_MODE, "full");
  assert.ok(!("INJECTED" in s.env));
  assert.ok(!s.summary.trim().includes("\n"));
  assert.equal(JSON.parse(s.out.stdout).mode, "full");
});

// ---- the vitest project mapping -----------------------------------------
test("vitest-projects maps directories to the project names vitest reports", () => {
  const listing = [
    "[@fx/api] packages/api/test/a.test.ts",
    "[@fx/api] packages/api/test/b.test.ts",
    "[web] apps/web/test/x.test.ts",
    "[lint-rules] lint/a.test.mjs",
    "[@fx/runner] packages/runner/test/a.test.ts",
    "[@fx/runner-cloud] packages/runner-cloud/test/a.test.ts",
    "noise that is not a project line",
  ].join("\n");
  const by = parseList(listing);
  assert.deepEqual(projectsFor(by, ["packages/api"]), ["@fx/api"]);
  assert.deepEqual(projectsFor(by, ["apps/web", "packages/api"]), ["@fx/api", "web"]);
  assert.deepEqual(projectsFor(by, ["packages/runner"]), ["@fx/runner"], "a directory name that is a prefix of another is not a match");
  assert.deepEqual(projectsFor(by, ["packages/nothing"]), []);
});

test("vitest-projects agrees with vitest itself on the real workspace", (t) => {
  const probe = spawnSync("pnpm", ["exec", "vitest", "--version"], { encoding: "utf8", cwd: repoRoot });
  if (probe.error || probe.status !== 0) return t.skip("vitest is not installed");
  const out = spawnSync(process.execPath, [path.join(here, "vitest-projects.mjs"), "packages/sitekit-claims", "apps/web", "apps/workspace", "infra"], { encoding: "utf8", cwd: repoRoot });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.stdout.trim().split("\n"), ["@fx/sitekit-claims", "web", "workspace"]);
});

// ---- the ci:full label comes from the API, never from the event payload ---------------------
// A re-run of a workflow run replays the original event payload, whose label list is whatever it was when the
// run began. The scope steps therefore ask the API at the moment they run. The fake below is a local HTTP
// server that, like api.github.com, refuses a request without a token or a User-Agent and pages at per_page.
const labelServer = {
  requests: [],
  respond: () => ({ status: 200, body: [] }),
};
let labelHttp;
let labelEnv;
before(async () => {
  labelHttp = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    labelServer.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.method !== "GET" || url.pathname !== "/repos/acme/widgets/issues/7/labels") return send(404, { message: "Not Found" });
    if (req.headers.authorization !== "Bearer tok-read") return send(401, { message: "Bad credentials" });
    if (!req.headers["user-agent"]) return send(403, { message: "Request forbidden by administrative rules. Please make sure your request has a User-Agent header" });
    if (!String(req.headers.accept ?? "").includes("github+json")) return send(415, { message: "Unsupported" });
    const { status, body, raw } = labelServer.respond(url.searchParams);
    return send(status, raw ?? body);
  });
  await new Promise((resolve) => labelHttp.listen(0, "127.0.0.1", resolve));
  labelEnv = {
    GITHUB_API_URL: `http://127.0.0.1:${labelHttp.address().port}`,
    GITHUB_REPOSITORY: "acme/widgets",
    CI_PR_NUMBER: "7",
    GH_TOKEN: "tok-read",
  };
});
after(() => labelHttp.close());

/** Serve `names` as the PR's labels, paged like GitHub (per_page / page). */
function serveLabels(names) {
  labelServer.respond = (q) => {
    const per = Number(q.get("per_page") ?? 30);
    const page = Number(q.get("page") ?? 1);
    return { status: 200, body: names.slice((page - 1) * per, page * per).map((name) => ({ name, id: 1 })) };
  };
  labelServer.requests.length = 0;
}

async function cli(args, env) {
  const clean = { ...process.env };
  for (const k of ["GITHUB_ENV", "GITHUB_STEP_SUMMARY", "GITHUB_API_URL", "GITHUB_REPOSITORY", "CI_PR_NUMBER", "GH_TOKEN"]) delete clean[k];
  const { stdout } = await execFileAsync(process.execPath, [CLI, "--repo", fx.dir, "--base", fx.base, "--head", fx.base, ...args], { env: { ...clean, ...env }, encoding: "utf8" });
  return JSON.parse(stdout);
}

test("labels from the API: ci:full on the PR forces full, and the request is authenticated and identifies itself", async () => {
  serveLabels(["bug", "ci:full"]);
  const r = await cli(["--labels-api"], labelEnv);
  assert.equal(r.mode, "full");
  assert.equal(r.reason, "label ci:full");
  assert.equal(labelServer.requests.length, 1);
  const q = labelServer.requests[0];
  assert.equal(q.method, "GET");
  assert.equal(q.headers.authorization, "Bearer tok-read");
  // GitHub refuses a request with no User-Agent; Node would add its own, so pin that ours is the explicit one
  assert.equal(q.headers["user-agent"], "fulcrumaxe-ci-scope");
  assert.match(q.headers.accept, /github\+json/);
});

test("labels from the API: no ci:full gives the natural mode (the fail-safe is not a permanent full)", async () => {
  serveLabels(["bug", "ci:fullish", "code-review-passed"]);
  assert.equal((await cli(["--labels-api"], labelEnv)).mode, "affected");
  serveLabels([]);
  assert.equal((await cli(["--labels-api"], labelEnv)).mode, "affected");
});

test("the event payload is not trusted: a --labels value is ignored when the API is used", async () => {
  // This is the re-run case: the payload says ci:full (or does not), the PR says otherwise.
  serveLabels(["bug"]);
  assert.equal((await cli(["--labels-api", "--labels", "ci:full"], labelEnv)).mode, "affected");
  serveLabels(["ci:full"]);
  assert.equal((await cli(["--labels-api", "--labels", "bug"], labelEnv)).reason, "label ci:full");
});

test("labels from the API: ci:full on a later page is found", async () => {
  const names = Array.from({ length: 130 }, (_, i) => `label-${i}`);
  names[120] = "ci:full";
  serveLabels(names);
  const r = await cli(["--labels-api"], labelEnv);
  assert.equal(r.reason, "label ci:full");
  assert.deepEqual(labelServer.requests.map((q) => q.query.page), ["1", "2"]);
});

test("labels from the API: any failure to read them gives FULL, never affected", async () => {
  const expectFull = (r, what) => {
    assert.equal(r.mode, "full", what);
    assert.match(r.reason, /^could not read the pull request labels \(.+\)$/, what);
    assertShape(r);
  };
  const cases = {
    "server error": () => ({ status: 500, body: { message: "boom" } }),
    "forbidden (token lacks the permission)": () => ({ status: 403, body: { message: "Resource not accessible by integration" } }),
    "not found": () => ({ status: 404, body: { message: "Not Found" } }),
    "malformed json": () => ({ status: 200, raw: "{not json" }),
    "not a list": () => ({ status: 200, body: { labels: [] } }),
    "list of non-labels": () => ({ status: 200, body: [1, 2] }),
  };
  for (const [what, respond] of Object.entries(cases)) {
    labelServer.respond = respond;
    expectFull(await cli(["--labels-api"], labelEnv), what);
  }
  // wrong token: the fake refuses like GitHub does
  serveLabels(["bug"]);
  expectFull(await cli(["--labels-api"], { ...labelEnv, GH_TOKEN: "other" }), "wrong token");
  // incomplete environment
  for (const drop of ["GH_TOKEN", "CI_PR_NUMBER", "GITHUB_REPOSITORY"]) {
    const env = { ...labelEnv };
    delete env[drop];
    expectFull(await cli(["--labels-api"], env), `no ${drop}`);
  }
  expectFull(await cli(["--labels-api"], { ...labelEnv, CI_PR_NUMBER: "7/../8" }), "malformed PR number");
  // nothing listening
  const dead = createServer();
  await new Promise((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const port = dead.address().port;
  await new Promise((resolve) => dead.close(resolve));
  expectFull(await cli(["--labels-api"], { ...labelEnv, GITHUB_API_URL: `http://127.0.0.1:${port}` }), "connection refused");
});

test("classify: labels that could not be read widen to full for a change that would be affected", () => {
  const leaf = { "packages/env-spec/src/a.ts": "x" };
  assert.equal(change(leaf).mode, "affected");
  const r = change(leaf, { labelsError: "GitHub API answered 500" });
  assert.equal(r.mode, "full");
  assert.equal(r.reason, "could not read the pull request labels (GitHub API answered 500)");
});

test("CI_FORCE_FULL=true needs no label read at all", async () => {
  serveLabels([]);
  const r = await cli(["--labels-api", "--force-full", "true"], labelEnv);
  assert.equal(r.reason, "CI_FORCE_FULL");
  assert.equal(labelServer.requests.length, 0);
});

test("fetchPrLabels never rejects, whatever the transport does", async () => {
  const boom = async () => {
    throw new Error("socket hang up");
  };
  assert.deepEqual(await fetchPrLabels(labelEnv, boom), { error: "socket hang up" });
  serveLabels(["a", "b"]);
  assert.deepEqual(await fetchPrLabels(labelEnv), { labels: ["a", "b"] });
});

// ---- D#507 follow-up: content-aware rules ---------------------------------
// `change()` above always starts from the bare fixture. These tests need a base that already holds a root
// package.json and the real ci.yml, so the base is built per case from `baseFiles`.
const REAL_CI = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
const REAL_ROOT_PKG = readFileSync(path.join(repoRoot, "package.json"), "utf8");
const NODE_TEST_LINE = /^( {8}run: nix develop .#ci --command node --test .*)$/m;
assert.match(REAL_CI, NODE_TEST_LINE, "the node-test step's run line moved: update NODE_TEST_LINE");

function changeFrom(baseFiles, files, extra = {}) {
  const put = (set) => {
    for (const [p, content] of Object.entries(set)) {
      const abs = path.join(fx.dir, p);
      if (content === null) rmSync(abs, { force: true });
      else {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }
    git(fx.dir, "add", "-A");
  };
  git(fx.dir, "reset", "-q", "--hard", fx.base);
  put(baseFiles);
  git(fx.dir, "commit", "-q", "--allow-empty", "-m", "base2");
  const base = git(fx.dir, "rev-parse", "HEAD");
  put(files);
  git(fx.dir, "commit", "-q", "--allow-empty", "-m", "change");
  const head = git(fx.dir, "rev-parse", "HEAD");
  const result = classify({ repoRoot: fx.dir, base, head, ...extra });
  git(fx.dir, "reset", "-q", "--hard", fx.base);
  return result;
}

const manifestText = (dir) => readFileSync(path.join(repoRoot, dir, "package.json"), "utf8");
/** A manifest's text with `edit` applied to its parsed form. */
const edited = (text, edit) => {
  const doc = JSON.parse(text);
  edit(doc);
  return `${JSON.stringify(doc, null, 2)}\n`;
};
const withKey = (key, value) => (text) => edited(text, (d) => (d[key] = value));

for (const key of rules.metadata_only_keys) {
  test(`package.json: a change to only "${key}" is no trigger, no e2e and selects the package alone, not its dependents`, () => {
    const value = key === "keywords" ? ["x"] : key === "private" ? false : key === "bugs" || key === "repository" ? { url: "https://example.invalid/x" } : "changed value";
    const dir = "packages/env-spec";
    const root = changeFrom({ "package.json": REAL_ROOT_PKG }, { "package.json": withKey(key, value)(REAL_ROOT_PKG) });
    assertShape(root);
    assert.equal(root.mode, "affected", `root package.json, ${key}`);
    assert.deepEqual(root.packages, []);
    assert.equal(root.e2e, false);
    const pkg = changeFrom({}, { [`${dir}/package.json`]: withKey(key, value)(manifestText(dir)) });
    assert.equal(pkg.mode, "affected");
    assert.deepEqual(pkg.packages, [dir], `${dir} alone, no dependents, for a "${key}" edit`);
    assert.equal(pkg.e2e, false);
  });
}

test("package.json: metadata-only edits under full-run packages and e2e directories are no trigger and no e2e; each package selects itself only", () => {
  const files = {};
  for (const dir of ["packages/core", "packages/db", "packages/test-guard", "apps/web", "apps/workspace"]) {
    files[`${dir}/package.json`] = withKey("license", "AGPL-3.0-only-ex507c")(manifestText(dir));
  }
  const r = changeFrom({}, files);
  assert.equal(r.mode, "affected");
  assert.deepEqual(r.packages, ["apps/web", "apps/workspace", "packages/core", "packages/db", "packages/test-guard"]);
  assert.equal(r.e2e, false);
});

test("package.json: a license-only edit to runner-protocol still selects it, so the test that asserts manifest.license runs", () => {
  const dir = "packages/runner-protocol";
  const r = changeFrom({}, { [`${dir}/package.json`]: withKey("license", "AGPL-3.0-only-ex507c")(manifestText(dir)) });
  assert.equal(r.mode, "affected");
  assert.deepEqual(r.packages, [dir]);
  assert.equal(r.e2e, false);
  // its dependents are not pulled in
  assert.ok(expectedSet(dir, WITH_SRC).length > 1);
  // a root manifest edit selects no package and is no trigger
  const root = changeFrom({ "package.json": REAL_ROOT_PKG }, { "package.json": withKey("license", "AGPL-3.0-only-ex507c")(REAL_ROOT_PKG) });
  assert.equal(root.mode, "affected");
  assert.deepEqual(root.packages, []);
});

test("package.json fail-safe: metadata plus a dependency, a script, a version or an engine is NOT exempt", () => {
  const dir = "packages/env-spec";
  const both = (edit) => (text) => edited(text, (d) => { d.license = "AGPL-3.0-only"; edit(d); });
  const dep = changeFrom({}, { [`${dir}/package.json`]: both((d) => (d.dependencies = { ...d.dependencies, "left-pad": "1.3.0" }))(manifestText(dir)) });
  assert.equal(dep.mode, "affected");
  assert.deepEqual(dep.packages, expectedAffected(dir, [`${dir}/package.json`]));
  const rootScript = changeFrom({ "package.json": REAL_ROOT_PKG }, { "package.json": both((d) => (d.scripts = { ...d.scripts, extra: "true" }))(REAL_ROOT_PKG) });
  assert.equal(rootScript.mode, "full");
  assert.equal(rootScript.trigger, "package.json");
  const version = changeFrom({}, { [`${dir}/package.json`]: both((d) => (d.version = "9.9.9"))(manifestText(dir)) });
  assert.deepEqual(version.packages, expectedAffected(dir, [`${dir}/package.json`]));
  const engines = changeFrom({ "package.json": REAL_ROOT_PKG }, { "package.json": withKey("engines", { node: ">=99" })(REAL_ROOT_PKG) });
  assert.equal(engines.trigger, "package.json");
});

test("package.json fail-safe: an unparseable manifest, a new one and a deleted one keep the path rule", () => {
  const broken = changeFrom({ "package.json": REAL_ROOT_PKG }, { "package.json": '{"license": "x",\n' });
  assert.equal(broken.mode, "full");
  assert.equal(broken.trigger, "package.json");
  const brokenBase = changeFrom({ "package.json": "not json" }, { "package.json": withKey("license", "x")(REAL_ROOT_PKG) });
  assert.equal(brokenBase.trigger, "package.json");
  const brokenPkg = changeFrom({}, { "packages/env-spec/package.json": "{ nope" });
  assert.equal(brokenPkg.mode, "full");
  const added = changeFrom({}, { "package.json": REAL_ROOT_PKG });
  assert.equal(added.trigger, "package.json");
  const deleted = changeFrom({ "package.json": REAL_ROOT_PKG }, { "package.json": null });
  assert.equal(deleted.trigger, "package.json");
  const notObject = changeFrom({ "package.json": "[]\n" }, { "package.json": "[1]\n" });
  assert.equal(notObject.trigger, "package.json");
});

test("package.json fail-safe: reordering the keys that remain is not exempt (exports conditions are ordered)", () => {
  const dir = "packages/env-spec";
  const doc = JSON.parse(manifestText(dir));
  const reordered = { version: doc.version, name: doc.name, ...doc };
  reordered.license = "AGPL-3.0-only";
  const r = changeFrom({}, { [`${dir}/package.json`]: `${JSON.stringify(reordered, null, 2)}\n` });
  assert.deepEqual(r.packages, expectedAffected(dir, [`${dir}/package.json`]));
});

test("package.json: the parsed JSON is compared, so a whitespace-only rewrite is exempt", () => {
  const dir = "packages/env-spec";
  const r = changeFrom({}, { [`${dir}/package.json`]: `${JSON.stringify(JSON.parse(manifestText(dir)))}\n` });
  assert.deepEqual(r.packages, [dir]);
});

test("documentation: LICENSE*, NOTICE*, THIRD-PARTY-NOTICES* and CONTRIBUTING* are ignored like Markdown", () => {
  for (const file of ["LICENSE", "LICENSE.txt", "NOTICE", "THIRD-PARTY-NOTICES", "CONTRIBUTING.md", "CONTRIBUTING", "archive/old-2026-10-05/LICENSE"]) {
    const r = change({ [file]: "x\n" });
    assertShape(r);
    assert.equal(r.mode, "affected", file);
    assert.deepEqual(r.packages, [], file);
    assert.equal(r.e2e, false, file);
  }
  // inside a package they still select the package, exactly as a Markdown file there does
  assert.deepEqual(change({ "packages/env-spec/LICENSE": "x\n" }).packages, expectedAffected("packages/env-spec", ["packages/env-spec/LICENSE"]));
  // a trigger still beats documentation
  assert.equal(change({ "packages/core/LICENSE": "x\n" }).trigger, "packages/core/**");
});

test("scripts: adding or editing a standalone scripts/ci/*.test.mjs is not a trigger and selects no package", () => {
  for (const file of ["scripts/ci/licence.test.mjs", "scripts/ci/affected.test.mjs", "scripts/ci/ci-workflow.test.mjs", "scripts/ci/same-tree.test.mjs", "scripts/ci/rollup-position.test.mjs"]) {
    const r = change({ [file]: "// x\n" });
    assertShape(r);
    assert.equal(r.mode, "affected", file);
    assert.deepEqual(r.packages, [], file);
    assert.equal(r.e2e, false, file);
    assert.equal(scopeLine(r), "CI scope: affected — 0 packages (ignored paths only)");
  }
  assert.match(change({ "scripts/ci/licence.test.mjs": "x" }).reason, /standalone/);
  // together with a real package change, only that package (and dependents) is selected
  const both = change({ "scripts/ci/licence.test.mjs": "x", "packages/env-spec/src/a.ts": "x" });
  assert.deepEqual(both.packages, expectedAffected("packages/env-spec", ["packages/env-spec/src/a.ts"]));
});

test("scripts: everything else under scripts/ stays a full-run trigger", () => {
  for (const file of [
    "scripts/ci/affected.mjs",
    "scripts/ci/full-run-triggers.json",
    "scripts/ci/vitest-projects.mjs",
    "scripts/ci/check-migration-compat.mjs",
    "scripts/check.sh",
    "scripts/check-globalsetup-env.sh",
    "scripts/lib/repo-resolve.sh",
    "scripts/ci/nested/x.test.mjs", // only a file directly in scripts/ci is standalone
    "scripts/ci/x.test.mjs.bak",
    "scripts/other/x.test.mjs",
    "scripts/ci/run-guards.sh",
  ]) {
    const r = change({ [file]: "x\n" });
    assert.equal(r.mode, "full", file);
    assert.equal(r.trigger, "scripts/**", file);
  }
  // a standalone test next to a trigger file changes nothing about the trigger
  assert.equal(change({ "scripts/ci/licence.test.mjs": "x", "scripts/check.sh": "x" }).mode, "full");
});

test("scripts: the standalone list is exactly the reviewed set, and nothing CI executes is in it", () => {
  assert.deepEqual(rules.standalone.map((s) => s.glob), ["scripts/ci/*.test.mjs"]);
  for (const s of rules.standalone) assert.ok(s.reason.length > 0);
  const re = rules.standalone.map((s) => globToRegExp(s.glob));
  for (const file of ["scripts/check.sh", "scripts/check-globalsetup-env.sh", "scripts/ci/affected.mjs", "scripts/ci/full-run-triggers.json", "scripts/ci/vitest-projects.mjs", "scripts/lib/x.sh"]) {
    assert.ok(!re.some((r) => r.test(file)), file);
  }
});

// ---- ci.yml by content ------------------------------------------------------
const CI = ".github/workflows/ci.yml";

test("ci.yml: a change confined to the node-test step's run line is neither a trigger nor an e2e one", () => {
  const next = REAL_CI.replace(NODE_TEST_LINE, "$1 scripts/ci/licence.test.mjs");
  assert.notEqual(next, REAL_CI);
  const r = changeFrom({ [CI]: REAL_CI }, { [CI]: next });
  assertShape(r);
  assert.equal(r.mode, "affected");
  assert.deepEqual(r.packages, []);
  assert.equal(r.e2e, false);
  assert.match(r.reason, /exempt CI edits/);
  // removing a test file from the list is not additions-only: it is a trigger
  const fewer = REAL_CI.replace(NODE_TEST_LINE, "        run: nix develop .#ci --command node --test scripts/ci/affected.test.mjs");
  const dropped = changeFrom({ [CI]: REAL_CI }, { [CI]: fewer });
  assert.equal(dropped.mode, "full");
  assert.equal(dropped.trigger, ".github/workflows/**");
  // swapping one file for another drops the first
  assert.equal(changeFrom({ [CI]: REAL_CI }, { [CI]: REAL_CI.replace("scripts/ci/affected.test.mjs", "scripts/ci/other.test.mjs") }).mode, "full");
  // reordering with nothing dropped is still exempt
  const reordered = REAL_CI.replace("scripts/ci/check-migration-compat.test.mjs scripts/ci/affected.test.mjs", "scripts/ci/affected.test.mjs scripts/ci/check-migration-compat.test.mjs");
  assert.equal(changeFrom({ [CI]: REAL_CI }, { [CI]: reordered }).mode, "affected");
});

test("ci.yml fail-safe: the exemption ends the moment the edit leaves the run line", () => {
  const base = { [CI]: REAL_CI };
  const run = (text) => changeFrom(base, { [CI]: text });
  // a line appended inside the step after the run line: the block is longer, so it is not just the run line
  const appended = run(REAL_CI.replace(NODE_TEST_LINE, "$1\n        continue-on-error: true"));
  assert.equal(appended.mode, "full");
  assert.equal(appended.trigger, ".github/workflows/**");
  const other = run(REAL_CI.replace(NODE_TEST_LINE, "        run: nix develop --command node scripts/ci/evil.mjs"));
  assert.equal(other.mode, "full");
  assert.equal(other.trigger, ".github/workflows/**");
  assert.equal(run(REAL_CI.replace(NODE_TEST_LINE, "$1; true")).mode, "full");
  assert.equal(run(REAL_CI.replace(NODE_TEST_LINE, "        if: false\n$1")).mode, "full");
  const both = REAL_CI.replace(NODE_TEST_LINE, "$1 scripts/ci/licence.test.mjs").replace("&& 175 || 90 }}", "&& 175 || 91 }}");
  assert.equal(run(both).mode, "full");
  assert.equal(run(REAL_CI.replace("name: Migration lint and secret scan tests", "name: Lint tests").replace(NODE_TEST_LINE, "$1 scripts/ci/licence.test.mjs")).mode, "full");
  assert.equal(changeFrom({}, { [CI]: REAL_CI }).mode, "full");
  assert.equal(changeFrom({ [CI]: REAL_CI }, { [CI]: null }).mode, "full");
});

test("ci.yml: an edit inside the check job is a full run without e2e; an edit that reaches the e2e job or lies outside the check job runs e2e", () => {
  const base = { [CI]: REAL_CI };
  const inCheck = changeFrom(base, { [CI]: REAL_CI.replace("&& 175 || 90 }}", "&& 175 || 91 }}") });
  assert.equal(inCheck.mode, "full");
  assert.equal(inCheck.trigger, ".github/workflows/**");
  assert.equal(inCheck.e2e, false);
  const inE2e = changeFrom(base, { [CI]: REAL_CI.replace("&& 125 || 60 }}", "&& 125 || 61 }}") });
  assert.equal(inE2e.mode, "full");
  assert.equal(inE2e.e2e, true);
  const env = changeFrom(base, { [CI]: REAL_CI.replace('FX_FORBID_MODEL_CALLS: "1"', 'FX_FORBID_MODEL_CALLS: "1"\n  OTHER: "x"') });
  assert.equal(env.e2e, true);
  const trigger = changeFrom(base, { [CI]: REAL_CI.replace("types: [opened, synchronize, reopened]", "types: [opened, synchronize]") });
  assert.equal(trigger.e2e, true);
  const matrix = changeFrom(base, { [CI]: REAL_CI.replace("project: [desktop, phone, tablet]", "project: [desktop, phone]") });
  assert.equal(matrix.e2e, true);
});

test("workflows: a workflow file other than ci.yml is a full-run trigger and never an e2e one", () => {
  const r = change({ ".github/workflows/other.yml": "x\n" });
  assert.equal(r.mode, "full");
  assert.equal(r.trigger, ".github/workflows/**");
  assert.equal(r.e2e, false);
});

// ---- e2e gated apart from the full unit scope -------------------------------
test("e2e: scripts/, docs/ops/staging.md and the lint and test config force the full unit scope but not the specs", () => {
  for (const file of ["scripts/check.sh", "scripts/lib/x.sh", "scripts/ci/affected.mjs", "docs/ops/staging.md", "eslint.config.js", "vitest.workspace.ts"]) {
    const r = change({ [file]: "x\n" });
    assert.equal(r.mode, "full", file);
    assert.equal(r.e2e, false, file);
  }
  // the schema and the toolchain stay e2e paths
  assert.equal(change({ "packages/db/migrations/9999_x.sql": "x\n" }).e2e, true);
  assert.equal(change({ "flake.lock": "x\n" }).e2e, true);
});

test("e2e: a trigger alongside an e2e path still runs the specs, and every fail-closed answer still says true", () => {
  assert.equal(change({ "scripts/check.sh": "x", "apps/workspace/shell/a.js": "x" }).e2e, true);
  assert.equal(change({ "scripts/check.sh": "x", "apps/web/app/a.ts": "x" }).e2e, true);
  assert.equal(change({ "scripts/check.sh": "x", "packages/api/src/routes/a.ts": "x" }).e2e, true);
  assert.equal(change({ "scripts/check.sh": "x", "pnpm-lock.yaml": "x" }).e2e, true);
  assert.equal(change({ "scripts/check.sh": "x" }, { forceFull: "true" }).e2e, true);
  assert.equal(change({ "scripts/check.sh": "x" }, { labels: ["ci:full"] }).e2e, true);
  assert.equal(change({ "scripts/check.sh": "x" }, { labelsError: "boom" }).e2e, true);
  assert.equal(change({ "brand-new-dir/x": "x" }).e2e, true);
  assert.equal(classify({ repoRoot: fx.dir, base: "0".repeat(40), head: fx.base }).e2e, true);
});

test("e2e: the skip line for a full run names the trigger, never undefined", () => {
  const r = change({ "scripts/check.sh": "x" });
  assert.equal(e2eSkipLine(r), "skipped: not affected (full unit scope: scripts/**; no e2e-relevant path changed)");
});

test("--github: a full run with no e2e path exports CI_SCOPE_E2E=false and keeps every other part on", () => {
  const s = runStep({ "scripts/check.sh": "x" }, ["--e2e-step"]);
  assert.equal(s.env.CI_SCOPE_MODE, "full");
  assert.ok(!("FX_CHECK_AFFECTED" in s.env));
  assert.equal(s.env.CI_SCOPE_RUNNER_PROTOCOL, "true");
  assert.equal(s.env.CI_SCOPE_E2E, "false");
  assert.match(s.stderr, /^skipped: not affected \(full unit scope: scripts\/\*\*/m);
});

// ---- replays of real pull requests ------------------------------------------
test("replay #538 (licence files, the license field of every package.json, one ci.yml line, one new test): no full run, no e2e, every package selected on its own", () => {
  const baseFiles = { [CI]: REAL_CI, "package.json": REAL_ROOT_PKG };
  const files = { [CI]: REAL_CI.replace(NODE_TEST_LINE, "$1 scripts/ci/licence.test.mjs"), "package.json": withKey("license", "AGPL-3.0-only-ex507c")(REAL_ROOT_PKG) };
  for (const dir of WORKSPACE.keys()) files[`${dir}/package.json`] = withKey("license", "AGPL-3.0-only-ex507c")(manifestText(dir));
  Object.assign(files, {
    LICENSE: "x\n",
    NOTICE: "x\n",
    "THIRD-PARTY-NOTICES": "x\n",
    "CONTRIBUTING.md": "x\n",
    "README.md": "x\n",
    "archive/runner-protocol-agpl-2026-10-05/LICENSE": "x\n",
    "packages/runner-protocol/LICENSE": "x\n",
    "packages/runner-protocol/README.md": "x\n",
    "packages/runner-protocol/src/index.ts": "export {};\n",
    "packages/runner-protocol/test/publicBoundary.test.ts": "export {};\n",
    "scripts/ci/licence.test.mjs": "// x\n",
  });
  const r = changeFrom(baseFiles, files);
  assertShape(r);
  assert.equal(r.mode, "affected", r.reason);
  assert.equal(r.trigger, null);
  assert.equal(r.e2e, false);
  // every package.json carries a license edit, so each package selects itself (a test may assert the field);
  // none is a trigger and none pulls in e2e
  assert.deepEqual(r.packages, [...WORKSPACE.keys()].sort());
  assert.ok(r.packages.includes("packages/runner-protocol"));
});

test("replay #537 (apps/workspace/perf scripts, one workspace test, two archived PEM files): what it selects, and why e2e", () => {
  const withoutArchive = change({
    "apps/workspace/perf/brotli-proxy.mjs": "x",
    "apps/workspace/perf/dev-tls.mjs": "x",
    "apps/workspace/perf/lighthouse.mjs": "x",
    "apps/workspace/test/brotli-proxy-tls.test.mjs": "x",
  });
  assert.equal(withoutArchive.mode, "affected");
  assert.deepEqual(withoutArchive.packages, expectedAffected("apps/workspace", ["apps/workspace/perf/dev-tls.mjs"]));
  // apps/workspace/** is an e2e path: the perf scripts live in the app the specs drive, and the glob does
  // not try to tell perf tooling from shell code
  assert.equal(withoutArchive.e2e, true);
  // the archived key material is under archive/**, which is on the ignore list: it no longer goes full
  const withArchive = change({
    "apps/workspace/perf/dev-tls.mjs": "x",
    "apps/workspace/test/brotli-proxy-tls.test.mjs": "x",
    "archive/dev-tls-pem-2026-10-05/dev-tls-cert.pem": "x",
    "archive/dev-tls-pem-2026-10-05/dev-tls-key.pem": "x",
  });
  assert.equal(withArchive.mode, "affected");
  assert.deepEqual(withArchive.packages, expectedAffected("apps/workspace", ["apps/workspace/perf/dev-tls.mjs"]));
  assert.equal(withArchive.e2e, true);
  const archiveOnly = change({ "archive/x-2026-10-05/a.pem": "x", "archive/y/z.ts": "x" });
  assert.equal(archiveOnly.mode, "affected");
  assert.deepEqual(archiveOnly.packages, []);
  assert.equal(archiveOnly.e2e, false);
});

test("lint: a standalone CI test asks for scripts/ci to be linted in an affected run; nothing else does", () => {
  assert.deepEqual(change({ "scripts/ci/licence.test.mjs": "x" }).lint, ["scripts/ci"]);
  assert.deepEqual(change({ "scripts/ci/licence.test.mjs": "x", "packages/env-spec/src/a.ts": "x" }).lint, ["scripts/ci"]);
  assert.deepEqual(change({ "packages/env-spec/src/a.ts": "x" }).lint, []);
  assert.deepEqual(change({ "docs/a.md": "x" }).lint, []);
  // a full run lints everything itself
  assert.deepEqual(change({ "scripts/ci/licence.test.mjs": "x", "scripts/check.sh": "x" }).lint, []);
});

test("ci.yml fail-safe: only the exact `nix develop .#ci` form is exempt; the old shell or a different one is a trigger", () => {
  const base = { [CI]: REAL_CI };
  for (const prefix of ["nix develop", "nix develop .#default", "nix develop .#ci2"]) {
    const next = REAL_CI.replace("run: nix develop .#ci --command node --test", `run: ${prefix} --command node --test`).replace(NODE_TEST_LINE, "$1 scripts/ci/new.test.mjs");
    assert.equal(changeFrom(base, { [CI]: next }).mode, "full", prefix);
  }
});

// ---- overlay-only pull requests (private repository) ----------------------------------------------------
// The overlay list is given only on the private repository (ci.yml passes it nowhere else). Its fixture is a
// SYNTHETIC list: the real one does not exist in the public repository, where this test also runs.
const LIST_PATH = "scripts/ci/publish-denylist.local";
// Stands in for a private workspace package (the real one is absent from the public tree): any package the
// other tests here do not use.
const PRIV_PKG = [...WORKSPACE.keys()].filter((d) => !["packages/env-spec", "packages/core", "packages/db", "apps/web", "apps/workspace"].includes(d)).at(-1);
const LIST_TEXT = [
  "# synthetic overlay list for the classifier tests",
  ".autonomous-team/\tteam-state",
  "archive/\tteam-state",
  "docs/ops/\tops-material",
  "scripts/ops/\tops-material",
  "scripts/lib/\tengine-tooling",
  "tests/\tengine-tooling",
  "config/private/\tprivate-config",
  `${PRIV_PKG}/\tprivate-package`,
  "CLAUDE.md\tteam-state",
  "scripts/ci/publish-denylist.local\tthe-list-itself",
  "packages/db/test/pgTls.test.ts\ttests-an-overlay-script",
  "",
].join("\n");
let ov; // { dir, base }
before(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "privscope-affected-"));
  git(dir, "init", "-q", "-b", "main");
  copyFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), path.join(dir, "pnpm-workspace.yaml"));
  for (const d of WORKSPACE.keys()) {
    mkdirSync(path.join(dir, d), { recursive: true });
    copyFileSync(path.join(repoRoot, d, "package.json"), path.join(dir, d, "package.json"));
  }
  writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: 1\n");
  mkdirSync(path.join(dir, "scripts/ci"), { recursive: true });
  writeFileSync(path.join(dir, LIST_PATH), LIST_TEXT);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  ov = { dir, base: git(dir, "rev-parse", "HEAD") };
});
after(() => rmSync(ov.dir, { recursive: true, force: true }));

/** Like change(), on the overlay fixture. */
function overlayChange(files, extra = {}) {
  git(ov.dir, "reset", "-q", "--hard", ov.base);
  for (const [p, content] of Object.entries(files)) {
    const abs = path.join(ov.dir, p);
    if (content === null) rmSync(abs, { force: true });
    else {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  }
  git(ov.dir, "add", "-A");
  git(ov.dir, "commit", "-q", "--allow-empty", "-m", "change");
  const head = git(ov.dir, "rev-parse", "HEAD");
  const result = classify({ repoRoot: ov.dir, base: ov.base, head, ...extra });
  git(ov.dir, "reset", "-q", "--hard", ov.base);
  return result;
}
const WITH_LIST = { overlayList: LIST_PATH };

test("overlay: an overlay-only change gives a no-product scope (no package, no e2e, no lint) and names the files", () => {
  const files = {
    "docs/ops/ci.md": "x",
    "scripts/lib/a.sh": "x",
    "tests/test_x.sh": "x",
    "config/private/plan-data.json": "{}",
    ".autonomous-team/PLAN.md": "x",
    "CLAUDE.md": "x",
  };
  const r = overlayChange(files, WITH_LIST);
  assert.equal(r.mode, "overlay");
  assert.deepEqual(r.packages, []);
  assert.equal(r.e2e, false);
  assert.deepEqual(r.lint, []);
  assert.equal(r.trigger, null);
  assert.deepEqual(r.overlay, Object.keys(files).sort());
  assert.match(scopeLine(r), /overlay-only — 6 overlay files; product suites skipped/);
  // the same change without the list (the public plane, and any caller that does not pass it) is what it always was
  const plain = overlayChange(files);
  assert.equal(plain.mode, "full", "scripts/lib/** matches scripts/**, a full-run trigger");
});

test("overlay: a mixed change (overlay plus any product path) keeps today's answer exactly", () => {
  const overlay = { "docs/ops/ci.md": "x", "tests/test_x.sh": "x" };
  for (const product of [
    { "packages/env-spec/src/a.ts": "x" },
    { "apps/web/app/page.tsx": "x" },
    { "pnpm-lock.yaml": "x" },
    { "scripts/ci/affected.mjs": "x" },
    { "scripts/check.sh": "x" },
    { "docs/guide.md": "x" }, // an ignored path is still not an overlay path
    { "README.md": "x" },
  ]) {
    const mixed = overlayChange({ ...overlay, ...product }, WITH_LIST);
    const without = overlayChange({ ...overlay, ...product });
    assert.notEqual(mixed.mode, "overlay", JSON.stringify(product));
    assert.deepEqual(mixed, without, `${JSON.stringify(product)} answers differently with the list`);
  }
});

test("overlay: without the list nothing can answer overlay, for every glob in the trigger file, the ignore list and the overlay paths", () => {
  const samples = [
    ...rules.triggers.map((t) => sampleFor(t.glob)),
    ...rules.ignore.map((t) => sampleFor(t.glob)),
    ...rules.e2e_paths.map((t) => sampleFor(t.glob)),
    "docs/ops/ci.md",
    "tests/test_x.sh",
    ".autonomous-team/x",
    "archive/x/y",
    "config/private/plan-data.json",
  ];
  for (const f of samples) {
    const a = overlayChange({ [f]: "x" });
    const b = overlayChange({ [f]: "x" }, { overlayList: "" });
    assert.notEqual(a.mode, "overlay", f);
    assert.deepEqual(a, b, f);
    assertShape(a);
  }
});

test("overlay: the public plane's answers are unchanged by the list for every product-only change", () => {
  const sets = [
    { "packages/env-spec/src/a.ts": "x" },
    { "packages/core/src/a.ts": "x" },
    { "apps/workspace/src/a.ts": "x" },
    { "scripts/ci/licence.test.mjs": "x" },
    { "pnpm-lock.yaml": "x" },
    { ".github/workflows/ci.yml": "x" },
    { "docs/a.md": "x" },
    { "wiki/a.md": "x" },
    {},
  ];
  for (const files of sets) {
    assert.deepEqual(overlayChange(files, WITH_LIST), overlayChange(files), JSON.stringify(files));
  }
});

test("overlay: a rename from an overlay path into a product path is not overlay-only (both sides are listed)", () => {
  git(ov.dir, "reset", "-q", "--hard", ov.base);
  mkdirSync(path.join(ov.dir, "tests"), { recursive: true });
  writeFileSync(path.join(ov.dir, "tests/test_y.sh"), "same\n");
  git(ov.dir, "add", "-A");
  git(ov.dir, "commit", "-q", "-m", "seed");
  const base = git(ov.dir, "rev-parse", "HEAD");
  mkdirSync(path.join(ov.dir, "apps/web"), { recursive: true });
  git(ov.dir, "mv", "tests/test_y.sh", "apps/web/test_y.sh");
  git(ov.dir, "commit", "-q", "-m", "move");
  const head = git(ov.dir, "rev-parse", "HEAD");
  const moved = classify({ repoRoot: ov.dir, base, head, ...WITH_LIST });
  git(ov.dir, "reset", "-q", "--hard", ov.base);
  assert.notEqual(moved.mode, "overlay");
  assert.ok(moved.mode === "full" || moved.packages.includes("apps/web"));
});

test("overlay: a pull request that edits the list itself is judged by the list at its BASE", () => {
  // It adds apps/web/ to the list and changes an apps/web file: judged by its own edit this would be overlay.
  const widened = overlayChange({ [LIST_PATH]: `${LIST_TEXT}apps/web/\tengine-tooling\n`, "apps/web/app/page.tsx": "x" }, WITH_LIST);
  assert.notEqual(widened.mode, "overlay");
  assert.equal(widened.mode, "full", "the list is under scripts/**, a full-run trigger, as before");
  // Editing only the list is an overlay-only change.
  assert.equal(overlayChange({ [LIST_PATH]: `${LIST_TEXT}docs/more/\tops-material\n` }, WITH_LIST).mode, "overlay");
});

test("overlay: a private package is not skippable", () => {
  const pkg = overlayChange({ [`${PRIV_PKG}/src/a.ts`]: "x", "docs/ops/ci.md": "x" }, WITH_LIST);
  assert.notEqual(pkg.mode, "overlay");
  assert.ok(pkg.packages.includes(PRIV_PKG));
});

test("overlay: an overlay script change, alone or with its overlay test, is overlay-only (never the product suite)", () => {
  const script = overlayChange({ "scripts/ops/staging-role-creds.mjs": "x", "docs/ops/ci.md": "x" }, WITH_LIST);
  assert.equal(script.mode, "overlay");
  assert.deepEqual(script.packages, []);
  assert.equal(script.e2e, false);
  // a vitest file marked tests-an-overlay-script changes alone, and together with the overlay script it tests
  for (const files of [
    { "packages/db/test/pgTls.test.ts": "x" },
    { "packages/db/test/pgTls.test.ts": "x", "scripts/ops/staging-role-creds.mjs": "x" },
  ]) {
    const r = overlayChange(files, WITH_LIST);
    assert.equal(r.mode, "overlay", JSON.stringify(files));
    assert.deepEqual(r.overlay, Object.keys(files).sort());
  }
});

test("overlay: a tests-an-overlay-script file mixed with a product path, and a product-only change, keep the ordinary answer", () => {
  for (const product of [{ "packages/env-spec/src/a.ts": "x" }, { "scripts/check.sh": "x" }]) {
    const mixed = overlayChange({ "packages/db/test/pgTls.test.ts": "x", ...product }, WITH_LIST);
    assert.notEqual(mixed.mode, "overlay", JSON.stringify(product));
    assert.deepEqual(mixed, overlayChange({ "packages/db/test/pgTls.test.ts": "x", ...product }), JSON.stringify(product));
    const only = overlayChange(product, WITH_LIST);
    assert.deepEqual(only, overlayChange(product), JSON.stringify(product));
  }
  assert.equal(overlayChange({ "scripts/check.sh": "x", "scripts/ops/a.mjs": "x" }, WITH_LIST).mode, "full");
});

test("overlay: ci:full, CI_FORCE_FULL and an unreadable label read still force a full run", () => {
  const files = { "tests/test_x.sh": "x" };
  assert.equal(overlayChange(files, { ...WITH_LIST, labels: ["ci:full"] }).mode, "full");
  assert.equal(overlayChange(files, { ...WITH_LIST, forceFull: "true" }).mode, "full");
  assert.equal(overlayChange(files, { ...WITH_LIST, labelsError: "GitHub API answered 500" }).mode, "full");
  assert.equal(overlayChange(files, { ...WITH_LIST, labels: ["bug"] }).mode, "overlay");
});

test("overlay: an empty change, a missing list, an empty list and a malformed list never narrow", () => {
  const empty = overlayChange({}, WITH_LIST);
  assert.notEqual(empty.mode, "overlay");
  assert.equal(empty.reason, "no changed files");
  const missing = overlayChange({ "tests/test_x.sh": "x" }, { overlayList: "scripts/ci/no-such-list" });
  assert.equal(missing.mode, "full");
  assert.match(missing.reason, /missing at the base commit/);
  for (const bad of ["", "# only a comment\n", "tests/ no-tab-here\n", "tests/\n", "/abs/\tx\n", "../up/\tx\n", "te*sts/\tx\n"]) {
    git(ov.dir, "reset", "-q", "--hard", ov.base);
    writeFileSync(path.join(ov.dir, "bad-list"), bad);
    git(ov.dir, "add", "-A");
    git(ov.dir, "commit", "-q", "-m", "bad list");
    const base = git(ov.dir, "rev-parse", "HEAD");
    mkdirSync(path.join(ov.dir, "tests"), { recursive: true });
    writeFileSync(path.join(ov.dir, "tests/test_z.sh"), "x");
    git(ov.dir, "add", "-A");
    git(ov.dir, "commit", "-q", "-m", "change");
    const head = git(ov.dir, "rev-parse", "HEAD");
    const r = classify({ repoRoot: ov.dir, base, head, overlayList: "bad-list" });
    git(ov.dir, "reset", "-q", "--hard", ov.base);
    assert.equal(r.mode, "full", JSON.stringify(bad));
    assert.match(r.reason, /overlay list/);
  }
});

test("overlay: the real overlay list, when this tree has one, parses and is never empty", { skip: !existsSync(path.join(repoRoot, LIST_PATH)) }, async () => {
  const { parseOverlayList } = await import("./affected.mjs");
  const entries = parseOverlayList(readFileSync(path.join(repoRoot, LIST_PATH), "utf8"));
  assert.ok(entries.length > 10);
  assert.ok(entries.every((e) => e.authority.length > 0));
});

// ---- the GitHub step with the overlay list ----
function overlayStep(files, env = {}, args = []) {
  git(ov.dir, "reset", "-q", "--hard", ov.base);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(ov.dir, p)), { recursive: true });
    writeFileSync(path.join(ov.dir, p), c);
  }
  git(ov.dir, "add", "-A");
  git(ov.dir, "commit", "-q", "-m", "c");
  const envFile = path.join(aux, "ov-env");
  writeFileSync(envFile, "");
  const clean = { ...process.env };
  for (const k of ["CI_OVERLAY_LIST", "GITHUB_API_URL", "GITHUB_REPOSITORY", "CI_PR_NUMBER", "GH_TOKEN"]) delete clean[k];
  const out = spawnSync(process.execPath, [CLI, "--repo", ov.dir, "--base", "HEAD^1", "--head", "HEAD", "--github", ...args], {
    encoding: "utf8",
    cwd: ov.dir,
    env: { ...clean, GITHUB_ENV: envFile, ...env },
  });
  const lines = readFileSync(envFile, "utf8").split("\n").filter(Boolean);
  const vars = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  rmSync(envFile, { force: true });
  git(ov.dir, "reset", "-q", "--hard", ov.base);
  return { out, vars, lines };
}

test("--github: an overlay answer exports CI_SCOPE_OVERLAY=true, turns every product part off and sets no package list", () => {
  const s = overlayStep({ "tests/test_x.sh": "x" }, { CI_OVERLAY_LIST: LIST_PATH });
  assert.equal(JSON.parse(s.out.stdout).mode, "overlay");
  assert.equal(s.vars.CI_SCOPE_OVERLAY, "true");
  assert.equal(s.vars.CI_SCOPE_MODE, "overlay");
  assert.equal(s.vars.CI_SCOPE_E2E, "false");
  assert.equal(s.vars.CI_SCOPE_RUNNER_PROTOCOL, "false");
  assert.equal("FX_CHECK_AFFECTED" in s.vars, false);
  assert.ok(s.out.stderr.includes("CI scope: overlay-only"));
  // --overlay-list on the command line does the same
  assert.equal(overlayStep({ "tests/test_x.sh": "x" }, {}, ["--overlay-list", LIST_PATH]).vars.CI_SCOPE_OVERLAY, "true");
});

test("--github: with no list (the public plane) the same change never exports CI_SCOPE_OVERLAY, and the other variables are the old ones", () => {
  for (const files of [{ "tests/test_x.sh": "x" }, { "packages/env-spec/src/a.ts": "x" }, { "pnpm-lock.yaml": "x" }]) {
    const s = overlayStep(files, { CI_OVERLAY_LIST: "" });
    assert.equal("CI_SCOPE_OVERLAY" in s.vars, false, JSON.stringify(files));
    assert.deepEqual(Object.keys(s.vars).sort(), ["CI_SCOPE_E2E", "CI_SCOPE_MODE", "CI_SCOPE_RUNNER_PROTOCOL", ...(s.vars.FX_CHECK_AFFECTED ? ["FX_CHECK_AFFECTED"] : [])].sort());
    assert.notEqual(s.vars.CI_SCOPE_MODE, "overlay");
  }
});

test("--github: a product change on the private plane (list given) exports no overlay flag", () => {
  const s = overlayStep({ "packages/env-spec/src/a.ts": "x", "tests/test_x.sh": "x" }, { CI_OVERLAY_LIST: LIST_PATH });
  assert.equal("CI_SCOPE_OVERLAY" in s.vars, false);
  // tests/ belongs to no package and is not ignored, so today's answer for the mixed set is full
  assert.equal(s.vars.CI_SCOPE_MODE, "full");
});

// ---- D#848 R3: merge queue groups ----------------------------------------
// The event's base_sha is the group's PARENT commit (for an entry queued behind another, that entry's head), so the
// group's scope is taken back to the merge base with the target branch, listed by the compare API. The API is stubbed
// here with the shapes captured from real queue runs: see scripts/ci/fixtures/merge-group/contract.json.
const MG_DIR = path.join(here, "fixtures", "merge-group");
const MG_CONTRACT = JSON.parse(readFileSync(path.join(MG_DIR, "contract.json"), "utf8"));
const MG_RUN = JSON.parse(readFileSync(path.join(MG_DIR, "run-44233460388.json"), "utf8"));
const MG_ENV = { GITHUB_REPOSITORY: "o/r", GH_TOKEN: "t", GITHUB_API_URL: "http://api.invalid" };
const queueRef = (sha, n = 7, branch = "main") => `refs/heads/gh-readonly-queue/${branch}/pr-${n}-${sha}`;

/** A repository with the workspace manifests and a chain of single-parent commits: [{ subject, files }]. */
function mgRepo(entries) {
  const dir = mkdtempSync(path.join(tmpdir(), "d848-mg-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "gc.auto", "0"); // no background gc left writing into the directory while it is removed
  copyFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), path.join(dir, "pnpm-workspace.yaml"));
  for (const d of WORKSPACE.keys()) {
    mkdirSync(path.join(dir, d), { recursive: true });
    copyFileSync(path.join(repoRoot, d, "package.json"), path.join(dir, d, "package.json"));
  }
  writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: 1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base (#1)");
  const shas = [git(dir, "rev-parse", "HEAD")];
  for (const e of entries) {
    for (const [p, c] of Object.entries(e.files)) {
      mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      writeFileSync(path.join(dir, p), c);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", e.subject);
    shas.push(git(dir, "rev-parse", "HEAD"));
  }
  return { dir, shas };
}
const mgDone = (repo) => rmSync(repo.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/**
 * The API as the workflow sees it. `compare` answers branch...head: the commits entries[0..to) (everything ahead of
 * the target branch, whose tip is shas[0], the merge base) and each pull request's labels.
 */
function mgApi({ shas }, entries, { labels = {}, compare = 200, labelStatus = {}, mergeBase = undefined } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (String(url).includes("/compare/")) {
      if (compare !== 200) return json({}, compare);
      const commits = entries.map((e, i) => ({
        sha: shas[i + 1],
        parents: [{ sha: shas[i] }],
        commit: { message: `${e.subject}\n\nCo-authored-by: a <a@example.invalid>` },
      }));
      const mb = mergeBase === undefined ? { sha: shas[0] } : mergeBase;
      return json({ total_commits: commits.length, commits, ...(mb ? { merge_base_commit: mb } : {}) });
    }
    const m = /\/issues\/(\d+)\/labels/.exec(String(url));
    if (m && labelStatus[m[1]]) return json({}, labelStatus[m[1]]);
    return json((labels[m?.[1]] ?? []).map((name) => ({ name })));
  };
  return { impl, calls };
}

const WEB = { subject: "web change (#101)", files: { "apps/web/src/a.ts": "export const a = 1;\n" } };
const DOC = { subject: "docs only (#102)", files: { "docs/ops/note.md": "note\n" } };
/**
 * Classify the group that ends at entries[to-1], as the event would describe it: base_sha = shas[eventBase] (the
 * entry ahead's head when eventBase = to - 1), head_sha = shas[to], GITHUB_REF = the queue branch.
 */
const mgRun = async (repo, entries, eventBase, to, opts = {}, deps = {}, envExtra = {}) => {
  const api = mgApi(repo, entries.slice(0, to), opts);
  const result = await classifyMergeGroup(
    { repoRoot: repo.dir, base: repo.shas[eventBase], head: repo.shas[to], env: { ...MG_ENV, GITHUB_REF: queueRef(repo.shas[eventBase]), ...envExtra } },
    { fetchImpl: api.impl, ...deps },
  );
  return { result, api };
};

test("merge group: a docs-only group answers affected with 0 packages and the summary line says docs", async () => {
  const repo = mgRepo([DOC]);
  const { result, api } = await mgRun(repo, [DOC], 0, 1);
  assert.equal(result.mode, "affected");
  assert.deepEqual(result.packages, []);
  assert.equal(result.e2e, false);
  assert.deepEqual(result.mergeGroup, { prs: [102] });
  assert.equal(scopeLine(result, { e2eStep: true }), "CI scope: docs — 0 packages (ignored paths only); merge group of #102");
  assert.ok(api.calls.some((u) => u.includes("/compare/main...")), "the compare is against the target branch named by GITHUB_REF");
  mgDone(repo);
});

test("merge group: a code change selects its packages and the line says affected", async () => {
  const repo = mgRepo([WEB]);
  const { result } = await mgRun(repo, [WEB], 0, 1);
  assert.equal(result.mode, "affected");
  assert.ok(result.packages.includes("apps/web"));
  assert.ok(scopeLine(result, { e2eStep: true }).startsWith("CI scope: affected — "));
  mgDone(repo);
});

test("merge group: the event's base_sha is the entry AHEAD, and the scope still covers the whole range back to the merge base", async () => {
  const repo = mgRepo([WEB, DOC]);
  // entry 2 (docs) queued behind entry 1 (web): the event says base_sha = entry 1's head, head_sha = entry 2's head
  const { result } = await mgRun(repo, [WEB, DOC], 1, 2);
  assert.ok(result.packages.includes("apps/web"), "entry 2 is tested with everything ahead of it");
  assert.deepEqual(result.mergeGroup.prs, [101, 102]);
  // what the event's own range would have said (base_sha..head_sha, one commit): docs. That is the defect this prevents.
  const eventRange = classify({ repoRoot: repo.dir, base: repo.shas[1], head: repo.shas[2], labels: [] });
  assert.deepEqual(eventRange.packages, []);
  assert.notDeepEqual(result.packages, eventRange.packages);
  mgDone(repo);
});

test("merge group: a GITHUB_REF that is not a merge queue branch is full", async () => {
  const repo = mgRepo([WEB, DOC]);
  const sha = repo.shas[1];
  for (const ref of [
    undefined,
    "",
    "refs/heads/main",
    "refs/pull/101/merge",
    `refs/heads/gh-readonly-queue/main/pr-7`,
    `refs/heads/gh-readonly-queue/main/pr-x-${sha}`,
    `refs/heads/gh-readonly-queue/main/pr-7-${sha}/extra`,
    `refs/tags/gh-readonly-queue/main/pr-7-${sha}`,
    `refs/heads/gh-readonly-queue//pr-7-${sha}`,
  ]) {
    const api = mgApi(repo, [WEB, DOC]);
    const result = await classifyMergeGroup(
      { repoRoot: repo.dir, base: sha, head: repo.shas[2], env: { ...MG_ENV, ...(ref === undefined ? {} : { GITHUB_REF: ref }) } },
      { fetchImpl: api.impl },
    );
    assert.equal(result.mode, "full", String(ref));
    assert.match(result.reason, /GITHUB_REF is not a merge queue branch/);
    assert.equal(api.calls.length, 0, "nothing is read from the API");
  }
  // a target branch with a slash in it is read whole
  const api = mgApi(repo, [WEB, DOC]);
  const ok = await classifyMergeGroup(
    { repoRoot: repo.dir, base: sha, head: repo.shas[2], env: { ...MG_ENV, GITHUB_REF: queueRef(sha, 7, "release/1.x") } },
    { fetchImpl: api.impl },
  );
  assert.equal(ok.mode, "affected");
  assert.ok(api.calls[0].includes("/compare/release/1.x..."));
  mgDone(repo);
});

test("merge group: an event base_sha that is neither in the range nor the merge base is full", async () => {
  const repo = mgRepo([WEB, DOC]);
  const { result } = await mgRun(repo, [WEB, DOC], 1, 2, {}, {}, { GITHUB_REF: queueRef("2".repeat(40)) });
  assert.equal(result.mode, "affected", "control: the same group with its real base is narrowed");
  const bad = await classifyMergeGroup(
    { repoRoot: repo.dir, base: "2".repeat(40), head: repo.shas[2], env: { ...MG_ENV, GITHUB_REF: queueRef("2".repeat(40)) } },
    { fetchImpl: mgApi(repo, [WEB, DOC]).impl },
  );
  assert.equal(bad.mode, "full");
  assert.match(bad.reason, /event's base SHA is not in the range/);
  mgDone(repo);
});

test("merge group: ci:full on ANY pull request of the group is full", async () => {
  const repo = mgRepo([WEB, DOC]);
  const { result } = await mgRun(repo, [WEB, DOC], 1, 2, { labels: { 101: ["ci:full"] } });
  assert.equal(result.mode, "full");
  assert.match(result.reason, /label ci:full on #101/);
  mgDone(repo);
});

test("merge group: a commit with no trailing (#N) is full", async () => {
  for (const subject of ["no number here", "number in the middle (#7) and text after", "(#abc)", "Merge branch 'x'"]) {
    const e = { subject, files: DOC.files };
    const repo = mgRepo([e]);
    const { result } = await mgRun(repo, [e], 0, 1);
    assert.equal(result.mode, "full", subject);
    assert.match(result.reason, /no \(#N\) pull request number/);
    mgDone(repo);
  }
});

test("merge group: a label read that fails is full, whichever pull request it was and however it failed", async () => {
  const repo = mgRepo([WEB, DOC]);
  for (const status of [403, 404, 500]) {
    const { result } = await mgRun(repo, [WEB, DOC], 1, 2, { labelStatus: { 101: status } });
    assert.equal(result.mode, "full");
    assert.match(result.reason, /could not read the labels of #101/);
  }
  assert.equal((await mgRun(repo, [WEB, DOC], 1, 2, { labelStatus: { 102: 500 } })).result.mode, "full");
  const boom = await classifyMergeGroup(
    { repoRoot: repo.dir, base: repo.shas[1], head: repo.shas[2], env: { ...MG_ENV, GITHUB_REF: queueRef(repo.shas[1]) } },
    { fetchImpl: async () => { throw new Error("socket hang up"); } },
  );
  assert.equal(boom.mode, "full");
  mgDone(repo);
});

test("merge group: a SHA that cannot be resolved is full (head missing, merge base missing and not fetchable)", async () => {
  const repo = mgRepo([DOC]);
  const missing = "0".repeat(40);
  const calls = [];
  const noFetch = (root, sha) => (calls.push(sha), "unreachable");
  const env = { ...MG_ENV, GITHUB_REF: queueRef(repo.shas[0]) };
  const head = await classifyMergeGroup({ repoRoot: repo.dir, base: repo.shas[0], head: missing, env }, { fetchImpl: mgApi(repo, [DOC]).impl, fetchBase: noFetch });
  assert.equal(head.mode, "full");
  assert.match(head.reason, /head SHA cannot be resolved/);
  // the compare names a merge base this checkout does not have, and it cannot be fetched
  const api = mgApi(repo, [DOC], { mergeBase: { sha: missing } });
  const base = await classifyMergeGroup({ repoRoot: repo.dir, base: missing, head: repo.shas[1], env: { ...env, GITHUB_REF: queueRef(missing) } }, { fetchImpl: api.impl, fetchBase: noFetch });
  assert.equal(base.mode, "full");
  assert.match(base.reason, /base SHA cannot be resolved/);
  assert.deepEqual(calls, [missing], "only the merge base is ever fetched");
  for (const bad of ["", "HEAD", "abc123", undefined]) {
    const r = await classifyMergeGroup({ repoRoot: repo.dir, base: bad, head: repo.shas[1], env }, { fetchImpl: mgApi(repo, [DOC]).impl });
    assert.equal(r.mode, "full", String(bad));
  }
  mgDone(repo);
});

test("merge group: a compare call that fails, is cut short, is empty, has no merge base or does not end at head is full", async () => {
  const repo = mgRepo([DOC]);
  const env = { ...MG_ENV, GITHUB_REF: queueRef(repo.shas[0]) };
  const run = (impl) => classifyMergeGroup({ repoRoot: repo.dir, base: repo.shas[0], head: repo.shas[1], env }, { fetchImpl: impl });
  for (const status of [401, 404, 500]) {
    const { result } = await mgRun(repo, [DOC], 0, 1, { compare: status });
    assert.equal(result.mode, "full", String(status));
    assert.match(result.reason, new RegExp(`compare answered ${status}`));
  }
  const mb = { merge_base_commit: { sha: repo.shas[0] } };
  const body = (b) => async () => new Response(JSON.stringify(b), { status: 200 });
  const c = (sha, n) => ({ sha, parents: [{ sha: "p" }], commit: { message: `x (#${n})` } });
  assert.match((await run(body({ ...mb, total_commits: 5, commits: [c(repo.shas[1], 1)] }))).reason, /compare listed \d+ of 5 commits/);
  assert.match((await run(body({ ...mb, total_commits: 0, commits: [] }))).reason, /listed no commits/);
  assert.match((await run(body({ ...mb, total_commits: 1, commits: [c("f".repeat(40), 1)] }))).reason, /does not end at the head/);
  assert.match((await run(body({ total_commits: 1, commits: [c(repo.shas[1], 1)] }))).reason, /no merge base/);
  assert.match((await run(body({ merge_base_commit: { sha: "nothex" }, total_commits: 1, commits: [c(repo.shas[1], 1)] }))).reason, /no merge base/);
  assert.match((await run(body({ nope: true }))).reason, /unexpected compare response/);
  assert.match((await run(async () => { throw new Error("socket hang up"); })).reason, /socket hang up/);
  // two parents (a merge commit) is not a queue commit
  const merge = { sha: repo.shas[1], parents: [{ sha: "a" }, { sha: "b" }], commit: { message: "x (#9)" } };
  assert.match((await run(body({ ...mb, total_commits: 1, commits: [merge] }))).reason, /exactly one parent/);
  mgDone(repo);
});

test("merge group: CI_FORCE_FULL, a missing token and a missing repository are full, and the force switch reads nothing", async () => {
  const repo = mgRepo([DOC]);
  const api = mgApi(repo, [DOC]);
  const env = { ...MG_ENV, GITHUB_REF: queueRef(repo.shas[0]) };
  const base = { repoRoot: repo.dir, base: repo.shas[0], head: repo.shas[1] };
  const forced = await classifyMergeGroup({ ...base, forceFull: "true", env }, { fetchImpl: api.impl });
  assert.equal(forced.reason, "CI_FORCE_FULL");
  assert.equal(api.calls.length, 0);
  for (const e of [{ ...env, GH_TOKEN: "" }, { ...env, GITHUB_REPOSITORY: "" }, { ...env, GITHUB_REPOSITORY: "a b" }]) {
    assert.equal((await classifyMergeGroup({ ...base, env: e }, { fetchImpl: api.impl })).mode, "full");
  }
  mgDone(repo);
});

test("merge group: a trigger path in the range is full exactly as on a pull request", async () => {
  const lock = { subject: "deps (#103)", files: { "pnpm-lock.yaml": "lockfileVersion: 2\n" } };
  const repo = mgRepo([lock, DOC]);
  // the trigger is in the entry AHEAD; the docs entry behind it is still full
  const { result } = await mgRun(repo, [lock, DOC], 1, 2);
  assert.equal(result.mode, "full");
  assert.match(result.reason, /pnpm-lock\.yaml matches a full-run trigger/);
  assert.equal("mergeGroup" in result, false);
  mgDone(repo);
});

test("merge group: a merge base that is not in the shallow checkout is fetched at depth 1 and the group is still classified", async () => {
  const src = mgRepo([WEB, DOC]);
  git(src.dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  const clone = path.join(mkdtempSync(path.join(tmpdir(), "d848-mg-shallow-")), "clone");
  execFileSync("git", ["clone", "-q", "--depth=1", `file://${src.dir}`, clone]);
  const has = (sha) => spawnSync("git", ["-C", clone, "cat-file", "-e", `${sha}^{commit}`]).status === 0;
  assert.equal(has(src.shas[0]), false, "the merge base is absent before");
  const fetched = [];
  const fetchBase = (root, sha) => (fetched.push(sha), fetchCommitDepth1(root, sha, MG_ENV, `file://${src.dir}`));
  const api = mgApi(src, [WEB, DOC]);
  const env = { ...MG_ENV, GITHUB_REF: queueRef(src.shas[1]) };
  const result = await classifyMergeGroup({ repoRoot: clone, base: src.shas[1], head: src.shas[2], env }, { fetchImpl: api.impl, fetchBase });
  assert.deepEqual(fetched, [src.shas[0]]);
  assert.equal(result.mode, "affected");
  assert.ok(result.packages.includes("apps/web"), "the entry ahead is in the diff");
  assert.equal(has(src.shas[0]), true, "the merge base is present after");
  // a fetch that fails is full
  const gone = await classifyMergeGroup(
    { repoRoot: clone, base: "1".repeat(40), head: src.shas[2], env: { ...env, GITHUB_REF: queueRef("1".repeat(40)) } },
    { fetchImpl: mgApi(src, [WEB, DOC], { mergeBase: { sha: "1".repeat(40) } }).impl, fetchBase },
  );
  assert.equal(gone.mode, "full");
  assert.match(gone.reason, /base SHA cannot be resolved/);
  mgDone(src);
  rmSync(path.dirname(clone), { recursive: true, force: true });
});

test("fetchCommitDepth1: refuses what it cannot do, and the token goes through git's environment, not its arguments", () => {
  assert.equal(fetchCommitDepth1("/nonexistent", "nothex", MG_ENV), "not a full SHA");
  assert.equal(fetchCommitDepth1("/nonexistent", "a".repeat(40), { GITHUB_REPOSITORY: "o/r" }), "token or repository missing");
  const text = fetchCommitDepth1.toString();
  assert.match(text, /GIT_CONFIG_VALUE_0/);
  assert.doesNotMatch(text, /"-c"/);
});

test("merge group contract: the captured run, the queue branch name and the single-parent commit shape", () => {
  const one = MG_CONTRACT.single_entry;
  assert.equal(MG_RUN.event, "merge_group");
  assert.equal(MG_RUN.id, 44233460388);
  assert.equal(MG_RUN.head_sha, one.head_sha);
  assert.equal(MG_RUN.head_branch, one.head_branch);
  const m = new RegExp(MG_CONTRACT.queue_branch_pattern).exec(MG_RUN.head_branch);
  assert.ok(m, "the queue branch name has the captured form");
  assert.equal(m[1], "1011");
  assert.equal(m[2], one.base_sha, "base_sha is the SHA the branch name ends with");
  assert.deepEqual(one.head_parents, [one.base_sha], "base_sha equals head^1");
  assert.equal(MG_RUN.head_commit.message.split("\n")[0], one.head_subject);
  assert.equal(prNumberOfSubject(one.head_subject), 1011);
  // the GITHUB_REF of that run names the target branch
  assert.equal(QUEUE_REF(`refs/heads/${MG_RUN.head_branch}`), "main");
  // The parent list is the captured one, checked against the captured data only: a shallow checkout (CI) does not
  // have this commit's history, so no live git history is read here.
});
const QUEUE_REF = (ref) => new RegExp(MG_CONTRACT.github_ref_pattern).exec(ref)?.[1];

test("merge group contract: two real groups queued behind each other; the second's event base is the first's head, and its range lists both", async () => {
  const two = MG_CONTRACT.two_entry_real;
  const first = JSON.parse(readFileSync(path.join(MG_DIR, two.first_run), "utf8"));
  const second = JSON.parse(readFileSync(path.join(MG_DIR, two.second_run), "utf8"));
  assert.equal(second.head_sha, two.second_head_sha);
  assert.equal(second.head_branch, two.second_head_branch);
  // the real defect: the second event's base_sha is the FIRST entry's head, not the target branch's tip
  assert.equal(new RegExp(MG_CONTRACT.queue_branch_pattern).exec(second.head_branch)[2], two.second_event_base_sha);
  assert.equal(first.head_sha, two.second_event_base_sha);
  assert.notEqual(two.second_event_base_sha, two.merge_base);
  assert.deepEqual(two.commits[0].parents, [two.merge_base]);
  assert.deepEqual(two.commits[1].parents, [two.second_event_base_sha]);
  assert.equal(first.head_commit.message.split("\n")[0], two.commits[0].subject);
  assert.equal(second.head_commit.message.split("\n")[0], two.commits[1].subject);
  // the compare the classifier makes, answered as GitHub answers it, lists both pull requests and the merge base
  const impl = async (url) => {
    assert.ok(String(url).includes("/compare/main..."));
    return new Response(
      JSON.stringify({
        merge_base_commit: { sha: two.merge_base },
        total_commits: 2,
        commits: two.commits.map((c) => ({ sha: c.sha, parents: c.parents.map((sha) => ({ sha })), commit: { message: `${c.subject}\n\nbody` } })),
      }),
      { status: 200 },
    );
  };
  const got = await fetchRangeCommits("main", two.second_head_sha, MG_ENV, impl);
  assert.equal(got.mergeBase, two.merge_base);
  assert.deepEqual(got.commits.map((c) => prNumberOfSubject(c.subject)), [1019, 1015]);
  assert.ok(got.commits.some((c) => c.sha === two.second_event_base_sha), "the event's base is in the list, so it is accepted");
  assert.ok(got.commits.every((c) => c.parents === 1));
});

test("fetchRangeCommits: a malformed target branch is refused before any request", async () => {
  let calls = 0;
  const impl = async () => (calls++, new Response("{}", { status: 200 }));
  for (const b of ["", "a..b", "a b", "a?x=1", "-x;y", undefined]) assert.match((await fetchRangeCommits(b, "a".repeat(40), MG_ENV, impl)).error, /target branch name is malformed/, String(b));
  assert.equal(calls, 0);
});

test("prNumberOfSubject: only a trailing (#N) counts", () => {
  assert.equal(prNumberOfSubject("Add a thing (#12)"), 12);
  assert.equal(prNumberOfSubject("Add a thing (#12)  "), 12);
  for (const s of ["Add (#12) a thing", "Add a thing", "Add a thing (#0)", "Add a thing (#12", "Add a thing #12", "Add a thing (#12345678901)"]) assert.equal(prNumberOfSubject(s), null, s);
});

test("scopeLine: on the check job a merge group's line says check runs its full suite; the e2e line does not; pull requests are unchanged", () => {
  const docs = { mode: "affected", packages: [], reason: "x", e2e: false, lint: [], trigger: null, mergeGroup: { prs: [4, 5] } };
  const web = { ...docs, packages: ["apps/web"] };
  const tail = "; check runs its full suite on queue runs (only workspace-e2e is narrowed)";
  assert.equal(scopeLine(docs), `CI scope: docs — 0 packages (ignored paths only); merge group of #4, #5${tail}`);
  assert.equal(scopeLine(web), `CI scope: affected — 1 packages: apps/web; merge group of #4, #5${tail}`);
  assert.equal(scopeLine(docs, { e2eStep: true }), "CI scope: docs — 0 packages (ignored paths only); merge group of #4, #5");
  assert.equal(scopeLine(web, { e2eStep: true }), "CI scope: affected — 1 packages: apps/web; merge group of #4, #5");
  assert.equal(scopeLine({ ...docs, mergeGroup: undefined }), "CI scope: affected — 0 packages (ignored paths only)");
  assert.equal(scopeLine({ ...web, mergeGroup: undefined }), "CI scope: affected — 1 packages: apps/web");
});

// ---- the command line, against a local API ----
async function mgCli(repo, entries, { opts = {}, e2eStep = true, ref } = {}) {
  const api = mgApi(repo, entries, opts);
  const server = createServer(async (req, res) => {
    const r = await api.impl(`http://x${req.url}`);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(await r.text());
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const envFile = path.join(aux, `mg-env-${Math.random().toString(36).slice(2)}`);
  const summary = `${envFile}.summary`;
  writeFileSync(envFile, "");
  writeFileSync(summary, "");
  const clean = { ...process.env };
  for (const k of ["CI_OVERLAY_LIST", "GITHUB_API_URL", "GITHUB_REPOSITORY", "CI_PR_NUMBER", "GH_TOKEN", "GITHUB_REF"]) delete clean[k];
  let out;
  try {
    out = await execFileAsync(
      process.execPath,
      [CLI, "--repo", repo.dir, "--base", repo.shas[0], "--head", repo.shas[entries.length], "--github", ...(e2eStep ? ["--e2e-step"] : []), "--event", "merge_group"],
      {
        encoding: "utf8",
        env: { ...clean, GITHUB_ENV: envFile, GITHUB_STEP_SUMMARY: summary, GITHUB_REPOSITORY: "o/r", GH_TOKEN: "t", GITHUB_REF: ref ?? queueRef(repo.shas[0]), GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` },
      },
    );
  } finally {
    server.close();
  }
  const vars = Object.fromEntries(readFileSync(envFile, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  return { json: JSON.parse(out.stdout), vars, summary: readFileSync(summary, "utf8"), stderr: out.stderr, requests: api.calls };
}

test("merge group CLI: a docs-only group exports CI_SCOPE_E2E=false and no package, and the summary says docs", async () => {
  const repo = mgRepo([DOC]);
  const r = await mgCli(repo, [DOC]);
  assert.equal(r.json.mode, "affected");
  assert.equal(r.vars.CI_SCOPE_MODE, "affected");
  assert.equal(r.vars.CI_SCOPE_E2E, "false", "every later spec step skips and the job still ends success");
  assert.equal(r.vars.FX_CHECK_AFFECTED, "none");
  assert.equal(r.vars.CI_SCOPE_RUNNER_PROTOCOL, "false");
  assert.equal(r.summary.trim(), "CI scope: docs — 0 packages (ignored paths only); merge group of #102");
  assert.match(r.stderr, /skipped: not affected/, "the e2e step prints its skip line");
  assert.ok(r.requests.some((u) => u.includes("/compare/main...")) && r.requests.some((u) => u.includes("/issues/102/labels")));
  assert.equal(r.requests.some((u) => u.includes("/issues//labels")), false, "no single-pull-request label read on a merge group");
  mgDone(repo);
});

test("merge group CLI: the check job's step (no --e2e-step) says check runs its full suite", async () => {
  const repo = mgRepo([DOC]);
  const r = await mgCli(repo, [DOC], { e2eStep: false });
  assert.equal(r.summary.trim(), "CI scope: docs — 0 packages (ignored paths only); merge group of #102; check runs its full suite on queue runs (only workspace-e2e is narrowed)");
  mgDone(repo);
});

test("merge group CLI: a GITHUB_REF that is not a queue branch exports full", async () => {
  const repo = mgRepo([DOC]);
  const r = await mgCli(repo, [DOC], { ref: "refs/heads/main" });
  assert.equal(r.json.mode, "full");
  assert.equal(r.vars.CI_SCOPE_E2E, "true");
  mgDone(repo);
});

test("merge group CLI: a change to the e2e job's own paths keeps CI_SCOPE_E2E true", async () => {
  const e2e = { subject: "shell spec (#104)", files: { "apps/workspace/e2e/a.spec.ts": "x\n" } };
  const repo = mgRepo([e2e]);
  const r = await mgCli(repo, [e2e]);
  assert.equal(r.vars.CI_SCOPE_E2E, "true");
  assert.ok(r.vars.FX_CHECK_AFFECTED.includes("apps/workspace"));
  mgDone(repo);
});

test("merge group CLI: any doubt exports full, so every step runs", async () => {
  const repo = mgRepo([DOC]);
  const r = await mgCli(repo, [DOC], { opts: { labels: { 102: ["ci:full"] } } });
  assert.equal(r.json.mode, "full");
  assert.equal(r.vars.CI_SCOPE_MODE, "full");
  assert.equal(r.vars.CI_SCOPE_E2E, "true");
  assert.equal("FX_CHECK_AFFECTED" in r.vars, false);
  mgDone(repo);
});

test("pull request runs are unchanged: --event pull_request and no --event give the same answer, and the line is the old one", () => {
  const repo = mgRepo([WEB]);
  const run = (extra) =>
    spawnSync(process.execPath, [CLI, "--repo", repo.dir, "--base", repo.shas[0], "--head", repo.shas[1], "--labels", "", ...extra], { encoding: "utf8" });
  const a = run([]);
  const b = run(["--event", "pull_request"]);
  assert.equal(a.stdout, b.stdout);
  assert.equal(JSON.parse(a.stdout).mode, "affected");
  assert.equal("mergeGroup" in JSON.parse(a.stdout), false);
  assert.equal(scopeLine({ mode: "affected", packages: [], reason: "x", e2e: false, lint: [], trigger: null }), "CI scope: affected — 0 packages (ignored paths only)");
  mgDone(repo);
});
