// apps/workspace/build/build.mjs
//
// Invoked as `node build/build.mjs` (see package.json's "build" script) --
// deliberately no #!/usr/bin/env node shebang, unlike import/checks.mjs and
// import/import.mjs: this module's `build()` export is imported directly by
// test/profile.test.mjs (not run only via execFileSync like those two),
// and a leading shebang line trips up vite's import-analysis when a test
// file imports the module directly.
//
// D#37 WS-B: `pnpm --filter workspace build` entry point. Filters the
// imported shell/ tree down to a single profile's feature set and writes
// the result to dist/.
//
//   1. Runs checks.mjs --import on shell/ (the same gate WS-A1/A2 run at
//      import time -- catches drift between what's on disk and what the
//      importer would have allowed).
//   2. Filters index.html per the profile (profile.mjs: app_modules,
//      drop_core).
//   3. Computes the file set reachable from the filtered index.html: every
//      kept <script src>/<link href>, plus the static (not dynamic) import
//      graph reached by walking from every kept .js file, plus the two
//      runtime-fetched asset directories core/theme-manager.js addresses
//      by string concatenation rather than a static import
//      (core/themes/*.json, fonts/**) -- see ALWAYS_INCLUDE_DIRS below.
//   4. Fails the build if any kept tag or import resolves to a file that
//      does not exist on disk.
//   5. Copies the reachable set (plus the filtered index.html) into dist/.
//   6. Runs checks.mjs --ship on dist/.
//
// D#37 C24 / WS-F0: first-party SDK apps (apps/workspace/apps/<id>/, see
// first-party.mjs) join the same pipeline. Their tags are injected into the
// filtered index.html after the SDK's data-core tags (only for ids the
// profile's app_modules lists), the reachability walk resolves
// apps/<id>/... against the apps dir and everything else against shell/,
// TS/TSX compiles to .js on the way into dist/, and step 6 checks the
// first-party output exactly like the imported output. With no first-party
// app listed, none of this changes what gets built.
//
// Usage: node build.mjs [--profile <path>] [--shell <dir>] [--apps <dir>] [--out <dir>]
// Defaults: profiles/cloud.json, ../shell, ../apps, ../dist (all relative to this file).

import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  rmSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep, posix } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadProfile,
  filterIndexHtml,
  stripQuery,
  computeAssetHash,
  injectBaseHref,
  injectModulePreloads,
  injectFirstPartyTags,
  substituteDefaultTheme,
  substituteDockOrder,
  validateThemeNames,
} from "./profile.mjs";
import { loadFirstPartyApps, createFirstPartyOutput, renderTags, tagPaths } from "./first-party.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = join(SCRIPT_DIR, "..");
const DEFAULT_PROFILE_PATH = join(WORKSPACE_DIR, "profiles", "cloud.json");
const DEFAULT_SHELL_DIR = join(WORKSPACE_DIR, "shell");
const DEFAULT_APPS_DIR = join(WORKSPACE_DIR, "apps");
const DEFAULT_OUT_DIR = join(WORKSPACE_DIR, "dist");
const DEFAULT_ALLOWLIST_PATH = join(WORKSPACE_DIR, "import", "allowlist.txt");
const DEFAULT_BUILD_INFO_PATH = join(WORKSPACE_DIR, "BUILD-INFO.json");
const CHECKS_MJS = join(WORKSPACE_DIR, "import", "checks.mjs");

// core/theme-manager.js fetches these two directories by string
// concatenation ('core/themes/' + id + '.json', and a font descriptor
// table keyed by literal 'fonts/*.woff2' paths) rather than a static
// import or an HTML tag -- neither a tag/import reachability walk nor
// checks.mjs can see that reference. Both directories are baseline shell
// assets needed by every profile that ships core/theme-manager.js (every
// profile does; it is core and never a drop_core candidate), so they are
// always included rather than teaching the reachability walker to
// evaluate runtime string concatenation.
const ALWAYS_INCLUDE_DIRS = ["core/themes", "fonts"];

