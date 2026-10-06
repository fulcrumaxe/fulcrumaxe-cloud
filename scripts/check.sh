#!/usr/bin/env bash
# Runs pass/fail checks 1 and 3 from the H01 monorepo-scaffold spec:
#   1. pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm --filter web build
#   3. pnpm test:guard (the guard's own deliberate-violation fixture)
# Exits non-zero on the first failure.
#
# Two modes, same script for CI and for a developer:
#   full      (default; nothing set) every step, exactly as before.
#   affected  FX_CHECK_AFFECTED="packages/a,apps/web" (workspace package directories, comma-separated;
#             `none` = a change that touches no package). Lint, typecheck and tests run for those
#             packages only; the web build and its trace and path checks run only when apps/web is in the
#             list, the sitekit browser tier only when packages/sitekit-checks is, the Postgres migration
#             shape test only when packages/db is. The cheap global guards always run. CI sets this from
#             scripts/ci/affected.mjs on pull requests; a push to main never sets it.
# An empty or unset FX_CHECK_AFFECTED means full: a variable that failed to populate must widen, not narrow.
#
# FX_CHECK_DRY_RUN=1 prints each step's header and the command it would run without running it (used by
# scripts/ci/ci-workflow.test.mjs to pin the step headers).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

mode=full
pkgs=()
if [ -n "${FX_CHECK_AFFECTED:-}" ]; then
  mode=affected
  if [ "$FX_CHECK_AFFECTED" != "none" ]; then
    IFS=, read -r -a pkgs <<< "$FX_CHECK_AFFECTED"
  fi
fi

# has_pkg DIR: is DIR in the affected list? (always true in full mode)
has_pkg() {
  [ "$mode" = full ] && return 0
  local p
  for p in ${pkgs[@]+"${pkgs[@]}"}; do
    [ "$p" = "$1" ] && return 0
  done
  return 1
}

# run CMD...: runs it, or only shows it under FX_CHECK_DRY_RUN.
run() {
  if [ -n "${FX_CHECK_DRY_RUN:-}" ]; then
    echo "(dry run) $*"
  else
    "$@"
  fi
}

# skipped HEADER WHY: the header of a step that this affected run does not need.
skipped() {
  echo "==> $1 -- skipped, $2"
}

if [ "$mode" = affected ]; then
  echo "check.sh: affected mode, ${#pkgs[@]} package(s): ${FX_CHECK_AFFECTED}"
fi

echo "==> pnpm install"
run pnpm install --frozen-lockfile

echo "==> declared cross-package imports"
run node --test scripts/ci/declared-imports.test.mjs

if [ "$mode" = full ]; then
  echo "==> pnpm lint"
  run pnpm lint
elif [ "${#pkgs[@]}" -gt 0 ] || [ -n "${FX_CHECK_LINT_PATHS:-}" ]; then
  # FX_CHECK_LINT_PATHS (comma-separated, set by scripts/ci/affected.mjs): paths outside every package that
  # the change touched, e.g. scripts/ci when a standalone CI test changed.
  lint_paths=(${pkgs[@]+"${pkgs[@]}"})
  if [ -n "${FX_CHECK_LINT_PATHS:-}" ]; then
    IFS=, read -r -a extra_lint <<< "$FX_CHECK_LINT_PATHS"
    lint_paths+=("${extra_lint[@]}")
  fi
  echo "==> pnpm lint (affected packages)"
  run pnpm exec eslint "${lint_paths[@]}"
else
  skipped "pnpm lint" "no affected package"
fi

if [ "$mode" = full ]; then
  echo "==> pnpm typecheck"
  run pnpm typecheck
elif [ "${#pkgs[@]}" -gt 0 ]; then
  echo "==> pnpm typecheck (affected packages)"
  filters=()
  for p in "${pkgs[@]}"; do filters+=(--filter "./$p"); done
  run pnpm "${filters[@]}" --if-present run typecheck
else
  skipped "pnpm typecheck" "no affected package"
fi

echo "==> scripts/check-globalsetup-env.sh"
run bash scripts/check-globalsetup-env.sh

if [ "$mode" = full ]; then
  echo "==> pnpm test"
  run env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN FX_FORBID_MODEL_CALLS=1 pnpm test
elif [ "${#pkgs[@]}" -gt 0 ] && [ -z "${FX_CHECK_DRY_RUN:-}" ]; then
  echo "==> pnpm test (affected projects)"
  # The vitest project names for those directories, as vitest itself reports them.
  project_names="$(node scripts/ci/vitest-projects.mjs "${pkgs[@]}")"
  project_args=()
  while IFS= read -r name; do
    [ -n "$name" ] && project_args+=(--project "$name")
  done <<< "$project_names"
  if [ "${#project_args[@]}" -gt 0 ]; then
    env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN FX_FORBID_MODEL_CALLS=1 pnpm exec vitest run "${project_args[@]}"
  else
    echo "no vitest project under the affected packages"
  fi
elif [ "${#pkgs[@]}" -gt 0 ]; then
  echo "==> pnpm test (affected projects)"
  run env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN FX_FORBID_MODEL_CALLS=1 pnpm exec vitest run --project NAMES
else
  skipped "pnpm test" "no affected package"
fi

echo "==> sitekit-checks browser tier"
if [ -n "${FX_BROWSER_TIER:-}" ] && [ "${FX_BROWSER_TIER:-}" != "skip" ]; then
  echo "FAILED browser tier: FX_BROWSER_TIER must be unset or 'skip'" >&2
  exit 1
elif [ "${FX_BROWSER_TIER:-}" = "skip" ] && [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
  echo "FAILED browser tier: FX_BROWSER_TIER=skip is not allowed on pull_request runs" >&2
  exit 1
elif ! has_pkg packages/sitekit-checks; then
  echo "SKIPPED browser tier: packages/sitekit-checks is not affected"
elif [ "${FX_BROWSER_TIER:-}" = "skip" ]; then
  echo "SKIPPED browser tier: FX_BROWSER_TIER=skip (self-hosted runner cannot start the Chromium sandbox; the tier runs on pull_request)"
elif [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  run pnpm --filter @fx/sitekit-checks test:browser
elif [ -n "${CI:-}" ]; then
  echo "FAILED browser tier: PLAYWRIGHT_BROWSERS_PATH unset under CI (run inside nix develop)" >&2
  exit 1
else
  echo "SKIPPED browser tier: PLAYWRIGHT_BROWSERS_PATH unset"
fi

if has_pkg packages/db; then
  echo "==> packages/db neon-shape migrations"
  run bash packages/db/scripts/test-neon-shape.sh
else
  skipped "packages/db neon-shape migrations" "packages/db not affected"
fi

echo "==> packages/db migration order"
run bash packages/db/scripts/check-migration-order.sh

if has_pkg apps/web; then
  echo "==> pnpm --filter web build"
  run pnpm --filter web build

  echo "==> apps/web next-server trace check"
  run node apps/web/scripts/check-next-trace.mjs

  echo "==> apps/web baked build-path check"
  run node apps/web/scripts/check-baked-paths.mjs
else
  skipped "pnpm --filter web build" "apps/web not affected"
  skipped "apps/web next-server trace check" "apps/web not affected"
  skipped "apps/web baked build-path check" "apps/web not affected"
fi

echo "==> pnpm test:guard"
run pnpm test:guard

echo "check.sh: all checks passed"
