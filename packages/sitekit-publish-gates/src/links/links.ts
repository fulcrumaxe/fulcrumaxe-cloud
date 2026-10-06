import { promises as fs } from "node:fs";
import path from "node:path";
import type { Finding, GateResult } from "../types.js";
import { maskSecrets } from "../leak/scan.js";

export interface LinkPolicyOptions {
  /** The site's own hosts (SiteContent.domains). An outbound link to any other host needs approval. */
  siteDomains?: string[];
  /** Outbound URLs the customer has approved, one entry per link. Compared after URL normalisation, fragment ignored. */
  approvedLinks?: string[];
}

/** Attributes whose value is a single URL. `data` covers <object data>; `data-href` is not matched by it (needs "=" right after). */
const URL_ATTR = /\b(?:href|src|action|formaction|poster|cite|data|data-href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const SRCSET_ATTR = /\b(?:srcset|imagesrcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const META_TAG = /<meta\b[^>]*>/gi;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", sol: "/", bsol: "\\", period: ".", comma: ",",
  semi: ";", num: "#", quest: "?", equals: "=", lpar: "(", rpar: ")", excl: "!", percnt: "%", commat: "@",
  plus: "+", lowbar: "_", Tab: "\t", NewLine: "\n", nbsp: " ",
};

/** One-pass HTML attribute entity decode, like a browser. Returns null for a reference we cannot resolve: the caller must fail closed. */
function decodeEntities(s: string): string | null {
  let bad = false;
  const out = s.replace(
    /&(?:#([0-9]+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z][A-Za-z0-9]*);)|&(amp|lt|gt|quot|nbsp)(?![A-Za-z0-9=])/g,
    (_m, dec: string | undefined, hex: string | undefined, name: string | undefined, legacy: string | undefined) => {
      if (legacy) return NAMED_ENTITIES[legacy] ?? "";
      if (name !== undefined) {
        if (Object.hasOwn(NAMED_ENTITIES, name)) return NAMED_ENTITIES[name] ?? "";
        bad = true;
        return "";
      }
      const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex ?? "", 16);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        bad = true;
        return "";
      }
      return String.fromCodePoint(cp);
    },
  );
  return bad ? null : out;
}

type Classified =
  | { type: "skip" }
  | { type: "url"; url: URL }
  | { type: "bad"; kind: "unparseable_link" | "disallowed_link_scheme"; detail: string };

/** Sort one raw attribute value into: not our business (relative, mailto, tel), a parsed http(s) URL, or a finding. */
export function classifyLink(raw: string): Classified {
  const decoded = decodeEntities(raw);
  if (decoded === null) return { type: "bad", kind: "unparseable_link", detail: "unresolvable HTML entity" };
  // Browsers strip surrounding C0/space and any tab or newline before parsing a URL.
  const s = decoded.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "").replace(/[\t\n\r]/g, "");
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(s)?.[1]?.toLowerCase();
  let target: string;
  if (scheme === undefined) {
    if (!/^[\\/]{2}/.test(s)) return { type: "skip" };
    target = `https:${s.replace(/\\/g, "/")}`;
  } else if (scheme === "mailto" || scheme === "tel") {
    return { type: "skip" };
  } else if (scheme !== "http" && scheme !== "https") {
    return { type: "bad", kind: "disallowed_link_scheme", detail: `${scheme}: URL` };
  } else {
    target = s;
  }
  try {
    const u = new URL(target);
    if (!u.hostname) throw new Error("no host");
    u.hash = "";
    return { type: "url", url: u };
  } catch {
    return { type: "bad", kind: "unparseable_link", detail: `${scheme ?? "https"} link that does not parse (${s.length} chars)` };
  }
}

export function normalizeLink(raw: string): URL | null {
  const c = classifyLink(raw);
  return c.type === "url" ? c.url : null;
}

