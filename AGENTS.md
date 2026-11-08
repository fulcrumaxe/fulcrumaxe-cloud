# Agent instructions

Before you change code here, read `docs/agents/builder-guide.md`. It covers the check, the
repository-wide guards and when each applies, migrations, Postgres tests, fakes and fixtures, UI
work, scope, the pull request, and when to stop and report.

## Rules that cause the most fix rounds

1. Run the check inside the dev shell: `nix develop`, then `bash scripts/check.sh`
   (or `FX_CHECK_AFFECTED=<dirs> bash scripts/check.sh`, listing the packages that own the guards
   your change can trip, not only the ones you edited).
2. After a route or schema change, regenerate and commit both files:
   `pnpm --filter @fx/api gen-openapi`, then `pnpm --filter @fx/api-client gen`.
3. A new `apps/web/app/api/**/route.ts` needs its line in `apps/web/app/api/ROUTES.allowlist`;
   run `pnpm exec vitest run apps/web/test/route-inventory.test.ts`.
4. A cross-package import, even in a test, must be declared in `package.json`:
   `node --test scripts/ci/declared-imports.test.mjs` and `pnpm typecheck`.
5. A new error or stop code goes in `OWN_ERROR_CODES` (`packages/telemetry/src/errorCodes.ts`) and
   every other list that names codes: `pnpm exec vitest run packages/telemetry/test/errorCodes.test.ts`.
6. Run the other guards your change trips: `packages/db/test/audit-log-guard.test.ts`,
   `packages/pipeline/test/build/mergeCallSites.test.ts`,
   `packages/pipeline/test/stackedPathsNoRepoGate.test.ts`,
   `packages/runner/test/runStatusWriter.test.ts`, `packages/core/test/unit/halt-writers.test.ts`,
   `packages/db/test/rls-inventory.test.ts` (each with `pnpm exec vitest run <path>`).
7. A new migration is numbered main's highest plus one; never edit, rename or delete an applied
   one. Run `bash packages/db/scripts/check-migration-order.sh --base origin/main`,
   `bash packages/db/scripts/test-neon-shape.sh` and `node scripts/ci/check-migration-compat.mjs`.
8. Database tests run on real Postgres with the real migrations, through
   `packages/db/test/support/ephemeral-pg.ts`, as the role the code uses: `pnpm --filter @fx/db test`.
9. Fakes refuse what the real service refuses (`packages/github/test/helpers/strictGithub.ts`);
   API response shapes come from `packages/api/fixtures/v1/`, never invented.
10. Mutation-check each new branch: break it, confirm a named test goes red, restore it, report it.
11. Test the undo path and every state; never trim tests to fit a size line.
12. UI changes run all three Playwright projects:
    `pnpm --filter workspace e2e --project=desktop` (and `phone`, `tablet`).
13. Lint what you changed with `pnpm exec eslint <files>`; a swallowing `catch` fails.
14. Stay inside the task's file list. If a derived file is needed that is not on it, stop and
    report which file, which guard needs it, and why. Never redefine an ambiguous criterion: stop
    and report it.
15. Report each suite you ran with its pass and fail counts and its exit code, and what you did not run.

## Pull request text

- Write the title, body and commit messages in your own words: what changed, why, and how it was tested.
- Start the body with the reference your task gives you. Never link a private repository, and never
  quote private planning text.
- No plan prices or limits, hostnames, secrets or customer names anywhere in the change.
