/**
 * D#31 Correction C13b: production minting stays refused while any listed
 * task id is open (independent of `FX_API_TOKENS_ENABLED`), see
 * `assertTokensAvailable` in `../routes/tokens.ts`.
 *
 * API-3d removal rule (C13b/C14c: "the PR that lands last of the three
 * empties the list and also asserts case (c) without injection
 * [production plus flag gives 201]"): "API-3f" (#155) and "API-3e"
 * (#158) have both already merged and removed their own ids. This PR
 * (API-3d -- token, tenant and per-IP failed-auth rate limits) is last,
 * so it removes "API-3d" AND empties the list, and its own
 * tokens.test.ts adds the no-injection 201 case C14c asks for alongside
 * the updated pin.
 */
export const TOKEN_GA_BLOCKERS: readonly string[] = [];
