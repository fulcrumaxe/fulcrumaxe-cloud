// Run with: node --test scripts/ci/check-migration-compat.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BASELINE, MIGRATIONS_DIR, checkSql, run } from "./check-migration-compat.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const rules = (sql) => checkSql(sql).map((h) => h.rule);

// ---- the five rules ------------------------------------------------------
test("each removing or reshaping change is flagged", () => {
  assert.deepEqual(rules("ALTER TABLE t DROP COLUMN c;"), ["drop-column"]);
  assert.deepEqual(rules("ALTER TABLE t DROP c;"), ["drop-column"], "COLUMN keyword is optional");
  assert.deepEqual(rules("alter table t drop column if exists c, add column d int;"), ["drop-column"]);
  assert.deepEqual(rules("DROP TABLE t;"), ["drop-table"]);
  assert.deepEqual(rules("DROP TABLE IF EXISTS t;"), ["drop-table"]);
  assert.deepEqual(rules("ALTER TABLE t RENAME COLUMN a TO b;"), ["rename"]);
  assert.deepEqual(rules("ALTER TABLE t RENAME TO u;"), ["rename"]);
  assert.deepEqual(rules("ALTER TABLE t RENAME a TO b;"), ["rename"]);
  assert.deepEqual(rules("ALTER INDEX i RENAME TO j;"), ["rename"]);
  assert.deepEqual(rules("ALTER TABLE t ALTER COLUMN c TYPE bigint;"), ["alter-type"]);
  assert.deepEqual(rules("ALTER TABLE t ALTER c SET DATA TYPE text;"), ["alter-type"]);
});

test("NOT NULL without a default is flagged, with one it is not", () => {
  assert.deepEqual(rules("ALTER TABLE t ADD COLUMN c int NOT NULL;"), ["not-null"]);
  assert.deepEqual(rules("ALTER TABLE t ADD c text NOT NULL;"), ["not-null"]);
  assert.deepEqual(rules("ALTER TABLE t ALTER COLUMN c SET NOT NULL;"), ["not-null"]);
  assert.deepEqual(rules("ALTER TABLE t ADD COLUMN c int NOT NULL DEFAULT 0;"), []);
  assert.deepEqual(rules("ALTER TABLE t ADD COLUMN c int GENERATED ALWAYS AS (a + 1) STORED NOT NULL;"), []);
  assert.deepEqual(rules("ALTER TABLE t ADD COLUMN c int;"), []);
});

test("additive and safe statements pass", () => {
  assert.deepEqual(rules("CREATE TABLE t (id int NOT NULL, name text NOT NULL);"), []);
  assert.deepEqual(rules("ALTER TABLE t ADD CONSTRAINT ck CHECK (c IS NOT NULL);"), []);
  assert.deepEqual(rules("ALTER TABLE t DROP CONSTRAINT ck;"), []);
  assert.deepEqual(rules("ALTER TABLE t ALTER COLUMN c DROP NOT NULL;"), []);
  assert.deepEqual(rules("ALTER TABLE t ALTER COLUMN c SET DEFAULT 1;"), []);
  assert.deepEqual(rules("ALTER TYPE e ADD VALUE 'x';"), []);
  assert.deepEqual(rules("CREATE INDEX i ON t (c);"), []);
});

test("a table created in the same file may take NOT NULL columns", () => {
  const sql = "CREATE TABLE n (id int);\nALTER TABLE n ADD COLUMN c int NOT NULL;\nALTER TABLE n ALTER COLUMN id SET NOT NULL;";
  assert.deepEqual(rules(sql), []);
  assert.deepEqual(rules(`${sql}\nALTER TABLE other ADD COLUMN d int NOT NULL;`), ["not-null"]);
});

test("comments and string literals are not code", () => {
  assert.deepEqual(rules("-- DROP TABLE t;\nSELECT 1;"), []);
  assert.deepEqual(rules("/* ALTER TABLE t DROP COLUMN c; */ SELECT 1;"), []);
  assert.deepEqual(rules("COMMENT ON TABLE t IS 'we will drop table x and rename y';"), []);
  assert.deepEqual(rules("ALTER TABLE t DROP COLUMN c -- later\n;"), ["drop-column"]);
});

