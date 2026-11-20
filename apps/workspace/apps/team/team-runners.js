// Which runner the Team app's watch switch means, and how to connect one. Pure functions, no page, no clock but the one passed in.
//
// What the cloud can tell: the account's runners (GET /api/runners: name, state, last seen) and, per repo, the runner whose bridge last reported for it
// (settings repos[].bridged_runner_id). It cannot see the setup file on the computer, and a bridge can only report once the watch is on and the repo is
// ticked, so "not set up" below means "no runner has reported for the bridge yet", and the words say that. The command is complete as shown: the repo name
// is filled in and nothing is left to edit. The runner finds its own checkout and state folder from `--repo` alone. A folder the runner itself discovered
// may be added (`commandFor`'s second argument), but nothing reports one yet, so no caller passes it.
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
