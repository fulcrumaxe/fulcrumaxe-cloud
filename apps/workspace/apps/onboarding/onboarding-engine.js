// D#845 ON-6: the engine track of the Onboarding app. The seven steps and their states come from the server (GET /api/v1/onboarding, tracks[1]);
// this file only words them. Nothing here computes or stores progress.
//
// Two halves. The first has no DOM and is unit-tested: describeStep() turns one step plus a view-model into its fixed copy, its commands and the apps
// it hands off to. The view-model's detail fields are all optional (a later row fills each one; the PR lists which): with a field absent the step
// shows only its generic state, never a guess. The second half draws what describeStep() returns, with h() only, so no server text is read as markup.
//
// Commands are fixed templates filled with the page's own origin. A Copy button copies exactly the text drawn beside it.
// onboarding-app.js loads this file with import() when the engine track is on screen, so it is not a boot request (the boot budget is full).
import { h, timeNode, usd } from "../_lib/dom.js";

export const LABELS = {
  machine: "Connect a machine", claude: "Sign in to Claude on the machine", github_app: "Install the GitHub App (write)", project: "Choose a project",
  plan: "Approve the plan", install: "Install the engine", live: "Go live",
};
export const STATE_WORDS = { done: "Done", active: "Up next", pending: "Waiting", failed: "Needs attention" };
export const TIME_TO_LIVE = "usually 15–30 minutes"; // until J1 measures it
export const NO_KVM = "This machine has no KVM, so jobs run in the OS sandbox. That's fine for one project.";
export const OPERATE_OFF = "The engine runs only while operate is on. Operate lets the cloud send commands to the engine, and your dials decide what it may do by itself.";
export const ASK_OWNER = "Ask an owner or admin to turn on operate";
const GENERIC_FAIL = "This step stopped. Try again.";
const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
const SUB_STEPS = { archive: "Archive", boot: "Boot the sandbox", populate: "Populate", provision: "Provision", bundle: "Bundle", push: "Push", open_pr: "Open the pull request" };
const SUB_WORDS = { pending: "Pending", running: "Running", ok: "Done", failed: "Failed" };