// D#37 WS-TH1 (C19b criterion 1): the two heritage adapter stylesheets are
// loaded at runtime by orchard-adapter.js/crystal-adapter.js building a
// <link href="apps/themes/heritage/{orchard,crystal}.css"> string and
// appending it to <head> (injectStyles() in each adapter) -- never a
// static <link> tag in index.html and never a JS import, so neither the
// tag filter (profile.mjs) nor walkImportGraph() above ever sees this
// reference. Without this, a cloud profile that ships the "heritage"
// app_module still drops both CSS files silently and the heritage UI
// paints unstyled. Included only when the profile actually ships heritage
// (unlike ALWAYS_INCLUDE_DIRS, which every profile needs unconditionally
// because core/theme-manager.js is never a drop_core candidate) --
// heritage-build.test.mjs pins both halves: the files are present when
// "heritage" is in app_modules, and the reachable set doesn't gain them
// otherwise.
const HERITAGE_CSS_FILES = ["apps/themes/heritage/orchard.css", "apps/themes/heritage/crystal.css"];

const IMPORT_SPEC_RE = /^\s*(?:import|export)\b.*?["'](\.[^"']+)["']/;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
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

function toPosix(p) {
  return p.split(sep).join("/");
}

// Resolves a relative import specifier against the POSIX path of the
// importing file, returning a shell-root-relative POSIX path -- or `null`
// when the specifier normalizes to a path outside the shell root (CWE-22).
// posix.normalize() alone does not bound the result: it only collapses
// ".." segments algebraically, so "core/../../outside.js" normalizes
// straight to "../outside.js" and would be returned as a valid-looking
// shell-root-relative path if the caller didn't reject a leading "..".
// The reviewed PoC (PR #100 review) chained exactly this from a kept file
// to reach one directory above shellDir.
function resolveImport(fromRelPath, specifier) {
  const fromDir = posix.dirname(fromRelPath);
  const resolved = posix.normalize(posix.join(fromDir, specifier));
  if (resolved === ".." || resolved.startsWith("../")) return null;
  return resolved;
}

// Throws unless `abs` resolves inside `root` -- the same escape a rejected
// resolveImport() specifier could otherwise smuggle through to a raw
// filesystem join at the copy step (build()'s step 4), which has no
// resolveImport() of its own to reject it. `path.relative` is the
// authoritative check here (works for both "../" escapes and a
// drive-absolute path on any platform), not another posix.normalize().
function assertPathWithinRoot(root, abs, label) {
  const rel = relative(root, abs);
  if (rel === "." || rel === "") return;
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`build.mjs: refusing to write ${label} "${abs}" -- resolves outside ${root} (CWE-22 path traversal rejected)`);
  }
}

function walkAll(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAll(abs, base, acc);
    } else if (entry.isFile()) {
      acc.push(toPosix(relative(base, abs)));
    }
  }
  return acc;
}

