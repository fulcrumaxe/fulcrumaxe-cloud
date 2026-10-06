// Run with: node --test scripts/ci/licence.test.mjs
//
// The licence files of a source-visible, proprietary repository: LICENSE must grant nothing beyond viewing and forking on
// github.com (and say that GitHub's Terms of Service are where those rights come from), every font file must be named in
// THIRD-PARTY-NOTICES, every package.json must say UNLICENSED, packages/runner-protocol must carry the root LICENSE byte for
// byte, and no tracked file outside archive/ and THIRD-PARTY-NOTICES may claim AGPL for this code.
//
// The checks are plain functions over text and lists, so each one is also run against a fixture that must fail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const tracked = () =>
  execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((f) => f && existsSync(path.join(root, f)));

// ---- the checks ----------------------------------------------------------------------------------------------------

/** Phrases that would be a grant (or name a licence) in a LICENSE that is meant to grant nothing. */
const GRANT_PHRASES = [
  /permission is hereby granted/i,
  /licensed under/i,
  /\bMIT\b/,
  /\bApache\b/i,
  /\bGNU\b/i,
  /\bBSD\b/,
  /\bMozilla\b/i,
];

/** Problems with the text of a LICENSE or NOTICE, as a list of strings. */
export function licenceProblems(text, { name = "LICENSE", requireTerms = false } = {}) {
  const out = [];
  if (!/Formal Hosting LLC/.test(text)) out.push(`${name}: does not name Formal Hosting LLC`);
  for (const re of GRANT_PHRASES) if (re.test(text)) out.push(`${name}: contains a grant phrase (${re})`);
  if (requireTerms) {
    if (!/All rights reserved/.test(text)) out.push(`${name}: does not say "All rights reserved"`);
    // GitHub's Terms of Service must be named as the only source of the viewing and forking rights.
    if (!/GitHub's Terms of Service/.test(text)) out.push(`${name}: does not name GitHub's Terms of Service`);
    if (!/only source/.test(text)) out.push(`${name}: does not say the Terms of Service are the only source of rights`);
    if (!/view and\s+fork/.test(text)) out.push(`${name}: does not name viewing and forking`);
  }
  return out;
}

const FONT_RE = /\.(woff2|woff|ttf|otf)$/i;

/** Tracked font files that THIRD-PARTY-NOTICES does not name by file name. */
export function unnamedFonts(files, notices) {
  return files.filter((f) => FONT_RE.test(f) && !notices.includes(path.basename(f)));
}

/** The expected copyright line of each of the four fonts (the lines recorded inside the font files). */
const FONT_COPYRIGHTS = [
  "Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)",
  "Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)",
  "Copyright (c) 2012, Carrois Type Design, Ralph du Carrois (post@carrois.com www.carrois.com),",
];

/** `package.json` files whose "license" is not UNLICENSED. */
export function badManifests(manifests) {
  return Object.entries(manifests)
    .filter(([, json]) => json.license !== "UNLICENSED")
    .map(([file, json]) => `${file}: license is ${JSON.stringify(json.license)}`);
}

// A path is exempt from the AGPL scan only with a reason. None of these claims AGPL for this repository's code.
const AGPL_EXEMPT = {
  "packages/sitekit-checks/src/checks/i18nCatalogue.ts": "keeps a licence token verbatim in a site-kit translation catalogue",
  "packages/sitekit-checks/test/fixtures/check-i18n-catalogue/fail/index.html": "fixture page for that check",
  "packages/sitekit-checks/test/fixtures/check-i18n-catalogue/pass/index.html": "fixture page for that check",
  "packages/sitekit-checks/test/fixtures/check-i18n-catalogue/fail/i18n/es/index.html.json": "fixture catalogue for that check",
  "packages/sitekit-checks/test/fixtures/check-i18n-catalogue/pass/i18n/es/index.html.json": "fixture catalogue for that check",
  "apps/workspace/shell/apps/activation/activation.css": "comment about the old engine download, not a claim about this code",
  "apps/workspace/shell/apps/activation/activation.js": "comment about the old engine download, not a claim about this code",
  "apps/workspace/shell/apps/activation/activation-app-lock.js": "comment about the old engine download, not a claim about this code",
  "pnpm-lock.yaml": "a base64 integrity hash contains the letters by chance",
  "scripts/ci/licence.test.mjs": "this test names the licence it looks for",
  "scripts/ci/affected.test.mjs": "CI-scope fixtures replay licence-change file lists and manifest edits, including the archived licence path; not a claim about this code",
};

/** Tracked files (outside archive/, THIRD-PARTY-NOTICES and the exempt list) that mention AGPL or Affero. */
export function agplHits(files, readFile, exempt = AGPL_EXEMPT) {
  const hits = [];
  for (const f of files) {
    if (f.startsWith("archive/") || f === "THIRD-PARTY-NOTICES" || f in exempt) continue;
    let text;
    try {
      text = readFile(f);
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    if (/AGPL|Affero/i.test(text)) hits.push(f);
  }
  return hits;
}

// ---- the real tree -------------------------------------------------------------------------------------------------

test("LICENSE and NOTICE name Formal Hosting LLC; LICENSE says All rights reserved and grants nothing", () => {
  for (const f of ["LICENSE", "NOTICE"]) assert.match(read(f), /Formal Hosting LLC/, f);
  assert.match(read("LICENSE"), /All rights reserved/);
  assert.deepEqual(licenceProblems(read("LICENSE"), { requireTerms: true }), []);
  assert.deepEqual(licenceProblems(read("NOTICE"), { name: "NOTICE" }), []);
});

test("every font file is named in THIRD-PARTY-NOTICES, with the OFL text and each copyright line", () => {
  const notices = read("THIRD-PARTY-NOTICES");
  const files = tracked();
  const fonts = files.filter((f) => FONT_RE.test(f));
  assert.ok(fonts.length >= 4, "the four fonts are tracked");
  assert.deepEqual(unnamedFonts(files, notices), []);
  assert.match(notices, /SIL OPEN FONT LICENSE Version 1\.1/);
  for (const part of ["PREAMBLE", "DEFINITIONS", "PERMISSION & CONDITIONS", "TERMINATION", "DISCLAIMER"]) {
    assert.ok(notices.includes(part), `OFL section ${part}`);
  }
  for (const line of FONT_COPYRIGHTS) assert.ok(notices.includes(line), line);
});

test("the root package.json and every workspace package.json say UNLICENSED", () => {
  const manifests = {};
  for (const f of tracked().filter((p) => /(^|\/)package\.json$/.test(p) && !p.includes("node_modules"))) {
    manifests[f] = JSON.parse(read(f));
  }
  assert.ok("package.json" in manifests && "packages/runner-protocol/package.json" in manifests);
  assert.ok(Object.keys(manifests).length > 20, "the workspaces were enumerated");
  assert.deepEqual(badManifests(manifests), []);
});

test("packages/runner-protocol has the root LICENSE byte for byte and a README that says source-visible", () => {
  assert.ok(readFileSync(path.join(root, "packages/runner-protocol/LICENSE")).equals(readFileSync(path.join(root, "LICENSE"))));
  const readme = read("packages/runner-protocol/README.md");
  assert.match(readme, /source-visible/i);
  assert.match(readme, /proprietary/i);
  assert.match(readme, /check what leaves your machine/);
  // archive/ is a private overlay directory: the public tree does not carry it, so the check holds only where it exists.
  if (existsSync(path.join(root, "archive"))) assert.ok(existsSync(path.join(root, "archive/runner-protocol-agpl-2026-10-05/LICENSE")), "old text archived");
});

test("no tracked file outside archive/ and THIRD-PARTY-NOTICES claims AGPL", () => {
  const files = tracked();
  const hits = agplHits(files, read);
  assert.deepEqual(hits, [], `AGPL mentioned in: ${hits.join(", ")}`);
  for (const f of Object.keys(AGPL_EXEMPT)) assert.ok(files.includes(f), `stale exemption ${f}`);
});

test("CONTRIBUTING.md says outside contributions wait for a contributor licence agreement", () => {
  const text = read("CONTRIBUTING.md");
  assert.match(text, /not accepted until a contributor licence agreement/);
});

// ---- the checks must fail on bad fixtures ---------------------------------------------------------------------------

const GOOD = read("LICENSE");

test("fixture: a LICENSE containing any grant phrase fails", () => {
  for (const phrase of ["Permission is hereby granted", "licensed under", "MIT", "Apache", "GNU", "BSD", "Mozilla"]) {
    const problems = licenceProblems(`${GOOD}\n${phrase} something\n`, { requireTerms: true });
    assert.ok(problems.some((p) => p.includes("grant phrase")), phrase);
  }
  assert.deepEqual(licenceProblems(GOOD, { requireTerms: true }), []);
});

test("fixture: a LICENSE that does not name GitHub's Terms of Service as the only source fails", () => {
  const without = GOOD.replaceAll("GitHub's Terms of Service", "the site rules");
  assert.ok(licenceProblems(without, { requireTerms: true }).some((p) => p.includes("Terms of Service")));
  assert.ok(licenceProblems("Copyright (c) 2026 Formal Hosting LLC.\n", { requireTerms: true }).length >= 3);
  assert.ok(licenceProblems("All rights reserved.\n").some((p) => p.includes("Formal Hosting LLC")));
});

test("fixture: a tracked font file that THIRD-PARTY-NOTICES does not name fails", () => {
  const notices = read("THIRD-PARTY-NOTICES");
  for (const ext of ["woff2", "woff", "ttf", "otf"]) {
    assert.deepEqual(unnamedFonts([`assets/NewFace-Regular.${ext}`], notices), [`assets/NewFace-Regular.${ext}`]);
  }
  assert.deepEqual(unnamedFonts(["assets/Inter-Medium.woff2", "src/a.ts"], notices), []);
});

test("fixture: a manifest without UNLICENSED fails", () => {
  assert.equal(badManifests({ "a/package.json": {}, "b/package.json": { license: "MIT" }, "c/package.json": { license: "UNLICENSED" } }).length, 2);
});

test("fixture: an AGPL claim is listed with its path, and archive/ and THIRD-PARTY-NOTICES are skipped", () => {
  const body = { "packages/x/README.md": "Licence: AGPL-3.0-only", "archive/y/LICENSE": "GNU Affero", THIRD_PARTY: "" };
  const files = ["packages/x/README.md", "archive/y/LICENSE", "THIRD-PARTY-NOTICES", "docs/ok.md"];
  const readFile = (f) => (f === "THIRD-PARTY-NOTICES" ? "AGPL" : (body[f] ?? "fine"));
  assert.deepEqual(agplHits(files, readFile, {}), ["packages/x/README.md"]);
});
