# Engine-watch journeys: runbook

Eleven journeys (W1 to W11) for the Team app and the engine rows in Needs you. Each acts through the app's own buttons, reads the result back after a reload, puts things back, and records one number (`LEDGER` lines in the output, and test annotations). Steps: `../engine-watch-journeys.spec.ts`. The stand-in for the cloud and the operator: `engine-watch.ts`.

## Dry run (any machine, no account, no network)

```
pnpm --filter workspace exec node build/build.mjs
pnpm --filter workspace exec playwright test e2e/engine-watch-journeys.spec.ts
```

The fixture server serves the built dist and a stateful stand-in answers the engine routes, so a reload reads what the stand-in kept. Run it on desktop, phone and tablet (`--project`).

## Live run (staging, after the engine-bridge changes are deployed)

Every one of these must be true first; otherwise a journey fails on a missing panel, not on a bug.

0. **Staging is paused by default.** Unpause it, deploy by hand (it never builds on push), run the journeys, then pause it again.
1. **Deploy.** Staging runs a build with the Team app, the engine read routes, event upload and the Budget & billing engine line (below). `/api/health` names the commit (staging does not follow main by itself). The Needs-you engine rows come with #1006: until that is deployed, W6 and the Needs-you part of W9 skip with a stated reason.
2. **Account switch on,** and the signed-in person is an owner or admin (the sheet is read-only for anyone else).
3. **An engine repo bridged:** a private, runner-local repository whose engine runs on a registered runner.
4. **Watch on** for that repo (Team, Settings). W1 turns it off and on again and leaves it as found.
5. **A runner with the bridge enabled,** online, so events upload. W7 and W9 stop and start it.
6. **A signed-in browser state** for that person: `JOURNEY_STORAGE_STATE=<file>`. The file holds a real session: keep it outside the repository (for example under your home directory). `.gitignore` carries `*.storage-state.json` and `storage-state*.json` as a second line of defence, not a place to keep it.
7. **The staging-only emitter hook that skips seq values** (W10 "make the emitter skip 5 seq values"). Without it W10 cannot make a gap and fails at the banner.
8. **The Budget & billing engine line (W11).** Budget & billing shows "On your own engine (API-equivalent)" from the `engine_api_equivalent_usd` field of the usage route (`/api/v1/usage`), and the Team cost headline reads the same figure. A build without that line fails W11.
9. **Work for the engine to do** while a journey waits: spawn an agent (W2), merge a ready pull request (W3), post a log line (W4), run the start-of-day script (W5), post and clear a needs-boss line (W6), load the 10,000-event fixture session (W10). Today's plan file at `JOURNEY_PLAN_FILE` (W5).

```
JOURNEY_MODE=live JOURNEY_BASE_URL=<staging origin> JOURNEY_STAGING_ORIGIN=<same origin> \
JOURNEY_REPO=<owner/name of the bridged repo> JOURNEY_STORAGE_STATE=<file> JOURNEY_PLAN_FILE=<file> \
pnpm --filter workspace exec playwright test e2e/engine-watch-journeys.spec.ts --project=desktop
```

**Staging allowlist.** It refuses to start unless the base URL equals `JOURNEY_STAGING_ORIGIN` and that origin is a staging host: `https://cloud-staging.vercel.app`, or a `https://cloud-staging-*-formalhosting.vercel.app` preview URL of the cloud-staging project (no port, no path, no credentials). Naming any other origin twice, the production one included, is still refused. `JOURNEY_REPO` is required: the repo box is found by that full name, never as the first box in the picker.

Nothing is stubbed. Each operator step prints `OPERATOR: ...`; the journey then waits up to 20 minutes for the screen to change. W2 and W7 start their clock at the first change on screen after that line, not while the person is still acting. That first change can be the target itself (the cloud shows everything in one refresh), so the figure is the time from the first visible change to the target and not from the operator's act; do the step promptly. Live limits: W2 60 s, W7 240 s and 120 s, W10 200 ms frame gap.

**Delete is a second opt-in.** W8 ends with Delete engine data, which cannot be undone and wipes every panel of the bridged repo. Live, it runs only if `JOURNEY_CONFIRM_DELETE` equals the full name in `JOURNEY_REPO`. Otherwise W8 runs the five-events check, prints that the delete was not run, and is reported as skipped with that reason.

**Counting.** The Log panel draws at most 100 rows, so W4 and W8 never count rows. A new event is a row whose `data-id` was not on screen before (W4: one such row; W8: five). W3 records every lane state the page shows; Merged must be reached and Queued or Testing must have been seen at least once, so a state that flashes past does not fail it.

Screen coverage: picker and chip (W1, W7, W9), Agents (W2, W9), Lanes (W3), Log (W4, W10), Plan (W5), Settings sheet (W1, W8), Needs-you engine rows (W6, W9), gap banner (W10).

## Things to know

- Run the file in order. W8 is last: Delete engine data cannot be undone. W3 and W4 leave history (a merge, a log line) with no undo.
- W2: the Agents panel lists running agents only, so a finished agent's verdict is not drawn anywhere. The journey checks the row leaves and stays gone after a reload.
- W6, and the Needs-you part of W9, skip themselves with a reason in a build without the Needs-you engine rows.
- Dry mode: W4's page-text check proves something only live (the stand-in never receives the words); W10 records the frame gap and holds it only live.
- Afterwards leave staging as found: watch on, repo ticked, runner started, bridge restarted.
