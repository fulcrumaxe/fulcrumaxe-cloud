# Engine operate journeys

The journeys O1 to O9, OC (cancel a pending command) and OF (operate off) press the Team app's buttons the way an owner does, reload,
check the result and undo it. Spec: `apps/workspace/e2e/journey-engine-operate.spec.ts`; fake cloud, ledger and machine numbers:
`apps/workspace/e2e/helpers/journey.ts`. Each journey's steps and undo are written at its test. Nothing runs against a real account
unless the live variables below are set.

O7 drives the dial a preset moves (the Team app lists the decision settings the Roles preset buttons write); when the Team Lead runs
O7 live, also press Balanced and then Autonomous under Roles, Autonomy.

## Dry run (no deploy, no account)

Runs on the built dist against a stateful fake of the engine routes, and is part of the normal workspace e2e run.

    pnpm --filter workspace build
    flock /tmp/fx-team-tests.lock pnpm --filter workspace exec playwright test e2e/journey-engine-operate.spec.ts e2e/team.spec.ts --project=desktop

The fake answers the command route as the real one does, in the route's order: 409 `operate_off`, `engine_not_connected`,
`too_many_pending` (20 waiting, counted before the insert) and then `halted` (the insert's trigger; for start day, resume, request and set
dial only, while pause, answer and stop stay allowed), and a held command still answers 201 with `expires_at`. The ORD journey sets two
or more of these at once and checks the answer is the first in that order. O8 and OF each end with a dry-only step in which the cloud refuses a send the page had not been told was
locked, and the page shows the route's own sentence ("The engine is halted, so this command isn't allowed." and "Operate is off for this
repository. Turn it on first.").

O3 skips in a dry run with its reason: the answer buttons on engine asks are not in this tree yet. It runs live.

## Live run (staging, after each bridge PR merges and deploys)

Staging only. Prerequisites, all of them:

1. **Deployed.** Web app, workspace and a runner build carrying `engine_bridge_v1`, on staging (unpaused, manually deployed, paused after).
2. **A bridged repo.** A private repository the runner serves, ticked in Team > Settings.
3. **Watch on.** The account's engine watch switch is on.
4. **Operate on, both switches.** The account switch (Team > Operate) and the engine's own `cloud_bridge.operate`. Operate stays
   off on every live project until the engine's merge-gate rows (EB-10d, EB-10e) are merged; the journeys run on staging only.
5. **A runner with the bridge enabled.** `fx-runner engine-bridge enable --repo <owner/name> --repo-root <absolute path of the engine repo>` has run, the Team chip reads
   "Engine connection: Live", and `fx-runner engine-host start` is running.
6. **An owner account** (owner or admin, never a member), saved as a Playwright storage state file.
7. **A real open Discussion** for O4, and a test Discussion for O7's flips.
8. **For OC only:** the bridge stopped so a command stays pending (`JOURNEY_RUNNER_AWAY=1`); start it again afterwards.

Variables (the config refuses to start without the first four):

    JOURNEY_LIVE=1  JOURNEY_ORIGIN=<staging origin>  JOURNEY_CONFIRM_ORIGIN=<same origin, typed again>  JOURNEY_STORAGE_STATE=<path>
    JOURNEY_CONFIRM_REPO=<owner/name, typed again; needed by the halt, stop-agent and operate-off steps>
    JOURNEY_REPO=<owner/name as in the picker>  JOURNEY_SPAWN_DISCUSSION=<n>  JOURNEY_REFUSED_DISCUSSION=<n>
    JOURNEY_MACHINE_FILE=<json>  JOURNEY_WAIT_MS=<per wait, default 20 min>

    pnpm --filter workspace exec playwright test -c playwright.journeys.config.ts

The config refuses any origin that is not a bare https origin (no port, path or login) whose host matches one of
`^cloud-staging\.vercel\.app$` or `^cloud-staging-([a-z0-9]{9}|git-[a-z0-9-]+)-formalhosting\.vercel\.app$` (the cloud-staging project's
own host, a deployment of it, or a branch preview of it), even when it is typed twice, and refuses a storage-state path that is not an
existing file. `apps/workspace/test/journey-staging-host.test.mjs` holds the table of hosts it admits and refuses.
The halt (O8), the agent stop (O5) and the operate-off switch (OF) also refuse to start unless `JOURNEY_CONFIRM_REPO` equals the repository name.

## Machine numbers

