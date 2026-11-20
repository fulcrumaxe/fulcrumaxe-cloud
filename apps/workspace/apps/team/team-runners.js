// Which runner the Team app's watch switch means, and how to connect one. Pure functions, no page, no clock but the one passed in.
//
// What the cloud can tell: the account's runners (GET /api/runners: name, state, last seen) and, per repo, the runner whose bridge last reported for it
// (settings repos[].bridged_runner_id). It cannot see the setup file on the computer, and a bridge can only report once the watch is on and the repo is
// ticked, so "not set up" below means "no runner has reported for the bridge yet", and the words say that. The command is complete as shown: the repo name
// is filled in and nothing is left to edit. The runner finds its own checkout and state folder from `--repo` alone. A folder the runner itself discovered
// may be added (`commandFor`'s second argument), but nothing reports one yet, so no caller passes it.
import { isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";
import { agoText, stateParts } from "../runners/runners-fleet.js";

export const RUNNER_WORDS = {
  watchOn: "Watch the engine team on ",
  watchAny: "Watch the engine team on your runner",
  pick: "Runner",
  unknown: "The runner list isn't available right now.",
  noRunners: "No runners yet. Use Add a runner to register your first machine.",
  openRunners: "Open Runners",
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
  unnamed: "This runner has no name yet. You can name it in Runners.", rename: "Name it in Runners",
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
  noRunner: "No runner is paired with this repo. Pair one in Runners, or run this on the computer that has the engine:",
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
  engine_version_unusable: "That copy has no readable engine version (engine/manifest.json).",
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
