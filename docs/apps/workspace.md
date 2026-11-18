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
- `apps/workspace/apps/team/`
- `apps/workspace/shell/core/window-manager.js`
- `apps/workspace/apps/needs-you/needs-you-model.js`
- `apps/workspace/e2e/engine-watch-journeys.spec.ts`
- `apps/workspace/e2e/journey-engine-operate.spec.ts`
- `apps/workspace/playwright.journeys.config.ts`
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
`app_modules` lists 16 apps: the imported `themes` and `heritage` (the
Cupertino+/Fluent+ adapter set, renamed Orchard/Crystal — `#172`, `#176`), and
fourteen first-party apps (below). `activation` was dropped
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
- `needs-you`: the list of setup requests people must act on, plus decision asks, stalled items and pull requests waiting for a merge. It also lists the engine's open asks (read through `/api/v1/engine/repos/{id}/asks`, refreshed on the `engine.changed` live event, #1006) and can answer one: an `answer_ask` command goes through the engine command channel, and a decision the engine asked about is approved or declined through `/api/v1/engine/decisions/{id}/answer` (#1013).
- `team`: the engine team of a repository, watched from the workspace (`apps/workspace/apps/team/`, #999). It has a repository picker, a settings sheet (the watch and operate switches, and an owner-only delete of all engine data) and six panels, each redrawn only when its own data changes: Agents, Merge lane, Plan, Stats, Cost and Log (#1005). An owner or admin can also send the engine a command (start the day, pause or resume the loop, request an agent, stop an agent, set a dial), set the three engine decision dials, and halt or clear a halt (#1007, #1012, #1019). While a repo is halted the panel says "Halted by <name> at <time>" (the day is added when it was not today), using the display name of the member who set it; when the cloud cannot name them it says only "Halted at <time>" (`apps/workspace/apps/team/team-operate.js`, #1046). Every control is locked, with a sentence saying why, while operate is off, watch is off or the repo is halted; a command reads "Applied" only after the runner reports back. The Log holds at most 400 rows (`LOG_WINDOW` in `apps/workspace/apps/team/team-model.js`). When it is redrawn, rows that did not change stay in place, new lines are added 40 at a time with a turn given back to the page between groups, and the row the person was reading is put back where it was, so "Load older" never blocks the page (`apps/workspace/apps/team/team-app.js`, #1038). Each drawn row keeps the text of its line as a plain property, and the redraw finds the matching old row from one lookup table built per pass, because a weak map keyed by the 400 rows made every full garbage collection slow, which was most of the longest task on a slow machine. The list marks itself `data-preview-keep="30"`, so the copy the window manager draws for a dock hover preview or an Alt+Tab thumbnail keeps only its first 30 rows (`apps/workspace/apps/team/team-app.js`, `apps/workspace/shell/core/window-manager.js`, #1043). Every sentence is picked from a closed code the cloud sends, never from server text; the halter's name is the one piece of cloud text shown, drawn in its own isolated run. The app has no refresh timer. A visible tab re-reads on `engine.changed`, only the parts the notice names in `data.panels` (`agents, lanes, gates, asks, log, plan, stats, usage, status`; `status` is the repo list, `asks` has no panel here), each part at most once in 10 s, with the parts named inside one window read together; only a read the app makes itself (a notice, the safety read, a retry, the catch-up on show) starts a window, while a read the person causes (opening the app, a save, Newest, Load older) is never held and does not make the next notice wait; a missing, empty or unknown `panels` re-reads everything. A 120 s safety read of everything runs while the tab is visible, a hidden tab ignores notices and reads nothing, and one catch-up read follows when it is shown. Commands and dials are read only for a member who can edit: on a full read, and, while a command is waiting for the machine (pending or delivered), in every notice-driven read and alone every 10 s, because the runner's report on a command raises no notice; those reads stop once nothing waits. A resync (the server says events were missed, or the stream came back) always reads everything, a part whose read failed is tried once more after 10 s, and the 120 s safety read is one timer set 120 s after each full read, whatever caused it, so a visible tab never goes longer than that without one. The data age of a repo follows the last-heard time of the status read, so it goes stale with the clock between reads, after 450 s: 1.5 times the 300 s an idle bridge may go between its status reports (`HEARTBEAT_MS` in `packages/fx-runner/src/engineBridge/loop.ts`) (`createCoalescer` and `noticeNames` in `apps/workspace/apps/team/team-model.js`; tests in `apps/workspace/test/team-push.test.mjs` and the push block of `apps/workspace/e2e/team.spec.ts`).
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

The build also strips comments from the shipped JS and CSS (`apps/workspace/build/strip-comments.mjs`, #118); source files on disk keep theirs, and `node build/build.mjs --keep-comments` turns it off. `apps/workspace/build/budget.mjs` holds the boot budget (a cap on static requests, 135 since #1020, and on total brotli bytes at boot) that a unit test and a Playwright spec both import. The static-request cap counts anything the shell fetches by itself at boot as well as the files the build can see (`apps/workspace/build/budget.mjs`), and the cold-start request count test in `apps/workspace/e2e/boot-budget.spec.ts` counts it live in `pnpm --filter workspace e2e` (the rest of that file is opt-in and skipped unless `BOOT_BUDGET_BASE_URL` is set) (#955). To stay under it, the build embeds the profile's default theme JSON into the shipped `apps/workspace/shell/core/theme-manager.js` (`substituteDefaultThemeData` in `apps/workspace/build/profile.mjs`, called from `apps/workspace/build/build.mjs`), and that file now fetches only the theme in use, not all of them, at boot.

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

Two journey files drive the Team app by real clicks, with a dry run against the fixture server by default and a live mode on a deployed staging host: `apps/workspace/e2e/engine-watch-journeys.spec.ts` (watching an engine team, #1014, with its steps in `apps/workspace/e2e/journeys/engine-watch.md`) and `apps/workspace/e2e/journey-engine-operate.spec.ts` (the operate controls, #1015, run live through `apps/workspace/playwright.journeys.config.ts`). A live run refuses to start unless the origin is named twice and is a staging host and a saved sign-in file exists; the operate run's steps that nothing takes back (a halt, a stop, operate off) also need the repository's name confirmed. The saved sign-in holds a real session, so keep it outside the repository: `.gitignore` ignores `*.storage-state.json` and `storage-state*.json` as a second line of defence. The watch journeys' reload waits 200 ms after the desktop is up, so the shell's restore of the saved windows has run before the journey opens the Team app and cannot hide it (`apps/workspace/e2e/engine-watch-journeys.spec.ts`, #1039). The restore itself no longer takes a window back from a person who got there first: `open()` and `focus()` in `apps/workspace/shell/core/window-manager.js` note the window a person opens or focuses while the saved layout is still waiting (only a trusted event counts, not boot code or a script), and when the late restore has put the other saved windows back it gives focus, and on a phone the one visible slot, back to that window (`apps/workspace/e2e/shell-restore-keeps-user-window.spec.ts`, #1052).

## Known gaps

None found in this app's own scope at this HEAD.
