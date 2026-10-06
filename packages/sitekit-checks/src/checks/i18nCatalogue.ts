import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CheckOptions, CheckResult, Finding } from "../types.js";

/**
 * Port of os-site-v2/tools/check-i18n-catalogue.py.
 *
 * Validates translation catalogues before render: each
 * `<renderedDir>/i18n/<locale>/<page>.json` must be a fresh, structurally
 * faithful translation of `<renderedDir>/<page>.html`'s `<main>` —
 * fingerprint matches, tag skeleton matches, and every dollar amount,
 * licence identifier and generated-block marker in the English survives.
 */

export interface I18nCatalogueOptions extends CheckOptions {
  /** Locale codes to check. Default: every subdirectory of <renderedDir>/i18n. */
  locales?: string[];
  /** Page basenames (e.g. "faq.html") to check. Default: every catalogue file present for a checked locale. */
  pages?: string[];
}

interface Catalogue {
  source?: string;
  title?: string;
  description?: string;
  main?: string;
}

const TEXT_ATTRS = new Set(["alt", "title", "aria-label", "placeholder", "content"]);
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*?)?)\s*(\/?)>/g;
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
const GENERATED_COMMENT = /<!--(?!\s*(?:endpoints|provenance|facts|tally|phases)[-:]).*?-->/gs;

function mainOf(doc: string): string | null {
  const m = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(doc);
  return m ? (m[1] ?? "") : null;
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}

function skeleton(html: string): string[] {
  const out: string[] = [];
  const stripped = html.replace(GENERATED_COMMENT, "");
  for (const m of stripped.matchAll(TAG)) {
    const attrs: string[] = [];
    for (const a of (m[3] ?? "").matchAll(ATTR)) {
      const name = (a[1] ?? "").toLowerCase();
      attrs.push(TEXT_ATTRS.has(name) ? name : `${name}=${a[2] ?? ""}`);
    }
    out.push(`<${m[1]}${(m[2] ?? "").toLowerCase()} ${attrs.join(" ")}>`);
  }
  return out;
}

function mustKeep(english: string): Set<string> {
  const keep = new Set<string>();
  for (const m of english.matchAll(/\$[\d][\d,.]*/g)) keep.add(m[0]);
  for (const m of english.matchAll(/AGPL-3\.0-only/g)) keep.add(m[0]);
  for (const m of english.matchAll(/<!-- [a-z-]+:(?:start|end) -->/g)) keep.add(m[0]);
  return keep;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

async function readJson(file: string): Promise<Catalogue | { error: string }> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function listDirs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

export async function run(renderedDir: string, options: I18nCatalogueOptions = {}): Promise<CheckResult> {
  const i18nDir = path.join(renderedDir, "i18n");
  const locales = options.locales ?? (await listDirs(i18nDir));
  const findings: Finding[] = [];
  let checked = 0;

  for (const locale of locales) {
    const localeDir = path.join(i18nDir, locale);
    const pages =
      options.pages ??
      (await fs.readdir(localeDir).catch(() => [])).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

    for (const page of pages) {
      const catalogueFile = path.join(localeDir, `${page}.json`);
      const englishFile = path.join(renderedDir, page);
      const englishDoc = await fs.readFile(englishFile, "utf-8").catch(() => null);
      if (englishDoc === null) continue; // no English source to compare against
      checked += 1;

      const parsed = await readJson(catalogueFile);
      const problems: string[] = [];
      if ("error" in parsed) {
        problems.push(`unreadable JSON: ${parsed.error}`);
      } else {
        for (const key of ["source", "title", "description", "main"] as const) {
          if (!parsed[key]) problems.push(`missing ${key}`);
        }
        const english = mainOf(englishDoc) ?? "";
        if (parsed.source !== fingerprint(english)) {
          problems.push("source fingerprint does not match the current English <main>");
        }
        const main = parsed.main ?? "";
        const a = skeleton(english);
        const b = skeleton(main);
        if (a.join("\0") !== b.join("\0")) {
          let diffAt = -1;
          for (let i = 0; i < Math.min(a.length, b.length); i++) {
            if (a[i] !== b[i]) {
              diffAt = i;
              break;
            }
          }
          if (diffAt >= 0) {
            problems.push(`tag skeleton differs at tag ${diffAt}: english ${JSON.stringify((a[diffAt] ?? "").slice(0, 120))} vs translation ${JSON.stringify((b[diffAt] ?? "").slice(0, 120))}`);
          } else {
            problems.push(`tag count differs: english ${a.length} vs translation ${b.length}`);
          }
        }
        for (const token of [...mustKeep(english)].sort()) {
          const engCount = countOccurrences(english, token);
          const mainCount = countOccurrences(main, token);
          if (engCount !== mainCount) {
            problems.push(`${JSON.stringify(token)} appears ${engCount}x in English, ${mainCount}x in translation`);
          }
        }
      }

      for (const p of problems) {
        findings.push({ path: `/i18n/${locale}/${page}.json`, kind: "i18n_catalogue_mismatch", message: p, severity: "error" });
      }
    }
  }

  const ok = findings.length === 0;
  return { ok, findings, summary: { catalogues: checked } };
}
