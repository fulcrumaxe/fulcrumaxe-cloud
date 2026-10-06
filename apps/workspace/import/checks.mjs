#!/usr/bin/env node
// apps/workspace/import/checks.mjs
//
// D#37 WS-A1: the build-failing security checks. Two modes:
//
//   --import <dir>  the freshly-imported tree (apps/workspace/shell): must
//                    contain nothing but allowlisted files, no dotfiles or
//                    obvious secret paths/content, and no vendor code we
//                    excluded on purpose.
//   --ship <dir>     the build output, every file of every type: all
//                    --import rules, plus the "Claude Code" string gate.
//
// Exits 0 with no output when clean. Exits non-zero and lists every
// offending path and the rule it tripped when not. Reads no environment
// (Node 22 built-ins only, no npm runtime dependency).
//
// The path and content rules live in rules.mjs, shared with import.mjs's
// pre-write refusal (security review finding E2): the two can no longer
// drift apart from each other.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAllowlist, isAllowlisted } from "./import.mjs";
import {
  pathIsSecretShaped,
  checkContent,
  checkShipClaudeCode,
  checkShipForbiddenSignin,
  checkShipForbiddenBranding,
  isPrecompressed,
  checkTrustedTypesSink,
  ACTIVATION_PATH_RE,
  checkShipNoLicenseActivation,
  checkShipNoSubscriptionBypass,
  TRUSTED_TYPES_SINK_RE,
} from "./rules.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ALLOWLIST_PATH = join(SCRIPT_DIR, "allowlist.txt");

// Rule: vendor code we deliberately never ship.
const VENDOR_MONACO_RE = /(^|\/)vendor\/monaco(\/|$)/;
const VENDOR_XTERM_RE = /(^|\/)vendor\/xterm(\/|$)/;

// D#37 C24 / WS-F0: the only shapes --first-party-prefix accepts.
const FIRST_PARTY_PREFIX_RE = /^apps\/(?:[a-z][a-z0-9-]{0,31}|_[a-z0-9][a-z0-9_-]{0,30})\/$/;

