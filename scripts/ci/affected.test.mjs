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
import { classify, e2eSkipLine, fetchPrLabels, globToRegExp, loadTriggers, scopeLine } from "./affected.mjs";
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
const WITH_EXTRA = new Map([...DECLARED].map(([k, v]) => [k, new Set(v)]));
for (const e of rules.extra_edges) WITH_EXTRA.get(e.from).add(e.to);

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
  assert.deepEqual(r.packages, expected);
  // The extra edges add nothing for this package, so the declared walk is the whole answer.
  assert.deepEqual(expectedSet("packages/env-spec", WITH_EXTRA), expected);
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
    assert.deepEqual(r.packages, expectedSet(x, WITH_EXTRA), x);
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
  assert.deepEqual(r.packages, expectedSet("packages/sitekit-claims", DECLARED));
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
  assert.deepEqual(r.packages, expectedSet("packages/env-spec", WITH_EXTRA));
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
  assert.deepEqual(right.packages, expectedSet("packages/env-spec", WITH_EXTRA));
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
  assert.deepEqual(r.packages, expectedSet("packages/env-spec", WITH_EXTRA));
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
  const s = runStep({ "packages/env-spec/src/a.ts": "x" });
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
  assert.equal(runStep({ "packages/env-spec/src/a.ts": "x" }).env.CI_SCOPE_RUNNER_PROTOCOL, "false");
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
  const out = spawnSync(process.execPath, [path.join(here, "vitest-projects.mjs"), "packages/sitekit-claims", "apps/web", "apps/workspace", "packages/partners"], { encoding: "utf8", cwd: repoRoot });
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
  assert.ok(expectedSet(dir, WITH_EXTRA).length > 1);
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
  assert.deepEqual(dep.packages, expectedSet(dir, WITH_EXTRA));
  const rootScript = changeFrom({ "package.json": REAL_ROOT_PKG }, { "package.json": both((d) => (d.scripts = { ...d.scripts, extra: "true" }))(REAL_ROOT_PKG) });
  assert.equal(rootScript.mode, "full");
  assert.equal(rootScript.trigger, "package.json");
  const version = changeFrom({}, { [`${dir}/package.json`]: both((d) => (d.version = "9.9.9"))(manifestText(dir)) });
  assert.deepEqual(version.packages, expectedSet(dir, WITH_EXTRA));
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
  assert.deepEqual(r.packages, expectedSet(dir, WITH_EXTRA));
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
  assert.deepEqual(change({ "packages/env-spec/LICENSE": "x\n" }).packages, expectedSet("packages/env-spec", WITH_EXTRA));
  // a trigger still beats documentation
  assert.equal(change({ "packages/core/LICENSE": "x\n" }).trigger, "packages/core/**");
});

test("scripts: adding or editing a standalone scripts/ci/*.test.mjs is not a trigger and selects no package", () => {
  for (const file of ["scripts/ci/licence.test.mjs", "scripts/ci/affected.test.mjs", "scripts/ci/ci-workflow.test.mjs"]) {
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
  assert.deepEqual(both.packages, expectedSet("packages/env-spec", WITH_EXTRA));
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
  const both = REAL_CI.replace(NODE_TEST_LINE, "$1 scripts/ci/licence.test.mjs").replace("timeout-minutes: 60", "timeout-minutes: 61");
  assert.equal(run(both).mode, "full");
  assert.equal(run(REAL_CI.replace("name: Migration lint and secret scan tests", "name: Lint tests").replace(NODE_TEST_LINE, "$1 scripts/ci/licence.test.mjs")).mode, "full");
  assert.equal(changeFrom({}, { [CI]: REAL_CI }).mode, "full");
  assert.equal(changeFrom({ [CI]: REAL_CI }, { [CI]: null }).mode, "full");
});

test("ci.yml: an edit inside the check job is a full run without e2e; an edit that reaches the e2e job or lies outside the check job runs e2e", () => {
  const base = { [CI]: REAL_CI };
  const inCheck = changeFrom(base, { [CI]: REAL_CI.replace("timeout-minutes: 60", "timeout-minutes: 61") });
  assert.equal(inCheck.mode, "full");
  assert.equal(inCheck.trigger, ".github/workflows/**");
  assert.equal(inCheck.e2e, false);
  const inE2e = changeFrom(base, { [CI]: REAL_CI.replace("timeout-minutes: 40", "timeout-minutes: 41") });
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
  assert.deepEqual(withoutArchive.packages, expectedSet("apps/workspace", WITH_EXTRA));
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
  assert.deepEqual(withArchive.packages, expectedSet("apps/workspace", WITH_EXTRA));
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