// Walks the static (not dynamic import()) import graph starting from
// `seeds` (shell-root-relative POSIX paths already known to exist).
// Returns { reachable: Set<string>, dangling: Array<{from, spec, resolved}>,
// traversal: Array<{from, spec}> } -- `dangling` is a resolved-but-missing
// file (a broken import), `traversal` is a specifier resolveImport()
// rejected outright because it resolves outside shellDir (CWE-22); the two
// are kept separate so a traversal attempt gets its own explicit,
// security-labeled failure instead of reading like an ordinary typo.
//
// `fp` (WS-F0): when a first-party output resolver is given, a path it owns
// (apps/<first-party id or library>/...) is read from the compiled
// first-party output and resolved through it, never through shellDir --
// including a MISSING file there, which is a dangling import, not a
// fall-through to shell/.
//
// `forbid` (WS-F0 fix round 1, security SHOULD-1): called for every import
// edge that STARTS in a first-party file, with the resolved target. A non-null
// return is the reason that target may not ship (the profile dropped it, or
// its app is not in app_modules); the edge is recorded in `forbidden` and not
// followed. drop_core/app_modules only ever filtered index.html tags, so
// without this a first-party import re-ships what the profile removed.
function walkImportGraph(shellDir, seeds, fp = null, forbid = null) {
  const reachable = new Set();
  const dangling = [];
  const traversal = [];
  const forbidden = [];
  const queue = [...seeds];

  while (queue.length > 0) {
    const relPath = queue.shift();
    if (reachable.has(relPath)) continue;
    reachable.add(relPath);

    if (!/\.m?js$/.test(relPath)) continue; // only JS carries further imports

    if (fp !== null && fp.owns(relPath)) {
      if (!fp.has(relPath)) continue; // reported by the caller's own existence pass
      for (const spec of fp.specifiers(relPath)) {
        const resolved = resolveImport(relPath, spec);
        if (resolved === null) {
          traversal.push({ from: relPath, spec });
          continue;
        }
        const reason = forbid === null ? null : forbid(resolved);
        if (reason !== null) {
          forbidden.push({ from: relPath, spec, resolved, reason });
          continue;
        }
        const exists = fp.owns(resolved) ? fp.has(resolved) : existsSync(join(shellDir, ...resolved.split("/")));
        if (!exists) {
          dangling.push({ from: relPath, spec, resolved });
          continue;
        }
        if (!reachable.has(resolved)) queue.push(resolved);
      }
      continue;
    }

    const abs = join(shellDir, ...relPath.split("/"));
    if (!existsSync(abs)) continue; // reported by the caller's own existence pass

    const content = readFileSync(abs, "utf8");
    for (const line of content.split("\n")) {
      const m = line.match(IMPORT_SPEC_RE);
      if (!m) continue;
      const resolved = resolveImport(relPath, m[1]);
      if (resolved === null) {
        traversal.push({ from: relPath, spec: m[1] });
        continue;
      }
      const resolvedAbs = join(shellDir, ...resolved.split("/"));
      const resolvedExists = fp !== null && fp.owns(resolved) ? fp.has(resolved) : existsSync(resolvedAbs);
      if (!resolvedExists) {
        dangling.push({ from: relPath, spec: m[1], resolved });
        continue;
      }
      if (!reachable.has(resolved)) queue.push(resolved);
    }
  }

  return { reachable, dangling, traversal, forbidden };
}

function runChecks(mode, dir, { allowlistPath, buildInfoPath, firstPartyPrefixes = [] }) {
  const argv = [CHECKS_MJS, `--${mode}`, dir, "--allowlist", allowlistPath, "--build-info", buildInfoPath];
  if (firstPartyPrefixes.length > 0) argv.push("--first-party-prefix", firstPartyPrefixes.join(","));
  try {
    execFileSync(process.execPath, argv, { stdio: "pipe" });
    return { ok: true, output: "" };
  } catch (err) {
    const output = [err.stdout, err.stderr].filter(Boolean).map(String).join("\n");
    return { ok: false, output };
  }
}

