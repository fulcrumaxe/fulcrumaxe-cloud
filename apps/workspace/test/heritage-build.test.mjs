// apps/workspace/test/heritage-build.test.mjs
//
// D#37 Correction C19 (discussioncomment 18606574), task WS-TH1, C19b
// criterion 1 (technical architect cause 1): "the heritage layer never
// ships" -- profiles/cloud.json's `app_modules` didn't list "heritage", so
// profile.mjs's tag filter dropped every `data-app="heritage"` line in
// index.html, and even once listed, orchard.css/crystal.css are loaded by
// the adapters building a `<link href="apps/themes/heritage/...css">`
// string at runtime (injectStyles() in each adapter) -- never a static
// index.html tag and never a JS `import`, so build.mjs's tag-based +
// static-import-graph reachability walk never found them either (see
// build.mjs's own HERITAGE_CSS_FILES comment). Both gaps are fixed by this
// task; this test builds the REAL cloud profile against the REAL shell/
// tree (never a synthetic fixture -- the missing files were the point) and
// proves both are closed.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { build, shippedPath } from "../build/build.mjs";

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

// The five data-app="heritage" tags index.html carries (module header,
// C19b criterion 1's own list).
const HERITAGE_TAGS = [
  "core/heritage-shell.js",
  "apps/themes/heritage/orchard-icons.js",
  "apps/themes/heritage/orchard-adapter.js",
  "apps/themes/heritage/crystal-icons.js",
  "apps/themes/heritage/crystal-adapter.js",
];

// Every module those five tags statically import (directly or
// transitively), per each file's own import list -- checked against the
// real files below, not assumed.
const HERITAGE_IMPORTED_MODULES = [
  "apps/themes/heritage/orchard-dom.js",
  "apps/themes/heritage/orchard-dock-layout.js",
  "apps/themes/heritage/orchard-dock-state.js",
  "apps/themes/heritage/orchard-dock-folders.js",
  "apps/themes/heritage/orchard-dock-minimized.js",
  "apps/themes/heritage/orchard-dock-menu.js",
  "apps/themes/heritage/crystal-dom.js",
];

const HERITAGE_CSS = ["apps/themes/heritage/orchard.css", "apps/themes/heritage/crystal.css"];

describe("D#37 WS-TH1 criterion 1: the real cloud profile ships the heritage layer", () => {
  it("the filtered index.html keeps all five data-app=\"heritage\" tags", () => {
    const outDir = join(scratchDir("wsth1-heritage-build-"), "dist");
    const result = build({ profilePath: REAL_PROFILE_PATH, shellDir: REAL_SHELL_DIR, outDir });

    for (const tag of HERITAGE_TAGS) {
      expect(result.keptPaths, `expected ${tag} to be kept`).toContain(tag);
    }
  });

  it("dist/ contains every module the heritage tags import, plus orchard.css and crystal.css", () => {
    const outDir = join(scratchDir("wsth1-heritage-build-"), "dist");
    const result = build({ profilePath: REAL_PROFILE_PATH, shellDir: REAL_SHELL_DIR, outDir });

    for (const relPath of [...HERITAGE_TAGS, ...HERITAGE_IMPORTED_MODULES]) {
      expect(existsSync(shippedPath(result, relPath)), `expected ${relPath} in dist/`).toBe(true);
    }
    // The CSS files are the actual regression this criterion targets: on
    // main (before build.mjs's HERITAGE_CSS_FILES fix) the tag/import walk
    // never found them, so they were silently absent from dist/ even with
    // "heritage" in app_modules -- confirmed by the "without heritage"
    // test below, which reproduces exactly that absence.
    for (const relPath of HERITAGE_CSS) {
      expect(existsSync(shippedPath(result, relPath)), `expected ${relPath} in dist/`).toBe(true);
    }
  });

  it('a profile that does NOT ship "heritage" gets none of the heritage tags, modules, or CSS', () => {
    // A synthetic profile, not the real cloud.json -- proves the CSS
    // inclusion is conditional on app_modules, not unconditional like
    // ALWAYS_INCLUDE_DIRS (core/theme-manager.js needs core/themes/ and
    // fonts/ regardless of which apps ship; nothing needs orchard.css/
    // crystal.css once their loader, the heritage app_module, is gone).
    // Reuses the real cloud.json's own drop_core list (unrelated to
    // heritage) rather than an empty one, which would keep untagged
    // core <link> tags like vendor/xterm/xterm.css that the real profile
    // drops and that don't exist on disk at all -- see profile.mjs's own
    // header comment.
    const realProfile = JSON.parse(readFileSync(REAL_PROFILE_PATH, "utf8"));
    const scratch = scratchDir("wsth1-heritage-build-no-heritage-");
    const profilePath = join(scratch, "no-heritage-profile.json");
    writeFileSync(
      profilePath,
      JSON.stringify({
        name: "no-heritage",
        app_modules: realProfile.app_modules.filter((id) => id !== "heritage"),
        drop_core: realProfile.drop_core,
        features: realProfile.features,
        // D#37 WS-D criterion 8: carried over from the real profile so this
        // synthetic one still excludes windows-aero/ubuntu-gnome from
        // dist/ -- without it, build()'s new theme-name validation
        // correctly refuses to ship them (they're still vendor-named on
        // disk, kept only for jpos parity).
        excluded_themes: realProfile.excluded_themes,
        default_theme: realProfile.default_theme,
      }),
    );
    const outDir = join(scratch, "dist");
    const result = build({ profilePath, shellDir: REAL_SHELL_DIR, outDir });

    for (const tag of HERITAGE_TAGS) {
      expect(result.keptPaths).not.toContain(tag);
    }
    for (const relPath of HERITAGE_CSS) {
      expect(existsSync(shippedPath(result, relPath)), `did not expect ${relPath} in dist/`).toBe(false);
    }
  });

  // D#37 WS-TH1 fix round 1 (owner ruling 2026-09-25): "I don't think Aero
  // and Yaru are fully worked, so you can just remove them." windows-aero
  // and ubuntu-gnome must not ship in the real cloud profile's dist/, and
  // their JSON must not be dead weight there either -- both are excluded
  // via profiles/cloud.json's `excluded_themes` (build.mjs), while staying
  // present, untouched, in shell/core/themes/ for jpos parity.
  it("dist/ ships exactly 8 theme JSON files, and neither windows-aero nor ubuntu-gnome is one of them", () => {
    const outDir = join(scratchDir("wsth1-heritage-build-theme-count-"), "dist");
    const result = build({ profilePath: REAL_PROFILE_PATH, shellDir: REAL_SHELL_DIR, outDir });

    const themesDir = join(result.outDir, "s", result.hash, "core", "themes");
    const shippedThemeFiles = readdirSync(themesDir).filter((f) => f.endsWith(".json"));
    expect(shippedThemeFiles.sort()).toEqual(
      [
        "classic-crt.json",
        "corporate.json",
        "crystal.json",
        "cyberpunk.json",
        "modern-flat.json",
        "nord.json",
        "orchard.json",
        "retro-amber.json",
      ].sort(),
    );
    expect(shippedThemeFiles).not.toContain("windows-aero.json");
    expect(shippedThemeFiles).not.toContain("ubuntu-gnome.json");

    // The source files still exist on disk (jpos parity, never deleted) --
    // only the shipped dist/ output excludes them.
    expect(existsSync(join(REAL_SHELL_DIR, "core", "themes", "windows-aero.json"))).toBe(true);
    expect(existsSync(join(REAL_SHELL_DIR, "core", "themes", "ubuntu-gnome.json"))).toBe(true);
  });
});
