// apps/workspace/test/strip-comments.test.mjs
//
// D#37 WS-D4: the dist-only comment stripper (build/strip-comments.mjs).
//
//   1. Adversarial fixtures: a comment-looking sequence inside a string, a
//      template literal, a regex literal, a CSS string or a CSS url() must
//      survive byte for byte; real comments go.
//   2. Kept comments: licence text, source-map and bundler directives.
//   3. Round trip on the real workspace: build it twice (comments kept, then
//      stripped), parse every shipped JS file from both with the TypeScript
//      parser and require the same syntax tokens, so the strip changes
//      nothing but comments and whitespace.
//   4. Source files are never written, and the byte report is printed.

import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { stripCssComments, stripJsComments, stripShippedComments } from "../build/strip-comments.mjs";
import { build, shippedPath } from "../build/build.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = join(TEST_DIR, "..");

describe("stripJsComments: comments go", () => {
  it("removes line and block comments, and the lines they alone occupied", () => {
    const src = ["// header", "const a = 1; // trailing", "/* block */", "", "", "/**", " * doc", " */", "const b = 2;", ""].join("\n");
    expect(stripJsComments(src)).toBe("const a = 1;\nconst b = 2;\n");
  });

  it("keeps a newline where a block comment contained one (ASI sees the same line break)", () => {
    expect(stripJsComments("let a = 1\n/* x\n y */\nlet b = 2")).toBe("let a = 1\nlet b = 2");
    expect(stripJsComments("return /* x\n y */ 1")).toBe("return\n 1");
  });

  it("never glues two tokens together", () => {
    expect(stripJsComments("a+/**/+b")).toBe("a+ +b");
    expect(stripJsComments("a/**/b")).toBe("a b");
    expect(stripJsComments("f(/**/x/**/)")).toBe("f(x)");
  });

  it("leaves a comment-free file byte-identical apart from blank lines and trailing blanks", () => {
    const src = "const x = [1, 2];\nfunction f() {\n  return x;\n}\n";
    expect(stripJsComments(src)).toBe(src);
  });
});

