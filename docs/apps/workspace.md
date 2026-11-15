# apps/workspace

`fulcrumaxe workspace`: an imported, pinned copy of a separate frontend
project's desktop-shell UI, filtered down to a single deployment profile
(cloud) and built to a static bundle this repo serves.

Sources:
- `apps/workspace/BUILD-INFO.json`
- `apps/workspace/import/IMPORT.md`
- `apps/workspace/import/allowlist.txt`
- `apps/workspace/build/build.mjs`
- `apps/workspace/build/profile.mjs`
- `apps/workspace/build/first-party.mjs`
- `apps/workspace/build/strip-comments.mjs`
- `apps/workspace/build/budget.mjs`
- `apps/workspace/e2e/boot-budget.spec.ts`
- `apps/workspace/shell/core/theme-manager.js`
- `apps/workspace/apps/README.md`
- `apps/workspace/profiles/cloud.json`
- `apps/workspace/shell/core/features.js`
- `apps/workspace/package.json`
- `.gitignore`

## What it does

`apps/workspace/shell/` is the imported shell tree — the full frontend, not
yet filtered to any one deployment's feature set. `apps/workspace/import/IMPORT.md`
documents the import procedure: it runs against a separate `jpos` checkout
that this repo never modifies and never opens a PR against, restricted to one
designated operator role rather than every contributor; the import narrows a
`git archive` to one anchor path, then an allowlist
(`apps/workspace/import/allowlist.txt`) controls what actually gets extracted
from that archive into `apps/workspace/shell/`.

## Its pin

`apps/workspace/BUILD-INFO.json` records exactly which `jpos` commit was
imported (`jpos_sha`), the origin repo it came from (`origin_url`), who
verified that commit was really on `jpos`'s main history and when
(`ancestor_of_main_checked_by`, `imported_at`), the tar's checksum
(`tar_sha256`), and a per-file sha256 for every file the import wrote
(`files`), plus an `added` list (`core/features.js`) for a file this repo
added on top of the imported tree rather than pulling from `jpos`.

## The profile-filtered build

`apps/workspace/build/` is listed under this repo's root `.gitignore`'s
general `build/` exclusion, but `.gitignore` explicitly un-ignores it
(`!apps/workspace/build/`, `!apps/workspace/build/*.mjs`) with a comment
stating it is a source directory — `build.mjs` and `profile.mjs`, the build
tool itself — not build output, despite the directory name.

`apps/workspace/build/profile.mjs`'s `loadProfile` reads a profile JSON file
requiring `app_modules` (an array of `data-app` ids that ship),
`drop_core` (exact `src`/`href` values to drop unconditionally, independent of
`data-app`), and a `features` object. `filterIndexHtml` classifies every
`<script>`/`<link>` line of `apps/workspace/shell/index.html`: a line in
`drop_core` is dropped; a line carrying a `data-app="X"` attribute is kept only
if `X` is in `app_modules`; a line with no `data-app` but an `apps/<id>/` path
prefix is treated the same way; anything else (a core tag not in `drop_core`)
is kept.

`apps/workspace/build/build.mjs` (`pnpm --filter workspace build`, invoked as
`node build/build.mjs`) runs the import-time checks against `shell/` again,
filters `index.html` per the chosen profile (default
`apps/workspace/profiles/cloud.json`), computes every file actually reachable
from the filtered `index.html` (kept tags, their static import graph, plus the
runtime-fetched `core/themes/*.json` and `fonts/**` directories), fails the
build if any kept reference resolves to a file that does not exist, copies the
reachable set into `dist/`, and re-runs the ship-time checks against `dist/`.

## The cloud profile

`apps/workspace/profiles/cloud.json` is the one profile shipped at this HEAD:
`app_modules` lists 15 apps: the imported `themes` and `heritage` (the
Cupertino+/Fluent+ adapter set, renamed Orchard/Crystal — `#172`, `#176`), and
thirteen first-party apps (below). `activation` was dropped
(`#162`, D#37 WS-L1 owner ruling: a subscription unlocks the workspace
instead of a licence-activation flow; see [`../security.md`](../security.md)'s
"Workspace subscription gate" section). `dock_order` in the same file sets the
dock's order, with `onboarding` first.
`excluded_themes` (`#163`) lists `windows-aero` and `ubuntu-gnome`, dropped
per an owner ruling against themes that too closely mimic a real OS/vendor's
branding; `default_theme` (`#172`) is `classic-crt`, read by
`apps/workspace/shell/core/theme-manager.js` at boot instead of a hardcoded
default, and a build-time check refuses to ship any theme whose id or name
matches a real OS/vendor's branding. `drop_core` lists eight files,
including `core/crdt-sync-client.js`, `core/crdt-sync.css`,
`core/storage-key-migration.js`, `vendor/xterm/xterm.css`, `editor.css`, and
`editor.js`; and every entry in `features` (`presence`, `liveEntitlements`,
`crdt`, `messages`, `updates`) is `false`. `apps/workspace/shell/core/features.js`
fetches this flag set at runtime from `apps/web`'s `/api/mode` endpoint (see
[apps/web](web.md)) rather than reading the profile file directly — the
profile is a build-time declaration of what the server is expected to answer,
not something shipped to the browser — and fails closed (every gated flag
reads `false`) if that fetch fails.

