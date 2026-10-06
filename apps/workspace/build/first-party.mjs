// apps/workspace/build/first-party.mjs
//
// D#37 Correction C24, task WS-F0: the build plumbing for first-party
// fulcrumaxe-os SDK apps. This is NOT an app framework and NOT React: an app
// is a directory under apps/workspace/apps/<id>/ holding a manifest.json plus
// .js/.ts/.tsx/.css files, which call FULC.register (shell/sdk/app.js) and
// may write TSX against the shell's own runtime/jsx-runtime.js. This module
// only decides which of those files ship, and how:
//
//   - loadFirstPartyApps()   scans + validates apps/ (layout, extension
//                            allowlist, manifests, id collisions).
//   - createFirstPartyOutput() resolves a dist-space path ("apps/<id>/x.js")
//                            to compiled bytes, and lists a file's relative
//                            import specifiers. TS/TSX is compiled per file by
//                            typescript's transpileModule (jsx "react-jsx",
//                            ES module output); plain .js is copied as is.
//   - renderTags()           the index.html tags for the apps a profile lists.
//
// Import specifiers inside a first-party file are spelled in DIST space, the
// same space the browser resolves them in: "../../sdk/fulc-sdk.js" is
// shell/sdk/fulc-sdk.js, and "./view.js" is view.js, view.ts or view.tsx in
// the same app directory. A specifier must end in ".js" (or ".css"); a ".ts"
// specifier is refused so no TypeScript source can ship.

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix } from "node:path";

import { pathIsSecretShaped } from "../import/rules.mjs";

// C24 criterion 2.
export const FIRST_PARTY_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
// A shared library directory: "_" then the same shape, e.g. "_lib".
const LIB_NAME_RE = /^_[a-z0-9][a-z0-9_-]{0,30}$/;
// C24 criterion 7: the only file types allowed under apps/workspace/apps/.
const ALLOWED_SOURCE_RE = /\.(?:js|ts|tsx|css)$/;
const SOURCE_TO_OUTPUT_EXT = { ".js": ".js", ".ts": ".js", ".tsx": ".js", ".css": ".css" };
const TOP_LEVEL_ALLOWED_FILES = new Set(["README.md"]);

const require = createRequire(import.meta.url);
let tsModule = null;
// Lazy: typescript is a large module, and a build with no first-party app in
// play (every production build at WS-F0's merge) never needs it.
function loadTypescript() {
  if (tsModule === null) tsModule = require("typescript");
  return tsModule;
}

