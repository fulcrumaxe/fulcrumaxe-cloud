import { ALLOWED_UI_CHROME, type ChromeKey } from "@fx/sitekit-claims";

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
};

/** Skip-link text. Template-internal, deliberately not a ChromeKey: no section
 * prop can select it, so ALLOWED_UI_CHROME stays unchanged. */
export const SKIP_LINK_EN = "Skip to content";

// Defensive completeness check, at module load: every key ALLOWED_UI_CHROME
// declares must have English copy, and vice versa. Catches a future K01
// change (a new chrome key) that this dictionary forgot to follow.
for (const key of ALLOWED_UI_CHROME) {
  if (!(key in CHROME_EN)) {
    throw new Error(`sitekit-template: CHROME_EN is missing copy for chrome key "${key}"`);
  }
}

export function chrome(key: ChromeKey): string {
  return CHROME_EN[key];
}