test("a statement inside a DO block is still seen", () => {
  assert.deepEqual(rules("DO $$ BEGIN ALTER TABLE t DROP COLUMN c; END $$;"), ["drop-column"]);
});

// ---- the contract-phase marker ------------------------------------------
test("a contract-phase marker naming a PR or D# lets the change through", () => {
  for (const ref of ["D#454", "#123", "PR #123", "PR 123"]) {
    assert.deepEqual(rules(`-- contract-phase: ${ref}\nALTER TABLE t DROP COLUMN c;`), [], ref);
  }
  assert.deepEqual(rules("ALTER TABLE t DROP COLUMN c;\n  --   Contract-Phase:   #9 expand was 0700"), []);
});

test("a marker that names nothing does not count", () => {
  for (const bad of ["-- contract-phase:", "-- contract-phase: soon", "-- contract-phase: D#", "-- contract-phase: PR", "-- contract-phase: x#12"]) {
    assert.deepEqual(rules(`${bad}\nALTER TABLE t DROP COLUMN c;`), ["drop-column"], bad);
  }
  assert.deepEqual(rules("SELECT 1; -- contract-phase: #4\nALTER TABLE t DROP COLUMN c;"), ["drop-column"], "must be its own comment line");
  assert.deepEqual(rules("/* contract-phase: #4 */\nALTER TABLE t DROP COLUMN c;"), ["drop-column"], "block comment is not a marker");
});

test("a marker counts only as a real line comment", () => {
  const drop = "ALTER TABLE t DROP COLUMN c;";
  const cases = {
    "multi-line block comment": `/*\n-- contract-phase: #1\n*/\n${drop}`,
    "multi-line string literal": `COMMENT ON TABLE t IS '\n-- contract-phase: #1\n';\n${drop}`,
    "multi-line E string": `COMMENT ON TABLE t IS E'\\'\n-- contract-phase: #1\n';\n${drop}`,
    "quoted identifier": `CREATE TABLE "a\n-- contract-phase: #1\n" (id int);\n${drop}`,
    "dollar-quoted body": `CREATE FUNCTION f() RETURNS text AS $$\n-- contract-phase: #1\nSELECT 1\n$$ LANGUAGE sql;\n${drop}`,
    "DO block body": `DO $x$ BEGIN\n-- contract-phase: #1\nPERFORM 1; END $x$;\n${drop}`,
  };
  for (const [name, sql] of Object.entries(cases)) assert.deepEqual(rules(sql), ["drop-column"], name);
  // ...and a real comment after such text still counts.
  assert.deepEqual(rules(`/* x */\n-- contract-phase: #1\n${drop}`), []);
  assert.deepEqual(rules(`COMMENT ON TABLE t IS 'x';\n  -- contract-phase: PR #2\n${drop}`), []);
});

test("the cheap extra rules", () => {
  assert.deepEqual(rules("DROP VIEW v;"), ["drop-view"]);
  assert.deepEqual(rules("DROP MATERIALIZED VIEW IF EXISTS v;"), ["drop-view"]);
  assert.deepEqual(rules("DROP SCHEMA s CASCADE;"), ["drop-schema"]);
  assert.deepEqual(rules("DROP TYPE e;"), ["drop-type"]);
  assert.deepEqual(rules("ALTER TABLE t SET SCHEMA other;"), ["set-schema"]);
  assert.deepEqual(rules("TRUNCATE t;"), ["truncate"]);
  assert.deepEqual(rules("DROP FUNCTION f(int);"), ["drop-function"]);
  assert.deepEqual(rules("DROP FUNCTION IF EXISTS f(int);\nCREATE FUNCTION f(a int, b int) RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;"), []);
  assert.deepEqual(rules("DROP FUNCTION f(int);\nCREATE OR REPLACE FUNCTION public.f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;"), []);
  assert.deepEqual(rules("DROP FUNCTION f(int);\nCREATE FUNCTION g() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;"), ["drop-function"]);
  assert.deepEqual(rules("DROP POLICY p ON t;\nDROP TRIGGER tr ON t;\nDROP INDEX i;"), []);
  assert.deepEqual(rules("-- we truncate nothing\nSELECT 'truncate';"), []);
});

