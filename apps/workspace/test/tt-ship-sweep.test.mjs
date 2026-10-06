// apps/workspace/test/tt-ship-sweep.test.mjs
//
// D#37 Correction C18 (discussioncomment 18604630), task WS-C5 criterion 2:
// a failing-first, ship-wide sweep. TRUSTED_TYPES_SINK_GUARDED_FILES (16
// entries after this task) only names files someone remembered to add to
// the guard -- it says nothing about the next file a future app_modules
// entry ships. This test instead builds the real cloud profile into a temp
// directory and runs the guard's own sink regex over every `.js` file the
// build actually writes, guarded or not. On main @ b6676f5 this reports the
// 21 sites C18a's table lists (10 files); on this branch it reports zero.
//
// It uses TRUSTED_TYPES_SINK_RE and stripJsComments exported from
// rules.mjs -- the exact objects checkTrustedTypesSink() itself uses, never
// a copied literal, so this test and the guard can never drift apart.

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, rmSync, mkdtempSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { build } from "../build/build.mjs";
import { TRUSTED_TYPES_SINK_RE, stripJsComments } from "../import/rules.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = join(TEST_DIR, "..");
const REAL_SHELL_DIR = join(WORKSPACE_DIR, "shell");
const REAL_PROFILE_PATH = join(WORKSPACE_DIR, "profiles", "cloud.json");

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

function walkJsFiles(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(abs, base, acc);
    } else if (entry.isFile() && /\.m?js$/.test(entry.name)) {
      acc.push(abs);
    }
  }
  return acc;
}

describe("WS-C5: ship-wide Trusted Types sink sweep", () => {
  it("the shipped cloud-profile dist/ tree has zero sink sites in any .js file", () => {
    const outDir = join(scratchDir("ws-c5-ship-sweep-out-"), "dist");
    const result = build({ profilePath: REAL_PROFILE_PATH, shellDir: REAL_SHELL_DIR, outDir });

    const jsFiles = walkJsFiles(result.outDir);
    // Sanity: the build actually wrote a non-trivial number of JS files, so
    // an empty tree (a broken profile path, say) can't pass this test by
    // vacuously finding nothing to check.
    expect(jsFiles.length).toBeGreaterThan(30);

    const hits = [];
    for (const abs of jsFiles) {
      const relPath = relative(result.outDir, abs).split(sep).join("/");
      const src = readFileSync(abs, "utf8");
      const stripped = stripJsComments(src);
      if (TRUSTED_TYPES_SINK_RE.test(stripped)) {
        hits.push(relPath);
      }
    }

    expect(hits).toEqual([]);
  });
});
