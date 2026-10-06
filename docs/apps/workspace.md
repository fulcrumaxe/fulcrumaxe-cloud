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
`app_modules` is `["themes", "heritage"]` — `activation` was dropped
(`#162`, D#37 WS-L1 owner ruling: a subscription unlocks the workspace
instead of a licence-activation flow; see [`../security.md`](../security.md)'s
"Workspace subscription gate" section) and `heritage` (the Cupertino+/Fluent+
adapter set, renamed Orchard/Crystal — `#172`, `#176`) ships instead.
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

## Tests

`apps/workspace/test/profile.test.mjs` unit-tests `loadProfile` and
`filterIndexHtml`'s line classification without running a full build.
`apps/workspace/test/checks.test.mjs`, `apps/workspace/test/import.test.mjs`,
and `apps/workspace/test/tar.test.mjs` cover the import-time checks, the
importer, and its tar handling. `apps/workspace/test/features-fail-closed.test.mjs`
covers `core/features.js`'s fail-closed behavior. Run with
`pnpm --filter workspace test` (`vitest run`, config at
`apps/workspace/vitest.config.mjs`). `apps/workspace/e2e/idle-network.spec.ts`
is a Playwright spec (`apps/workspace/playwright.config.ts`), run via
`pnpm --filter workspace e2e` (`node build/build.mjs && playwright test`). Agents running e2e locally must set
`E2E_PORT` and `E2E_FIRST_PARTY_PORT` to free ports (the 4319/4320 defaults collide with other runs).

## Known gaps

None found in this app's own scope at this HEAD.
