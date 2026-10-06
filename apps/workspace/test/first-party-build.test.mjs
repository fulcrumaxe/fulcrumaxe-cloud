// apps/workspace/test/first-party-build.test.mjs
//
// D#37 Correction C24, task WS-F0: build plumbing for first-party SDK apps
// (apps/workspace/apps/<id>/, compiled per file by typescript's
// transpileModule, tags injected after the SDK, checked by checks.mjs
// --ship). Every C24 pass/fail criterion has at least one test below whose
// name carries the criterion number; the mutation proofs in the PR body
// name the test each scratch change turns red.
//
// The fixture app lives under test/fixtures/first-party/ (never under
// apps/workspace/apps/), so it can not ship in the real dist/. Negative
// cases copy or synthesise a scratch apps tree per test.

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { build, shippedPath } from "../build/build.mjs";
import { loadFirstPartyApps } from "../build/first-party.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = join(TEST_DIR, "..");
const SHELL_DIR = join(WORKSPACE_DIR, "shell");
const CHECKS_MJS = join(WORKSPACE_DIR, "import", "checks.mjs");
const FIXTURE_ROOT = join(TEST_DIR, "fixtures", "first-party");
const FIXTURE_PROFILE = join(FIXTURE_ROOT, "profile.json");
const FIXTURE_APPS = join(FIXTURE_ROOT, "apps");
const REAL_PROFILE = join(WORKSPACE_DIR, "profiles", "cloud.json");

const cleanupDirs = [];
afterEach(() => {
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop(), { recursive: true, force: true });
});

function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

// A scratch apps tree: { "id/manifest.json": "...", "id/main.js": "..." }.
function appsTree(files) {
  const dir = scratchDir("ws-f0-apps-");
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  return dir;
}

// A copy of the fixture root, for tests that plant something in it.
function fixtureCopy() {
  const dir = scratchDir("ws-f0-fixture-");
  cpSync(FIXTURE_APPS, dir, { recursive: true });
  makeWritable(dir);
  return dir;
}

// cpSync preserves source modes, so a copy of a read-only tree (a verified,
// read-only checkout) is read-only too and the tests that plant files in it
// fail with EACCES. Directories first, so the walk can descend into them.
function makeWritable(path) {
  if (lstatSync(path).isSymbolicLink()) return;
  const isDir = lstatSync(path).isDirectory();
  chmodSync(path, lstatSync(path).mode | (isDir ? 0o700 : 0o200));
  if (isDir) for (const name of readdirSync(path)) makeWritable(join(path, name));
}

function manifestOf(over) {
  return JSON.stringify({ id: "demo", entry: "main.js", ...over });
}

function tinyApp(manifestOver = {}, extra = {}) {
  return appsTree({
    "demo/manifest.json": manifestOf(manifestOver),
    "demo/main.js": "export {};\n",
    "demo/a.css": "a{}\n",
    ...extra,
  });
}

function buildFixture({ appsDir = FIXTURE_APPS, profilePath = FIXTURE_PROFILE } = {}) {
  const outDir = scratchDir("ws-f0-out-");
  return build({ profilePath, appsDir, outDir });
}

function walk(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs, base, acc);
    else acc.push(relative(base, abs).split(sep).join("/"));
  }
  return acc;
}

