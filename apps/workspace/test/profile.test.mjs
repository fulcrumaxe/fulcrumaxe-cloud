// apps/workspace/test/profile.test.mjs
//
// D#37 WS-B: tests for build/profile.mjs (line classification) and
// build/build.mjs (the profile-filtered build). Two kinds of coverage:
//
//   1. Synthetic fixtures (own index.html, own profile, own tmp shell/
//      tree) -- per Correction C6, these never rely on the real
//      import/allowlist.txt; they invent their own small tree so a change
//      to the real allowlist can't silently change what these assert.
//   2. A real-build check against the actual profiles/cloud.json and
//      shell/ tree, which is the only way to exercise WS-B acceptance
//      criteria 2 and 3 (no .wasm/automerge/xterm/crdt paths, no dropped-
//      app stylesheet, <=130 files referenced at boot, <=BOOT_BUDGET.maxBrotliBytes (320 KB) total
//      brotli for those files) without a browser.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import {
  classifyLine,
  filterIndexHtml,
  loadProfile,
  stripQuery,
  computeAssetHash,
  injectBaseHref,
  injectModulePreloads,
  substituteDefaultTheme,
  validateThemeNames,
} from "../build/profile.mjs";
import { build, shippedPath } from "../build/build.mjs";
import { BOOT_BUDGET } from "../build/budget.mjs";

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

