// apps/workspace/test/checks.test.mjs
//
// D#37 WS-A1: tests checks.mjs's --import and --ship modes. Every rule gets
// a fixture file that trips exactly that rule, so removing the rule's check
// from checks.mjs makes that fixture's assertion fail.
//
// Security fix round: adds case-insensitive path-rule fixtures, the widened
// content-rule family (E2/W2), non-regular-entry detection (E3), and the
// --ship product-name gate's Unicode/encoding bypasses plus the
// precompressed-file refusal (E4). Every fixture here is invented for this
// test; nothing is read from the private source checkout.

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import {
  checkContent,
  checkShipClaudeCode,
  isPrecompressed,
  checkTrustedTypesSink,
  TRUSTED_TYPES_SINK_GUARDED_FILES,
  checkShipNoLicenseActivation,
  checkShipNoSubscriptionBypass,
} from "../import/rules.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CHECKS_MJS = join(TEST_DIR, "..", "import", "checks.mjs");

// One literal backslash byte, built at runtime -- typing a 4-hex escape
// sequence (` `) directly into a source/test file gets turned into the
// real character by the authoring tool before it ever reaches disk, which
// is useless for a fixture that has to contain the literal, UNPARSED escape
// TEXT (the six characters backslash/u/0/0/2/0), exactly as it would sit in
// a source file the importer pulls in. Building it this way sidesteps that
// entirely: the string "u0020" below is never adjacent to a real backslash
// until this line runs.
const BS = String.fromCharCode(92);

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