test("parser edges: keyword order, quoted names, escaped quotes", () => {
  assert.deepEqual(rules("ALTER TABLE IF EXISTS ONLY t DROP COLUMN c;"), ["drop-column"]);
  assert.deepEqual(rules("ALTER TABLE ONLY IF EXISTS t DROP COLUMN c;"), ["drop-column"]);
  assert.deepEqual(rules('CREATE TABLE "n" (id int);\nALTER TABLE "old" ADD COLUMN c int NOT NULL;'), ["not-null"]);
  assert.deepEqual(rules('CREATE TABLE "n" (id int);\nALTER TABLE "n" ADD COLUMN c int NOT NULL;'), []);
  assert.deepEqual(rules('ALTER TABLE "drop" ADD COLUMN c int;'), []);
  assert.deepEqual(rules("COMMENT ON TABLE t IS E'it\\'s; DROP TABLE x';\nALTER TABLE t DROP COLUMN c;"), ["drop-column"]);
  assert.deepEqual(rules("SELECT E'a\\\\';\nDROP TABLE x;"), ["drop-table"]);
  assert.deepEqual(rules("SELECT 'it''s';\nDROP TABLE x;"), ["drop-table"]);
});

// ---- existing migrations and the baseline -------------------------------
test("every existing migration passes, with the baseline applied", () => {
  const r = run(["--all"], {}, repoRoot);
  assert.equal(r.code, 0, r.lines.join("\n"));
});

test("the baseline is exactly the existing files that trip a rule, and may only shrink", () => {
  const r = run(["--all", "--no-baseline"], {}, repoRoot);
  const tripping = new Set(r.lines.filter((l) => l.startsWith(MIGRATIONS_DIR)).map((l) => path.basename(l.split(":")[0])));
  assert.deepEqual([...tripping].sort(), [...BASELINE].sort());
});

// ---- default mode, against a throwaway repository -----------------------
function sh(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function fixtureRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "fx-migcompat-"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@example.invalid");
  sh(dir, "config", "user.name", "t");
  mkdirSync(path.join(dir, MIGRATIONS_DIR), { recursive: true });
  writeFileSync(path.join(dir, MIGRATIONS_DIR, "0001_a.sql"), "CREATE TABLE t (id int);\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "base");
  sh(dir, "checkout", "-q", "-b", "work");
  return dir;
}
function commit(dir, file, text) {
  writeFileSync(path.join(dir, MIGRATIONS_DIR, file), text);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "change");
}

