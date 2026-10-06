#!/usr/bin/env bash
# Called by .github/workflows/ci-full-label.yml when the label `ci:full` is added to a pull request.
#
# Makes the CI workflow run again on the pull request's current head, as a RE-RUN of its latest run (the same
# run id, a new attempt; the same head SHA; the same `check` and `workspace-e2e (...)` check names). The
# scope steps of that attempt read the labels from the API, see `ci:full` and run everything.
#
#   needs: GH_TOKEN (actions: write, pull-requests: read), GITHUB_REPOSITORY, HEAD_SHA, PR_NUMBER, `gh` on PATH
#   knobs: CI_FULL_FIND_SECONDS (wait for a run to exist, default 90), CI_FULL_WAIT_SECONDS (wait for a
#          cancelled run to finish, default 600), CI_FULL_POLL_SECONDS (default 5)
#
# What it does with the latest run, by status:
#   completed  re-run it.
#   queued / waiting / pending / requested
#              nothing: it has not started, its scope steps have not read the labels yet and will see
#              `ci:full` when they do (the label was added before this script ran). Cancelling it would only
#              send it to the back of the queue.
#   in_progress
#              its scope step may already have decided `affected`. Cancel it, wait until it is completed, then
#              re-run it (GitHub refuses to re-run a run that is still going).
#   no run     wait up to CI_FULL_FIND_SECONDS (the run for a fresh push may not exist yet), then fail loudly.
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${HEAD_SHA:?HEAD_SHA is required}"
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "HEAD_SHA is not a 40-character SHA: $HEAD_SHA" >&2; exit 1; }
[[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "GITHUB_REPOSITORY is malformed" >&2; exit 1; }

: "${PR_NUMBER:?PR_NUMBER is required}"
[[ "$PR_NUMBER" =~ ^[1-9][0-9]{0,9}$ ]] || { echo "PR_NUMBER is malformed: $PR_NUMBER" >&2; exit 1; }

# The label job can get the runner long after the label event. HEAD_SHA comes from the event, so a push in
# between makes it stale, and re-running the OLD head's run would cancel the NEW head's run (same concurrency
# group). Ask for the PR's head now. A different head, or an answer we cannot get, means do nothing: the new
# head's own run reads `ci:full` from the API when it starts.
current="$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json headRefOid --jq .headRefOid 2>/dev/null)" || current=""
if [ -z "$current" ]; then
  echo "could not read the current head of PR $PR_NUMBER; touching no run" >&2
  exit 0
fi
if [ "$current" != "$HEAD_SHA" ]; then
  echo "PR $PR_NUMBER has moved on from $HEAD_SHA to $current; its own run reads ci:full when it starts. Touching no run."
  exit 0
fi

find_s="${CI_FULL_FIND_SECONDS:-90}"
retry_s="${CI_FULL_RETRY_SECONDS:-10}"
wait_s="${CI_FULL_WAIT_SECONDS:-600}"
poll_s="${CI_FULL_POLL_SECONDS:-5}"

# "<run id> <status>" of the newest CI run of a pull_request event on this head, or nothing.
latest() {
  gh run list --repo "$GITHUB_REPOSITORY" --workflow ci.yml --event pull_request --commit "$HEAD_SHA" --limit 1 \
    --json databaseId,status --jq '.[0] // empty | "\(.databaseId) \(.status)"'
}

run=""
status=""
waited=0
while :; do
  line="$(latest)"
  if [ -n "$line" ]; then
    run="${line%% *}"
    status="${line#* }"
    break
  fi
  if [ "$waited" -ge "$find_s" ]; then
    echo "no CI run found for $HEAD_SHA after ${find_s}s; nothing to re-run" >&2
    exit 1
  fi
  sleep "$poll_s"
  waited=$((waited + poll_s))
done

case "$status" in
  completed) ;;
  queued | waiting | pending | requested)
    echo "CI run $run has not started ($status): its scope step will read ci:full from the API. Nothing to do."
    exit 0
    ;;
  in_progress)
    echo "CI run $run is in progress: cancelling it so that it can be re-run at full scope."
    gh run cancel "$run" --repo "$GITHUB_REPOSITORY"
    waited=0
    while :; do
      line="$(latest)"
      [ "${line%% *}" = "$run" ] && [ "${line#* }" = completed ] && break
      if [ "$waited" -ge "$wait_s" ]; then
        echo "CI run $run did not finish cancelling within ${wait_s}s" >&2
        exit 1
      fi
      sleep "$poll_s"
      waited=$((waited + poll_s))
    done
    ;;
  *)
    echo "CI run $run has an unexpected status: $status" >&2
    exit 1
    ;;
esac

echo "Re-running CI run $run at full scope (label ci:full)."
if ! gh run rerun "$run" --repo "$GITHUB_REPOSITORY"; then
  echo "re-run of CI run $run failed; retrying once in ${retry_s}s" >&2
  sleep "$retry_s"
  if ! gh run rerun "$run" --repo "$GITHUB_REPOSITORY"; then
    echo "re-run of CI run $run failed twice (it may have been cancelled and not restarted): re-run it by hand" >&2
    exit 1
  fi
fi
