// Fixtures for the Team app, in exactly the shapes the engine read routes document: the per-repo list envelope
// ({items, next_cursor, as_of, heard_age_s, source_ages_s, gaps, missing_events}), the settings read, and the repo list row.
// Everything is relative to `nowMs`, so a unit test (a fixed time) and a browser test (the real clock) build the same states.
// Names are made up: no real repository, runner or person appears here.

export const REPO_A = "6f1c2f5e-3d8f-4f43-8d6e-8f2f6a9b1c22";
export const REPO_B = "6f1c2f5e-3d8f-4f43-8d6e-8f2f6a9b1c33";
export const SESSION = "0a8d1c52-7a0e-4c1a-9a53-0b1d2e3f4a55";
export const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script> **bold** [x](javascript:window.__pwned=3) &amp;';

export function makeFixtures(nowMs) {
  const iso = (agoS) => new Date(nowMs - agoS * 1000).toISOString();
  const envelope = (items, over = {}) => ({
    items, next_cursor: null, as_of: iso(30), heard_age_s: 20,
    source_ages_s: { loop: 60, team_log: 120, plan: 3600, merge_queue: 300 }, gaps: [], missing_events: 0, ...over,
  });
  const repo = (over = {}) => ({
    repo_id: REPO_A, full_name: "acme-labs/widgets", runner_id: "9d2c7b1e-5f3a-4e8b-8a6d-1c2b3a4d5e66", runner_name: "Workshop laptop",
    session_id: SESSION, last_event_at: iso(30), last_heard_at: iso(20), liveness: "live", watch_enabled: true, operate_enabled: false, halted: false, halt_pending: false, ...over,
  });
  const settingsRepo = (over = {}) => ({ repo_id: REPO_A, full_name: "acme-labs/widgets", enabled: true, eligible: true, refusal: null, ...over });
  const settings = (over = {}) => ({
    watch_enabled: true, operate_enabled: false, can_edit: true,
    repos: [settingsRepo(), settingsRepo({ repo_id: REPO_B, full_name: "acme-labs/site", enabled: false, eligible: false, refusal: "public_repo" })], ...over,
  });
  const agent = (over = {}) => ({
    agent_id: "a1b2c3d4e5f60718", role: "executor", discussion: 42, background: false, started_at: iso(600), stopped_at: null, verdict: null, state: "running", model: "sonnet-5", credential_mode: "subscription", ...over,
  });
  const lane = (over = {}) => ({ pr: 7, discussion: 42, state: "testing", updated_at: iso(300), ...over });
  const gate = (over = {}) => ({ pr: 7, gate: "gate1", result: "pass", head_sha: "a".repeat(40), at: iso(200), ...over });
  const list = (items) => ({ items });
  // The command channel and the decision dials, in the shapes engine-commands.ts and decision-settings.ts document.
  const command = (over = {}) => ({
    id: "c0000000-0000-4000-8000-000000000001", command_seq: 1, kind: "pause_loop", args: {}, state: "pending", refusal: null, issued_by: "u0000000-0000-4000-8000-000000000009",
    issued_at: iso(60), expires_at: new Date(nowMs + 540000).toISOString(), delivered_at: null, acked_at: null, halt_epoch_at_issue: 0, ...over,
  });
  const commands = (items) => ({ commands: items });
  const dial = (type, over = {}) => ({ decision_type: type, label: "Server label for " + type, class: "human_over_the_loop", adjustable: true, disposition: "ask", allowed_dispositions: ["act", "announce", "ask"], source: "default", preset: null, version: null, ...over });
  const dials = (over = {}) => ({ repo_id: REPO_A, can_change: true, catalogue_version: 11, active_preset: null, presets: [], invariants: [], dials: [dial("start_small_item"), dial("engine_spawn"), dial("engine_merge", { disposition: "announce" }), dial("engine_spec_ready", { allowed_dispositions: ["act", "ask"] })], ...over });
  /** Operate on, for the account and the repo: what an owner sees once the switch is on. */
  const operateOn = () => ({ settings: settings({ operate_enabled: true }), repos: list([repo({ operate_enabled: true })]) });
  return { iso, envelope, repo, settingsRepo, settings, agent, lane, gate, list, command, commands, dial, dials, operateOn };
}
