// apps/workspace/build/profile.mjs
//
// D#37 WS-B: profile loading + index.html line-classification for the
// profile-filtered build. A "profile" (e.g. profiles/cloud.json) declares:
//
//   app_modules  -- data-app ids that ship. Every <script>/<link> tagged
//                   data-app="X" for X not in this list is dropped, and so
//                   is every untagged apps/<id>/* <link> whose inferred app
//                   id is not in this list (see below -- most app CSS
//                   <link> tags in index.html carry no data-app attribute
//                   at all, only the <script> tags do).
//   drop_core    -- exact tag src/href values to drop unconditionally,
//                   regardless of data-app. Four of the eight entries here
//                   go beyond the Spec prose's four-item list (PR #100
//                   review round, D#37 correction pending) -- one line each:
//                     core/crdt-sync.css   untagged <link>, no data-app; left
//                                          in would ship a forbidden "crdt"
//                                          path in dist/, violating WS-B
//                                          acceptance criterion 3.
//                     vendor/xterm/xterm.css  untagged <link>, no data-app;
//                                          never imported at all (see
//                                          import/allowlist.txt) -- would be
//                                          a dangling reference otherwise.
//                     editor.css           untagged <link>, no data-app --
//                                          invisible to the app_modules
//                                          filter the same way the two
//                                          above are; the cloud profile
//                                          ships no "editor" app to justify
//                                          it.
//                     editor.js            tagged data-core, not data-app --
//                                          same blind spot as editor.css;
//                                          drops the in-shell text editor
//                                          surface the cloud profile does
//                                          not include.
//                   The remaining two entries (core/automerge-bootstrap.js,
//                   crypto.js) are no-ops -- neither file exists in the
//                   imported tree (C5, and the same is independently true of
//                   crypto.js) -- kept as documentation per C5's instruction.
//   features     -- the flags the built app reads once via core/features.js
//                   (presence, liveEntitlements, crdt, messages, updates).
//                   Not consulted by the build itself; shipped so
//                   test/profile.test.mjs can assert the built dist/ and
//                   the source profile agree, and so a future profile can
//                   diff its own flags against this one.
//
// Exports are pure functions (no filesystem access beyond loadProfile's own
// JSON read) so test/profile.test.mjs can unit-test line classification
// without running the full build.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { escapeAttr } from "./first-party.mjs";

export function loadProfile(profilePath) {
  const raw = readFileSync(profilePath, "utf8");
  const profile = JSON.parse(raw);
  if (!Array.isArray(profile.app_modules)) {
    throw new Error(`profile.mjs: ${profilePath} is missing an app_modules array`);
  }
  if (!Array.isArray(profile.drop_core)) {
    throw new Error(`profile.mjs: ${profilePath} is missing a drop_core array`);
  }
  if (typeof profile.features !== "object" || profile.features === null) {
    throw new Error(`profile.mjs: ${profilePath} is missing a features object`);
  }
  return profile;
}

// Matches a <script ...> or <link ...> tag that is the ENTIRE (trimmed)
// line -- every real tag in shell/index.html is one self-contained line
// (the file's own header comment calls this out for the commented-out
// "withheld" lines, and it holds for the live tags too), so line-based
// matching never has to parse HTML properly. A line that doesn't match
// (plain markup, an already-commented-out withheld tag, blank lines) is
// left untouched.
// <link> is a void tag (no closing tag); <script> always closes on the same
// line in this codebase (`<script src="...">...</script>` with no inline
// body), so both forms are matched.
const TAG_RE = /^\s*<(script|link)\b[^>]*>(?:\s*<\/\1>)?\s*$/i;
const SRC_OR_HREF_RE = /\b(?:src|href)="([^"]+)"/i;
const DATA_APP_RE = /\bdata-app="([^"]+)"/i;
const APP_PATH_RE = /^apps\/([^/]+)\//;
// D#37 WS-D criterion 2/3: <link rel="preload" as="fetch" ...> (the three
// static mode/system-mode/branding boot preloads, always present
// regardless of profile) and <link rel="modulepreload" ...> (build.mjs's
// own injectModulePreloads output) are resource hints, not asset
// references -- their href is a root-absolute API path ("/api/mode") or a
// path build.mjs already resolved and will copy on its own. Neither is a
// file this filter should classify by app_modules/drop_core, and neither
// should ever be added to keptPaths/droppedPaths (which build.mjs treats
// as shell-root-relative on-disk paths to copy or skip) -- doing so tried
// to copy a nonexistent "shell/api/mode" file and crashed the build.
const PRELOAD_REL_RE = /\brel="(?:preload|modulepreload)"/i;

// Strips a trailing cache-busting query string (e.g. "core/desktop.js?v=2")
// so a tag's src/href resolves to the real on-disk path. The querystring
// itself is preserved verbatim in the kept HTML line.
export function stripQuery(path) {
  const i = path.indexOf("?");
  return i === -1 ? path : path.slice(0, i);
}

