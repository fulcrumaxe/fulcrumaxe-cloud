import { promises as fs } from "node:fs";
import type { CheckOptions, CheckResult, Finding } from "../types.js";
import { findHtmlFiles, urlFor } from "../lib/walk.js";

/**
 * Port of os-site-v2/tools/check-a11y.py: the accessibility rules that are
 * decidable from markup alone. Not an audit. Deliberately narrow, because a
 * check that guesses at judgement calls produces noise and gets ignored.
 *
 * Every page under renderedDir is checked, translated pages included.
 */
export interface A11yOptions extends CheckOptions {
  /** Page paths ("/x.html") allowed to have a number of <h1> other than one. Default []. */
  h1ExemptPaths?: string[];
  /** Page paths allowed to have no skip link. Default ["/404.html"]. */
  skipLinkExemptPaths?: string[];
  /** The class a skip link carries. Default "skip-link". */
  skipLinkClass?: string;
}

export async function run(renderedDir: string, options: A11yOptions = {}): Promise<CheckResult> {
  const h1Exempt = new Set(options.h1ExemptPaths ?? []);
  const skipExempt = new Set(options.skipLinkExemptPaths ?? ["/404.html"]);
  const skipClass = options.skipLinkClass ?? "skip-link";
  const findings: Finding[] = [];
  const files = await findHtmlFiles(renderedDir);

  for (const file of files) {
    const doc = await fs.readFile(file, "utf-8");
    const url = urlFor(renderedDir, file);
    const add = (kind: string, message: string) => findings.push({ path: url, kind, message, severity: "error" });

    // 1. Every <img> needs an alt attribute. Empty is fine (decoration); absent is not.
    for (const tag of doc.match(/<img\b[^>]*>/g) ?? []) {
      if (!/\balt=/.test(tag)) {
        const src = /\bsrc="([^"]*)"/.exec(tag);
        add("img_missing_alt", `img without alt: ${(src?.[1] ?? tag).slice(0, 70)}`);
      }
    }

    // 2. Exactly one <h1>.
    const h1s = (doc.match(/<h1\b/g) ?? []).length;
    if (!h1Exempt.has(url) && h1s !== 1) {
      add("h1_count", `${h1s} <h1> elements, expected exactly 1`);
    }

    // 3. lang on <html>.
    if (!/<html[^>]*\blang=/.test(doc)) {
      add("html_missing_lang", "no lang on <html>");
    }

    // 4. Form controls need a label or accessible name; placeholder is not a label.
    for (const m of doc.matchAll(/<input\b[^>]*>/g)) {
      const tag = m[0];
      if (/type="(hidden|submit|button)"/.test(tag)) continue;
      if (/\baria-label(?:ledby)?=/.test(tag)) continue;
      const ident = /\bid="([^"]*)"/.exec(tag);
      if (ident && doc.includes(`for="${ident[1]}"`)) continue;
      // Wrapped: the nearest <label> before it is not yet closed.
      const before = doc.slice(0, m.index);
      if (before.lastIndexOf("<label") > before.lastIndexOf("</label>")) continue;
      add("input_missing_label", `input without a label: ${tag.slice(0, 70)}`);
    }

    // 5. A skip link.
    if (!skipExempt.has(url) && !doc.includes(`class="${skipClass}"`)) {
      add("missing_skip_link", "no skip link");
    }
  }

  return { ok: findings.length === 0, findings, summary: { pages: files.length } };
}
