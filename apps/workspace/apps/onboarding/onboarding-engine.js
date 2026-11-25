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
import { api } from "../_lib/api.js";

export const LABELS = {
  machine: "Connect a machine", claude: "Sign in to Claude on the machine", github_app: "Install the GitHub App (write)", project: "Choose a project",
  plan: "Approve the plan", install: "Install the engine", live: "Go live",
};
// B-6-VMTOKEN: the words for a machine in virtual machine mode with no Claude token. The Machines app says the same (runners-fleet.js); a test pins that they match.
export const VM_TOKEN_COMMAND = "fx-runner credentials set-vm-token";
export const VM_TOKEN_LINE = "Virtual machine mode needs a Claude token on this machine. On that machine run " + VM_TOKEN_COMMAND + ".";
export const VM_TOKEN_STAYS = "The token stays on that machine and is never sent to us.";
/** The claude step reads differently for a machine in virtual machine mode: it gets a token, not a sign-in. The machine step carries the tier. */
const vmMode = (steps) => (steps.find((s) => s.step === "machine") || {}).tier === "microvm";
export const VM_CLAUDE_LABEL = "Give the machine a Claude token";
const labelOf = (steps, key) => (key === "claude" && vmMode(steps) ? VM_CLAUDE_LABEL : LABELS[key]);
export const STATE_WORDS = { done: "Done", active: "Up next", pending: "Waiting", failed: "Needs attention" };
export const TIME_TO_LIVE = "usually 15–30 minutes"; // until J1 measures it
export const NO_KVM = "This machine has no KVM, so jobs run in the OS sandbox. That's fine for one project.";
export const OPERATE_OFF = "The engine runs only while operate is on. Operate lets the cloud send commands to the engine, and your dials decide what it may do by itself.";
export const ASK_OWNER = "Ask an owner or admin to turn on operate";
export const ASK_PICK = "Ask an owner or admin to pick the project";
const GENERIC_FAIL = "This step stopped. Try again.";
const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
const SUB_STEPS = {
  archive: "Archive", boot: "Boot the sandbox", populate: "Populate", provision: "Provision", bundle: "Bundle", push: "Push", open_pr: "Open the pull request",
  // D#845 ON-8a: the sub-steps a setup job reports (the protocol's SETUP_SUB_STEPS).
  engine_fetch: "Download the engine", plan_fetch: "Fetch the plan", sandbox_boot: "Boot the sandbox", workspace_in: "Copy the project in", bootstrap: "Set up the engine", preflight: "Check the machine", interview: "Record the answers",
  wiring: "Wire the project", deps: "Install dependencies", labels: "Labels", sandbox_hook: "Sandbox hook", done: "Finish coldstart", finalize: "Finish the install", bundle_out: "Bundle the changes", pr_open: "Open the pull request", gh_labels: "Create the labels",
};
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