describe("C24 criterion 2: manifest validation", () => {
  it("accepts a well-formed manifest", () => {
    const model = loadFirstPartyApps(tinyApp({ styles: ["a.css"] }), { shellDir: SHELL_DIR });
    expect(model.apps.map((a) => a.id)).toEqual(["demo"]);
  });

  it("refuses an id that differs from the directory name", () => {
    expect(() => loadFirstPartyApps(tinyApp({ id: "other" }), { shellDir: SHELL_DIR })).toThrow(/id/);
  });

  it("refuses an id (directory name) that does not match the id pattern", () => {
    const dir = appsTree({
      "Bad_Id/manifest.json": JSON.stringify({ id: "Bad_Id", entry: "main.js" }),
      "Bad_Id/main.js": "export {};\n",
    });
    expect(() => loadFirstPartyApps(dir, { shellDir: SHELL_DIR })).toThrow(/Bad_Id/);
  });

  it.each([
    ["a parent-directory segment", "../x.js"],
    ["a nested parent-directory segment", "sub/../../x.js"],
    ["an absolute path", "/etc/x.js"],
    ["a URL", "https://example.com/x.js"],
    ["a scheme-relative URL", "//example.com/x.js"],
    ["a data: URL", "data:text/javascript,1"],
    ["a query string", "main.js?v=1"],
    ["a fragment", "main.js#x"],
    ["a backslash", "sub\\x.js"],
    ["a drive letter", "C:x.js"],
    ["a percent-encoded traversal", "%2e%2e/x.js"],
    ["a dot segment", "./main.js"],
    ["an empty path", ""],
    ["a non-string", 7],
  ])("refuses an entry with %s", (_name, entry) => {
    expect(() => loadFirstPartyApps(tinyApp({ entry }), { shellDir: SHELL_DIR })).toThrow(/entry/);
  });

  // Refused by the traversal rule itself, not merely because the target
  // file happens not to exist.
  it.each(["../x.js", "sub/../../x.js", "a/../main.js"])("refuses entry %s as a traversal", (entry) => {
    expect(() => loadFirstPartyApps(tinyApp({ entry }), { shellDir: SHELL_DIR })).toThrow(/stay inside the app directory/);
  });

  it("refuses styles with a parent-directory segment as a traversal", () => {
    expect(() => loadFirstPartyApps(tinyApp({ styles: ["../a.css"] }), { shellDir: SHELL_DIR })).toThrow(
      /stay inside the app directory/
    );
  });

  it("refuses an entry whose file does not exist", () => {
    expect(() => loadFirstPartyApps(tinyApp({ entry: "missing.js" }), { shellDir: SHELL_DIR })).toThrow(/entry/);
  });

  it("requires an entry", () => {
    const dir = appsTree({ "demo/manifest.json": JSON.stringify({ id: "demo" }), "demo/main.js": "" });
    expect(() => loadFirstPartyApps(dir, { shellDir: SHELL_DIR })).toThrow(/entry/);
  });

  it.each([
    ["a parent-directory segment", ["../a.css"]],
    ["an absolute path", ["/a.css"]],
    ["a URL", ["https://example.com/a.css"]],
    ["a query string", ["a.css?x"]],
    ["a non-.css file", ["main.js"]],
    ["a missing file", ["nope.css"]],
    ["a non-list", "a.css"],
  ])("refuses styles with %s", (_name, styles) => {
    expect(() => loadFirstPartyApps(tinyApp({ styles }), { shellDir: SHELL_DIR })).toThrow(/styles/);
  });

  it("refuses a manifest that is not valid JSON", () => {
    const dir = appsTree({ "demo/manifest.json": "{nope", "demo/main.js": "" });
    expect(() => loadFirstPartyApps(dir, { shellDir: SHELL_DIR })).toThrow(/manifest/);
  });

  it("refuses an app directory with no manifest", () => {
    const dir = appsTree({ "demo/main.js": "" });
    expect(() => loadFirstPartyApps(dir, { shellDir: SHELL_DIR })).toThrow(/manifest/);
  });
});