// Classifies one line of index.html. Returns:
//   { kind: "tag", keep: boolean, path: string|null }  for a script/link tag
//   { kind: "other" }                                   for anything else
export function classifyLine(line, profile) {
  if (!TAG_RE.test(line)) return { kind: "other" };
  if (PRELOAD_REL_RE.test(line)) return { kind: "other" };

  const srcMatch = line.match(SRC_OR_HREF_RE);
  if (!srcMatch) return { kind: "other" }; // no src/href at all -- not a tag we filter
  const rawPath = srcMatch[1];
  const path = stripQuery(rawPath);

  const dropSet = profile.drop_core;
  if (dropSet.includes(path)) {
    return { kind: "tag", keep: false, path };
  }

  const dataAppMatch = line.match(DATA_APP_RE);
  if (dataAppMatch) {
    const appId = dataAppMatch[1];
    return { kind: "tag", keep: profile.app_modules.includes(appId), path };
  }

  // No data-app attribute: infer the owning app from an "apps/<id>/" path
  // prefix (every app-owned <link> in index.html is spelled this way; only
  // the <script> tags carry an explicit data-app attribute -- see the
  // module header).
  const appPathMatch = path.match(APP_PATH_RE);
  if (appPathMatch) {
    const appId = appPathMatch[1];
    return { kind: "tag", keep: profile.app_modules.includes(appId), path };
  }

  // Core tag (no data-app, no apps/<id>/ prefix) not in drop_core: keep.
  return { kind: "tag", keep: true, path };
}

// Filters the full index.html text, returning { html, keptPaths, droppedPaths }.
export function filterIndexHtml(html, profile) {
  const lines = html.split("\n");
  const keptLines = [];
  const keptPaths = [];
  const droppedPaths = [];

  for (const line of lines) {
    const c = classifyLine(line, profile);
    if (c.kind === "other") {
      keptLines.push(line);
      continue;
    }
    if (c.keep) {
      keptLines.push(line);
      if (c.path) keptPaths.push(c.path);
    } else {
      droppedPaths.push(c.path);
    }
  }

  return { html: keptLines.join("\n"), keptPaths, droppedPaths };
}

// ── D#37 C24 / WS-F0: first-party app tags ─────────────────────────────────
//
// First-party SDK apps (apps/workspace/apps/<id>/) have no line in the
// imported shell/index.html, so classifyLine()/filterIndexHtml() above never
// see them. build.mjs asks first-party.mjs for the tag lines of the apps the
// profile's app_modules lists (the same list, and the same rule, that keeps
// or drops an imported app's tags -- no product id is added to any profile),
// and this pure function splices them in AFTER the last data-core tag: the
// SDK and runtime tags every SDK app depends on. An empty list returns the
// html untouched, so a build with no first-party app is byte-identical.
const DATA_CORE_RE = /\bdata-core\b/;

export function injectFirstPartyTags(html, tagLines) {
  if (tagLines.length === 0) return html;
  const lines = html.split("\n");
  let lastCore = -1;
  lines.forEach((line, i) => {
    if (TAG_RE.test(line) && DATA_CORE_RE.test(line)) lastCore = i;
  });
  if (lastCore === -1) {
    throw new Error("profile.mjs: injectFirstPartyTags found no data-core tag to inject after");
  }
  lines.splice(lastCore + 1, 0, ...tagLines);
  return lines.join("\n");
}

// ── D#37 WS-D: content-hashed /s/<hash>/ prefix, preload hints ─────────────
//
// The functions below are pure (no filesystem access) so
// test/profile.test.mjs can unit-test each transform directly; build.mjs
// wires them into the real pipeline (computing the hash from the copied
// file set, then rewriting the ALREADY-FILTERED index.html before it's
// written to disk).

