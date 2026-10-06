// apps/workspace/test/first-party-hardening-r2.test.mjs
//
// D#37 C24 / WS-F0, fix round 2 of PR #200 (security re-check MUST-1
// residual, CWE-79/116). Round 1 pinned the charset for a manifest's entry
// and styles; the re-check showed a file reached only by import (and so
// written into index.html as a <link rel="modulepreload">) was not covered.
// These cases build through the real build() and also unit-test the two
// index.html injectors directly, so the escape layer is pinned even if the
// scan-time validation were bypassed.

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { build } from "../build/build.mjs";
import { injectBaseHref, injectModulePreloads } from "../build/profile.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REAL_PROFILE = join(TEST_DIR, "..", "profiles", "cloud.json");

const cleanupDirs = [];
afterEach(() => {
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop(), { recursive: true, force: true });
});

function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function appsTree(files) {
  const dir = scratchDir("ws-f0-fix2-apps-");
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  return dir;
}

function profileWith(...ids) {
  const p = JSON.parse(readFileSync(REAL_PROFILE, "utf8"));
  p.app_modules.push(...ids);
  const path = join(scratchDir("ws-f0-fix2-prof-"), "profile.json");
  writeFileSync(path, JSON.stringify(p));
  return path;
}

function tryBuild(files) {
  const appsDir = appsTree(files);
  try {
    const out = scratchDir("ws-f0-fix2-out-");
    build({ profilePath: profileWith("demo"), appsDir, outDir: out });
    return { built: true, out, error: "" };
  } catch (e) {
    return { built: false, out: "", error: String(e.message) };
  }
}

const manifest = JSON.stringify({ id: "demo", entry: "main.js" });

describe("MUST-1 residual: every name under apps/<name>/ is charset-checked", () => {
  const EVIL_NAMES = [
    ['a"><meta http-equiv="refresh" content="0;url=https:evil.example"><b x=".js', "quote and angle brackets"],
    ['b" data-core="1.js', "quote (data-core spoof)"],
    ["a b.js", "space"],
    ["a<b.js", "less-than"],
    ["a>b.js", "greater-than"],
  ];

  for (const [name, label] of EVIL_NAMES) {
    it(`refuses an imported non-entry file in an app named with ${label}`, () => {
      const r = tryBuild({
        "demo/manifest.json": manifest,
        "demo/main.js": `import './${name}';\n`,
        [`demo/${name}`]: "export {};\n",
      });
      expect(r.built).toBe(false);
      expect(r.error).toMatch(/allowed charset/);
    });

    it(`refuses an imported file in a _lib named with ${label}`, () => {
      const r = tryBuild({
        "demo/manifest.json": manifest,
        "demo/main.js": `import '../_lib/${name}';\n`,
        [`_lib/${name}`]: "export {};\n",
      });
      expect(r.built).toBe(false);
      expect(r.error).toMatch(/allowed charset/);
    });
  }

  it("refuses a directory name outside the charset, in an app and in a _lib", () => {
    for (const files of [
      { "demo/manifest.json": manifest, "demo/main.js": "", "demo/a b/x.js": "export {};\n" },
      { "demo/manifest.json": manifest, "demo/main.js": "", '_lib/d"q/x.js': "export {};\n" },
    ]) {
      const r = tryBuild(files);
      expect(r.built).toBe(false);
      expect(r.error).toMatch(/allowed charset/);
    }
  });

  it("still builds a plain nested import and emits exactly its own preload link", () => {
    const r = tryBuild({
      "demo/manifest.json": manifest,
      "demo/main.js": "import './sub/util-1.js';\nimport '../_lib/shared.js';\n",
      "demo/sub/util-1.js": "export {};\n",
      "_lib/shared.js": "export {};\n",
    });
    expect(r.error).toBe("");
    expect(r.built).toBe(true);
    const indexHtml = readFileSync(join(r.out, "index.html"), "utf8");
    expect(indexHtml).toContain('<link rel="modulepreload" href="apps/demo/sub/util-1.js">');
    expect(indexHtml).toContain('<link rel="modulepreload" href="apps/_lib/shared.js">');
  });
});

describe("MUST-1 residual: injectors escape even if validation were bypassed", () => {
  const HTML = "<!doctype html>\n<html>\n<head>\n<title>t</title>\n</head>\n<body></body>\n</html>\n";
  const HOSTILE = 'a"><meta http-equiv="refresh" content="0;url=https:evil.example"><b x=".js';

  it("injectModulePreloads escapes a hostile path and adds no element", () => {
    const out = injectModulePreloads(HTML, [HOSTILE, 'b" data-core="1.js', "a b.js"]);
    expect(out).not.toContain("<meta");
    expect(out).not.toMatch(/data-core="/);
    expect(out.match(/<link /g)).toHaveLength(3);
    expect(out).toContain("&quot;");
    expect(out).toContain("a&#32;b.js");
  });

  it("injectBaseHref escapes a hostile base href and adds no element", () => {
    const out = injectBaseHref(HTML, '/s/x"><script>alert(1)</script>/');
    expect(out).not.toContain("<script");
    expect(out.match(/<base /g)).toHaveLength(1);
    expect(out).toContain('<base href="/s/x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;/">');
  });

  it("does not treat $ in a value as a String.replace pattern", () => {
    expect(injectModulePreloads(HTML, ["$&x.js"])).toContain('href="$&amp;x.js"');
    expect(injectBaseHref(HTML, "/s/$1/")).toContain('<base href="/s/$1/">');
  });

  it("leaves ordinary paths byte-for-byte as before", () => {
    expect(injectModulePreloads(HTML, ["core/a-b_c.js"])).toContain(
      '    <link rel="modulepreload" href="core/a-b_c.js">\n</head>'
    );
    expect(injectBaseHref(HTML, "/s/0123abcd/")).toContain('<head>\n    <base href="/s/0123abcd/">');
  });
});