export function build({
  profilePath = DEFAULT_PROFILE_PATH,
  shellDir = DEFAULT_SHELL_DIR,
  // WS-F0: where first-party SDK apps live. Overridable so a test can point
  // at a fixture root (test/fixtures/first-party/) instead.
  appsDir = DEFAULT_APPS_DIR,
  outDir = DEFAULT_OUT_DIR,
  // Explicit, not derived from shellDir/outDir's location -- checks.mjs's
  // own CLI defaults the allowlist/build-info path from `dir`'s position
  // on disk (sibling BUILD-INFO.json, sibling-of-import/ allowlist.txt),
  // which only resolves correctly when shellDir/outDir sit where the real
  // shell/ and dist/ do. A test running build() against a scratch tmp
  // tree needs to point these at its own fixtures (or, for a real-tree
  // build with an out-of-place outDir, still needs them to resolve to the
  // real files) -- see test/profile.test.mjs's fixture vs. real-build
  // suites and Correction C6 (never rely on the real allowlist in a new
  // test).
  allowlistPath = DEFAULT_ALLOWLIST_PATH,
  buildInfoPath = DEFAULT_BUILD_INFO_PATH,
} = {}) {
  const checksOpts = { allowlistPath, buildInfoPath };

  // Step 1: checks.mjs --import on the source tree.
  const importCheck = runChecks("import", shellDir, checksOpts);
  if (!importCheck.ok) {
    throw new Error(`build.mjs: checks.mjs --import failed on ${shellDir}:\n${importCheck.output}`);
  }

  const profile = loadProfile(profilePath);

  // Step 2: filter index.html.
  const indexPath = join(shellDir, "index.html");
  const indexHtml = readFileSync(indexPath, "utf8");
  const { html: shellFilteredHtml, keptPaths: shellKeptPaths, droppedPaths } = filterIndexHtml(indexHtml, profile);

  // WS-F0 (C24 criteria 1, 2, 5, 7): scan + validate apps/ -- extension
  // allowlist, manifests, id collisions -- for EVERY first-party directory,
  // listed by the profile or not, then inject tags for the listed ones.
  const firstParty = loadFirstPartyApps(appsDir, { shellDir, shellIndexHtml: indexHtml });
  const fp = createFirstPartyOutput(firstParty);
  const filteredHtml = injectFirstPartyTags(shellFilteredHtml, renderTags(firstParty, profile));
  const keptPaths = [...shellKeptPaths, ...tagPaths(firstParty, profile)];

  // Every drop_core entry that names a file actually present on disk must
  // have produced a drop -- guards against a typo'd path in the profile
  // silently doing nothing (the two genuinely-absent entries,
  // core/automerge-bootstrap.js and crypto.js, are expected no-ops, see
  // profile.mjs's module header).
  const EXPECTED_NOOP_DROPS = new Set(["core/automerge-bootstrap.js", "crypto.js"]);
  for (const entry of profile.drop_core) {
    if (EXPECTED_NOOP_DROPS.has(entry)) continue;
    if (!droppedPaths.includes(entry)) {
      throw new Error(
        `build.mjs: drop_core entry "${entry}" did not match any tag in ${indexPath} -- ` +
          `check the path is spelled exactly as it appears in the src/href attribute.`
      );
    }
  }

  // Step 3: reachable file set. `bootReachable` is exactly item 2's "tags
  // plus static import graph" -- this is the set criterion 3's "≤N files
  // referenced at boot" (N is BOOT_BUDGET.maxStaticRequests in
  // build/budget.mjs) / "≤320 KB total brotli" budget is measured against
  // (test/profile.test.mjs computes both over this set, not over
  // `reachable`). ALWAYS_INCLUDE_DIRS is added to `reachable` afterwards,
  // for dist/ to actually serve those files when core/theme-manager.js
  // fetches them at runtime -- but neither directory is "referenced at
  // boot": core/themes/*.json is fetched once, asynchronously, well after
  // the boot sequence starts, and fonts/*.woff2 are loaded per-experience
  // on theme switch, not for all four weights up front. Counting them
  // against the boot budget would conflate "ships in dist/" with
  // "loads before the desktop is usable", which is what criterion 3 is
  // actually trying to bound.
  const seeds = new Set(["index.html", ...keptPaths.map(stripQuery)]);
  // A first-party import may not pull in what the profile dropped (a
  // drop_core path, whether or not it has a tag) or an app app_modules does
  // not list (imported, or another first-party app; "_" libraries are shared
  // code and always fine).
  const droppedSet = new Set([...droppedPaths, ...profile.drop_core].map(stripQuery));
  const listedApps = new Set(profile.app_modules);
  const forbid = (resolved) => {
    const m = /^apps\/([^/]+)\//.exec(resolved);
    if (m !== null && !m[1].startsWith("_") && !listedApps.has(m[1])) {
      return `belongs to app "${m[1]}", which the profile's app_modules does not list`;
    }
    if (droppedSet.has(resolved)) return "dropped by the profile (drop_core)";
    return null;
  };
  const { reachable, dangling, traversal, forbidden } = walkImportGraph(shellDir, seeds, fp, forbid);

  if (forbidden.length > 0) {
    const lines = forbidden.map((f) => `  ${f.from} -> "${f.spec}" (resolved: ${f.resolved}): ${f.reason}`);
    throw new Error(
      `build.mjs: ${forbidden.length} first-party import(s) reach a module this profile does not ship:\n${lines.join("\n")}`
    );
  }

  if (traversal.length > 0) {
    const lines = traversal.map((t) => `  ${t.from} -> "${t.spec}"`);
    throw new Error(
      `build.mjs: ${traversal.length} import(s) in the kept file set resolve outside shellDir ` +
        `(CWE-22 path traversal rejected):\n${lines.join("\n")}`
    );
  }

  if (dangling.length > 0) {
    const lines = dangling.map((d) => `  ${d.from} -> "${d.spec}" (resolved: ${d.resolved})`);
    throw new Error(
      `build.mjs: ${dangling.length} import(s) in the kept file set point at a missing file:\n${lines.join("\n")}`
    );
  }

  const bootReachable = new Set(reachable);

  // D#37 WS-TH1 fix round 1 (owner ruling 2026-09-25): "core/themes" is
  // walked wholesale by ALWAYS_INCLUDE_DIRS above (theme-manager.js fetches
  // by string concatenation, so nothing else can see which ids it actually
  // needs) -- an optional `excluded_themes` array on the profile is this
  // build's only lever to keep a theme JSON's *source* file (still present,
  // untouched, for jpos parity) out of a specific profile's dist/ without
  // deleting it. Absent on a profile (every profile before this one), this
  // is a no-op: every core/themes/*.json file ships exactly as before.
  const excludedThemes = new Set(Array.isArray(profile.excluded_themes) ? profile.excluded_themes : []);

  for (const dir of ALWAYS_INCLUDE_DIRS) {
    const abs = join(shellDir, ...dir.split("/"));
    if (!existsSync(abs)) continue;
    for (const f of walkAll(abs)) {
      if (dir === "core/themes" && excludedThemes.has(f.replace(/\.json$/, ""))) continue;
      reachable.add(`${dir}/${f}`);
    }
  }

  // See HERITAGE_CSS_FILES's own comment: string-path-loaded, so the
  // reachability walk above never finds them on its own. Only added when
  // the profile actually ships "heritage" -- a profile that doesn't ship
  // the heritage app_module (or the tag filter already dropped it) has no
  // adapter left to load these, and shouldn't gain two orphaned CSS files.
  if (profile.app_modules.includes("heritage")) {
    for (const relPath of HERITAGE_CSS_FILES) {
      const abs = join(shellDir, ...relPath.split("/"));
      if (!existsSync(abs)) {
        throw new Error(`build.mjs: heritage CSS file "${relPath}" is missing from ${shellDir}`);
      }
      reachable.add(relPath);
    }
  }

  // D#37 WS-D criterion 3: every module reached only through a static
  // import (never a direct <script>/<link> tag -- i.e. in `reachable` but
  // not in `seeds`) gets a <link rel="modulepreload"> hint. Computed here,
  // before the copy step, since it depends only on the tag/import graph
  // already built above, not on any file's content.
  const modulePreloadPaths = [...reachable]
    .filter((p) => p !== "index.html" && !seeds.has(p) && /\.m?js$/.test(p))
    .sort();

  // Step 4: copy every reachable file into a FLAT outDir first -- the same
  // layout this build produced before WS-D, so checks.mjs --ship's
  // allowlist matching (relative to `outDir`) is completely unaffected by
  // the /s/<hash>/ prefix this function adds afterward (step 6). Moving
  // files into their hashed home only happens once that check has passed
  // (see the rename loop below) -- if it moved them first, checks.mjs
  // would see paths like "s/<hash>/core/boot.js" and every allowlist
  // pattern (anchored at "core/**" etc.) would stop matching, failing the
  // build on every single file.
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const copied = [];
  for (const relPath of reachable) {
    if (relPath === "index.html") continue;
    const isFirstParty = fp.owns(relPath);
    const srcAbs = join(shellDir, ...relPath.split("/"));
    const destAbs = join(outDir, ...relPath.split("/"));
    // Defense in depth: resolveImport()/walkImportGraph() already reject a
    // traversing import before it reaches `reachable`, but `reachable` also
    // absorbs `seeds` straight from the kept HTML tags and ALWAYS_INCLUDE_DIRS
    // -- neither passes through resolveImport(). Bound both ends of the copy
    // itself so a future seed source can't silently reopen this path.
    if (!isFirstParty) assertPathWithinRoot(shellDir, srcAbs, `source path for "${relPath}"`);
    assertPathWithinRoot(outDir, destAbs, `destination path for "${relPath}"`);
    mkdirSync(dirname(destAbs), { recursive: true });
    if (isFirstParty) {
      // Compiled (TS/TSX) or verbatim (.js/.css) first-party output; the
      // source tree is never copied. `has()` only answers true for .js/.css
      // outputs, so no .ts/.tsx can reach this branch.
      writeFileSync(destAbs, fp.read(relPath));
    } else if (relPath === "core/theme-manager.js") {
      // D#37 WS-D criterion 7 (OPEN OWNER DECISION 1): substitute the
      // profile's own default_theme into the copy that ships -- the
      // source tree (and any OTHER profile's build) keeps the literal's
      // own fallback untouched.
      const defaultTheme = typeof profile.default_theme === "string" ? profile.default_theme : "classic-crt";
      writeFileSync(destAbs, substituteDefaultTheme(readFileSync(srcAbs, "utf8"), defaultTheme));
    } else if (relPath === "core/taskbar.js") {
      // D#37 WS-E criterion 6: substitute the profile's own dock_order into
      // the copy that ships, the same way theme-manager.js's default theme
      // is substituted just above. The source tree (and any profile build
      // that omits dock_order) keeps the literal's own empty-array fallback.
      writeFileSync(destAbs, substituteDockOrder(readFileSync(srcAbs, "utf8"), profile.dock_order));
    } else {
      copyFileSync(srcAbs, destAbs);
    }
    copied.push(relPath);
  }

  // D#37 WS-D criterion 8 (OPEN OWNER DECISION 2): validate only the theme
  // JSON files this profile actually ships -- `copied` already excludes
  // `excludedThemes` (the ALWAYS_INCLUDE_DIRS loop above never added them
  // to `reachable`), so windows-aero.json/ubuntu-gnome.json (kept on disk
  // for jpos parity, never shipped) never reach this check.
  const shippedThemeFiles = copied
    .filter((p) => p.startsWith("core/themes/") && p.endsWith(".json"))
    .map((relPath) => ({ relPath, content: readFileSync(join(outDir, ...relPath.split("/")), "utf8") }));
  const themeNameViolations = validateThemeNames(shippedThemeFiles);
  if (themeNameViolations.length > 0) {
    const lines = themeNameViolations.map((v) => `  ${v.relPath}: ${v.field}="${v.value}"`);
    throw new Error(
      `build.mjs: shipped theme JSON matches the forbidden vendor-name pattern (WS-D criterion 8, OPEN OWNER DECISION 2):\n${lines.join("\n")}`
    );
  }

  // Step 5: hash the shipped (non-index.html) file set, then write the
  // final index.html -- <base href="/s/<hash>/"> plus the modulepreload
  // hints computed above. Hashing excludes index.html itself (it stays
  // unhashed at outDir's root, Cache-Control: no-cache) -- including it
  // would be circular, since its own content depends on the hash.
  const hash = computeAssetHash(copied.map((relPath) => ({ relPath, content: readFileSync(join(outDir, ...relPath.split("/"))) })));
  const baseHref = `/s/${hash}/`;
  const finalHtml = injectModulePreloads(injectBaseHref(filteredHtml, baseHref), modulePreloadPaths);
  writeFileSync(join(outDir, "index.html"), finalHtml);

  // Step 6: checks.mjs --ship on the still-FLAT dist/ (see step 4's
  // comment for why this must run before the rename below).
  // WS-F0 (C24 criterion 7): the first-party output is not in allowlist.txt
  // (anchored to the jpos tar). checks.mjs is told which apps/<name>/
  // prefixes are first-party, and admits only .js/.css under them; every
  // other --ship rule (secrets, product-name gate, precompressed files,
  // symlinks, ...) runs over those files exactly as over imported ones.
  const firstPartyPrefixes = [
    ...new Set(copied.filter((p) => fp.owns(p)).map((p) => `apps/${p.split("/")[1]}/`)),
  ].sort();
  const shipCheck = runChecks("ship", outDir, { ...checksOpts, firstPartyPrefixes });
  if (!shipCheck.ok) {
    throw new Error(`build.mjs: checks.mjs --ship failed on ${outDir}:\n${shipCheck.output}`);
  }

  // Step 7: move every shipped file (everything but index.html) under the
  // content-hashed /s/<hash>/ prefix -- a same-filesystem rename, not a
  // copy. This is the ONLY step that changes the on-disk layout; every
  // check above ran against the flat tree specifically so it never had to
  // learn about this prefix.
  for (const relPath of copied) {
    const flatAbs = join(outDir, ...relPath.split("/"));
    const hashedAbs = join(outDir, "s", hash, ...relPath.split("/"));
    assertPathWithinRoot(outDir, hashedAbs, `hashed destination path for "${relPath}"`);
    mkdirSync(dirname(hashedAbs), { recursive: true });
    renameSync(flatAbs, hashedAbs);
  }

  // Cosmetic only: the rename above leaves the FLAT directory skeleton
  // behind, now empty (everything in it moved into s/<hash>/). Remove it
  // so `ls dist/` reads as "index.html, s/" rather than a confusing mix of
  // both layouts -- every directory here was created fresh by step 4's own
  // mkdirSync calls this same build() call, so removing an empty one can
  // never lose anything.
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (entry.name === "s" || !entry.isDirectory()) continue;
    rmSync(join(outDir, entry.name), { recursive: true, force: true });
  }

  // bootReachable already includes "index.html" (it's the BFS's first
  // seed) -- its paths mirror copiedFiles' shell-root-relative spelling so
  // a caller can map onto dist/ paths via shippedPath() below.
  return {
    profile,
    keptPaths,
    droppedPaths,
    copiedFiles: copied.sort(),
    bootFiles: [...bootReachable].sort(),
    modulePreloadPaths,
    hash,
    outDir,
  };
}