function writeTree(dir, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const dest = join(dir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
}

const SYNTHETIC_PROFILE = {
  name: "test-profile",
  app_modules: ["kept-app"],
  drop_core: ["core/dropped-core.js"],
  features: { widgets: false },
};

// ---------------------------------------------------------------------------
// classifyLine / filterIndexHtml (synthetic fixtures only -- C6)
// ---------------------------------------------------------------------------

describe("classifyLine", () => {
  it("drops a script tag whose data-app is not in app_modules", () => {
    const line = '  <script type="module" src="apps/dropped-app/x.js" data-app="dropped-app"></script>';
    expect(classifyLine(line, SYNTHETIC_PROFILE)).toMatchObject({ kind: "tag", keep: false });
  });

  it("keeps a script tag whose data-app is in app_modules", () => {
    const line = '  <script type="module" src="apps/kept-app/x.js" data-app="kept-app"></script>';
    expect(classifyLine(line, SYNTHETIC_PROFILE)).toMatchObject({ kind: "tag", keep: true });
  });

  it("drops a link tag matching drop_core, with no data-app attribute", () => {
    const line = '    <link rel="stylesheet" href="core/dropped-core.js">';
    expect(classifyLine(line, SYNTHETIC_PROFILE)).toMatchObject({ kind: "tag", keep: false });
  });

  it("infers the app id from an apps/<id>/ path when there is no data-app attribute", () => {
    const dropped = '    <link rel="stylesheet" href="apps/dropped-app/style.css">';
    const kept = '    <link rel="stylesheet" href="apps/kept-app/style.css">';
    expect(classifyLine(dropped, SYNTHETIC_PROFILE)).toMatchObject({ keep: false });
    expect(classifyLine(kept, SYNTHETIC_PROFILE)).toMatchObject({ keep: true });
  });

  it("keeps an untagged core link/script that isn't in drop_core", () => {
    const line = '    <link rel="stylesheet" href="core/kept-core.css">';
    expect(classifyLine(line, SYNTHETIC_PROFILE)).toMatchObject({ kind: "tag", keep: true });
  });

  it("matches drop_core on a script tag with a closing </script> on the same line", () => {
    const line = '    <script type="module" src="core/dropped-core.js" data-core></script>';
    expect(classifyLine(line, SYNTHETIC_PROFILE)).toMatchObject({ kind: "tag", keep: false });
  });

  it("strips a cache-busting query string before matching drop_core", () => {
    const line = '    <script type="module" src="core/dropped-core.js?v=2" data-core></script>';
    expect(classifyLine(line, SYNTHETIC_PROFILE)).toMatchObject({ kind: "tag", keep: false });
  });

  it("leaves an already-commented-out tag line untouched", () => {
    const line = '    <!-- withheld: <script type="module" src="apps/dropped-app/x.js" data-app="dropped-app"></script> -->';
    expect(classifyLine(line, SYNTHETIC_PROFILE)).toEqual({ kind: "other" });
  });

  it("leaves non-tag lines untouched", () => {
    expect(classifyLine("<body>", SYNTHETIC_PROFILE)).toEqual({ kind: "other" });
    expect(classifyLine("", SYNTHETIC_PROFILE)).toEqual({ kind: "other" });
  });
});

describe("stripQuery", () => {
  it("removes a trailing querystring", () => {
    expect(stripQuery("core/desktop.js?v=2")).toBe("core/desktop.js");
  });
  it("leaves a plain path unchanged", () => {
    expect(stripQuery("core/desktop.js")).toBe("core/desktop.js");
  });
});

describe("filterIndexHtml", () => {
  const html = [
    "<!DOCTYPE html>",
    '<link rel="stylesheet" href="apps/kept-app/style.css">',
    '<link rel="stylesheet" href="apps/dropped-app/style.css">',
    '<script type="module" src="core/dropped-core.js" data-core></script>',
    '<script type="module" src="apps/kept-app/x.js" data-app="kept-app"></script>',
    '<script type="module" src="apps/dropped-app/x.js" data-app="dropped-app"></script>',
  ].join("\n");

  it("keeps only the surviving tags and reports what was dropped", () => {
    const { html: out, keptPaths, droppedPaths } = filterIndexHtml(html, SYNTHETIC_PROFILE);
    expect(out).toContain("apps/kept-app/style.css");
    expect(out).not.toContain("apps/dropped-app/style.css");
    expect(out).not.toContain("core/dropped-core.js");
    expect(keptPaths.sort()).toEqual(["apps/kept-app/style.css", "apps/kept-app/x.js"]);
    expect(droppedPaths.sort()).toEqual([
      "apps/dropped-app/style.css",
      "apps/dropped-app/x.js",
      "core/dropped-core.js",
    ]);
  });
});

// ---------------------------------------------------------------------------
// D#37 WS-D criterion 3/7/8: the pure helpers build.mjs wires into the
// hash-prefixed build (content hash, <base>/modulepreload injection,
// default-theme substitution, vendor theme-name validation).
// ---------------------------------------------------------------------------

describe("computeAssetHash", () => {
  it("is deterministic regardless of input order", () => {
    const a = [
      { relPath: "core/a.js", content: Buffer.from("a") },
      { relPath: "core/b.js", content: Buffer.from("b") },
    ];
    const b = [a[1], a[0]];
    expect(computeAssetHash(a)).toBe(computeAssetHash(b));
  });

  it("changes when any file's content changes", () => {
    const before = [{ relPath: "core/a.js", content: Buffer.from("a") }];
    const after = [{ relPath: "core/a.js", content: Buffer.from("a2") }];
    expect(computeAssetHash(before)).not.toBe(computeAssetHash(after));
  });

  it("is a lowercase 16-char hex string", () => {
    const hash = computeAssetHash([{ relPath: "x.js", content: Buffer.from("x") }]);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("injectBaseHref", () => {
  it("inserts <base> as the first child of <head>", () => {
    const html = "<!DOCTYPE html>\n<head>\n<title>t</title>\n</head>\n<body></body>";
    const out = injectBaseHref(html, "/s/abc123/");
    const headIdx = out.indexOf("<head>");
    const baseIdx = out.indexOf('<base href="/s/abc123/">');
    const titleIdx = out.indexOf("<title>");
    expect(headIdx).toBeGreaterThanOrEqual(0);
    expect(baseIdx).toBeGreaterThan(headIdx);
    expect(baseIdx).toBeLessThan(titleIdx);
  });

  it("throws when there is no <head> tag", () => {
    expect(() => injectBaseHref("<div></div>", "/s/abc/")).toThrow(/<head>/);
  });
});

describe("injectModulePreloads", () => {
  it("inserts one modulepreload link per path, before </head>", () => {
    const html = "<head>\n<link rel=\"stylesheet\" href=\"style.css\">\n</head>";
    const out = injectModulePreloads(html, ["core/a.js", "core/b.js"]);
    expect(out).toContain('<link rel="modulepreload" href="core/a.js">');
    expect(out).toContain('<link rel="modulepreload" href="core/b.js">');
    expect(out.indexOf("</head>")).toBeGreaterThan(out.indexOf('href="core/b.js"'));
  });

  it("is a no-op for an empty list", () => {
    const html = "<head></head>";
    expect(injectModulePreloads(html, [])).toBe(html);
  });

  it("never reorders the existing stylesheet/script tags (WS-D criterion 3's own tag-order check)", () => {
    const html = [
      "<head>",
      '<link rel="stylesheet" href="a.css">',
      '<script type="module" src="b.js"></script>',
      "</head>",
    ].join("\n");
    const before = [...html.matchAll(/<(?:script|link)\b[^>]*>/g)].map((m) => m[0]);
    const out = injectModulePreloads(injectBaseHref(html, "/s/x/"), ["c.js"]);
    const after = [...out.matchAll(/<(?:script|link)\b[^>]*rel="stylesheet"[^>]*>|<script\b[^>]*>/g)].map((m) => m[0]);
    expect(after).toEqual(before);
  });
});

describe("substituteDefaultTheme", () => {
  const source = 'var x = 1;\nvar DEFAULT_THEME_ID = "classic-crt"; // marker\nvar y = 2;\n';

  it("replaces the marker literal with the given theme id", () => {
    const out = substituteDefaultTheme(source, "orchard");
    expect(out).toContain('var DEFAULT_THEME_ID = "orchard";');
    expect(out).not.toContain('"classic-crt"');
  });

  it("throws when the marker is missing", () => {
    expect(() => substituteDefaultTheme("no marker here", "orchard")).toThrow(/DEFAULT_THEME_ID/);
  });
});

describe("validateThemeNames", () => {
  it("flags a vendor-named id or name", () => {
    const violations = validateThemeNames([
      { relPath: "core/themes/windows-aero.json", content: JSON.stringify({ id: "windows-aero", name: "Aero+" }) },
    ]);
    expect(violations).toEqual(
      expect.arrayContaining([
        { relPath: "core/themes/windows-aero.json", field: "id", value: "windows-aero" },
        { relPath: "core/themes/windows-aero.json", field: "name", value: "Aero+" },
      ])
    );
  });

  it("passes a clean, renamed theme", () => {
    const violations = validateThemeNames([
      { relPath: "core/themes/orchard.json", content: JSON.stringify({ id: "orchard", name: "Orchard" }) },
    ]);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// build() against a synthetic fixture tree
// ---------------------------------------------------------------------------

function fixtureShellTree() {
  const shellDir = scratchDir("ws-b-fixture-shell-");
  writeTree(shellDir, {
    "index.html": [
      "<!DOCTYPE html>",
      "<head>",
      '<link rel="stylesheet" href="core/kept.css">',
      '<link rel="stylesheet" href="apps/dropped-app/style.css">',
      '<script type="module" src="core/dropped.js" data-core></script>',
      '<script type="module" src="core/entry.js" data-core></script>',
      '<script type="module" src="apps/kept-app/x.js" data-app="kept-app"></script>',
      '<script type="module" src="apps/dropped-app/x.js" data-app="dropped-app"></script>',
      "</head>",
    ].join("\n"),
    "core/kept.css": "body { color: red; }",
    "core/dropped.js": "export const x = 1;",
    "core/entry.js": 'import { y } from "./lib.js";\nexport const x = y;',
    "core/lib.js": "export const y = 2;",
    "apps/kept-app/x.js": "export const app = 'kept';",
    "apps/dropped-app/x.js": "export const app = 'dropped';",
    "apps/dropped-app/style.css": ".dropped {}",
  });
  return shellDir;
}

function fixtureProfile(dir, overrides = {}) {
  const profilePath = join(dir, "profile.json");
  writeFileSync(
    profilePath,
    JSON.stringify({
      name: "fixture",
      app_modules: ["kept-app"],
      drop_core: ["core/dropped.js"],
      features: {},
      ...overrides,
    })
  );
  return profilePath;
}

// C6: a fixture-owned allowlist/BUILD-INFO.json, never the real ones --
// checks.mjs --import/--ship would otherwise reject every fixture file as
// "not-allowlisted".
function fixtureChecksConfig(dir, { added = [] } = {}) {
  const allowlistPath = join(dir, "allowlist.txt");
  writeFileSync(
    allowlistPath,
    ["index.html", "core/*.css", "core/*.js", "apps/kept-app/*.js", "apps/dropped-app/*.js", "apps/dropped-app/*.css"].join("\n")
  );
  const buildInfoPath = join(dir, "BUILD-INFO.json");
  writeFileSync(buildInfoPath, JSON.stringify({ files: {}, added }));
  return { allowlistPath, buildInfoPath };
}

describe("build()", () => {
  it("copies only the reachable set and drops everything else", () => {
    const shellDir = fixtureShellTree();
    const outDir = join(scratchDir("ws-b-fixture-out-"), "dist");
    const profileDir = scratchDir("ws-b-fixture-profile-");
    const profilePath = fixtureProfile(profileDir);
    const { allowlistPath, buildInfoPath } = fixtureChecksConfig(profileDir);

    const result = build({ profilePath, shellDir, outDir, allowlistPath, buildInfoPath });

    // core/entry.js's static import pulls core/lib.js in even though
    // lib.js has no <script> tag of its own.
    expect(result.copiedFiles).toEqual(
      expect.arrayContaining(["core/kept.css", "core/entry.js", "core/lib.js", "apps/kept-app/x.js"])
    );
    expect(result.copiedFiles).not.toContain("core/dropped.js");
    expect(result.copiedFiles).not.toContain("apps/dropped-app/x.js");
    expect(result.copiedFiles).not.toContain("apps/dropped-app/style.css");

    const dist = readFileSync(join(outDir, "index.html"), "utf8");
    expect(dist).not.toContain("dropped");
  });

  it("throws when a kept file's static import points at a missing file", () => {
    const shellDir = fixtureShellTree();
    writeTree(shellDir, {
      "core/entry.js": 'import { z } from "./missing.js";\nexport const x = z;',
    });
    const outDir = join(scratchDir("ws-b-fixture-out-"), "dist");
    const profileDir = scratchDir("ws-b-fixture-profile-");
    const profilePath = fixtureProfile(profileDir);
    const { allowlistPath, buildInfoPath } = fixtureChecksConfig(profileDir);

    expect(() => build({ profilePath, shellDir, outDir, allowlistPath, buildInfoPath })).toThrow(/missing.js/);
  });

  it("throws when a drop_core entry matches nothing in index.html", () => {
    const shellDir = fixtureShellTree();
    const outDir = join(scratchDir("ws-b-fixture-out-"), "dist");
    const profileDir = scratchDir("ws-b-fixture-profile-");
    const profilePath = fixtureProfile(profileDir, { drop_core: ["core/typo-path.js"] });
    const { allowlistPath, buildInfoPath } = fixtureChecksConfig(profileDir);

    expect(() => build({ profilePath, shellDir, outDir, allowlistPath, buildInfoPath })).toThrow(/typo-path\.js/);
  });

  it("rejects a static import that resolves outside shellDir (CWE-22 path traversal, PR #100 review)", () => {
    // Same shape as the review's own PoC: a chained "../../" import from an
    // otherwise-kept file reaches above shellDir entirely.
    // posix.normalize("core/../../outside-secret.js") == "../outside-secret.js",
    // i.e. one level above shellDir -- a sibling of shellDir itself.
    const container = scratchDir("ws-b-traversal-");
    const shellDir = join(container, "shell");
    writeTree(shellDir, {
      "index.html": [
        "<!DOCTYPE html>",
        '<script type="module" src="core/entry.js" data-core></script>',
      ].join("\n"),
      "core/entry.js": 'import { secretMarker } from "../../outside-secret.js";\nexport const x = secretMarker;',
    });
    writeFileSync(join(container, "outside-secret.js"), "export const secretMarker = 'leak';\n");

    const outDir = join(container, "dist");
    const profileDir = scratchDir("ws-b-fixture-profile-");
    const profilePath = fixtureProfile(profileDir, { app_modules: [], drop_core: [] });
    const { allowlistPath, buildInfoPath } = fixtureChecksConfig(profileDir);

    expect(() => build({ profilePath, shellDir, outDir, allowlistPath, buildInfoPath })).toThrow(
      /outside-secret\.js/
    );
    // The traversal check runs before step 4 (the copy step that creates
    // outDir) -- nothing gets written outside outDir because nothing gets
    // written at all.
    expect(existsSync(outDir)).toBe(false);
  });

  it("does not throw on a drop_core entry that is a documented no-op (file never imported)", () => {
    const shellDir = fixtureShellTree();
    // core/automerge-bootstrap.js and crypto.js are absent from the real
    // import tree by design (C5) -- their drop_core entries have to be
    // silent no-ops rather than build failures.
    const outDir = join(scratchDir("ws-b-fixture-out-"), "dist");
    const profileDir = scratchDir("ws-b-fixture-profile-");
    const profilePath = fixtureProfile(profileDir, {
      drop_core: ["core/dropped.js", "core/automerge-bootstrap.js", "crypto.js"],
    });
    const { allowlistPath, buildInfoPath } = fixtureChecksConfig(profileDir);

    expect(() => build({ profilePath, shellDir, outDir, allowlistPath, buildInfoPath })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Real build: profiles/cloud.json against the actual shell/ tree.
// This is the only place WS-B acceptance criteria 2 and 3 are checked
// without a browser -- see e2e/idle-network.spec.ts for criteria 4-6.
// ---------------------------------------------------------------------------

describe("cloud profile: real build", () => {
  function realBuild() {
    const outDir = join(scratchDir("ws-b-real-out-"), "dist");
    return build({ profilePath: REAL_PROFILE_PATH, shellDir: REAL_SHELL_DIR, outDir });
  }

  it("loads and validates", () => {
    const profile = loadProfile(REAL_PROFILE_PATH);
    // D#37 WS-L1 (correction C19c criterion 1 / C19e item 1): "activation"
    // is removed from app_modules -- the licence-activation module does
    // not belong in cloud (owner ruling). Also asserts it stays OUT, so a
    // regression here (activation creeping back into the profile) fails
    // this test, not just the --ship string/path guard.
    expect(profile.app_modules).toEqual(expect.arrayContaining(["themes"]));
    expect(profile.app_modules).not.toContain("activation");
    expect(profile.features).toMatchObject({
      presence: false,
      liveEntitlements: false,
      crdt: false,
      messages: false,
      updates: false,
    });
  });

  it("builds without throwing (checks.mjs --import and --ship both pass)", () => {
    expect(() => realBuild()).not.toThrow();
  });

  it("criterion 3: no .wasm, no automerge/xterm/crdt path, no dropped-app stylesheet", () => {
    const result = realBuild();
    for (const relPath of result.copiedFiles) {
      expect(relPath.endsWith(".wasm")).toBe(false);
      expect(relPath).not.toMatch(/automerge|xterm|crdt/i);
    }
    // Every remaining apps/<id>/*.css belongs to a kept app.
    for (const relPath of result.copiedFiles) {
      const m = relPath.match(/^apps\/([^/]+)\/.*\.css$/);
      if (m) expect(result.profile.app_modules).toContain(m[1]);
    }
  });

  it("criterion 3: <=BOOT_BUDGET.maxStaticRequests files referenced at boot, <=BOOT_BUDGET.maxBrotliBytes total brotli (q11) for them", () => {
    const result = realBuild();
    expect(result.bootFiles.length).toBeLessThanOrEqual(BOOT_BUDGET.maxStaticRequests);

    let total = 0;
    for (const relPath of result.bootFiles) {
      const abs = shippedPath(result, relPath);
      const buf = readFileSync(abs);
      const compressed = zlib.brotliCompressSync(buf, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
      });
      total += compressed.length;
    }
    expect(total).toBeLessThanOrEqual(BOOT_BUDGET.maxBrotliBytes);
  });

  it("WS-D criterion 3: index.html gets <base href='/s/<hash>/'> and a modulepreload for every import-only module", () => {
    const result = realBuild();
    expect(result.hash).toMatch(/^[0-9a-f]{16}$/);

    const indexHtml = readFileSync(shippedPath(result, "index.html"), "utf8");
    expect(indexHtml).toContain(`<base href="/s/${result.hash}/">`);
    // Every shipped .js file NOT directly tagged in index.html (i.e. reached
    // only via a static import) gets its own modulepreload hint.
    expect(result.modulePreloadPaths.length).toBeGreaterThan(0);
    for (const relPath of result.modulePreloadPaths) {
      expect(indexHtml).toContain(`<link rel="modulepreload" href="${relPath}">`);
    }

    // Every file build.mjs says it shipped is actually reachable under the
    // hashed prefix, and index.html itself stays unhashed at outDir's root.
    for (const relPath of result.copiedFiles.slice(0, 5)) {
      expect(existsSync(shippedPath(result, relPath))).toBe(true);
    }
    expect(existsSync(join(result.outDir, "index.html"))).toBe(true);
  });

  it("WS-D criterion 7: the shipped theme-manager.js's default start id matches profiles/cloud.json's default_theme", () => {
    const result = realBuild();
    const themeManagerJs = readFileSync(shippedPath(result, "core/theme-manager.js"), "utf8");
    expect(themeManagerJs).toContain(`var DEFAULT_THEME_ID = "${result.profile.default_theme}";`);
  });

  it("WS-D criterion 8: no shipped theme JSON's id/name matches the vendor-name pattern", () => {
    const result = realBuild();
    const violations = validateThemeNames(
      result.copiedFiles
        .filter((p) => p.startsWith("core/themes/") && p.endsWith(".json"))
        .map((relPath) => ({ relPath, content: readFileSync(shippedPath(result, relPath), "utf8") }))
    );
    expect(violations).toEqual([]);
  });

  it("ships the fork files (features.js + the four gated core modules)", () => {
    const result = realBuild();
    for (const relPath of [
      "core/features.js",
      "core/presence.js",
      "core/entitlements.js",
      "core/taskbar.js",
      "core/tray-update-indicator.js",
    ]) {
      expect(result.copiedFiles).toContain(relPath);
    }
  });

  it("core/boot.js has no reference to automerge (C5)", () => {
    const bootJs = readFileSync(join(REAL_SHELL_DIR, "core", "boot.js"), "utf8");
    expect(bootJs).not.toMatch(/automerge/i);
  });
});
