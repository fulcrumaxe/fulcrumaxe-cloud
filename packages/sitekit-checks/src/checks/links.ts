import { promises as fs } from "node:fs";
import path from "node:path";
import type { CheckOptions, CheckResult, Finding } from "../types.js";
import { findHtmlFiles, urlFor } from "../lib/walk.js";

/**
 * Port of os-site-v2/tools/check-links.py.
 *
 * Verifies every internal href/src resolves to something in `renderedDir`,
 * flags non-absolute internal paths, and flags every external link whose
 * host is not one of the site's own domains as `needs_review` (a security
 * must-have per D#2606 K02 item 4). Never makes a network call: link
 * *liveness* is opt-in via `options.live`, and even then this port does not
 * perform it (that is a separate, explicitly network-gated feature a caller
 * can layer on).
 */

export interface LinksOptions extends CheckOptions {
  /** Hosts considered "the repo's own domains" — external links elsewhere are needs_review. */
  siteDomains?: string[];
  /** Paths that resolve by convention (platform rewrites, etc.) even without a file on disk. */
  allowPaths?: string[];
  /** Path prefixes considered served by the platform / a build step rather than the tree. */
  allowPrefixes?: string[];
  /** Off by default. This port never performs a live fetch even when true — see docstring. */
  live?: boolean;
}

const ANCHOR_HREF = /<(?:a|link)\b[^>]*href="([^"]+)"/g;
const ANCHOR_SRC = /<(?:script|img)\b[^>]*src="([^"]+)"/g;
const ID_ATTR = /\bid="([^"]+)"/g;
const SECTION_HEADING = /<h2 class="section-heading"[^>]*>(.*?)<\/h2>/gs;

function anchors(doc: string): string[] {
  const out: string[] = [];
  for (const m of doc.matchAll(ANCHOR_HREF)) out.push(m[1] ?? "");
  for (const m of doc.matchAll(ANCHOR_SRC)) out.push(m[1] ?? "");
  return out;
}

function idsIn(doc: string): Set<string> {
  const ids = new Set<string>();
  for (const m of doc.matchAll(ID_ATTR)) ids.add(m[1] ?? "");
  for (const m of doc.matchAll(SECTION_HEADING)) {
    let text = (m[1] ?? "").replace(/<[^>]+>/g, "");
    text = text.replace(/&[a-z]+;/g, " ");
    const slug = text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug) ids.add(slug);
  }
  return ids;
}

async function resolves(target: string, renderedDir: string, opts: LinksOptions): Promise<boolean> {
  let p = (target.split("#")[0] ?? "").split("?")[0] ?? "";
  if (!p || (opts.allowPaths ?? []).includes(p)) return true;
  if ((opts.allowPrefixes ?? []).some((prefix) => p.startsWith(prefix))) return true;
  if (p === "/") p = "/index.html";
  const local = path.join(renderedDir, p.replace(/^\//, ""));
  try {
    const st = await fs.stat(local);
    if (st.isFile()) return true;
    if (st.isDirectory()) {
      const idx = path.join(local, "index.html");
      const idxSt = await fs.stat(idx).catch(() => null);
      if (idxSt?.isFile()) return true;
    }
  } catch {
    // fx-swallow-ok: a path that cannot be stat-ed is a link target that does not exist; the function returns false
  }
  return false;
}

export async function run(renderedDir: string, options: LinksOptions = {}): Promise<CheckResult> {
  const siteDomains = new Set(options.siteDomains ?? []);
  const findings: Finding[] = [];
  const files = await findHtmlFiles(renderedDir);
  let checked = 0;

  for (const file of files) {
    const doc = await fs.readFile(file, "utf-8");
    const name = urlFor(renderedDir, file);

    for (const target of anchors(doc)) {
      if (/^https?:\/\//.test(target)) {
        const host = target.split("/")[2] ?? "";
        if (host && !siteDomains.has(host)) {
          findings.push({
            path: name,
            kind: "external_needs_review",
            message: `outbound link to ${host} is outside the site's own domains: ${target}`,
            severity: "advisory",
          });
        }
        continue;
      }
      if (/^(#|mailto:|data:|tel:)/.test(target)) continue;
      if (!target.startsWith("/")) {
        findings.push({
          path: name,
          kind: "relative_path",
          message: `relative path (this site uses absolute): ${target}`,
          severity: "error",
        });
        continue;
      }
      checked += 1;
      if (!(await resolves(target, renderedDir, options))) {
        findings.push({
          path: name,
          kind: "broken_link",
          message: `no such file: ${target}`,
          severity: "error",
        });
        continue;
      }
      if (target.includes("#")) {
        const [base, frag] = target.split("#");
        if (!frag) continue;
        const targetPath =
          !base || base === name
            ? file
            : path.join(renderedDir, (base === "/" ? "/index.html" : base).replace(/^\//, ""));
        const targetSt = await fs.stat(targetPath).catch(() => null);
        if (targetSt?.isFile()) {
          const targetDoc = await fs.readFile(targetPath, "utf-8");
          if (!idsIn(targetDoc).has(frag)) {
            findings.push({
              path: name,
              kind: "missing_anchor",
              message: `no such anchor on the target: ${target}`,
              severity: "error",
            });
          }
        }
      }
    }
  }

  const ok = findings.every((f) => f.severity !== "error");
  return { ok, findings, summary: { pages: files.length, linksChecked: checked } };
}