// One path segment of a manifest entry / style: letters, digits, "." "_" "-",
// first character a letter or digit (so no leading dot, and no "." / "..").
const MANIFEST_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Attribute-value escaping for renderTags(): a second layer behind the
// manifest allowlist, so a future relaxation of one cannot reopen the other.
export function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "&#96;")
    .replace(/[\u0000- \u007f]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function extOf(p) {
  const i = p.lastIndexOf(".");
  return i === -1 ? "" : p.slice(i);
}

// A manifest path (entry / a style): relative, POSIX, inside the app's own
// directory, no traversal, no URL, no query. Returns the normalised path or
// throws. (C24 criterion 2.)
function validateManifestPath(appId, field, value, allowedExts) {
  const where = `first-party app "${appId}": manifest ${field}`;
  if (typeof value !== "string" || value === "") {
    throw new Error(`first-party.mjs: ${where} must be a non-empty string`);
  }
  if (value.length > 200 || /[\\\0:?#%]/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`first-party.mjs: ${where} "${value}" is not a plain relative path (no backslash, scheme, query, fragment or escape)`);
  }
  if (value.startsWith("/")) {
    throw new Error(`first-party.mjs: ${where} "${value}" must be relative to the app directory, not absolute`);
  }
  for (const seg of value.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new Error(`first-party.mjs: ${where} "${value}" must stay inside the app directory (no empty, "." or ".." segment)`);
    }
    // CWE-79/116: the path is interpolated into an index.html attribute, and
    // a file name may legally hold a quote, "<", ">" or whitespace. Only a
    // strict charset gets through; no segment starts with a dot.
    if (!MANIFEST_SEGMENT_RE.test(seg)) {
      throw new Error(
        `first-party.mjs: ${where} ${JSON.stringify(value)} has a segment outside the allowed charset (a letter or digit, then letters, digits, ".", "_" or "-")`
      );
    }
  }
  if (!allowedExts.includes(extOf(value))) {
    throw new Error(`first-party.mjs: ${where} "${value}" must end in ${allowedExts.join(", ")}`);
  }
  return value;
}

// Every directory and file name under apps/<name>/ gets the same per-segment
// charset as a manifest path. Names reach dist/ (and, for files reached only
// by import, a <link rel="modulepreload"> tag in index.html), so a quote,
// angle bracket, space or non-ASCII look-alike in ANY name is refused rather
// than trusted to a downstream escape. The scan only RECORDS the first
// offender; loadFirstPartyApps throws after the manifest is validated, so a
// bad manifest entry/styles still reports as such.
function noteUnsafeName(name, rel, acc) {
  if (!MANIFEST_SEGMENT_RE.test(name)) acc.push({ rel, kind: "badname" });
}

// Recursive scan. Every file must be a regular file with an allowed
// extension and a non-secret-shaped path; symlinks and other entries are
// refused outright (checks.mjs does the same for dist/).
function scanApp(absDir, relBase, acc) {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    const rel = `${relBase}/${entry.name}`;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      throw new Error(`first-party.mjs: ${rel} is a symlink; first-party apps may hold regular files only`);
    }
    if (st.isDirectory()) {
      noteUnsafeName(entry.name, rel, acc);
      scanApp(abs, rel, acc);
      continue;
    }
    if (!st.isFile()) {
      throw new Error(`first-party.mjs: ${rel} is not a regular file`);
    }
    if (pathIsSecretShaped(rel)) {
      throw new Error(`first-party.mjs: ${rel} has a dotfile or secret-shaped path`);
    }
    noteUnsafeName(entry.name, rel, acc);
    if (entry.name === "manifest.json" && relBase.split("/").length === 1) {
      acc.push({ rel, abs, kind: "manifest" });
      continue;
    }
    if (!ALLOWED_SOURCE_RE.test(entry.name)) {
      throw new Error(
        `first-party.mjs: ${rel} is not allowed under apps/ (only manifest.json, *.js, *.ts, *.tsx and *.css)`
      );
    }
    acc.push({ rel, abs, kind: "source" });
  }
}

/**
 * Scans and validates `appsDir`.
 *
 * @returns {{
 *   appsDir: string,
 *   apps: Array<{ id: string, entry: string, styles: string[] }>,
 *   libs: string[],
 *   sources: Map<string, string>,   // dist-space path -> absolute source path
 * }}
 * `sources` is keyed by the OUTPUT path ("apps/<name>/x.js" for x.js, x.ts
 * or x.tsx), so a lookup by what the browser will request is one Map.get.
 */