Loop ticks, `systemd-cgls` counts, `engine_events` rows and the merge command's output come from the runner's machine. "The engine's state
directory" below is `$AUTONOMOUS_TEAM_STATE_DIR`, or `~/.autonomous-forever-state` when that is not set. `fx-runner engine-host status`
prints only two things, whether a host is recorded (its pid and scope) and `Halt: halted` or `Halt: not halted`; it does not show loops
or agents. The journey asks for each by
name (`O8.survivors`) in `JOURNEY_MACHINE_FILE`, a JSON object of `"<journey>.<name>": <number>`; a missing number fails the journey at
the step that asks, so produce them as the journey reaches each point (a journey prints `LEDGER` lines as it goes) and write the
file before the run, or run the journeys one at a time (`-g "O1 "`). How to produce each, on the machine that runs the engine:

| Number | How |
|---|---|
| `O1.loop_ticks_in_20_min` | After the pause applies, count the lines with `"kind":"tick_started"` and `"tick_kind":"loop"` that the host adds to `engine-host-events.jsonl` in the engine's state directory over 20 minutes (the file rotates at 1 MiB to `.1`; count before it does). Expect 0. |
| `O1.loop_ticks_within_2_min_of_resume` | After the resume applies, count those lines in the next 2 minutes. Expect at least 1. |
| `O2.start_day_tick_ran` | 1 if the start-of-day script ran (its log line is in the team log after the command applied), else 0. |
| `O2.plan_received_at_updated` | 1 if the cloud's plan `received_at` moved after the command (read it on the Team plan panel before and after), else 0. |
| `O3.command_state_applied` | 1 if the answer's command row reads Applied in Team > Commands. |
| `O3.note_text_in_engine_events_rows` | Count rows of the `engine_events` table whose payload holds the note text typed in the journey (`approved from the journey`). Expect 0: a note never goes into events. |
| `O4.agent_started_within_15_min` | 1 if the requested agent shows within 15 minutes of the request: in the Team app's Agents panel, or as an `agent_started` line (with its role and Discussion) added to `engine-events.jsonl` in the engine's state directory. |
| `O4.decide_receipt_answered_by_owner` | 1 if the engine's receipt for the request names the owner as the one who decided. |
| `O5.agent_stopped_within_10_min` | 1 if the agent process is gone from `systemd-cgls` (it runs inside the host's `fx-engine-host-<repo id>.scope`) within 10 minutes of the stop, and the Team app's Agents panel no longer lists it. |
| `O6.decision_asks_after_merge_attempt` | 1 if the merge attempt of the O6 step below produced an ask (a Needs-you row), 0 if it merged. |
| `O7.balanced_flip_asks` / `O7.autonomous_flip_status_ready` | After each dial value, mark a throwaway Spec ready on the test Discussion: 1 if the engine asked first (ask) or went ahead (act), else 0. |
| `O8.survivors` | After the halt shows Halted, count engine and agent processes still alive on the machine. Expect 0. |
| `O8.systemd_cgls_processes` | `systemd-cgls` on the host's `fx-engine-host-<repo id>.scope`: count its processes. Expect 0. |
| `O8.host_runs_again_after_start` | After clearing the halt, run `fx-runner engine-host resume` if `fx-runner engine-host status` still shows a local stop, then `fx-runner engine-host start`; 1 if it prints "Engine host started." and `status` shows a host recorded. |
| `O9.merge_refused_exit_code` | The exit code of the merge attempt in the O9 step below. From the engine's merge guard (`scripts/merge-and-hook.sh` calling `cloud-decide.sh` and `cloud_decide.py`): a cloud that cannot be asked or answers badly is exit 5, with no merge. Expect 5. |
| `O9.fixed_line_in_team_log` | 1 if the merge command's standard error held the fixed line `cloud unreachable; merge refused (fail-closed)`. The key keeps its name, but the engine writes that line to the command's output and emits a `merge_lane` event with state `refused`; it writes nothing to the team log for a refusal (only an announce writes a team-log line). Record what you see. |

## O6: approve and merge

O6 sets the merge dial to ask first. Machine step, after the dial shows "ask" and before the journey continues: on the machine, run the
engine's merge on a throwaway pull request (one that is ready and approved). It must stop and raise an ask instead of merging. Open
Needs-you, find the engine row for that pull request, press Approve with a note, and wait for the command to read Applied; then run
the same merge again, which now goes through. Write `O6.decision_asks_after_merge_attempt` = 1 if the first run asked and did not
merge. The journey puts the merge dial back at its end.

## O9: refusal by an unreachable origin

O9's screen part shows a refused command's sentence. Its machine part (the numbers `merge_refused_exit_code` and `fixed_line_in_team_log`)
is a local step, done on the runner's machine after the screen part:

The origin is not a setting: it is the `cloud_origin` field of `registration.json` in the runner's state directory (written by `register`), and
`fx-runner status` shows it on its `Cloud:` line. There is no command to change it, so this step edits that file by hand and puts it back.
The running `fx-runner run` reads it only when it starts, so it is that process, not the engine host, that must be restarted (the host never
reads the origin). This build pins job-signing keys per cloud address, so `fx-runner run` against an unknown origin refuses to start with
`job_keyring_missing`: the bridge is then simply down, and the engine finds no usable decide socket. Either way the engine's merge guard
refuses; record which of the two you saw.

1. Copy `registration.json` aside in the runner's state directory (`cp -p registration.json registration.json.o9-backup`) and note the `Cloud:` line of `fx-runner status`.
2. Stop `fx-runner run`, edit only the `cloud_origin` field of `registration.json` to `https://unreachable.invalid`, and start `fx-runner run` again the way this machine runs it.
3. Run the engine's merge on a throwaway pull request. It must not merge. From the engine's merge guard, the expected result is exit code 5 and the line `cloud unreachable; merge refused (fail-closed)` on its output (then `[merge-and-hook] cloud decide refused the merge of PR #<n> (exit 5).`). Record the exit code and the lines you actually see; the team log is not expected to hold a line for a refusal.
4. Stop `fx-runner run`, restore the copy (`cp -p registration.json.o9-backup registration.json`), and start `fx-runner run` again.
5. Confirm `fx-runner status` shows the original `Cloud:` origin from step 1 and the Team chip reads "Engine connection: Live" again.

Do steps 4 and 5 even if step 3 went wrong; until they are done the bridge is cut off.

## Failed undo recovery

Every journey puts back what it changed in an `afterEach`; each undo step runs on its own, so one failing never hides another, and the
run then fails with a message naming each failed step. When it does, the state may be left changed. Put it back by hand, on staging,
as the owner in the Team app (or the commands given):

| Left over | Put it back |
|---|---|
| Loop paused (O1) | Team > Operate > Resume loop; read the Commands list until it says Applied. To see the loop run again, watch the Team app's panels (the plan and the live line), or new `tick_started` lines with `"tick_kind":"loop"` in `engine-host-events.jsonl` in the engine's state directory; `fx-runner engine-host status` does not show the loop. |
| An agent still running (O4, O5) | Team > Agents > Stop on the code reviewer for the test Discussion, confirm, wait for Applied. On the machine there is no unit of its own to stop: the agent runs inside the host's `fx-engine-host-<repo id>.scope`, so `systemctl --user stop` on that unit would stop the whole host. To stop everything on purpose, run `fx-runner engine-host stop`; to bring the host back after that, `fx-runner engine-host resume`, then `fx-runner engine-host start`. |
| Merge dial or Spec-ready dial changed (O6, O7) | Team > Dials: set the dial to the value printed at the start of the journey (the page shows it before the change; if lost, Balanced for merge and ask for Spec ready), Apply, reload to confirm. A command-set dial (O6) lapses with its "for today" time. |
| Engine halted (O8) | Team > Halt > Clear halt, confirm. Then, on the machine, if `fx-runner engine-host status` still shows `Halt: halted by a local stop`, run `fx-runner engine-host resume`; then start the host: `fx-runner engine-host start`. If the clear button never shows, clear from the cloud with the halt route (`POST /api/v1/engine/repos/<repo id>/halt/clear` as the owner) and read the chip. |
| Operate off (OF) | Team > Operate: tick "Allow commands to the engine". |
| Command left pending (OC) | Team > Commands > Cancel on the row, or wait 10 minutes for it to expire. Start the bridge again (`fx-runner engine-bridge enable --repo <owner/name> --repo-root <absolute path of the engine repo>`, then `fx-runner engine-host start`). |
| Runner origin pointed away (O9) | Stop `fx-runner run`, restore `registration.json` from the copy made in step 1 (`cp -p registration.json.o9-backup registration.json`), start `fx-runner run` again, and check `fx-runner status` shows the original `Cloud:` origin. |

After any recovery, reload Team and check: chip Live, not halted, Operate on, no agent of the journeys running.

## Ledger

`test-results/journey-ledger.jsonl` (override with `JOURNEY_LEDGER`): `{at, mode, journey, name, value, source}`, where
`source` is `ui`, `machine` or `fixture` (dry run only). Copy the live rows into the verify ledger.
