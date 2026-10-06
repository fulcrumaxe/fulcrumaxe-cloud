// apps/workspace/test/import.test.mjs
//
// D#37 WS-A1: tests the secure importer against SYNTHETIC tars built with
// real `git archive`, in scratch repos under a per-test tmp dir. Never reads
// or references the private source checkout -- every fixture commit is our own throwaway
// repo, invented for this test.
//
// Security fix round: adds --tar-sha256 (W1) coverage, --verify (W1)
// coverage, the E5 refuse-on-regular-file-outside-anchor behavior (this
// replaces the old skip-silently test), the E2 pre-write secret/dotfile
// refusal, and W4's duplicate-path refusal and mid-write atomicity.
//
// Second fix round (security re-review, PR #49): V1 (--verify now walks
// the whole --root tree and refuses on any extra/non-regular/missing/
// mismatched file), W1b (--verify requires an independent --tar-sha256),
// W4b (isSafeRelPath rejects empty and "." path segments), and a W5
// regression test (a symlink under --out is never followed).

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const IMPORT_MJS = join(TEST_DIR, "..", "import", "import.mjs");
const REAL_ALLOWLIST = join(TEST_DIR, "..", "import", "allowlist.txt");
const REAL_BUILD_INFO = join(TEST_DIR, "..", "BUILD-INFO.json");
const ANCHOR = "crates/fulc-shell/assets/";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// D#37 Correction C6: snapshot the real, committed apps/workspace/BUILD-INFO.json
// before any test in this file runs, so the suite can assert at the end that
// it never wrote to it. Captured once at module load, which vitest evaluates
// before any describe/it body in this file runs.
const REAL_BUILD_INFO_SHA_BEFORE = existsSync(REAL_BUILD_INFO) ? sha256File(REAL_BUILD_INFO) : null;