export function loadFirstPartyApps(appsDir, { shellDir, shellIndexHtml } = {}) {
  const apps = [];
  const libs = [];
  const sources = new Map();
  if (!existsSync(appsDir)) return { appsDir, apps, libs, sources };

  const shellAppIds = new Set();
  if (shellIndexHtml === undefined && shellDir && existsSync(join(shellDir, "index.html"))) {
    shellIndexHtml = readFileSync(join(shellDir, "index.html"), "utf8");
  }
  if (typeof shellIndexHtml === "string") {
    for (const m of shellIndexHtml.matchAll(/\bdata-app="([^"]+)"/g)) shellAppIds.add(m[1]);
    for (const m of shellIndexHtml.matchAll(/\b(?:src|href)="apps\/([^/"]+)\//g)) shellAppIds.add(m[1]);
  }

  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    const abs = join(appsDir, entry.name);
    if (!entry.isDirectory()) {
      if (lstatSync(abs).isFile() && TOP_LEVEL_ALLOWED_FILES.has(entry.name)) continue;
      throw new Error(`first-party.mjs: apps/${entry.name} is not allowed (only app directories and README.md)`);
    }
    const name = entry.name;
    const isLib = name.startsWith("_");
    if (isLib ? !LIB_NAME_RE.test(name) : !FIRST_PARTY_ID_RE.test(name)) {
      throw new Error(
        `first-party.mjs: apps/${name} is not a valid first-party app id (id must match ${FIRST_PARTY_ID_RE}) or "_"-prefixed library name`
      );
    }
    // C24 criterion 5: an id (or library name) that an imported app already
    // owns fails the build, naming the id.
    if (
      (shellDir && existsSync(join(shellDir, "apps", name))) ||
      shellAppIds.has(name)
    ) {
      throw new Error(
        `first-party.mjs: first-party id "${name}" collides with the imported app shell/apps/${name}/ (or a data-app tag of that name in index.html)`
      );
    }

    const files = [];
    scanApp(abs, name, files);
    const manifestFile = files.find((f) => f.kind === "manifest");

    if (isLib) {
      if (manifestFile) {
        throw new Error(`first-party.mjs: ${name} is a "_"-prefixed shared library and must not have a manifest.json`);
      }
      libs.push(name);
    } else {
      if (!manifestFile) {
        throw new Error(`first-party.mjs: first-party app "${name}" has no manifest.json`);
      }
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestFile.abs, "utf8"));
      } catch (e) {
        throw new Error(`first-party.mjs: ${name}/manifest.json is not valid JSON (${e.message})`);
      }
      if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
        throw new Error(`first-party.mjs: ${name}/manifest.json must be a JSON object`);
      }
      if (manifest.id !== name) {
        throw new Error(`first-party.mjs: ${name}/manifest.json id "${String(manifest.id)}" must equal the directory name "${name}"`);
      }
      const entryPath = validateManifestPath(name, "entry", manifest.entry, [".js", ".ts", ".tsx"]);
      let styles = [];
      if (manifest.styles !== undefined) {
        if (!Array.isArray(manifest.styles)) {
          throw new Error(`first-party.mjs: first-party app "${name}": manifest styles must be a list of paths`);
        }
        styles = manifest.styles.map((s) => validateManifestPath(name, "styles", s, [".css"]));
      }
      apps.push({ id: name, entry: entryPath, styles });
    }

    const badName = files.find((f) => f.kind === "badname");
    if (badName) {
      throw new Error(
        `first-party.mjs: ${JSON.stringify(badName.rel)} has a name outside the allowed charset (a letter or digit, then letters, digits, ".", "_" or "-")`
      );
    }

    // Register outputs; two sources compiling to one output is a conflict.
    for (const f of files) {
      if (f.kind !== "source") continue;
      const outRel = `apps/${f.rel.slice(0, f.rel.length - extOf(f.rel).length)}${SOURCE_TO_OUTPUT_EXT[extOf(f.rel)]}`;
      if (sources.has(outRel)) {
        throw new Error(`first-party.mjs: two source files compile to ${outRel} (${sources.get(outRel)} and ${f.abs})`);
      }
      sources.set(outRel, f.abs);
    }
    // The manifest's files must exist (entry may be .ts/.tsx).
    if (!isLib) {
      const app = apps[apps.length - 1];
      for (const [field, rel] of [["entry", app.entry], ...app.styles.map((s) => ["styles", s])]) {
        if (!sources.has(distPathOf(name, rel))) {
          throw new Error(`first-party.mjs: first-party app "${name}": manifest ${field} "${rel}" does not exist`);
        }
      }
    }
  }

  apps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  libs.sort();
  return { appsDir, apps, libs, sources };
}

// "apps/<id>/<rel>" with a .ts/.tsx extension renamed to .js.
export function distPathOf(id, rel) {
  const ext = extOf(rel);
  return `apps/${id}/${rel.slice(0, rel.length - ext.length)}${SOURCE_TO_OUTPUT_EXT[ext] ?? ext}`;
}

/**
 * The index.html tags for the first-party apps a profile lists, in a fixed
 * order: app id (sorted), then per app the script, then its styles in
 * manifest order. Apps not listed in `app_modules` get none.
 */
