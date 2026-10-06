import { z } from "zod";

/**
 * H24 token-set schema (D#2 spec amendment, pass/fail item 6).
 *
 * A token set is DATA: every colour, spacing step, type-scale step, radius
 * and container width a surface renders with comes from one of these, never
 * from a literal in a component. Two complete sets ship in
 * `packages/design/tokens/` (`terminal.json`, `dark.json`), lifted from the
 * two complete value sets `formal-support/assets/css/style.css` declares
 * for its `--bg`/`--fg`/`--accent` family of custom properties.
 *
 * White-labelling (D#4 P03) works by handing `renderTokens` a *different*
 * TokenSet — no second theming mechanism, no markup fork. `PartnerOverride`
 * below is the one sanctioned way a partner's colours reach the page.
 */

export const ColorTokens = z.object({
  bg: z.string(),
  bgRaised: z.string(),
  bgCard: z.string(),
  bgFooter: z.string(),
  fg: z.string(),
  fgDim: z.string(),
  accent: z.string(),
  accentFaint: z.string(),
  accentDim: z.string(),
  accentWash: z.string(),
  muted: z.string(),
  border: z.string(),
  danger: z.string(),
  dangerDim: z.string(),
  warn: z.string(),
  warnDim: z.string(),
});
export type ColorTokens = z.infer<typeof ColorTokens>;

/**
 * Colour keys that stay constant across every theme, by design (D#2 H24
 * criterion 2 ruling, D#2 comment 18505329):
 * `danger`/`dangerDim`/`warn`/`warnDim` keep meaning "error"/"caution"
 * regardless of accent colour, so set A and set B deliberately agree on
 * them. This is the one and only place that agreement is declared — the
 * token-swap test (`token-swap.test.ts`) asserts equality for exactly this
 * list and asserts every *other* colour and spacing key differs between
 * sets, and `PartnerOverride` below omits exactly this list, so a partner
 * can never bend "error" or "caution" away from its fixed meaning.
 */
export const SEMANTIC_CONSTANT_KEYS = ["danger", "dangerDim", "warn", "warnDim"] as const;
export type SemanticConstantKey = (typeof SEMANTIC_CONSTANT_KEYS)[number];

export const SpacingTokens = z.object({
  "3xs": z.string(),
  "2xs": z.string(),
  xs: z.string(),
  sm: z.string(),
  md: z.string(),
  lg: z.string(),
  xl: z.string(),
});
export type SpacingTokens = z.infer<typeof SpacingTokens>;

export const TypeTokens = z.object({
  fontFamily: z.string(),
  size2xs: z.string(),
  sizeXs: z.string(),
  sizeSm: z.string(),
  sizeMd: z.string(),
  sizeLg: z.string(),
  sizeXl: z.string(),
  trackingNormal: z.string(),
  trackingWide: z.string(),
  trackingWider: z.string(),
});
export type TypeTokens = z.infer<typeof TypeTokens>;

export const ContainerTokens = z.object({
  max: z.string(),
  /** Minimum track width for an `auto-fit` card/feature grid — a container
   * width in the same sense `max` is, just for one grid item rather than
   * the page. Keeping it here (not a one-off literal in base.css) is what
   * lets the hardcoded-value guard treat card-grid layout the same as every
   * other structural measurement. */
  cardMin: z.string(),
});
export type ContainerTokens = z.infer<typeof ContainerTokens>;

export const TokenSet = z.object({
  id: z.string().min(1),
  colors: ColorTokens,
  spacing: SpacingTokens,
  type: TypeTokens,
  radius: z.string(),
  container: ContainerTokens,
});
export type TokenSet = z.infer<typeof TokenSet>;

/**
 * The partner-override schema (D#2 spec amendment, pass/fail item 6).
 *
 * Overridable — a partner's brand colours, and nothing else:
 *   `colors.*`, EXCLUDING `SEMANTIC_CONSTANT_KEYS` (twelve of the sixteen
 *   keys above).
 *
 * Structural and fixed — never partner-overridable, because they are what
 * keeps a ported component's proportions (and the hardcoded-value guard's
 * assumptions) intact regardless of branding, or (for the semantic keys)
 * because "error"/"caution" must keep meaning "error"/"caution" regardless
 * of a partner's brand colours:
 *   `spacing.*`, `type.*` (including `fontFamily`), `radius`, `container.max`,
 *   and `colors.danger` / `colors.dangerDim` / `colors.warn` / `colors.warnDim`
 *   (`SEMANTIC_CONSTANT_KEYS` — D#2 H24 criterion 2/6 ruling).
 *
 * A partner overriding a color that doesn't exist, a semantic-constant
 * colour, or trying to reach a structural key, fails `PartnerOverride.parse`
 * — there is no back door from override data into the fixed scale. P03 (the
 * white-label consumer) supplies values against exactly this shape; it must
 * not invent a second theming mechanism alongside it.
 */
export const PartnerOverride = ColorTokens.omit({
  // Kept as a literal mask (zod's `.omit()` needs a statically-typed object,
  // not a value built from SEMANTIC_CONSTANT_KEYS at runtime) — must stay in
  // sync with SEMANTIC_CONSTANT_KEYS above; both are exactly four entries.
  danger: true,
  dangerDim: true,
  warn: true,
  warnDim: true,
})
  .partial()
  .strict();
export type PartnerOverride = z.infer<typeof PartnerOverride>;

/**
 * Applies a validated partner override on top of a base TokenSet, replacing
 * only the colour keys the partner supplied. `set.id` is not overridden by
 * `override` (it has no `id` field to do so); callers that want a distinct
 * id for the branded result should set `.id` on the returned object
 * themselves — kept explicit rather than folded into this function so a
 * partner id can never silently collide with a shipped set's id.
 */
export function applyPartnerOverride(set: TokenSet, override: PartnerOverride): TokenSet {
  PartnerOverride.parse(override);
  return {
    ...set,
    colors: { ...set.colors, ...override },
  };
}