describe("stripJsComments: comment-looking text inside literals survives", () => {
  it('"//" and "/*" in single- and double-quoted strings', () => {
    const src = `const a = "//"; // gone\nconst b = '/* x */'; /* gone */\nconst u = "http://example.test/a";\n`;
    expect(stripJsComments(src)).toBe(`const a = "//";\nconst b = '/* x */';\nconst u = "http://example.test/a";\n`);
  });

  it("escaped quotes and line continuations inside strings", () => {
    const src = 'const a = "say \\"//\\" now"; // gone\nconst b = "one \\\n// two";\n';
    expect(stripJsComments(src)).toBe('const a = "say \\"//\\" now";\nconst b = "one \\\n// two";\n');
  });

  it("template literals, with their blank lines, nested templates and ${} code", () => {
    const src = [
      "const t = `line /* not a comment */",
      "",
      "// still text ${a /* real */ + `inner // text ${b}`} end`; // gone",
      "const n = `${ {k: 1}.k }`; /* gone */",
      "",
    ].join("\n");
    const want = [
      "const t = `line /* not a comment */",
      "",
      "// still text ${a + `inner // text ${b}`} end`;",
      "const n = `${ {k: 1}.k }`;",
      "",
    ].join("\n");
    expect(stripJsComments(src)).toBe(want);
  });

  it("regex literals, including escaped slashes, comment openers and character classes", () => {
    const src = [
      "const r1 = /\\/\\*/; // gone",
      "const r2 = /[/*]/g; /* gone */",
      "const r3 = /a\\/\\/b/i;",
      "const r4 = str.replace(/\\/\\/.*$/, '');",
      "if (ok) return /\\*\\//.test(s);",
      "",
    ].join("\n");
    const want = [
      "const r1 = /\\/\\*/;",
      "const r2 = /[/*]/g;",
      "const r3 = /a\\/\\/b/i;",
      "const r4 = str.replace(/\\/\\/.*$/, '');",
      "if (ok) return /\\*\\//.test(s);",
      "",
    ].join("\n");
    expect(stripJsComments(src)).toBe(want);
  });

  it("tells division from a regex literal", () => {
    const src = "const a = x / y / z; // gone\nconst b = (x) / 2 / 3;\nlet c = i++ / 2 // gone\nconst d = arr[0] / 2; /* gone */\nconst e = o.return / 2;\n";
    expect(stripJsComments(src)).toBe("const a = x / y / z;\nconst b = (x) / 2 / 3;\nlet c = i++ / 2\nconst d = arr[0] / 2;\nconst e = o.return / 2;\n");
  });

  it("a comment right after a regex literal and a string is still removed", () => {
    expect(stripJsComments("x = /a/ // c\ny = 'b' // c\n")).toBe("x = /a/\ny = 'b'\n");
  });

  it('keeps "use strict" and other string directives', () => {
    expect(stripJsComments('"use strict"; // gone\n')).toBe('"use strict";\n');
  });

  it("a // comment ends at LF, CR, U+2028 and U+2029, and the terminator stays", () => {
    for (const term of ["\n", "\r", "\u2028", "\u2029"]) {
      const out = stripJsComments(`x=1 // c${term} y=1`);
      expect(out, JSON.stringify(term)).toContain("y=1");
      expect(out.startsWith("x=1"), JSON.stringify(term)).toBe(true);
      expect(out, JSON.stringify(term)).not.toContain("// c");
      expect(out.includes(term), JSON.stringify(term)).toBe(true);
    }
    expect(stripJsComments("x=1 // c\u2028 y=1")).toBe("x=1\u2028 y=1");
    expect(stripJsComments("x=1 // c\u2029 y=1")).toBe("x=1\u2029 y=1");
    expect(stripJsComments("x=1 // c\r y=1")).toBe("x=1\r y=1");
    expect(stripJsComments("x=1 // c\r\ny=1\r\n")).toBe("x=1\ny=1\n");
  });

  it("U+2028 / U+2029 / CR stay line terminators for ASI, regex and string decisions", () => {
    // `return` + terminator + value is `return; value`: the terminator must survive a comment.
    expect(stripJsComments("return /* c */\u2028 1")).toBe("return\u2028 1");
    expect(stripJsComments("return /* a\u2029b */ 1")).toBe("return\n 1");
    expect(stripJsComments("return /* a\rb */ 1")).toBe("return\n 1");
    // They are not identifier characters: a division after one is still a division.
    expect(stripJsComments("a = b\u2028/ 2 // c\n")).toBe("a = b\u2028/ 2\n");
    // A regex literal cannot contain one.
    expect(() => stripJsComments("x = /a\u2028b/")).toThrow(/unterminated regex/);
    expect(() => stripJsComments("x = /a\rb/")).toThrow(/unterminated regex/);
    // U+2028 inside a string is legal (ES2019) and untouched; a raw CR is not.
    expect(stripJsComments('s = "a\u2028// b"; // c\n')).toBe('s = "a\u2028// b";\n');
    expect(() => stripJsComments('s = "a\rb"')).toThrow(/unterminated string/);
    // CRLF line continuation inside a string.
    expect(stripJsComments('s = "a\\\r\n// b"; // c\r\n')).toBe('s = "a\\\r\n// b";\n');
    // Hashbang line ends at any terminator.
    expect(stripJsComments("#!/x\u2028// c\nrun();")).toBe("#!/x\u2028\nrun();");
  });

  it("fails closed on input it cannot read", () => {
    expect(() => stripJsComments("const a = 'open")).toThrow(/unterminated string/);
    expect(() => stripJsComments("const a = `open")).toThrow(/unterminated template/);
    expect(() => stripJsComments("/* open")).toThrow(/unterminated block comment/);
    expect(() => stripJsComments("x = /open\n")).toThrow(/unterminated regex/);
  });
});

