import { promises as fs } from "node:fs";
import path from "node:path";
import type { CheckOptions, CheckResult, Finding } from "../types.js";

/**
 * Port of os-site-v2/tools/check-i18n-chrome.py.
 *
 * Every nav/footer label must have a translation in every language. The
 * original derives its "wanted" label set by regex-parsing a specific
 * `sync-nav.mjs`; a site kit has no such fixed nav script, so the wanted set
 * is supplied directly (`options.wantedLabels`) or read from
 * `<renderedDir>/i18n/chrome-labels.json` (a plain string array) when omitted.
 * The translation table itself keeps the original's shape:
 * `<renderedDir>/i18n/chrome.json` = `{ [locale]: { [label]: translation } }`.
 */

export interface I18nChromeOptions extends CheckOptions {
  wantedLabels?: string[];
}

type ChromeTable = Record<string, Record<string, string>>;

export async function run(renderedDir: string, options: I18nChromeOptions = {}): Promise<CheckResult> {
  const chromeFile = path.join(renderedDir, "i18n", "chrome.json");
  const labelsFile = path.join(renderedDir, "i18n", "chrome-labels.json");

  const table: ChromeTable = JSON.parse(await fs.readFile(chromeFile, "utf-8"));
  const wanted = new Set(
    options.wantedLabels ?? (JSON.parse(await fs.readFile(labelsFile, "utf-8").catch(() => "[]")) as string[]),
  );

  const findings: Finding[] = [];
  for (const locale of Object.keys(table).sort()) {
    const have = new Set(Object.keys(table[locale] as Record<string, string>));
    const missing = [...wanted].filter((w) => !have.has(w)).sort();
    const extra = [...have].filter((h) => !wanted.has(h)).sort();
    if (missing.length) {
      findings.push({
        path: `/i18n/chrome.json`,
        kind: "missing_chrome_translation",
        message: `${locale} has no translation for: ${missing.join(", ")}`,
        severity: "error",
      });
    }
    if (extra.length) {
      findings.push({
        path: `/i18n/chrome.json`,
        kind: "stale_chrome_translation",
        message: `${locale} translates labels that no longer exist: ${extra.join(", ")}`,
        severity: "error",
      });
    }
  }

  const ok = findings.length === 0;
  return { ok, findings, summary: { locales: Object.keys(table).length, labels: wanted.size } };
}
