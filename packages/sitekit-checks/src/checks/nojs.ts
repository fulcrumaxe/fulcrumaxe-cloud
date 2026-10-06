import { promises as fs } from "node:fs";
import type { CheckOptions, CheckResult, Finding } from "../types.js";
import { findHtmlFiles, urlFor } from "../lib/walk.js";

/**
 * Port of os-site-v2/tools/check-nojs.py.
 *
 * Finds pages that say nothing without JavaScript. The bar is deliberately
 * low: a page has to say SOMETHING — a heading, a sentence, a link onwards —
 * before any script runs.
 */

export interface NojsOptions extends CheckOptions {
  /** Words of visible prose a page must have before any script runs. */
  minWords?: number;
}

const MIN_WORDS_DEFAULT = 40;

// Chinese/CJK is written without spaces, so a naive split() counts a whole
// paragraph as one "word". Count each ideograph as one word instead — see
// the original's docstring for why this bar (not a token, not a word) is
// still the right generosity to allow for those scripts.
const CJK = "㐀-䶿一-鿿豈-﫿\u{20000}-\u{2ffff}";
const CJK_SPLIT = new RegExp(`([${CJK}])`, "gu");

function staticText(doc: string): string[] {
  const bodyMatch = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(doc);
  let text = bodyMatch?.[1] ?? doc;
  text = text.replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // `hidden` elements are revealed by JS; without it they are not there.
  text = text.replace(/<(\w+)[^>]*\bhidden\b[^>]*>[\s\S]*?<\/\1>/g, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&[a-zA-Z]+;|&#\d+;/g, " ");
  text = text.replace(CJK_SPLIT, " $1 ");
  return text.split(/\s+/).filter((w) => w.length > 0);
}

export async function run(renderedDir: string, options: NojsOptions = {}): Promise<CheckResult> {
  const minWords = options.minWords ?? MIN_WORDS_DEFAULT;
  const findings: Finding[] = [];
  const files = await findHtmlFiles(renderedDir);

  for (const file of files) {
    const doc = await fs.readFile(file, "utf-8");
    const url = urlFor(renderedDir, file);
    const words = staticText(doc).length;
    if (words < minWords) {
      findings.push({
        path: url,
        kind: "thin_without_js",
        message: `renders ${words} words without JavaScript (under ${minWords})`,
        severity: "error",
      });
    }
  }

  const ok = findings.length === 0;
  return { ok, findings, summary: { pages: files.length } };
}
