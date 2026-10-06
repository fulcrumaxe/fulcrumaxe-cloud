import { promises as fs } from "node:fs";
import type { CheckOptions, CheckResult, Finding } from "../types.js";
import { walkFiles } from "../lib/walk.js";

/**
 * Port of os-site-v2/tools/check-redaction.mjs, generic-secret half.
 *
 * The original scans the site's own live endpoints for a fixed, hardcoded
 * list of that one deployment's private strings (its own GitHub org, its own
 * internal hostname). A multi-tenant site kit cannot hardcode a customer's
 * private strings, so this port takes them as `options` — a deny-list of the
 * *customer's* private hosts, account names and email patterns — and always
 * also checks the same generic secret-shaped patterns the original checked
 * (tokens, keys, hex blobs, home paths). See D#2606 K02 item 3.
 */

export interface EvidenceCommits {
  host: "github.com";
  /** owner/name, matched exactly against the link's path. */
  repo: string;
  /** Commit ids the server already holds for the site. */
  shas: string[];
}

export interface RedactionOptions extends CheckOptions {
  /** Private hostnames that must never appear in rendered output. */
  denyHosts?: string[];
  /** Private account/org names (e.g. a GitHub login) that must never appear. */
  denyAccounts?: string[];
  /** Extra email addresses or patterns (string = literal, RegExp = pattern) to deny. */
  denyEmailPatterns?: (string | RegExp)[];
  /**
   * Opt-in, and off when absent (then behaviour is exactly the original's). A hex run is exempt from the
   * "40+ char hex blob" rule only when it is the whole commit segment of an evidence link, in the href of an
   * <a> element, of the form https://github.com/<repo>/blob/<sha>/<rest>, and <sha> is exactly 40 or 64
   * lowercase hex AND is one of `shas`. Every other pattern still sees the whole link.
   */
  evidenceCommits?: EvidenceCommits;
  /** File extensions to scan. Default covers rendered HTML, JSON and text assets. */
  extensions?: string[];
}

const DEFAULT_EXTENSIONS = [".html", ".htm", ".json", ".txt", ".xml", ".js", ".css"];

/** Generic secret-shaped patterns, independent of any single site's private strings. */
export const GENERIC_LEAK_PATTERNS: [string, RegExp][] = [
  ["absolute home path", /\/(?:home|Users)\/[A-Za-z0-9._-]+/g],
  ["email address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{16,}\b/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["JWT", /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["40+ char hex blob", /\b[A-Fa-f0-9]{40,}\b/g],
];

/** Canonical plants each generic pattern above must fire on — used by this package's own tests as a negative control, mirroring the original's self-test. */
export const GENERIC_LEAK_PLANTS: Record<string, string> = {
  "absolute home path": "see /home/someone/.config",
  "email address": "mail someone@example.org",
  "GitHub token": "token ghp_abcdefghijklmnopqrstuv",
  "OpenAI-style key": "key sk-abcdefghijklmnopqrstuv",
  "AWS access key": "AKIAABCDEFGHIJKLMNOP",
  "private key block": "-----BEGIN RSA PRIVATE KEY-----",
  JWT: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "40+ char hex blob": "a".repeat(40),
};

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildDenyPatterns(options: RedactionOptions): [string, RegExp][] {
  const out: [string, RegExp][] = [];
  for (const host of options.denyHosts ?? []) {
    out.push([`denied host: ${host}`, new RegExp(escapeRegExp(host), "gi")]);
  }
  for (const account of options.denyAccounts ?? []) {
    out.push([`denied account: ${account}`, new RegExp(escapeRegExp(account), "gi")]);
  }
  for (const pattern of options.denyEmailPatterns ?? []) {
    const re = typeof pattern === "string" ? new RegExp(escapeRegExp(pattern), "gi") : pattern;
    out.push([`denied email pattern: ${pattern}`, re]);
  }
  return out;
}

const HEX_RULE = "40+ char hex blob";
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeHtml(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g, (whole, dec, hex, name) => {
    const cp = dec !== undefined ? Number(dec) : hex !== undefined ? parseInt(hex, 16) : undefined;
    if (cp !== undefined) return cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    return NAMED_ENTITIES[name] ?? whole;
  });
}

