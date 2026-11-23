// Which runner the Team app's watch switch means, and how to connect one (pure functions, no page, no clock but the one passed in), and, further down, the live view of a repo.
//
// What the cloud can tell: the account's runners (GET /api/runners: name, state, last seen) and, per repo, the runner whose bridge last reported for it
// (settings repos[].bridged_runner_id). It cannot see the setup file on the computer, and a bridge can only report once the watch is on and the repo is
// ticked, so "not set up" below means "no runner has reported for the bridge yet", and the words say that. The command is complete as shown: the repo name
// is filled in and nothing is left to edit. The runner finds its own checkout and state folder from `--repo` alone. A folder the runner itself discovered
// may be added (`commandFor`'s second argument), but nothing reports one yet, so no caller passes it.
import { isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";
import { agoText, stateParts } from "../runners/runners-fleet.js";
import { HEALTHY_MS, apiFetch, backoffDelay, openStream } from "../../core/cloud-live.js";

export const RUNNER_WORDS = {
  watchOn: "Watch the engine team on ",
  watchAny: "Watch the engine team on your runner",
  pick: "Runner",
  unknown: "The runner list isn't available right now.",
  noRunners: "No runners yet. Use Add a runner to register your first machine.",
  openRunners: "Open Machines",
  connectTitle: "Connect a runner",
  setUpFor: "Bridge has reported for ",
  notSetUpFor: "No report from this runner's bridge for ",
  yet: " yet",
  soon: "Coming soon: set this up from here.",
  noneBridged: "No runner's bridge has reported yet. Run this on the computer that runs your engine, then turn the switch on:",
  fillIn: "Run this on that computer, then turn the switch on.",
  noRepoName: "This repository has no owner/name yet, so there is no command to show.",
  never: "never seen",
  copy: "Copy command", copied: "Copied", copyFailed: "Couldn't copy. Select the command and copy it by hand.",
  unnamed: "This runner has no name yet. You can name it in Machines.", rename: "Name it in Machines",
};
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/; // a name that is not owner/name (an unnamed repository) gives no command at all
/** One shell word: bare when plain, else single-quoted with each ' written as '\'' . */
export const shellQuote = (s) => (/^[A-Za-z0-9/._+:@-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'");
/** The command for the runner's computer, or "" when the repo has no owner/name. `root` is a folder the runner itself found; it is added only as an absolute path. */
export const commandFor = (repoName, root = "") => {
  if (!OWNER_NAME.test(repoName || "")) return "";
  const rooted = typeof root === "string" && root.startsWith("/") && !/[\0\r\n]/.test(root);
  return "fx-runner engine-bridge enable --repo " + repoName + (rooted ? " --repo-root " + shellQuote(root) : "");
};

const ONLINE = ["online_idle", "busy", "paused", "draining"];
const seen = (r, nowMs) => (r.lastSeen ? "last seen " + (agoText(r.lastSeen, nowMs) || "unknown") : RUNNER_WORDS.never);

/**
 * `settings.repos[].runnerId`, `fleet` (readFleet's answer or null when it could not be read), `repoName` (the repo the person is looking at, or ""),
 * `pickId` (the runner chosen in the picker). Returns everything the watch switch and the connect panel draw.
 */
export function runnerView({ settings, fleet, repoName, pickId, nowMs, root = "" }) {
  const runners = fleet ? fleet.runners.filter((r) => r.state !== "revoked") : [];
  const byId = new Map(runners.map((r) => [r.id, r]));
  const repos = settings.repos.filter((r) => r.enabled || r.eligible);
  const target = repoName || (repos.find((r) => r.enabled) || repos[0] || { name: "" }).name;
  const bridgedIds = [];
  for (const r of repos) if (r.runnerId && byId.has(r.runnerId) && !bridgedIds.includes(r.runnerId)) bridgedIds.push(r.runnerId);
  const choices = bridgedIds.map((id) => ({ id, name: byId.get(id).name }));
  const picked = byId.get(bridgedIds.includes(pickId) ? pickId : bridgedIds[0]) || null;
  const command = commandFor(target, settings.canEdit ? root : ""); // only an owner or admin may see a path; a member gets the bare --repo form
  let status;
  if (!fleet) status = { kind: "unknown", text: RUNNER_WORDS.unknown };
  else if (picked) {
    const online = ONLINE.includes(picked.state);
    status = { kind: online ? "online" : "offline", text: (online ? "Online" : stateParts(picked).words) + " · " + seen(picked, nowMs) };
  } else status = { kind: "unset", text: runners.length === 0 ? RUNNER_WORDS.noRunners : RUNNER_WORDS.noneBridged };
  const repoRunner = (id) => repos.some((r) => r.runnerId === id && (!target || r.name === target));
  return {
    words: RUNNER_WORDS,
    label: picked ? RUNNER_WORDS.watchOn + picked.name : RUNNER_WORDS.watchAny,
    runnerName: picked ? picked.name : "",
    choices: choices.length > 1 ? choices : [], pickedId: picked ? picked.id : "",
    unnamed: picked ? !picked.hasName : false, status, command: status.kind === "unset" && runners.length > 0 ? command : "",
    connect: {
      failed: !fleet, empty: !!fleet && runners.length === 0, command,
      rows: runners.map((r) => ({
        id: r.id, name: r.name, unnamed: !r.hasName, state: stateParts(r).words, online: ONLINE.includes(r.state), seen: seen(r, nowMs),
        bridge: (repoRunner(r.id) ? RUNNER_WORDS.setUpFor : RUNNER_WORDS.notSetUpFor) + (target || "this repository") + (repoRunner(r.id) ? "" : RUNNER_WORDS.yet), bridged: repoRunner(r.id),
      })),
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// One-click Connect. It shares this file, which the page fetches only when a screen shows the runners, so the app keeps its boot files (the boot budget holds).
// The Team app's one-click Connect, with no DOM (unit-testable with a fake client): the person presses Connect on a repo, an online runner finds the engine's
// checkout and turns the bridge on for it, and this file keeps what the screen says at each step. team-model.js owns the state and calls in here;
// team-app.js draws what bridgeView() returns.
//
// Rules this file holds:
//  - Every sentence is chosen by a closed word the cloud sent (a phase, a result, a refusal code), never taken from the server's text.
//  - A folder the runner offers is data: it is drawn as text, never as a link, and a person can pick only one the runner offered (the cloud checks that too).
//  - The full path is shown only to an owner or admin; a member gets the last two parts and no list.
//  - Nothing here counts or guesses: "connected" is what the runners last reported.

export const BRIDGE_WORDS = {
  title: "Connect this repo's engine",
  connect: "Connect", disconnect: "Disconnect", cancel: "Cancel", tryAgain: "Try again", connectThis: "Connect this one",
  copyDetails: "Copy details", detailsCopied: "Copied", detailsFailed: "Couldn't copy. Select the code and copy it by hand.",
  pickRunner: "Which runner?", pickFolder: "Folder", giveFolder: "Or type the folder, to get a command you can run yourself", folderHint: "/path/to/the/checkout",
  readFailed: "Couldn't check whether this repo is connected.",
  copy: "Copy command", copied: "Copied", copyFailed: "Couldn't copy. Select the command and copy it by hand.",
  waiting: "Still waiting for ", waitingTail: ". Is it running?",
  noRunner: "No runner is paired with this repo. Pair one in Machines, or run this on the computer that has the engine:",
  offline: "No runner that has this repo is online. Start it, or run this on the computer that has the engine:",
  old: "Your runner is out of date: run fx-runner update. Or run this on the computer that has the engine:",
  readOnly: "Only an owner or an admin can connect a repo.",
  pending: "A request for this repo is already on its way.",
  tooMany: "Too many requests in a short time.",
  gone: "That runner or repo is not available any more. The screen is refreshed.",
  offered: "That folder was not offered by the runner. Ask again.",
  failed: "That did not go through. Try again.",
  disconnectTip: "To connect it again, press Connect.",
  wrongFolder: "Picked the wrong folder? Disconnect, then Connect again.",
  skipped: "These copies were skipped because other people on this computer can write in them. If one is yours, run chmod go-w on it (and on any folder above it that others can write in), then Connect again, or give its folder in the command below:",
  memberPick: "An owner or an admin can pick which copy to use.",
  alreadyHas: "The runner already has this request. Wait for its answer.",
  incompleteTail: ". If it is the right one, confirm it:",
  cutShort: ", but its search was cut short, so a copy may be somewhere it did not reach. Type the folder below to get a command you can run yourself.",
  cutShortMember: ", but its search was cut short, so a copy may be somewhere it did not reach. An owner or an admin can give the folder.",
};
const REFUSALS = {
  checkout_layout_unexpected: "A copy of this repo was found, but it is not set up for the engine (no usable .autonomous-team/project.json). Set it up with coldstart, or give the folder.",
  checkout_incomplete: "The search stopped early after finding one copy, and there may be another it did not reach",
  checkout_mismatch: "That folder is not a copy of this repo.",
  checkout_unsafe: "That copy is not safe to use: it, or a folder above it, can be changed by other people on this computer. Run chmod go-w on it (and on any folder above it that others can write in), then Connect again, or run the command below with the folder.",
  repo_root_invalid: "That folder cannot be used: it must be a real folder of yours, with no link in it, and a copy of this repo.",
  repo_not_paired: "This runner is not paired with this repo.",
  engine_version_unusable: "That copy has no readable engine version (engine/manifest.json or .autonomous-team/engine-install.json).",
  state_dir_missing: "The engine's state folder for that copy does not exist yet. Start the engine once there, then try again.",
  state_dir_unreadable: "The engine's state folder for that copy cannot be read by the runner's user.",
  state_dir_shared: "Another connected repo already uses that state folder. Give this one its own.",
  state_dir_reserved: "That state folder is the runner's own or inside a checkout. Give the engine its own.",
  state_dir_unchecked: "The runner could not check that state folder. Try again, or connect by hand.",
  too_many_repos: "This computer already bridges as many repos as it can.",
  settings_damaged: "The runner's bridge settings file is damaged. Remove engine-bridge.json from its state folder, then try again.",
  bridge_failed: "The runner could not finish that. Try again, or connect by hand.",
  wrong_repo: "The runner does not have this repo on its list.", wrong_runner: "That request was made for another runner.",
  expired: "The request ran out before the runner took it.", seq_not_increasing: "The runner had already seen that request.", signature_invalid: "The runner did not trust that request.",
};
const PHASES = ["connecting", "connected", "disconnecting", "not_found", "ambiguous", "incomplete", "refused", "not_confirmed", "expired", "disconnect_failed", "disconnect_refused", "idle"];
const PLANS = ["send", "choose", "no_runner", "offline", "old"];
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : null);
const ABS = /^\/[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{0,1022}$/u; // a plain absolute folder: no control, invisible or bidirectional character

/** What the cloud said, checked for shape; null when it is not what this screen reads. Folders are kept only when they are plain absolute paths. */
export function readBridge(raw) {
  if (!isObj(raw) || !PHASES.includes(raw.phase) || !PLANS.includes(raw.plan) || !Array.isArray(raw.runners)) return null;
  const runners = [];
  for (const r of raw.runners) {
    if (!isObj(r) || typeof r.id !== "string" || typeof r.name !== "string" || typeof r.online !== "boolean" || typeof r.protocol_ok !== "boolean") return null;
    runners.push({ id: r.id, name: r.name, online: r.online, ok: r.protocol_ok, lastSeen: str(r.last_seen_at) || "" });
  }
  let connected = null;
  if (raw.connected !== null && raw.connected !== undefined) {
    const c = raw.connected;
    if (!isObj(c) || typeof c.runner_name !== "string") return null;
    connected = { runnerId: str(c.runner_id) || "", runnerName: c.runner_name, tail: str(c.root_tail) || "", root: typeof c.root === "string" && ABS.test(c.root) ? c.root : "" };
  }
  let command = null;
  if (raw.command !== null && raw.command !== undefined) {
    const c = raw.command;
    if (!isObj(c) || typeof c.id !== "string" || (c.kind !== "bridge_enable" && c.kind !== "bridge_disable")) return null;
    command = {
      id: c.id, kind: c.kind, runnerId: str(c.runner_id) || "", runnerName: str(c.runner_name) || "your runner", state: str(c.state) || "", result: str(c.result) || "", refusal: str(c.refusal) || "", tail: str(c.root_tail) || "",
      candidates: Array.isArray(c.candidates) ? c.candidates.filter((p) => typeof p === "string" && ABS.test(p)).slice(0, 10) : [],
      skipped: Array.isArray(c.skipped) ? c.skipped.filter((p) => typeof p === "string" && ABS.test(p)).slice(0, 10) : [], incomplete: c.incomplete === true, issuedAt: Date.parse(c.issued_at) || 0,
    };
  }
  return { phase: raw.phase, plan: raw.plan, runners, connected, command };
}

/** The last two parts, and the parent too when two of the folders end alike, so each can be told apart. */
export function folderLabels(paths) {
  const parts = (p) => p.split("/").filter(Boolean);
  const tail = (p) => parts(p).slice(-2).join("/");
  return paths.map((p) => (paths.filter((q) => tail(q) === tail(p)).length > 1 ? "…/" + parts(p).slice(-3).join("/") : tail(p)));
}

/** A folder, quoted for the command line the fallback shows. */
export const withFolder = (repoName, folder) => commandFor(repoName, ABS.test(folder) ? folder : "");

/**
 * Everything the Connect panel draws for one moment. `bridge` is the controller's state ({ data, failed, busy, notice, runnerPick, rootPick, typedRoot }); `canEdit` whether the
 * person is an owner or admin.
 */
export function bridgeView(bridge, { repoName, canEdit, nowMs }) {
  const W = BRIDGE_WORDS;
  const d = bridge.data;
  const base = { words: W, canEdit, notice: bridge.notice || "", busy: !!bridge.busy, commandFor: (folder) => withFolder(repoName, folder) };
  if (!repoName) return { ...base, kind: "none" };
  if (bridge.failed || !d) return { ...base, kind: "unknown", text: W.readFailed };
  const c = d.command;
  const runnerName = c ? c.runnerName : d.connected ? d.connected.runnerName : "your runner";
  const root = canEdit && d.connected ? d.connected.root : "";
  const fallback = withFolder(repoName, root);
  // The copies a scan skipped as unsafe come in their own list and are shown to read, never to pick (ruling 9); the folders on offer are the only ones to pick from.
  const offered = c && canEdit ? (d.phase === "not_found" ? c.skipped : c.candidates) : [];
  const labels = folderLabels(offered);
  // A single folder on offer (the one a capped scan found) is already chosen: confirming is one press.
  const rows = offered.map((p, i) => ({ path: p, label: labels[i], picked: bridge.rootPick === p || (d.phase === "incomplete" && offered.length === 1) }));
  const waited = c && c.issuedAt > 0 ? nowMs - c.issuedAt : 0;
  // A press that can be made again: there is one runner to send to, or the person can choose among several.
  const retry = canEdit && (d.plan === "send" || (d.plan === "choose" && d.runners.some((r) => r.online && r.ok)));
  switch (d.phase) {
    case "connected":
      return { ...base, kind: "connected", text: "Connected to " + (d.connected.tail || "the engine's folder") + " on " + d.connected.runnerName, tip: W.wrongFolder, command: fallback, canDisconnect: canEdit };
    case "connecting":
      return { ...base, kind: waited > 60_000 ? "slow" : "connecting", retry: waited > 60_000 && retry, text: waited > 60_000 ? W.waiting + runnerName + W.waitingTail : "Asking " + runnerName + " to connect...", cancelId: canEdit ? c.id : "" }; // Cancel stays for the whole life of the command, so a person is never stuck behind it
    case "disconnecting": {
      const online = d.runners.find((r) => r.id === (d.connected ? d.connected.runnerId : "")) ;
      const away = online ? !online.online : false;
      return { ...base, kind: "disconnecting", text: away ? "Will disconnect when " + runnerName + " is back online" : "Asking " + runnerName + " to disconnect...", cancelId: canEdit ? c.id : "" };
    }
    case "disconnect_failed": // the disconnect ran out unanswered: it did not happen, and the button is there to ask again
      return { ...base, kind: "disconnect_failed", text: "Disconnect did not reach " + runnerName + "; try again", canDisconnect: canEdit };
    case "disconnect_refused": // the runner would not disconnect: it says why, and the button is there to ask again
      return { ...base, kind: "disconnect_refused", text: "Disconnect refused: " + (REFUSALS[c.refusal] || W.failed), canDisconnect: canEdit };
    case "not_found": // the folders it skipped are shown to read, not to pick: a pick of an unsafe copy is refused, so the way forward is chmod or the command
      return { ...base, kind: "not_found", retry, text: runnerName + " looked on this computer and found no copy of " + repoName + (c.incomplete ? (canEdit ? W.cutShort : W.cutShortMember) : ""), cutShort: !!c.incomplete, command: fallback, folderBox: canEdit, skipped: rows.length ? W.skipped : "", rows, canPick: false };
    case "ambiguous":
      return { ...base, kind: "ambiguous", text: runnerName + " found more than one copy of " + repoName + (canEdit ? ". Which one?" : ". " + W.memberPick), rows, canPick: canEdit && rows.length > 0, command: fallback };
    case "incomplete":
      return { ...base, kind: "incomplete", text: REFUSALS.checkout_incomplete + (rows.length ? ": " + rows[0].label + W.incompleteTail : canEdit ? "." : ". " + W.memberPick), rows, canPick: canEdit && rows.length > 0, command: fallback };
    case "refused":
      return { ...base, kind: "refused", retry, text: REFUSALS[c.refusal] || W.failed, code: c.refusal, command: fallback };
    case "not_confirmed":
    case "expired":
      return { ...base, kind: "slow", retry, text: W.waiting + runnerName + W.waitingTail, command: fallback };
    default:
  }
  // Idle: what a press would do now.
  if (d.plan === "no_runner") return { ...base, kind: "fallback", text: W.noRunner, command: fallback, folderBox: canEdit };
  if (d.plan === "offline") return { ...base, kind: "fallback", text: W.offline, command: fallback, folderBox: canEdit };
  if (d.plan === "old") return { ...base, kind: "fallback", text: W.old, command: fallback, folderBox: canEdit };
  const choices = d.plan === "choose" ? d.runners.filter((r) => r.online && r.ok) : [];
  return { ...base, kind: "idle", text: "", choices, picked: bridge.runnerPick || (choices[0] ? choices[0].id : ""), canConnect: canEdit && (d.plan === "send" || choices.length > 0), command: fallback };
}

/** The person's sentence for a refused request. */
export function bridgeFailureWords(e) {
  const W = BRIDGE_WORDS;
  if (isRateLimited(e)) return retryWords(waitSeconds(e));
  if (e && e.status === 403) return W.readOnly;
  if (e && e.status === 404) return W.gone;
  if (e && e.status === 400 && e.code === "root_not_offered") return W.offered;
  if (e && e.status === 409 && e.code === "bridge_pending") return W.pending;
  if (e && e.status === 409 && e.code === "runner_too_old") return W.old;
  if (e && e.status === 409 && (e.code === "already_delivered" || e.code === "expired" || e.code === "already_cancelled")) return W.alreadyHas;
  if (e && e.status === 409 && (e.code === "no_runner_online" || e.code === "runner_choice_needed" || e.code === "bridge_not_connected")) return W.failed;
  return W.failed;
}

export const NO_BRIDGE = { repoId: "", data: null, failed: false, busy: false, notice: "", runnerPick: "", rootPick: "" };
/** How often the answer is read while a request is out (the runner's report raises no notice of its own). */
export const BRIDGE_POLL_MS = 4000;

export function createBridge({ client, signal, get, set, aborted }) {
  const patch = (p) => set({ bridge: { ...get().bridge, ...p } });
  const target = () => {
    const st = get();
    return st.settings ? st.settings.repos.find((r) => r.id === st.bridge.repoId) || null : null;
  };
  /** Reads where Connect stands for the repo. A read that lands after another repo was chosen is dropped. */
  async function read(repoId) {
    const id = repoId || get().bridge.repoId;
    if (!id) return;
    if (id !== get().bridge.repoId) set({ bridge: { ...NO_BRIDGE, repoId: id } });
    let data = null;
    try { data = readBridge(await client.bridge(id, signal)); } catch (e) { if (aborted(e)) return; }
    if (id !== get().bridge.repoId) return;
    patch({ data, failed: data === null });
  }
  async function send(call) {
    const b = get().bridge;
    if (!b.repoId || b.busy) return false;
    patch({ busy: true, notice: "" });
    try { await call(b.repoId); } catch (e) {
      if (aborted(e)) return false;
      patch({ busy: false, notice: bridgeFailureWords(e) });
      await read(b.repoId); // the answer may be a state that changed (pending, gone): show what is true now
      return false;
    }
    patch({ busy: false, rootPick: "" });
    await read(b.repoId);
    return true;
  }
  return {
    read,
    /** Shows the repo the sheet is about: reads it when it is not the one already held. */
    show: (repoId) => (repoId ? read(repoId) : Promise.resolve()),
    connect: () => {
      const b = get().bridge;
      const body = {};
      const cmd = b.data && b.data.command;
      // A folder is picked from what ONE runner offered, so the request goes to that runner (the cloud checks the offer against it); a single folder on offer is the pick.
      const root = b.rootPick || (b.data && b.data.phase === "incomplete" && cmd && cmd.candidates.length === 1 ? cmd.candidates[0] : "");
      if (root && cmd && cmd.runnerId) body.runner_id = cmd.runnerId;
      else if (b.runnerPick) body.runner_id = b.runnerPick;
      else if (b.data && b.data.plan === "choose") { const first = b.data.runners.find((r) => r.online && r.ok); if (first) body.runner_id = first.id; }
      if (root) body.repo_root = root;
      return send((id) => client.connectBridge(id, body, signal));
    },
    disconnect: () => send((id) => client.disconnectBridge(id, signal)),
    cancel: (commandId) => send(() => client.cancel(commandId, signal)),
    pickRunner: (id) => patch({ runnerPick: id }),
    pickRoot: (path) => patch({ rootPick: path }),
    /** True while a request is out and its answer is still being waited for (the controller polls on it). */
    waiting: () => { const d = get().bridge.data; return !!d && (d.phase === "connecting" || d.phase === "disconnecting"); },
    repoOf: target,
  };
}

// ── the live view ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// The Team app's live view (D#845 ON-25b). It lives in this file, the app's one lazily loaded module, because the Team app is at its per-app file ceiling and the boot budget counts a file of its own.
//
// Opening a repo asks the cloud for a live view (the watch route): the runner then uploads detail until the view ends. This module holds the person's slot:
//  - one POST when the view opens (real input, active: true), another about every 5 minutes (active only if the person did something since), a DELETE when the tab is hidden;
//  - a stream of its own at /api/v1/events?watch=<lease>, which renews the lease on the server and frees it the moment it closes (the shell's stream never carries a lease);
//  - the states the page draws: connecting, live, offline, at the cap, ended, and "Updating every minute" after 10 failed stream attempts.
// "Live" needs all four of: the lease is held, the watch is streaming, the repo was heard from under 90 s ago, and the stream is healthy. Anything else reads "Updated <time>".
// No retry is ever sent on its own at the cap (Try again is a click); the only timers are the 5-minute renewal and the stream's own backoff.

export const STREAM_URL = (leaseId) => "/api/v1/events?watch=" + encodeURIComponent(leaseId);
/** The renewal: the lease lives 90 s past the stream's last word, and a view with no input ends at the plan's idle limit, so the server is told every 5 minutes whether anyone is there. */
export const REPOST_MS = 5 * 60 * 1000;
/** The repo must have been heard from this recently for "Live" (a watched engine sends a heartbeat well inside it). */
export const INGEST_LIVE_S = 90;
/** The stream closes this long after the tab is hidden (the shell's own rule), and the slot is freed with it. */
export const HIDE_RELEASE_MS = 5000;
export const FAILED_ATTEMPTS = 10;
export const POLL_MS = 60000;
/** The page is told the time has moved this often, so "Live" drops by itself when the repo goes quiet (nothing else would repaint it). */
export const TICK_MS = 15000;
/** After a reconnect the lease is asked about once more this long after: the server's by-id delete from the old stream's cleanup may land after the re-take, and "Live" waits for that answer. */
export const CONFIRM_MS = 10000;
const DEAD_STREAM_MS = 50000;
const BROWSER_KEY = "fx-team-watch-browser";

export const WATCH_WORDS = {
  connecting: "Connecting to the machine…",
  live: "Live",
  polling: "Updating every minute",
  offline: "The machine is offline. Details appear when it reconnects.",
  cap: (inUse, limit, cap) => (cap === "account" ? "Your account has " + inUse + " live views open" : "Live view is in use by " + inUse + " people on this repo") + " (your plan allows " + limit + "). You're seeing the summary; it refreshes every 2 minutes.",
  tryAgain: "Try again",
  ended: "The live view has ended. You're seeing the summary.",
  tooOld: "This machine's runner can't send a live view yet. You're seeing the summary.",
  noData: "Not updated yet",
  held: (n) => n + (n === 1 ? " older line is on the machine and was" : " older lines are on the machine and were") + " not uploaded",
  loadOlder: "Load older",
  asking: "Asking the machine for older lines…",
  soon: "The machine was asked a moment ago. Try again shortly.",
  nothing: "There is nothing older to load.",
  olderFailed: "Older lines couldn't be requested.",
};

const stampMs = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
/** "Updated just now", "Updated 7 min ago", "Updated 3 h ago": the time since the repo was last heard from, as the clock moves. */
export function updatedWords(lastHeard, nowMs) {
  const t = stampMs(lastHeard);
  if (t === null) return WATCH_WORDS.noData;
  const m = Math.max(0, Math.floor((nowMs - t) / 60000));
  return "Updated " + (m < 1 ? "just now" : m < 120 ? m + " min ago" : Math.floor(m / 60) + " h ago");
}

const newId = () => (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : "00000000-0000-4000-8000-" + String(Date.now()).padStart(12, "0").slice(-12));
/** One id per browser, kept so a reload or a second tab renews the same slot instead of taking another; with no storage it lives for this page. */
function browserId(store) {
  try {
    const have = store && store.getItem(BROWSER_KEY);
    if (have && /^[0-9a-f-]{36}$/i.test(have)) return have;
    const id = newId();
    if (store) store.setItem(BROWSER_KEY, id);
    return id;
  } catch { return newId(); } // fx-swallow-ok: storage is a convenience; a blocked store means a new slot per page, never an error
}

export const NO_WATCH = { repoId: "", leaseId: "", leaseUntil: 0, startedAt: 0, posting: false, command: "", machine: "", postedAt: 0, cap: null, ended: false, summary: false, streamOpen: false, streamHealthy: false, leaseOk: false, polling: false, older: "", tickAt: 0 };

/**
 * What the page draws about the live view: `state` is one of connecting, live, offline, cap, ended, polling, summary; `pill` the one status word; `banner` the sentence for offline, the cap or
 * an ended view; `retry` the Try again label when the person may ask again. Pure: the clock and the repo's last-heard time are arguments, so every state is a fixture.
 */
export function watchView(w, repo, nowMs) {
  if (!w || !w.repoId || !repo) return null;
  const heardMs = stampMs(repo.lastHeard);
  const heardS = heardMs === null ? null : Math.max(0, (nowMs - heardMs) / 1000);
  const updated = updatedWords(repo.lastHeard, nowMs);
  const heardSinceStart = heardMs !== null && heardMs >= w.startedAt;
  const offline = w.machine === "offline" && !(heardMs !== null && heardMs > w.postedAt);
  const streaming = !offline && (w.command === "issued" || w.command === "held" || w.command === "throttled") && (w.command !== "issued" || heardSinceStart);
  const held = w.leaseId !== "" && w.leaseOk && (w.streamOpen || nowMs < w.leaseUntil);
  let state = "summary", pill = updated, banner = "", retry = "";
  if (w.cap) { state = "cap"; banner = WATCH_WORDS.cap(w.cap.inUse, w.cap.limit, w.cap.cap); retry = WATCH_WORDS.tryAgain; }
  else if (w.ended) { state = "ended"; banner = WATCH_WORDS.ended; retry = WATCH_WORDS.tryAgain; }
  else if (w.polling) { state = "polling"; pill = WATCH_WORDS.polling; }
  else if (w.leaseId === "" && w.posting) { state = "connecting"; pill = WATCH_WORDS.connecting; }
  else if (offline) { state = "offline"; banner = WATCH_WORDS.offline; }
  else if (w.command === "runner_too_old") banner = WATCH_WORDS.tooOld;
  else if (w.leaseId !== "" && !streaming) { state = "connecting"; pill = WATCH_WORDS.connecting; }
  else if (w.leaseId !== "" && held && streaming && w.streamHealthy && heardS !== null && heardS < INGEST_LIVE_S) { state = "live"; pill = WATCH_WORDS.live; }
  return { state, pill, banner, retry, older: w.older };
}

/**
 * The live view's controller. `get`/`set` read and patch the Team app's state (the `watch` key); `client.watch(repoId, body)` and `client.unwatch(repoId, browserId)` are its two calls.
 * Everything with a clock, a timer, a stream or the page's visibility is an argument, so a test drives it with fakes.
 */
export function createWatch({ client, signal, get, set, refresh, hidden = () => false, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, open = openStream, doFetch = apiFetch, rand = Math.random, doc = globalThis.document, store = globalThis.localStorage, channel = doc && typeof BroadcastChannel === "function" ? new BroadcastChannel("fx-team-watch") : null }) {
  const id = browserId(store);
  const timers = { repost: null, hide: null, retry: null, poll: null, healthy: null, dead: null, tick: null, confirm: null };
  let cur = null, failures = 0, input = false, lastInputAt = 0;
  const w = () => get().watch || NO_WATCH;
  const patch = (p) => set({ watch: { ...w(), ...p } });
  const clear = (k) => { if (timers[k] !== null) { clearTimer(timers[k]); timers[k] = null; } };
  const dead = () => !!signal && signal.aborted;

  function closeStream() {
    clear("healthy"); clear("dead");
    if (cur) { const c = cur; cur = null; c.close(); }
    if (w().streamOpen || w().streamHealthy) patch({ streamOpen: false, streamHealthy: false });
  }
  function openLease() {
    closeStream();
    const lease = w().leaseId;
    if (!lease || dead() || hidden()) return;
    let bytes = false, healthy = false;
    const at = now();
    const arm = () => { clear("dead"); timers.dead = setTimer(() => { if (cur === mine) mine.close(); }, DEAD_STREAM_MS); };
    const good = () => { if (healthy || cur !== mine) return; healthy = true; failures = 0; patch({ streamHealthy: true, polling: false }); clear("poll"); };
    const mine = open(doFetch, {
      url: STREAM_URL(lease),
      onOpen: () => { arm(); patch({ streamOpen: true }); timers.healthy = setTimer(() => { if (bytes) good(); }, HEALTHY_MS); },
      onBytes: () => { bytes = true; arm(); if (now() - at >= HEALTHY_MS) good(); },
      onFrame: (f) => { if (f.event === "resync") refresh(); },
    });
    cur = mine;
    mine.done.then(() => {
      if (cur !== mine) return;
      clear("healthy"); clear("dead");
      cur = null;
      // The server drops the lease whenever a stream closes from the client's side, and the lease may be gone even when this close was the server's own: it is taken again before any reconnect, and not Live until it is.
      patch({ streamOpen: false, streamHealthy: false, leaseOk: false });
      failures = healthy ? 0 : failures + 1; // a stream that stayed up and was rolled by the server reconnects at once; one that never got going backs off
      if (dead() || hidden() || !w().leaseId) return;
      announce();
      retry();
    });
  }
  function retry() {
    if (failures >= FAILED_ATTEMPTS) { patch({ polling: true }); schedulePoll(); return; }
    clear("retry");
    timers.retry = setTimer(async () => {
      timers.retry = null;
      if (dead() || hidden() || !w().leaseId) return;
      if (await call(now() - lastInputAt < REPOST_MS)) { openLease(); confirm(); } // a 409 (no input for a while) or a cap is shown as it is; a failed call counts as a failed attempt
      else if (w().leaseId && !w().ended && !w().cap) { failures++; retry(); }
    }, failures ? backoffDelay(failures, rand()) : 0);
  }
  /** One more POST shortly after a reconnect. A lease taken seconds ago cannot have ended for being idle, so a 409 here is the race and not the person's quiet: it asks once more with input. */
  function confirm() {
    patch({ leaseOk: false });
    clear("confirm");
    timers.confirm = setTimer(async () => {
      timers.confirm = null;
      if (dead() || hidden() || !w().leaseId) return;
      const was = w().leaseId;
      let r = await call(false);
      if (!r && w().ended) r = await call(true);
      if (r && r.lease_id !== was) openLease();
    }, CONFIRM_MS);
  }
  /** Tabs of one browser share one lease: when this one closes a stream or gives the lease up, the others are told, and take it again. */
  function announce() { if (channel) channel.postMessage({ repoId: w().repoId }); }
  if (channel) channel.onmessage = (m) => {
    const repoId = m && m.data && m.data.repoId;
    if (!repoId || repoId !== w().repoId || !w().leaseId || hidden() || dead()) return;
    patch({ leaseOk: false });
    closeStream();
    retry();
  };
  /** After 10 failed attempts: the panels are read every minute, and the stream is tried once a minute; one that holds ends this. */
  function schedulePoll() {
    clear("poll");
    timers.poll = setTimer(async () => {
      timers.poll = null;
      if (dead() || hidden()) return;
      refresh();
      const was = w().leaseId;
      const r = await call(false);
      if (w().polling && w().leaseId && (!cur || (r && r.lease_id !== was))) openLease();
      if (w().polling) schedulePoll();
    }, POLL_MS);
  }

  /** The watch route. `active` is whether the person did something; `before` a "Load older" cursor. Returns the answer, or null when the call failed (the state says why). */
  async function call(active, before) {
    const repoId = w().repoId;
    if (!repoId) return null;
    const body = { browser_id: id, active, ...(before === undefined ? {} : { before }) };
    try {
      const r = await client.watch(repoId, body, signal);
      if (!r || typeof r.lease_id !== "string" || w().repoId !== repoId) return null;
      const until = stampMs(r.expires_at);
      patch({ leaseId: r.lease_id, leaseUntil: until === null ? 0 : until, command: typeof r.command === "string" ? r.command : "", machine: r.machine === "offline" ? "offline" : "online", postedAt: now(), cap: null, ended: false, summary: false, posting: false, leaseOk: true });
      return r;
    } catch (e) {
      if (dead() || (e && e.name === "AbortError") || w().repoId !== repoId) return null;
      if (e && e.status === 429 && e.code === "watch_limit" && e.limit) patch({ cap: e.limit, leaseId: "", posting: false });
      else if (e && e.status === 409 && e.code === "watch_ended") { closeStream(); patch({ ended: true, leaseId: "", posting: false }); }
      else patch({ summary: true, posting: false, leaseOk: false }); // anything else: the summary stays, and the next renewal asks again
      return null;
    }
  }
  function armRepost() {
    clear("repost");
    timers.repost = setTimer(async () => {
      timers.repost = null;
      if (dead() || hidden() || !w().repoId || w().cap || w().ended) return;
      const active = input;
      input = false;
      const was = w().leaseId;
      const r = await call(active);
      if (r && r.lease_id !== was && !hidden()) openLease(); // the lease was taken again under a new id: the stream must carry it
      armRepost();
    }, REPOST_MS);
  }

  function armTick() {
    clear("tick");
    timers.tick = setTimer(() => { timers.tick = null; if (!w().repoId) return; if (!hidden()) patch({ tickAt: now() }); armTick(); }, TICK_MS);
  }
  /** Starts (or restarts) the view of one repo. Real input: a person opening it, or coming back to it, asks for a view. */
  async function begin(repoId) {
    if (dead() || hidden() || !repoId) return;
    clear("hide");
    closeStream();
    lastInputAt = now();
    set({ watch: { ...NO_WATCH, repoId, startedAt: now(), posting: true } });
    armTick();
    const r = await call(true);
    if (!r) { armRepost(); return; }
    if (r.command !== "runner_too_old") openLease();
    armRepost();
  }
  /** Frees the slot at once: the stream closes (the server drops the lease with it) and the route's DELETE says so too. */
  function release() {
    const repoId = w().repoId;
    closeStream();
    for (const k of ["repost", "retry", "poll", "hide", "tick", "confirm"]) clear(k);
    if (repoId && w().leaseId) { announce(); client.unwatch(repoId, id).catch(() => {}); } // fx-swallow-ok: the stream's close and the lease's 90 s life free the slot anyway
    set({ watch: null });
  }
  const onVisibility = () => {
    if (doc && doc.hidden) { clear("hide"); timers.hide = setTimer(() => { timers.hide = null; release(); }, HIDE_RELEASE_MS); }
    else { clear("hide"); const repoId = get().selectedId; if (!w().repoId && repoId && !hidden()) begin(repoId); }
  };
  if (doc && doc.addEventListener) doc.addEventListener("visibilitychange", onVisibility);

  return {
    /** Called after each read: opens a view for the shown repo when there is none, and moves it when another repo is chosen. */
    sync(repoId) {
      if (!repoId) { if (w().repoId) release(); return; }
      if (w().repoId === repoId || hidden()) return;
      if (w().repoId) release();
      begin(repoId);
    },
    /** Try again (the cap, an ended view): one new start, never on a timer. */
    again() { const repoId = w().repoId; if (repoId) begin(repoId); },
    /** A person did something in the app: the next renewal says so, and a view that ended for want of input can restart. */
    touch() { input = true; lastInputAt = now(); },
    /** "Load older": a watch with the log's lowest uploaded seq as `before`. */
    async older(oldestSeq) {
      if (w().older === WATCH_WORDS.asking || !w().repoId) return;
      if (!Number.isInteger(oldestSeq)) { patch({ older: WATCH_WORDS.nothing }); return; } // nothing has been uploaded yet, so there is nothing before it
      patch({ older: WATCH_WORDS.asking });
      const repoId = w().repoId;
      try {
        const r = await client.watch(repoId, { browser_id: id, active: true, before: oldestSeq }, signal);
        patch({ older: r && r.command === "throttled" ? WATCH_WORDS.soon : "" });
      } catch (e) {
        if (dead() || (e && e.name === "AbortError")) return;
        patch({ older: e && e.status === 400 ? WATCH_WORDS.nothing : WATCH_WORDS.olderFailed });
      }
    },
    release,
    destroy() { if (doc && doc.removeEventListener) doc.removeEventListener("visibilitychange", onVisibility); release(); if (channel) channel.close(); },
  };
}