describe("stripJsComments: comments that are kept", () => {
  it("licence and directive comments", () => {
    const lic = "/*!\n * (c) Somebody\n */\n";
    expect(stripJsComments(lic + "// gone\nvar a;\n")).toBe(lic + "var a;\n");
    expect(stripJsComments("/* @license MIT */\nvar a;\n")).toBe("/* @license MIT */\nvar a;\n");
    expect(stripJsComments("/** @preserve x */\nvar a;\n")).toBe("/** @preserve x */\nvar a;\n");
    expect(stripJsComments("//! keep\nvar a;\n")).toBe("//! keep\nvar a;\n");
    expect(stripJsComments("var a;\n//# sourceMappingURL=a.js.map\n")).toBe("var a;\n//# sourceMappingURL=a.js.map\n");
    expect(stripJsComments("import(/* @vite-ignore */ u);")).toBe("import(/* @vite-ignore */ u);");
    expect(stripJsComments("import(/* webpackIgnore: true */ u);")).toBe("import(/* webpackIgnore: true */ u);");
    expect(stripJsComments("var a = /*#__PURE__*/ f();")).toBe("var a = /*#__PURE__*/ f();");
  });

  it("a leading hashbang line", () => {
    expect(stripJsComments("#!/usr/bin/env node\n// gone\nrun();\n")).toBe("#!/usr/bin/env node\nrun();\n");
  });
});

describe("stripCssComments", () => {
  it("removes comments and the lines they alone occupied", () => {
    const src = "/* header */\na { color: red; /* c */ }\n\n\n/* multi\n   line */\nb { top: 0 }\n";
    expect(stripCssComments(src)).toBe("a { color: red; }\nb { top: 0 }\n");
  });

  it('content:"/*" and other strings keep their text', () => {
    const src = `a::before { content: "/*"; } /* gone */\nb::after { content: '*/ //'; }\n`;
    expect(stripCssComments(src)).toBe(`a::before { content: "/*"; }\nb::after { content: '*/ //'; }\n`);
  });

  it("url() with a scheme-relative host, unquoted, with a comment opener, and quoted", () => {
    const src = [
      "a { background: url(//host.test/x.png); } /* gone */",
      "b { background: url(/* not a comment */x.png); }",
      'c { background: url("//host.test/y.png") /* gone */; }',
      "d { background: URL( '//h/z.png' ); }",
      "",
    ].join("\n");
    const want = [
      "a { background: url(//host.test/x.png); }",
      "b { background: url(/* not a comment */x.png); }",
      'c { background: url("//host.test/y.png") ; }',
      "d { background: URL( '//h/z.png' ); }",
      "",
    ].join("\n");
    expect(stripCssComments(src)).toBe(want);
  });

  it("keeps licence comments and does not glue tokens", () => {
    expect(stripCssComments("/*! keep */\na{}\n")).toBe("/*! keep */\na{}\n");
    expect(stripCssComments("/* @license x */\na{}\n")).toBe("/* @license x */\na{}\n");
  });

  it("a removed comment inserts nothing, so compound selectors stay compound", () => {
    expect(stripCssComments("a/**/.b{}")).toBe("a.b{}");
    expect(stripCssComments("a/**/:hover{}")).toBe("a:hover{}");
    expect(stripCssComments("a/**/[x]{}")).toBe("a[x]{}");
    expect(stripCssComments("a/**/#i{}")).toBe("a#i{}");
    expect(stripCssComments("a/**/>/**/b{}")).toBe("a>b{}");
    expect(stripCssComments("a { top:/**/0/**/;/**/left:1px }")).toBe("a { top:0;left:1px }");
  });

  it("a space that was already there is kept, once", () => {
    expect(stripCssComments("a /**/ .b{}")).toBe("a .b{}");
    expect(stripCssComments("a /**/.b{}")).toBe("a .b{}");
    expect(stripCssComments("a/**/ .b{}")).toBe("a .b{}");
  });

  it("where both sides would fuse into one token, an empty comment stays (div/**/span is never divspan, never a descendant)", () => {
    // `div/**/span` is two adjacent type selectors (no combinator): invalid, and it must stay as it was,
    // not become the valid descendant `div span` and not the different type selector `divspan`.
    expect(stripCssComments("div/**/span{}")).toBe("div/**/span{}");
    expect(stripCssComments("div/* gone */span{}")).toBe("div/**/span{}");
    expect(stripCssComments("a{margin:1px/**/solid}")).toBe("a{margin:1px/**/solid}");
    expect(stripCssComments("a{width:1/**/.5px}")).toBe("a{width:1/**/.5px}");
    expect(stripCssComments("a{b:url/**/(x)}")).toBe("a{b:url/**/(x)}");
    expect(stripCssComments("@/**/media x{}")).toBe("@/**/media x{}");
    expect(stripCssComments("a[x~/**/=y]{}")).toBe("a[x~/**/=y]{}");
    expect(stripCssComments("a{x:-/**/webkit}")).toBe("a{x:-/**/webkit}");
    // a multi-line comment is not whitespace either
    expect(stripCssComments("a/* x\n y */.b{}")).toBe("a.b{}");
    expect(stripCssComments("a/* x\n y */b{}")).toBe("a/**/b{}");
  });

  it("escapes and fail-closed behaviour", () => {
    expect(stripCssComments('a { content: "\\"/*"; } /* c */\n')).toBe('a { content: "\\"/*"; }\n');
    expect(() => stripCssComments("a { /* open")).toThrow(/unterminated CSS comment/);
    expect(() => stripCssComments('a { content: "open')).toThrow(/unterminated CSS string/);
  });
});

