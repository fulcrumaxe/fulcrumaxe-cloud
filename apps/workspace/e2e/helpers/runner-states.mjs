// apps/workspace/e2e/helpers/runner-states.mjs
//
// D#6 C42-4: what the Runs detail must draw for each state of a run on the person's own machine. One table, read by the unit test
// (test/runner-parity.test.mjs) and by the Playwright specs, so the two cannot disagree. The states are the files in
// packages/api/fixtures/v1/getRunInsight (and getWorkItemActivity): the real route outputs pinned against Postgres.

export const NOT_RECORDED = "This run ended without reporting how many tokens it used, so there is no cost estimate. That is not the same as $0.";
export const NOT_PRICED = "The tokens were recorded, but there is no API price for this run's model, so no dollar estimate is shown. That is not the same as $0.";

/** What each fixture must draw. `empty` is the empty-Activity view for the state (null when lines exist or the wait speaks for it). */
export const LIVE_COST = { value: "Counting…", detail: null };
export const NOT_REC = { value: "Not recorded", detail: NOT_RECORDED };
export const RUNS = {
  "200-runner-approval-needed.json": { wait: "Waiting for your runner to come online", cost: LIVE_COST, empty: null },
  "200-runner-capped.json": { wait: null, cost: LIVE_COST, checkedIn: "10:03:30", attach: true },
  "200-runner-claimed-no-events.json": { wait: null, cost: LIVE_COST, checkedIn: "10:03:30", attach: true, empty: { testid: "runs-nothing-yet", text: "Your runner has started; nothing recorded yet" } },
  "200-runner-failed-agent-failed.json": { wait: null, cost: NOT_REC },
  "200-runner-failed-job-refused.json": { wait: null, cost: NOT_REC },
  "200-runner-failed-push-rejected.json": { wait: null, cost: NOT_REC },
  "200-runner-failed-push-too-large.json": { wait: null, cost: NOT_REC },
  "200-runner-failed-runner-setup.json": { wait: null, cost: NOT_REC },
  "200-runner-failed-wall-clock.json": { wait: null, cost: NOT_REC },
  "200-runner-lease-lost.json": { wait: null, cost: NOT_REC },
  "200-runner-running-activity.json": { wait: null, cost: LIVE_COST, checkedIn: "10:03:30", attach: true },
  "200-runner-succeeded-with-pr.json": { wait: null, cost: { value: "On your Claude plan · API-equivalent $0.01 · 1,000 in / 200 out tokens", detail: "Estimate, priced at this run's model" } },
  "200-runner-taken-over.json": { wait: null, cost: NOT_REC },
  "200-runner-usage-limit.json": { wait: null, cost: NOT_REC },
  "200-runner-usage-not-priced.json": { wait: null, cost: { value: "On your Claude plan · no API price for this model · 500 in / 100 out tokens", detail: NOT_PRICED } },
  "200-runner-usage-not-recorded.json": { wait: null, cost: NOT_REC },
  "200-runner-wait-account-cap.json": { wait: "Waiting: your account's runner job limit is reached", cost: LIVE_COST, empty: null },
  "200-runner-wait-paused-usage-limit.json": { wait: "Paused: Claude usage limit reached.", cost: LIVE_COST, empty: null },
  "200-runner-wait-runner-lost-retrying.json": { wait: "Your runner lost contact. Retrying from the last pushed commit", cost: LIVE_COST, empty: null },
  "200-runner-wait-slot-ceiling.json": { wait: "Waiting: your runner is at its job limit", cost: LIVE_COST, empty: null },
  "200-runner-wait-slot-cpu.json": { wait: "Waiting for a free slot on your runner (CPU is busy)", cost: LIVE_COST, empty: null },
  "200-runner-wait-slot-disk.json": { wait: "Waiting for a free slot on your runner (disk is low)", cost: LIVE_COST, empty: null },
  "200-runner-wait-slot-memory.json": { wait: "Waiting for a free slot on your runner (memory is short)", cost: LIVE_COST, empty: null },
  "200-runner-wait-slot-paused.json": { wait: "Your runner is paused", cost: LIVE_COST, empty: null },
  "200-runner-wait-slot-plain.json": { wait: "Waiting for a free slot on your runner", cost: LIVE_COST, empty: null },
  "200-runner-wait-timed-out-waiting.json": { wait: "Timed out waiting for a runner.", cost: NOT_REC, empty: { testid: "runs-no-activity", text: "No activity recorded." } },
  "200-runner-wait-waiting-for-approval.json": { wait: "Waiting for approval before this run starts on a Claude plan", cost: LIVE_COST, empty: null },
  "200-runner-wait-waiting-for-runner.json": { wait: "Waiting for your runner to come online", cost: LIVE_COST, empty: null },
  "200-runner-waiting.json": { wait: "Waiting for your runner to come online", cost: LIVE_COST },
};

