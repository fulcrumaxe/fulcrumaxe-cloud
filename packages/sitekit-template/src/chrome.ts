import { ALLOWED_UI_CHROME, DEFAULT_PRODUCT_KIND, PRODUCT_KINDS, type ChromeKey, type ProductKindType } from "@fx/sitekit-claims";

/**
 * English copy for every fixed UI-chrome key (D#2606 K03).
 *
 * K01 validates that a section's chrome-* props hold only one of
 * ALLOWED_UI_CHROME's keys — never a literal label, so no product fact can
 * enter a page through a chrome prop. This module is the one place that
 * maps each key to real copy. It is deliberately the *only* place in this
 * package allowed to contain a bare English sentence: everything else must
 * come from a claim (see claims.ts) or from here.
 *
 * K03 ships English only. A later milestone (see D#2606 K02's
 * check-i18n-catalogue/check-i18n-chrome) adds a catalogue per locale; this
 * dictionary's shape (Record<ChromeKey, string>) is what that catalogue
 * will need to match, one file per locale.
 */
export const CHROME_EN: Record<ChromeKey, string> = {
  "section.hero.title": "Overview",
  "section.hero.subtitle": "Verified, and kept in sync with the repo.",
  "section.hero.cta": "Get started",
  "section.features.title": "Features",
  "section.roadmap.title": "Roadmap",
  "section.changelog.title": "Changelog",
  "section.docs.title": "Docs",
  "section.pricing.title": "Pricing",
  "section.legal.title": "Legal",
  "section.faq.title": "FAQ",
  "footer.credit": "Built with fulcrumaxe site kit",
  // The open_source footer carries no licence line or badge; an empty value
  // means "not rendered" (page.ts), which keeps that kind's output exactly as
  // it was before productKind existed.
  "footer.licence": "",
  "footer.badge": "",
};

/**
 * Chrome copy for a `code_visible_paid` site (D#3 K-KIND, OQ4 default
 * wording). The source is public to read but not free to use, so it must never
 * say or imply "open source"; a banned-string test renders the whole site
 * and fails on any of the open-source phrases.
 */
export const CHROME_CODE_VISIBLE_PAID_EN: Record<ChromeKey, string> = {
  ...CHROME_EN,
  "section.pricing.title": "Plans",
  "section.legal.title": "Licence",
  "footer.licence": "The source code is public to read. Using it requires a paid plan.",
  "footer.badge": "Code-visible",
};

/** One chrome dictionary per product kind. */
export const CHROME_BY_KIND: Record<ProductKindType, Record<ChromeKey, string>> = {
  open_source: CHROME_EN,
  code_visible_paid: CHROME_CODE_VISIBLE_PAID_EN,
};

/** Skip-link text. Template-internal, deliberately not a ChromeKey: no section
 * prop can select it, so ALLOWED_UI_CHROME stays unchanged. */
export const SKIP_LINK_EN = "Skip to content";

// Defensive completeness check, at module load: every key ALLOWED_UI_CHROME
// declares must have English copy, and vice versa. Catches a future K01
// change (a new chrome key) that this dictionary forgot to follow.
for (const kind of PRODUCT_KINDS) {
  for (const key of ALLOWED_UI_CHROME) {
    if (!(key in CHROME_BY_KIND[kind])) {
      throw new Error(`sitekit-template: the ${kind} chrome dictionary is missing copy for chrome key "${key}"`);
    }
  }
}

export function chrome(key: ChromeKey, kind: ProductKindType = DEFAULT_PRODUCT_KIND): string {
  return CHROME_BY_KIND[kind][key];
}