/** Skips comments and raw-text elements (an <a inside them is not an element); otherwise stops at each <a. */
const TAG_START = /<!--(?:[\s\S]*?-->|[\s\S]*$)|<(script|style|textarea|title)\b(?:[\s\S]*?<\/\1\s*>|[\s\S]*$)|<a(?=[\s/>])/gi;
// Whitespace and slashes between attributes are skipped by SEPARATORS in one step. Folding them into ATTR as a
// leading `[\s/]*` made every failed attempt rescan the whole run, which is quadratic on a long run of spaces.
const SEPARATORS = /[\s/]+/y;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/y;

/**
 * Character ranges of the sha in every <a href> that is an evidence link to a known commit. Anything unusual (two
 * href attributes, an unterminated tag, an entity inside the URL prefix, a different host or repo) yields no range.
 */
function exemptShaRanges(html: string, ev: EvidenceCommits): Map<number, number> {
  const out = new Map<number, number>(); // start -> end, so a lookup per hex match is O(1)
  if (ev.host !== "github.com" || !REPO_SLUG.test(ev.repo)) return out;
  const known = new Set(ev.shas.filter((s) => COMMIT_ID.test(s)));
  const prefix = `https://${ev.host}/${ev.repo}/blob/`;
  TAG_START.lastIndex = 0;
  for (let t = TAG_START.exec(html); t; t = TAG_START.exec(html)) {
    if (t[0].length !== 2) continue; // a comment or raw-text element, not an <a
    let pos = t.index + 2;
    let closed = false;
    const hrefs: { raw: string; at: number }[] = [];
    while (pos < html.length) {
      if (html[pos] === ">") { closed = true; break; }
      SEPARATORS.lastIndex = pos;
      if (SEPARATORS.test(html)) { pos = SEPARATORS.lastIndex; continue; }
      ATTR.lastIndex = pos;
      const a = ATTR.exec(html);
      if (!a) { pos += 1; continue; }
      if (a[1]?.toLowerCase() === "href") {
        const quoted = a[2] !== undefined || a[3] !== undefined;
        const raw = a[2] ?? a[3] ?? a[4] ?? "";
        hrefs.push({ raw, at: a.index + a[0].length - raw.length - (quoted ? 1 : 0) });
      }
      pos = ATTR.lastIndex;
    }
    TAG_START.lastIndex = Math.max(pos, TAG_START.lastIndex);
    const only = hrefs.length === 1 ? hrefs[0] : undefined;
    if (!closed || !only) continue;
    const { raw, at } = only;
    // Raw, not just unescaped, must carry the prefix: an entity-encoded URL is not exempt (fail closed).
    if (!raw.startsWith(prefix)) continue;
    const sha = raw.slice(prefix.length).match(/^(?:[0-9a-f]{64}|[0-9a-f]{40})(?=\/)/)?.[0];
    if (!sha || !known.has(sha)) continue;
    let url: URL;
    try { url = new URL(unescapeHtml(raw)); } catch { continue; }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port) continue;
    if (!url.pathname.startsWith(`/${ev.repo}/blob/${sha}/`)) continue;
    const start = at + prefix.length;
    out.set(start, start + sha.length);
  }
  return out;
}

export async function run(renderedDir: string, options: RedactionOptions = {}): Promise<CheckResult> {
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const patterns = [...GENERIC_LEAK_PATTERNS, ...buildDenyPatterns(options)];
  const findings: Finding[] = [];
  const files = await walkFiles(renderedDir, (name) => extensions.some((ext) => name.endsWith(ext)));

  for (const file of files) {
    const text = await fs.readFile(file, "utf-8").catch(() => "");
    const relPath = "/" + file.slice(renderedDir.length).replace(/^\/+/, "");
    const exempt = options.evidenceCommits && /\.html?$/i.test(file) ? exemptShaRanges(text, options.evidenceCommits) : new Map<number, number>();
    for (const [name, re] of patterns) {
      re.lastIndex = 0;
      let m = re.exec(text);
      // The hex rule looks at every match, so an exempt commit id cannot hide a later one. The other patterns report
      // their first match per file, as before.
      while (m && name === HEX_RULE && exempt.get(m.index) === m.index + m[0].length) m = re.exec(text);
      if (m) {
        findings.push({
          path: relPath,
          kind: "leak",
          message: `${name}: ${JSON.stringify(m[0].slice(0, 60))}`,
          severity: "error",
        });
      }
    }
  }

  const ok = findings.length === 0;
  return { ok, findings, summary: { filesScanned: files.length } };
}
