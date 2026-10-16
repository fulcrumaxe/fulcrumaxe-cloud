import { TOKEN_GA_BLOCKERS } from "./ga-blockers.js";

/**
 * Whether API tokens can be minted right now. The one test behind both the mint route (`assertTokensAvailable`) and the sentence the
 * public reference opens with: outside production tokens are always available; in production they need `FX_API_TOKENS_ENABLED` to be
 * exactly "1" and no open GA blocker.
 */
export function tokensAvailable(blockers: readonly string[] = TOKEN_GA_BLOCKERS): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.FX_API_TOKENS_ENABLED === "1" && blockers.length === 0;
}