function writeFixtureDir(files) {
  const dir = scratchDir("ws-a1-checks-fixture-");
  for (const [relPath, content] of Object.entries(files)) {
    const dest = join(dir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  return dir;
}

function writeAllowlist(patterns) {
  const dir = scratchDir("ws-a1-checks-allowlist-");
  const path = join(dir, "allowlist.txt");
  writeFileSync(path, patterns.join("\n") + "\n");
  return path;
}

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CHECKS_MJS, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

// A fixture directory covering every --import rule with one isolated file
// per rule, plus a clean allowlisted file as a positive control.
const IMPORT_FIXTURE_FILES = {
  ".env": "TOKEN=should-never-ship\n",
  "config/env.local": "also should never ship\n",
  "notes.bak": "old draft\n",
  "secret.txt": "not actually a secret file, but named like one\n",
  "certs/server.pem": "not a real cert\n",
  "certs/server.key": "not a real key\n",
  "certs/server.p12": "not a real bundle\n",
  "keys/id_rsa": "not a real key\n",
  ".npmrc": "//registry.example.com/:_authToken=x\n",
  "bundle.js.map": "{}\n",
  "clean/ok.js": "console.log('clean and allowlisted');\n",
  "apps/terminal/t.js": "console.log('not on the allowlist, otherwise clean');\n",
  "apps/config/token-ghs.js": "const t = 'ghs_abcdefghijklmnop';\n",
  "apps/config/token-ghp.js": "const t = 'ghp_abcdefghijklmnop';\n",
  "apps/config/token-sk-ant.js": "const t = 'sk-ant-abcdefghijklmnop';\n",
  "apps/config/token-sk-live.js": "const t = 'sk_live_abcdefghijklmnop';\n",
  "apps/config/token-akia.js": "const t = 'AKIAABCDEFGHIJKLMNOP';\n",
  "apps/config/pem-block.js": "const t = '-----BEGIN PRIVATE KEY-----';\n",
  "apps/config/local-path.js": "const p = '/home/alice/jpos/some/file';\n",
  "vendor/monaco/loader.js": "monaco loader\n",
  "vendor/xterm/xterm.js": "xterm\n",
  "apps/automerge-bootstrap/core.js": "// wraps automerge\n",
  // E2/W2: the widened token-family and generic assignment rules.
  "apps/config/token-github-pat.js": "const t = 'github_pat_abcdefghijklmnop';\n",
  "apps/config/token-gho.js": "const t = 'gho_abcdefghijklmnop';\n",
  "apps/config/token-ghu.js": "const t = 'ghu_abcdefghijklmnop';\n",
  "apps/config/token-ghr.js": "const t = 'ghr_abcdefghijklmnop';\n",
  "apps/config/token-xoxb.js": "const t = 'xoxb-1234567890-abcdefg';\n",
  // Security re-review 2 (E2c): a real Google API key is "AIza" + 35
  // characters (39 total) -- the tightened rule requires the full length,
  // so the fixture has to be a real-shaped key, not an arbitrary shorter
  // string that merely started with "AIza".
  "apps/config/token-aiza.js": `const t = 'AIza${"SyAbCdEfGhIjKlMnOpQrStUvWxYz1234567".slice(0, 35)}';\n`,
  "apps/config/token-sk-proj.js": "const t = 'sk-proj-abcdefghijklmnop';\n",
  "apps/config/token-rk-live.js": "const t = 'rk_live_abcdefghijklmnop';\n",
  "apps/config/token-asia.js": "const t = 'ASIAABCDEFGHIJKLMNOP';\n",
  "apps/config/token-jwt.js":
    "const t = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzbm90YXJlYWxzaWc';\n",
  "apps/config/token-password-assign.js": "const cfg = { DB_PASSWORD=hunter2 };\n",
  "apps/config/token-api-key-assign.js": "const cfg = { API_KEY=abcdef123456 };\n",
  "apps/config/token-fxat.js": `const t = 'fxat_${"a".repeat(49)}';\n`,
  "apps/config/token-whsec.js": `const t = 'whsec_${"a".repeat(24)}';\n`,
  // E2: case-insensitive path rule -- same shapes as above, different case.
  "certs/SERVER.PEM": "not a real cert, uppercase extension\n",
  "keys/ID_RSA": "not a real key, uppercase name\n",
  "CONFIG/SECRET.JS": "named like a secret, uppercase throughout\n",
};

const ALLOWLIST_PATTERNS = ["clean/ok.js"];

describe("checks.mjs --import: each rule fires on its own isolated fixture", () => {
  const dir = writeFixtureDir(IMPORT_FIXTURE_FILES);
  const allowlist = writeAllowlist(ALLOWLIST_PATTERNS);
  const result = runCli(["--import", dir, "--allowlist", allowlist]);

  it("exits non-zero", () => {
    expect(result.code).not.toBe(0);
  });

  const pathRuleCases = [
    [".env", "path-dotfile-or-secret"],
    ["config/env.local", "path-dotfile-or-secret"],
    ["notes.bak", "path-dotfile-or-secret"],
    ["secret.txt", "path-dotfile-or-secret"],
    ["certs/server.pem", "path-dotfile-or-secret"],
    ["certs/server.key", "path-dotfile-or-secret"],
    ["certs/server.p12", "path-dotfile-or-secret"],
    ["keys/id_rsa", "path-dotfile-or-secret"],
    [".npmrc", "path-dotfile-or-secret"],
    ["bundle.js.map", "path-dotfile-or-secret"],
    ["apps/terminal/t.js", "not-allowlisted"],
    ["apps/config/token-ghs.js", "content-secret-ghs"],
    ["apps/config/token-ghp.js", "content-secret-ghp"],
    ["apps/config/token-sk-ant.js", "content-secret-sk-ant"],
    ["apps/config/token-sk-live.js", "content-secret-sk-live"],
    ["apps/config/token-akia.js", "content-secret-akia"],
    ["apps/config/pem-block.js", "content-secret-pem-begin"],
    ["apps/config/local-path.js", "content-local-path"],
    ["vendor/monaco/loader.js", "path-vendor-monaco"],
    ["vendor/xterm/xterm.js", "path-vendor-xterm"],
    ["apps/automerge-bootstrap/core.js", "path-automerge"],
    ["apps/config/token-github-pat.js", "content-secret-github-pat"],
    ["apps/config/token-gho.js", "content-secret-gho"],
    ["apps/config/token-ghu.js", "content-secret-ghu"],
    ["apps/config/token-ghr.js", "content-secret-ghr"],
    ["apps/config/token-xoxb.js", "content-secret-xoxb"],
    ["apps/config/token-aiza.js", "content-secret-aiza"],
    ["apps/config/token-sk-proj.js", "content-secret-sk-proj"],
    ["apps/config/token-rk-live.js", "content-secret-rk-live"],
    ["apps/config/token-asia.js", "content-secret-asia"],
    ["apps/config/token-jwt.js", "content-secret-jwt"],
    ["apps/config/token-password-assign.js", "content-secret-password-assign"],
    ["apps/config/token-api-key-assign.js", "content-secret-api-key-assign"],
    ["apps/config/token-fxat.js", "content-secret-fxat"],
    ["apps/config/token-whsec.js", "content-secret-whsec"],
    ["certs/SERVER.PEM", "path-dotfile-or-secret"],
    ["keys/ID_RSA", "path-dotfile-or-secret"],
    ["CONFIG/SECRET.JS", "path-dotfile-or-secret"],
  ];

  for (const [path, rule] of pathRuleCases) {
    it(`flags ${path} with rule ${rule}`, () => {
      expect(result.stdout).toMatch(new RegExp(`^${rule}: ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    });
  }

  it("does not flag the clean, allowlisted file", () => {
    const lines = result.stdout.split("\n");
    const hitsForCleanFile = lines.filter((l) => l.endsWith(": clean/ok.js"));
    expect(hitsForCleanFile).toEqual([]);
  });
});

describe("checks.mjs --import: a clean, fully-allowlisted tree passes", () => {
  it("exits 0 with no violations", () => {
    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n" });
    const allowlist = writeAllowlist(["clean/ok.js"]);
    const result = runCli(["--import", dir, "--allowlist", allowlist]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/passed/);
  });
});

describe("checks.mjs --import: BUILD-INFO.json's added list is an exception to not-allowlisted", () => {
  it("does not flag a file listed in added", () => {
    const dir = writeFixtureDir({ "apps/local/extra.js": "console.log('added by the fork');\n" });
    const allowlist = writeAllowlist(["clean/ok.js"]);
    const buildInfoDir = scratchDir("ws-a1-checks-bi-");
    const buildInfoPath = join(buildInfoDir, "BUILD-INFO.json");
    writeFileSync(buildInfoPath, JSON.stringify({ files: {}, added: ["apps/local/extra.js"] }));
    const result = runCli(["--import", dir, "--allowlist", allowlist, "--build-info", buildInfoPath]);
    expect(result.code).toBe(0);
  });

  it("flags the same file as not-allowlisted when there is no added exception", () => {
    const dir = writeFixtureDir({ "apps/local/extra.js": "console.log('added by the fork');\n" });
    const allowlist = writeAllowlist(["clean/ok.js"]);
    const result = runCli(["--import", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^not-allowlisted: apps\/local\/extra\.js$/m);
  });
});

describe("checks.mjs E3: a non-regular entry is flagged, in both --import and --ship, never silently skipped", () => {
  function withSymlinkFixture() {
    const outsideDir = scratchDir("ws-a1-checks-outside-");
    const outsideTarget = join(outsideDir, "secret-target.js");
    writeFileSync(outsideTarget, "const t = 'ghp_shouldneverbereadthroughthelink';\n");

    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n" });
    symlinkSync(outsideTarget, join(dir, "linked-file.js"));
    mkdirSync(join(dir, "linkdir-target"));
    writeFileSync(join(dir, "linkdir-target", "inner.js"), "inner file, reachable only via the symlink\n");
    symlinkSync(join(dir, "linkdir-target"), join(dir, "linked-dir"));
    return { dir, allowlist: writeAllowlist(["clean/ok.js", "linked-file.js", "linked-dir/**"]) };
  }

  it("--import flags a symlink-to-file as non-regular-file", () => {
    const { dir, allowlist } = withSymlinkFixture();
    const result = runCli(["--import", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^non-regular-file: linked-file\.js$/m);
  });

  it("--import flags a symlink-to-directory as non-regular-file, and never descends into it", () => {
    const { dir, allowlist } = withSymlinkFixture();
    const result = runCli(["--import", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^non-regular-file: linked-dir$/m);
    expect(result.stdout).not.toMatch(/linked-dir\/inner\.js/);
  });

  it("--ship also flags the same symlinks as non-regular-file", () => {
    const { dir, allowlist } = withSymlinkFixture();
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^non-regular-file: linked-file\.js$/m);
    expect(result.stdout).toMatch(/^non-regular-file: linked-dir$/m);
  });
});

describe("checks.mjs --ship: adds the Claude Code gate on top of every --import rule", () => {
  it("flags the flexible-separator text form (ship-claude-code-text)", () => {
    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n", "apps/agents/output1.js": "// Generated with Claude Code\n" });
    const allowlist = writeAllowlist(["clean/ok.js", "apps/agents/output1.js"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^ship-claude-code-text: apps\/agents\/output1\.js$/m);
  });

  it("flags the literal &nbsp; entity form (ship-claude-code-nbsp), which the text-form pattern alone misses", () => {
    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n", "apps/agents/output2.js": "claude&nbsp;code trailer\n" });
    const allowlist = writeAllowlist(["clean/ok.js", "apps/agents/output2.js"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^ship-claude-code-nbsp: apps\/agents\/output2\.js$/m);
    expect(result.stdout).not.toMatch(/^ship-claude-code-text: apps\/agents\/output2\.js$/m);
  });

  it("still enforces the --import rules in --ship mode (e.g. content-secret-ghs)", () => {
    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n", "apps/config/token.js": "const t = 'ghs_abcdefghijklmnop';\n" });
    const allowlist = writeAllowlist(["clean/ok.js", "apps/config/token.js"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^content-secret-ghs: apps\/config\/token\.js$/m);
  });

  it("a clean, fully-allowlisted tree with no Claude Code text passes", () => {
    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n" });
    const allowlist = writeAllowlist(["clean/ok.js"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).toBe(0);
  });
});

describe("checks.mjs --ship: D#37 C19d WS-B1 criterion 5, the forbidden jpos branding gate", () => {
  it("flags the jpos system-name string (JP OP)", () => {
    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n", "core/script.js": "const x = 'JP OP V.0.1';\n" });
    const allowlist = writeAllowlist(["clean/ok.js", "core/script.js"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^ship-forbidden-branding-jpos: core\/script\.js$/m);
  });

  it("flags the jpos company string (Formal Hosting)", () => {
    const dir = writeFixtureDir({
      "clean/ok.js": "console.log('ok');\n",
      "core/script.js": "const c = '2026 Formal Hosting LLC and fulcrumaxe-os contributors';\n",
    });
    const allowlist = writeAllowlist(["clean/ok.js", "core/script.js"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^ship-forbidden-branding-jpos: core\/script\.js$/m);
  });

  it("flags the jpos welcome string (Jungle We Like)", () => {
    const dir = writeFixtureDir({
      "clean/ok.js": "console.log('ok');\n",
      "core/script.js": "const w = 'WELCOME TO Jungle We Like Fun And Games';\n",
    });
    const allowlist = writeAllowlist(["clean/ok.js", "core/script.js"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^ship-forbidden-branding-jpos: core\/script\.js$/m);
  });

  it("flags the jpos boot-line string (CONNECTING TO THE CONSTRUCT)", () => {
    const dir = writeFixtureDir({
      "clean/ok.js": "console.log('ok');\n",
      "core/boot.js": "const b = 'CONNECTING TO THE CONSTRUCT...';\n",
    });
    const allowlist = writeAllowlist(["clean/ok.js", "core/boot.js"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^ship-forbidden-branding-jpos: core\/boot\.js$/m);
  });

  it("a comment mentioning the old strings (documenting the removal) does not trip the gate", () => {
    const dir = writeFixtureDir({
      "clean/ok.js": "console.log('ok');\n",
      "core/boot.js": "// Removed the old 'JP OP V.0.1' / 'Formal Hosting' jpos defaults here.\nconst x = 1;\n",
    });
    const allowlist = writeAllowlist(["clean/ok.js", "core/boot.js"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).toBe(0);
  });

  it("--import does not run this rule (ship-only)", () => {
    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n", "core/script.js": "const x = 'JP OP V.0.1';\n" });
    const allowlist = writeAllowlist(["clean/ok.js", "core/script.js"]);
    const result = runCli(["--import", dir, "--allowlist", allowlist]);
    expect(result.stdout).not.toMatch(/ship-forbidden-branding-jpos/);
  });

  it("a clean --ship tree with the new ruled branding strings passes", () => {
    const dir = writeFixtureDir({
      "clean/ok.js": "console.log('ok');\n",
      "core/script.js": "window.brandingData = { os_name: 'fulcrumaxe cloud', welcome_message: 'Welcome to fulcrumaxe cloud.' };\n",
    });
    const allowlist = writeAllowlist(["clean/ok.js", "core/script.js"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).toBe(0);
  });
});

describe("checks.mjs D#37 WS-L1 (correction C19c criteria 2 and 8): no licence-activation module, no subscription-gate bypass flag", () => {
  it("--ship flags a dist/ path under apps/activation/ (path-activation-shipped)", () => {
    const dir = writeFixtureDir({
      "clean/ok.js": "console.log('ok');\n",
      "apps/activation/activation.js": "console.log('should never ship');\n",
    });
    const allowlist = writeAllowlist(["clean/ok.js", "apps/activation/**"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^path-activation-shipped: apps\/activation\/activation\.js$/m);
  });

  it("--import does NOT flag apps/activation/** (C19e item 9: the fork keeps the import, only --ship drops it)", () => {
    const dir = writeFixtureDir({
      "clean/ok.js": "console.log('ok');\n",
      "apps/activation/activation.js": "console.log('imported but never shipped');\n",
    });
    const allowlist = writeAllowlist(["clean/ok.js", "apps/activation/**"]);
    const result = runCli(["--import", dir, "--allowlist", allowlist]);
    expect(result.code).toBe(0);
  });

  const licenseVocabCases = [
    ["window.FULCLicense.openActivation();", "ship-license-activation-global"],
    ["fetch('/api/license/status');", "ship-license-activation-api-path"],
    ["cta.textContent = 'Activate license';", "ship-license-activation-cta-text"],
    ["errorLine.textContent = 'License key is required.';", "ship-license-activation-key-text"],
  ];
  for (const [snippet, rule] of licenseVocabCases) {
    it(`--ship flags ${JSON.stringify(snippet)} with ${rule}`, () => {
      const dir = writeFixtureDir({
        "clean/ok.js": "console.log('ok');\n",
        "core/leftover.js": `${snippet}\n`,
      });
      const allowlist = writeAllowlist(["clean/ok.js", "core/leftover.js"]);
      const result = runCli(["--ship", dir, "--allowlist", allowlist]);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toMatch(new RegExp(`^${rule}: core/leftover\\.js$`, "m"));
    });
  }

  it("--ship does not flag a comment merely EXPLAINING the removal (same comment-stripping checkTrustedTypesSink uses)", () => {
    const dir = writeFixtureDir({
      "clean/ok.js": "console.log('ok');\n",
      "core/explains-removal.js": "// D#37 WS-L1: FULCLicense, /api/license/, 'Activate license' and 'license key' are gone.\nconsole.log('fine');\n",
    });
    const allowlist = writeAllowlist(["clean/ok.js", "core/explains-removal.js"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).toBe(0);
  });

  it("--ship flags a subscription-gate bypass flag (ship-subscription-bypass-flag)", () => {
    const dir = writeFixtureDir({
      "clean/ok.js": "console.log('ok');\n",
      "core/leftover2.js": "if (window.WORKSPACE_ACCESS_BYPASS) return openDesktop();\n",
    });
    const allowlist = writeAllowlist(["clean/ok.js", "core/leftover2.js"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^ship-subscription-bypass-flag: core\/leftover2\.js$/m);
  });

  it("checkShipNoLicenseActivation / checkShipNoSubscriptionBypass: a clean file trips neither rule", () => {
    const clean = Buffer.from("export function open() { return true; }\n");
    expect(checkShipNoLicenseActivation(clean)).toEqual([]);
    expect(checkShipNoSubscriptionBypass(clean)).toEqual([]);
  });

  it("a real dist/ built from the current cloud profile ships none of this vocabulary and no apps/activation/* path", () => {
    // Builds the ACTUAL profile-filtered dist/ (not a synthetic fixture)
    // and runs --ship against it directly -- the same demonstration this
    // task's PR description reports by hand, pinned here so a regression
    // (e.g. cloud.json regaining "activation") fails CI.
    const outDir = scratchDir("ws-l1-real-dist-");
    const buildScript = join(TEST_DIR, "..", "build", "build.mjs");
    const buildResult = (() => {
      try {
        const stdout = execFileSync(process.execPath, [buildScript, "--out", outDir], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, stdout };
      } catch (err) {
        return { code: err.status ?? 1, stdout: (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "") };
      }
    })();
    expect(buildResult.code, `build.mjs failed:\n${buildResult.stdout}`).toBe(0);

    function listPaths(dir, base = dir, acc = []) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) listPaths(abs, base, acc);
        else acc.push(relative(base, abs).split(sep).join("/"));
      }
      return acc;
    }
    // D#37 WS-D criterion 3: build.mjs now ships everything except
    // index.html under a content-hashed s/<hash>/ prefix -- a substring
    // check (not startsWith) still finds a shipped apps/activation/* path
    // regardless of that prefix, and correctly stays empty when there
    // genuinely is none.
    const distPaths = listPaths(outDir);
    expect(distPaths.some((p) => p.includes("apps/activation/"))).toBe(false);

    // build.mjs's own internal --ship check (step 6) already ran against
    // the FLAT pre-hash tree (see build.mjs's own comment on why) -- this
    // is a second, independent invocation of the checks.mjs CLI directly,
    // now against the real, final s/<hash>/ subtree (same relative paths
    // as that internal check saw, so the allowlist still matches). There
    // is exactly one hash directory per build.
    const hashDirs = readdirSync(join(outDir, "s"));
    expect(hashDirs, `expected exactly one s/<hash> directory, got: ${hashDirs.join(", ")}`).toHaveLength(1);
    const hashedOutDir = join(outDir, "s", hashDirs[0]);

    // Same --build-info build.mjs's OWN internal --ship check (step 6)
    // passes -- the real apps/workspace/BUILD-INFO.json, which records
    // this fork's own locally-added files (never part of the original
    // jpos import, so not literally in allowlist.txt). Omitting it here
    // would report spurious not-allowlisted violations build.mjs itself
    // never sees.
    const realBuildInfoPath = join(TEST_DIR, "..", "BUILD-INFO.json");
    // First-party apps (apps/workspace/apps/<id>/, D#37 C24) are not in the
    // import allowlist; build.mjs tells the check which prefixes are theirs,
    // so this direct invocation does too: the app directories in the built
    // dist that also exist under apps/workspace/apps/.
    const firstParty = existsSync(join(hashedOutDir, "apps"))
      ? readdirSync(join(hashedOutDir, "apps")).filter((d) => existsSync(join(TEST_DIR, "..", "apps", d)))
      : [];
    const prefixArgs = firstParty.length > 0 ? ["--first-party-prefix", firstParty.map((d) => `apps/${d}/`).join(",")] : [];
    const shipResult = runCli(["--ship", hashedOutDir, "--build-info", realBuildInfoPath, ...prefixArgs]);
    expect(shipResult.code, `--ship failed against the real built dist/:\n${shipResult.stdout}`).toBe(0);
  });
});

describe("checks.mjs E4: --ship product-name gate bypasses the review probed", () => {
  // Every fixture pairs a "words with a hidden/encoded separator" file with
  // a clean allowlisted control file, matching the review's own probe shape.
  const bypassCases = [
    ["utf8-nbsp", "claude code", "a real UTF-8-encoded NBSP between the words"],
    ["escape-u00a0-text", "claude\\u00a0code", "the literal six-character \\u00a0 escape text"],
    ["escape-xa0-text", "claude\\xa0code", "the literal four-character \\xa0 escape text"],
    ["html-decimal-entity", "claude&#160;code", "the &#160; HTML decimal entity"],
    ["html-hex-entity", "claude&#xa0;code", "the &#xa0; HTML hex entity"],
    ["zero-width-space", "claude​code", "an actual zero-width space (U+200B)"],
  ];

  for (const [slug, content, description] of bypassCases) {
    it(`flags ${description}`, () => {
      const relPath = `apps/agents/bypass-${slug}.js`;
      const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n", [relPath]: `${content}\n` });
      const allowlist = writeAllowlist(["clean/ok.js", relPath]);
      const result = runCli(["--ship", dir, "--allowlist", allowlist]);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toMatch(new RegExp(`^ship-claude-code-\\w+: ${relPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    });
  }

  it("refuses a .gz file under --ship regardless of its content", () => {
    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n" });
    // These are real gzip magic bytes (1f 8b) -- E4b detects compression by
    // magic bytes now, not by extension, so this has to be a real signature
    // for the refusal to mean anything.
    mkdirSync(join(dir, "apps"), { recursive: true });
    writeFileSync(join(dir, "apps", "bundle.js.gz"), Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02, 0x03]));
    const allowlist = writeAllowlist(["clean/ok.js", "apps/bundle.js.gz"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^ship-precompressed-file: apps\/bundle\.js\.gz$/m);
  });
});

describe("checks.mjs E4b: --ship product-name gate bypasses the second security re-review probed", () => {
  // Every fixture again pairs an obfuscated-separator file with a clean
  // allowlisted control, matching E4's own fixture shape.
  const nbspBypassCases = [
    ["combining-acute-after-claude", "claudé code", "U+0301 combining acute accent, used as the separator"],
    ["combining-low-line-after-claude", "claude̲ code", "U+0332 combining low line, used as the separator"],
    ["cgj-after-claude", "claude͏ code", "the combining grapheme joiner U+034F, used as the separator"],
    ["soft-hyphen", "claude­ code", "the real soft hyphen character U+00AD"],
    ["shy-entity", "claude&shy;code", "the &shy; HTML entity"],
    ["mongolian-vowel-sep", "claude᠎ code", "the Mongolian vowel separator U+180E"],
    ["function-application", "claude⁡ code", "function application U+2061"],
    ["decimal-entity-32", "claude&#32;code", "the &#32; decimal HTML entity for a plain space"],
    ["hex-entity-20", "claude&#x20;code", "the &#x20; hex HTML entity for a plain space"],
    ["ensp-entity", "claude&ensp;code", "the &ensp; HTML entity"],
    ["emsp-entity", "claude&emsp;code", "the &emsp; HTML entity"],
    ["thinsp-entity", "claude&thinsp;code", "the &thinsp; HTML entity"],
    ["decimal-entity-8203", "claude&#8203;code", "the &#8203; decimal entity for a zero-width space"],
    ["escape-x20-text", "claude\\x20code", "the literal four-character \\x20 escape text"],
    ["escape-u-brace-a0-text", "claude\\u{a0}code", "the literal \\u{a0} escape text"],
    ["css-a0-escape", "claude\\a0 code", "the CSS \\a0 hex escape"],
    ["mid-word-combining-mark", "cĺaude code", "a combining mark splitting the word \"claude\" itself"],
  ];

  for (const [slug, content, description] of nbspBypassCases) {
    it(`flags ${description}`, () => {
      const relPath = `apps/agents/bypass2-${slug}.js`;
      const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n", [relPath]: `${content}\n` });
      const allowlist = writeAllowlist(["clean/ok.js", relPath]);
      const result = runCli(["--ship", dir, "--allowlist", allowlist]);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toMatch(new RegExp(`^ship-claude-code-\\w+: ${relPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    });
  }

  it("flags a UTF-16LE-encoded \"Claude Code\" that latin1/utf8 decoding cannot see", () => {
    const relPath = "apps/agents/bypass2-utf16le.js";
    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n" });
    mkdirSync(join(dir, "apps", "agents"), { recursive: true });
    writeFileSync(join(dir, relPath), Buffer.from("claude code\n", "utf16le"));
    const allowlist = writeAllowlist(["clean/ok.js", relPath]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^ship-claude-code-text: apps\/agents\/bypass2-utf16le\.js$/m);
  });

  it("flags a UTF-16BE-encoded \"Claude Code\"", () => {
    const relPath = "apps/agents/bypass2-utf16be.js";
    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n" });
    mkdirSync(join(dir, "apps", "agents"), { recursive: true });
    const le = Buffer.from("claude code\n", "utf16le");
    const be = Buffer.from(le);
    be.swap16();
    writeFileSync(join(dir, relPath), be);
    const allowlist = writeAllowlist(["clean/ok.js", relPath]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^ship-claude-code-text: apps\/agents\/bypass2-utf16be\.js$/m);
  });

  it("still does not flag ordinary unrelated words that happen to contain combining-mark-adjacent bytes", () => {
    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\nconst greeting = 'cafe\\u0301';\n" });
    const allowlist = writeAllowlist(["clean/ok.js"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).toBe(0);
  });

  it("detects a precompressed file by magic bytes regardless of its extension", () => {
    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n" });
    mkdirSync(join(dir, "apps"), { recursive: true });
    // zstd magic bytes, named with no recognizable compressed extension at
    // all -- proves detection is content-based, not extension-based.
    writeFileSync(join(dir, "apps", "bundle.data"), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]));
    const allowlist = writeAllowlist(["clean/ok.js", "apps/bundle.data"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^ship-precompressed-file: apps\/bundle\.data$/m);
  });

  it("does NOT flag a file merely named .gz when its bytes are plain text", () => {
    const dir = writeFixtureDir({
      "clean/ok.js": "console.log('ok');\n",
      "apps/not-really-compressed.gz": "just plain text, not gzip\n",
    });
    const allowlist = writeAllowlist(["clean/ok.js", "apps/not-really-compressed.gz"]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.stdout).not.toMatch(/ship-precompressed-file/);
  });
});

describe("checks.mjs E2b: widened content-rule family the second security re-review probed", () => {
  const cases = [
    ["fxat-48-chars", "const t = 'fxat_" + "a".repeat(48) + "';\n", "content-secret-fxat"],
    ["fxat-with-dashes", "const t = 'fxat_" + "a".repeat(20) + "_" + "b".repeat(28) + "';\n", "content-secret-fxat"],
    ["whsec-16-chars", "const t = 'whsec_" + "a".repeat(16) + "';\n", "content-secret-whsec"],
    ["ghp-utf16le", null, "content-secret-ghp"],
    ["json-password-colon", '{"password": "hunter2hunter2"}\n', "content-secret-assign-colon"],
    ["js-apikey-colon", "const cfg = { apiKey: 'abcdefgh12345678abcd' }\n", "content-secret-assign-colon"],
    ["client-secret-assign", "CLIENT_SECRET=abcdefgh12345678\n", "content-secret-client-secret-assign"],
    ["github-token-assign", "GITHUB_TOKEN=abcdefgh12345678\n", "content-secret-github-token-assign"],
    ["home-other-user", "const p = '/home/alice/.ssh/id_rsa';\n", "content-local-path"],
    ["root-path", "const p = '/root/.aws/credentials';\n", "content-local-path"],
  ];

  for (const [slug, content, rule] of cases) {
    it(`flags ${slug} with rule ${rule}`, () => {
      const relPath = `apps/config/e2b-${slug}.js`;
      const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n" });
      mkdirSync(join(dir, "apps", "config"), { recursive: true });
      if (content === null) {
        // UTF-16LE-encoded content -- can't be expressed as a plain JS
        // string in writeFixtureDir's map, so written directly.
        writeFileSync(join(dir, relPath), Buffer.from("const t = 'ghp_" + "A".repeat(36) + "';\n", "utf16le"));
      } else {
        writeFileSync(join(dir, relPath), content);
      }
      const allowlist = writeAllowlist(["clean/ok.js", relPath]);
      const result = runCli(["--import", dir, "--allowlist", allowlist]);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toMatch(new RegExp(`^${rule}: ${relPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    });
  }
});

describe("checks.mjs --import: does not apply the ship-only Claude Code gate", () => {
  it("does not flag Claude Code text in --import mode", () => {
    const dir = writeFixtureDir({
      "clean/ok.js": "console.log('ok');\n",
      "apps/agents/output1.js": "// Generated with Claude Code\n",
      "apps/agents/output2.js": "claude&nbsp;code trailer\n",
    });
    const allowlist = writeAllowlist(["clean/ok.js", "apps/agents/output1.js", "apps/agents/output2.js"]);
    const result = runCli(["--import", dir, "--allowlist", allowlist]);
    expect(result.stdout).not.toMatch(/ship-claude-code/);
  });
});

// D#37 WS-C2b: PR #114's round-3 milestone run found 11 pre-existing
// `require-trusted-types-for: trusted-types-sink` CSP reports, sourced to
// plain innerHTML/outerHTML/insertAdjacentHTML sinks in exactly four shell
// files (core/modals.js, core/cloud-login.js, core/desktop.js,
// core/taskbar.js). This guards those four files specifically -- not the
// tree generally -- against the sink coming back, in both --import and
// --ship mode. Every fixture here is invented for this test; none of it is
// the real file content (which lives under apps/workspace/shell/core/ and
// is exercised by checks.mjs's own real run against that tree).
describe("checks.mjs WS-C2b: Trusted Types sink guard on the four WS-C shell files", () => {
  const GUARDED_PATHS = ["core/modals.js", "core/cloud-login.js", "core/desktop.js", "core/taskbar.js"];

  it("checkTrustedTypesSink: flags a plain .innerHTML assignment in a guarded file", () => {
    expect(checkTrustedTypesSink(Buffer.from("el.innerHTML = '<b>x</b>';"), "core/modals.js")).toBe(
      "trusted-types-sink",
    );
  });

  it("checkTrustedTypesSink: flags a plain .outerHTML assignment in a guarded file", () => {
    expect(checkTrustedTypesSink(Buffer.from("el.outerHTML = html;"), "core/desktop.js")).toBe("trusted-types-sink");
  });

  it("checkTrustedTypesSink: flags an .insertAdjacentHTML(...) call in a guarded file", () => {
    expect(
      checkTrustedTypesSink(Buffer.from("el.insertAdjacentHTML('beforeend', html);"), "core/taskbar.js"),
    ).toBe("trusted-types-sink");
  });

  // D#37 WS-C2 fix round (needs-fix): the guard above missed the sink
  // command-registry.js's cmdPrintHTML actually used --
  // `new DOMParser().parseFromString(html, 'text/html')` -- because none of
  // these six patterns were in TRUSTED_TYPES_SINK_RE. One fixture per
  // pattern, same style as the four original fixtures above.

  it("checkTrustedTypesSink: flags a DOMParser .parseFromString(...) call in a guarded file", () => {
    expect(
      checkTrustedTypesSink(
        Buffer.from("const parsed = new DOMParser().parseFromString(html, 'text/html');"),
        "core/modals.js",
      ),
    ).toBe("trusted-types-sink");
  });

  it("checkTrustedTypesSink: flags a Range .createContextualFragment(...) call in a guarded file", () => {
    expect(
      checkTrustedTypesSink(Buffer.from("const frag = range.createContextualFragment(html);"), "core/modals.js"),
    ).toBe("trusted-types-sink");
  });

  it("checkTrustedTypesSink: flags a document.write(...) call in a guarded file", () => {
    expect(checkTrustedTypesSink(Buffer.from("document.write(html);"), "core/modals.js")).toBe(
      "trusted-types-sink",
    );
  });

  it("checkTrustedTypesSink: flags a writeln(...) call (e.g. a popup's own document) in a guarded file", () => {
    expect(checkTrustedTypesSink(Buffer.from("popup.document.writeln(html);"), "core/modals.js")).toBe(
      "trusted-types-sink",
    );
  });

  it("checkTrustedTypesSink: flags a .setHTMLUnsafe(...) call in a guarded file", () => {
    expect(checkTrustedTypesSink(Buffer.from("el.setHTMLUnsafe(html);"), "core/modals.js")).toBe(
      "trusted-types-sink",
    );
  });

  it("checkTrustedTypesSink: flags a .parseHTMLUnsafe(...) call in a guarded file", () => {
    expect(checkTrustedTypesSink(Buffer.from("const doc = Document.parseHTMLUnsafe(html);"), "core/modals.js")).toBe(
      "trusted-types-sink",
    );
  });

  it("checkTrustedTypesSink: flags .innerHTML = '' (clearing content is still a sink use)", () => {
    expect(checkTrustedTypesSink(Buffer.from("surface.innerHTML = '';"), "core/desktop.js")).toBe(
      "trusted-types-sink",
    );
  });

  it("checkTrustedTypesSink: does not flag a guarded file with no sink (the fixed shape)", () => {
    const clean = "const el = document.createElement('div');\nel.textContent = 'x';\nparent.replaceChildren(el);\n";
    for (const p of GUARDED_PATHS) {
      expect(checkTrustedTypesSink(Buffer.from(clean), p)).toBeNull();
    }
  });

  it("checkTrustedTypesSink: does not flag a file with the same sink outside the guarded set", () => {
    expect(checkTrustedTypesSink(Buffer.from("el.innerHTML = html;"), "core/other-file.js")).toBeNull();
    expect(checkTrustedTypesSink(Buffer.from("el.innerHTML = html;"), "core/modals.test.js")).toBeNull();
  });

  it("checkTrustedTypesSink: a comment merely mentioning the sink shape does not self-trigger", () => {
    // The real fix round's own files document what they removed and why --
    // this pins that a warning/explanatory comment written in that shape
    // (e.g. "the old x.innerHTML = y sink") can't trip its own guard.
    //
    // D#37 WS-C3: extended with one commented-out line per new sink form
    // (computed-member and script sinks) -- same guarantee, wider set of
    // forms. Comments only: the stripper doesn't track string-literal
    // context (see stripJsComments's own doc comment in rules.mjs), so an
    // "eval(...) inside a *string*" is deliberately not pinned here.
    const commented = [
      "// this used to be: el.innerHTML = html;",
      "/* do not reintroduce el.outerHTML = x here */",
      "// never call el.insertAdjacentHTML(pos, html) in this file",
      "// or the computed form: el['innerHTML'] = html;",
      "// or: el[\"outerHTML\"] = html;",
      "// or: el[`innerHTML`] = html;",
      "// or: el['insertAdjacentHTML'](pos, html);",
      "/* never call eval(html) in this file */",
      "// or: new Function(html); / Function(html);",
      '// or: setTimeout("code", 0); / setInterval(\'code\', 0);',
      "// or: frame.srcdoc = html;",
      "// or: script.src = html;",
      "// or: script.setAttribute('src', html);",
      "const el = document.createElement('div');",
    ].join("\n");
    expect(checkTrustedTypesSink(Buffer.from(commented), "core/modals.js")).toBeNull();
  });

  // D#37 WS-C2 fix round: reads the real shipped file (not a fixture) so
  // this test is tied to the actual bug, not a stand-in for it. Before this
  // fix round, cmdPrintHTML built its output with
  // `new DOMParser().parseFromString(html, 'text/html')` -- itself a
  // Trusted Types sink under require-trusted-types-for 'script', confirmed
  // live via a CSP violation report -- directly under a comment claiming
  // the opposite. With the widened TRUSTED_TYPES_SINK_RE above, this
  // assertion fails against that unfixed content (the guard now finds the
  // sink); it only passes once cmdPrintHTML stops parsing the string.
  it("checkTrustedTypesSink: the real command-registry.js has no Trusted Types sink", () => {
    const src = readFileSync(join(TEST_DIR, "..", "shell", "core", "command-registry.js"));
    expect(checkTrustedTypesSink(src, "core/command-registry.js")).toBeNull();
  });

  it("end to end --import: flags all four guarded files, and not a fifth unguarded file with the same sink", () => {
    const files = {
      "clean/ok.js": "console.log('ok');\n",
      "core/modals.js": "modalEl.innerHTML = html;\n",
      "core/cloud-login.js": "screen.innerHTML = `<form></form>`;\n",
      "core/desktop.js": "el.outerHTML = markup;\n",
      "core/taskbar.js": "popup.insertAdjacentHTML('beforeend', html);\n",
      "core/unrelated.js": "el.innerHTML = html;\n",
    };
    const dir = writeFixtureDir(files);
    const allowlist = writeAllowlist(Object.keys(files));
    const result = runCli(["--import", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    for (const p of GUARDED_PATHS) {
      expect(result.stdout).toMatch(new RegExp(`^trusted-types-sink: ${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    }
    expect(result.stdout).not.toMatch(/^trusted-types-sink: core\/unrelated\.js$/m);
  });

  it("end to end --ship: same guard applies to the dist/ tree (relative paths match)", () => {
    const files = {
      "clean/ok.js": "console.log('ok');\n",
      "core/modals.js": "modalEl.innerHTML = html;\n",
    };
    const dir = writeFixtureDir(files);
    const allowlist = writeAllowlist(Object.keys(files));
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^trusted-types-sink: core\/modals\.js$/m);
  });

  it("end to end: a clean tree with the fixed (DOM-construction) shape in all four guarded files passes", () => {
    const clean =
      "const el = document.createElement('div');\nel.textContent = 'x';\nparent.replaceChildren(el);\n";
    const files = { "clean/ok.js": "console.log('ok');\n" };
    for (const p of GUARDED_PATHS) files[p] = clean;
    const dir = writeFixtureDir(files);
    const allowlist = writeAllowlist(Object.keys(files));
    const result = runCli(["--import", dir, "--allowlist", allowlist]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/passed/);
  });
});

// D#37 Correction C16 (discussioncomment 18603506), task WS-C3: the six
// dotted-member forms TRUSTED_TYPES_SINK_RE already covered (WS-C2/WS-C2b
// above) miss a computed-member sink (`el['innerHTML'] = x`, any of
// '/"/` as the bracketed key's quote) and every script sink. One
// failing-first fixture per new form below: each was NOT flagged by
// TRUSTED_TYPES_SINK_RE on origin/main (8ac2f1c) before this change, and is
// flagged after it -- see the PR description for that before/after run.
// Negative fixtures pin the exact false-positive boundaries C16 calls out
// by name, so tightening never regresses into re-widening.
describe("checks.mjs WS-C3: Trusted Types sink guard widened to computed-member and script sinks", () => {
  it("checkTrustedTypesSink: flags a computed-member ['innerHTML'] assignment (single-quoted)", () => {
    expect(checkTrustedTypesSink(Buffer.from("el['innerHTML'] = x;"), "core/modals.js")).toBe("trusted-types-sink");
  });

  it('checkTrustedTypesSink: flags a computed-member ["outerHTML"] assignment (double-quoted)', () => {
    expect(checkTrustedTypesSink(Buffer.from('el["outerHTML"] = x;'), "core/modals.js")).toBe("trusted-types-sink");
  });

  it("checkTrustedTypesSink: flags a computed-member [`innerHTML`] assignment (template-literal key)", () => {
    expect(checkTrustedTypesSink(Buffer.from("el[`innerHTML`] = x;"), "core/modals.js")).toBe("trusted-types-sink");
  });

  it("checkTrustedTypesSink: flags a computed-member ['insertAdjacentHTML'](...) call", () => {
    expect(checkTrustedTypesSink(Buffer.from("el['insertAdjacentHTML'](p, x);"), "core/modals.js")).toBe(
      "trusted-types-sink",
    );
  });

  it("checkTrustedTypesSink: flags eval(...)", () => {
    expect(checkTrustedTypesSink(Buffer.from("eval(x);"), "core/modals.js")).toBe("trusted-types-sink");
  });

  it("checkTrustedTypesSink: flags new Function(...)", () => {
    expect(checkTrustedTypesSink(Buffer.from("const f = new Function(x);"), "core/modals.js")).toBe(
      "trusted-types-sink",
    );
  });

  it("checkTrustedTypesSink: flags bare Function(...)", () => {
    expect(checkTrustedTypesSink(Buffer.from("const f = Function(x);"), "core/modals.js")).toBe("trusted-types-sink");
  });

  it("checkTrustedTypesSink: flags setTimeout(...) called with a string-literal first argument", () => {
    expect(checkTrustedTypesSink(Buffer.from('setTimeout("code", 0);'), "core/modals.js")).toBe("trusted-types-sink");
  });

  it("checkTrustedTypesSink: flags setInterval(...) called with a string-literal first argument", () => {
    expect(checkTrustedTypesSink(Buffer.from("setInterval('code', 0);"), "core/modals.js")).toBe(
      "trusted-types-sink",
    );
  });

  it("checkTrustedTypesSink: flags a .srcdoc assignment", () => {
    expect(checkTrustedTypesSink(Buffer.from("frame.srcdoc = x;"), "core/modals.js")).toBe("trusted-types-sink");
  });

  it("checkTrustedTypesSink: flags script.src assignment (receiver literally named script)", () => {
    expect(checkTrustedTypesSink(Buffer.from("script.src = x;"), "core/modals.js")).toBe("trusted-types-sink");
  });

  // D#37 Correction C17a / WS-C4 criterion 7: the WS-C3 review on #147
  // found a real gap in C16b's own pass/fail list -- its prose named
  // setAttribute('src', ...) but the shipped list only covered
  // `script.src = x`. These two fixtures failed against
  // TRUSTED_TYPES_SINK_RE on main (8ac2f1c) before this change, and pass
  // on the branch.
  it("checkTrustedTypesSink: flags script.setAttribute('src', x) (single-quoted)", () => {
    expect(checkTrustedTypesSink(Buffer.from("script.setAttribute('src', x);"), "core/modals.js")).toBe(
      "trusted-types-sink",
    );
  });

  it('checkTrustedTypesSink: flags script.setAttribute("src", x) (double-quoted)', () => {
    expect(checkTrustedTypesSink(Buffer.from('script.setAttribute("src", x);'), "core/modals.js")).toBe(
      "trusted-types-sink",
    );
  });

  // --- Negative fixtures: the exact false-positive boundaries C16 names ---

  it("checkTrustedTypesSink: does not flag el['innerHTML'] === x (a comparison, not an assignment)", () => {
    expect(checkTrustedTypesSink(Buffer.from("if (el['innerHTML'] === x) {}"), "core/modals.js")).toBeNull();
  });

  it("checkTrustedTypesSink: does not flag setTimeout(fn, 0) (a function argument, not a string)", () => {
    expect(checkTrustedTypesSink(Buffer.from("setTimeout(fn, 0);"), "core/modals.js")).toBeNull();
  });

  it("checkTrustedTypesSink: does not flag img.src = x (receiver is not named script)", () => {
    expect(checkTrustedTypesSink(Buffer.from("img.src = x;"), "core/modals.js")).toBeNull();
  });

  it("checkTrustedTypesSink: does not flag img.setAttribute('src', x) (receiver is not named script)", () => {
    expect(checkTrustedTypesSink(Buffer.from("img.setAttribute('src', x);"), "core/modals.js")).toBeNull();
  });

  it("checkTrustedTypesSink: does not flag script.setAttribute('type', x) (attribute is not src)", () => {
    expect(checkTrustedTypesSink(Buffer.from("script.setAttribute('type', x);"), "core/modals.js")).toBeNull();
  });

  // WS-C3 pass/fail item 4: run the widened guard over the real guarded
  // files' actual content (not an invented fixture). All six must stay
  // clean -- none of the newly covered forms appear in them. If a real hit
  // ever shows up here, this assertion fails and the fix belongs to a
  // different task: "Rewriting shell code is outside this task's files."
  it("checkTrustedTypesSink: all six real guarded shell files remain clean under the widened guard", () => {
    for (const relPath of TRUSTED_TYPES_SINK_GUARDED_FILES) {
      const src = readFileSync(join(TEST_DIR, "..", "shell", relPath));
      expect(checkTrustedTypesSink(src, relPath)).toBeNull();
    }
  });
});

describe("checks.mjs: usage", () => {
  it("refuses with a usage message when neither --import nor --ship is given", () => {
    const result = runCli([]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/usage/i);
  });
});

// Security re-review 2 (needs-fix): the widened E2b rules caught every real
// secret the review reported, but also refused 18 of 18 benign fixtures it
// pushed through runImport, plus 55 of 2,400 files in a public JS/CSS/HTML
// corpus, plus a 150KB base64 blob about 3-4% of the time -- with a
// whole-import refusal on any single hit, that false-positive rate would
// have blocked the real WS-A2 import outright. This section measures the
// tightened rules (rules.mjs's CONTENT_RULES) against the reviewer's own
// true-positive set, benign set, and a random-blob set, all built fresh
// here -- nothing is read from the private source checkout or /nix/store.
describe("security re-review 2, MUST fix: tightened content rules still catch every true positive", () => {
  const truePositives = [
    ["AKIA", "AKIA" + "ABCDEFGHIJ234567", "content-secret-akia"],
    ["ASIA", "ASIA" + "ABCDEFGHIJ234567", "content-secret-asia"],
    ["AIza", "AIza" + "A".repeat(35), "content-secret-aiza"],
    ["DB_PASSWORD=", "DB_PASSWORD=hunter2hunter2", "content-secret-password-assign"],
    ["OPENAI_API_KEY=", "OPENAI_API_KEY=abcdefgh12345678", "content-secret-api-key-assign"],
    ["json password colon", '{"password": "hunter2hunter2"}', "content-secret-assign-colon"],
    ["js apiKey colon", "const cfg = { apiKey: 'abcdefgh12345678abcd' }", "content-secret-assign-colon"],
    ["js token= literal", 'this.token = "fxat0123456789abcdef";', "content-secret-assign-colon"],
    ["yaml secret:", "secret: 'Zm9vYmFyYmF6cXV4MTIz'", "content-secret-assign-colon"],
    ["CLIENT_SECRET=", "CLIENT_SECRET=abcdefgh12345678", "content-secret-client-secret-assign"],
    ["GITHUB_TOKEN=", "GITHUB_TOKEN=abcdefgh12345678", "content-secret-github-token-assign"],
    ["/home/alice/x", "const p = '/home/alice/x';", "content-local-path"],
    ["/home/alice/.ssh", "const p = '/home/alice/.ssh/id';", "content-local-path"],
    ["/home/<other user>/<dir>", "const p = '/home/alice/project/x';", "content-local-path"],
    ["/root/.aws","const p = '/root/.aws/credentials';", "content-local-path"],
  ];

  for (const [slug, content, rule] of truePositives) {
    it(`still flags ${slug} with rule ${rule}`, () => {
      const hits = checkContent(Buffer.from(content));
      expect(hits).toContain(rule);
    });
  }

  it("a private key block is still flagged", () => {
    expect(checkContent(Buffer.from("-----BEGIN PRIVATE KEY-----"))).toContain("content-secret-pem-begin");
  });

  it("end to end: every true positive above also refuses the whole --import", () => {
    const files = Object.fromEntries(truePositives.map(([slug, content], i) => [`apps/tp-${i}-${slug.replace(/[^a-z0-9]+/gi, "-")}.js`, content + "\n"]));
    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n", ...files });
    const allowlist = writeAllowlist(["clean/ok.js", ...Object.keys(files)]);
    const result = runCli(["--import", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    for (const [, , rule] of truePositives) {
      expect(result.stdout).toMatch(new RegExp(`^${rule}: `, "m"));
    }
  });
});

describe("security re-review 2, MUST fix: tightened content rules no longer refuse benign code (regression)", () => {
  // The exact benign fixtures the review measured the fix against, plus the
  // ones D#37's own acceptance criteria names explicitly. Every one of
  // these is allowlisted and expected to import cleanly.
  const benignFiles = {
    "index.html": '<label for="pw">Password:</label> <input id="pw" type="password">',
    "sdk/client.js": "this.baseUrl = baseUrl;\n    this.token = token;",
    "style.css": ".password:focus{outline:2px solid var(--accent)}.token:hover{x:y}",
    "app/state.js": 'const initial={username:"",password:"",remember:!1};',
    "core/fs.js": 'export const HOME = "/home/user/";',
    "core/fs-standins.js": 'export const A = "/home/user/file.txt", B = "/home/apps/list", C = "/home/me/";',
    "app/api.js": "const url = `${BASE}/data?q=${city}&api_key=${key}`;",
    "app/regions.js": '["EUROPE", "ASIA", "AMERICAS"]',
    "assets/font.css": ".x{src:url(data:font/woff2;base64,d09GMgABAAAAAAOoAA4AAAAAAlwAAAA=)}",
  };

  for (const [relPath, content] of Object.entries(benignFiles)) {
    it(`does not flag ${relPath}`, () => {
      const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n", [relPath]: content });
      const allowlist = writeAllowlist(["clean/ok.js", relPath]);
      const result = runCli(["--import", dir, "--allowlist", allowlist]);
      expect(result.code).toBe(0);
    });
  }

  it("end to end: an import made entirely of the benign fixtures above passes cleanly", () => {
    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n", ...benignFiles });
    const allowlist = writeAllowlist(["clean/ok.js", ...Object.keys(benignFiles)]);
    const result = runCli(["--import", dir, "--allowlist", allowlist]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/passed/);
  });

  it("a public-key/certificate BEGIN block is not flagged (only a private-key block is)", () => {
    expect(checkContent(Buffer.from("-----BEGIN CERTIFICATE-----"))).toEqual([]);
    expect(checkContent(Buffer.from("-----BEGIN PUBLIC KEY-----"))).toEqual([]);
  });

  it("a path named like a runtime/env file, not a real dotfile, is unaffected by the content rules", () => {
    // pathIsSecretShaped's own bare "env." substring is a separate, known,
    // documented minor finding (not required by D#37's acceptance
    // criteria) -- this only asserts the CONTENT rules stay quiet.
    expect(checkContent(Buffer.from("export function readEnv() { return process.env.NODE_ENV; }"))).toEqual([]);
  });
});

describe("security re-review 2, MUST fix: 0 of 300 random base64/binary blobs refused", () => {
  // A small, seeded PRNG so this is a deterministic regression test, not a
  // flaky one -- mulberry32, a standard 32-bit generator with a fixed seed.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomBytes(n, rand) {
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = Math.floor(rand() * 256);
    return buf;
  }

  it("0 of 300 random 112KB-base64-encoded blobs trip a content rule", () => {
    const rand = mulberry32(0xc0ffee);
    let refused = 0;
    const offenders = [];
    for (let i = 0; i < 300; i++) {
      const blob = randomBytes(112_000, rand).toString("base64");
      const hits = checkContent(Buffer.from(blob));
      if (hits.length) {
        refused++;
        offenders.push([i, hits]);
      }
    }
    expect({ refused, offenders: offenders.slice(0, 5) }).toEqual({ refused: 0, offenders: [] });
  });

  it("0 of 300 random 100KB binary blobs trip a content rule", () => {
    const rand = mulberry32(0xdeadbeef);
    let refused = 0;
    for (let i = 0; i < 300; i++) {
      const blob = randomBytes(100_000, rand);
      if (checkContent(blob).length) refused++;
    }
    expect(refused).toBe(0);
  });
});

// Security re-review 2, SHOULD fix (E4c): the --ship precompressed check
// regressed from checking extension AND magic bytes (b0f11f6) to magic
// bytes only (5e86c4a) -- brotli has no magic number at all, and neither
// does raw deflate, so both slipped through as if they were plaintext.
describe("security re-review 2, SHOULD fix E4c: precompressed detection checks extension AND magic bytes", () => {
  const secretBody = Buffer.from(`const brand = "Claude Code"; const t = "ghp_${"A".repeat(36)}";\n`.repeat(4));

  it("isPrecompressed: brotli is detected by extension (it has no magic number)", () => {
    const brotli = zlib.brotliCompressSync(secretBody);
    expect(isPrecompressed(brotli, "dist/core/app.js.br")).toBe(true);
  });

  it("isPrecompressed: a zlib stream (.zz) is detected by its magic bytes", () => {
    const zz = zlib.deflateSync(secretBody);
    expect(isPrecompressed(zz, "dist/core/app.js.zz")).toBe(true);
  });

  it("isPrecompressed: raw deflate (.deflate) is detected by extension (it has no magic number)", () => {
    const raw = zlib.deflateRawSync(secretBody);
    expect(isPrecompressed(raw, "dist/core/app.js.deflate")).toBe(true);
  });

  it("isPrecompressed: still does not flag a plaintext file merely named .gz (no false positive from the extension check)", () => {
    expect(isPrecompressed(Buffer.from("just plain text, not gzip\n"), "dist/not-really-compressed.gz")).toBe(false);
  });

  it("end to end: a --ship tree whose only copies are .br, .zz and .deflate is refused, not silently passed", () => {
    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n" });
    mkdirSync(join(dir, "dist", "core"), { recursive: true });
    writeFileSync(join(dir, "dist", "core", "app.js.br"), zlib.brotliCompressSync(secretBody));
    writeFileSync(join(dir, "dist", "core", "app.js.zz"), zlib.deflateSync(secretBody));
    writeFileSync(join(dir, "dist", "core", "app.js.deflate"), zlib.deflateRawSync(secretBody));
    const allowlist = writeAllowlist(["clean/ok.js", "dist/core/app.js.br", "dist/core/app.js.zz", "dist/core/app.js.deflate"]);
    const result = runCli(["--ship", join(dir, "dist"), "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^ship-precompressed-file: core\/app\.js\.br$/m);
    expect(result.stdout).toMatch(/^ship-precompressed-file: core\/app\.js\.zz$/m);
    expect(result.stdout).toMatch(/^ship-precompressed-file: core\/app\.js\.deflate$/m);
  });
});

// Security re-review 2, SHOULD fix (E4c): the name gate enumerated one
// separator form at a time across three rounds and still missed 46 of 54
// new forms the review's third pass tried (entities without a trailing
// ";", the long MathML-style entity names, JS escape TEXT for \t/\n/\x09,
// and four raw code points outside \s/\p{M}/\p{Cf}). rules.mjs now decodes
// known entity/escape forms to their real character FIRST and matches once
// against the normalized result, instead of adding another alternative.
describe("security re-review 2, SHOULD fix E4c: the name gate decodes before matching, closing the missed separator forms", () => {
  // NOTE: the reviewer found that typing a 4-hex escape sequence directly
  // into a file turns it into the real character before it's ever written.
  // Every backslash-escape form below is built at runtime from BS (see top
  // of file) for exactly that reason -- these are never typed literally.
  const decodeCases = [
    ["backslash-u0020 escape text", "Claude" + BS + "u0020" + "Code"],
    ["backslash-u2002 escape text", "Claude" + BS + "u2002" + "Code"],
    ["backslash-u{20} escape text", "Claude" + BS + "u{20}" + "Code"],
    ["backslash-x09 escape text", "Claude" + BS + "x09" + "Code"],
    ["backslash-t escape text", "Claude" + BS + "t" + "Code"],
    ["backslash-n escape text", "Claude" + BS + "n" + "Code"],
    ["CSS \\20 escape", "Claude" + BS + "20 " + "Code"],
    ["CSS \\00a0 escape (leading zeros)", "Claude" + BS + "00a0 " + "Code"],
    ["&nbsp without a semicolon", "Claude&nbspCode"],
    ["&#160 without a semicolon", "Claude&#160Code"],
    ["&#xa0 without a semicolon", "Claude&#xa0Code"],
    ["&#x200b;", "Claude&#x200b;Code"],
    ["&ZeroWidthSpace;", "Claude&ZeroWidthSpace;Code"],
    ["&NoBreak;", "Claude&NoBreak;Code"],
    ["&hairsp;", "Claude&hairsp;Code"],
    ["&numsp;", "Claude&numsp;Code"],
    ["&Tab;", "Claude&Tab;Code"],
    ["&NewLine;", "Claude&NewLine;Code"],
    ["&#9;", "Claude&#9;Code"],
    ["&#10;", "Claude&#10;Code"],
    ["&#8194; (ensp numeric)", "Claude&#8194;Code"],
    ["&#x2009;", "Claude&#x2009;Code"],
    ["&#173; + space", "Claude&#173; Code"],
    ["U+115F Hangul choseong filler", "Claude" + String.fromCodePoint(0x115f) + "Code"],
    ["U+3164 Hangul filler", "Claude" + String.fromCodePoint(0x3164) + "Code"],
    ["U+FFA0 halfwidth Hangul filler", "Claude" + String.fromCodePoint(0xffa0) + "Code"],
    ["U+2800 braille pattern blank", "Claude" + String.fromCodePoint(0x2800) + "Code"],
  ];

  for (const [description, content] of decodeCases) {
    it(`flags ${description}`, () => {
      const hits = checkShipClaudeCode(Buffer.from(content, "utf8"));
      expect(hits.length).toBeGreaterThan(0);
    });
  }

  it("end to end: a --ship file using the backslash-u0020 escape text form is refused", () => {
    const relPath = "apps/agents/bypass3-backslash-u0020.js";
    const content = "const banner = 'Claude" + BS + "u0020Code';\n";
    const dir = writeFixtureDir({ "clean/ok.js": "console.log('ok');\n", [relPath]: content });
    const allowlist = writeAllowlist(["clean/ok.js", relPath]);
    const result = runCli(["--ship", dir, "--allowlist", allowlist]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(new RegExp(`^ship-claude-code-\\w+: ${relPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  });

  it("still does not flag ordinary unrelated words that contain an unrelated escape-text-looking substring", () => {
    // "cafe" + a literal, unparsed ́ escape text -- nothing to do with
    // "claude"/"code" either before or after decoding.
    const content = "const greeting = 'cafe" + BS + "u0301';\n";
    expect(checkShipClaudeCode(Buffer.from(content))).toEqual([]);
  });
});

// Security re-review 2, SHOULD fix (R1, CWE-1333): NBSP_LIKE_SEPARATOR's
// CSS-escape alternative used to let "\a0 " (backslash, a, 0, space) match
// two different ways inside the surrounding (?:...)+ group, which made the
// name gate hang for over 30 seconds on a 192-byte adversarial CSS file.
describe("security re-review 2, SHOULD fix R1: no exponential backtracking in the name gate", () => {
  it("a 192-byte adversarial CSS-escape run completes in well under 100ms", () => {
    const input = Buffer.from("claude" + (BS + "a0 ").repeat(46) + "x");
    expect(input.length).toBeLessThan(220);
    const t0 = process.hrtime.bigint();
    checkShipClaudeCode(input);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms).toBeLessThan(100);
  });

  it("a 1MB adversarial CSS-escape run scales linearly with its size (no super-linear backtracking)", () => {
    // A wall-clock ceiling on the 1MB input measures the machine as much as the regex: a loaded runner took 1.1 s
    // for a linear scan. What matters is how the time GROWS. Quadrupling the input must roughly quadruple the
    // time (linear ~4x); a quadratic engine would take ~16x and an exponential one would not finish at all.
    // Each size is timed nine times, small and large alternating so a load burst lands on both, and the best of each
    // is compared: a scheduling stall inflates a run, it cannot make one faster, so the best run is the least
    // disturbed one. (Best-of-three still read 11.4x against the limit of 10 on a machine at load 24-30.)
    const inputOf = (repeats) => Buffer.from("claude" + (BS + "a0 ").repeat(repeats) + "x");
    const timeOnce = (input) => {
      const t0 = process.hrtime.bigint();
      checkShipClaudeCode(input);
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    const smallInput = inputOf(65_000);
    const largeInput = inputOf(260_000);
    expect(largeInput.length).toBeGreaterThan(1_000_000);
    let small = Infinity;
    let large = Infinity;
    for (let i = 0; i < 9; i++) {
      small = Math.min(small, timeOnce(smallInput));
      large = Math.min(large, timeOnce(largeInput));
    }
    expect(large / Math.max(small, 1)).toBeLessThan(10);
  }, 30_000); // 18 timed runs: about 1.4 s unloaded, several times that on a loaded machine; the default is 5 s

  it("end to end: --ship on the same adversarial CSS file returns promptly, not a hang", () => {
    const dir = writeFixtureDir({
      "clean/ok.js": "console.log('ok');\n",
      "apps/style.css": "claude" + (BS + "a0 ").repeat(46) + "x",
    });
    const allowlist = writeAllowlist(["clean/ok.js", "apps/style.css"]);
    const t0 = process.hrtime.bigint();
    runCli(["--ship", dir, "--allowlist", allowlist]);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms).toBeLessThan(5000);
  });
});

describe("checks.mjs --ship: D#37 C34 section 1 (WS-F5p), the Model Key password-input exemption", () => {
  const PW = 'export const f = { type: "password" };\n';
  const allowlist = () => writeAllowlist(["core/none.js"]);

  it("passes at the exempt path with --first-party-prefix apps/model-key/", () => {
    const dir = writeFixtureDir({ "apps/model-key/model-key-app.js": PW });
    const result = runCli(["--ship", dir, "--allowlist", allowlist(), "--first-party-prefix", "apps/model-key/"]);
    expect(result.stdout).not.toMatch(/ship-forbidden-password-input/);
    expect(result.code).toBe(0);
  });

  it("fails without the prefix argument", () => {
    const dir = writeFixtureDir({ "apps/model-key/model-key-app.js": PW });
    const result = runCli(["--ship", dir, "--allowlist", allowlist()]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^ship-forbidden-password-input: apps\/model-key\/model-key-app\.js$/m);
  });

  it("fails for a sibling first-party file", () => {
    const dir = writeFixtureDir({ "apps/model-key/other.js": PW });
    const result = runCli(["--ship", dir, "--allowlist", allowlist(), "--first-party-prefix", "apps/model-key/"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/^ship-forbidden-password-input: apps\/model-key\/other\.js$/m);
  });
});