## First-party apps

`apps/workspace/apps/<id>/` holds the first-party apps, each a `manifest.json` (`id`, `entry`, `styles`) plus plain JS, TS or TSX and CSS; `apps/workspace/apps/README.md` has the rules, and `apps/workspace/build/first-party.mjs` loads them. They are not a framework: an app registers itself through the shell's `FULC` global, builds its DOM with the shared `h()` helper so server text stays text, and TS/TSX is compiled per file with no bundler. An app ships only if its id is in the profile's `app_modules`, and a literal import that is not relative, or that names a dropped module, fails the build. A directory starting with `_` (`apps/workspace/apps/_lib`) is a shared library with no manifest. At HEAD the apps are:

- `onboarding`: the six setup steps, with progress read from the server.
- `pipeline`: the board of work items by stage, with the approve, cancel, retry and verify-again controls the server offers.
- `needs-you`: the list of setup requests people must act on.
- `runs`: the account's runs and one run's events.
- `memory`: the memory review queue and all memory by scope.
- `repos`: installed repositories and their auto-merge settings.
- `runners`: the runner fleet page and the "Add a runner" sheet.
- `roles`: per-repository role modes, models and expected spend.
- `site-review`: a site version's review report, with attest and approve for owners and admins.
- `model-key`: the account's model connection.
- `vercel`: the Vercel connection screen.
- `budget-billing`: the plan, the three monthly budgets and billing standing.
- `developer`: API tokens, webhooks and the API reference.

The build also strips comments from the shipped JS and CSS (`apps/workspace/build/strip-comments.mjs`, #118); source files on disk keep theirs, and `node build/build.mjs --keep-comments` turns it off. `apps/workspace/build/budget.mjs` holds the boot budget (a cap on static requests and on total brotli bytes at boot) that a unit test and a Playwright spec both import. The static-request cap counts anything the shell fetches by itself at boot as well as the files the build can see (`apps/workspace/build/budget.mjs`), and the cold-start request count test in `apps/workspace/e2e/boot-budget.spec.ts` counts it live in `pnpm --filter workspace e2e` (the rest of that file is opt-in and skipped unless `BOOT_BUDGET_BASE_URL` is set) (#955). To stay under it, the build embeds the profile's default theme JSON into the shipped `apps/workspace/shell/core/theme-manager.js` (`substituteDefaultThemeData` in `apps/workspace/build/profile.mjs`, called from `apps/workspace/build/build.mjs`), and that file now fetches only the theme in use, not all of them, at boot.

## Tests

`apps/workspace/test/profile.test.mjs` unit-tests `loadProfile` and
`filterIndexHtml`'s line classification without running a full build.
`apps/workspace/test/checks.test.mjs`, `apps/workspace/test/import.test.mjs`,
and `apps/workspace/test/tar.test.mjs` cover the import-time checks, the
importer, and its tar handling. `apps/workspace/test/features-fail-closed.test.mjs`
covers `core/features.js`'s fail-closed behavior. Most first-party apps have a unit test under `apps/workspace/test/` (for example `pipeline-*.test.mjs`, `memory-app.test.mjs`, `needs-you.test.mjs`) and a Playwright spec under `apps/workspace/e2e/`; `developer`, `model-key` and `vercel` have Playwright specs only. Run with
`pnpm --filter workspace test` (`vitest run`, config at
`apps/workspace/vitest.config.mjs`). `apps/workspace/e2e/idle-network.spec.ts`
is a Playwright spec (`apps/workspace/playwright.config.ts`), run via
`pnpm --filter workspace e2e` (`node build/build.mjs && playwright test`). Agents running e2e locally must set
`E2E_PORT` and `E2E_FIRST_PARTY_PORT` to free ports (the 4319/4320 defaults collide with other runs).

## Known gaps

None found in this app's own scope at this HEAD.