// D#37 C24 / WS-F0 fix round 1: a remote module import in first-party output,
// static (`import "https://..."`, `from "//host/x.js"`) or dynamic
// (`import("https://...")`). Matched on the raw text, not comment-stripped:
// stripJsComments would eat everything after the "//" inside the URL itself.
const FIRST_PARTY_URL_IMPORT_RE = /\b(?:from|import)\s*\(?\s*(['"`])(?:https?:)?\/\//i;

// E3 (security review): readdirSync's Dirent only reports isDirectory() or
// isFile() true for the two ordinary types. A symlink (to a file OR a
// directory), FIFO, socket, or device is neither, so the old walk silently
// skipped it -- a synthetic probe pointed dist/core/link.js and
// dist/core/linkdir/ at outside paths carrying the product-name string, a
// GitHub-token prefix, and a PEM header, and neither --ship nor --import
// reported anything. Every non-regular, non-directory entry is now
// collected and flagged as a violation in BOTH modes, instead of being
// silently descended into (a symlinked directory) or silently ignored (a
// symlinked file).
function walkTree(dir, base = dir, files = [], nonRegular = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const relPath = relative(base, abs).split(sep).join("/");
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      nonRegular.push(relPath);
    } else if (entry.isDirectory()) {
      walkTree(abs, base, files, nonRegular);
    } else {
      files.push({ abs, relPath });
    }
  }
  return { files, nonRegular };
}

function loadAddedSet(buildInfoPath) {
  if (!buildInfoPath || !existsSync(buildInfoPath)) return new Set();
  try {
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8"));
    return new Set(buildInfo.added || []);
  } catch {
    return new Set();
  }
}

/**
 * @param {string} dir
 * @param {{ mode: "import" | "ship", allowlistPatterns: ReturnType<typeof loadAllowlist>, addedSet: Set<string> }} opts
 * @returns {Array<{ rule: string, path: string }>}
 */
export function checkTree(dir, opts) {
  const { mode, allowlistPatterns, addedSet, firstPartyPrefixes = [] } = opts;
  const violations = [];

  const { files, nonRegular } = walkTree(dir);

  for (const relPath of nonRegular) {
    violations.push({ rule: "non-regular-file", path: relPath });
  }

  for (const { abs, relPath } of files) {
    if (pathIsSecretShaped(relPath)) {
      violations.push({ rule: "path-dotfile-or-secret", path: relPath });
    }
    // D#37 C24 / WS-F0 criterion 7: first-party app output (compiled from
    // apps/workspace/apps/, never imported) is admitted by its own
    // extension allowlist -- .js and .css under a prefix build.mjs named --
    // instead of allowlist.txt, which stays anchored to the jpos tar. Every
    // other rule in this loop still runs over these files.
    const inFirstParty = mode === "ship" && firstPartyPrefixes.some((p) => relPath.startsWith(p));
    const firstPartyOk = inFirstParty && /\.(?:js|css)$/.test(relPath);
    if (!firstPartyOk && !isAllowlisted(allowlistPatterns, relPath) && !addedSet.has(relPath)) {
      violations.push({ rule: "not-allowlisted", path: relPath });
    }
    if (VENDOR_MONACO_RE.test(relPath)) {
      violations.push({ rule: "path-vendor-monaco", path: relPath });
    }
    if (VENDOR_XTERM_RE.test(relPath)) {
      violations.push({ rule: "path-vendor-xterm", path: relPath });
    }
    if (relPath.includes("automerge")) {
      violations.push({ rule: "path-automerge", path: relPath });
    }
    // D#37 WS-L1 (correction C19c criterion 2): --ship only -- --import
    // still allows apps/activation/** (C19e item 9: "the source files
    // under apps/activation/ stay in the fork as imported ... They are
    // filtered out of dist/ and are not deleted").
    if (mode === "ship" && ACTIVATION_PATH_RE.test(relPath)) {
      violations.push({ rule: "path-activation-shipped", path: relPath });
    }

    const content = readFileSync(abs);

    // E4c: detected by magic bytes OR extension -- brotli and raw deflate
    // have no magic number at all, so a rename can't evade the extension
    // half, and every format with a real magic number is still caught
    // regardless of its extension (unchanged from E4b).
    if (mode === "ship" && isPrecompressed(content, relPath)) {
      // E4: a precompressed file's bytes are never plaintext, so every
      // content rule below is blind to it -- refuse it outright instead of
      // scanning garbled bytes that will never match.
      violations.push({ rule: "ship-precompressed-file", path: relPath });
      continue;
    }

    for (const rule of checkContent(content)) {
      violations.push({ rule, path: relPath });
    }
    if (mode === "ship") {
      for (const rule of checkShipClaudeCode(content)) {
        violations.push({ rule, path: relPath });
      }
      // D#37 WS-C2 criterion 9.
      for (const rule of checkShipForbiddenSignin(content, { relPath, firstParty: inFirstParty })) {
        violations.push({ rule, path: relPath });
      }
      // D#37 Correction C19d / WS-B1 criterion 5.
      for (const rule of checkShipForbiddenBranding(content)) {
        violations.push({ rule, path: relPath });
      }
      // D#37 WS-L1 (correction C19c criteria 2 and 8): "a shipped .js
      // file" -- scoped to .js the same way the criterion is worded, so
      // an unrelated HTML comment or markup string (e.g. documenting why
      // the activation tags below stay filtered) never trips it.
      if (relPath.endsWith(".js")) {
        for (const rule of checkShipNoLicenseActivation(content)) {
          violations.push({ rule, path: relPath });
        }
        for (const rule of checkShipNoSubscriptionBypass(content)) {
          violations.push({ rule, path: relPath });
        }
      }
    }
    // WS-F0 fix round 1 (security SHOULD-2): first-party code is held to the
    // Trusted Types sink regex the guarded shell files are (innerHTML,
    // insertAdjacentHTML, eval, Function(...), ...) and may not import a
    // remote module. Unlike the guarded-file check below, the sink regex runs
    // on the RAW text: the comment stripper is not string-aware, so a `"//"`
    // literal earlier on a line would hide a sink after it, and this code is
    // not the reviewed shell source that stripper was written for. A comment
    // that spells a sink out therefore trips it too; reword the comment.
    if (inFirstParty && relPath.endsWith(".js")) {
      const text = content.toString("utf8");
      if (TRUSTED_TYPES_SINK_RE.test(text)) {
        violations.push({ rule: "first-party-trusted-types-sink", path: relPath });
      }
      if (FIRST_PARTY_URL_IMPORT_RE.test(text)) {
        violations.push({ rule: "first-party-remote-import", path: relPath });
      }
    }
    // D#37 WS-C2b: runs in both modes -- the guarded files live at the same
    // relative path under shell/ (--import) and dist/ (--ship), and a
    // reintroduced sink is worth catching as early as --import.
    const ttSinkRule = checkTrustedTypesSink(content, relPath);
    if (ttSinkRule) {
      violations.push({ rule: ttSinkRule, path: relPath });
    }
  }

  return violations;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);

  let mode;
  let dir;
  if (typeof args.import === "string") {
    mode = "import";
    dir = args.import;
  } else if (typeof args.ship === "string") {
    mode = "ship";
    dir = args.ship;
  } else {
    console.error("checks.mjs: usage: checks.mjs --import <dir> | --ship <dir> [--allowlist <path>] [--build-info <path>] [--first-party-prefix apps/<id>/,...]");
    return 1;
  }

  const allowlistPath = typeof args.allowlist === "string" ? args.allowlist : DEFAULT_ALLOWLIST_PATH;
  const buildInfoPath =
    typeof args["build-info"] === "string" ? args["build-info"] : join(dirname(dir), "BUILD-INFO.json");

  const allowlistPatterns = loadAllowlist(allowlistPath);
  const addedSet = loadAddedSet(buildInfoPath);

  let firstPartyPrefixes = [];
  if (typeof args["first-party-prefix"] === "string") {
    firstPartyPrefixes = args["first-party-prefix"].split(",");
    // One directory of one app or library, never a wider tree: "apps/"
    // itself (or "") would admit every file under apps/ without allowlisting.
    const bad = firstPartyPrefixes.filter((p) => !FIRST_PARTY_PREFIX_RE.test(p));
    if (bad.length > 0) {
      console.error(`checks.mjs: refusing --first-party-prefix ${JSON.stringify(bad)} (want apps/<id>/ or apps/_<lib>/)`);
      return 1;
    }
    // ... and never a directory the imported tree owns: allowlist.txt (or the
    // build-info additions) already names files there, so a prefix over it
    // would let an unlisted, unreviewed file ride in beside them.
    const owned = firstPartyPrefixes.filter(
      (p) =>
        allowlistPatterns.some((a) => a.raw.startsWith(p)) ||
        isAllowlisted(allowlistPatterns, `${p}probe.js`) ||
        isAllowlisted(allowlistPatterns, `${p}probe.css`) ||
        [...addedSet].some((a) => a.startsWith(p))
    );
    if (owned.length > 0) {
      console.error(`checks.mjs: refusing --first-party-prefix ${JSON.stringify(owned)}: the imported tree owns that directory`);
      return 1;
    }
  }

  const violations = checkTree(dir, { mode, allowlistPatterns, addedSet, firstPartyPrefixes });

  if (violations.length === 0) {
    console.log(`checks.mjs: --${mode} check passed (0 violations)`);
    return 0;
  }

  for (const v of violations) {
    console.log(`${v.rule}: ${v.path}`);
  }
  console.error(`checks.mjs: --${mode} check failed (${violations.length} violation(s))`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
