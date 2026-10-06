export type { CheckOptions, CheckResult, CheckRun, Finding } from "./types.js";
export type { BrowserDriver, BrowserPage, JsonValue } from "./lib/browser/driver.js";
export type { BrowserRunOptions } from "./lib/browser/run.js";

export { run as checkLinks } from "./checks/links.js";
export type { LinksOptions } from "./checks/links.js";

export { run as checkMeta } from "./checks/meta.js";
export type { MetaOptions } from "./checks/meta.js";

export { run as checkNojs } from "./checks/nojs.js";
export type { NojsOptions } from "./checks/nojs.js";

export { run as checkWeight } from "./checks/weight.js";
export type { WeightOptions } from "./checks/weight.js";

export { run as checkRedaction, GENERIC_LEAK_PATTERNS, GENERIC_LEAK_PLANTS } from "./checks/redaction.js";
export type { EvidenceCommits, RedactionOptions } from "./checks/redaction.js";

export { run as checkI18nCatalogue, fingerprint as i18nFingerprint } from "./checks/i18nCatalogue.js";
export type { I18nCatalogueOptions } from "./checks/i18nCatalogue.js";

export { run as checkI18nChrome } from "./checks/i18nChrome.js";
export type { I18nChromeOptions } from "./checks/i18nChrome.js";

export { run as checkA11y } from "./extra/a11y.js";
export type { A11yOptions } from "./extra/a11y.js";

export { run as checkRender } from "./extra/render.js";
export type { RenderOptions } from "./extra/render.js";

export { run as checkA11yStructure } from "./extra/a11y-structure.js";
export type { A11yStructureOptions } from "./extra/a11y-structure.js";

export { run as checkMotion } from "./extra/motion.js";
export type { MotionOptions } from "./extra/motion.js";

export { run as checkDegrade } from "./extra/degrade.js";
export type { DegradeOptions } from "./extra/degrade.js";

export type { BrowserPagesOptions } from "./extra/browser-pages.js";

export { run as checkHeaders } from "./extra/headers.js";
export type { HeadersOptions } from "./extra/headers.js";

export { run as checkFreshness } from "./extra/freshness.js";
export type { FreshnessOptions } from "./extra/freshness.js";

import { run as checkA11y } from "./extra/a11y.js";
import { run as checkA11yStructure } from "./extra/a11y-structure.js";
import { run as checkRender } from "./extra/render.js";
import { run as checkMotion } from "./extra/motion.js";
import { run as checkDegrade } from "./extra/degrade.js";
import { run as checkHeaders } from "./extra/headers.js";
import { run as checkFreshness } from "./extra/freshness.js";
import { run as checkLinks } from "./checks/links.js";
import { run as checkMeta } from "./checks/meta.js";
import { run as checkNojs } from "./checks/nojs.js";
import { run as checkWeight } from "./checks/weight.js";
import { run as checkRedaction } from "./checks/redaction.js";
import { run as checkI18nCatalogue } from "./checks/i18nCatalogue.js";
import { run as checkI18nChrome } from "./checks/i18nChrome.js";
import type { CheckRun } from "./types.js";

/** Every ported mechanical check, keyed by its os-site-v2 tool name. */
export const CHECKS: Record<string, CheckRun> = {
  "check-links": checkLinks,
  "check-meta": checkMeta,
  "check-nojs": checkNojs,
  "check-weight": checkWeight,
  "check-redaction": checkRedaction,
  "check-i18n-catalogue": checkI18nCatalogue,
  "check-i18n-chrome": checkI18nChrome,
  "check-a11y": checkA11y,
  "check-render": checkRender,
  "check-a11y-structure": checkA11yStructure,
  "check-motion": checkMotion,
  "check-degrade": checkDegrade,
  "check-headers": checkHeaders,
  "check-freshness": checkFreshness,
};
