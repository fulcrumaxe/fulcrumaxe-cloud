/**
 * H24 shared design layer — package entry point.
 *
 * One package, three consumers (marketing site H25, apps/web, and
 * packages/sitekit-template via K03): this is the one source of style. See
 * D#2's spec amendment comment for the full task and its six pass/fail
 * criteria.
 */
export { TOKEN_SETS, renderTokens } from "./css/tokens.js";
export { BASE_CSS, getBaseCss } from "./css/index.js";
export {
  TokenSet,
  ColorTokens,
  SpacingTokens,
  TypeTokens,
  ContainerTokens,
  PartnerOverride,
  applyPartnerOverride,
} from "./schema/tokenSet.js";
export type {
  TokenSet as TokenSetType,
  ColorTokens as ColorTokensType,
  PartnerOverride as PartnerOverrideType,
} from "./schema/tokenSet.js";
export * as components from "./components/index.js";
export * as html from "./html/index.js";
// React wrappers are deliberately NOT re-exported here: this barrel must
// stay importable by consumers (packages/sitekit-template) whose tsconfig
// has no `jsx` compiler option set, and TypeScript type-checks a workspace
// dependency's real .tsx source (there is no separate .d.ts build step in
// this repo) the moment anything reaches it. React consumers (apps/web)
// import "@fx/design/react" instead — see package.json's "exports" map.

import type { TokenSet } from "./schema/tokenSet.js";
import { renderTokens } from "./css/tokens.js";
import { getBaseCss } from "./css/index.js";

/** One complete stylesheet for a given token set: the emitted custom
 * properties, then the static component rules that consume them. This is
 * what apps/web/app/layout.tsx and packages/sitekit-template/src/render.ts
 * both use to get their `assets/site.css` / inline stylesheet — the one
 * place the two halves (tokens.ts + base.css) are joined. */
export function renderStylesheet(set: TokenSet): string {
  return `${renderTokens(set)}\n${getBaseCss()}`;
}