describe("stripShippedComments", () => {
  it("dispatches on the extension and leaves every other file alone", () => {
    expect(stripShippedComments("a.js", "// c\nx;\n")).toBe("x;\n");
    expect(stripShippedComments("a.mjs", "// c\nx;\n")).toBe("x;\n");
    expect(stripShippedComments("a.css", "/* c */\na{}\n")).toBe("a{}\n");
    const json = '{"a": "// not a comment"}\n';
    expect(stripShippedComments("a.json", json)).toBe(json);
    const html = "<!-- keep -->\n<p>x</p>\n";
    expect(stripShippedComments("index.html", html)).toBe(html);
  });
});

// ---------------------------------------------------------------------------
// The real workspace, built with and without the strip.
// ---------------------------------------------------------------------------

// esbuild is not a direct dependency; it comes with vitest -> vite, so it is
// reached through that chain (no new dependency, no second copy).
function loadEsbuild() {
  const req = createRequire(import.meta.url);
  const viteReq = createRequire(createRequire(req.resolve("vitest/package.json")).resolve("vite/package.json"));
  return viteReq("esbuild");
}

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function realBuild(stripComments) {
  const base = mkdtempSync(join(tmpdir(), "ws-strip-"));
  tmpDirs.push(base);
  return build({ outDir: join(base, "dist"), stripComments });
}

function brotliTotal(result) {
  let total = 0;
  for (const relPath of result.bootFiles) {
    const buf = readFileSync(shippedPath(result, relPath));
    total += zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  }
  return total;
}

// The token stream of a JS file as the TypeScript parser reads it, JSDoc
// nodes left out (they are comments that the parser happens to model).
function syntaxTokens(ts, text, name) {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const tokens = [];
  const walk = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = node.getChildren(sf);
    if (kids.length === 0) tokens.push(`${node.kind}:${node.getText(sf)}`);
    else kids.forEach(walk);
  };
  walk(sf);
  return { tokens, diagnostics: sf.parseDiagnostics.length };
}