test("default mode checks only what the branch touched", () => {
  const dir = fixtureRepo();
  try {
    const env = { MIGRATION_ORDER_BASE: "main" };
    assert.equal(run([], env, dir).code, 0, "nothing touched");
    commit(dir, "0002_b.sql", "ALTER TABLE t ADD COLUMN c int;\n");
    assert.equal(run([], env, dir).code, 0, "additive migration");
    commit(dir, "0003_c.sql", "ALTER TABLE t DROP COLUMN c;\n");
    const bad = run([], env, dir);
    assert.equal(bad.code, 1);
    assert.match(bad.lines.join("\n"), /0003_c\.sql: drop-column/);
    assert.doesNotMatch(bad.lines.join("\n"), /0002_b/);
    commit(dir, "0003_c.sql", "-- contract-phase: #77\nALTER TABLE t DROP COLUMN c;\n");
    assert.equal(run([], env, dir).code, 0, "marker added");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an edit to an existing migration is checked too", () => {
  const dir = fixtureRepo();
  try {
    commit(dir, "0001_a.sql", "CREATE TABLE t (id int);\nDROP TABLE t;\n");
    const r = run([], { MIGRATION_ORDER_BASE: "main" }, dir);
    assert.equal(r.code, 1);
    assert.match(r.lines.join("\n"), /0001_a\.sql: drop-table/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the baseline never excuses a change in diff mode", () => {
  assert.ok(BASELINE.includes("0639_stream_leases.sql"));
  const dir = fixtureRepo();
  try {
    writeFileSync(path.join(dir, MIGRATIONS_DIR, "0639_stream_leases.sql"), "ALTER TABLE t ALTER COLUMN c SET NOT NULL;\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "old file, already baselined");
    // a baselined file edited to also drop a table
    commit(dir, "0639_stream_leases.sql", "ALTER TABLE t ALTER COLUMN c SET NOT NULL;\nDROP TABLE t;\n");
    const r = run([], { MIGRATION_ORDER_BASE: "main" }, dir);
    assert.equal(r.code, 1);
    assert.match(r.lines.join("\n"), /0639_stream_leases\.sql: drop-table/);
    assert.equal(run(["--all"], {}, dir).code, 0, "--all still skips baselined files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unresolvable base refuses to pass", () => {
  const dir = fixtureRepo();
  try {
    assert.equal(run([], { MIGRATION_ORDER_BASE: "no-such-ref" }, dir).code, 2);
    assert.equal(run(["--bogus"], {}, dir).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the command line exits with the same codes", () => {
  const dir = fixtureRepo();
  try {
    commit(dir, "0002_b.sql", "DROP TABLE t;\n");
    const r = spawnSync("node", [path.join(here, "check-migration-compat.mjs")], {
      cwd: dir,
      env: { ...process.env, MIGRATION_ORDER_BASE: "main" },
      encoding: "utf8",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /0002_b\.sql: drop-table/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- CI wiring and the secret scan --------------------------------------
const ci = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");

/** The `run:` text of the named step, read straight from ci.yml. */
function stepRun(name) {
  const lines = ci.split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.notEqual(at, -1, `ci.yml has no step "${name}"`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run:/.test(l));
  const inline = lines[runAt].replace(/^\s+run:\s*/, "");
  if (inline && inline !== "|") return inline;
  const indent = lines[runAt + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length && (lines[i].trim() === "" || lines[i].match(/^\s*/)[0].length >= indent); i += 1) {
    body.push(lines[i].slice(indent));
  }
  return body.join("\n");
}

test("ci.yml runs the lint, its tests and the secret scan inside the required check job", () => {
  const checkJob = ci.slice(ci.indexOf("\n  check:"), ci.indexOf("\n  workspace-e2e:"));
  for (const name of ["Migration compatibility lint", "Migration lint and secret scan tests", "Secret scan of the change"]) {
    assert.ok(checkJob.includes(`- name: ${name}`), `${name} must be a step of the check job`);
  }
  assert.match(stepRun("Migration compatibility lint"), /check-migration-compat\.mjs/);
  assert.match(stepRun("Migration lint and secret scan tests"), /check-migration-compat\.test\.mjs/);
  assert.ok(ci.indexOf("- name: Migration compatibility lint") < ci.indexOf("- name: Run checks"), "fails fast, before check.sh");
});

/** All step blocks of the check job, in order: [{ name, text }]. */
function checkJobSteps() {
  const job = ci.slice(ci.indexOf("\n  check:"), ci.indexOf("\n  workspace-e2e:"));
  const parts = job.split(/\n(?=      - (?:name|uses):)/).slice(1);
  return parts.map((text) => ({ text, name: (/^ {6}- name: (.*)$/m.exec(text) ?? [, text.split("\n")[0]])[1] }));
}

test("the secret scan is the first step after checkout and the hosted-only setup, before any nix develop", () => {
  const steps = checkJobSteps();
  const at = steps.findIndex((s) => s.name === "Secret scan of the change");
  assert.notEqual(at, -1);
  assert.match(steps[0].text, /actions\/checkout/);
  for (const s of steps.slice(1, at)) assert.match(s.name, /\(hosted\)$/, `${s.name} runs before the scan`);
  const firstDevelop = steps.findIndex((s) => /nix develop/.test(s.text.replace(/^\s*#.*$/gm, "")));
  assert.ok(firstDevelop > at, "no step that enters the change's dev shell may precede the scan");
  const scanBody = steps[at].text.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(scanBody, /nix develop|node |pnpm |scripts\//, "the scan runs nothing from the change");
});

test("the new steps cannot be skipped or made non-fatal", () => {
  const steps = checkJobSteps();
  for (const name of ["Secret scan of the change", "Migration compatibility lint", "Migration lint and secret scan tests"]) {
    const s = steps.find((x) => x.name === name);
    assert.ok(s, name);
    const text = s.text.replace(/^\s*#.*$/gm, "");
    assert.doesNotMatch(text, /^\s+if:/m, `${name} has an if:`);
    assert.doesNotMatch(text, /continue-on-error/, `${name} has continue-on-error`);
  }
  assert.doesNotMatch(ci.slice(ci.indexOf("\n  check:"), ci.indexOf("\n  workspace-e2e:")), /^ {4}continue-on-error/m);
});

test("the new steps keep every job on the guarded runner expression", () => {
  assert.doesNotMatch(ci, /runs-on:\s*(ubuntu|macos|windows)/i, "no hard-coded hosted runner");
  const runsOn = ci.split("\n").filter((l) => /^\s*runs-on:/.test(l));
  assert.ok(runsOn.length >= 2);
  for (const l of runsOn) assert.match(l, /runs-on: \$\{\{ github\.event\.repository\.private && \(vars\.CI_RUNS_ON \|\| 'self-hosted'\) \|\| 'ubuntu-latest' \}\}$/);
});

test("the migration step reads the base the same way check-migration-order does", () => {
  const at = ci.indexOf("- name: Migration compatibility lint");
  assert.match(ci.slice(at, at + 300), /MIGRATION_ORDER_BASE: HEAD\^1/);
});

const scan = stepRun("Secret scan of the change");
const hasNix = spawnSync("nix", ["--version"], { encoding: "utf8" }).status === 0;

/**
 * Run the exact scan step from ci.yml over a two-commit repository. `files` is
 * what the second commit adds ({ name: string | Buffer }); `extraEnv` is added to
 * the environment. RUNNER_TEMP stands in for the runner's temp directory.
 */
function runScan(files, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "fx-scan-"));
  const runnerTemp = mkdtempSync(path.join(tmpdir(), "fx-scan-rt-"));
  try {
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.email", "t@example.invalid");
    sh(dir, "config", "user.name", "t");
    writeFileSync(path.join(dir, "a.txt"), "one\n");
    // The base commit carries this repository's flake files: the step takes its
    // nixpkgs pin from the base commit, so the pin used here is the real one.
    copyFileSync(path.join(repoRoot, "flake.nix"), path.join(dir, "flake.nix"));
    copyFileSync(path.join(repoRoot, "flake.lock"), path.join(dir, "flake.lock"));
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "base");
    // Reproduce the runner's checkout: the change lives on a branch, GitHub's merge
    // commit (--no-ff) is what gets checked out, and fetch-depth 2 makes it shallow.
    sh(dir, "checkout", "-q", "-b", "pr");
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "change");
    sh(dir, "checkout", "-q", "main");
    sh(dir, "merge", "-q", "--no-ff", "-m", "merge", "pr");
    const ws = path.join(runnerTemp, "ws");
    sh(runnerTemp, "clone", "-q", "--depth", "2", `file://${dir}`, ws);
    assert.equal(sh(ws, "rev-parse", "--is-shallow-repository").trim(), "true");
    const bare = bareRunnerPath(runnerTemp);
    return spawnSync(path.join(bare, "bash"), ["-e", "-c", scan], {
      cwd: ws,
      env: {
        ...process.env,
        PATH: bare,
        GITHUB_WORKSPACE: ws,
        RUNNER_TEMP: runnerTemp,
        ...extraEnv,
      },
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
}

/**
 * A PATH holding only what the step may assume the runner has: bash, git and nix
 * (symlinks to this machine's own). Anything else the step calls (awk, grep,
 * sed, mktemp, env, cat, wc, ...) is "command not found", as on the runner.
 */
function bareRunnerPath(parent) {
  const bin = path.join(parent, "bare-bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of ["bash", "git", "nix"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    assert.ok(found, `${tool} must exist on the machine running this test`);
    symlinkSync(found, path.join(bin, tool));
  }
  return bin;
}

// A made-up token in GitHub's personal-access-token shape. Built from parts so this file itself does not
// carry the pattern.
const FAKE_TOKEN = ["ghp", "_", "R8sT2vKq9LmN4xWcY7bZdE1fGhJ3pAuV5oXi"].join("");
const LEAK = `const t = "${FAKE_TOKEN}";\n`;
const needsNix = { skip: !hasNix && "nix not available" };
const caught = (r) => {
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /leaks found: 1/);
  assert.ok(!r.stdout.includes(FAKE_TOKEN) && !r.stderr.includes(FAKE_TOKEN), "the token is redacted in the output");
};

test("the secret scan step fails on an added token and passes on clean text", needsNix, () => {
  caught(runScan({ "a.txt": `one\n${LEAK}` }));
  assert.equal(runScan({ "a.txt": 'one\nconst t = "hello";\n' }).status, 0);
});

test("a token on a line marked allow is not a finding", needsNix, () => {
  assert.equal(runScan({ "a.txt": `one\nconst t = "${FAKE_TOKEN}"; // gitleaks:allow\n` }).status, 0);
});

test("a change cannot hide a token from the scan with .gitattributes", needsNix, () => {
  caught(runScan({ ".gitattributes": "*.txt binary\n", "b.txt": LEAK }));
  caught(runScan({ ".gitattributes": "b.txt -diff\n", "b.txt": LEAK }));
  caught(runScan({ ".gitattributes": "b.txt diff=nope\n", "b.txt": LEAK }));
});

test("a change cannot hide a token by making the file binary", needsNix, () => {
  caught(runScan({ "b.bin": Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(LEAK)]) }));
});

test("a change cannot configure gitleaks with its own files or environment", needsNix, () => {
  const allowAll = '[extend]\nuseDefault = false\n[allowlist]\nregexes = [".*"]\n';
  caught(runScan({ ".gitleaks.toml": allowAll, "b.txt": LEAK }));
  caught(runScan({ ".gitleaksignore": "*\n", "b.txt": LEAK }));
  const cfg = mkdtempSync(path.join(tmpdir(), "fx-scan-cfg-"));
  try {
    writeFileSync(path.join(cfg, "x.toml"), allowAll);
    caught(runScan({ "b.txt": LEAK }, { GITLEAKS_CONFIG: path.join(cfg, "x.toml"), GITLEAKS_CONFIG_TOML: allowAll }));
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("a token on a line that begins like a diff header is still scanned", needsNix, () => {
  // Added line "++ <token>" appears in the diff as "+++ <token>", which looks like a file header.
  caught(runScan({ "b.txt": `++ ${FAKE_TOKEN}\n` }));
  caught(runScan({ "b.txt": `+++ b/x\n${LEAK}` }));
});

test("a change cannot choose the tools of its own scan by editing flake.lock", needsNix, () => {
  // A lock that matches flake.nix (input `nixpkgs`) but names a revision that cannot be fetched:
  // if the step took its pin from the checkout, nix would fail to fetch it and the scan would not run.
  const lock = JSON.parse(readFileSync(path.join(repoRoot, "flake.lock"), "utf8"));
  lock.nodes.nixpkgs.locked.rev = "0000000000000000000000000000000000000000";
  lock.nodes.nixpkgs.locked.narHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  caught(runScan({ "flake.lock": `${JSON.stringify(lock, null, 2)}\n`, "b.txt": LEAK }));
  // and a change that points flake.nix's input at another owner
  const nix = readFileSync(path.join(repoRoot, "flake.nix"), "utf8").replace("github:NixOS/nixpkgs/nixos-unstable", "github:nobody/nixpkgs/nixos-unstable");
  caught(runScan({ "flake.nix": nix, "b.txt": LEAK }));
});

// ---- no tool outside nix and the runner's base set -----------------------
/** The scan step's text with the here-document that holds the inner script split out. */
function scanParts() {
  const m = /<<'SCAN' \|\| true\n([\s\S]*?)\nSCAN\n/.exec(scan);
  assert.ok(m, "the inner script must sit in a SCAN here-document");
  return { inner: m[1], outer: scan.replace(m[0], "<<'SCAN' || true\nSCAN\n") };
}

test("the step calls no program that is neither from nix nor in the assumed base set", () => {
  // Assumed on the self-hosted runner outside `nix develop`: bash, git and nix. Everything
  // else must come from the `nix shell` line, which supplies bash, git, coreutils, gitleaks.
  const { outer, inner } = scanParts();
  for (const tool of ["awk", "gawk", "sed", "grep", "egrep", "cut", "tr", "head", "tail", "xargs", "env", "mktemp", "mkdir", "cat", "wc", "rm", "python3", "node", "jq", "curl"]) {
    assert.doesNotMatch(outer, new RegExp(`(^|[\\s|;&(])${tool}\\s`, "m"), `outer script must not call ${tool}`);
  }
  assert.match(outer, /nix shell nixpkgs#bash nixpkgs#git nixpkgs#coreutils nixpkgs#gitleaks/);
  assert.match(outer, /--inputs-from "git\+file:\/\/\$\{GITHUB_WORKSPACE:\?\}\?rev=\$\{base\}&shallow=1"/, "pin comes from the base commit, and a shallow checkout is allowed");
  // the inner script may use only these (all in the nix shell line)
  const allowed = new Set(["unset", "mktemp", "trap", "git", "while", "case", "printf", "if", "wc", "echo", "cd", "gitleaks", "cat", "exit", "rm", "done", "fi", "then", "esac", "read", "do"]);
  const lines = inner.split("\n").map((l) => l.trim());
  const subs = lines.flatMap((l) => [...l.matchAll(/\$\(\s*(?:<|([a-z]+))/g)].map((m) => m[1]).filter(Boolean));
  const words = [...subs, ...lines.filter((l) => !/^[a-z_]+=/.test(l)).map((l) => l.split(/[\s=(]/)[0]).filter((w) => /^[a-z]+$/.test(w))];
  for (const w of words) assert.ok(allowed.has(w), `inner script calls ${w}`);
});

test("the step runs with only bash, git and nix on PATH", needsNix, () => {
  // runScan already does this for every scan test above; this states it on its own.
  const r = runScan({ "b.txt": "nothing secret\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /command not found/);
});

// ---- fail closed: a scan that read nothing --------------------------------
function innerRun(gitleaksBody, files) {
  const dir = mkdtempSync(path.join(tmpdir(), "fx-inner-"));
  try {
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.email", "t@example.invalid");
    sh(dir, "config", "user.name", "t");
    writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "base");
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "change");
    const fake = path.join(dir, ".fake-bin");
    mkdirSync(fake);
    writeFileSync(path.join(fake, "gitleaks"), `#!/usr/bin/env bash\n${gitleaksBody}\n`);
    chmodSync(path.join(fake, "gitleaks"), 0o755);
    return spawnSync("bash", ["-euo", "pipefail", "-c", scanParts().inner], {
      cwd: dir,
      env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, GITHUB_WORKSPACE: dir },
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a scan over 0 bytes while lines were added fails", () => {
  const empty = innerRun('cat > /dev/null; echo "scanned ~0 bytes (0 bytes)" >&2; echo "no leaks found" >&2', { "a.txt": "one\ntwo\nthree\n" });
  assert.equal(empty.status, 1, empty.stderr);
  assert.match(empty.stderr, /scanned 0 bytes of 1 added line/);
});

test("a scan that read the added lines and found nothing passes", () => {
  const ok = innerRun('n=$(wc -c); echo "scanned ~$n bytes ($n bytes)" >&2', { "a.txt": "one\ntwo\nthree\n" });
  assert.equal(ok.status, 0, ok.stderr);
});

test("a finding or a crash from gitleaks fails the step", () => {
  assert.equal(innerRun('cat > /dev/null; exit 1', { "a.txt": "one\ntwo\nthree\n" }).status, 1);
  assert.equal(innerRun('exit 127', { "a.txt": "one\ntwo\nthree\n" }).status, 127);
});

test("a change that only deletes lines has nothing to scan and passes", () => {
  const r = innerRun('cat > /dev/null; echo "scanned ~0 bytes (0 bytes)" >&2', { "a.txt": "one\n" });
  assert.equal(r.status, 0, r.stderr);
});

test("both shells of the step stop on the first error", () => {
  const { outer } = scanParts();
  assert.match(outer, /^set -euo pipefail$/m);
  assert.match(outer, /--command bash -euo pipefail -c "\$scan"/, "a failing git diff must not become an empty scan");
});
