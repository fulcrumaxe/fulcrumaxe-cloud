import { promises as fs } from "node:fs";
import path from "node:path";
import type { CheckOptions, CheckResult, Finding } from "../types.js";
import { findHtmlFiles, urlFor } from "../lib/walk.js";

/**
 * Port of os-site-v2/tools/check-weight.py.
 *
 * Counts what a first cold visit actually costs: the HTML plus every
 * same-origin stylesheet/script/image the markup references up front. Does
 * NOT count anything fetched later by JavaScript, or lazily-loaded images —
 * counting those would punish the design decision that keeps the page fast.
 */

export interface WeightOptions extends CheckOptions {
  /** Bytes, uncompressed, budget for one cold visit. */
  budgetBytes?: number;
  /** A tighter budget for JavaScript alone (it costs parse/execution, not just bytes). */
  jsBudgetBytes?: number;
  /** Same-origin URLs matching this are never counted (e.g. social-preview images only a scraper fetches). */
  ignorePattern?: RegExp;
}

const BUDGET_DEFAULT = 400 * 1024;
const JS_BUDGET_DEFAULT = 80 * 1024;

const PICTURE_BLOCK = /<picture>[\s\S]*?<\/picture>/g;
const WEBP_SOURCE = /<source[^>]+type="image\/webp"[^>]+srcset="([^"\s,]+)/;
const IMG_SRC = /(<img[^>]+src=")[^"]+(")/;
const LAZY_IMG = /<img[^>]+loading="lazy"[^>]*>/g;
const REFERENCED_PATTERNS = [/<link[^>]+href="([^"]+)"[^>]*>/g, /<script[^>]+src="([^"]+)"/g, /<img[^>]+src="([^"]+)"/g];

function pictureSources(doc: string): string {
  // Inside a <picture>, a browser that reads webp fetches the webp source and
  // never the <img> fallback. Swap each picture's <img src> for its webp so a
  // png fallback isn't charged to the page as well as the image actually loaded.
  return doc.replace(PICTURE_BLOCK, (block) => {
    const webp = WEBP_SOURCE.exec(block);
    if (!webp) return block;
    return block.replace(IMG_SRC, (_full, pre: string, post: string) => pre + webp[1] + post);
  });
}

function referenced(doc: string): Set<string> {
  const swapped = pictureSources(doc).replace(LAZY_IMG, "");
  const urls = new Set<string>();
  for (const pattern of REFERENCED_PATTERNS) {
    for (const m of swapped.matchAll(pattern)) {
      const url = m[1] ?? "";
      if (url.startsWith("/")) urls.add(url.split("?")[0] ?? "");
    }
  }
  return urls;
}

async function sizeOf(renderedDir: string, url: string, ignorePattern?: RegExp): Promise<number> {
  if (ignorePattern && ignorePattern.test(url)) return 0;
  const local = path.join(renderedDir, url.replace(/^\//, ""));
  const st = await fs.stat(local).catch(() => null);
  return st?.isFile() ? st.size : 0;
}

export async function run(renderedDir: string, options: WeightOptions = {}): Promise<CheckResult> {
  const budget = options.budgetBytes ?? BUDGET_DEFAULT;
  const jsBudget = options.jsBudgetBytes ?? JS_BUDGET_DEFAULT;
  const findings: Finding[] = [];
  const files = await findHtmlFiles(renderedDir);

  for (const file of files) {
    const doc = await fs.readFile(file, "utf-8");
    const htmlStat = await fs.stat(file);
    const url = urlFor(renderedDir, file);
    const assets = referenced(doc);

    let assetBytes = 0;
    let jsBytes = 0;
    for (const assetUrl of assets) {
      const size = await sizeOf(renderedDir, assetUrl, options.ignorePattern);
      assetBytes += size;
      if (assetUrl.endsWith(".js")) jsBytes += size;
    }

    const total = htmlStat.size + assetBytes;
    if (total > budget) {
      findings.push({
        path: url,
        kind: "over_weight_budget",
        message: `${(total / 1024).toFixed(1)} KB over the ${(budget / 1024).toFixed(0)} KB first-visit budget`,
        severity: "error",
      });
    }
    if (jsBytes > jsBudget) {
      findings.push({
        path: url,
        kind: "over_js_budget",
        message: `${(jsBytes / 1024).toFixed(1)} KB of script over the ${(jsBudget / 1024).toFixed(0)} KB JS budget`,
        severity: "error",
      });
    }
  }

  const ok = findings.length === 0;
  return { ok, findings, summary: { pages: files.length } };
}