// Deterministic content hash for the /s/<hash>/ prefix: sha256 over the
// sorted "relPath\0sha256(content)\n" lines of every shipped file (NOT
// including index.html itself -- index.html references the hash, so
// hashing it too would be circular, and it stays unhashed/no-cache at "/"
// regardless). Sorting first means the hash depends only on the file set's
// content, not the filesystem's (or Set's) iteration order. Truncated to
// 16 hex chars -- enough collision resistance for a cache-busting path
// segment, short enough to keep <base href> readable.
export function computeAssetHash(files) {
  const lines = files
    .map(({ relPath, content }) => `${relPath}\0${createHash("sha256").update(content).digest("hex")}`)
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

// Inserts `<base href="<baseHref>">` as the very first child of <head> --
// before any stylesheet, so every relative src/href in the document
// (script/link tags AND any relative fetch() the fork itself makes with a
// relative URL) resolves against the hashed prefix. HTML spec best
// practice is "first element in head"; this build never has anything
// earlier for <base> to arrive too late to affect.
export function injectBaseHref(html, baseHref) {
  const HEAD_OPEN_RE = /(<head[^>]*>)/i;
  if (!HEAD_OPEN_RE.test(html)) {
    throw new Error("profile.mjs: injectBaseHref found no <head> tag to inject into");
  }
  const tag = `\n    <base href="${escapeAttr(baseHref)}">`;
  return html.replace(HEAD_OPEN_RE, (_m, open) => `${open}${tag}`);
}

// Inserts one `<link rel="modulepreload" href="...">` per path, right
// before </head>. These are resource hints only -- they never execute or
// reorder anything -- so inserting them here cannot change the execution
// order of the real <script>/<link rel="stylesheet"> tags already in the
// document (the property WS-D criterion 3's own tag-order test checks).
export function injectModulePreloads(html, paths) {
  if (paths.length === 0) return html;
  const HEAD_CLOSE_RE = /(<\/head>)/i;
  if (!HEAD_CLOSE_RE.test(html)) {
    throw new Error("profile.mjs: injectModulePreloads found no </head> tag to inject into");
  }
  const tags = paths.map((p) => `    <link rel="modulepreload" href="${escapeAttr(p)}">`).join("\n");
  return html.replace(HEAD_CLOSE_RE, (_m, close) => `${tags}\n${close}`);
}

// D#37 WS-D criterion 7 (OPEN OWNER DECISION 1): theme-manager.js's own
// DEFAULT_THEME_ID literal (see that file's header comment) is the one
// place a fresh visitor's starting theme comes from. Substituting it here,
// from the profile's own default_theme field, is what makes "an override
// changes only the theme id in profiles/cloud.json" literally true --
// nobody has to touch the fork's JS to change the default.
const DEFAULT_THEME_MARKER_RE = /var DEFAULT_THEME_ID = "[^"]*";/;

export function substituteDefaultTheme(content, themeId) {
  if (!DEFAULT_THEME_MARKER_RE.test(content)) {
    throw new Error("profile.mjs: DEFAULT_THEME_ID marker not found in theme-manager.js content");
  }
  return content.replace(DEFAULT_THEME_MARKER_RE, `var DEFAULT_THEME_ID = "${themeId}";`);
}

// D#37 WS-E criterion 6: taskbar.js's own DOCK_ORDER literal is the one
// place the dock's pin order comes from when nothing is saved yet. This
// mirrors substituteDefaultTheme() above exactly (same marker-and-replace
// technique WS-D criterion 7 established) rather than inventing a second way
// to thread a profile field into a shipped file: the profile itself has no
// runtime channel to the client (profiles/cloud.json is a build INPUT, never
// copied into dist/), so build-time substitution is the only way "dock order
// comes from profiles/cloud.json" is more than documentation.
const DOCK_ORDER_MARKER_RE = /var DOCK_ORDER = \[\];/;

export function substituteDockOrder(content, dockOrder) {
  if (!DOCK_ORDER_MARKER_RE.test(content)) {
    throw new Error("profile.mjs: DOCK_ORDER marker not found in taskbar.js content");
  }
  const order = Array.isArray(dockOrder) ? dockOrder : [];
  const literal = JSON.stringify(order);
  return content.replace(DOCK_ORDER_MARKER_RE, `var DOCK_ORDER = ${literal};`);
}

// D#37 WS-D criterion 8 (OPEN OWNER DECISION 2): "No theme id or name in
// shell/core/themes/*.json ... matches [this regex]". Scoped to the theme
// JSON files a profile actually SHIPS (the caller excludes
// profile.excluded_themes before calling this) -- windows-aero.json and
// ubuntu-gnome.json still legitimately carry "aero"/"windows"/"ubuntu"/
// "gnome" in their own id/name on disk (owner ruling: excluded from every
// profile's dist/, not deleted, for jpos parity) and would otherwise always
// fail this check despite never shipping. A blanket byte-scan over every
// shipped file (the pattern rules.mjs's other SHIP_* rules use) was
// rejected for this one: "windows" alone matches the ordinary English word
// inside "windows-container"/"openWindows", which is all over the shell's
// OWN core files and has nothing to do with vendor branding.
export const VENDOR_THEME_NAME_RE = /cupertino|mac ?os|sonoma|aqua|windows|aero|fluent|yaru|ubuntu|gnome/i;

// `themeFiles`: [{ relPath, content (JSON text) }]. Returns a list of
// { relPath, field, value } violations -- empty when clean.
export function validateThemeNames(themeFiles) {
  const violations = [];
  for (const { relPath, content } of themeFiles) {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error(`profile.mjs: ${relPath} is not valid JSON (${e.message})`);
    }
    for (const field of ["id", "name"]) {
      const value = parsed[field];
      if (typeof value === "string" && VENDOR_THEME_NAME_RE.test(value)) {
        violations.push({ relPath, field, value });
      }
    }
  }
  return violations;
}