// Resolves a shell-root-relative path (as returned in a build() result's
// `copiedFiles`/`bootFiles`, or the literal "index.html") to its real
// on-disk location under that result's outDir -- index.html is unhashed at
// outDir's root; every other shipped file lives under outDir/s/<hash>/
// (WS-D criterion 3). Callers (tests, copy-workspace.mjs) use this instead
// of assuming either layout directly.
export function shippedPath(result, relPath) {
  if (relPath === "index.html") return join(result.outDir, "index.html");
  return join(result.outDir, "s", result.hash, ...relPath.split("/"));
}

function main(argv) {
  const args = parseArgs(argv);
  const profilePath = typeof args.profile === "string" ? args.profile : DEFAULT_PROFILE_PATH;
  const shellDir = typeof args.shell === "string" ? args.shell : DEFAULT_SHELL_DIR;
  const appsDir = typeof args.apps === "string" ? args.apps : DEFAULT_APPS_DIR;
  const outDir = typeof args.out === "string" ? args.out : DEFAULT_OUT_DIR;

  try {
    const result = build({ profilePath, shellDir, appsDir, outDir });
    console.log(
      `build.mjs: wrote ${result.copiedFiles.length + 1} file(s) to ${result.outDir} ` +
        `(profile "${result.profile.name}", dropped ${result.droppedPaths.length} tag(s))`
    );
    return 0;
  } catch (err) {
    console.error(err.message || String(err));
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
