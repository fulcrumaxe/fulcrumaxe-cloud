import { promises as fs } from "node:fs";
import path from "node:path";
import type { Finding, GateResult } from "../types.js";
import { EMAIL_RE, FILE_EXTENSION_TLDS, SECRET_PATTERNS } from "./patterns.js";

export interface LeakOptions {
  /** Emails allowed to appear: an exact address, or "@domain.tld" for a whole domain. Case-insensitive. */
  emailAllowlist?: string[];
  /** The per-site deny-list. A string is a case-insensitive literal; a RegExp is used as given. */
  denyList?: (string | RegExp)[];
  /** The site.json content, parsed or raw text. Scanned as "/site.json" in addition to the rendered tree. */
  siteJson?: unknown;
}

/** First 4 characters plus length: enough to locate a hit, never enough to reuse it, since findings are stored in site_versions.report. */
function mask(value: string): string {
  return `${value.slice(0, 4)}… (${value.length} chars)`;
}

/** Replace every secret-shaped substring, for strings that go into a stored report. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const [, re] of SECRET_PATTERNS) out = out.replace(new RegExp(re.source, re.flags), "***");
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function emailAllowed(email: string, allowlist: readonly string[]): boolean {
  const e = email.toLowerCase();
  return allowlist.some((entry) => {
    const a = entry.toLowerCase();
    return a.startsWith("@") ? e.endsWith(a) : e === a;
  });
}

export function scanText(text: string, relPath: string, options: LeakOptions = {}): Finding[] {
  const findings: Finding[] = [];
  const add = (kind: string, value: string): void => {
    findings.push({ path: relPath, kind, message: `${kind.replace(/_/g, " ")}: ${mask(value)}`, severity: "error" });
  };
  for (const [kind, re] of SECRET_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) add(kind, m[0]);
  }
  const allow = options.emailAllowlist ?? [];
  for (const m of text.matchAll(new RegExp(EMAIL_RE.source, EMAIL_RE.flags))) {
    const tld = m[0].slice(m[0].lastIndexOf(".") + 1).toLowerCase();
    if (FILE_EXTENSION_TLDS.has(tld) || emailAllowed(m[0], allow)) continue;
    add("email_not_allowlisted", m[0]);
  }
  for (const entry of options.denyList ?? []) {
    const re =
      typeof entry === "string"
        ? new RegExp(escapeRegExp(entry), "gi")
        : new RegExp(entry.source, entry.flags.includes("g") ? entry.flags : entry.flags + "g");
    for (const m of text.matchAll(re)) add("deny_list", m[0]);
  }
  return findings;
}

const SNIFF_BYTES = 8192;
const MAX_SCAN_BYTES = 5 * 1024 * 1024;
/** Formats expected to hold NUL bytes. A NUL in any other file may be hiding text, so that is an error. */
const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|pdf|zip|gz|br|mp[34]|webm|ogg|wasm|bin)$/i;

/** "le"/"be" when the head looks like UTF-16 (BOM, or NULs alternating with non-NULs), else null. */
function utf16Kind(head: Buffer): "le" | "be" | null {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return "le";
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return "be";
  if (head.length < 4) return null;
  const pairs = Math.floor(head.length / 2);
  let odd = 0;
  let even = 0;
  for (let i = 0; i < pairs; i++) {
    if (head[2 * i] === 0) even += 1;
    if (head[2 * i + 1] === 0) odd += 1;
  }
  if (odd >= pairs * 0.4 && even <= pairs * 0.05) return "le";
  if (even >= pairs * 0.4 && odd <= pairs * 0.05) return "be";
  return null;
}

function decodeUtf16(buf: Buffer, kind: "le" | "be"): string {
  const even = buf.length - (buf.length % 2);
  const b = Buffer.from(buf.subarray(0, even));
  if (kind === "be") b.swap16();
  return b.toString("utf16le");
}

/** Every regular file, dotfiles and extensionless files included; anything else (symlink, socket) goes to `odd`. */
async function walk(dir: string, files: string[], odd: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, files, odd);
    else if (e.isFile()) files.push(full);
    else odd.push(full);
  }
}

/** Reject entries that match at every position: they would block every publish with noise. */
function assertDenyList(denyList: readonly (string | RegExp)[]): void {
  for (const entry of denyList) {
    const empty =
      typeof entry === "string" ? entry === "" : new RegExp(entry.source, entry.flags.replace(/[gy]/g, "")).test("");
    if (empty) throw new Error("denyList entry is empty or matches the empty string");
  }
}

/**
 * K06 criterion 1: secret/PII scan over site.json and the full rendered output.
 * Every non-binary file is scanned whatever its name. A file that cannot be
 * scanned is a finding, not silence: too large is an error (it may hold a
 * secret), binary is advisory (images and fonts are expected; detected by a NUL
 * byte in the first 8 KiB, not by extension). Any error finding blocks publish.
 */
export async function run(renderedDir: string, options: LeakOptions = {}): Promise<GateResult> {
  assertDenyList(options.denyList ?? []);
  const files: string[] = [];
  const odd: string[] = [];
  await walk(renderedDir, files, odd);
  files.sort();
  const relOf = (file: string): string => "/" + path.relative(renderedDir, file).split(path.sep).join("/");
  const findings: Finding[] = [];
  let skipped = 0;
  const skip = (file: string, message: string, severity: Finding["severity"]): void => {
    skipped += 1;
    findings.push({ path: relOf(file), kind: "unscanned_file", message, severity });
  };
  for (const file of odd.sort()) skip(file, "not a regular file, so not scanned", "error");
  let scanned = 0;
  for (const file of files) {
    const size = (await fs.stat(file)).size;
    const fh = await fs.open(file, "r");
    let buf: Buffer;
    let utf16: "le" | "be" | null = null;
    try {
      const head = Buffer.alloc(Math.min(size, SNIFF_BYTES));
      await fh.read(head, 0, head.length, 0);
      if (head.includes(0)) {
        utf16 = utf16Kind(head);
        if (utf16 === null) {
          const binary = BINARY_EXT.test(file);
          skip(file, `${binary ? "binary" : "unrecognised NUL-bearing"} file skipped (${size} bytes)`, binary ? "advisory" : "error");
          continue;
        }
      }
      if (size > MAX_SCAN_BYTES) {
        skip(file, `file too large to scan (${size} bytes)`, "error");
        continue;
      }
      buf = await fh.readFile();
    } finally {
      await fh.close();
    }
    findings.push(...scanText(utf16 ? decodeUtf16(buf, utf16) : buf.toString("utf-8"), relOf(file), options));
    scanned += 1;
  }
  if (options.siteJson !== undefined) {
    const raw = typeof options.siteJson === "string" ? options.siteJson : JSON.stringify(options.siteJson);
    findings.push(...scanText(raw, "/site.json", options));
    scanned += 1;
  }
  return {
    ok: !findings.some((f) => f.severity === "error"),
    findings,
    summary: { filesScanned: scanned, filesSkipped: skipped },
  };
}
