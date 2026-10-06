/**
 * D#2607 P01 only scaffolds this package (package.json/tsconfig.json/
 * vitest.config.ts) -- no feature code lands here yet. Each later P-task
 * adds its own `src/<feature>/index.ts` (host, auth-handoff, admin,
 * domains, referrals, support-access, brand, onboarding, suspension,
 * surfaces), matched by this package's package.json exports map (each
 * subpath maps to `./src/<name>/index.ts`), and none of them import from
 * this file.
 *
 * This file exists only so `tsc --noEmit` has at least one input under
 * `src/` (an empty directory makes TypeScript fail with "No inputs were
 * found", not "0 errors") -- it is not part of the package's public
 * surface and nothing should import it.
 */
export {};