/** Scheme, host and path only: userinfo is dropped and query values are masked, since findings are stored in site_versions.report. */
export function displayLink(u: URL): string {
  const cred = u.username || u.password ? "***@" : "";
  const query = u.search ? "?" + [...u.searchParams.keys()].map((k) => `${k}=***`).join("&") : "";
  // A webhook or API key can sit in the path, so the secret patterns run over the whole string.
  return maskSecrets(`${u.protocol}//${cred}${u.host}${u.pathname}${query}`);
}

/** Every URL-bearing value in a document: plain attributes, each srcset candidate, and meta-refresh targets. */
function linkValues(doc: string): string[] {
  const values: string[] = [];
  for (const m of doc.matchAll(URL_ATTR)) values.push(m[1] ?? m[2] ?? m[3] ?? "");
  for (const m of doc.matchAll(SRCSET_ATTR)) {
    const decoded = decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
    if (decoded === null) {
      values.push("&unresolvable;");
      continue;
    }
    // srcset grammar: a URL runs to whitespace (trailing commas trimmed), then descriptors run to the next comma.
    for (const cand of decoded.matchAll(/(?:^|,)\s*([^\s,]\S*)[^,]*/g)) values.push((cand[1] ?? "").replace(/,+$/, ""));
  }
  for (const tag of doc.match(META_TAG) ?? []) {
    if (!/http-equiv\s*=\s*["']?\s*refresh/i.test(tag)) continue;
    const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    const decoded = decodeEntities(content?.[1] ?? content?.[2] ?? content?.[3] ?? "");
    if (decoded === null) values.push("&unresolvable;");
    else {
      const target = /url\s*=\s*['"]?([^'";]*)/i.exec(decoded);
      if (target?.[1] !== undefined) values.push(target[1]);
    }
  }
  return values;
}

async function htmlFiles(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await htmlFiles(full, out);
    else if (e.isFile() && /\.html?$/i.test(e.name)) out.push(full);
  }
}

/**
 * K06 criterion 2: every outbound link to a host outside the site's own
 * domains is an error until the customer has approved that exact URL.
 * One finding per distinct link per page, so the review page can show each
 * link and its approval state. Fails closed: a link that is not relative,
 * mailto or tel and does not parse as http(s) is an error, never dropped.
 * Approval matching uses the full URL in memory; findings carry only the
 * masked display form. Never fetches: liveness is not this gate's job.
 */
export async function run(renderedDir: string, options: LinkPolicyOptions = {}): Promise<GateResult> {
  const own = new Set((options.siteDomains ?? []).map((d) => d.toLowerCase()));
  const approved = new Set(
    (options.approvedLinks ?? []).map((l) => normalizeLink(l)?.href).filter((h): h is string => h !== undefined),
  );
  const files: string[] = [];
  await htmlFiles(renderedDir, files);
  files.sort();
  const findings: Finding[] = [];
  const distinct = new Set<string>();
  for (const file of files) {
    const rel = "/" + path.relative(renderedDir, file).split(path.sep).join("/");
    const seen = new Set<string>();
    for (const value of linkValues(await fs.readFile(file, "utf-8"))) {
      const c = classifyLink(value);
      if (c.type === "skip") continue;
      if (c.type === "bad") {
        // The raw value never goes into a message: it may hold a credential.
        const key = `${c.kind}|${c.detail}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ path: rel, kind: c.kind, message: `link not allowed: ${c.detail}`, severity: "error" });
        continue;
      }
      const u = c.url;
      if (own.has(u.hostname.toLowerCase()) || seen.has(u.href)) continue;
      seen.add(u.href);
      distinct.add(u.href);
      if (approved.has(u.href)) continue;
      const subject = displayLink(u);
      findings.push({
        path: rel,
        kind: "unapproved_outbound_link",
        message: `outbound link to ${u.hostname} awaits customer approval: ${subject}`,
        severity: "error",
        subject,
      });
    }
  }
  return { ok: findings.length === 0, findings, summary: { filesScanned: files.length, outboundLinks: distinct.size } };
}