const cleanupDirs = [];
afterEach(() => {
  while (cleanupDirs.length > 0) {
    rmSync(cleanupDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// D#37 Correction C6: a fixture allowlist shared by every CLI-harness case in
// this file, so no test ever reads or depends on the real, committed
// apps/workspace/import/allowlist.txt (which WS-A2 narrowed to the real jpos
// tree's actual filenames -- something this file's synthetic fixtures were
// never written against). Mirrors the broad, generic pattern set the WS-A1
// baseline allowlist used (before WS-A2's real-tree narrowing), which is
// exactly what every fixture tar in this file was designed to be matched
// against. This is a throwaway fixture file, created once for the whole
// suite and removed when it finishes -- never the real allowlist.
const FIXTURE_ALLOWLIST_DIR = mkdtempSync(join(tmpdir(), "ws-a1-fixture-allowlist-"));
const FIXTURE_ALLOWLIST_PATH = join(FIXTURE_ALLOWLIST_DIR, "allowlist.txt");
writeFileSync(
  FIXTURE_ALLOWLIST_PATH,
  [
    "index.html",
    "script.js",
    "style.css",
    "rain.js",
    "keybindings.js",
    "keybindings.css",
    "core/**",
    "sdk/**",
    "runtime/**",
    "fonts/**",
    "apps/themes/**",
    "apps/activation/**",
    "",
  ].join("\n"),
);
afterAll(() => {
  rmSync(FIXTURE_ALLOWLIST_DIR, { recursive: true, force: true });
});

// D#37 Correction C6: every CLI-harness invocation gets an explicit
// --allowlist (the fixture above) and an explicit --build-info under a fresh
// scratch dir, unless the caller already supplied one -- so no case in this
// file can ever read the real allowlist.txt or write the real
// apps/workspace/BUILD-INFO.json, regardless of which CLI mode it invokes.
function withFixtureDefaults(args) {
  const finalArgs = [...args];
  if (!finalArgs.includes("--allowlist")) {
    finalArgs.push("--allowlist", FIXTURE_ALLOWLIST_PATH);
  }
  if (!finalArgs.includes("--build-info")) {
    finalArgs.push("--build-info", join(scratchDir("ws-a1-auto-bi-"), "BUILD-INFO.json"));
  }
  return finalArgs;
}

/**
 * Builds a scratch git repo with the given files (map of repo-relative path
 * -> string content), commits them, and archives that commit with real
 * `git archive`. Returns { repoDir, sha, tarPath }.
 */
function buildFixtureTar(files, { archiveTree = false, anchorOnly = false } = {}) {
  const repoDir = scratchDir("ws-a1-fixture-repo-");
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test User"]);
  for (const [relPath, content] of Object.entries(files)) {
    const dest = join(repoDir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-q", "-m", "fixture"]);
  const sha = git(repoDir, ["rev-parse", "HEAD"]).trim();
  const tarPath = join(repoDir, "fixture.tar");
  const archiveArgs = ["archive", "--format=tar", "-o", tarPath];
  if (archiveTree) {
    const tree = git(repoDir, ["rev-parse", "HEAD^{tree}"]).trim();
    archiveArgs.push(tree);
  } else {
    archiveArgs.push(sha);
  }
  if (anchorOnly) archiveArgs.push(ANCHOR.replace(/\/$/, ""));
  git(repoDir, archiveArgs);
  return { repoDir, sha, tarPath };
}

// Auto-injects a --tar-sha256 flag computed from the file --tar points at
// (W1 made it required for the main import mode; W1b made it required for
// --verify too, independently of anything BUILD-INFO.json records).
// Callers that need to control the flag explicitly (missing / wrong value)
// pass it themselves in args, which this never overrides; --status calls
// are left untouched since that mode doesn't take --tar at all.
function runCli(args) {
  const finalArgs = withFixtureDefaults(args);
  const tarIdx = finalArgs.indexOf("--tar");
  if (
    tarIdx !== -1 &&
    !finalArgs.includes("--status") &&
    !finalArgs.includes("--tar-sha256")
  ) {
    const tarPath = finalArgs[tarIdx + 1];
    let sha;
    try {
      sha = sha256File(tarPath);
    } catch {
      sha = "0".repeat(64); // e.g. --tar points at a directory -- never reached by the comparison
    }
    finalArgs.push("--tar-sha256", sha);
  }
  try {
    const stdout = execFileSync(process.execPath, [IMPORT_MJS, ...finalArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

// Runs the CLI with no --tar-sha256 auto-injection, for tests that need to
// omit that flag entirely. Still gets the --allowlist/--build-info fixture
// defaults (D#37 C6) -- those are orthogonal to what each test is exercising.
function runCliRaw(args) {
  const finalArgs = withFixtureDefaults(args);
  try {
    const stdout = execFileSync(process.execPath, [IMPORT_MJS, ...finalArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

function walkRel(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else out.push(relative(dir, abs).split(sep).join("/"));
    }
  }
  return out.sort();
}

describe("import.mjs criterion 1: refuses bad inputs before touching anything", () => {
  it("refuses when --tar is a directory", () => {
    const dir = scratchDir("ws-a1-dir-as-tar-");
    const out = scratchDir("ws-a1-out-");
    const result = runCli(["--tar", dir, "--sha", "a".repeat(40), "--origin", "https://example.com/x", "--out", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/directory/i);
  });

  it("refuses when --tar is not a tar file", () => {
    const dir = scratchDir("ws-a1-not-tar-");
    const fakeTar = join(dir, "fake.tar");
    writeFileSync(fakeTar, "this is definitely not a tar file\n");
    const out = scratchDir("ws-a1-out-");
    const result = runCli(["--tar", fakeTar, "--sha", "a".repeat(40), "--origin", "https://example.com/x", "--out", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/tar/i);
  });

  it("refuses when --sha is too short", () => {
    const { tarPath } = buildFixtureTar({ [`${ANCHOR}index.html`]: "hi\n" });
    const out = scratchDir("ws-a1-out-");
    const result = runCli(["--tar", tarPath, "--sha", "deadbeef", "--origin", "https://example.com/x", "--out", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/40 hex/i);
  });

  it("refuses when --sha contains non-hex characters", () => {
    const { tarPath } = buildFixtureTar({ [`${ANCHOR}index.html`]: "hi\n" });
    const out = scratchDir("ws-a1-out-");
    const badSha = "g".repeat(40);
    const result = runCli(["--tar", tarPath, "--sha", badSha, "--origin", "https://example.com/x", "--out", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/40 hex/i);
  });

  it("refuses when the tar's pax global header commit id is missing (archived from a tree, not a commit)", () => {
    const { tarPath } = buildFixtureTar({ [`${ANCHOR}index.html`]: "hi\n" }, { archiveTree: true });
    const out = scratchDir("ws-a1-out-");
    const result = runCli(["--tar", tarPath, "--sha", "a".repeat(40), "--origin", "https://example.com/x", "--out", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/pax global header|commit id/i);
  });

  it("refuses when the tar's recorded commit id does not match --sha", () => {
    const { tarPath, sha } = buildFixtureTar({ [`${ANCHOR}index.html`]: "hi\n" });
    const out = scratchDir("ws-a1-out-");
    const wrongSha = (sha[0] === "a" ? "b" : "a") + sha.slice(1);
    const result = runCli(["--tar", tarPath, "--sha", wrongSha, "--origin", "https://example.com/x", "--out", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/does not match/i);
  });

  it("accepts a --sha that differs only in letter case from the tar's recorded commit id", () => {
    const { tarPath, sha } = buildFixtureTar({ [`${ANCHOR}index.html`]: "hi\n" });
    const out = scratchDir("ws-a1-out-");
    const buildInfoPath = join(scratchDir("ws-a1-bi-"), "BUILD-INFO.json");
    const result = runCli([
      "--tar", tarPath, "--sha", sha.toUpperCase(), "--origin", "https://example.com/x",
      "--out", out, "--build-info", buildInfoPath,
    ]);
    expect(result.code).toBe(0);
  });
});

describe("import.mjs W1: --tar-sha256 is required and pins the tar's own bytes", () => {
  it("refuses when --tar-sha256 is omitted", () => {
    const { tarPath, sha } = buildFixtureTar({ [`${ANCHOR}index.html`]: "hi\n" });
    const out = scratchDir("ws-a1-out-");
    const result = runCliRaw(["--tar", tarPath, "--sha", sha, "--origin", "https://example.com/x", "--out", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/missing required flag.*tar-sha256|tar-sha256/i);
  });

  it("refuses when --tar-sha256 is not 64 hex characters", () => {
    const { tarPath, sha } = buildFixtureTar({ [`${ANCHOR}index.html`]: "hi\n" });
    const out = scratchDir("ws-a1-out-");
    const result = runCliRaw([
      "--tar", tarPath, "--sha", sha, "--tar-sha256", "deadbeef",
      "--origin", "https://example.com/x", "--out", out,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/64 hex/i);
  });

  it("refuses when --tar-sha256 does not match the tar's actual bytes (a swapped tar)", () => {
    const { tarPath, sha } = buildFixtureTar({ [`${ANCHOR}index.html`]: "hi\n" });
    const out = scratchDir("ws-a1-out-");
    const wrongHash = "0".repeat(64);
    const result = runCliRaw([
      "--tar", tarPath, "--sha", sha, "--tar-sha256", wrongHash,
      "--origin", "https://example.com/x", "--out", out,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/does not match --tar-sha256/i);
  });

  it("is checked before any tar parsing -- a wrong --tar-sha256 refuses even a corrupt tar", () => {
    const dir = scratchDir("ws-a1-corrupt-");
    const corruptTar = join(dir, "corrupt.tar");
    writeFileSync(corruptTar, Buffer.alloc(1024)); // not ustar magic, and would fail readTar too
    const out = scratchDir("ws-a1-out-");
    const result = runCliRaw([
      "--tar", corruptTar, "--sha", "a".repeat(40), "--tar-sha256", "0".repeat(64),
      "--origin", "https://example.com/x", "--out", out,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/does not match --tar-sha256/i);
  });

  it("accepts the correct --tar-sha256", () => {
    const { tarPath, sha } = buildFixtureTar({ [`${ANCHOR}index.html`]: "hi\n" });
    const out = scratchDir("ws-a1-out-");
    const buildInfoPath = join(scratchDir("ws-a1-bi-"), "BUILD-INFO.json");
    const result = runCli(["--tar", tarPath, "--sha", sha, "--origin", "https://example.com/x", "--out", out, "--build-info", buildInfoPath]);
    expect(result.code).toBe(0);
    const info = JSON.parse(readFileSync(buildInfoPath, "utf8"));
    expect(info.tar_sha256).toBe(sha256File(tarPath));
  });
});

describe("import.mjs criterion 2: extracts only the allowlist, nothing else", () => {
  it("yields exactly the allowlisted file from a tar containing .env, a secret, and a non-allowlisted app file", () => {
    const { tarPath, sha } = buildFixtureTar({
      [`${ANCHOR}.env`]: "SECRET=1\n",
      [`${ANCHOR}secrets/x.pem`]: "-----BEGIN PRIVATE KEY-----\n",
      [`${ANCHOR}apps/terminal/t.js`]: "console.log('terminal');\n",
      [`${ANCHOR}index.html`]: "<html>fixture</html>\n",
    });
    const out = scratchDir("ws-a1-out-");
    const buildInfoPath = join(scratchDir("ws-a1-bi-"), "BUILD-INFO.json");
    const result = runCli(["--tar", tarPath, "--sha", sha, "--origin", "https://example.com/x", "--out", out, "--build-info", buildInfoPath]);
    expect(result.code).toBe(0);
    expect(walkRel(out)).toEqual(["index.html"]);
    expect(readFileSync(join(out, "index.html"), "utf8")).toBe("<html>fixture</html>\n");
  });

  it("extracts a directory pattern (core/**) recursively", () => {
    const { tarPath, sha } = buildFixtureTar({
      [`${ANCHOR}core/boot.js`]: "boot\n",
      [`${ANCHOR}core/themes/classic-crt.json`]: "{}\n",
      [`${ANCHOR}vendor/monaco/loader.js`]: "monaco\n",
    });
    const out = scratchDir("ws-a1-out-");
    const buildInfoPath = join(scratchDir("ws-a1-bi-"), "BUILD-INFO.json");
    const result = runCli(["--tar", tarPath, "--sha", sha, "--origin", "https://example.com/x", "--out", out, "--build-info", buildInfoPath]);
    expect(result.code).toBe(0);
    expect(walkRel(out)).toEqual(["core/boot.js", "core/themes/classic-crt.json"]);
  });
});

describe("import.mjs E5: refuses a tar that has a regular file outside the anchor", () => {
  it("refuses the whole tar, writing nothing, when a regular file sits outside the anchor even alongside a correctly-anchored one", () => {
    const { tarPath, sha } = buildFixtureTar({
      "index.html": "top-level, outside the anchor -- must refuse the whole tar\n",
      [`${ANCHOR}index.html`]: "inside the anchor\n",
    });
    const out = scratchDir("ws-a1-out-");
    const result = runCli(["--tar", tarPath, "--sha", sha, "--origin", "https://example.com/x", "--out", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/outside the anchor/i);
    expect(existsSync(out) ? walkRel(out) : []).toEqual([]);
  });

  it("a tar narrowed to the anchor at its source (git archive with the anchor pathspec) is accepted", () => {
    const { tarPath, sha } = buildFixtureTar(
      {
        "README.md": "outside the anchor, but excluded from the tar by the pathspec itself\n",
        [`${ANCHOR}index.html`]: "inside the anchor\n",
      },
      { anchorOnly: true },
    );
    const out = scratchDir("ws-a1-out-");
    const buildInfoPath = join(scratchDir("ws-a1-bi-"), "BUILD-INFO.json");
    const result = runCli(["--tar", tarPath, "--sha", sha, "--origin", "https://example.com/x", "--out", out, "--build-info", buildInfoPath]);
    expect(result.code).toBe(0);
    expect(walkRel(out)).toEqual(["index.html"]);
  });
});

describe("import.mjs E2: refuses the whole import on a secret/dotfile hit, before any write", () => {
  it("refuses when an allowlisted subtree contains a secret-shaped path, and writes nothing at all", () => {
    const { tarPath, sha } = buildFixtureTar({
      [`${ANCHOR}core/boot.js`]: "boot\n",
      [`${ANCHOR}core/secrets/token.js`]: "not read for this rule -- the path alone trips it\n",
    });
    const out = scratchDir("ws-a1-out-");
    const result = runCli(["--tar", tarPath, "--sha", sha, "--origin", "https://example.com/x", "--out", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/path-dotfile-or-secret/);
    expect(existsSync(out) ? walkRel(out) : []).toEqual([]);
  });

  it("refuses when an allowlisted subtree contains secret-shaped content in one file, and the clean sibling is also never written", () => {
    const { tarPath, sha } = buildFixtureTar({
      [`${ANCHOR}core/boot.js`]: "boot\n", // clean -- must not be written once the batch refuses
      [`${ANCHOR}core/config.js`]: "const t = 'ghp_abcdefghijklmnop';\n",
    });
    const out = scratchDir("ws-a1-out-");
    const result = runCli(["--tar", tarPath, "--sha", sha, "--origin", "https://example.com/x", "--out", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/content-secret-ghp/);
    expect(existsSync(out) ? walkRel(out) : []).toEqual([]);
  });

  it("a clean, fully-allowlisted subtree with no secret-shaped path or content is imported normally", () => {
    const { tarPath, sha } = buildFixtureTar({
      [`${ANCHOR}core/boot.js`]: "boot\n",
      [`${ANCHOR}core/config.js`]: "export const clean = true;\n",
    });
    const out = scratchDir("ws-a1-out-");
    const buildInfoPath = join(scratchDir("ws-a1-bi-"), "BUILD-INFO.json");
    const result = runCli(["--tar", tarPath, "--sha", sha, "--origin", "https://example.com/x", "--out", out, "--build-info", buildInfoPath]);
    expect(result.code).toBe(0);
    expect(walkRel(out)).toEqual(["core/boot.js", "core/config.js"]);
  });
});

describe("import.mjs W4: duplicate paths refused, writes are staged and atomic", () => {
  it("refuses duplicate post-anchor paths without writing anything", () => {
    // Two different tar entries (different case in the *anchor* segment,
    // which is stripped) collapse to the same relPath after stripping the
    // anchor, when the allowlist matches both.
    const repoDir = scratchDir("ws-a1-dup-repo-");
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test User"]);
    const path1 = join(repoDir, ANCHOR, "core", "boot.js");
    mkdirSync(dirname(path1), { recursive: true });
    writeFileSync(path1, "boot v1\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-q", "-m", "fixture"]);
    const sha = git(repoDir, ["rev-parse", "HEAD"]).trim();
    const tarPath = join(repoDir, "fixture.tar");
    git(repoDir, ["archive", "--format=tar", "-o", tarPath, sha]);

    // Duplicate the tar's own header+data for core/boot.js by concatenating
    // the archive with itself (minus its trailing zero-padding, which a
    // real tar writer pads out to a full blocking factor -- e.g. git
    // archive here pads a tiny fixture all the way to 10240 bytes, not
    // just the two-block end-of-archive marker), so the parser sees the
    // same path twice with different content.
    const raw = readFileSync(tarPath);
    const BLOCK = 512;
    let lastRealBlock = raw.length / BLOCK - 1;
    while (lastRealBlock >= 0 && raw.subarray(lastRealBlock * BLOCK, (lastRealBlock + 1) * BLOCK).every((b) => b === 0)) {
      lastRealBlock--;
    }
    const withoutTrailer = raw.subarray(0, (lastRealBlock + 1) * BLOCK);
    const dupTar = Buffer.concat([withoutTrailer, withoutTrailer, Buffer.alloc(BLOCK * 2)]);
    const dupTarPath = join(repoDir, "dup.tar");
    writeFileSync(dupTarPath, dupTar);

    const out = scratchDir("ws-a1-out-");
    const result = runCli(["--tar", dupTarPath, "--sha", sha, "--origin", "https://example.com/x", "--out", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/duplicate path/i);
    expect(existsSync(out) ? walkRel(out) : []).toEqual([]);
  });

  it("a re-import atomically replaces the previous tree -- a file removed upstream does not persist", () => {
    const first = buildFixtureTar({
      [`${ANCHOR}core/boot.js`]: "boot v1\n",
      [`${ANCHOR}core/legacy.js`]: "will be removed upstream\n",
    });
    const out = scratchDir("ws-a1-out-");
    const buildInfoPath = join(scratchDir("ws-a1-bi-"), "BUILD-INFO.json");
    const result1 = runCli(["--tar", first.tarPath, "--sha", first.sha, "--origin", "https://example.com/x", "--out", out, "--build-info", buildInfoPath]);
    expect(result1.code).toBe(0);
    expect(walkRel(out)).toEqual(["core/boot.js", "core/legacy.js"]);

    const second = buildFixtureTar({
      [`${ANCHOR}core/boot.js`]: "boot v2\n",
    });
    const result2 = runCli(["--tar", second.tarPath, "--sha", second.sha, "--origin", "https://example.com/x", "--out", out, "--build-info", buildInfoPath]);
    expect(result2.code).toBe(0);
    expect(walkRel(out)).toEqual(["core/boot.js"]);
    expect(readFileSync(join(out, "core/boot.js"), "utf8")).toBe("boot v2\n");
  });
});

describe("import.mjs criterion 5: BUILD-INFO.json", () => {
  it("records jpos_sha, origin_url, ancestor_of_main_checked_by, tar_sha256, imported_at, and a per-file sha256", () => {
    const { tarPath, sha } = buildFixtureTar({ [`${ANCHOR}index.html`]: "hello fixture\n" });
    const out = scratchDir("ws-a1-out-");
    const buildInfoPath = join(scratchDir("ws-a1-bi-"), "BUILD-INFO.json");
    const result = runCli([
      "--tar", tarPath,
      "--sha", sha,
      "--origin", "https://example.invalid/source/repo",
      "--out", out,
      "--build-info", buildInfoPath,
      "--checked-by", "test-suite",
    ]);
    expect(result.code).toBe(0);
    expect(existsSync(buildInfoPath)).toBe(true);
    const info = JSON.parse(readFileSync(buildInfoPath, "utf8"));
    expect(info.jpos_sha).toBe(sha);
    expect(info.origin_url).toBe("https://example.invalid/source/repo");
    expect(info.ancestor_of_main_checked_by).toBe("test-suite");
    expect(typeof info.tar_sha256).toBe("string");
    expect(info.tar_sha256).toHaveLength(64);
    expect(typeof info.imported_at).toBe("string");
    expect(new Date(info.imported_at).toString()).not.toBe("Invalid Date");
    expect(Object.keys(info.files)).toEqual(["index.html"]);
    expect(info.files["index.html"]).toHaveLength(64);
    expect(Array.isArray(info.added)).toBe(true);
  });
});

describe("import.mjs --status", () => {
  function freshImport() {
    const { tarPath, sha } = buildFixtureTar({
      [`${ANCHOR}index.html`]: "original\n",
      [`${ANCHOR}core/boot.js`]: "boot\n",
    });
    const out = scratchDir("ws-a1-status-out-");
    const buildInfoDir = scratchDir("ws-a1-status-bi-");
    const buildInfoPath = join(buildInfoDir, "BUILD-INFO.json");
    const result = runCli([
      "--tar", tarPath, "--sha", sha, "--origin", "https://example.com/x",
      "--out", out, "--build-info", buildInfoPath,
    ]);
    expect(result.code).toBe(0);
    return { out, buildInfoPath };
  }

  it("reports no drift right after a clean import", () => {
    const { out, buildInfoPath } = freshImport();
    const result = runCli(["--status", "--build-info", buildInfoPath, "--root", out]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/MODIFIED:|REMOVED:|ADDED:/);
  });

  it("reports MODIFIED for a file whose bytes changed since import (the fork's delta)", () => {
    const { out, buildInfoPath } = freshImport();
    writeFileSync(join(out, "index.html"), "hand-edited by the fork\n");
    const result = runCli(["--status", "--build-info", buildInfoPath, "--root", out]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/MODIFIED: index\.html/);
    expect(result.stdout).not.toMatch(/MODIFIED: core\/boot\.js/);
  });

  it("reports ADDED for a new file under root that BUILD-INFO.json doesn't know about", () => {
    const { out, buildInfoPath } = freshImport();
    mkdirSync(join(out, "apps", "local"), { recursive: true });
    writeFileSync(join(out, "apps", "local", "extra.js"), "new file\n");
    const result = runCli(["--status", "--build-info", buildInfoPath, "--root", out]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/ADDED: apps\/local\/extra\.js/);
  });

  it("does not report a file as ADDED once it is listed in BUILD-INFO.json's own added array", () => {
    const { out, buildInfoPath } = freshImport();
    mkdirSync(join(out, "apps", "local"), { recursive: true });
    writeFileSync(join(out, "apps", "local", "extra.js"), "new file\n");
    const info = JSON.parse(readFileSync(buildInfoPath, "utf8"));
    info.added = ["apps/local/extra.js"];
    writeFileSync(buildInfoPath, JSON.stringify(info, null, 2));
    const result = runCli(["--status", "--build-info", buildInfoPath, "--root", out]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/ADDED: apps\/local\/extra\.js/);
  });

  it("refuses --status when BUILD-INFO.json does not exist", () => {
    const result = runCli(["--status", "--build-info", join(scratchDir("ws-a1-missing-"), "nope.json"), "--root", scratchDir("ws-a1-missing-root-")]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/BUILD-INFO\.json/);
  });
});

describe("import.mjs W1: --verify re-checks an imported tree against BUILD-INFO.json and the tar", () => {
  function freshImport() {
    const { tarPath, sha } = buildFixtureTar({
      [`${ANCHOR}index.html`]: "original\n",
      [`${ANCHOR}core/boot.js`]: "boot\n",
    });
    const out = scratchDir("ws-a1-verify-out-");
    const buildInfoDir = scratchDir("ws-a1-verify-bi-");
    const buildInfoPath = join(buildInfoDir, "BUILD-INFO.json");
    const result = runCli([
      "--tar", tarPath, "--sha", sha, "--origin", "https://example.com/x",
      "--out", out, "--build-info", buildInfoPath,
    ]);
    expect(result.code).toBe(0);
    return { tarPath, sha, out, buildInfoPath };
  }

  it("passes immediately after a clean import", () => {
    const { tarPath, buildInfoPath, out } = freshImport();
    const result = runCli(["--verify", "--tar", tarPath, "--build-info", buildInfoPath, "--root", out]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/--verify passed/);
  });

  it("refuses when a file on disk has been hand-edited since import (does not match the tar's bytes)", () => {
    const { tarPath, buildInfoPath, out } = freshImport();
    writeFileSync(join(out, "index.html"), "tampered\n");
    const result = runCli(["--verify", "--tar", tarPath, "--build-info", buildInfoPath, "--root", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/content mismatch/i);
  });

  it("refuses when a file is missing from disk", () => {
    const { tarPath, buildInfoPath, out } = freshImport();
    rmSync(join(out, "core", "boot.js"));
    const result = runCli(["--verify", "--tar", tarPath, "--build-info", buildInfoPath, "--root", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/missing on disk/i);
  });

  it("refuses when the tar's commit id does not match BUILD-INFO.json's jpos_sha", () => {
    const { buildInfoPath, out } = freshImport();
    // A different tar, from a different commit (different tree content, so
    // the commit id is guaranteed to differ regardless of timing), but
    // otherwise well-formed.
    const other = buildFixtureTar({ [`${ANCHOR}index.html`]: "a different upstream commit\n" });
    const result = runCli(["--verify", "--tar", other.tarPath, "--build-info", buildInfoPath, "--root", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/jpos_sha|tar_sha256/i);
  });

  it("refuses when the tar bytes have changed since import (tar_sha256 mismatch)", () => {
    const { tarPath, buildInfoPath, out } = freshImport();
    // Append a byte -- still a readable (if odd) file, but a different
    // sha256 than what BUILD-INFO.json recorded at import time.
    writeFileSync(tarPath, Buffer.concat([readFileSync(tarPath), Buffer.from([0])]));
    const result = runCli(["--verify", "--tar", tarPath, "--build-info", buildInfoPath, "--root", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/tar_sha256/i);
  });
});

describe("import.mjs V1: --verify walks the whole --root tree, not just the tar's selected set", () => {
  function freshImport() {
    const { tarPath, sha } = buildFixtureTar({
      [`${ANCHOR}index.html`]: "original\n",
      [`${ANCHOR}core/boot.js`]: "boot\n",
    });
    const out = scratchDir("ws-a1-v1-out-");
    const buildInfoDir = scratchDir("ws-a1-v1-bi-");
    const buildInfoPath = join(buildInfoDir, "BUILD-INFO.json");
    const tarSha256 = sha256File(tarPath);
    const result = runCli([
      "--tar", tarPath, "--sha", sha, "--origin", "https://example.com/x",
      "--out", out, "--build-info", buildInfoPath,
    ]);
    expect(result.code).toBe(0);
    return { tarPath, sha, out, buildInfoPath, tarSha256 };
  }

  it("refuses an extra file on disk that is allowlisted and otherwise clean (core/extra.js)", () => {
    const { tarPath, buildInfoPath, out } = freshImport();
    mkdirSync(join(out, "core"), { recursive: true });
    writeFileSync(join(out, "core", "extra.js"), "evil()\n");
    const result = runCli(["--verify", "--tar", tarPath, "--build-info", buildInfoPath, "--root", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/on disk but not in BUILD-INFO\.json's file list: core\/extra\.js/);
  });

  it("refuses an extra file on disk that is not allowlisted at all (evil.js)", () => {
    const { tarPath, buildInfoPath, out } = freshImport();
    writeFileSync(join(out, "evil.js"), "evil()\n");
    const result = runCli(["--verify", "--tar", tarPath, "--build-info", buildInfoPath, "--root", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/on disk but not in BUILD-INFO\.json's file list: evil\.js/);
  });

  it("refuses an extra dotfile on disk (.env)", () => {
    const { tarPath, buildInfoPath, out } = freshImport();
    writeFileSync(join(out, ".env"), "GH=ghp_x\n");
    const result = runCli(["--verify", "--tar", tarPath, "--build-info", buildInfoPath, "--root", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/on disk but not in BUILD-INFO\.json's file list: \.env/);
  });

  it("refuses an extra file even when it is also listed in BUILD-INFO.json's added[] array", () => {
    const { tarPath, buildInfoPath, out } = freshImport();
    mkdirSync(join(out, "core"), { recursive: true });
    writeFileSync(join(out, "core", "extra.js"), "evil()\n");
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8"));
    buildInfo.added = ["core/extra.js"];
    writeFileSync(buildInfoPath, JSON.stringify(buildInfo));
    const result = runCli(["--verify", "--tar", tarPath, "--build-info", buildInfoPath, "--root", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/on disk but not in BUILD-INFO\.json's file list: core\/extra\.js/);
  });

  it("refuses when a known file is replaced by a symlink to identical bytes held outside the tree", () => {
    const { tarPath, buildInfoPath, out } = freshImport();
    const outsideFile = join(dirname(out), "outside-index.html");
    writeFileSync(outsideFile, "original\n"); // byte-identical to index.html's tar content
    rmSync(join(out, "index.html"));
    symlinkSync(outsideFile, join(out, "index.html"));
    // Sanity: the symlink really does resolve to identical bytes -- this
    // proves the refusal below is about the entry's TYPE, not its content.
    expect(readFileSync(join(out, "index.html"), "utf8")).toBe("original\n");
    const result = runCli(["--verify", "--tar", tarPath, "--build-info", buildInfoPath, "--root", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/non-regular entry on disk.*index\.html/);
  });

  it("refuses on a non-regular entry anywhere under --root, even a path unrelated to any known file", () => {
    const { tarPath, buildInfoPath, out } = freshImport();
    const outsideFile = join(dirname(out), "outside-anything.txt");
    writeFileSync(outsideFile, "whatever\n");
    mkdirSync(join(out, "core"), { recursive: true });
    symlinkSync(outsideFile, join(out, "core", "sneaky-link.js"));
    const result = runCli(["--verify", "--tar", tarPath, "--build-info", buildInfoPath, "--root", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/non-regular entry on disk.*core\/sneaky-link\.js/);
  });

  it("a clean tree with nothing extra still passes (no false positives from the new tree walk)", () => {
    const { tarPath, buildInfoPath, out } = freshImport();
    const result = runCli(["--verify", "--tar", tarPath, "--build-info", buildInfoPath, "--root", out]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/--verify passed/);
  });
});

describe("import.mjs W1b: --verify requires an independent --tar-sha256, never trusting BUILD-INFO.json's own recorded value", () => {
  it("refuses when --tar-sha256 is omitted, even though BUILD-INFO.json's tar_sha256 would otherwise validate", () => {
    const { tarPath, sha } = buildFixtureTar({ [`${ANCHOR}index.html`]: "hello\n" });
    const out = scratchDir("ws-a1-w1b-out-");
    const buildInfoPath = join(scratchDir("ws-a1-w1b-bi-"), "BUILD-INFO.json");
    const importResult = runCli(["--tar", tarPath, "--sha", sha, "--origin", "o", "--out", out, "--build-info", buildInfoPath]);
    expect(importResult.code).toBe(0);
    // runCliRaw does no auto-injection at all -- --tar-sha256 is genuinely
    // absent here, even though BUILD-INFO.json's own recorded tar_sha256
    // (written by the successful import above) would validate against
    // this exact tar if --verify still fell back to trusting it.
    const raw = runCliRaw(["--verify", "--tar", tarPath, "--build-info", buildInfoPath, "--root", out]);
    expect(raw.code).not.toBe(0);
    expect(raw.stderr).toMatch(/--tar-sha256/);
  });

  it("refuses a re-signed tar even when the operator's independent --tar-sha256 is the ORIGINAL trusted hash -- the review's own attack", () => {
    // Reproduces the security review's probe: rebuild the tar with one file
    // changed, edit that file on disk to match, and rewrite BUILD-INFO.json's
    // own tar_sha256 to the new tar's hash. Before this fix, --verify only
    // ever compared the tar it was given against that rewritten field, so
    // the attack was self-consistent and passed. Now the operator's
    // independently-known --tar-sha256 (the ORIGINAL tar's hash, from
    // Step 1's own trusted record) is what --verify pins against, and the
    // resigned tar can never produce that hash.
    const original = buildFixtureTar({
      [`${ANCHOR}index.html`]: "original\n",
      [`${ANCHOR}core/a.js`]: "A\n",
    });
    const out = scratchDir("ws-a1-w1b-resign-out-");
    const buildInfoPath = join(scratchDir("ws-a1-w1b-resign-bi-"), "BUILD-INFO.json");
    const originalTarSha256 = sha256File(original.tarPath);
    const importResult = runCli([
      "--tar", original.tarPath, "--sha", original.sha, "--origin", "o",
      "--out", out, "--build-info", buildInfoPath,
    ]);
    expect(importResult.code).toBe(0);

    // Attacker: a new tar, one file's bytes changed, a matching edit on
    // disk, and BUILD-INFO.json's tar_sha256 rewritten to the new tar's
    // hash -- everything the OLD --verify compared against is now
    // internally self-consistent.
    writeFileSync(join(out, "core", "a.js"), "EVIL\n");
    const forgedTar = buildFixtureTar({
      [`${ANCHOR}index.html`]: "original\n",
      [`${ANCHOR}core/a.js`]: "EVIL\n",
    });
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8"));
    buildInfo.tar_sha256 = sha256File(forgedTar.tarPath);
    writeFileSync(buildInfoPath, JSON.stringify(buildInfo));

    // Operator supplies the tar they were actually handed for THIS verify
    // run (the forged one, since that's what --tar points at) but pins it
    // with the ORIGINAL trusted hash they recorded independently -- proving
    // the independent pin, not BUILD-INFO.json's field, is what refuses.
    const result = runCli([
      "--verify", "--tar", forgedTar.tarPath, "--tar-sha256", originalTarSha256,
      "--build-info", buildInfoPath, "--root", out,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/does not match --tar-sha256/);
  });
});

describe("import.mjs W4b: isSafeRelPath rejects empty and \".\" path segments", () => {
  it("directly exercises the unsafe-segment rejection via a synthetic tar containing core//a.js and core/./a.js", () => {
    // Builds the tar by hand (not through git, which would never emit
    // these spellings) so the fixture is unambiguous about which entries
    // are unsafe. Uses the same anchor-relative naming import.mjs expects.
    const parts = [];
    function header(name, size) {
      const buf = Buffer.alloc(512);
      buf.write(name, 0, "utf8");
      buf.write(size.toString(8).padStart(11, "0") + " ", 124, "latin1");
      buf.write("0", 156, "latin1"); // regular file
      buf.write("ustar\0", 257, "latin1");
      buf.write("00", 263, "latin1");
      let checksum = 0;
      for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 0x20 : buf[i];
      buf.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
      return buf;
    }
    function entry(name, data) {
      const content = Buffer.from(data, "utf8");
      const padded = Math.ceil(content.length / 512) * 512;
      const body = Buffer.alloc(padded);
      content.copy(body);
      return Buffer.concat([header(name, content.length), body]);
    }
    function paxRecord(key, value) {
      // PAX record format: "<len> key=value\n", where <len> counts the
      // whole record (itself included) -- computed iteratively since the
      // length prefix's own digit count can push the total past a power
      // of ten.
      const suffix = `${key}=${value}\n`;
      let len = suffix.length + 2;
      for (;;) {
        const total = `${len}`.length + 1 + suffix.length;
        if (total === len) break;
        len = total;
      }
      return `${len} ${suffix}`;
    }
    function globalHeader(sha) {
      const data = Buffer.from(paxRecord("comment", sha), "utf8");
      const padded = Math.ceil(data.length / 512) * 512;
      const body = Buffer.alloc(padded);
      data.copy(body);
      const buf = Buffer.alloc(512);
      buf.write("pax_global_header", 0, "utf8");
      buf.write(data.length.toString(8).padStart(11, "0") + " ", 124, "latin1");
      buf.write("g", 156, "latin1");
      buf.write("ustar\0", 257, "latin1");
      buf.write("00", 263, "latin1");
      let checksum = 0;
      for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 0x20 : buf[i];
      buf.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
      return Buffer.concat([buf, body]);
    }
    const sha = "a".repeat(40);
    parts.push(globalHeader(sha));
    parts.push(entry(`${ANCHOR}core/a.js`, "safe\n"));
    parts.push(entry(`${ANCHOR}core//a.js`, "unsafe-empty-segment\n"));
    parts.push(entry(`${ANCHOR}core/./a.js`, "unsafe-dot-segment\n"));
    parts.push(Buffer.alloc(1024)); // end-of-archive marker
    const tarBuf = Buffer.concat(parts);
    const tarPath = join(scratchDir("ws-a1-w4b-synth-"), "fixture.tar");
    writeFileSync(tarPath, tarBuf);

    const out = scratchDir("ws-a1-w4b-synth-out-");
    const buildInfoPath = join(scratchDir("ws-a1-w4b-synth-bi-"), "BUILD-INFO.json");
    const result = runCli(["--tar", tarPath, "--sha", sha, "--origin", "o", "--out", out, "--build-info", buildInfoPath]);
    expect(result.code).toBe(0);
    // Only the safe spelling was ever selected -- the other two entries'
    // relPaths ("core//a.js", "core/./a.js") contain an empty or "."
    // segment and are silently skipped, exactly like a defense-in-depth
    // path-traversal entry always has been.
    expect(readdirSync(join(out, "core"))).toEqual(["a.js"]);
    expect(readFileSync(join(out, "core", "a.js"), "utf8")).toBe("safe\n");
  });
});

describe("import.mjs W5 regression: a symlink pre-existing under --out is never followed", () => {
  it("--out/core -> an outside victim directory: import succeeds and the victim is untouched", () => {
    const victim = scratchDir("ws-a1-w5-victim-");
    writeFileSync(join(victim, "CANARY"), "keep\n");

    const { tarPath, sha } = buildFixtureTar({ [`${ANCHOR}core/pwn.js`]: "pwn\n" });
    const outParent = scratchDir("ws-a1-w5-out-parent-");
    const out = join(outParent, "shell");
    mkdirSync(out, { recursive: true });
    symlinkSync(victim, join(out, "core"));
    expect(lstatSync(join(out, "core")).isSymbolicLink()).toBe(true);

    const buildInfoPath = join(scratchDir("ws-a1-w5-bi-"), "BUILD-INFO.json");
    const result = runCli(["--tar", tarPath, "--sha", sha, "--origin", "o", "--out", out, "--build-info", buildInfoPath]);
    expect(result.code).toBe(0);

    // The victim directory was never written into -- runImport's staged
    // swap replaces the whole --out directory in one atomic rename, so a
    // pre-existing symlink anywhere under it can never be traversed into.
    expect(readdirSync(victim)).toEqual(["CANARY"]);
    expect(readFileSync(join(victim, "CANARY"), "utf8")).toBe("keep\n");
    // And the import actually landed the real content at the real path.
    expect(readFileSync(join(out, "core", "pwn.js"), "utf8")).toBe("pwn\n");
    expect(lstatSync(join(out, "core")).isSymbolicLink()).toBe(false);
  });
});

describe("the real allowlist.txt", () => {
  it("exists and is non-empty", () => {
    expect(existsSync(REAL_ALLOWLIST)).toBe(true);
    const contents = readFileSync(REAL_ALLOWLIST, "utf8");
    const patternLines = contents.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    expect(patternLines.length).toBeGreaterThan(0);
  });
});

describe("IMPORT.md", () => {
  it("documents the no-environment invocation and that executors never touch jpos", () => {
    const importMd = readFileSync(join(TEST_DIR, "..", "import", "IMPORT.md"), "utf8");
    expect(importMd).toMatch(/env -i/);
    expect(importMd).toMatch(/<jpos-checkout>/);
    expect(importMd).toMatch(/executors never/i);
    expect(importMd).toMatch(/re-import/i);
  });

  it("documents the anchor pathspec on the git archive command (E5)", () => {
    const importMd = readFileSync(join(TEST_DIR, "..", "import", "IMPORT.md"), "utf8");
    expect(importMd).toMatch(/git archive[\s\S]*crates\/fulc-shell\/assets/);
  });

  it("documents --tar-sha256 (W1)", () => {
    const importMd = readFileSync(join(TEST_DIR, "..", "import", "IMPORT.md"), "utf8");
    expect(importMd).toMatch(/--tar-sha256/);
  });
});

// D#37 Correction C6: placed last so it observes the final state after every
// other test in this file has run (vitest executes describe/it blocks in a
// single file in source order by default). Every CLI-harness case above now
// passes an explicit --build-info under a scratch dir (withFixtureDefaults),
// so none of them should ever touch the real, committed
// apps/workspace/BUILD-INFO.json -- this is the mechanical check that holds
// that guarantee to account.
describe("the real apps/workspace/BUILD-INFO.json", () => {
  it("is left byte-identical by this whole suite", () => {
    const after = existsSync(REAL_BUILD_INFO) ? sha256File(REAL_BUILD_INFO) : null;
    expect(after).toBe(REAL_BUILD_INFO_SHA_BEFORE);
  });
});
