// The Team app's operate half, with no DOM (unit-tested with a fake client): the closed commands an owner or admin may send to the engine on their
// own machine, the three engine dials, and the list of commands with what became of each. team-model.js owns the state and calls in here; team-app.js
// draws what describeOperate() returns.
//
// Rules this file holds:
//  - Every control is locked, with a sentence that says why, while operate is off, watch is off or the repo is halted. The guard is here too, so a
//    press that reaches the controller while locked sends nothing (the page's aria-disabled is a cue, not the check).
//  - A command reads "Applied" only once the runner's report is in (acked_at set); a pending one past its life reads "Expired" at once.
//  - Every sentence is chosen by the closed wire code (a refusal, a 409 code), never taken from the server's text.
//  - Nothing here counts, adds up or estimates: the lists show what the cloud sent.
import { isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";
import { h } from "../_lib/dom.js";
import { readFleet } from "../runners/runners-fleet.js";

export const COMMAND_LIFE_MIN = 10;
export const ENGINE_DIALS = ["engine_spawn", "engine_merge", "engine_spec_ready"];
const DIAL_NAME = { engine_spawn: "Letting the engine start an agent", engine_merge: "Letting the engine merge a pull request", engine_spec_ready: "Letting the engine mark a Spec ready to build" };
const DISPOSITION_TEXT = { ask: "Ask me first", announce: "Go ahead and tell me", act: "Go ahead" };
export const ROLES = {
  executor: "Executor", "code-reviewer": "Code reviewer", "security-reviewer": "Security reviewer", "acceptance-tester": "Acceptance tester", "browser-tester": "Browser tester",
  "project-manager": "Project manager", "technical-architect": "Technical architect", "product-owner": "Product owner", "cost-analyst": "Cost analyst", "performance-expert": "Performance expert", "security-expert": "Security expert",
};
export const DIAL_CLASSES = {
  "docs.write": "Writing documentation", "tests.add": "Adding tests", "deps.bump": "Bumping dependencies", "agent.spawn": "Starting agents",
  "merge.standard": "Standard merges", "merge.fast-path": "Fast-path merges", "memory.write": "Writing memory", "archive.move": "Moving files to the archive",
};
export const TTL = { for_today: "For today", none: "Until I change it" };
const KIND_WORD = { start_day: "Start the day", pause_loop: "Pause the loop", resume_loop: "Resume the loop", request_spawn: "Request an agent", stop_agent: "Stop an agent", set_dial: "Set a dial", answer_ask: "Answer an ask" };
const STATE_WORD = { pending: "Pending", delivered: "Delivered", applied: "Applied", refused: "Refused", expired: "Expired", cancelled: "Cancelled", not_confirmed: "Not confirmed" };
const STATE_DETAIL = {
  pending: "Waiting for the runner to pick it up.", delivered: "The runner has it. Waiting for it to report back.", applied: "The engine did it.",
  expired: "The runner did not pick it up in time.", cancelled: "You cancelled it before the runner had it.", not_confirmed: "The runner had it but never reported back, so it may or may not have happened.",
};
export const REFUSALS = {
  signature_invalid: "The runner could not verify the command's signature.", wrong_runner: "It was addressed to a different runner.", wrong_repo: "It was addressed to a different repository.",
  expired: "It expired before the runner could apply it.", seq_not_increasing: "The runner had already seen a newer command.", halted: "The engine is halted.", operate_off: "Operate is off on that machine.",
  host_not_running: "The engine host is not running on that machine.", unknown_ask: "That ask is no longer open.", unknown_agent: "That agent is not running.", ceiling: "A ceiling set in the cloud does not allow that.",
};
export const OP_WORDS = {
  operate: "Operate", operateSwitch: "Allow commands to the engine", operateOff: "Operate is off.", watchOff: "Engine watch is off.", noRepo: "No repository is enabled for engine watch.",
  halted: "The engine is halted.", haltPending: "A halt is being applied.", removed: "The runner for this repository was removed, so commands can't be sent.",
  offline: "Machine offline; commands will expire in " + COMMAND_LIFE_MIN + " min.", watchFirst: "Turn on engine watch first.",
  startDay: "Start day", pause: "Pause loop", resume: "Resume loop", request: "Request agent", role: "Role", discussion: "Discussion number", send: "Send",
  stop: "Stop", stopPending: "A stop is already on its way.", stopTitle: "Stop this agent?", stopText: "It stops now, and work it has not finished can be lost.", stopYes: "Yes, stop it", cancel: "Cancel",
  dials: "Engine dials", dialClass: "Dial", level: "Level", levelHint: "Lower levels ask more often; higher levels ask less.", ttl: "Lasts", apply: "Apply", setDial: "Set a dial on the engine",
  commands: "Commands", noCommands: "No commands have been sent.", noDials: "The engine dials aren't available.", listFailed: "This list couldn't be read.", noData: "no data yet",
  sent: "Sent. Waiting for the runner to pick it up.", cancelled: "Command cancelled.", dialSaved: "Dial saved.", operateSaved: "Saved.", badSpawn: "Choose a role and enter a Discussion number of 1 or more.",
  badDial: "Choose a dial, a level from 1 to 5 and how long it lasts.", sendFailed: "That didn't send. Try again.", forbidden: "Only an owner or admin can send commands.", gone: "That repository or command no longer exists.",
  dialForbidden: "Only an owner or admin can change dials.", dialRefused: "That setting isn't allowed for this dial.", dialChanged: "A dial changed while you saved. Reload and try again.", dialFailed: "That dial didn't save. Try again.",
  unknownAgent: "an agent",
};
const SEND_409 = {
  operate_off: "Operate is off for this repository. Turn it on first.", engine_not_connected: "No engine is connected for this repository. Start the engine on your machine first.",
  halted: "The engine is halted, so this command isn't allowed.", too_many_pending: "Too many commands are waiting (20 is the most). Wait for some to finish, or cancel one.",
};
const CANCEL_409 = { already_delivered: "The runner already has this command, so it can't be cancelled.", expired: "That command has already expired.", already_cancelled: "That command is already cancelled." };
export const HALT_WORDS = {
  halt: "Halt", clear: "Clear halt", yesHalt: "Yes, halt", yesClear: "Yes, clear it", cancel: "Cancel", head: "Halt", chipPending: "Halting…", chipHalted: "Halted",
  none: "The engine is not halted. A halt stops it now and refuses every command until a person clears it.",
  noneOwner: "The engine is not halted. A halt stops it now and refuses every command until a person clears it. If the engine was stopped on the machine itself, halting here and then clearing is how to end that stop from the cloud.",
  pending: "Halting. The machine has not yet confirmed that the engine and its agents are stopped. Every command is refused until a person clears the halt.",
  halted: "The engine is halted. It is stopped on the machine and every command is refused until a person clears the halt.",
  askHaltTitle: "Halt the engine?", askClearTitle: "Clear the halt?", haltTail: " now and kills its agents.", haltLead: "This stops the engine on ", yourMachine: "your machine",
  haltRisk: "Work the agents have not finished can be lost. Every command is refused until an owner or admin clears the halt.",
  clearText: "Commands are allowed again. The engine is not started for you: use Resume loop or Start day afterwards.",
  clearLocal: "If it was stopped on the machine itself, clearing does not lift that. Afterwards, halt here and clear again, or resume it on the machine.",
  byLead: "Halted by ", atWord: "at", haltedAt: "Halted at",
  busy: "Another change is being saved. Try again in a moment.",
  clearedSaid: "The halt is cleared. The engine is not started again until you start it.", pendingSaid: "Halting. Waiting for the machine to confirm it stopped the engine.", haltedSaid: "The engine is halted.",
  haltForbidden: "Only an owner or admin can halt the engine.", clearForbidden: "Only an owner or admin, signed in, can clear a halt.", signedOut: "Your session has ended. Sign in again.",
  gone: "That repository no longer exists.", haltRefused: "The halt was not accepted. Reload the page and try again.", clearRefused: "The halt was not cleared. Reload the page and try again.",
  haltUnknown: "The halt may not have gone through. Check the state above, then try again.", clearUnknown: "The halt may not have been cleared. Check the state above, then try again.",
};
// ── a stop that did not finish (the `stop_failed` fact on the repo list) ─────────────────────────────────────────────────────
// The cloud sends {reason, code, at} or null; every sentence is chosen here by those closed values, never taken from the server. A person's or a halt's stop can be asked
// again by an owner or admin; the other causes have no button: a system cause is re-issued by the cloud itself, a move or a removal by its own flow.
export const STOP_WORDS = {
  chipContext: "Engine stop: ", chip: "Stop failed", retry: "Try again", retrying: "Trying again…", forbidden: "Only an owner or admin can try again.",
  other: "The engine didn't stop",
  base: {
    person: "The stop didn't finish. The engine may still be running",
    halt: "The halt didn't finish stopping the engine. It may still be running, and commands stay refused",
    operate_off: "Operate is off, but the engine didn't stop. It may still be running",
    plan: "The Engine plan ended, but the engine didn't stop. It may still be running",
    move: "Moving the project didn't stop the engine on its old machine",
    remove: "Removing the project didn't stop its engine",
  },
  why: {
    snapshot_failed: "the engine's state couldn't be saved", vm_teardown_incomplete: "the machine couldn't finish shutting it down", job_expired: "the machine didn't pick up the stop in time",
    job_silent: "the machine went quiet", job_overran: "the stop took too long",
  },
  after: { operate_off: "We'll try again when the machine next reports in.", plan: "We'll try again when the machine next reports in.", move: "Start the move again to try once more.", remove: "Stop it on the machine itself." },
  sent: "Asked the machine to stop the engine again.", already: "A stop is already on its way.", queued: "Asked again. The stop goes out when the machine next reports in.",
  errors: {
    forbidden: "Only an owner or admin can try again.", notFound: "That repository no longer exists.", signedOut: "Your session has ended. Sign in again.", other: "That didn't send. Try again.",
    not_placed: "This project isn't on a machine.", runner_removed: "The machine was removed.", nothing_to_retry: "The stop already changed. Reload the page.", cause_gone: "That's no longer needed, so nothing was sent.",
  },
};
const STOP_REASONS = ["person", "halt", "operate_off", "plan", "move", "remove"];
/** The closed shape of the list's `stop_failed`; anything else reads as no failed stop (fail closed). */
export function readStopFailed(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  return { reason: STOP_REASONS.includes(raw.reason) ? raw.reason : "", code: typeof raw.code === "string" ? raw.code : "", at: typeof raw.at === "string" ? raw.at : "" };
}
/** A move or a removal is not asked again from the chip; every other cause (and an unknown one) has the button. */
const stopAskable = (sf) => sf.reason !== "move" && sf.reason !== "remove";
/** The row under the bar for the open repo, or null when its stop did not fail. The flag is the one the Halt control reads (`canEdit`: an owner or admin). */
export function describeStopFailed(st, repo) {
  const sf = repo && repo.stopFailed;
  if (!st.settings || !sf) return null;
  const base = sf.reason !== "" ? STOP_WORDS.base[sf.reason] : STOP_WORDS.other;
  const why = Object.hasOwn(STOP_WORDS.why, sf.code) ? " (" + STOP_WORDS.why[sf.code] + ")" : "";
  const askable = stopAskable(sf), can = st.settings.canEdit === true;
  return {
    id: repo.id, chip: STOP_WORDS.chip, text: base + why + ".", after: Object.hasOwn(STOP_WORDS.after, sf.reason) ? STOP_WORDS.after[sf.reason] : "",
    button: askable, canRetry: askable && can, busy: st.op.stopBusy === true, label: st.op.stopBusy ? STOP_WORDS.retrying : STOP_WORDS.retry,
    forbidden: askable && !can ? STOP_WORDS.forbidden : "", note: st.op.stopNote,
  };
}
/** Every refusal of Try again in words, chosen by the status and the closed 409 code. */
export function stopFailure(e) {
  const st = e && Number.isInteger(e.status) ? e.status : 0;
  if (st === 401) return STOP_WORDS.errors.signedOut;
  if (st === 403) return STOP_WORDS.errors.forbidden;
  if (st === 404) return STOP_WORDS.errors.notFound;
  if (st === 409 && typeof e.code === "string" && ["not_placed", "runner_removed", "nothing_to_retry", "cause_gone"].includes(e.code)) return STOP_WORDS.errors[e.code];
  return STOP_WORDS.errors.other;
}
/** The row's nodes: the sentence, the button (disabled for a member, with the line that says why), what happens next, and the last answer. The click calls `retry()` with no argument. */
export function stopFailNodes(v, retry) {
  const btn = v.button ? h("button", { type: "button", class: "tm-btn", "data-testid": "tm-stopfail-retry", "data-focus": "stop-retry", "aria-disabled": !v.canRetry || v.busy ? "true" : "false", "aria-describedby": v.forbidden ? "tm-stopfail-why" : null, onClick: () => { if (btn.getAttribute("aria-disabled") !== "true") retry(); } }, v.label) : null;
  return [
    h("p", { class: "tm-stop-text", "data-testid": "tm-stopfail-text" }, v.text),
    btn,
    v.forbidden ? h("p", { class: "tm-muted", id: "tm-stopfail-why", "data-testid": "tm-stopfail-why" }, v.forbidden) : null,
    v.after ? h("p", { class: "tm-muted", "data-testid": "tm-stopfail-after" }, v.after) : null,
    v.note ? h("p", { class: "tm-halt-note", role: "note", "data-testid": "tm-stopfail-note" }, v.note) : null,
  ];
}

// ── the engine update card (D#845 ON-15d) ──────────────────────────────────────────────────────────────────────────────────────
// The cloud sends one fact per repo, `engine_update: {behind, update} | null`; every sentence, the progress step, the PR link and who gets the button are chosen here by those
// closed values, never taken from the server's text. `behind` is the version pair on offer (nothing under way, project on a machine); `update` is the repo's update under
// way, or the one that failed while the project is still behind.
export const UPDATE_WORDS = {
  available: (from, to) => "Update available (v" + from + " → v" + to + ")",
  running: (from, to) => "Updating the engine (v" + from + " → v" + to + ")",
  failedTitle: (from, to) => "Engine update failed (v" + from + " → v" + to + ")",
  update: "Update", retry: "Try again", starting: "Starting the update…", forbidden: "Only an owner or admin can update the engine.",
  step: (n, of, label) => "Step " + n + " of " + of + ": " + label + ".",
  steps: { push: "Preparing the update", pr: "Opening the pull request", await_merge: "Waiting for someone to merge the pull request", restart: "Restarting the engine" },
  sub: { engine_fetch: "fetching the new version", sandbox_boot: "starting a sandbox", workspace_in: "copying the project in", bootstrap: "applying the update", bundle_out: "collecting the changes", push: "sending the changes to GitHub" },
  merged: (to) => "Merged. Restarting the engine on v" + to + ".", mergedIdle: (to) => "Merged. The engine restarts on v" + to + " when Operate is next on.",
  failed: (to, why) => "The update to v" + to + " didn't finish" + (why ? " (" + why + ")" : "") + ".",
  pr: (n) => "Pull request #" + n, newTab: " (opens in a new tab)",
  why: {
    engine_fetch_failed: "the new version couldn't be downloaded", engine_checksum: "the download didn't match its checksum", engine_archive_refused: "the download wasn't accepted",
    bootstrap_failed: "the update step failed on the machine", bundle_refused: "the changes from the machine weren't accepted", push_failed: "the changes couldn't be sent to GitHub",
    direct_raced: "the update branch changed while it ran", vm_admission_refused: "the machine had no room for a sandbox", vm_boot_failed: "the sandbox didn't start",
    vm_egress_unavailable: "the sandbox couldn't reach the network", vm_token_delivery_failed: "the sandbox couldn't be given access", vm_workspace_failed: "the project couldn't be copied into the sandbox",
    vm_teardown_incomplete: "the sandbox didn't shut down cleanly", job_expired: "the machine didn't pick up the update in time", job_silent: "the machine went quiet", job_overran: "the update took too long",
    engine_unsupported: "this machine can't run that version", kind_unsupported: "this machine can't run updates yet", pr_open_failed: "GitHub didn't open the pull request",
    pr_scope_refused: "the update touched files it shouldn't have", update_head_changed: "the update branch changed after it was pushed", pr_closed: "the pull request was closed without merging",
    pr_not_opened: "the pull request was never opened",
  },
  started: (to) => (to ? "Started the update to v" + to + "." : "Started the update."),
  errors: {
    forbidden: "Only an owner or admin can update the engine.", notFound: "That project isn't installed any more.", signedOut: "Your session has ended. Sign in again.", other: "That didn't send. Try again.",
    not_behind: "The engine is already up to date.", update_live: "An update is already under way.", setup_not_placed: "This project isn't on a machine.", setup_changed: "A new version came out while we got ready. Try again.",
    not_configured: "Updating isn't available right now. Try again later.",
  },
};
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/, WORD = /^[a-z][a-z0-9_]{0,63}$/, PHASES = ["push", "pr", "await_merge", "restart", "done", "failed"], STATES = ["started", "ok", "failed", "skipped"];
const STEPS = ["push", "pr", "await_merge", "restart"], OWNER_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** The closed shape of the list's `engine_update`; anything else reads as nothing to show (fail closed). */
export function readEngineUpdate(raw) {
  if (!isObj(raw)) return null;
  const b = raw.behind, u = raw.update;
  const behind = isObj(b) && VERSION.test(b.from) && VERSION.test(b.to) ? { from: b.from, to: b.to } : null;
  const update = isObj(u) && VERSION.test(u.from_version) && VERSION.test(u.to_version) && PHASES.includes(u.phase) && STATES.includes(u.state) && u.phase !== "done" ? {
    from: u.from_version, to: u.to_version, phase: u.phase, sub: typeof u.sub_step === "string" && WORD.test(u.sub_step) ? u.sub_step : "", failed: u.phase === "failed" || u.state === "failed",
    code: typeof u.failure_code === "string" && WORD.test(u.failure_code) ? u.failure_code : "", pr: Number.isInteger(u.pr) && u.pr > 0 ? u.pr : 0,
  } : null;
  return behind || update ? { behind, update } : null;
}

/** The card for the open repo, or null. `repo.operate` says whether a merged update restarts at once. The flag is the one Halt reads (`canEdit`: an owner or admin). */
export function describeEngineUpdate(st, repo) {
  const eu = repo && repo.engineUpdate;
  if (!st.settings || !eu) return null;
  const { behind, update: u } = eu, can = st.settings.canEdit === true, busy = st.op.updateBusy === true;
  const link = u && u.pr && OWNER_NAME.test(repo.name) ? { href: "https://github.com/" + repo.name + "/pull/" + u.pr, text: UPDATE_WORDS.pr(u.pr) } : null;
  let title, detail = "", step = null;
  if (u && !u.failed) {
    const n = STEPS.indexOf(u.phase) + 1;
    title = UPDATE_WORDS.running(u.from, u.to);
    step = { n, of: STEPS.length };
    detail = u.phase === "restart" ? (repo.operate ? UPDATE_WORDS.merged(u.to) : UPDATE_WORDS.mergedIdle(u.to))
      : UPDATE_WORDS.step(n, STEPS.length, UPDATE_WORDS.steps[u.phase] + (u.phase === "push" && Object.hasOwn(UPDATE_WORDS.sub, u.sub) ? " (" + UPDATE_WORDS.sub[u.sub] + ")" : ""));
  } else {
    title = behind ? UPDATE_WORDS.available(behind.from, behind.to) : UPDATE_WORDS.failedTitle(u.from, u.to);
    if (u) detail = UPDATE_WORDS.failed(u.to, Object.hasOwn(UPDATE_WORDS.why, u.code) ? UPDATE_WORDS.why[u.code] : "");
  }
  const note = st.op.updateRepo === repo.id ? st.op.updateNote : "";
  return {
    id: repo.id, title, detail, step, link, button: behind !== null, label: busy ? UPDATE_WORDS.starting : u ? UPDATE_WORDS.retry : UPDATE_WORDS.update,
    canStart: can, busy, forbidden: behind && !can ? UPDATE_WORDS.forbidden : "", note, said: u ? detail : "",
  };
}

/** Every refusal of the update route in words, chosen by the status and the closed 409 or 503 code. */
export function updateFailure(e) {
  const st = e && Number.isInteger(e.status) ? e.status : 0, W = UPDATE_WORDS.errors;
  if (st === 401) return W.signedOut;
  if (st === 403) return W.forbidden;
  if (st === 404) return W.notFound;
  if ((st === 409 || st === 503) && typeof e.code === "string" && Object.hasOwn(W, e.code) && e.code !== "forbidden" && e.code !== "notFound") return W[e.code];
  return W.other;
}

/** The card's nodes. The button is aria-disabled (not disabled) for a member and while a start is in flight, so it keeps its place in the Tab order; the click calls `start()` with no argument. */
export function updateNodes(v, start) {
  const btn = v.button ? h("button", { type: "button", class: "tm-btn", "data-testid": "tm-update-start", "data-focus": "update-start", "aria-disabled": !v.canStart || v.busy ? "true" : "false", "aria-describedby": v.forbidden ? "tm-update-why" : null, onClick: () => { if (btn.getAttribute("aria-disabled") !== "true") start(); } }, v.label) : null;
  return [
    h("p", { class: "tm-update-title", tabindex: "-1", "data-focus": "update-title", "data-testid": "tm-update-title" }, v.title),
    v.detail ? h("p", { class: "tm-update-text", "data-testid": "tm-update-text", ...(v.step ? { "data-step": String(v.step.n) } : {}) }, v.detail) : null,
    v.link ? h("p", null, h("a", { class: "tm-update-link", href: v.link.href, target: "_blank", rel: "noopener noreferrer", "data-testid": "tm-update-pr" }, v.link.text, h("span", { class: "tm-vh" }, UPDATE_WORDS.newTab))) : null,
    btn,
    v.forbidden ? h("p", { class: "tm-muted", id: "tm-update-why", "data-testid": "tm-update-why" }, v.forbidden) : null,
    v.note ? h("p", { class: "tm-halt-note", role: "note", "data-testid": "tm-update-note" }, v.note) : null,
  ];
}

// ── the next step of the open repo (D#845 ON-14c) ───────────────────────────────────────────────────────────────────────────────
// The cloud sends the facts (`machine_name`, `setup`, `session`, `quota` on the repo list); which sentence and which button show is chosen here, by closed values only. First match wins:
// the machine was removed, the engine is halted, its session is stopped, it is starting, then (a repo never heard from) its setup, then (a stale one) its runner.
const ASK = (v) => "Ask an owner or admin to " + v;
export const NEXT_WORDS = {
  move: "Move to another machine", stopped: (at) => (at ? "Stopped " + at : "The engine is stopped."),
  operateOff: (at) => (at ? "Stopped at " + at + " because operate was turned off" : "Stopped because operate was turned off"),
  idleOperateOff: ["Operate is off, so the engine isn't running on ", ""], idle: ["The engine isn't running on ", ""], starting: ["Starting the engine on ", "…"], runner: ["Start the runner on ", ""],
  fresh: (at) => "Started fresh at " + at, quota: (inw) => "Today's event limit is reached. Updates resume at 00:00 UTC (" + inw + ")",
  ask: { carry: ASK("start without the memory"), turnOn: ASK("turn on operate"), start: ASK("start the engine"), setup: ASK("set up the engine"), renew: "Ask an owner to renew the plan", move: ASK("move it") },
  phases: { survey: "surveying the project", plan: "writing the plan", install: "installing the engine", await_merge: "waiting for the install pull request", finish: "finishing the install" },
  sent: "Asked the machine to start the engine.", already: "A start is already on its way.", moved: "Moved. The engine starts on the new machine.", held: "You already have the Engine plan.", added: "Engine added. This updates when the provider confirms the change.",
  alias: { project_not_placed: "not_placed", machine_single_project: "machine_not_eligible" },
  errors: {
    signedOut: "Your session has ended. Sign in again.", other: "That didn't go through. Try again.", forbidden: "Only an owner or admin can do that.", notFound: "That repository or machine no longer exists.",
    plan_required: "The engine needs the Engine plan. Choose it in Onboarding.", engine_quantity: "Every engine on your plan is in use. Add an engine in Onboarding.", plan_ended: "The Engine plan ended. Renew it first.",
    account_held: "This account is on hold.", operate_off: "Operate is off. Turn it on first.", start_pending: "A start is already waiting for the machine.", not_placed: "This project isn't on a machine.",
    machine_not_eligible: "That machine can't take the project right now. Pick another.",
    carry_pending: "The team's memory is still being moved. Wait for it, or start without it.", no_carry: "That was already settled. Reload the page.", carry_not_failed: "The team's memory is still on its way.",
    nothing_to_retry: "The old machine can't hand the memory over again. Start without it.",
  },
  carryRetried: "Trying again. The team's memory is being brought from the old machine.", carryAbandoned: "Starting the engine on the new machine without the team's memory.",
  carryRefusals: { runner_update_needed: "Update fx-runner on both machines to bring the team's memory along.", machine_kek_unset: "The team's memory can't be carried right now. Start without it, or try again later." },
};
// D#845 MC-9b2e: the carry of a project moved with its team memory. The cloud sends the derived state and a closed failure code; the sentence is chosen here, with each machine's name in its own run.
const CARRY_STATES = ["waiting_machine", "exporting", "starting", "failed"];
const CARRY_LINES = {
  too_large: () => ["The team's memory is over 50 MB, so it can't be carried."], source_removed: (o) => [{ bdi: o }, " was removed before it handed over the team's memory."],
  expired: (o, n) => ["The team's memory expired before ", { bdi: n }, " came online."], runner_update_needed: (o) => ["Update fx-runner on ", { bdi: o }, " to bring the memory along."],
  other: (o) => ["The team's memory couldn't be brought from ", { bdi: o }, "."],
};
const NO_RETRY = ["too_large", "source_removed"];
/** The closed shape of a repo's open carry; anything else reads as no carry. */
export function readCarry(c) {
  if (!isObj(c) || !CARRY_STATES.includes(c.state)) return null;
  const name = (v, d) => (typeof v === "string" && v.trim() !== "" ? v : d), n = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  return { state: c.state, code: typeof c.failure_code === "string" && FACT_WORD.test(c.failure_code) ? c.failure_code : "", from: name(c.from_name, "the old machine"), to: name(c.to_name, "the new machine"), done: n(c.parts_done), of: n(c.parts_total) };
}
/** The sentence and the controls of a carry that is waiting, exporting or failed; null once it is sealed (the normal start progress takes over). */
function carryCard(c) {
  if (c.state === "starting") return null;
  const parts = c.state === "waiting_machine" ? ["Waiting for ", { bdi: c.from }, " to hand over the team's memory. It's offline; the project starts on ", { bdi: c.to }, " once ", { bdi: c.from }, " is back."]
    : c.state === "exporting" ? ["Bringing the team's memory from ", { bdi: c.from }, c.of ? " (part " + Math.min((c.done || 0) + 1, c.of) + " of " + c.of + ")." : "."]
      : (CARRY_LINES[c.code] || CARRY_LINES.other)(c.from, c.to);
  const acts = c.state === "exporting" ? [] : [...(c.state === "failed" && !NO_RETRY.includes(c.code) ? [{ id: "carry-retry", label: "Try again" }] : []), { id: "carry-abandon", label: "Start without the memory" }];
  return { parts, acts, note: acts.length ? [{ bdi: c.from }, "'s copy of the project is deleted once ", { bdi: c.to }, " is running."] : null };
}
const FACT_STATES = ["never", "starting", "running", "stale", "stopped", "halted", "runner_removed"], FACT_MODES = ["created", "resumed", "fresh"], FACT_QUOTA = ["ok", "session_full", "repo_full"];
const FACT_REASONS = ["person", "halt", "move", "remove", "operate_off", "plan"], FACT_SETUP = ["none", "open", "done"], FACT_WORD = /^[a-z][a-z0-9_]{0,63}$/;
/** The closed shape of a repo's session facts; a list without them (an older server) reads as null and shows no next step (fail closed). */
export function readFacts(r) {
  if (!isObj(r)) return null;
  const se = r.session, qu = r.quota, su = r.setup;
  const session = isObj(se) && FACT_STATES.includes(se.state) ? {
    state: se.state, mode: FACT_MODES.includes(se.last_start_mode) ? se.last_start_mode : "", startAt: typeof se.last_start_at === "string" ? se.last_start_at : "",
    reason: FACT_REASONS.includes(se.stopped_reason) ? se.stopped_reason : "", at: typeof se.state_at === "string" ? se.state_at : "",
  } : null;
  const quota = isObj(qu) && FACT_QUOTA.includes(qu.state) && stamp(qu.resets_at) !== null ? { state: qu.state, resetsAt: qu.resets_at } : null;
  const setup = isObj(su) && FACT_SETUP.includes(su.status) ? { status: su.status, phase: typeof su.phase === "string" && FACT_WORD.test(su.phase) ? su.phase : "", failed: su.state === "failed" } : { status: "none", phase: "", failed: false };
  return session || quota ? { machine: typeof r.machine_name === "string" ? r.machine_name : "", setup, session, quota } : null;
}
const clock = (iso) => { const t = stamp(iso); if (t === null) return ""; const d = new Date(t), p = (n) => String(n).padStart(2, "0"); return p(d.getHours()) + ":" + p(d.getMinutes()); };
/** Under a minute "in under a minute", under an hour "in N min", else "in N h"; each rounded up. */
export function untilWords(iso, nowMs) {
  const left = (stamp(iso) ?? nowMs) - nowMs;
  if (left < 60000) return "in under a minute";
  return left < 3600000 ? "in " + Math.ceil(left / 60000) + " min" : "in " + Math.ceil(left / 3600000) + " h";
}
/** The chip's own word while the session is stopped or starting: never "Live" or "Stale" for an engine that is not running. */
export const sessionChip = (repo) => {
  const s = repo && repo.facts ? repo.facts.session : null;
  if (!s) return "";
  if (s.at !== "" && repo.operate !== true && (s.state === "running" || s.state === "stale" || s.state === "starting")) return "Operate off"; // a cloud session with operate off is winding down: never Live or Stale
  return s.state === "stopped" ? "Stopped" : s.state === "starting" ? "Starting" : "";
};

/** The next-step card of the open repo, or null. `parts` is the sentence with a machine name in its own run ({bdi}); `action` is {id, label} or null; a member gets the sentence and the line that says who can act. */
const NO_FACTS = { machine: "", setup: { status: "none", phase: "", failed: false }, session: null, quota: null };
export function describeNext(st, repo, nowMs) {
  const carry = repo && repo.carry ? carryCard(repo.carry) : null;
  const f = repo && (repo.facts || (carry ? NO_FACTS : null));
  if (!st.settings || !f) return null;
  const can = st.settings.canEdit === true, W = NEXT_WORDS, m = f.machine, s = f.session;
  const named = (pair) => (m ? [pair[0], { bdi: m }, pair[1]] : null);
  let parts = null, action = null, ask = "";
  const owner = st.fleet && st.fleet.role === "owner"; // the checkout route takes an owner only; the role is read from the machines list
  const act = (id, label, askKey) => { if (id === "renew" ? can && owner : can) action = { id, label }; else ask = W.ask[askKey]; };
  // Operate is off while a cloud session (a listed sandbox) is still up or stopped: the engine is being or has been stopped, so a start or a runner start would only be refused (409 operate_off).
  const winding = s && s.at !== "" && repo.operate !== true && s.state !== "never" && !(s.state === "stopped" && s.reason === "plan");
  let acts = [];
  if (carry) {
    parts = carry.parts;
    if (can) acts = carry.acts; else if (carry.acts.length) ask = W.ask.carry;
  } else if (winding) {
    if (s.state === "stale") parts = m ? ["Stopping when ", { bdi: m }, " comes back"] : ["Stopping when the machine comes back"];
    else if (s.state === "stopped" && s.reason === "operate_off") { parts = [W.operateOff(clock(s.at))]; act("operate", "Turn on operate", "turnOn"); }
    else if (s.state === "runner_removed") { parts = ["Its machine was removed, and operate is off"]; act("operate", "Turn on operate", "turnOn"); }
    else { parts = named(W.idleOperateOff) || ["Operate is off, so the engine isn't running"]; act("operate", "Turn on operate", "turnOn"); }
  } else if (s) {
    if (s.state === "runner_removed") { parts = ["Its machine was removed"]; act("move", W.move, "move"); }
    else if (s.state === "halted") { parts = [s.at ? W.stopped(clock(s.at)) : "The engine is halted."]; act("start", "Start engine", "start"); }
    else if (s.state === "stopped") {
      if (s.reason === "operate_off") { parts = [W.operateOff(clock(s.at))]; act("operate", "Turn on operate", "turnOn"); }
      else if (s.reason === "plan") { parts = ["Plan ended: the engine is stopped"]; act("renew", "Renew", "renew"); }
      else { parts = [W.stopped(clock(s.at))]; if (s.reason !== "remove") act("start", "Start engine", "start"); }
    } else if (s.state === "starting") parts = named(W.starting) || ["Starting the engine…"];
    else if (s.state === "never" && f.setup.status === "open") { parts = ["Setting up: " + (Object.hasOwn(W.phases, f.setup.phase) ? W.phases[f.setup.phase] : "the install") + (f.setup.failed ? " (it stopped; open Onboarding to try again)" : "")]; action = { id: "onboarding", label: "Open Onboarding" }; }
    else if (s.state === "never" && f.setup.status === "none") { parts = ["This repo isn't set up on a machine yet"]; act("setup", "Set up the engine", "setup"); }
    else if (s.state === "never" && f.setup.status === "done") {
      if (repo.operate) { parts = named(W.idle) || ["The engine isn't running"]; act("start", "Start engine", "start"); } else { parts = named(W.idleOperateOff) || ["Operate is off, so the engine isn't running"]; act("operate", "Turn on operate", "turnOn"); }
    } else if (s.state === "stale") { parts = named(W.runner) || ["Start the runner on your machine"]; action = { id: "machines", label: "Open Machines" }; }
  }
  const fresh = s && s.state === "running" && s.mode === "fresh" && clock(s.startAt) ? W.fresh(clock(s.startAt)) : "";
  const quota = f.quota && f.quota.state !== "ok" ? W.quota(untilWords(f.quota.resetsAt, nowMs)) : "";
  if (!parts && !fresh && !quota) return null;
  const carryNote = carry && acts.length ? carry.note : null;
  const mine = st.op.nextRepo === repo.id;
  const move = mine ? st.op.move : null;
  return {
    id: repo.id, parts: parts || [], text: parts ? parts.map((p) => (typeof p === "string" ? p : p.bdi)).join("") : "", action: move ? null : action, acts, carryNote, ask, fresh, quota,
    busy: st.op.nextBusy === true, note: mine ? st.op.nextNote : "", move,
  };
}
/** Every refusal of Start engine, Renew and Move in words, chosen by the status and the closed code; never the server's text. */
export function nextFailure(e) {
  if (isRateLimited(e)) return retryWords(waitSeconds(e));
  const st = e && Number.isInteger(e.status) ? e.status : 0, W = NEXT_WORDS.errors;
  const code = e && typeof e.code === "string" ? NEXT_WORDS.alias[e.code] || e.code : "";
  if (code === "state_carry_unavailable") return Object.hasOwn(NEXT_WORDS.carryRefusals, e.reason) ? NEXT_WORDS.carryRefusals[e.reason] : W.other;
  return st === 401 ? W.signedOut : st === 403 ? W.forbidden : st === 404 ? W.notFound : Object.hasOwn(W, code) && !["forbidden", "notFound", "signedOut", "other"].includes(code) ? W[code] : W.other;
}
/** The card's nodes. A button is aria-disabled (not disabled) while a call is out, so it keeps its place in the Tab order; a click calls `go(id)`, and the move picker calls `mv.pick(id)`, `mv.go()` and `mv.cancel()`. */
export function nextNodes(v, go, mv) {
  const btn = v.action ? h("button", { type: "button", class: "tm-btn", "data-testid": "tm-next-" + v.action.id, "data-focus": "next-" + v.action.id, "aria-disabled": v.busy ? "true" : "false", onClick: () => { if (btn.getAttribute("aria-disabled") !== "true") go(v.action.id); } }, v.action.label) : null;
  const mvs = v.move, none = mvs && (mvs.loading || mvs.choices.length === 0);
  const picker = mvs ? h("div", { class: "tm-move", role: "group", "aria-label": NEXT_WORDS.move, "data-testid": "tm-move" },
    none ? h("p", { class: "tm-muted", "data-testid": "tm-move-note" }, mvs.loading ? "Looking for machines…" : "No other machine is online to move it to.")
      : h("select", { class: "tm-select", "aria-label": "Machine to move it to", "data-testid": "tm-move-pick", "data-focus": "next-move-pick", onChange: (e) => mv.pick(e.target.value) }, mvs.choices.map((c) => h("option", { value: c.id, selected: c.id === mvs.pick }, c.name))),
    none ? null : h("button", { type: "button", class: "tm-btn", "data-testid": "tm-move-go", "data-focus": "next-move-go", "aria-disabled": v.busy ? "true" : "false", onClick: () => { if (!v.busy) mv.go(); } }, "Move"),
    h("button", { type: "button", class: "tm-btn", "data-testid": "tm-move-cancel", "data-focus": "next-move-cancel", onClick: () => mv.cancel() }, "Cancel")) : null;
  const words = (parts) => parts.map((p) => (typeof p === "string" ? p : h("bdi", null, p.bdi)));
  const acts = v.acts.map((a) => {
    const b = h("button", { type: "button", class: "tm-btn", "data-testid": "tm-next-" + a.id, "data-focus": "next-" + a.id, "aria-disabled": v.busy ? "true" : "false", onClick: () => { if (b.getAttribute("aria-disabled") !== "true") go(a.id); } }, a.label);
    return b;
  });
  return [
    v.parts.length ? h("p", { class: "tm-next-text", "data-testid": "tm-next-text" }, words(v.parts)) : null,
    btn, ...acts, v.carryNote ? h("p", { class: "tm-muted", "data-testid": "tm-carry-note" }, words(v.carryNote)) : null, picker,
    v.ask ? h("p", { class: "tm-muted", "data-testid": "tm-next-ask" }, v.ask) : null,
    v.fresh ? h("p", { class: "tm-next-text", "data-testid": "tm-fresh" }, v.fresh) : null,
    v.quota ? h("p", { class: "tm-next-text", "data-testid": "tm-quota" }, v.quota) : null,
    v.note ? h("p", { class: "tm-halt-note", role: "note", "data-testid": "tm-next-note" }, v.note) : null,
  ];
}

export const NO_OP = { commands: null, commandsAt: "", commandsFailed: false, dials: null, dialsAt: "", dialsFailed: false, saving: false, notice: "", confirmStop: null, confirmHalt: null, haltNote: "", stopBusy: false, stopNote: "", updateBusy: false, updateNote: "", updateRepo: "", nextBusy: false, nextNote: "", nextRepo: "", move: null };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const stamp = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DISCUSSION = /^[1-9][0-9]{0,8}$/;
export const isAgentId = (v) => typeof v === "string" && AGENT_ID.test(v);
/** An agent named in words a person can tell apart: its role in plain words (never the wire enum), its Discussion and a short id. */
export function agentWords(a) {
  const role = a && Object.hasOwn(ROLES, a.role) ? ROLES[a.role].toLowerCase() + " agent" : "agent";
  const d = a && Number.isInteger(a.discussion) && a.discussion >= 1 ? " on D#" + a.discussion : "";
  const id = a && isAgentId(a.stopId) ? " (id " + a.stopId.slice(0, 6) + ")" : "";
  return "the " + role + d + id;
}

// ── readers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The command list. A reply without the list is a failed read (null), never an empty one. */
export function readCommands(raw) {
  if (!isObj(raw) || !Array.isArray(raw.commands)) return null;
  return raw.commands.filter((c) => isObj(c) && typeof c.id === "string" && c.id !== "" && Object.hasOwn(KIND_WORD, c.kind) && Object.hasOwn(STATE_WORD, c.state)).map((c) => ({
    id: c.id, kind: c.kind, args: isObj(c.args) ? c.args : {}, state: c.state, refusal: typeof c.refusal === "string" ? c.refusal : "", ackedAt: typeof c.acked_at === "string" ? c.acked_at : "", expiresAt: typeof c.expires_at === "string" ? c.expires_at : "",
  }));
}
/** The decision dials of the repo, narrowed to the engine's three. */
export function readDials(raw) {
  if (!isObj(raw) || !Array.isArray(raw.dials)) return null;
  const rows = [];
  for (const type of ENGINE_DIALS) {
    const d = raw.dials.find((x) => isObj(x) && x.decision_type === type);
    if (!d || !Object.hasOwn(DISPOSITION_TEXT, d.disposition)) continue;
    const allowed = Array.isArray(d.allowed_dispositions) ? d.allowed_dispositions.filter((v) => Object.hasOwn(DISPOSITION_TEXT, v)) : [];
    rows.push({ type, label: typeof d.label === "string" && d.label !== "" ? d.label : DIAL_NAME[type], value: d.disposition, options: allowed.map((v) => ({ value: v, label: DISPOSITION_TEXT[v] })), adjustable: d.adjustable !== false && allowed.length > 0 });
  }
  return rows;
}

// ── what the page draws ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** Why every control is locked, or "". A halt being applied first (it is what the owner just did), then watch, then operate (the account's switch and the repo's), then a halt. */
export function lockReason(settings, repo) {
  if (repo && repo.haltPending) return OP_WORDS.haltPending;
  if (!settings.watch) return OP_WORDS.watchOff;
  if (!repo) return OP_WORDS.noRepo;
  if (!settings.operate || !repo.operate) return OP_WORDS.operateOff;
  if (repo.halted) return OP_WORDS.halted;
  return "";
}
const argText = (c, agentName) => {
  const a = c.args;
  if (c.kind === "request_spawn") return "Request " + (Object.hasOwn(ROLES, a.role) ? "a " + ROLES[a.role].toLowerCase() : "an agent") + (Number.isInteger(a.discussion) && a.discussion >= 1 ? " for D#" + a.discussion : "");
  if (c.kind === "stop_agent") return "Stop " + (isAgentId(a.agent_id) ? agentName(a.agent_id) : OP_WORDS.unknownAgent);
  if (c.kind === "set_dial") return "Set " + (Object.hasOwn(DIAL_CLASSES, a.dial_class) ? DIAL_CLASSES[a.dial_class].toLowerCase() : "a dial") + (Number.isInteger(a.level) ? " to level " + a.level : "") + (Object.hasOwn(TTL, a.ttl) ? " (" + TTL[a.ttl].toLowerCase() + ")" : "");
  if (c.kind === "answer_ask") return "Answer an ask" + (["approve", "decline", "defer"].includes(a.choice) ? ": " + a.choice : "");
  return KIND_WORD[c.kind];
};
/** One command row: its sentence, its state word and the detail (a refusal in words), and whether it can still be cancelled. */
export function commandRow(c, nowMs, agentName) {
  const exp = stamp(c.expiresAt);
  let state = c.state;
  if (state === "applied" && c.ackedAt === "") state = "delivered"; // applied is the runner's own report: no report, no "Applied"
  if (state === "pending" && exp !== null && exp <= nowMs) state = "expired";
  const detail = state === "refused" ? (Object.hasOwn(REFUSALS, c.refusal) ? REFUSALS[c.refusal] : "The runner refused it.") : STATE_DETAIL[state];
  return { id: c.id, text: argText(c, agentName), state, word: STATE_WORD[state], detail, cancel: state === "pending" };
}
const pendingStops = (commands) => new Set((commands || []).filter((c) => c.kind === "stop_agent" && (c.state === "pending" || c.state === "delivered") && isAgentId(c.args.agent_id)).map((c) => c.args.agent_id));

/** Everything the operate panel draws. `asOf(iso)` is the app's one "as of HH:MM (N min ago)" wording. */
export function describeOperate(st, nowMs, repo, asOf, agentRows) {
  const s = st.settings;
  if (!s || !s.canEdit) return { show: false }; // a member sees no controls at all
  const op = st.op;
  const reason = lockReason(s, repo);
  const removed = !!repo && repo.liveness === "runner_removed";
  const names = new Map((agentRows || []).map((a) => [a.stopId, ROLES[a.role] ? "the " + ROLES[a.role].toLowerCase() + " agent" : "the agent"]));
  const agentName = (id) => names.get(id) || OP_WORDS.unknownAgent;
  const live = !!repo && !removed && s.watch;
  const list = (items, at, failed, empty, rows) => ({ asOf: at ? asOf(at) : OP_WORDS.noData, failed, empty, rows: items ? rows(items) : [] });
  return {
    show: true, reason, removed: removed ? OP_WORDS.removed : "", offline: live && repo.liveness !== "live" ? OP_WORDS.offline : "", saving: op.saving, notice: op.notice,
    sw: { on: s.operate, enabled: s.watch && !op.saving, why: s.watch ? "" : OP_WORDS.watchFirst },
    // The question closes with its agent: once the agent is no longer a running one with a Stop control, there is nothing left to confirm.
    confirm: op.confirmStop && (!agentRows || agentRows.some((a) => a.stopId === op.confirmStop.id && a.stop))
      ? { id: op.confirmStop.id, title: OP_WORDS.stopTitle, who: agentWords((agentRows || []).find((a) => a.stopId === op.confirmStop.id)), text: OP_WORDS.stopText } : null,
    commands: live && !removed ? list(op.commands, op.commandsAt, op.commandsFailed,OP_WORDS.noCommands, (items) => items.map((c) => commandRow(c, nowMs, agentName))) : null,
    dials: live && !removed ? list(op.dials, op.dialsAt, op.dialsFailed, OP_WORDS.noDials, (items) => items) : null,
  };
}
/** The Stop control of one agent row: null when there is none to show, else whether a stop is already on its way. */
export function stopOf(st, agentId) {
  if (!st.settings || !st.settings.canEdit || !st.settings.watch || !isAgentId(agentId)) return null;
  const repo = st.repos.find((r) => r.id === st.selectedId);
  if (!repo || repo.liveness === "runner_removed") return null;
  return { pending: pendingStops(st.op.commands).has(agentId) };
}

/** The halt of the open repo, for everyone (a member sees the state and no controls). `confirm` is null unless the question still fits the state. */
/** "14:05", or "11-17 14:05" when it was not today, in the person's own time; "" for a value that is not a time. */
function haltTime(iso, nowMs) {
  const t = stamp(iso);
  if (t === null) return "";
  const d = new Date(t), p = (n) => String(n).padStart(2, "0");
  const day = nowMs !== undefined && d.toDateString() !== new Date(nowMs).toDateString() ? p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " : "";
  return day + p(d.getHours()) + ":" + p(d.getMinutes());
}
/** "Halted by <name> at <time>": the name in its own isolated run (parts), the same sentence as plain text. Null when there is no time to say. */
function haltedBy(repo, nowMs) {
  const at = repo.halted ? haltTime(repo.haltedAt, nowMs) : "";
  if (at === "") return null;
  return repo.haltedBy !== ""
    ? { parts: [HALT_WORDS.byLead, { bdi: repo.haltedBy }, " " + HALT_WORDS.atWord + " " + at], text: HALT_WORDS.byLead + repo.haltedBy + " " + HALT_WORDS.atWord + " " + at }
    : { parts: [HALT_WORDS.haltedAt + " " + at], text: HALT_WORDS.haltedAt + " " + at };
}
export function describeHalt(st, repo, nowMs) {
  const s = st.settings;
  if (!s || !repo) return null;
  const state = repo.halted ? (repo.haltPending ? "pending" : "halted") : repo.haltPending ? "pending" : "none";
  const can = s.canEdit && s.watch;
  const busy = !!st.op.saving || !!st.saving;
  const kind = st.op.confirmHalt;
  const fits = (kind === "halt" && state === "none") || (kind === "clear" && state !== "none");
  const parts = [HALT_WORDS.haltLead, repo.runner !== "" ? { bdi: repo.runner } : HALT_WORDS.yourMachine, HALT_WORDS.haltTail];
  const confirm = can && fits ? (kind === "halt"
    ? { kind, title: HALT_WORDS.askHaltTitle, parts, texts: [HALT_WORDS.haltRisk], yes: HALT_WORDS.yesHalt }
    : { kind, title: HALT_WORDS.askClearTitle, parts: [HALT_WORDS.clearText], texts: [HALT_WORDS.clearLocal], yes: HALT_WORDS.yesClear }) : null;
  return {
    id: repo.id, by: haltedBy(repo, nowMs), state, chip: state === "pending" ? HALT_WORDS.chipPending : state === "halted" ? HALT_WORDS.chipHalted : "",
    text: state === "pending" ? HALT_WORDS.pending : state === "halted" ? HALT_WORDS.halted : can ? HALT_WORDS.noneOwner : HALT_WORDS.none,
    canHalt: can && state === "none", canClear: can && state !== "none", locked: busy, why: busy ? HALT_WORDS.busy : "", note: can ? st.op.haltNote : "", confirm, stale: !!kind && !confirm,
  };
}

// ── sentences for a refusal ─────────────────────────────────────────────────────────────────────────────────────────────────
export function sendFailure(e) {
  if (isRateLimited(e)) return retryWords(waitSeconds(e));
  if (e && e.status === 403) return OP_WORDS.forbidden;
  if (e && e.status === 404) return OP_WORDS.gone;
  if (e && e.status === 409 && typeof e.code === "string" && Object.hasOwn(SEND_409, e.code)) return SEND_409[e.code];
  return OP_WORDS.sendFailed;
}
/** Every refusal of a halt or a clear in words: the 4xx the routes give, a limit on how often it may be asked, and the answers that leave it unknown whether it happened. */
export function haltFailure(e, clearing) {
  if (isRateLimited(e)) return retryWords(waitSeconds(e));
  const st = e && Number.isInteger(e.status) ? e.status : 0;
  if (st === 401) return HALT_WORDS.signedOut;
  if (st === 403) return clearing ? HALT_WORDS.clearForbidden : HALT_WORDS.haltForbidden;
  if (st === 404) return HALT_WORDS.gone;
  if (st >= 400 && st < 500) return clearing ? HALT_WORDS.clearRefused : HALT_WORDS.haltRefused;
  return clearing ? HALT_WORDS.clearUnknown : HALT_WORDS.haltUnknown;
}
export function cancelFailure(e) {
  if (e && e.status === 409 && typeof e.code === "string" && Object.hasOwn(CANCEL_409, e.code)) return CANCEL_409[e.code];
  return sendFailure(e);
}
export function dialFailure(e) {
  if (isRateLimited(e)) return retryWords(waitSeconds(e));
  if (e && e.status === 403) return OP_WORDS.dialForbidden;
  if (e && e.status === 422) return OP_WORDS.dialRefused;
  if (e && e.status === 409 && e.code === "dial_changed") return OP_WORDS.dialChanged;
  return OP_WORDS.dialFailed;
}

// ── the controller half ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** `get()` is the Team state, `set(patch)` changes it, `refresh()` reads everything again, `aborted(e)` is true for a closed window. */
export function createOperate({ client, signal, get, set, refresh, aborted, assign = (u) => window.location.assign(u) }) {
  const patch = (p) => set({ op: { ...get().op, ...p } });
  const locked = () => {
    const st = get();
    const repo = st.repos.find((r) => r.id === st.selectedId);
    return !st.settings || !st.settings.canEdit || st.op.saving || st.saving || lockReason(st.settings, repo) !== "";
  };
  // Cancelling a pending command only removes an action, so it stays allowed while operate is off or the repo is halted (a halt is exactly when a person
  // wants to take back what is waiting). Only watch off, no repo, a save in flight and a member lock it.
  const cancelLocked = () => {
    const st = get();
    const repo = st.repos.find((r) => r.id === st.selectedId);
    return !st.settings || !st.settings.canEdit || st.op.saving || st.saving || !st.settings.watch || !repo;
  };
  async function run(call, ok, failure, { isLocked = locked, refreshOn409 = false, refreshOnFail = false, note = "notice" } = {}) {
    if (isLocked()) return false;
    patch({ saving: true, notice: "", haltNote: "", confirmStop: null, confirmHalt: null });
    try { await call(get().selectedId); } catch (e) {
      if (!aborted(e)) {
        patch({ saving: false, [note]: failure(e) });
        if (refreshOnFail || (refreshOn409 && e && e.status === 409)) await refresh(); // the list was out of date, or the answer was lost: show what is true now
      }
      return false;
    }
    patch({ saving: false, [note]: ok });
    await refresh();
    return true;
  }
  // A halt is allowed while operate is off or the repo is already halted (that is what it is for); watch off, no repo, a member and a save in flight lock it.
  // A halt needs a repo that is not halted, and a clear one that is.
  const haltable = (clearing) => {
    const st = get();
    const repo = st.repos.find((r) => r.id === st.selectedId);
    if (!st.settings || !st.settings.canEdit || !st.settings.watch || !repo || st.op.saving || st.saving) return false;
    return clearing === (repo.halted || repo.haltPending);
  };
  const send = (kind, args) => run((id) => client.issue(id, kind, args, signal), OP_WORDS.sent, sendFailure);
  const api = {
    async read(repoId, stale) {
      const [c, d] = await Promise.allSettled([client.commands(repoId, signal), client.dials(repoId, signal)]);
      if (stale()) return;
      const commands = c.status === "fulfilled" ? readCommands(c.value) : null;
      const dials = d.status === "fulfilled" ? readDials(d.value) : null;
      const now = new Date().toISOString();
      const cur = get().op;
      patch({ commands: commands || cur.commands, commandsAt: commands ? now : cur.commandsAt, commandsFailed: !commands, dials: dials || cur.dials, dialsAt: dials ? now : cur.dialsAt, dialsFailed: !dials });
    },
    startDay: () => send("start_day", {}),
    pause: () => send("pause_loop", {}),
    resume: () => send("resume_loop", {}),
    requestSpawn(role, discussion) {
      if (locked()) return Promise.resolve(false);
      if (!Object.hasOwn(ROLES, role) || !DISCUSSION.test(String(discussion).trim())) { patch({ notice: "" }); patch({ notice: OP_WORDS.badSpawn }); return Promise.resolve(false); }
      return send("request_spawn", { role, discussion: Number(String(discussion).trim()) });
    },
    setDialLevel(dialClass, level, ttl) {
      if (locked()) return Promise.resolve(false);
      const n = Number(level);
      if (!Object.hasOwn(DIAL_CLASSES, dialClass) || !Number.isInteger(n) || n < 1 || n > 5 || !Object.hasOwn(TTL, ttl)) { patch({ notice: "" }); patch({ notice: OP_WORDS.badDial }); return Promise.resolve(false); }
      return send("set_dial", { dial_class: dialClass, level: n, ttl });
    },
    askStop(id) { if (isAgentId(id) && !locked()) patch({ confirmStop: { id }, confirmHalt: null }); },
    cancelStop: () => patch({ confirmStop: null }),
    askHalt(kind) { if ((kind === "halt" || kind === "clear") && haltable(kind === "clear")) patch({ confirmHalt: kind, confirmStop: null, haltNote: "" }); },
    cancelHalt: () => patch({ confirmHalt: null }),
    halt: () => run((id) => client.halt(id, signal), "", (e) => haltFailure(e, false), { isLocked: () => !haltable(false), refreshOnFail: true, note: "haltNote" }),
    clearHalt: () => run((id) => client.clearHalt(id, signal), "", (e) => haltFailure(e, true), { isLocked: () => !haltable(true), refreshOnFail: true, note: "haltNote" }),
    async retryStop() {
      const st = get();
      const repo = st.repos.find((r) => r.id === st.selectedId);
      if (!st.settings || st.settings.canEdit !== true || !repo || !repo.stopFailed || !stopAskable(repo.stopFailed) || st.op.stopBusy) return false;
      patch({ stopBusy: true, stopNote: "" });
      let r;
      try { r = await client.retryStop(repo.id, signal); } catch (e) {
        if (aborted(e)) return false;
        patch({ stopBusy: false, stopNote: stopFailure(e) });
        if (e && (e.status === 404 || e.status === 409)) await refresh(); // what was shown is out of date: show what is true now
        return false;
      }
      patch({ stopBusy: false, stopNote: r && r.queued === true ? STOP_WORDS.queued : r && r.already_issued === true ? STOP_WORDS.already : STOP_WORDS.sent });
      await refresh();
      return true;
    },
    // The next-step card's buttons (D#845 ON-14c): each is one existing route, called only by an owner or admin, and says its answer in fixed words.
    async nextCall(call, ok, fail = nextFailure) {
      const st = get();
      const repo = st.repos.find((r) => r.id === st.selectedId);
      if (!st.settings || st.settings.canEdit !== true || !repo || st.op.nextBusy) return false;
      patch({ nextBusy: true, nextNote: "", nextRepo: repo.id });
      let r;
      try { r = await call(repo); } catch (e) {
        if (aborted(e)) return false;
        patch({ nextBusy: false, nextNote: fail(e) });
        if (e && (e.status === 404 || e.status === 409 || e.status === 402)) await refresh(); // what was shown is out of date: show what is true now
        return false;
      }
      patch({ nextBusy: false, nextNote: ok(r), move: null });
      await refresh();
      return true;
    },
    startEngine() { return api.nextCall((repo) => client.startEngine(repo.id, signal), (r) => (r && r.already_issued === true ? NEXT_WORDS.already : NEXT_WORDS.sent)); },
    /** Renew goes to the same checkout route Onboarding's Renew uses: the answer is an item added to the held subscription, or the provider's own page (https only). */
    renew() {
      let url = "";
      return api.nextCall(() => client.checkout(signal), (r) => {
        if (r && r.already_held === true) return NEXT_WORDS.held;
        if (r && r.added === true) return NEXT_WORDS.added;
        if (r && typeof r.url === "string" && r.url.startsWith("https://")) { url = r.url; return ""; }
        return NEXT_WORDS.errors.other;
      }, (e) => (e && e.status === 403 ? "Only an owner can renew the plan." : nextFailure(e))).then((ok) => { if (ok && url) assign(url); return ok; });
    },
    /** Turn on operate from the card: says why when it cannot (engine watch is off, or a save is out), instead of doing nothing. */
    turnOnOperate() {
      const st = get();
      const repo = st.repos.find((r) => r.id === st.selectedId);
      if (!st.settings || st.settings.canEdit !== true || !repo) return Promise.resolve(false);
      if (!st.settings.watch) { patch({ nextRepo: repo.id, nextNote: OP_WORDS.watchFirst }); return Promise.resolve(false); }
      if (st.op.saving || st.saving) { patch({ nextRepo: repo.id, nextNote: "A change is being saved. Try again in a moment." }); return Promise.resolve(false); }
      patch({ nextNote: "" });
      return api.setOperate(true);
    },
    async askMove() {
      const st = get();
      const repo = st.repos.find((r) => r.id === st.selectedId);
      if (!st.settings || st.settings.canEdit !== true || !repo || st.op.nextBusy) return false;
      patch({ nextRepo: repo.id, nextNote: "", move: { loading: true, choices: [], pick: "" } });
      let fleet = null;
      try { fleet = readFleet(await client.runners(signal)); } catch (e) { if (aborted(e)) return false; } // fx-swallow-ok: an unreadable list shows "no other machine", and the card still has its way back
      if (get().op.move === null || get().selectedId !== repo.id) return false;
      const choices = fleet ? fleet.runners.filter((r) => r.state === "online_idle" || r.state === "busy").map((r) => ({ id: r.id, name: r.name })) : [];
      patch({ move: { loading: false, choices, pick: choices.length ? choices[0].id : "" } });
      return true;
    },
    retryCarry() { return api.nextCall((repo) => client.retryCarry(repo.id, signal), () => NEXT_WORDS.carryRetried); },
    abandonCarry() { return api.nextCall((repo) => client.abandonCarry(repo.id, signal), () => NEXT_WORDS.carryAbandoned); },
    pickMove(id) { const mv = get().op.move; if (mv && mv.choices.some((c) => c.id === id)) patch({ move: { ...mv, pick: id } }); },
    cancelMove() { patch({ move: null }); },
    moveNow() {
      const mv = get().op.move;
      return mv && mv.pick ? api.nextCall((repo) => client.moveProject(repo.id, mv.pick, signal), () => NEXT_WORDS.moved) : Promise.resolve(false);
    },
    async startUpdate() {
      const st = get();
      const repo = st.repos.find((r) => r.id === st.selectedId);
      if (!st.settings || st.settings.canEdit !== true || !repo || !repo.engineUpdate || !repo.engineUpdate.behind || st.op.updateBusy) return false;
      patch({ updateBusy: true, updateNote: "", updateRepo: repo.id });
      let r;
      try { r = await client.startUpdate(repo.id, signal); } catch (e) {
        if (aborted(e)) return false;
        patch({ updateBusy: false, updateNote: updateFailure(e) });
        if (e && (e.status === 404 || e.status === 409)) await refresh(); // what was shown is out of date: show what is true now
        return false;
      }
      patch({ updateBusy: false, updateNote: UPDATE_WORDS.started(r && VERSION.test(r.to_version) ? r.to_version : "") });
      await refresh();
      return true;
    },
    stop(id) { return isAgentId(id) ? send("stop_agent", { agent_id: id }) : Promise.resolve(false); },
    cancel: (id) => run(() => client.cancel(id, signal), OP_WORDS.cancelled, cancelFailure, { isLocked: cancelLocked, refreshOn409: true }),
    saveDial: (type, value) => (ENGINE_DIALS.includes(type) && Object.hasOwn(DISPOSITION_TEXT, value) ? run((rid) => client.setDial(rid, type, value, signal), OP_WORDS.dialSaved, dialFailure) : Promise.resolve(false)),
    setOperate(on) {
      const st = get();
      if (!st.settings || !st.settings.canEdit || !st.settings.watch || st.op.saving || st.saving) return Promise.resolve(false);
      // The choice stays on screen while the save is out (draft); a failure drops it, a success makes it the shown value until the read that follows.
      set({ draft: { repos: {}, operate: on === true }, op: { ...st.op, saving: true, notice: "", confirmStop: null, confirmHalt: null } });
      return client.saveSettings({ operate_enabled: on === true }, signal).then(
        () => { set({ draft: null, settings: { ...get().settings, operate: on === true }, op: { ...get().op, saving: false, notice: OP_WORDS.operateSaved } }); return refresh(); },
        (e) => { if (!aborted(e)) set({ draft: null, op: { ...get().op, saving: false, notice: e && e.status === 403 ? OP_WORDS.forbidden : OP_WORDS.sendFailed } }); },
      );
    },
  };
  return api;
}