export function renderTags(model, profile) {
  const lines = [];
  const listed = new Set(profile.app_modules);
  for (const app of model.apps) {
    if (!listed.has(app.id)) continue;
    const id = escapeAttr(app.id);
    lines.push(
      `    <script type="module" src="${escapeAttr(distPathOf(app.id, app.entry))}" data-app="${id}"></script>`
    );
    for (const style of app.styles) {
      lines.push(`    <link rel="stylesheet" href="${escapeAttr(distPathOf(app.id, style))}" data-app="${id}">`);
    }
  }
  return lines;
}

/** The dist-space tag paths renderTags() would emit (the reachability seeds). */
export function tagPaths(model, profile) {
  const paths = [];
  const listed = new Set(profile.app_modules);
  for (const app of model.apps) {
    if (!listed.has(app.id)) continue;
    paths.push(distPathOf(app.id, app.entry), ...app.styles.map((s) => distPathOf(app.id, s)));
  }
  return paths;
}

// TypeScript emits `import { jsx } from "<jsxImportSource>/jsx-runtime"`
// with no extension; the browser needs the .js.
function compileTypescript(text, sourceName, distRel) {
  const ts = loadTypescript();
  const runtimeRel = posix.relative(posix.dirname(distRel), "runtime");
  const jsxImportSource = runtimeRel.startsWith(".") ? runtimeRel : `./${runtimeRel}`;
  const out = ts.transpileModule(text, {
    fileName: sourceName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource,
      sourceMap: false,
      inlineSourceMap: false,
      inlineSources: false,
    },
  });
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const msgs = errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    throw new Error(`first-party.mjs: ${sourceName} does not compile:\n  ${msgs.join("\n  ")}`);
  }
  return out.outputText.split(`"${jsxImportSource}/jsx-runtime"`).join(`"${jsxImportSource}/jsx-runtime.js"`);
}

/**
 * Resolves dist-space paths to first-party output.
 *  owns(path)        true for anything under apps/<id>/ or apps/<lib>/ (so a
 *                    missing file there is an error, never a silent fall
 *                    through to shell/).
 *  has(path)         true when a .js/.css output exists for it.
 *  read(path)        compiled contents.
 *  specifiers(path)  relative import specifiers of a .js output.
 */
export function createFirstPartyOutput(model) {
  const names = new Set([...model.apps.map((a) => a.id), ...model.libs]);
  const cache = new Map();

  function owns(distRel) {
    const m = /^apps\/([^/]+)\//.exec(distRel);
    return m !== null && names.has(m[1]);
  }
  function has(distRel) {
    return model.sources.has(distRel);
  }
  function read(distRel) {
    if (cache.has(distRel)) return cache.get(distRel);
    const abs = model.sources.get(distRel);
    if (abs === undefined) throw new Error(`first-party.mjs: no first-party source for ${distRel}`);
    const text = readFileSync(abs, "utf8");
    const srcExt = extOf(abs);
    const out = srcExt === ".ts" || srcExt === ".tsx" ? compileTypescript(text, abs, distRel) : text;
    cache.set(distRel, out);
    return out;
  }
  function specifiers(distRel) {
    if (!distRel.endsWith(".js")) return [];
    const ts = loadTypescript();
    const specs = ts.preProcessFile(read(distRel), true, true).importedFiles.map((f) => f.fileName);
    // Import specifiers are spelled in dist space (see the module header), so
    // the SDK is reached by a relative path too. Anything else -- a URL, a
    // bare package name, a root-absolute path -- would be resolved by the
    // browser outside the reviewed file set, so it is refused, never skipped.
    const bad = specs.filter((s) => !s.startsWith("./") && !s.startsWith("../"));
    if (bad.length > 0) {
      throw new Error(
        `first-party.mjs: ${distRel} imports non-relative specifier(s) ${bad.map((b) => JSON.stringify(b)).join(", ")}; ` +
          `first-party code may import only relative dist-space paths (../../sdk/fulc-sdk.js and the like)`
      );
    }
    return specs;
  }
  return { owns, has, read, specifiers, names };
}
