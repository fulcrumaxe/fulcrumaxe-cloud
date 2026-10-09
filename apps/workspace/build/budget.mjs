// apps/workspace/build/budget.mjs
//
// D#37 WS-D3 (Correction C26): the ONE definition of the boot budget. The
// build-time assertion (test/profile.test.mjs) and the live one
// (e2e/boot-budget.spec.ts) both import BOOT_BUDGET from here, so the number
// cannot drift between them. Raising maxStaticRequests is a PM correction with
// new numbers, never an edit inside an app PR.
//
// The timing budgets (1.5 s desktop cold sign-in, Lighthouse mobile) and the
// one-request warm reload are not request counts and stay in their specs.

export const BOOT_BUDGET = Object.freeze({
  // Static requests at boot: index.html plus every file it references or
  // statically imports.
  maxStaticRequests: 130,
  // Total brotli (q11) bytes over the same set.
  // Raised from 250 KB to 320 KB by owner ruling 2026-09-30 (PM correction,
  // D#37 C26): main sat at 249,159 of 256,000 and Launch needs ~45 KB more.
  // Raised again from 320 KB to 448 KB by owner ruling 2026-10-09 (PM
  // correction, D#37 C46): main sat at 324,530 of 327,680 and the remaining
  // Launch UI needs about 55-100 KB more. Lowered again after WS-D4 (comment
  // stripping) lands.
  maxBrotliBytes: 448 * 1024,
  // Boot files a single first-party app may ship under apps/<id>/.
  // Raised from 4 to 5 by owner ruling 2026-09-30 (D#37 C40, WS-F15b: the
  // Developer app's API reference tab).
  maxFilesPerApp: 5,
  // Boot files the shared apps/_lib/ directory may hold in total.
  maxSharedLibFiles: 4,
});

/**
 * Per-app ceiling (C26 rules 1). `bootFiles` are dist-space paths
 * ("apps/<id>/x.js"); `firstPartyAppIds` are the first-party app ids the
 * profile lists. Returns one human-readable message per breach; empty means
 * the ceiling holds.
 */
export function perAppCeilingViolations(bootFiles, firstPartyAppIds, budget = BOOT_BUDGET) {
  const violations = [];
  for (const id of firstPartyAppIds) {
    const n = bootFiles.filter((f) => f.startsWith(`apps/${id}/`)).length;
    if (n > budget.maxFilesPerApp) {
      violations.push(`apps/${id}/ has ${n} boot files, over the per-app ceiling of ${budget.maxFilesPerApp}`);
    }
  }
  const lib = bootFiles.filter((f) => f.startsWith("apps/_lib/")).length;
  if (lib > budget.maxSharedLibFiles) {
    violations.push(`apps/_lib/ has ${lib} boot files, over the shared-library ceiling of ${budget.maxSharedLibFiles}`);
  }
  return violations;
}