describe("the real workspace build, stripped", () => {
  it("changes only comments and whitespace: identical syntax tokens in every shipped JS file", () => {
    const ts = createRequire(import.meta.url)("typescript");
    const kept = realBuild(false);
    const stripped = realBuild(true);
    expect(stripped.copiedFiles).toEqual(kept.copiedFiles);

    const jsFiles = kept.copiedFiles.filter((p) => /\.m?js$/.test(p));
    expect(jsFiles.length).toBeGreaterThan(50);
    for (const relPath of jsFiles) {
      const a = syntaxTokens(ts, readFileSync(shippedPath(kept, relPath), "utf8"), relPath);
      const b = syntaxTokens(ts, readFileSync(shippedPath(stripped, relPath), "utf8"), relPath);
      expect(b.diagnostics, relPath).toBe(a.diagnostics);
      expect(b.tokens.length, relPath).toBe(a.tokens.length);
      const at = a.tokens.findIndex((t, i) => t !== b.tokens[i]);
      expect(at === -1 ? null : `${relPath}: ${a.tokens[at]} vs ${b.tokens[at]}`).toBeNull();
    }
  });

  it("CSS: esbuild-minified output is identical for kept and stripped, in every shipped CSS file", () => {
    const esbuild = loadEsbuild();
    const kept = realBuild(false);
    const stripped = realBuild(true);
    const cssFiles = kept.copiedFiles.filter((p) => p.endsWith(".css"));
    expect(cssFiles.length).toBeGreaterThan(10);
    for (const relPath of cssFiles) {
      const min = (r) =>
        esbuild.transformSync(readFileSync(shippedPath(r, relPath), "utf8"), { loader: "css", minify: true }).code;
      expect(min(stripped), relPath).toBe(min(kept));
    }
  });

  it("ships no whole-line comment in JS or CSS, keeps the SDK licence header, and leaves non-code files alone", () => {
    const kept = realBuild(false);
    const stripped = realBuild(true);
    for (const relPath of stripped.copiedFiles.filter((p) => /\.(?:m?js|css)$/.test(p))) {
      const text = readFileSync(shippedPath(stripped, relPath), "utf8");
      for (const line of text.split("\n")) {
        if (/^\s*\/\//.test(line) && !/^\s*\/\/!/.test(line) && !/@license|@preserve|sourceMappingURL/.test(line)) {
          // A line that starts with // is only legitimate inside a template literal or string;
          // the shipped tree has none, so a hit here means a comment survived.
          throw new Error(`${relPath}: whole-line comment survived: ${line.slice(0, 80)}`);
        }
      }
    }
    expect(readFileSync(shippedPath(stripped, "sdk/fulc-sdk.umd.js"), "utf8").startsWith("/*!")).toBe(true);
    for (const relPath of kept.copiedFiles.filter((p) => p.endsWith(".json"))) {
      expect(readFileSync(shippedPath(stripped, relPath), "utf8")).toBe(readFileSync(shippedPath(kept, relPath), "utf8"));
    }
  });

  it("never writes to the source tree, and prints the byte report", () => {
    const sdk = join(WORKSPACE_DIR, "shell", "sdk", "fulc-sdk.umd.js");
    const before = readFileSync(sdk, "utf8");
    const kept = realBuild(false);
    const stripped = realBuild(true);
    expect(readFileSync(sdk, "utf8")).toBe(before);
    expect(before).toContain("// ── types.js");

    const rawBefore = stripped.stripReport.reduce((a, r) => a + r.before, 0);
    const rawAfter = stripped.stripReport.reduce((a, r) => a + r.after, 0);
    const brotliBefore = brotliTotal(kept);
    const brotliAfter = brotliTotal(stripped);
    console.log(
      `strip report: ${stripped.stripReport.length} JS/CSS files, raw ${rawBefore} -> ${rawAfter} B; ` +
        `boot set (${stripped.bootFiles.length} files) brotli q11 ${brotliBefore} -> ${brotliAfter} B (-${brotliBefore - brotliAfter})`,
    );
    expect(kept.stripReport).toEqual([]);
    expect(rawAfter).toBeLessThan(rawBefore);
    // The strip is worth keeping only while it pays: C46 asked for at least 80,000 B off the boot set.
    expect(brotliBefore - brotliAfter).toBeGreaterThanOrEqual(80_000);
  });
});