/** The origin a command may carry: a plain http(s) origin, or "" (the commands that need it are then left out). */
const ORIGIN_RE = /^https?:\/\/(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/;
export const cleanOrigin = (o) => (typeof o === "string" && ORIGIN_RE.test(o) ? o : "");

/** The commands of the open `machine` step, in order, for this origin. */
export function machineCommands(origin) {
  const o = cleanOrigin(origin);
  return [
    { label: "Install the Claude command-line app", text: CLAUDE_INSTALL },
    { label: "Sign in to Claude", text: "claude" },
    ...(o ? [{ label: "Install the runner", text: "curl -fsSL " + o + "/install.sh | sh" }, { label: "Connect this machine", text: "fx-runner setup --cloud-url " + o }] : []),
  ];
}

/** What the person needs before the first command (the price is plan data, never a literal here). */
export function prerequisites(priceUsd) {
  return [
    "A Claude subscription",
    "A GitHub account",
    "A computer running Linux, macOS or Windows with WSL2, or a Hetzner Cloud account",
    typeof priceUsd === "number" && Number.isFinite(priceUsd) ? "Price: " + usd(priceUsd) + " a month per engine" : "Price: shown when you choose a plan",
    "Time to Live: " + TIME_TO_LIVE,
  ];
}

/** The Engine plan's monthly price from a GET /api/plans body, or null. */
export function enginePrice(body) {
  const p = body && Array.isArray(body.plans) ? body.plans.find((x) => x && x.id === "engine") : null;
  return p && typeof p.price_usd_month === "number" && Number.isFinite(p.price_usd_month) ? p.price_usd_month : null;
}

// §4: each closed failure code's sentence, with its command when it has one. d is the optional detail ({ repo, free_gb, need_gb, reason, sub_step }).
const gb = (n) => (Number.isFinite(n) ? n + " GB" : "");
const par = (s) => (s ? " (" + s + ")" : "");
const FIXES = {
  runner_too_old: (nm) => [nm + " runs an old runner. Update the runner:", "fx-runner update"],
  claude_missing: (nm) => ["Claude isn't installed on " + nm + ". Install it:", CLAUDE_INSTALL],
  claude_signed_out: (nm) => ["Run claude on " + nm + " and sign in", "claude"],
  claude_too_old: (nm) => ["Claude on " + nm + " is too old. Update it:", "claude update"],
  microvm_no_kvm: (nm) => ["No KVM on " + nm + ". It will use Standard isolation (one project)"],
  microvm_helper_missing: (nm) => [nm + " can run microVMs. Run sudo fx-runner vm install on it.", "sudo fx-runner vm install"],
  microvm_helper_not_ready: (nm) => ["The microVM helper on " + nm + " isn't ready. Restart it:", "sudo systemctl restart fx-vmhelper"],
  microvm_helper_out_of_date: (nm) => ["The microVM helper on " + nm + " is out of date. Update it:", "sudo fx-runner vm install"],
  vm_memory_low: (nm, d) => [nm + (Number.isFinite(d.free_gb) ? " has " + gb(d.free_gb) + " free" : " is low on memory") + "; an engine needs " + (Number.isFinite(d.need_gb) ? gb(d.need_gb) : "more") + ". Stop another engine or add memory"],
  snapshot_quota: (nm) => [nm + "'s snapshot space is full. Remove an old project or raise the quota:", "fx-runner config set snapshot_quota_bytes <bytes>"],
  image_missing: (nm) => ["The sandbox image isn't on " + nm + " yet. It downloads on first use; check the network"],
  disk_low: (nm, d) => [nm + (Number.isFinite(d.free_gb) ? " has " + gb(d.free_gb) + " free" : " is low on disk") + "; a project needs 10 GB"],
  mirror_denied: (nm, d) => ["The GitHub App can't read " + (d.repo || "the repository") + ". Open Repos"],
  mirror_failed: (nm, d) => ["Couldn't fetch " + (d.repo || "the repository") + " to " + nm + ". Try again"],
  engine_release_unset: () => ["Setup isn't available right now."],
  engine_checksum: () => ["The engine download didn't match its checksum. Nothing was installed"],
  populate_failed: (nm, d) => ["Engine install stopped" + (d.sub_step ? " at " + d.sub_step : "") + ". Try again (it picks up where it stopped)"],
  provision_failed: (nm, d) => FIXES.populate_failed(nm, d),
  deps_failed: (nm, d) => FIXES.populate_failed(nm, d),
  bundle_refused: (nm, d) => ["The install produced changes we couldn't accept" + par(d.reason) + ". Nothing was pushed"],
  push_denied: (nm, d) => ["The GitHub App can't push to " + (d.repo || "the repository") + ". Check its write access in Repos"],
  pr_failed: () => ["Couldn't open the install PR. Try again"],
  seed_failed: (nm, d) => ["The first Discussions couldn't be created. Turn on Discussions in " + (d.repo || "the repository") + "'s settings, then try again"],
  session_boot_failed: (nm, d) => ["The engine didn't start on " + nm + par(d.reason) + ". Start the engine to retry"],
  session_crash_loop: () => ["The engine stopped 6 times in an hour. It stays stopped until you start it"],
  token_refresh_failed: (nm) => ["The engine lost GitHub access on " + nm + ". It's paused until access returns"],
  survey_failed: (nm, d) => ["The survey stopped" + par(d.reason) + ". Try again, or write your own plan"],
  survey_timeout: (nm, d) => FIXES.survey_failed(nm, d),
  subscription_limit: () => ["Your Claude plan's usage limit was reached. Work resumes after it resets"],
  machine_offline: (nm, d) => [nm + " is offline" + (Number.isInteger(d.last_seen_min) ? " (last seen " + d.last_seen_min + " min ago)" : "")],
};
/** The sentence and optional command for a failure code (a code with no entry reads as a generic stop). */
export function fixFor(code, nm, detail) {
  const f = Object.prototype.hasOwnProperty.call(FIXES, code) ? FIXES[code] : null;
  const [text, cmd] = f ? f(nm, detail || {}) : [GENERIC_FAIL];
  return { text, cmd: cmd || "" };
}

/**
 * The machine the engine track speaks of, from a GET /api/runners body: the most recently heard runner that is not revoked (the one the server's `machine`
 * step picks; a tie goes to the lower id). Returns { name, offline, last_seen_min }, or {} when there is none (the copy then says "your machine").
 */
export function machineContext(body, nowMs) {
  const heard = (r) => (r && typeof r.id === "string" && r.state !== "revoked" && typeof r.last_seen_at === "string" ? Date.parse(r.last_seen_at) : NaN);
  const list = (body && Array.isArray(body.runners) ? body.runners : []).filter((r) => Number.isFinite(heard(r)));
  list.sort((a, b) => heard(b) - heard(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const r = list[0];
  if (!r) return {};
  return { name: typeof r.name === "string" ? r.name.trim() : "", offline: r.state === "offline" || r.state === "not_responding", last_seen_min: Math.max(0, Math.floor((nowMs - heard(r)) / 60000)) };
}

/** The copy of the project step's machine list for a machine that cannot take another project, or "". */
export const machineChoiceLine = (m) => (m && m.tier === "standard" && m.hasProject === true ? "Standard isolation hosts one project" : "");
/** "Public" or "Private" for a repo in the picker; "" when GitHub has not said. */
export const visibilityLabel = (v) => (v === "public" ? "Public" : v === "private" ? "Private" : "");

const act = (id, label, app) => ({ id, label, app });
/**
 * One engine step's copy. `steps` is the engine track, `i` the step, `ctx` the view-model (every field optional):
 *   name, origin, isAdmin, offline, last_seen_min
 *   machine { linked_silent, helper_missing, kvm: "present"|"absent", doctor_reason, doctor: [{ code, ...detail }] }
 *   project { no_eligible_machine }   plan { stage: "surveying"|"draft", run_id }
 *   install { sub_steps: [{ id, state }], pr: { number, state: "open"|"closed" } }   live { operate: "on"|"off", silent_min, starting }
 * Returns { label, state, word, failed, lines, list, commands, actions }; an action with `app` is a hand-off to that app.
 */
export function describeStep(steps, i, ctx = {}) {
  const step = steps[i];
  const nm = ctx.name || "your machine";
  const v = { label: LABELS[step.step], state: step.state, word: STATE_WORDS[step.state], failed: step.state === "failed", lines: [], list: [], commands: [], actions: [] };
  const fix = (code, d) => {
    const f = fixFor(code, nm, d);
    v.lines.push(f.text);
    if (f.cmd) v.commands.push({ label: "", text: f.cmd });
  };
  if (step.state === "failed") { fix(step.failure.code, ctx.detail); return v; }
  if (step.state === "pending") {
    const before = steps.slice(0, i).find((s) => s.state !== "done");
    if (before) v.lines.push("Finish " + LABELS[before.step] + " first");
    return v;
  }
  const m = ctx.machine || {};
  switch (step.step) {
    case "machine":
      if (step.state === "done") {
        v.lines.push(nm + " connected" + (step.tier === "microvm" ? " · MicroVM isolation" : step.tier === "standard" ? " · Standard isolation" : ""));
        // D#845 ON-6b: the Standard tier follows the configured engine, not the hardware, so "no KVM" is said only when the machine's facts say KVM is absent. With KVM present
        // the machine can run microVMs and lacks the helper; a machine that has not said (no `kvm`) gets neither line, since neither would be known.
        if (step.tier === "standard" && m.kvm === "absent") v.lines.push(NO_KVM);
        else if (step.tier === "standard" && m.kvm === "present" && m.helper_missing) fix("microvm_helper_missing");
      } else if (m.doctor_reason === "microvm_helper_not_ready" || m.doctor_reason === "microvm_helper_out_of_date") fix(m.doctor_reason);
      else if (m.helper_missing) fix("microvm_helper_missing");
      else if (m.linked_silent) { v.lines.push("Not started yet. On " + nm + " run fx-runner service status"); v.commands.push({ label: "", text: "fx-runner service status" }); }
      else {
        v.commands.push(...machineCommands(ctx.origin));
        v.lines.push(cleanOrigin(ctx.origin) ? "It prints a code. Open " + ctx.origin + "/link and type the code there." : "", "Waiting for your machine…");
      }
      if (step.state !== "done") for (const c of Array.isArray(m.doctor) ? m.doctor : []) if (c && Object.hasOwn(FIXES, c.code)) fix(c.code, c);
      break;
    case "claude":
      if (step.state === "done") v.lines.push("Claude is signed in on " + nm);
      else if (ctx.offline) v.lines.push(Number.isInteger(ctx.last_seen_min) ? nm + " was last seen " + ctx.last_seen_min + " min ago" : nm + " is offline");
      else fix("claude_signed_out");
      break;
    case "github_app":
      v.lines.push(step.state === "done" ? "The GitHub App is installed with write access" : "Install the GitHub App with write access");
      if (step.state !== "done") v.actions.push(act("open_repos", "Open Repos", "repos"));
      break;
    case "project":
      if (step.state === "done") v.lines.push("Your project is placed");
      else if ((ctx.project || {}).no_eligible_machine) { v.lines.push("Every machine is full or offline"); v.actions.push(act("add_machine", "Add a machine", "runners")); }
      break;
    case "plan": {
      const p = ctx.plan || {};
      if (step.state === "done") v.lines.push("Your plan is approved");
      else if (p.stage === "surveying") { v.lines.push("Reading your code and docs…"); if (p.run_id) v.actions.push(act("open_run", "Open the run", "runs")); }
      else if (p.stage === "draft") v.lines.push("Your plan is ready to review");
      break;
    }
    case "install": {
      const n = ctx.install || {};
      if (n.pr && Number.isInteger(n.pr.number) && n.pr.state === "open") v.lines.push("Review and merge the install PR #" + n.pr.number);
      else if (n.pr && n.pr.state === "closed") v.lines.push("The install PR was closed. Reopen it, or start install again");
      else if (Array.isArray(n.sub_steps)) for (const s of n.sub_steps) if (s && SUB_STEPS[s.id] && SUB_WORDS[s.state]) v.list.push({ label: SUB_STEPS[s.id], word: SUB_WORDS[s.state] });
      if (step.state === "done") v.lines.push("The engine is installed");
      break;
    }
    case "live": {
      const l = ctx.live || {};
      if (step.state === "done") v.actions.push(act("open_team", "Open Team", "team"));
      else if (l.operate === "off") {
        v.lines.push(OPERATE_OFF);
        if (ctx.isAdmin === false) v.lines.push(ASK_OWNER); else v.actions.push(act("operate", "Turn on operate and start the engine", "team"));
      } else if (Number.isFinite(l.silent_min) && l.silent_min > 5) v.lines.push("No heartbeat from the engine on " + nm + ". Open Machines → " + nm + " → sandboxes");
      else if (l.starting) v.lines.push("Starting the engine on " + nm + "…");
      break;
    }
  }
  v.lines = v.lines.filter((x) => x !== "");
  return v;
}

/** Copies exactly `text`. Says so in the live region, or says it could not. */
export async function copyText(text, announce) {
  try {
    await navigator.clipboard.writeText(text);
    announce("Copied");
  } catch {
    announce("Couldn't copy. Select the command and copy it yourself.");
  }
}

function commandBox(c, env) {
  return h("div", { class: "ob-cmd" },
    c.label ? h("span", { class: "ob-cmd-label" }, c.label) : null,
    h("code", { class: "ob-code", "data-testid": "ob-cmd" }, c.text),
    h("button", { type: "button", class: "ob-btn", "data-testid": "ob-copy", "aria-label": "Copy: " + c.text, onClick: () => copyText(c.text, env.announce) }, "Copy"));
}

/** A line of copy as DOM children: the machine's own name goes in <bdi> (text, never HTML), so a right-to-left name cannot reorder the sentence. */
function lineNodes(text, name) {
  if (!name || !text.includes(name)) return [text];
  return text.split(name).flatMap((part, i) => (i === 0 ? [part] : [h("bdi", null, name), part])).filter((x) => x !== "");
}

/** The engine track's section. `env`: { ctx (view-model), price, announce, canOpen(id), openApp(id) }. */
export function engineSection(steps, env) {
  const first = steps.findIndex((s) => s.state !== "done");
  const items = steps.map((s, i) => {
    const v = describeStep(steps, i, env.ctx);
    const buttons = v.actions.filter((a) => env.canOpen(a.app)).map((a) => h("button", { type: "button", class: "ob-btn ob-btn-primary", "data-testid": "ob-engine-" + a.id, onClick: () => env.openApp(a.app) }, a.label));
    return h("li", { class: "ob-step ob-engine-step" + (s.state === "done" ? " ob-done" : "") + (i === first ? " ob-current" : "") + (v.failed ? " ob-failed" : ""), "data-testid": "ob-engine-" + s.step, "data-state": s.state, "aria-current": i === first ? "step" : null },
      h("div", { class: "ob-step-head" }, h("strong", null, v.label),
        h("span", { class: "ob-state", "data-testid": "ob-engine-state" }, v.word, s.completed_at ? [" ", timeNode(s.completed_at, true)] : null)),
      v.lines.map((t) => h("p", { class: "ob-muted", "data-testid": "ob-engine-line" }, lineNodes(t, env.ctx.name))),
      v.list.length ? h("ul", { class: "ob-issues", "aria-label": "Install progress" }, v.list.map((x) => h("li", { "data-testid": "ob-engine-sub" }, x.label + ": " + x.word))) : null,
      v.commands.map((c) => commandBox(c, env)), buttons);
  });
  return h("section", { class: "ob-track", "data-testid": "ob-track-engine", "aria-label": "Engine setup" },
    first === 0 ? h("div", { class: "ob-prereq", "data-testid": "ob-prereq" }, h("h3", { class: "ob-sub" }, "Before you start"),
      h("ul", { class: "ob-issues" }, prerequisites(env.price).map((t) => h("li", { "data-testid": "ob-prereq-line" }, t)))) : null,
    h("ol", { class: "ob-steps", "aria-label": "Engine setup steps" }, items));
}