describe("C24 criterion 1: layout and _-prefixed shared libraries", () => {
  it("a _-prefixed directory is a library: no manifest allowed, not an app", () => {
    const ok = loadFirstPartyApps(FIXTURE_APPS, { shellDir: SHELL_DIR });
    expect(ok.apps.map((a) => a.id)).toEqual(["fp-fixture"]);
    expect(ok.libs).toEqual(["_shared"]);

    const bad = tinyApp({}, { "_lib/manifest.json": manifestOf({ id: "_lib" }), "_lib/x.js": "" });
    expect(() => loadFirstPartyApps(bad, { shellDir: SHELL_DIR })).toThrow(/_lib/);
  });

  it("the real apps/ directory loads, and holds exactly the app directories that have a manifest", () => {
    // WS-F0 merged with no app here; each WS-F task adds its own directory.
    const model = loadFirstPartyApps(join(WORKSPACE_DIR, "apps"), { shellDir: SHELL_DIR });
    const dirs = readdirSync(join(WORKSPACE_DIR, "apps"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
      .map((d) => d.name)
      .sort();
    expect(model.apps.map((a) => a.id).sort()).toEqual(dirs);
  });

  it("refuses an app that has both x.js and x.ts (both compile to x.js)", () => {
    const dir = tinyApp({}, { "demo/main.ts": "export {};\n" });
    expect(() => loadFirstPartyApps(dir, { shellDir: SHELL_DIR })).toThrow(/main/);
  });
});

describe("C24 criterion 5: an id colliding with an imported app fails", () => {
  it.each(["themes", "heritage", "activation", "terminal"])("refuses first-party id %s", (id) => {
    const dir = appsTree({
      [`${id}/manifest.json`]: JSON.stringify({ id, entry: "main.js" }),
      [`${id}/main.js`]: "export {};\n",
    });
    expect(() => loadFirstPartyApps(dir, { shellDir: SHELL_DIR })).toThrow(new RegExp(`"${id}"`));
  });

  it("fails the build too, naming the id", () => {
    const dir = appsTree({
      "themes/manifest.json": JSON.stringify({ id: "themes", entry: "main.js" }),
      "themes/main.js": "export {};\n",
    });
    expect(() => build({ appsDir: dir, outDir: scratchDir("ws-f0-out-") })).toThrow(/"themes"/);
  });
});

describe("C24 criterion 7: first-party file checks", () => {
  it("refuses a file type outside manifest.json/.js/.ts/.tsx/.css, inside an app", () => {
    const dir = tinyApp({}, { "demo/notes.md": "hi\n" });
    expect(() => loadFirstPartyApps(dir, { shellDir: SHELL_DIR })).toThrow(/notes\.md/);
  });

  it("refuses a stray top-level file other than README.md", () => {
    const dir = tinyApp({}, { "stray.json": "{}" });
    expect(() => loadFirstPartyApps(dir, { shellDir: SHELL_DIR })).toThrow(/stray\.json/);
    const withReadme = tinyApp({}, { "README.md": "docs\n" });
    expect(() => loadFirstPartyApps(withReadme, { shellDir: SHELL_DIR })).not.toThrow();
  });

  it("refuses dotfiles and secret-shaped paths", () => {
    const dot = tinyApp({}, { "demo/.hidden.js": "" });
    expect(() => loadFirstPartyApps(dot, { shellDir: SHELL_DIR })).toThrow(/\.hidden\.js/);
    const secret = tinyApp({}, { "demo/secret.js": "" });
    expect(() => loadFirstPartyApps(secret, { shellDir: SHELL_DIR })).toThrow(/secret\.js/);
  });

  it("refuses a symlink", () => {
    const dir = tinyApp();
    symlinkSync("/etc/hostname", join(dir, "demo", "link.js"));
    expect(() => loadFirstPartyApps(dir, { shellDir: SHELL_DIR })).toThrow(/link\.js/);
  });

  it("a disallowed file type in a fixture app fails the build", () => {
    const dir = fixtureCopy();
    writeFileSync(join(dir, "fp-fixture", "payload.html"), "<p>x</p>\n");
    expect(() => buildFixture({ appsDir: dir })).toThrow(/payload\.html/);
  });

  it("a secret-shaped string in a fixture app fails the build via checks.mjs --ship", () => {
    const dir = fixtureCopy();
    const token = ["gh", "p_", "a".repeat(36)].join("");
    writeFileSync(join(dir, "_shared", "label.ts"), `export const t: string = "${token}";\nexport function label(n: number): string { return String(n); }\n`);
    let msg = "";
    try {
      buildFixture({ appsDir: dir });
    } catch (e) {
      msg = String(e.message);
    }
    expect(msg).toMatch(/checks\.mjs --ship failed/);
    expect(msg).toMatch(/content-secret-ghp: apps\/_shared\/label\.js/);
  });

  it("a shipped-string rule (the product-name gate) applies to first-party code too", () => {
    const dir = fixtureCopy();
    const view = join(dir, "fp-fixture", "view.tsx");
    writeFileSync(view, readFileSync(view, "utf8") + `\nexport const s = "${["Claude", "Code"].join(" ")}";\n`);
    expect(() => buildFixture({ appsDir: dir })).toThrow(/ship-claude-code-text/);
  });

  it("checks.mjs --ship only exempts first-party output when told the prefix, and only .js/.css", () => {
    const dist = scratchDir("ws-f0-ship-");
    mkdirSync(join(dist, "apps", "demo"), { recursive: true });
    writeFileSync(join(dist, "apps", "demo", "main.js"), "export {};\n");
    const run = (extra) => {
      try {
        const out = execFileSync(process.execPath, [CHECKS_MJS, "--ship", dist, ...extra], { stdio: "pipe" });
        return { code: 0, out: String(out) };
      } catch (e) {
        return { code: e.status, out: String(e.stdout) + String(e.stderr) };
      }
    };
    expect(run([]).out).toMatch(/not-allowlisted: apps\/demo\/main\.js/);
    expect(run(["--first-party-prefix", "apps/demo/"]).code).toBe(0);

    writeFileSync(join(dist, "apps", "demo", "data.json"), "{}");
    expect(run(["--first-party-prefix", "apps/demo/"]).out).toMatch(/not-allowlisted: apps\/demo\/data\.json/);

    // A prefix that would open the whole apps/ tree is itself refused.
    expect(run(["--first-party-prefix", "apps/"]).code).not.toBe(0);
  });
});

describe("C24 criteria 3, 4, 8: the fixture app builds end to end", () => {
  it("injects the tags after the SDK tag, in a fixed order, and ships compiled JS with no .ts", () => {
    const result = buildFixture();
    const html = readFileSync(join(result.outDir, "index.html"), "utf8");
    const scriptTag = '<script type="module" src="apps/fp-fixture/main.js" data-app="fp-fixture"></script>';
    const linkTag = '<link rel="stylesheet" href="apps/fp-fixture/fixture.css" data-app="fp-fixture">';
    expect(html).toContain(scriptTag);
    expect(html).toContain(linkTag);

    const lines = html.split("\n").map((l) => l.trim());
    const sdk = lines.indexOf('<script src="sdk/fulc-sdk.umd.js" data-core></script>');
    expect(sdk).toBeGreaterThan(-1);
    expect(lines.indexOf(scriptTag)).toBe(sdk + 1);
    expect(lines.indexOf(linkTag)).toBe(sdk + 2);
    // Every data-core tag comes before the first first-party tag.
    const lastCore = lines.reduce((acc, l, i) => (/data-core/.test(l) ? i : acc), -1);
    expect(lastCore).toBeLessThan(lines.indexOf(scriptTag));

    const shipped = result.copiedFiles;
    expect(shipped).toContain("apps/fp-fixture/main.js");
    expect(shipped).toContain("apps/fp-fixture/view.js");
    expect(shipped).toContain("apps/fp-fixture/fixture.css");
    expect(shipped).toContain("apps/_shared/label.js");
    expect(shipped).toContain("sdk/fulc-sdk.js");
    expect(shipped).toContain("runtime/jsx-runtime.js");
    expect(shipped).toContain("runtime/h.js");
    expect(shipped.filter((p) => /\.tsx?$/.test(p))).toEqual([]);
    expect(shipped).not.toContain("apps/fp-fixture/manifest.json");

    const onDisk = walk(result.outDir);
    expect(onDisk.filter((p) => /\.tsx?$/.test(p))).toEqual([]);
    expect(onDisk.some((p) => p.endsWith("manifest.json") && p.includes("fp-fixture"))).toBe(false);
  });

  it("compiles TSX against the shell's own JSX runtime, with real .js specifiers and no sinks", () => {
    const result = buildFixture();
    const view = readFileSync(shippedPath(result, "apps/fp-fixture/view.js"), "utf8");
    expect(view).toContain('from "../../runtime/jsx-runtime.js"');
    expect(view).not.toMatch(/\binterface\b/);
    expect(view).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    const main = readFileSync(shippedPath(result, "apps/fp-fixture/main.js"), "utf8");
    expect(main).toContain('from "../../sdk/fulc-sdk.js"');
    expect(main).toContain('from "../_shared/label.js"');
    const lib = readFileSync(shippedPath(result, "apps/_shared/label.js"), "utf8");
    expect(lib).not.toMatch(/: number|: string/);
  });

  it("the fixture app's own sources use no innerHTML (or another sink)", () => {
    for (const rel of walk(FIXTURE_APPS).filter((p) => /\.(tsx?|css)$/.test(p))) {
      const text = readFileSync(join(FIXTURE_APPS, rel), "utf8");
      const code = text.replace(/\/\/.*$/gm, "");
      expect(code, rel).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    }
  });

  it("every import in the shipped first-party output resolves to a shipped file", () => {
    const result = buildFixture();
    const shipped = new Set(result.copiedFiles);
    for (const rel of result.copiedFiles.filter((p) => p.startsWith("apps/fp-fixture/") || p.startsWith("apps/_shared/"))) {
      if (!rel.endsWith(".js")) continue;
      const text = readFileSync(shippedPath(result, rel), "utf8");
      for (const m of text.matchAll(/from "(\.[^"]+)"/g)) {
        const target = join("/", dirname(rel), m[1]).split(sep).join("/").slice(1);
        expect(shipped.has(target), `${rel} imports ${m[1]}`).toBe(true);
      }
    }
  });

  it("build is reproducible: same inputs, same hash", () => {
    expect(buildFixture().hash).toBe(buildFixture().hash);
  });

  it("an app the profile does not list gets no tags and none of its files (nor its libs) are copied", () => {
    const result = buildFixture({ profilePath: REAL_PROFILE });
    const html = readFileSync(join(result.outDir, "index.html"), "utf8");
    expect(html).not.toContain("fp-fixture");
    expect(result.copiedFiles.filter((p) => p.startsWith("apps/fp-fixture/") || p.startsWith("apps/_shared/"))).toEqual([]);
    expect(result.copiedFiles).not.toContain("sdk/fulc-sdk.js");
  });
});

describe("C24 criterion 4: imports from first-party files", () => {
  function twoFileApp(mainSource) {
    return appsTree({
      "demo/manifest.json": manifestOf({}),
      "demo/main.js": mainSource,
    });
  }
  const profile = () => {
    const p = JSON.parse(readFileSync(REAL_PROFILE, "utf8"));
    p.app_modules.push("demo");
    const path = join(scratchDir("ws-f0-prof-"), "profile.json");
    writeFileSync(path, JSON.stringify(p));
    return path;
  };
  const run = (src) => build({ profilePath: profile(), appsDir: twoFileApp(src), outDir: scratchDir("ws-f0-out-") });

  it("a plain .js app builds without compilation", () => {
    const result = run('import { register } from "../../sdk/fulc-sdk.js";\nregister({ id: "demo", title: "Demo" });\n');
    expect(result.copiedFiles).toContain("apps/demo/main.js");
    expect(result.copiedFiles).toContain("sdk/fulc-sdk.js");
  });

  it("a multi-line import is followed", () => {
    const result = run('import {\n  register,\n  ready,\n} from "../../sdk/fulc-sdk.js";\nregister({ id: "demo", title: "Demo" });\nready(() => {});\n');
    expect(result.copiedFiles).toContain("sdk/fulc-sdk.js");
  });

  it("an import of a missing file fails the build", () => {
    expect(() => run('import "./missing.js";\n')).toThrow(/missing/);
  });

  it("an import that escapes the served root fails the build (CWE-22)", () => {
    expect(() => run('import "../../../../outside.js";\n')).toThrow(/outside/);
  });

  it("an import spelled with a .ts extension is refused rather than shipping source", () => {
    const dir = appsTree({
      "demo/manifest.json": manifestOf({}),
      "demo/main.js": 'import "./helper.ts";\n',
      "demo/helper.ts": "export {};\n",
    });
    expect(() => build({ profilePath: profile(), appsDir: dir, outDir: scratchDir("ws-f0-out-") })).toThrow(/helper\.ts/);
  });
});

describe("C24 criterion 9: the production build does not change", () => {
  it("with no first-party app listed, the real profile builds the same file set and hash whatever apps/ holds", () => {
    // The real profile now lists real first-party apps, so take them out of a
    // copy: the property is about a profile that lists none.
    const realIds = new Set(loadFirstPartyApps(join(WORKSPACE_DIR, "apps"), { shellDir: SHELL_DIR }).apps.map((x) => x.id));
    const real = JSON.parse(readFileSync(REAL_PROFILE, "utf8"));
    real.app_modules = real.app_modules.filter((id) => !realIds.has(id));
    const profilePath = join(scratchDir("ws-f0-prof-"), "profile.json");
    writeFileSync(profilePath, JSON.stringify(real));

    const empty = scratchDir("ws-f0-empty-");
    const a = build({ profilePath, outDir: scratchDir("ws-f0-out-") });
    const b = build({ profilePath, appsDir: empty, outDir: scratchDir("ws-f0-out-") });
    // A real app dir that no profile lists changes nothing either.
    const c = build({ profilePath, appsDir: FIXTURE_APPS, outDir: scratchDir("ws-f0-out-") });
    expect(b.hash).toBe(a.hash);
    expect(c.hash).toBe(a.hash);
    expect(c.copiedFiles).toEqual(a.copiedFiles);
    expect(existsSync(shippedPath(a, "index.html"))).toBe(true);
    expect(a.copiedFiles.some((p) => p.startsWith("apps/fp-") || p.startsWith("apps/_"))).toBe(false);
  });

  it("a first-party app the real profile lists ships its tags and files; one it does not list ships nothing", () => {
    // WS-F0 merged with none listed; each WS-F task adds its own id to
    // app_modules and this holds for it too.
    const profile = JSON.parse(readFileSync(REAL_PROFILE, "utf8"));
    const model = loadFirstPartyApps(join(WORKSPACE_DIR, "apps"), { shellDir: SHELL_DIR });
    const result = build({ outDir: scratchDir("ws-f0-out-") });
    const html = readFileSync(join(result.outDir, "index.html"), "utf8");
    for (const app of model.apps) {
      const listed = profile.app_modules.includes(app.id);
      expect(html.includes(`data-app="${app.id}"`), app.id).toBe(listed);
      expect(result.copiedFiles.some((f) => f.startsWith(`apps/${app.id}/`)), app.id).toBe(listed);
    }
  });
});