/** The Engine plan's monthly price from a GET /api/plans body (`engine_plan`, beside the hosted plans), or null. */
export function enginePrice(body) {
  const p = body && body.engine_plan;
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
/** The distinct fixed lines of a machine's reported preflight codes, in the order the cloud sent them; nothing but a { code, fix } pair of strings counts. */
export const preflightTexts = (list) => [...new Set((Array.isArray(list) ? list : []).filter((p) => p && typeof p.code === "string" && typeof p.fix === "string" && p.fix !== "").map((p) => p.fix))];
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

/**
 * D#845 ON-22c: what a refused plan purchase says, by the server's closed `code` first and then by status. `link` marks the two lines that point at Budget & billing; the pointer is a link only
 * while that app can be opened, otherwise the same sentence shows without it. Nothing the server wrote is shown.
 */
export const PLAN_BY_CODE = {
  already_subscribed: { text: "This account already has that plan. Change the number of engines in Budget & billing.", link: true },
  no_subscription: { text: "This account has no paying plan yet. Choose the Engine plan first.", link: false },
  engine_quantity_in_use: { text: "More engines are running than that number. Park or stop an engine first.", link: false },
  subscription_not_paying: { text: "The subscription isn't being paid right now. Settle the payment in Budget & billing, then try again.", link: true },
  payment_pending: { text: "The charge wasn't collected, so nothing changed. Update your payment method and try again.", link: false },
};
export const PLAN_BY_STATUS = { 403: "Only the account owner can change the Engine plan.", 422: "That quantity isn't accepted." };
export const PLAN_FAILED = "The Engine plan couldn't be changed. Try again.";
/** Codes after which the step reads again, so it shows its current buttons (Choose plan again, or the payment line). */
export const PLAN_REREAD = ["no_subscription", "subscription_not_paying"];
export const BUDGET_APP = "budget-billing";
export const BUDGET_PHRASE = "Budget & billing";
/** `e` is anything thrown by the API call; returns { text, link, code } with text never empty. */
export function planRefusal(e) {
  const code = e && typeof e.code === "string" ? e.code : "";
  if (Object.hasOwn(PLAN_BY_CODE, code)) return { ...PLAN_BY_CODE[code], code };
  const status = e && typeof e.status === "number" ? e.status : 0;
  if (Object.hasOwn(PLAN_BY_STATUS, status)) return { text: PLAN_BY_STATUS[status], link: false, code };
  return { text: PLAN_FAILED, link: false, code };
}

/** A refusal's sentence with "Budget & billing" as a link that opens that app (text only, never markup). */
function budgetLinked(text, env) {
  const [pre, post] = text.split(BUDGET_PHRASE);
  return [pre, h("button", { type: "button", class: "ob-link", "data-testid": "ob-open-budget-billing", onClick: () => env.openApp(BUDGET_APP) }, BUDGET_PHRASE), post];
}

const act = (id, label, app) => ({ id, label, app });
/** An action the app runs itself (a purchase), not a hand-off to another app. */
const run = (id, label) => ({ id, label, run: true });
/**
 * D#845 ON-22: the project step's plan gate. The price is plan data (`ctx.price`, from GET /api/plans), never a literal here; without it the line says only what to do.
 * `plan_ended` shows even on a placed project (its engine is stopped); the others only while the project is still to be placed.
 */
function planGate(v, gate, ctx) {
  const price = typeof ctx.price === "number" && Number.isFinite(ctx.price) ? " (" + usd(ctx.price) + " a month per engine)" : "";
  // An engine was just added and the step has not caught up with the provider yet: say so instead of offering the purchase again.
  if (ctx.planAdded && ctx.planNote && (gate === "plan_required" || gate === "engine_quantity")) { v.lines.push(ctx.planNote); return; }
  if (gate === "plan_required") { v.lines.push("Pick the Engine plan to run the engine" + price); v.actions.push(run("choose_plan", "Choose plan")); }
  else if (gate === "engine_quantity") { v.lines.push("Every engine on your plan is in use. Add an engine to place another project."); v.actions.push(run("add_engine", "Add an engine")); }
  else if (gate === "plan_ended") { v.lines.push("Plan ended: the engine is stopped"); v.actions.push(run("renew", "Renew")); }
  else if (gate === "account_held") v.lines.push("This account is on hold, so an engine can't be placed right now");
  else if (gate === "unavailable") v.lines.push("The Engine plan isn't available right now");
  if (ctx.planNote) v.lines.push(ctx.planNote);
}

/** D#845 ON-8a: the install step's detail from a setup row ({ phase, sub_step, state }): the sub-step the running job last reported, `skipped` counting as done. Empty outside the install phase or for a name it does not know. */
export function installDetail(row) {
  if (!row || row.phase !== "install" || !Object.hasOwn(SUB_STEPS, row.sub_step)) return {};
  const state = row.state === "started" ? "running" : row.state === "skipped" ? "ok" : row.state;
  return { install: { sub_steps: [{ id: row.sub_step, state }] } };
}
/** D#845 ON-10b2: the closed reasons a failed survey records, in plain words (Ruling 88 item 10). The sentence they sit in is `FIXES.survey_failed`: "The survey stopped (<these words>)". */
const SURVEY_REASONS = {
  output_invalid: "its answer wasn't a usable plan",
  output_too_large: "its answer was too long",
  no_output: "it gave no answer",
  workspace_written: "it tried to change your files",
  run_failed: "the run failed",
  runner_lost: "your machine stopped answering",
  refused_at_admit: "your machine couldn't take it",
  cancelled: "it was cancelled",
  deadline: "it ran past 20 minutes",
};
/**
 * D#845 ON-10b2 (ON-6's fields): the plan step's detail from a setup row ({ phase, state, survey_run_id, failure_code, failure_reason }). A survey that started and has a run is "surveying" (with the run to open); one that started with
 * no run is "not_started". A failed survey (code `survey_failed` or `survey_timeout`) carries its reason in plain words for the existing failure line. Anything else, an unknown reason included, is empty.
 */
export function surveyDetail(row) {
  if (!row || row.phase !== "survey") return {};
  if (row.state === "started") return typeof row.survey_run_id === "string" && row.survey_run_id !== "" ? { plan: { stage: "surveying", run_id: row.survey_run_id } } : { plan: { stage: "not_started" } };
  if (row.state === "failed" && (row.failure_code === "survey_failed" || row.failure_code === "survey_timeout") && typeof row.failure_reason === "string" && Object.hasOwn(SURVEY_REASONS, row.failure_reason)) return { detail: { reason: SURVEY_REASONS[row.failure_reason] } };
  return {};
}
/**
 * One engine step's copy. `steps` is the engine track, `i` the step, `ctx` the view-model (every field optional):
 *   name, origin, isAdmin, offline, last_seen_min, price (the Engine plan's monthly price), planNote (a refused purchase's sentence, or the "Engine added" notice), planBusy
 *   machine { linked_silent, helper_missing, kvm: "present"|"absent", preflight: [{ code, fix }], doctor_reason, doctor: [{ code, ...detail }] }
 *   project { no_eligible_machine }   plan { stage: "surveying"|"not_started"|"draft", run_id }
 *   install { sub_steps: [{ id, state }], pr: { number, state: "open"|"closed" } }   live { operate: "on"|"off", silent_min, starting }
 * Returns { label, state, word, failed, lines, list, commands, actions }; an action with `app` is a hand-off to that app.
 */
export function describeStep(steps, i, ctx = {}) {
  const step = steps[i];
  const nm = ctx.name || "your machine";
  const v = { label: labelOf(steps, step.step), state: step.state, word: STATE_WORDS[step.state], failed: step.state === "failed", lines: [], list: [], commands: [], actions: [] };
  const fix = (code, d) => {
    const f = fixFor(code, nm, d);
    v.lines.push(f.text);
    if (f.cmd) v.commands.push({ label: "", text: f.cmd });
  };
  if (step.state === "failed") { fix(step.failure.code, ctx.detail); return v; }
  if (step.state === "pending") {
    const before = steps.slice(0, i).find((s) => s.state !== "done");
    if (before) v.lines.push("Finish " + labelOf(steps, before.step) + " first");
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
      // D#845 ON-21b: what the machine's own preflight found, each code's one fixed line (the cloud's, never retyped here), the same lines the Machines row shows. The reported `kvm_absent` line says it better than the generic
      // no-KVM sentence, so it takes that one's place; identical lines are said once.
      for (const text of preflightTexts(m.preflight)) {
        if (m.preflight.some((p) => p.code === "kvm_absent" && p.fix === text)) {
          const at = v.lines.indexOf(NO_KVM);
          if (at >= 0) v.lines.splice(at, 1);
        }
        v.lines.push(text);
      }
      break;
    case "claude":
      if (step.state === "done") v.lines.push(vmMode(steps) ? "A Claude token is set on " + nm : "Claude is signed in on " + nm);
      else if (ctx.offline) v.lines.push(Number.isInteger(ctx.last_seen_min) ? nm + " was last seen " + ctx.last_seen_min + " min ago" : nm + " is offline");
      else if (vmMode(steps)) { v.lines.push(VM_TOKEN_LINE, VM_TOKEN_STAYS); v.commands.push({ label: "", text: VM_TOKEN_COMMAND }); }
      else fix("claude_signed_out");
      break;
    case "github_app":
      v.lines.push(step.state === "done" ? "The GitHub App is installed with write access" : "Install the GitHub App with write access");
      if (step.state !== "done") v.actions.push(act("open_repos", "Open Repos", "repos"));
      break;
    case "project":
      if (step.plan_gate && (step.plan_gate === "plan_ended" || step.state !== "done")) {
        if (step.state === "done") v.lines.push("Your project is placed");
        planGate(v, step.plan_gate, ctx);
      } else if (step.state === "done") v.lines.push("Your project is placed");
      else if ((ctx.project || {}).no_eligible_machine) { v.lines.push("Every machine is full or offline"); v.actions.push(act("add_machine", "Add a machine", "runners")); }
      break;
    case "plan": {
      const p = ctx.plan || {};
      if (step.state === "done") v.lines.push("Your plan is approved");
      else if (p.stage === "surveying") { v.lines.push("Reading your code and docs…"); if (p.run_id) v.actions.push(act("open_run", "Open the run", "runs")); }
      else if (p.stage === "not_started") v.lines.push("The survey didn't start. Try again, or write your own plan.");
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
    const buttons = v.actions.filter((a) => a.run || env.canOpen(a.app)).map((a) => h("button", { type: "button", class: "ob-btn ob-btn-primary", "data-testid": "ob-engine-" + a.id, disabled: a.run && env.ctx.planBusy === true, onClick: () => (a.run ? env.runAction(a.id) : env.openApp(a.app)) }, a.label));
    return h("li", { class: "ob-step ob-engine-step" + (s.state === "done" ? " ob-done" : "") + (i === first ? " ob-current" : "") + (v.failed ? " ob-failed" : ""), "data-testid": "ob-engine-" + s.step, "data-state": s.state, "aria-current": i === first ? "step" : null },
      h("div", { class: "ob-step-head" }, h("strong", null, v.label),
        h("span", { class: "ob-state", "data-testid": "ob-engine-state" }, v.word, s.completed_at ? [" ", timeNode(s.completed_at, true)] : null)),
      v.lines.map((t) => h("p", { class: "ob-muted", "data-testid": "ob-engine-line" }, env.ctx.planLink && t === env.ctx.planNote && env.canOpen(BUDGET_APP) && t.includes(BUDGET_PHRASE) ? budgetLinked(t, env) : lineNodes(t, env.ctx.name))),
      v.list.length ? h("ul", { class: "ob-issues", "aria-label": "Install progress" }, v.list.map((x) => h("li", { "data-testid": "ob-engine-sub" }, x.label + ": " + x.word))) : null,
      v.commands.map((c) => commandBox(c, env)), buttons,
      // D#845 ON-7b: the picker lives in a host the app keeps across redraws; a member is told who can pick.
      s.step === "project" && s.state === "active" && !s.plan_gate ? (env.ctx.isAdmin === false ? h("p", { class: "ob-muted", "data-testid": "ob-engine-line" }, ASK_PICK) : env.projectHost || null) : null,
      // D#845 ON-20b: the install step's summary and merge, in a host the app keeps across redraws; it is there only while the pull request is open.
      s.step === "install" && s.state === "active" && s.pr_state === "open" && s.setup_id ? env.installHost || null : null);
  });
  return h("section", { class: "ob-track", "data-testid": "ob-track-engine", "aria-label": "Engine setup" },
    first === 0 ? h("div", { class: "ob-prereq", "data-testid": "ob-prereq" }, h("h3", { class: "ob-sub" }, "Before you start"),
      h("ul", { class: "ob-issues" }, prerequisites(env.price).map((t) => h("li", { "data-testid": "ob-prereq-line" }, t)))) : null,
    h("ol", { class: "ob-steps", "aria-label": "Engine setup steps" }, items));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// D#845 ON-7b: the project step's picker and confirm. The first half is pure (parsing the three reads, the machine list, the operate box, every refusal's sentence) and is unit-tested;
// the second draws it with h() only. Nothing is stored in the browser: the state lives in this closure, and what the server decides (the placement, the setup) is read again after.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const PUBLIC_COPY = "Anyone can open issues on a public repo, and the engine reads them. The engine starts work only from collaborators' items.";
export const COULDNT_CHECK = "Couldn't check";
export const NO_OWNERS = "Install the GitHub app first";
export const OWNERS_UNKNOWN = "Couldn't load your GitHub accounts";
export const NO_MACHINE = "Every machine is full or offline";
export const NEW_PRESET = "Balanced (the starting setting)";
export const PUBLIC_OPERATE = "Operate isn't available for public repos yet. The engine can watch this repo, but won't act on it.";
export const pickVisibility = (v) => visibilityLabel(v) || COULDNT_CHECK;
const PRESET_NAMES = { cautious: "Cautious", balanced: "Balanced", autonomous: "Autonomous" };
export const presetName = (p) => (typeof p === "string" && Object.hasOwn(PRESET_NAMES, p) ? PRESET_NAMES[p] : "Custom");
/** The confirm's dials line: the repo's own preset (a hand-moved dial is "Custom"), or the runtime's starting setting for a repo that has no dials yet. */
export const dialsLine = (repo, isNew) => "Dials: " + (isNew ? NEW_PRESET : presetName(repo && repo.active_preset));

/** GET /api/runners/repos/picker, or null when it is not that shape. A repo's visibility is "public", "private" or "unknown". */
export function readPicker(body) {
  if (!body || !Array.isArray(body.repos)) return null;
  const repos = body.repos.filter((r) => r && typeof r.id === "string" && UUID_RE.test(r.id) && typeof r.name === "string" && r.name !== "")
    .map((r) => ({ id: r.id.toLowerCase(), name: r.name, visibility: r.visibility === "public" || r.visibility === "private" ? r.visibility : "unknown", active_preset: typeof r.active_preset === "string" ? r.active_preset : null }));
  const owners = (Array.isArray(body.owners) ? body.owners : []).filter((o) => o && Number.isSafeInteger(o.gh_id) && o.gh_id > 0 && typeof o.login === "string" && o.login !== "").map((o) => ({ gh_id: o.gh_id, login: o.login }));
  return { repos, owners, ownersUnknown: body.owners_unknown === true };
}

/** "Linked 2026-11-20 from 203.0.113.9". No country: nothing here looks an address up. "" when the machine has no link facts (a member's read, an older machine). */
export function linkedLine(at, ip) {
  const d = typeof at === "string" ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return "Linked " + d.toISOString().slice(0, 10) + (typeof ip === "string" && ip !== "" ? " from " + ip : "");
}

/**
 * The machines the confirm offers, from GET /api/runners (names, state, link facts) and, when it answered, GET /api/machines (isolation tier and the project a machine hosts).
 * `ok` is whether it can take this project now; otherwise `note` says why. A standard-isolation machine that hosts a project is greyed, never hidden.
 */
export function machineChoices(runners, machines) {
  const extra = new Map((machines && Array.isArray(machines.machines) ? machines.machines : []).filter((m) => m && typeof m.id === "string").map((m) => [m.id, m]));
  return (runners && Array.isArray(runners.runners) ? runners.runners : []).filter((r) => r && typeof r.id === "string" && UUID_RE.test(r.id) && r.state !== "revoked").map((r) => {
    const m = extra.get(r.id) || {};
    const engine = r.facts && r.facts.engine;
    const tier = m.tier === "microvm" || m.tier === "standard" ? m.tier : engine === "microvm" ? "microvm" : engine === "os_sandbox" ? "standard" : null;
    const live = m.live === true || (m.live === undefined && (r.state === "online_idle" || r.state === "busy"));
    const full = machineChoiceLine({ tier, hasProject: !!m.running });
    return { id: r.id, name: typeof r.name === "string" && r.name.trim() !== "" ? r.name.trim() : "Unnamed machine", tier, linked: linkedLine(r.linked_at, r.linked_from_ip), ok: live && !full, note: !live ? "Offline" : full };
  });
}

/**
 * The operate box from GET /api/v1/engine/settings: `operate_others` are the enabled repos other than the chosen one. With operate already on there is nothing to consent to; with it off the box
 * says what ticking it also operates. A public repo cannot be operated yet, so its box is off. `null` settings (the read failed) show no box, and the placement leaves operate as it is.
 */
export function operateBox(settings, repoId, visibility) {
  if (!settings || typeof settings.operate_enabled !== "boolean") return null;
  const others = (Array.isArray(settings.repos) ? settings.repos : []).filter((r) => r && r.enabled === true && r.repo_id !== repoId && typeof r.repo_id === "string").map((r) => ({ id: r.repo_id, name: typeof r.full_name === "string" && r.full_name !== "" ? r.full_name : "a repo" }));
  if (settings.operate_enabled) return { on: true, others, text: "Operate is already on for this account, so the engine may act on this repo too." };
  const text = "Turn on operate for this account." + (others.length ? " This also operates " + others.length + " other " + (others.length === 1 ? "repo" : "repos") + ": " + others.map((o) => o.name).join(", ") : "");
  return { on: false, others, text, blocked: visibility === "public" ? PUBLIC_OPERATE : "" };
}

// Every refusal of the place route: by its closed code, then by status. `link` marks the one that points at the setup that already exists.
const PLACE_BY_CODE = {
  setup_exists: ["This repo is already being set up.", "setup"],
  account_not_active: ["This account isn't active, so a project can't be placed right now."],
  project_already_placed: ["This project is already placed on a machine."],
  machine_single_project: ["Standard isolation hosts one project, and that machine already has one. Pick another machine."],
  machine_not_eligible: ["That machine can't take a project right now. Pick another machine."],
  no_eligible_machine: [NO_MACHINE + ". Add a machine, or free one up.", "machine"],
  operate_consent_stale: ["The repos operate would also run have changed. Read the list again and confirm again."],
  operate_public_pending: [PUBLIC_OPERATE],
  placement_busy: ["The machine was busy with another change. Try again."],
};
const PLACE_BY_STATUS = { 400: "That request wasn't accepted. Reload the list and try again.", 403: "Only an owner or admin can place a project.", 404: "That repo wasn't found. Reload the list and pick again." };
/** `e` is anything the call threw; the text is never empty and never the server's own words. */
export function placeRefusal(e, name) {
  const code = e && typeof e.code === "string" ? e.code : "";
  if (code === "repo_visibility_unknown") return { code, text: "GitHub didn't say whether " + (name || "this repo") + " is public or private. Try again in a minute." };
  if (Object.hasOwn(PLACE_BY_CODE, code)) return { code, text: PLACE_BY_CODE[code][0], also: PLACE_BY_CODE[code][1] || "" };
  const status = e && typeof e.status === "number" ? e.status : 0;
  return { code, text: Object.hasOwn(PLACE_BY_STATUS, status) ? PLACE_BY_STATUS[status] : "The project couldn't be placed. Try again." };
}
const CREATE_BY_CODE = { install_first: NO_OWNERS, account_not_active: "This account isn't active, so a repo can't be created right now.", rate_limited: "You've created a lot of repos lately. Try again later.", github_app_not_configured: "Creating a repo isn't available right now.", validation_failed: "That name isn't a valid repo name. Use letters, numbers, dots, dashes and underscores." };
export const createRefusal = (e) => (e && Object.hasOwn(CREATE_BY_CODE, e.code) ? CREATE_BY_CODE[e.code] : e && e.status === 403 ? "Only an owner or admin can create a repo." : "The repo couldn't be created. Try again.");
// The words for where GitHub's authorization sent the browser back (`?create=<outcome>`). Only `ok` carries a repo id.
const CREATE_OUTCOMES = {
  created_not_connected: "The repo was created, but the GitHub App can't see it yet. Add it to the App's repos on GitHub, then reload.",
  name_taken: "A repo with that name already exists there. Pick another name.", visibility_not_allowed: "That owner doesn't allow that visibility. Pick the other one.",
  refused: "GitHub refused to create the repo.", github_busy: "GitHub was busy. Try again in a minute.", rate_limited: CREATE_BY_CODE.rate_limited, install_first: NO_OWNERS, failed: "The repo couldn't be created. Try again.",
};
/** What the page's query string says about a create that just returned: { outcome, repo } or null. The repo id is used only when the picker read lists it. */
export function parseReturn(search) {
  const p = new URLSearchParams(typeof search === "string" ? search : "");
  const outcome = p.get("create");
  if (outcome === "ok") return { outcome, repo: UUID_RE.test(p.get("repo") || "") ? p.get("repo").toLowerCase() : "" };
  return Object.hasOwn(CREATE_OUTCOMES, outcome || "") ? { outcome, repo: "" } : null;
}

/**
 * Draws the project step's picker into `host`. `env`: { announce, openApp, canOpen(id), onPlaced(), search, clearReturn(), signal }. Stages: loading, pick, create, confirm, placed.
 * Nothing is sent until Confirm (or "Continue to GitHub"), and every stage has a way back.
 */
export function mountProjectPicker(host, env) {
  const S = { stage: "loading", err: null, note: "", data: null, machines: [], settings: null, repo: null, isNew: false, runner: "", operate: false, owner: 0, name: "", vis: "private", busy: false, loadFailed: false };
  let dead = false;
  const bdi = (t) => h("bdi", null, t);
  const p = (t, id) => h("p", { class: "ob-muted", "data-testid": id }, t);
  const btn = (id, label, fn, o = {}) => h("button", { type: "button", class: "ob-btn" + (o.primary ? " ob-btn-primary" : ""), "data-testid": "ob-pick-" + id, "data-focus": id, disabled: o.disabled || S.busy, onClick: fn }, label);
  const go = (stage) => { S.stage = stage; S.err = null; S.note = ""; draw(); };
  function draw(focus) {
    if (dead) return;
    host.replaceChildren(h("div", { class: "ob-picker", "data-testid": "ob-picker", "data-stage": S.stage }, S.err ? h("p", { class: "ob-error", role: "alert", "data-testid": "ob-pick-error" }, S.err.text) : "", S.err && S.err.also === "setup" ? btn("see-setup", "See that setup", env.onPlaced) : "", S.err && S.err.also === "machine" && env.canOpen("runners") ? btn("add-machine", "Add a machine", () => env.openApp("runners")) : "", S.note ? p(S.note, "ob-pick-note") : "", view()));
    const f = focus && host.querySelector('[data-focus="' + focus + '"]');
    if (f) f.focus();
  }
  async function read() {
    S.loadFailed = false;
    try {
      const [picker, runners, machines, settings] = await Promise.all([api("GET", "/api/runners/repos/picker", undefined, env.signal), api("GET", "/api/runners", undefined, env.signal).catch(soft), api("GET", "/api/machines", undefined, env.signal).catch(soft), api("GET", "/api/v1/engine/settings", undefined, env.signal).catch(soft)]);
      S.data = readPicker(picker);
      if (!S.data) throw new Error("shape");
      S.machines = machineChoices(runners, machines);
      S.settings = settings;
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      S.loadFailed = true;
    }
  }
  const soft = (e) => { if (e && e.name === "AbortError") throw e; return null; };
  async function start() {
    S.stage = "loading"; draw();
    try { await read(); } catch { return; } // fx-swallow-ok: an aborted read means the picker was closed
    const back = parseReturn(env.search);
    if (back) {
      env.clearReturn();
      const hit = back.outcome === "ok" && S.data && S.data.repos.find((r) => r.id === back.repo);
      // `kind: "new"` is sent only for a repo this very read lists: the id in the address is never trusted on its own.
      if (hit) { choose(hit, true); return; }
      S.note = back.outcome === "ok" ? "The new repo isn't in your list yet. Reload the list to see it." : CREATE_OUTCOMES[back.outcome];
    }
    S.stage = S.loadFailed ? "failed" : "pick";
    draw();
  }
  function choose(repo, isNew) {
    S.repo = repo; S.isNew = isNew; S.operate = false; S.err = null; S.note = "";
    const first = S.machines.find((m) => m.ok);
    S.runner = first ? first.id : "";
    S.stage = "confirm"; draw();
    say("Confirm " + repo.name);
  }
  const say = (t) => env.announce(t);
  async function reload() { S.busy = true; draw(); try { await read(); } catch { return; } S.busy = false; if (S.loadFailed) S.stage = "failed"; else if (S.stage === "failed" || S.stage === "loading") S.stage = "pick"; draw(); } // fx-swallow-ok: an aborted read means the picker was closed
  async function install() {
    S.busy = true; draw();
    try {
      const res = await api("GET", "/api/v1/github/install-url?app_kind=team", undefined, env.signal);
      if (res && typeof res.url === "string" && res.url.startsWith("https://github.com/")) { window.location.assign(res.url); return; }
      throw new Error("link");
    } catch (e) {
      if (e && e.name === "AbortError") return;
      S.err = { text: e && e.status === 403 ? "Only an owner or admin can install the GitHub App." : "Installing the GitHub App isn't available right now." };
    }
    S.busy = false; draw();
  }
  async function createIntent() {
    const owner = S.data.owners.length === 1 ? S.data.owners[0] : S.data.owners.find((o) => o.gh_id === S.owner);
    if (!owner || !REPO_NAME_RE.test(S.name)) { S.err = { text: !owner ? "Choose who will own the repo." : createRefusal({ code: "validation_failed" }) }; draw(); return; }
    S.busy = true; S.err = null; draw();
    try {
      const res = await api("POST", "/api/v1/repos/create-intent", { owner_gh_id: owner.gh_id, name: S.name, visibility: S.vis }, env.signal);
      if (res && typeof res.authorize_url === "string" && res.authorize_url.startsWith("https://github.com/")) { window.location.assign(res.authorize_url); return; } // GitHub's own page; it returns here with ?create=<outcome>
      throw new Error("link");
    } catch (e) {
      if (e && e.name === "AbortError") return;
      S.err = { text: createRefusal(e), code: e && e.code };
    }
    S.busy = false; draw();
  }
  async function place() {
    const box = operateBox(S.settings, S.repo.id, S.repo.visibility);
    const ticked = !!box && !box.on && !box.blocked && S.operate;
    S.busy = true; S.err = null; draw();
    try {
      await api("POST", "/api/runners/repos/" + S.repo.id + "/place", { kind: S.isNew ? "new" : "existing", ...(S.runner ? { runner_id: S.runner } : {}), ...(ticked ? { turn_on_operate: true, operate_others: box.others.map((o) => o.id) } : {}) }, env.signal);
    } catch (e) {
      if (e && e.name === "AbortError") return;
      S.err = placeRefusal(e, S.repo.name);
      S.busy = false;
      if (["operate_consent_stale", "machine_single_project", "machine_not_eligible", "no_eligible_machine"].includes(S.err.code)) { S.operate = false; try { await read(); } catch { return; } } // fx-swallow-ok: an aborted read means the picker was closed
      if (S.loadFailed) S.stage = "failed";
      else if (S.runner && !(S.machines.find((m) => m.id === S.runner) || {}).ok) S.runner = (S.machines.find((m) => m.ok) || {}).id || "";
      draw();
      say(S.err.text);
      return;
    }
    S.busy = false; S.stage = "placed"; draw();
    say("Placed " + S.repo.name);
    env.onPlaced();
  }

  function createView() {
    const { owners, ownersUnknown } = S.data;
    const back = btn("back", "Back", () => go("pick"));
    if (ownersUnknown) return [p(OWNERS_UNKNOWN, "ob-pick-owners-unknown"), btn("retry-owners", "Try again", reload, { primary: true }), back];
    if (!owners.length) return [p(NO_OWNERS, "ob-pick-no-owner"), btn("install", "Install the GitHub App", install, { primary: true }), back];
    const field = (label, node) => h("label", { class: "ob-label" }, label, node);
    return [
      h("h3", { class: "ob-sub" }, "Create a new project"),
      owners.length === 1 ? p(["Owner: ", bdi(owners[0].login)], "ob-pick-owner")
        : field("Owner", h("select", { class: "ob-input", "data-testid": "ob-pick-owner", onChange: (ev) => { S.owner = Number(ev.target.value); } }, h("option", { value: "0" }, "Choose an owner"), owners.map((o) => h("option", { value: String(o.gh_id), selected: S.owner === o.gh_id }, o.login)))),
      field("Name", h("input", { class: "ob-input", type: "text", value: S.name, maxLength: 100, autocomplete: "off", "data-testid": "ob-pick-name", onInput: (ev) => { S.name = ev.target.value.trim(); } })),
      field("Visibility", h("select", { class: "ob-input", "data-testid": "ob-pick-vis", onChange: (ev) => { S.vis = ev.target.value; } }, h("option", { value: "private", selected: S.vis === "private" }, "Private"), h("option", { value: "public", selected: S.vis === "public" }, "Public"))),
      p("GitHub asks you to approve this. The repo is created under your own GitHub authority and stays on GitHub if you stop here.", "ob-pick-create-note"),
      btn("continue", "Continue to GitHub", createIntent, { primary: true }), back,
    ];
  }
  function confirmView() {
    const r = S.repo;
    const box = operateBox(S.settings, r.id, r.visibility);
    const choices = S.machines;
    const eligible = choices.some((m) => m.ok);
    return [
      h("h3", { class: "ob-sub" }, ["Set up ", bdi(r.name)]),
      p(pickVisibility(r.visibility) + (S.isNew ? " · new repo" : ""), "ob-pick-vis-line"),
      r.visibility === "public" ? p(PUBLIC_COPY, "ob-pick-public") : "",
      p(dialsLine(r, S.isNew), "ob-pick-dials"),
      h("fieldset", { class: "ob-fieldset" }, h("legend", null, "Machine"),
        choices.length ? choices.map((m) => h("label", { class: "ob-preset", "data-testid": "ob-pick-machine" },
          h("input", { type: "radio", name: "ob-machine", value: m.id, checked: S.runner === m.id, disabled: !m.ok || S.busy, onChange: () => { S.runner = m.id; draw("machine-" + m.id); }, "data-focus": "machine-" + m.id }),
          h("span", { class: "ob-preset-text" }, h("strong", null, bdi(m.name)), m.linked ? h("span", { class: "ob-preset-role", "data-testid": "ob-pick-linked" }, m.linked) : "", m.note ? h("span", { class: "ob-preset-role" }, m.note) : "")))
          : p("No machine is connected yet.", "ob-pick-no-machine"),
        eligible ? "" : [p(NO_MACHINE, "ob-pick-no-eligible"), env.canOpen("runners") ? btn("add-machine", "Add a machine", () => env.openApp("runners")) : ""]),
      box ? h("div", { class: "ob-operate", "data-testid": "ob-pick-operate" },
        box.on ? p(box.text, "ob-pick-operate-on")
          : h("label", { class: "ob-preset" }, h("input", { type: "checkbox", checked: S.operate && !box.blocked, disabled: !!box.blocked || S.busy, "data-focus": "operate", onChange: (ev) => { S.operate = ev.target.checked; draw("operate"); } }), h("span", { class: "ob-preset-text" }, box.text, box.blocked ? h("span", { class: "ob-preset-role" }, box.blocked) : ""))) : "",
      btn("confirm", S.busy ? "Placing…" : "Confirm", place, { primary: true, disabled: !S.runner || !choices.some((m) => m.id === S.runner && m.ok) }),
      btn("change", "Change repo", () => go("pick")),
    ];
  }
  function view() {
    if (S.stage === "loading") return [p("Loading your repos…", "ob-pick-loading")];
    if (S.stage === "failed") return [p("Your repos couldn't be loaded.", "ob-pick-load-failed"), btn("retry", "Try again", reload, { primary: true })];
    if (S.stage === "create") return createView();
    if (S.stage === "confirm") return confirmView();
    if (S.stage === "placed") return [p(["Placed ", bdi(S.repo.name), "."], "ob-pick-placed")];
    return [
      S.data.repos.length ? h("ul", { class: "ob-issues", "aria-label": "Your repos" }, S.data.repos.map((r) => h("li", null, h("button", { type: "button", class: "ob-btn ob-repo", "data-testid": "ob-pick-repo", "data-repo": r.id, onClick: () => choose(r, false) }, bdi(r.name), " · ", pickVisibility(r.visibility)))))
        : p("You have no repos yet. Create a new project.", "ob-pick-empty"),
      btn("create", "Create a new project", () => go("create")), btn("reload", "Reload the list", reload),
    ];
  }
  start();
  return { destroy() { dead = true; host.replaceChildren(); } };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// D#845 ON-20b: the install step's inline panel. The first half is pure (reading the summary, every refusal's sentence) and is unit-tested; the second draws it with h() only, so the
// server's labels, paths and sentences are always text. The summary and the merge are ON-20a's two routes; the person's click is the only thing that merges (nothing here merges by itself).
// It lives in this file, not a file of its own: the boot budget's request cap is full (136), and this file already counts as the one extra request.
export const INSTALL_COPY = {
  merge: "Merge and continue", copyLink: "Copy a link for someone who can merge", view: "View on GitHub",
  changes: "What merging changes", undo: "How to undo it", undoText: "Remove the project, or revert the merge on GitHub",
  member: "Only an owner or admin can merge this. Copy the link and send it to someone who can.",
  differ: "The pull request no longer holds the files we prepared, so it was not merged. Open it on GitHub to see what changed, or remove the project and start the install again.",
  blocked: "GitHub will not merge this yet; it may need a passing check or a review first. Finish those on GitHub, then try again.",
  changed: "The pull request changed on GitHub, so the summary was read again. Look it over, then merge.",
  merged: "Merged. This step finishes when GitHub confirms it.",
  alreadyMerged: "This pull request is already merged. This step finishes when GitHub confirms it.",
  loading: "Reading what the pull request changes…", loadFailed: "The summary couldn't be loaded. Try again.", mergeFailed: "The pull request couldn't be merged. Try again.",
  gone: "This setup has no install pull request to look at right now.",
  show: (n) => "Show every file (" + n + ")",
};
const COUNT = (v) => Number.isInteger(v) && v >= 0;
const PATHS_SHOWN = 300;
/** The install step's pull request from the engine track (open or closed; a merged one has nothing left to review), for `ctx.install.pr`. Null when the step does not carry a valid one. */
export function installPr(steps) {
  const s = Array.isArray(steps) ? steps.find((x) => x && x.step === "install") : null;
  return s && Number.isInteger(s.pr_number) && s.pr_number > 0 && (s.pr_state === "open" || s.pr_state === "closed") ? { number: s.pr_number, state: s.pr_state } : null;
}
/** GET /api/v1/setups/:id/install/summary, or null when it is not that shape for this setup. The link is kept only when it is a github.com address. */
export function readInstallSummary(body, setupId) {
  if (!body || typeof body !== "object" || typeof body.setup_id !== "string" || body.setup_id.toLowerCase() !== String(setupId).toLowerCase()) return null;
  const url = typeof body.pr_url === "string" && /^https:\/\/github\.com\/[^\s]+$/.test(body.pr_url) ? body.pr_url : "";
  const cats = body.categories;
  if (!url || !Number.isInteger(body.pr_number) || !Array.isArray(cats) || !Array.isArray(body.paths) || !body.totals || !COUNT(body.totals.files)) return null;
  const categories = [];
  for (const c of cats.slice(0, 12)) {
    if (!c || typeof c.id !== "string" || typeof c.label !== "string" || c.label === "" || c.label.length > 300) return null;
    if (![c.files, c.added_files, c.changed_files, c.additions, c.deletions].every(COUNT)) return null;
    categories.push({ id: c.id, label: c.label, files: c.files, added: c.added_files, changed: c.changed_files, additions: c.additions, deletions: c.deletions });
  }
  const paths = body.paths.filter((x) => typeof x === "string" && x !== "" && x.length <= 300);
  return { number: body.pr_number, url, merged: body.merged === true, total: body.totals.files, categories, paths: paths.slice(0, PATHS_SHOWN), morePaths: Math.max(0, paths.length - PATHS_SHOWN) };
}
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);
/** "3 files: 2 added, 1 changed (+40 -2 lines)". */
export const categoryCounts = (c) => plural(c.files, "file", "files") + ": " + c.added + " added, " + c.changed + " changed (+" + c.additions + " -" + c.deletions + " lines)";
/** What a refused call says. `code` is the server's closed code; `rebuild` means read the summary again. A sentence of the server's is shown only for `install_pr_blocked` (Ruling 96). */
export function installRefusal(e, reading) {
  const code = e && typeof e.code === "string" ? e.code : "";
  const status = e && typeof e.status === "number" ? e.status : 0;
  if (code === "install_pr_changed") return { code, text: INSTALL_COPY.changed, rebuild: true };
  if (code === "install_pr_files_differ") return { code, text: INSTALL_COPY.differ };
  if (code === "install_pr_blocked") return { code, text: typeof e.message === "string" && e.message.trim() !== "" && e.message.length <= 300 ? e.message.trim() : INSTALL_COPY.blocked };
  if (status === 403) return { code, text: INSTALL_COPY.member };
  if (status === 404 || code === "setup_phase") return { code, text: INSTALL_COPY.gone, reread: true };
  return { code, text: reading ? INSTALL_COPY.loadFailed : INSTALL_COPY.mergeFailed };
}

/**
 * Draws the install step's summary and the merge into `host`. `env`: { setupId, announce, isAdmin(), onChanged(), signal }. Stages: loading, ready, failed, merged.
 * A member sees Merge disabled with the reason; the summary is open to every member, and so is the link to hand to someone who can merge.
 */
export function mountInstallPanel(host, env) {
  const S = { stage: "loading", sum: null, err: null, note: "", busy: false };
  let dead = false;
  const path = "/api/v1/setups/" + env.setupId + "/install/";
  const btn = (id, label, fn, o = {}) => h("button", { type: "button", class: "ob-btn" + (o.primary ? " ob-btn-primary" : ""), "data-testid": "ob-install-" + id, "data-focus": id, disabled: o.disabled, onClick: fn }, label);
  function draw(focus) {
    if (dead) return;
    host.replaceChildren(h("div", { class: "ob-install", "data-testid": "ob-install", "data-stage": S.stage }, S.err ? h("p", { class: "ob-error", role: "alert", "data-testid": "ob-install-error" }, S.err.text) : "", S.note ? h("p", { class: "ob-muted", "data-testid": "ob-install-note" }, S.note) : "", view()));
    const f = focus && host.querySelector('[data-focus="' + focus + '"]');
    if (f) f.focus();
  }
  async function read(note) {
    S.stage = "loading"; S.err = null; S.note = note || ""; draw();
    try {
      const sum = readInstallSummary(await api("GET", path + "summary", undefined, env.signal), env.setupId);
      if (!sum) throw new Error("shape");
      S.sum = sum; S.stage = sum.merged ? "merged" : "ready";
      if (sum.merged) S.note = INSTALL_COPY.alreadyMerged;
    } catch (e) {
      if (e && e.name === "AbortError") return;
      S.stage = "failed"; S.err = installRefusal(e, true);
      if (S.err.reread) env.onChanged();
    }
    if (S.note) env.announce(S.note);
    draw();
  }
  async function merge() {
    if (S.busy || !env.isAdmin()) return;
    S.busy = true; S.err = null; draw("merge");
    try {
      await api("POST", path + "merge", undefined, env.signal);
      S.busy = false; S.stage = "merged"; S.note = INSTALL_COPY.merged;
      env.announce(S.note); draw(); env.onChanged();
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;
      const r = installRefusal(e, false);
      S.busy = false;
      if (r.rebuild) { await read(r.text); return; }
      S.err = r;
      if (r.reread) env.onChanged();
    }
    draw("merge");
  }
  const link = () => h("a", { class: "ob-btn", href: S.sum.url, target: "_blank", rel: "noopener noreferrer", "data-testid": "ob-install-view" }, INSTALL_COPY.view);
  function view() {
    if (S.stage === "loading") return [h("p", { class: "ob-muted", "data-testid": "ob-install-loading" }, INSTALL_COPY.loading)];
    if (S.stage === "failed") return [btn("retry", "Try again", () => read(), { primary: true })];
    const sum = S.sum, admin = env.isAdmin(), open = S.stage === "ready";
    return [
      h("h4", { class: "ob-sub" }, INSTALL_COPY.changes),
      h("ul", { class: "ob-issues", "aria-label": INSTALL_COPY.changes }, sum.categories.map((c) => h("li", { "data-testid": "ob-install-cat", "data-cat": c.id }, h("span", { "data-testid": "ob-install-cat-label" }, c.label), " ", h("span", { class: "ob-muted" }, categoryCounts(c))))),
      h("details", { class: "ob-paths", "data-testid": "ob-install-paths" }, h("summary", null, INSTALL_COPY.show(sum.paths.length + sum.morePaths)),
        h("ul", { class: "ob-issues" }, sum.paths.map((x) => h("li", null, h("code", { class: "ob-code" }, x))), sum.morePaths ? h("li", { class: "ob-muted" }, "and " + sum.morePaths + " more") : "")),
      h("h4", { class: "ob-sub" }, INSTALL_COPY.undo), h("p", { class: "ob-muted", "data-testid": "ob-install-undo" }, INSTALL_COPY.undoText),
      open && !admin ? h("p", { class: "ob-muted", "data-testid": "ob-install-member" }, INSTALL_COPY.member) : "",
      h("div", { class: "ob-actions" }, open ? btn("merge", INSTALL_COPY.merge, merge, { primary: true, disabled: S.busy || !admin }) : "",
        open ? btn("copy", INSTALL_COPY.copyLink, () => copyText(S.sum.url, env.announce)) : "", link()),
    ];
  }
  read();
  return { destroy() { dead = true; host.replaceChildren(); } };
}
