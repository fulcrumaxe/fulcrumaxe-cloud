import baseCss from "./baseCss.json" with { type: "json" };

/** The full, static component/reset stylesheet (base.css), compiled into the code as baseCss.json (built by
 * scripts/generate-base-css.mjs; a test fails if it is stale) so it needs no file read at runtime. Consumers
 * concatenate `renderTokens(set) + getBaseCss()` to get one complete stylesheet — see src/index.ts's
 * `renderStylesheet`. */
export const BASE_CSS: string = baseCss;

export function getBaseCss(): string {
  return BASE_CSS;
}

export { renderTokens, TOKEN_SETS } from "./tokens.js";
