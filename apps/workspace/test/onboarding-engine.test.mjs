// apps/workspace/test/onboarding-engine.test.mjs
//
// D#845 ON-6: the engine track's copy (apps/onboarding/onboarding-engine.js) and the parsing of both tracks (core/onboarding-mode.js).
// Every row of the track's state table has a fixture and an assertion on its copy. The drawn screen (the track choice, Copy buttons, phone and
// tablet layout) is in e2e/onboarding.spec.ts.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PREFLIGHT_CODES, PREFLIGHT_FIX, preflightView } from "../../../packages/runner-protocol/src/preflight.ts";
import { parseSteps, parseTracks, shownTracks } from "../shell/core/onboarding-mode.js";
import {
  ASK_OWNER, LABELS, NO_KVM, OPERATE_OFF, STATE_WORDS, TIME_TO_LIVE,
  CHECKING_MACHINE, CHECK_TRIES, CHECK_WAIT_MS, COULDNT_CHECK, NEW_PRESET, NO_MACHINE, NO_OWNERS, PUBLIC_COPY, PUBLIC_OPERATE, createRefusal, dialsLine, isLoadPending, linkedLine, machineChoices, operateBox, parseReturn, pickVisibility, placeRefusal, presetName, readPicker,
  cleanOrigin, copyText, describeStep, enginePrice, installDetail, surveyDetail, twinDetail, fixFor, machineChoiceLine, machineCommands, machineContext, prerequisites, visibilityLabel,
  approveWords, approvedLine, draftRefusal, engineSection, planProblems, readDraft, retryRefusal, toRoadmap,
} from "../apps/onboarding/onboarding-engine.js";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1", "getOnboarding");
const fixture = (name) => JSON.parse(readFileSync(join(V1, name), "utf8"));
const IDS = ["machine", "claude", "github_app", "project", "plan", "install", "live"];
const T = "2026-11-20T10:00:00.000Z";
/** The engine track with each named step in the given state (the rest pending; the first not-done step the caller names active). */
const track = (states, extra = {}) => IDS.map((id) => {
  const state = states[id] || "pending";
  return { step: id, state, completed_at: state === "done" ? T : null, tier: id === "machine" ? extra.tier ?? null : null, failure: state === "failed" ? { code: extra.code || "survey_failed", at: T } : null };
});
const ORIGIN = "https://cloud.example.test";
const at = (steps, id, ctx = {}) => describeStep(steps, IDS.indexOf(id), { name: "box-1", origin: ORIGIN, ...ctx });
const text = (v) => v.lines.join("\n");

// D#845 ON-21b: the machine step shows the machine's preflight codes with the cloud's fixed lines. The data is built the way the server builds it (preflightView over the stored codes),
// parsed the way the app parses a response, then rendered: every code in the closed set has its line on the screen.
describe("the machine step's preflight lines (ON-21b)", () => {
  const body = () => fixture("200-new.json");
  const withPreflight = (preflight) => parseTracks({ ...body(), tracks: [body().tracks[0], { ...body().tracks[1], steps: body().tracks[1].steps.map((s, i) => (i === 0 ? { ...s, state: "done", completed_at: T, tier: "standard", ...(preflight === undefined ? {} : { preflight }) } : s)) }] }).engine;
  const render = (codes, ctx = {}) => {
    const steps = withPreflight(preflightView(codes));
    return describeStep(steps, 0, { name: "box-1", origin: ORIGIN, machine: { preflight: steps[0].preflight, ...ctx } });
  };

  it("every code has a fixture: its fixed line is on the machine step, and only that code's", () => {
    for (const code of PREFLIGHT_CODES) {
      const v = render([code]);
      expect(v.lines, code).toContain(PREFLIGHT_FIX[code]);
      expect(v.lines.filter((l) => l === PREFLIGHT_FIX[code]), code).toHaveLength(1);
      expect(v.commands, code).toEqual([]);
    }
  });

  it("several codes show their lines in the protocol's order, identical lines once, and no line carries null or undefined", () => {
    const v = render(["dns_failed", "unchecked:disk", "kvm_absent", "unchecked:memory"]);
    expect(v.lines.slice(1)).toEqual([PREFLIGHT_FIX.kvm_absent, PREFLIGHT_FIX.dns_failed, PREFLIGHT_FIX["unchecked:disk"]]);
    expect(text(v)).not.toMatch(/null|undefined/);
  });

  it("every check passing (an empty list), and a machine that has not said, add no line", () => {
    const connected = describeStep(withPreflight(undefined), 0, { name: "box-1", origin: ORIGIN, machine: {} }).lines;
    expect(render([]).lines).toEqual(connected);
    expect(parseTracks({ ...body(), tracks: [body().tracks[0], body().tracks[1]] }).engine[0]).not.toHaveProperty("preflight");
    expect(withPreflight([])[0].preflight).toEqual([]);
  });

  it("the reported kvm_absent line takes the place of the generic no-KVM sentence, and the sentence stays for a machine whose preflight did not report it", () => {
    const reported = render(["kvm_absent"], { kvm: "absent" });
    expect(reported.lines).toContain(PREFLIGHT_FIX.kvm_absent);
    expect(reported.lines).not.toContain(NO_KVM);
    const unreported = render([], { kvm: "absent" });
    expect(unreported.lines).toContain(NO_KVM);
  });

  it("an open machine step shows them too, after its own lines", () => {
    const steps = withPreflight(preflightView(["net_blocked:cloud"])).map((s, i) => (i === 0 ? { ...s, state: "active", completed_at: null } : s));
    const v = describeStep(steps, 0, { name: "box-1", origin: ORIGIN, machine: { preflight: steps[0].preflight } });
    expect(v.lines.at(-1)).toBe(PREFLIGHT_FIX["net_blocked:cloud"]);
  });

  it("the parser keeps only { code, fix } pairs of short strings, on the machine step only, and a value that is not a list is not said", () => {
    const m = (preflight) => withPreflight(preflight)[0];
    expect(m([{ code: "kvm_absent", fix: "Fixed" }, { code: 1, fix: "x" }, { code: "a" }, null, { code: "b", fix: "" }, { code: "c", fix: "y".repeat(401) }]).preflight).toEqual([{ code: "kvm_absent", fix: "Fixed" }]);
    for (const bad of ["kvm_absent", 3, { code: "a", fix: "b" }, true]) expect(m(bad), JSON.stringify(bad)).not.toHaveProperty("preflight");
    const other = parseTracks({ ...body(), tracks: [body().tracks[0], { ...body().tracks[1], steps: body().tracks[1].steps.map((s) => ({ ...s, preflight: [{ code: "kvm_absent", fix: "Fixed" }] })) }] }).engine;
    for (const s of other.slice(1)) expect(s).not.toHaveProperty("preflight");
  });
});

describe("parseTracks and parseSteps", () => {
  it("reads both tracks of every contract fixture, the pipeline first", () => {
    for (const name of ["200-new.json", "200-step3.json", "200-pay.json", "200-skipped.json", "200-complete.json"]) {
      const body = fixture(name);
      const parsed = parseTracks(body);
      expect(parsed.pipeline.map((s) => s.step)).toEqual(["model_key", "readonly_app", "preview", "pay", "write_app", "first_pr"]);
      expect(parsed.engine.map((s) => s.step)).toEqual(IDS);
      expect(parseSteps(body)).toEqual(parsed.pipeline);
    }
  });

  // D#845 ON-6c: the machine step's optional kvm and helper_missing are kept (closed values only), on the machine step only; an old body without them reads as unsaid.
  it("keeps the machine step's kvm and helper_missing, drops anything outside the closed values, and reads an old body as unsaid", () => {
    const body = fixture("200-new.json");
    const withMachine = (extra) => parseTracks({ ...body, tracks: [body.tracks[0], { ...body.tracks[1], steps: body.tracks[1].steps.map((s, i) => (i === 0 ? { ...s, ...extra } : { ...s, kvm: "present", helper_missing: true })) }] }).engine;
    const m = (extra) => withMachine(extra)[0];
    expect(m({ kvm: "present", helper_missing: true })).toMatchObject({ kvm: "present", helper_missing: true });
    expect(m({ kvm: "absent" })).toMatchObject({ kvm: "absent" });
    expect(m({ kvm: "absent" })).not.toHaveProperty("helper_missing");
    for (const bad of [{ kvm: "yes" }, { kvm: null }, { kvm: true }, { helper_missing: false }, { helper_missing: "true" }]) {
      expect(m(bad), JSON.stringify(bad)).not.toHaveProperty("kvm");
      expect(m(bad), JSON.stringify(bad)).not.toHaveProperty("helper_missing");
    }
    const old = parseTracks(body).engine[0];
    expect(old).not.toHaveProperty("kvm");
    expect(old).not.toHaveProperty("helper_missing");
    for (const other of withMachine({}).slice(1)) {
      expect(other).not.toHaveProperty("kvm");
      expect(other).not.toHaveProperty("helper_missing");
    }
  });

  it("the gate and the strip read tracks[0], not the top-level list", () => {
    const body = fixture("200-new.json");
    const moved = { ...body, steps: [], tracks: [{ ...body.tracks[0], steps: fixture("200-complete.json").steps }, body.tracks[1]] };
    expect(parseSteps(moved).every((s) => s.completed_at !== null)).toBe(true);
    expect(parseSteps({ steps: body.steps })).toBeNull(); // a body without `tracks` does not fit
  });

  it("a broken engine track leaves the pipeline track readable (engine is null) and never touches the pipeline read the gate relies on", () => {
    const body = fixture("200-new.json");
    const broken = { ...body, tracks: [body.tracks[0], { ...body.tracks[1], steps: body.tracks[1].steps.slice(1) }] };
    const parsed = parseTracks(broken);
    expect(parsed.engine).toBeNull();
    expect(parsed.pipeline).toHaveLength(6);
    expect(parseSteps(broken)).toHaveLength(6);
  });

  it("refuses an engine step whose state, time, tier or failure disagree", () => {
    const body = fixture("200-new.json");
    const first = body.tracks[1].steps[0];
    const bad = [
      { ...first, state: "done" }, // done without a time
      { ...first, completed_at: T }, // a time on a step that is not done
      { ...first, state: "failed" }, // failed without its failure
      { ...first, failure: { code: "survey_failed", at: T } }, // a failure on a step that did not fail
      { ...first, state: "failed", failure: { code: "", at: T } },
      { ...first, state: "failed", failure: { code: "x", at: "not a time" } },
      { ...first, tier: "hypervisor" },
      { ...first, state: "stuck" },
      { ...first, step: "claude" },
    ];
    for (const s of bad) expect(parseTracks({ ...body, tracks: [body.tracks[0], { ...body.tracks[1], steps: [s, ...body.tracks[1].steps.slice(1)] }] }).engine).toBeNull();
    for (const t of [null, "x", {}, { tracks: [] }, { tracks: [body.tracks[1], body.tracks[0]] }]) expect(parseTracks(t)).toBeNull();
    expect(parseTracks({ ...body, tracks: [{ ...body.tracks[0], chosen_at: "later" }, body.tracks[1]] })).toBeNull();
    expect(parseTracks({ ...body, tracks: [body.tracks[0], { ...body.tracks[1], chosen_at: "later" }] })).toBeNull();
  });
});

describe("the track choice (criterion 3)", () => {
  const parsed = (chosen, pipelineDone = 0) => {
    const body = fixture("200-new.json");
    body.tracks[0].steps = body.tracks[0].steps.map((s, i) => (i < pipelineDone ? { ...s, completed_at: T } : s));
    body.tracks[0].chosen_at = chosen.pipeline || null;
    body.tracks[1].chosen_at = chosen.engine || null;
    return parseTracks(body);
  };
  it("a first visit shows no track, so the screen offers the choice", () => {
    expect(shownTracks(parsed({}))).toEqual([]);
  });
  it("shows each chosen track, in the order they were chosen", () => {
    expect(shownTracks(parsed({ engine: T }))).toEqual(["engine"]);
    expect(shownTracks(parsed({ pipeline: T }))).toEqual(["pipeline"]);
    expect(shownTracks(parsed({ pipeline: "2026-11-20T09:00:00.000Z", engine: T }))).toEqual(["pipeline", "engine"]);
    expect(shownTracks(parsed({ pipeline: T, engine: "2026-11-20T09:00:00.000Z" }))).toEqual(["engine", "pipeline"]);
  });
  it("an account that already made pipeline progress before tracks existed keeps its pipeline view, and never gets the engine track unasked", () => {
    expect(shownTracks(parsed({}, 2))).toEqual(["pipeline"]);
  });
  it("the engine track alone, and a track chosen with nothing else started, each show only themselves", () => {
    expect(shownTracks(parsed({ engine: T }, 3))).toEqual(["pipeline", "engine"]); // pipeline progress keeps its view beside the chosen engine
    expect(shownTracks(parsed({ engine: T }))).toEqual(["engine"]);
  });
});

describe("the engine track's states (criterion 1: one fixture and one copy assertion per row)", () => {
  it("any / blocked: a step after an unfinished one says which to finish", () => {
    const steps = track({ machine: "active" });
    expect(text(at(steps, "claude"))).toBe("Finish Connect a machine first");
    expect(text(at(steps, "live"))).toBe("Finish Connect a machine first");
    expect(at(steps, "claude").word).toBe("Waiting");
    const later = track({ machine: "done", claude: "active" });
    expect(text(at(later, "plan"))).toBe("Finish Sign in to Claude on the machine first");
  });

  it("every step reads its generic state when no detail is known: a word and no guess", () => {
    const steps = track({ machine: "done", claude: "done", github_app: "active" });
    for (const id of ["project", "plan", "install"]) expect(at(steps, id).lines).toEqual(["Finish Install the GitHub App (write) first"]);
    const active = track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "done", install: "active" });
    expect(at(active, "install").lines).toEqual([]);
    expect(at(active, "install").word).toBe("Up next");
    expect(at(track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "active" }), "plan").lines).toEqual([]);
    expect(Object.values(STATE_WORDS)).toEqual(["Done", "Up next", "Waiting", "Needs attention"]);
  });

  it("machine / open: the commands from this origin, with a waiting line", () => {
    const v = at(track({ machine: "active" }), "machine");
    expect(v.commands.map((c) => c.text)).toEqual([
      "curl -fsSL https://claude.ai/install.sh | bash",
      "claude",
      "curl -fsSL https://cloud.example.test/install.sh | sh",
      "fx-runner setup --cloud-url https://cloud.example.test",
    ]);
    expect(v.lines).toEqual(["It prints a code. Open https://cloud.example.test/link and type the code there.", "Waiting for your machine…"]);
  });

  it("machine / open: an origin that is not a plain http(s) origin never reaches a command", () => {
    for (const bad of ["", "null", "javascript:alert(1)", "https://a b", "https://x.test/path", "https://x.test?x=1", undefined, 5]) {
      expect(cleanOrigin(bad)).toBe("");
      expect(machineCommands(bad).map((c) => c.text)).toEqual(["curl -fsSL https://claude.ai/install.sh | bash", "claude"]);
    }
    expect(machineCommands("http://localhost:3000").at(-1).text).toBe("fx-runner setup --cloud-url http://localhost:3000");
  });

  it("machine / open: a host with shell metacharacters, userinfo or non-ASCII letters never reaches a command", () => {
    const bad = ["https://a;b.com", "https://x$(id).com", "https://x`id`.com", "https://u:p@evil.com", "https://m\u00fcnchen.example", "https://\u4f8b\u3048.jp", "https://x.test:80a", "https://x.test:", "https://[::1", "https://[zz]", "https://a|b.com", "https://a&b.com", "https://a'b.com", "https://a\"b.com", "https://x.test\n", "https://"];
    for (const o of bad) {
      expect(cleanOrigin(o)).toBe("");
      expect(machineCommands(o).map((c) => c.text)).toEqual(["curl -fsSL https://claude.ai/install.sh | bash", "claude"]);
    }
    for (const o of ["https://cloud.example.test:8443", "https://cloud-1.example.test", "http://127.0.0.1:3000", "https://[::1]", "https://[2001:db8::1]:8443"]) {
      expect(cleanOrigin(o)).toBe(o);
      expect(machineCommands(o).at(-1).text).toBe("fx-runner setup --cloud-url " + o);
    }
  });

  it("machine / linked, no hello in 3 min", () => {
    const v = at(track({ machine: "active" }), "machine", { machine: { linked_silent: true } });
    expect(v.lines).toEqual(["Not started yet. On box-1 run fx-runner service status"]);
    expect(v.commands.map((c) => c.text)).toEqual(["fx-runner service status"]);
  });

  it("machine / KVM present, helper missing", () => {
    const v = at(track({ machine: "active" }), "machine", { machine: { helper_missing: true } });
    expect(v.lines).toEqual(["box-1 can run microVMs. Run sudo fx-runner vm install on it."]);
    expect(v.commands.map((c) => c.text)).toEqual(["sudo fx-runner vm install"]);
  });

  it("machine / helper not ready or out of date: doctor's closed reason with its fix line", () => {
    const steps = track({ machine: "active" });
    const notReady = at(steps, "machine", { machine: { doctor_reason: "microvm_helper_not_ready" } });
    expect(notReady.lines).toEqual(["The microVM helper on box-1 isn't ready. Restart it:"]);
    expect(notReady.commands.map((c) => c.text)).toEqual(["sudo systemctl restart fx-vmhelper"]);
    const old = at(steps, "machine", { machine: { doctor_reason: "microvm_helper_out_of_date" } });
    expect(old.lines).toEqual(["The microVM helper on box-1 is out of date. Update it:"]);
    expect(old.commands.map((c) => c.text)).toEqual(["sudo fx-runner vm install"]);
  });

  it("machine / done: the tier is in the words (criterion 16)", () => {
    const micro = at(track({ machine: "done" }, { tier: "microvm" }), "machine");
    expect(micro.lines).toEqual(["box-1 connected · MicroVM isolation"]);
    expect(micro.word).toBe("Done");
    const std = at(track({ machine: "done" }, { tier: "standard" }), "machine");
    expect(std.lines).toEqual(["box-1 connected · Standard isolation"]); // ON-6b: the hardware is not known, so no claim about KVM
    const absent = at(track({ machine: "done" }, { tier: "standard" }), "machine", { machine: { kvm: "absent" } });
    expect(absent.lines).toEqual(["box-1 connected · Standard isolation", NO_KVM]);
    const present = at(track({ machine: "done" }, { tier: "standard" }), "machine", { machine: { kvm: "present" } });
    expect(present.lines).toEqual(["box-1 connected · Standard isolation"]); // KVM there, nothing said about the helper: never the no-KVM line
    const noHelper = at(track({ machine: "done" }, { tier: "standard" }), "machine", { machine: { kvm: "present", helper_missing: true } });
    expect(noHelper.lines).toEqual(["box-1 connected · Standard isolation", "box-1 can run microVMs. Run sudo fx-runner vm install on it."]);
    expect(noHelper.commands.map((c) => c.text)).toEqual(["sudo fx-runner vm install"]);
    expect(text(noHelper)).not.toContain(NO_KVM);
    const micro2 = at(track({ machine: "done" }, { tier: "microvm" }), "machine", { machine: { kvm: "absent" } });
    expect(micro2.lines).toEqual(["box-1 connected · MicroVM isolation"]);
    expect(NO_KVM).toBe("This machine has no KVM, so jobs run in the OS sandbox. That's fine for one project.");
    expect(at(track({ machine: "done" }), "machine").lines).toEqual(["box-1 connected"]); // a machine that has not said its tier
  });

  it("no KVM is normal: no failure styling, no failure word, no failure copy (criterion 16)", () => {
    const v = at(track({ machine: "done" }, { tier: "standard" }), "machine", { machine: { doctor: [{ code: "microvm_no_kvm" }] } });
    expect(v.failed).toBe(false);
    expect(v.state).toBe("done");
    expect(v.word).not.toMatch(/attention|fail|warn/i);
    expect(text(v)).not.toMatch(/fail|warn|error|problem|attention|stopped/i);
    // while the step is still open, a doctor line for a machine with no KVM is informational and does not mark the step failed
    const open = at(track({ machine: "active" }), "machine", { machine: { doctor: [{ code: "microvm_no_kvm" }] } });
    expect(open.failed).toBe(false);
    expect(open.lines).toContain("No KVM on box-1. It will use Standard isolation (one project)");
  });

  it("claude / open, and offline", () => {
    const steps = track({ machine: "done", claude: "active" });
    const open = at(steps, "claude");
    expect(open.lines).toEqual(["Run claude on box-1 and sign in"]);
    expect(open.commands.map((c) => c.text)).toEqual(["claude"]);
    expect(at(steps, "claude", { offline: true, last_seen_min: 12 }).lines).toEqual(["box-1 was last seen 12 min ago"]);
    expect(at(steps, "claude", { offline: true }).lines).toEqual(["box-1 is offline"]);
  });

  it("project / no eligible machine; a full standard machine is greyed with its reason", () => {
    const steps = track({ machine: "done", claude: "done", github_app: "done", project: "active" });
    const v = at(steps, "project", { project: { no_eligible_machine: true } });
    expect(v.lines).toEqual(["Every machine is full or offline"]);
    expect(v.actions).toEqual([{ id: "add_machine", label: "Add a machine", app: "runners" }]);
    expect(machineChoiceLine({ tier: "standard", hasProject: true })).toBe("Standard isolation hosts one project");
    expect(machineChoiceLine({ tier: "standard", hasProject: false })).toBe("");
    expect(machineChoiceLine({ tier: "microvm", hasProject: true })).toBe("");
    expect(machineChoiceLine(null)).toBe("");
  });

  it("project / the repo picker says Public or Private", () => {
    expect(visibilityLabel("public")).toBe("Public");
    expect(visibilityLabel("private")).toBe("Private");
    for (const unknown of ["unknown", "", null, undefined, 3]) expect(visibilityLabel(unknown)).toBe("");
  });

  it("plan / surveying, draft ready, failed", () => {
    const steps = track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "active" });
    const surveying = at(steps, "plan", { plan: { stage: "surveying", run_id: "r1" } });
    expect(surveying.lines).toEqual(["Reading your code and docs…"]);
    expect(surveying.actions).toEqual([{ id: "open_run", label: "Open the run", app: "runs" }]);
    expect(at(steps, "plan", { plan: { stage: "surveying" } }).actions).toEqual([]);
    expect(at(steps, "plan", { plan: { stage: "draft" } }).lines).toEqual(["Your plan is ready to review"]);
    const failed = track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "failed" }, { code: "survey_failed" });
    const v = at(failed, "plan", { detail: { reason: "timeout" } });
    expect(v.failed).toBe(true);
    expect(v.word).toBe("Needs attention");
    expect(v.lines).toEqual(["The survey stopped (timeout). Try again, or write your own plan"]);
  });

  it("install / running sub-steps, PR open, PR closed, failed", () => {
    const steps = track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "done", install: "active" });
    const running = at(steps, "install", { install: { sub_steps: [{ id: "archive", state: "ok" }, { id: "boot", state: "running" }, { id: "populate", state: "pending" }, { id: "open_pr", state: "failed" }, { id: "bogus", state: "ok" }] } });
    expect(running.list).toEqual([{ label: "Archive", word: "Done" }, { label: "Boot the sandbox", word: "Running" }, { label: "Populate", word: "Pending" }, { label: "Open the pull request", word: "Failed" }]);
    expect(at(steps, "install", { install: { pr: { number: 42, state: "open" } } }).lines).toEqual(["Review and merge the install PR #42"]);
    expect(at(steps, "install", { install: { pr: { number: 42, state: "closed" } } }).lines).toEqual(["The install PR was closed. Reopen it, or start install again"]);
    expect(at(steps, "install", { install: { pr: { number: "x", state: "open" } } }).lines).toEqual([]); // a number that is not one is not printed
    const failed = track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "done", install: "failed" }, { code: "provision_failed" });
    expect(at(failed, "install", { detail: { sub_step: "provision" } }).lines).toEqual(["Engine install stopped at provision. Try again (it picks up where it stopped)"]);
    expect(at(failed, "install").lines).toEqual(["Engine install stopped. Try again (it picks up where it stopped)"]);
  });

  const live = track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "done", install: "done", live: "active" });
  it("live / operate off: the owner or admin is offered the switch, a member is told whom to ask", () => {
    const admin = at(live, "live", { live: { operate: "off" }, isAdmin: true });
    expect(admin.lines).toEqual([OPERATE_OFF]);
    expect(OPERATE_OFF).toBe("The engine runs only while operate is on. Operate lets the cloud send commands to the engine, and your dials decide what it may do by itself.");
    expect(admin.actions).toEqual([{ id: "operate", label: "Turn on operate and start the engine", app: "team" }]);
    const member = at(live, "live", { live: { operate: "off" }, isAdmin: false });
    expect(member.lines).toEqual([OPERATE_OFF, ASK_OWNER]);
    expect(ASK_OWNER).toBe("Ask an owner or admin to turn on operate");
    expect(member.actions).toEqual([]);
  });

  it("live / starting, over 5 min, done", () => {
    expect(at(live, "live", { live: { starting: true } }).lines).toEqual(["Starting the engine on box-1…"]);
    expect(at(live, "live", { live: { silent_min: 6 } }).lines).toEqual(["No heartbeat from the engine on box-1. Open Machines → box-1 → sandboxes"]);
    expect(at(live, "live", { live: { silent_min: 5 } }).lines).toEqual([]); // the line starts after five minutes
    const done = track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "done", install: "done", live: "done" });
    expect(at(done, "live").actions).toEqual([{ id: "open_team", label: "Open Team", app: "team" }]);
  });

  it("github_app hands off to Repos until it is done", () => {
    const steps = track({ machine: "done", claude: "done", github_app: "active" });
    expect(at(steps, "github_app").actions).toEqual([{ id: "open_repos", label: "Open Repos", app: "repos" }]);
    expect(at(track({ machine: "done", claude: "done", github_app: "done" }), "github_app").actions).toEqual([]);
  });

  it("the name falls back to 'your machine' when the runners list gave none", () => {
    expect(describeStep(track({ machine: "done" }, { tier: "microvm" }), 0, {}).lines).toEqual(["your machine connected · MicroVM isolation"]);
  });

  it("criterion 4: no null, undefined or NaN reaches a word, whatever the view-model is missing", () => {
    const contexts = [{}, { name: "" }, { machine: {} }, { machine: { doctor: [null, {}, { code: "nope" }, { code: "vm_memory_low" }, { code: "disk_low" }] } },
      { project: {}, plan: {}, install: { sub_steps: [null, {}], pr: {} }, live: {} }, { detail: {} }, { live: { silent_min: NaN, operate: "?" } }, { last_seen_min: NaN, offline: true }];
    const states = ["done", "active", "pending", "failed"];
    for (const ctx of contexts) {
      for (const id of IDS) {
        for (const state of states) {
          const steps = track({ [id]: state }, { tier: "standard", code: "unheard_of_code" });
          const v = describeStep(steps, IDS.indexOf(id), ctx);
          const all = [v.label, v.word, ...v.lines, ...v.commands.map((c) => c.text + c.label), ...v.list.map((x) => x.label + x.word), ...v.actions.map((a) => a.label)].join("|");
          expect(all).not.toMatch(/null|undefined|NaN/);
        }
      }
    }
    for (const code of ["vm_memory_low", "disk_low", "machine_offline", "bundle_refused", "session_boot_failed", "mirror_denied"]) expect(fixFor(code, "box-1", {}).text).not.toMatch(/null|undefined|NaN/);
  });
});

describe("failure copy and copyable fixes (criterion 14)", () => {
  const cmds = {
    runner_too_old: "fx-runner update",
    claude_missing: "curl -fsSL https://claude.ai/install.sh | bash",
    claude_signed_out: "claude",
    claude_too_old: "claude update",
    microvm_helper_missing: "sudo fx-runner vm install",
    microvm_helper_not_ready: "sudo systemctl restart fx-vmhelper",
    microvm_helper_out_of_date: "sudo fx-runner vm install",
    snapshot_quota: "fx-runner config set snapshot_quota_bytes <bytes>",
  };
  for (const [code, cmd] of Object.entries(cmds)) {
    it(`${code}: its fix line carries exactly one command, shown as the Copy button's text`, () => {
      const steps = track({ machine: "active" });
      const v = at(steps, "machine", { machine: { doctor: [{ code }] } });
      expect(v.commands.map((c) => c.text)).toContain(cmd);
      expect(fixFor(code, "box-1", {}).cmd).toBe(cmd);
    });
  }
  it("a code with no command shows only its sentence", () => {
    for (const code of ["microvm_no_kvm", "vm_memory_low", "image_missing", "disk_low", "mirror_denied", "mirror_failed", "engine_release_unset", "engine_checksum", "pr_failed", "seed_failed", "session_crash_loop", "subscription_limit", "machine_offline"]) {
      const f = fixFor(code, "box-1", {});
      expect(f.cmd).toBe("");
      expect(f.text).not.toBe("");
    }
  });
  it("sentences carry the optional detail when it is there", () => {
    expect(fixFor("vm_memory_low", "box-1", { free_gb: 2, need_gb: 4 }).text).toBe("box-1 has 2 GB free; an engine needs 4 GB. Stop another engine or add memory");
    expect(fixFor("disk_low", "box-1", { free_gb: 3 }).text).toBe("box-1 has 3 GB free; a project needs 10 GB");
    expect(fixFor("mirror_denied", "box-1", { repo: "acme/app" }).text).toBe("The GitHub App can't read acme/app. Open Repos");
    expect(fixFor("machine_offline", "box-1", { last_seen_min: 9 }).text).toBe("box-1 is offline (last seen 9 min ago)");
    expect(fixFor("bundle_refused", "box-1", { reason: "symlink" }).text).toBe("The install produced changes we couldn't accept (symlink). Nothing was pushed");
    expect(fixFor("session_boot_failed", "box-1", { reason: "no_memory" }).text).toBe("The engine didn't start on box-1 (no_memory). Start the engine to retry");
  });
  it("a code nobody has heard of reads as a generic stop and never prints the code", () => {
    expect(fixFor("brand_new_code", "box-1", {})).toEqual({ text: "This step stopped. Try again.", cmd: "" });
    expect(fixFor("__proto__", "box-1", {}).text).toBe("This step stopped. Try again.");
    expect(fixFor("toString", "box-1", {}).text).toBe("This step stopped. Try again.");
  });
});

describe("copyText (criterion 2)", () => {
  it("copies exactly the text it is given and says so", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const said = [];
    const cmd = machineCommands(ORIGIN)[3].text;
    await copyText(cmd, (t) => said.push(t));
    expect(writeText.mock.calls).toEqual([["fx-runner setup --cloud-url https://cloud.example.test"]]);
    expect(said).toEqual(["Copied"]);
    vi.unstubAllGlobals();
  });
  it("says it could not copy when the clipboard is missing or refuses", async () => {
    for (const nav of [{}, { clipboard: { writeText: () => Promise.reject(new Error("denied")) } }]) {
      vi.stubGlobal("navigator", nav);
      const said = [];
      await copyText("claude", (t) => said.push(t));
      expect(said).toEqual(["Couldn't copy. Select the command and copy it yourself."]);
      vi.unstubAllGlobals();
    }
  });
});

describe("prerequisites (item 13)", () => {
  it("lists a Claude subscription, a GitHub account, a computer or Hetzner account, the price and the time to Live", () => {
    expect(prerequisites(29)).toEqual([
      "A Claude subscription",
      "A GitHub account",
      "A computer running Linux, macOS or Windows with WSL2, or a Hetzner Cloud account",
      "Price: $29.00 a month per engine",
      "Time to Live: usually 15–30 minutes",
    ]);
    expect(TIME_TO_LIVE).toBe("usually 15–30 minutes");
  });
  it("the price is read from plan data: change it and the line changes (no price is written in app code)", () => {
    const plans = (price) => ({ plans: [{ id: "starter", price_usd_month: 129 }], engine_plan: { price_usd_month: price } });
    expect(prerequisites(enginePrice(plans(29)))[3]).toBe("Price: $29.00 a month per engine");
    expect(prerequisites(enginePrice(plans(35.5)))[3]).toBe("Price: $35.50 a month per engine");
    expect(prerequisites(enginePrice(plans(49)))[3]).toBe("Price: $49.00 a month per engine");
  });
  it("without an Engine plan in the data, the line says where the price will be, never a number or 'undefined'", () => {
    for (const body of [null, {}, { plans: [] }, { plans: [{ id: "starter", price_usd_month: 129 }], engine_plan: null }, { engine_plan: {} }, { engine_plan: { price_usd_month: "29" } }, { engine_plan: { price_usd_month: NaN } }, { plans: [{ id: "engine", price_usd_month: 29 }] }]) {
      expect(enginePrice(body)).toBeNull();
      expect(prerequisites(enginePrice(body))[3]).toBe("Price: shown when you choose a plan");
    }
  });
});

describe("the machine named in the copy (ruling 26.2)", () => {
  const NOW = Date.parse("2026-11-20T12:00:00.000Z");
  const r = (id, minutes, extra = {}) => ({ id, name: "m-" + id, state: "online_idle", last_seen_at: new Date(NOW - minutes * 60000).toISOString(), ...extra });
  it("picks the most recently heard runner that is not revoked, the same machine the server's step picks", () => {
    expect(machineContext({ runners: [r("a", 30), r("b", 2), r("c", 10)] }, NOW)).toEqual({ name: "m-b", offline: false, last_seen_min: 2 });
    expect(machineContext({ runners: [r("a", 1, { state: "revoked" }), r("b", 9)] }, NOW).name).toBe("m-b");
  });
  it("a tie goes to the lower id", () => {
    expect(machineContext({ runners: [r("z", 5), r("a", 5)] }, NOW).name).toBe("m-a");
  });
  it("reads offline and not responding as offline, with how long ago", () => {
    expect(machineContext({ runners: [r("a", 12, { state: "offline" })] }, NOW)).toEqual({ name: "m-a", offline: true, last_seen_min: 12 });
    expect(machineContext({ runners: [r("a", 12, { state: "not_responding" })] }, NOW).offline).toBe(true);
  });
  it("gives nothing for no runner, a bad body or a runner never heard", () => {
    for (const body of [null, {}, { runners: [] }, { runners: [r("a", 1, { last_seen_at: null })] }, { runners: [r("a", 1, { last_seen_at: "x" })] }, { runners: [null, 3] }, { runners: [r("a", 1, { state: "revoked" })] }]) expect(machineContext(body, NOW)).toEqual({});
  });
  it("the placeholder name of an unnamed runner (has_name false) reads as no name, so the copy says your machine", () => {
    const ctx = machineContext({ runners: [r("a", 1, { name: "Unnamed runner (jp)", has_name: false })] }, NOW);
    expect(ctx.name).toBe("");
    expect(machineContext({ runners: [r("a", 1, { has_name: true })] }, NOW).name).toBe("m-a");
    const steps = track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "done", install: "active" });
    expect(text(describeStep(steps, IDS.indexOf("install"), { ...ctx, origin: ORIGIN, setup: { id: "3c1c0b7e-5f0a-4c1e-9b1f-0a1b2c3d4e5f", phase: "install", state: "started" } }))).toBe("The install is running on your machine.");
  });
  it("a name that is not a string reads as no name, and a clock that went backwards never gives a negative age", () => {
    expect(machineContext({ runners: [r("a", 1, { name: 7 })] }, NOW).name).toBe("");
    expect(machineContext({ runners: [r("a", -5)] }, NOW).last_seen_min).toBe(0);
  });
});

it("every engine step has a label", () => {
  expect(Object.keys(LABELS)).toEqual(IDS);
});

// D#845 ON-22: the project step's plan gate. The server sends a closed value on the project step; the words and the price are the app's, the price from plan data.
describe("the Engine plan gate on the project step", () => {
  const gated = (gate, state = "active", extra = {}) => {
    const steps = track({ machine: "done", claude: "done", github_app: "done", project: state }).map((s) => (s.step === "project" ? { ...s, plan_gate: gate, ...extra } : s));
    return steps;
  };
  const price = (n) => ({ price: enginePrice({ engine_plan: { price_usd_month: n } }) });

  it("plan_required reads 'Pick the Engine plan to run the engine ($X a month per engine)' with Choose plan; the price follows plan data", () => {
    for (const n of [29, 35.5, 49]) {
      const v = at(gated("plan_required"), "project", price(n));
      expect(v.lines).toEqual(["Pick the Engine plan to run the engine ($" + n.toFixed(2) + " a month per engine)"]);
      expect(v.actions).toEqual([{ id: "choose_plan", label: "Choose plan", run: true }]);
    }
  });

  it("without a price in the data the line says what to do and never prints undefined or NaN", () => {
    for (const ctx of [{}, { price: null }, { price: NaN }, { price: "29" }]) {
      const v = at(gated("plan_required"), "project", ctx);
      expect(v.lines).toEqual(["Pick the Engine plan to run the engine"]);
      expect(text(v)).not.toMatch(/undefined|NaN|null/);
    }
  });

  it("engine_quantity says every engine is in use and offers Add an engine; plan_ended says so with Renew; unavailable says so with no action", () => {
    expect(at(gated("engine_quantity"), "project")).toMatchObject({ lines: ["Every engine on your plan is in use. Add an engine to place another project."], actions: [{ id: "add_engine", label: "Add an engine", run: true }] });
    expect(at(gated("plan_ended"), "project")).toMatchObject({ lines: ["Plan ended: the engine is stopped"], actions: [{ id: "renew", label: "Renew", run: true }] });
    expect(at(gated("unavailable"), "project")).toMatchObject({ lines: ["The Engine plan isn't available right now"], actions: [] });
    expect(at(gated("account_held"), "project")).toMatchObject({ lines: ["This account is on hold, so an engine can't be placed right now"], actions: [] });
  });

  it("a placed project shows only an ended plan; the purchase prompts do not show on a done step", () => {
    expect(at(gated("plan_ended", "done"), "project").lines).toEqual(["Your project is placed", "Plan ended: the engine is stopped"]);
    for (const gate of ["plan_required", "engine_quantity", "unavailable"]) expect(at(gated(gate, "done"), "project").lines).toEqual(["Your project is placed"]);
  });

  it("a refused purchase or the 'Engine added' notice is shown under the gate, and a step with no gate is unchanged", () => {
    expect(at(gated("plan_required"), "project", { planNote: "Only the account owner can change the Engine plan." }).lines.at(-1)).toBe("Only the account owner can change the Engine plan.");
    expect(at(track({ machine: "done", claude: "done", github_app: "done", project: "active" }), "project", { planNote: "x" }).lines).toEqual([]);
  });

  it("parseTracks keeps the closed plan_gate and the engine counts on the project step only, and drops anything else", () => {
    const body = fixture("200-new.json");
    const parse = (extra) => parseTracks({ ...body, tracks: [body.tracks[0], { ...body.tracks[1], steps: body.tracks[1].steps.map((s) => ({ ...s, ...extra })) }] }).engine;
    const project = (extra) => parse(extra).find((s) => s.step === "project");
    expect(project({ plan_gate: "engine_quantity", engines: { quantity: 2, live: 2 } })).toMatchObject({ plan_gate: "engine_quantity", engines: { quantity: 2, live: 2 } });
    expect(project({ plan_gate: "account_held" })).toMatchObject({ plan_gate: "account_held" });
    for (const bad of [{ plan_gate: "free" }, { plan_gate: null }, { plan_gate: 1 }, { engines: { quantity: -1, live: 0 } }, { engines: { quantity: 1.5, live: 0 } }, { engines: "2" }]) {
      expect(project(bad), JSON.stringify(bad)).not.toHaveProperty(Object.keys(bad)[0]);
    }
    for (const other of parse({ plan_gate: "plan_required", engines: { quantity: 1, live: 1 } }).filter((s) => s.step !== "project")) {
      expect(other).not.toHaveProperty("plan_gate");
      expect(other).not.toHaveProperty("engines");
    }
    expect(parseTracks(body).engine.every((s) => !("plan_gate" in s))).toBe(true);
  });
});

describe("installDetail (D#845 ON-8a)", () => {
  it("shows the sub-step a setup row reports, with skipped as done, and nothing outside the install phase or for a name it does not know", () => {
    const steps = track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "done", install: "active" });
    const list = (row) => at(steps, "install", installDetail(row)).list;
    expect(list({ phase: "install", sub_step: "deps", state: "started" })).toEqual([{ label: "Install dependencies", word: "Running" }]);
    expect(list({ phase: "install", sub_step: "gh_labels", state: "skipped" })).toEqual([{ label: "Create the labels", word: "Done" }]);
    expect(list({ phase: "install", sub_step: "bundle_out", state: "failed" })).toEqual([{ label: "Bundle the changes", word: "Failed" }]);
    for (const row of [{ phase: "survey", sub_step: "deps", state: "started" }, { phase: "install", sub_step: "nope", state: "ok" }, { phase: "install", sub_step: "constructor", state: "ok" }, null]) expect(installDetail(row)).toEqual({});
  });
});

// D#845 ON-7b: the project step's picker and confirm. The words and the decisions are pure and tested here; the drawn screen (phone width, every stage) is in e2e/onboarding-picker.spec.ts.
describe("the project picker's reads and words (ON-7b)", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const C = "33333333-3333-4333-8333-333333333333";

  it("readPicker keeps well-formed repos and owners, reads any other visibility as unknown, and refuses a body that is not a picker", () => {
    const r = readPicker({ repos: [{ id: A.toUpperCase(), name: "acme/a", visibility: "private", active_preset: "balanced" }, { id: B, name: "acme/b", visibility: "internal", active_preset: 3 }, { id: "nope", name: "x" }, { id: C, name: "" }], owners: [{ gh_id: 9, login: "acme", extra: 1 }, { gh_id: 0, login: "z" }, { gh_id: 4, login: "" }] });
    expect(r.repos).toEqual([{ id: A, name: "acme/a", visibility: "private", active_preset: "balanced" }, { id: B, name: "acme/b", visibility: "unknown", active_preset: null }]);
    expect(r.owners).toEqual([{ gh_id: 9, login: "acme" }]);
    expect(r.ownersUnknown).toBe(false);
    expect(readPicker({ repos: [], owners: [], owners_unknown: true }).ownersUnknown).toBe(true);
    for (const bad of [null, {}, { repos: "x" }, []]) expect(readPicker(bad)).toBeNull();
    expect(readPicker({ repos: [] }).owners).toEqual([]);
  });

  it("each visibility has its word, and a repo GitHub could not be asked about reads Couldn't check", () => {
    expect(["public", "private", "unknown", undefined, "x"].map(pickVisibility)).toEqual(["Public", "Private", COULDNT_CHECK, COULDNT_CHECK, COULDNT_CHECK]);
  });

  it("the dials line names the repo's preset, Custom when none matches, and the starting setting for a new repo", () => {
    expect(["cautious", "balanced", "autonomous"].map((p) => dialsLine({ active_preset: p }, false))).toEqual(["Dials: Cautious", "Dials: Balanced", "Dials: Autonomous"]);
    expect(dialsLine({ active_preset: null }, false)).toBe("Dials: Custom");
    expect(dialsLine({ active_preset: "weird" }, false)).toBe("Dials: Custom");
    expect(presetName(undefined)).toBe("Custom");
    expect(dialsLine({ active_preset: "autonomous" }, true)).toBe("Dials: " + NEW_PRESET);
    expect(NEW_PRESET).toBe("Balanced (the starting setting)");
  });

  it("the public-repo copy is Ruling 87's sentence, word for word", () => {
    expect(PUBLIC_COPY).toBe("Anyone can open issues on a public repo, and the engine reads them. The engine starts work only from collaborators' items.");
  });

  it("the linked line is 'Linked <date> from <IP>' with no country, and empty when the machine has no link facts", () => {
    expect(linkedLine("2026-11-20T10:00:00.000Z", "203.0.113.9")).toBe("Linked 2026-11-20 from 203.0.113.9");
    expect(linkedLine("2026-11-20T10:00:00.000Z", null)).toBe("Linked 2026-11-20");
    expect(linkedLine(null, "203.0.113.9")).toBe("");
    expect(linkedLine("not a date", "203.0.113.9")).toBe("");
  });

  it("machines: offline and revoked are not offered, a standard machine with a project is greyed with its reason, names come out clean", () => {
    const runners = { runners: [
      { id: A, name: " box-1 ", state: "online_idle", facts: { engine: "microvm" }, linked_at: "2026-11-20T10:00:00.000Z", linked_from_ip: "203.0.113.9" },
      { id: B, name: "", state: "offline", facts: { engine: "microvm" }, linked_at: null, linked_from_ip: null },
      { id: C, name: "std", state: "busy", facts: { engine: "os_sandbox" } },
      { id: "44444444-4444-4444-8444-444444444444", name: "gone", state: "revoked" },
    ] };
    const machines = { machines: [{ id: C, tier: "standard", live: true, running: { repo_id: A, name: "acme/a" } }] };
    const out = machineChoices(runners, machines);
    expect(out.map((m) => [m.name, m.ok, m.note])).toEqual([["box-1", true, ""], ["Unnamed machine", false, "Offline"], ["std", false, "Standard isolation hosts one project"]]);
    expect(out[0].linked).toBe("Linked 2026-11-20 from 203.0.113.9");
    expect(out[1].linked).toBe("");
    // Without the machines read, tier comes from what the runner reported and nothing is greyed for a project it cannot see.
    expect(machineChoices(runners, null).find((m) => m.id === C)).toMatchObject({ ok: true, tier: "standard" });
    expect(machineChoices(null, null)).toEqual([]);
    expect(NO_MACHINE).toBe("Every machine is full or offline");
  });

  describe("the operate box", () => {
    const settings = (o) => ({ watch_enabled: true, operate_enabled: false, can_edit: true, repos: [{ repo_id: A, full_name: "acme/a", enabled: true }, { repo_id: B, full_name: "acme/b", enabled: true }, { repo_id: C, full_name: "acme/c", enabled: false }], ...o });
    it("switch on: nothing to consent to", () => {
      expect(operateBox(settings({ operate_enabled: true }), C, "private")).toMatchObject({ on: true, text: expect.stringContaining("already on") });
    });
    it("switch off with no other ticked repo: the plain sentence", () => {
      const box = operateBox(settings({ repos: [{ repo_id: C, full_name: "acme/c", enabled: false }] }), C, "private");
      expect(box).toMatchObject({ on: false, others: [], text: "Turn on operate for this account." });
    });
    it("switch off with others: it names the count and the other repos, and operate_others is exactly the enabled repos other than the chosen one", () => {
      const box = operateBox(settings(), C, "private");
      expect(box.text).toBe("Turn on operate for this account. This also operates 2 other repos: acme/a, acme/b");
      expect(box.others.map((o) => o.id)).toEqual([A, B]);
      // The chosen repo is never among them, even when it is already ticked.
      expect(operateBox(settings(), A, "private").others.map((o) => o.id)).toEqual([B]);
      expect(operateBox(settings(), A, "private").text).toBe("Turn on operate for this account. This also operates 1 other repo: acme/b");
    });
    it("a public repo cannot be operated yet, so the box is blocked with the server's own sentence; an unreadable settings read shows no box", () => {
      expect(operateBox(settings(), C, "public").blocked).toBe(PUBLIC_OPERATE);
      expect(operateBox(settings(), C, "private").blocked).toBe("");
      expect(operateBox(null, C, "private")).toBeNull();
      expect(operateBox({ operate_enabled: "yes" }, C, "private")).toBeNull();
    });
  });

  it("every refusal of the place route has its sentence, none is the server's text, and none reads null or undefined", () => {
    const codes = ["setup_exists", "account_not_active", "repo_visibility_unknown", "project_already_placed", "machine_single_project", "machine_not_eligible", "no_eligible_machine", "operate_consent_stale", "operate_public_pending", "placement_busy"];
    const seen = new Set();
    for (const code of codes) {
      const r = placeRefusal({ code, status: 409, message: "SERVER WORDS" }, "acme/a");
      expect(r.code).toBe(code);
      expect(r.text, code).not.toMatch(/SERVER WORDS|null|undefined/);
      expect(r.text.length).toBeGreaterThan(10);
      seen.add(r.text);
    }
    expect(seen.size).toBe(codes.length);
    expect(placeRefusal({ code: "setup_exists" }).also).toBe("setup");
    expect(placeRefusal({ code: "no_eligible_machine" }).also).toBe("machine");
    expect(placeRefusal({ code: "repo_visibility_unknown" }, "acme/a").text).toBe("GitHub didn't say whether acme/a is public or private. Try again in a minute.");
    expect(placeRefusal({ code: "operate_public_pending" }).text).toBe(PUBLIC_OPERATE);
    expect(new Set([403, 404, 400].map((status) => placeRefusal({ status, code: "forbidden" }).text)).size).toBe(3);
    expect(placeRefusal({ status: 403 }).text).toBe("Only an owner or admin can place a project.");
    for (const odd of [undefined, null, {}, { status: 500 }, { code: "invented" }]) expect(placeRefusal(odd).text).toBe("The project couldn't be placed. Try again.");
  });

  it("a machine_not_eligible refusal says why in its own sentence, one per reason the server can name, and an unknown or missing reason falls back to the plain one", () => {
    // The closed list is read from the server's own type, so a reason added there without a sentence here fails this test.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "runner-cloud", "src", "placement.ts"), "utf8");
    const union = /export type IneligibleReason = ([^;]+);/.exec(src)?.[1] ?? "";
    const reasons = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).filter((r) => r !== "has_project");
    expect(reasons.sort()).toEqual(["claude_not_ready", "draining", "load_unknown", "low_disk", "low_memory", "not_live", "paused", "server_deleting"]);
    const plain = placeRefusal({ code: "machine_not_eligible", status: 409 }).text;
    const seen = new Set();
    for (const reason of reasons) {
      const r = placeRefusal({ code: "machine_not_eligible", status: 409, reason, message: "SERVER WORDS" });
      expect(r, reason).toMatchObject({ code: "machine_not_eligible", reason });
      expect(r.text, reason).not.toMatch(/SERVER WORDS|null|undefined/);
      expect(r.text, reason).not.toBe(plain);
      seen.add(r.text);
    }
    expect(seen.size).toBe(reasons.length);
    expect(placeRefusal({ code: "machine_not_eligible", status: 409, reason: "invented" }).text).toBe(plain);
    expect(placeRefusal({ code: "machine_not_eligible", status: 409, reason: 7 }).text).toBe(plain);
    expect(placeRefusal({ code: "machine_not_eligible", status: 409, reason: "__proto__" }).text).toBe(plain);
    // A reason beside any other code changes nothing: machine_single_project keeps its own sentence.
    expect(placeRefusal({ code: "machine_single_project", status: 409, reason: "low_disk" }).text).toMatch(/Standard isolation hosts one project/);
    expect(placeRefusal({ code: "machine_not_eligible", status: 409, reason: "low_memory" }).text).toMatch(/4 GB/);
    expect(placeRefusal({ code: "machine_not_eligible", status: 409, reason: "low_disk" }).text).toMatch(/10 GB/);
  });

  it("only an unknown load is waited out: asked again a bounded number of times, a few seconds apart", () => {
    expect(isLoadPending({ code: "machine_not_eligible", reason: "load_unknown" })).toBe(true);
    for (const e of [{ code: "machine_not_eligible", reason: "low_memory" }, { code: "machine_not_eligible" }, { code: "machine_single_project", reason: "load_unknown" }, null, undefined]) expect(isLoadPending(e)).toBe(false);
    expect(CHECKING_MACHINE).toBe("Checking the machine…");
    expect(CHECK_TRIES).toBeGreaterThanOrEqual(1);
    expect(CHECK_TRIES * CHECK_WAIT_MS).toBeGreaterThanOrEqual(20_000); // the wake poll is every 20 seconds
    expect(CHECK_TRIES * CHECK_WAIT_MS).toBeLessThanOrEqual(60_000);
  });

  it("create-intent refusals and the outcomes GitHub's return carries each have a sentence", () => {
    expect(createRefusal({ code: "install_first" })).toBe(NO_OWNERS);
    expect(createRefusal({ status: 403, code: "forbidden" })).toBe("Only an owner or admin can create a repo.");
    expect(createRefusal({ code: "rate_limited" })).toMatch(/Try again later/);
    expect(createRefusal({ code: "validation_failed" })).toMatch(/valid repo name/);
    expect(createRefusal(new Error("x"))).toBe("The repo couldn't be created. Try again.");
    for (const outcome of ["created_not_connected", "name_taken", "visibility_not_allowed", "refused", "github_busy", "rate_limited", "install_first", "failed"]) expect(parseReturn("?create=" + outcome)).toEqual({ outcome, repo: "" });
  });

  it("parseReturn takes a repo id only on ok and only in the shape of an id; any other value is nothing", () => {
    expect(parseReturn("?create=ok&repo=" + A.toUpperCase())).toEqual({ outcome: "ok", repo: A });
    expect(parseReturn("?create=ok&repo=not-an-id")).toEqual({ outcome: "ok", repo: "" });
    expect(parseReturn("?create=ok")).toEqual({ outcome: "ok", repo: "" });
    expect(parseReturn("?create=failed&repo=" + A)).toEqual({ outcome: "failed", repo: "" });
    for (const s of ["", "?create=bogus", "?create=__proto__", "?x=1", undefined, null]) expect(parseReturn(s)).toBeNull();
  });
});

describe("surveyDetail (D#845 ON-10b2)", () => {
  const RUN = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
  const steps = track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "active" });
  const failedSteps = track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "failed" }, { code: "survey_failed" });
  const row = (over) => ({ phase: "survey", state: "started", survey_run_id: RUN, failure_code: null, failure_reason: null, ...over });

  it("a started survey with a run is surveying, with the run to open", () => {
    expect(surveyDetail(row({}))).toEqual({ plan: { stage: "surveying", run_id: RUN } });
    const v = at(steps, "plan", surveyDetail(row({})));
    expect(text(v)).toBe("Reading your code and docs…");
    expect(v.actions).toEqual([{ id: "open_run", label: "Open the run", app: "runs" }]);
  });

  it("a started survey with no run says it did not start, with its one copy line and no action", () => {
    for (const none of [null, ""]) expect(surveyDetail(row({ survey_run_id: none }))).toEqual({ plan: { stage: "not_started" } });
    const v = at(steps, "plan", surveyDetail(row({ survey_run_id: null })));
    expect(text(v)).toBe("The survey didn't start. Try again, or write your own plan.");
    expect(v.actions).toEqual([]);
  });

  const WORDS = {
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
  it.each(Object.entries(WORDS))("a failed survey with reason %s reads %s, in the existing failure line", (reason, words) => {
    for (const code of ["survey_failed", "survey_timeout"]) {
      const detail = surveyDetail(row({ state: "failed", failure_code: code, failure_reason: reason }));
      expect(detail).toEqual({ detail: { reason: words } });
      expect(text(describeStep(failedSteps, IDS.indexOf("plan"), { name: "box-1", detail: detail.detail }))).toBe("The survey stopped (" + words + "). Try again, or write your own plan");
    }
  });

  it("anything else is empty: another phase, a code that is not a survey's, an unknown or inherited reason, a done survey, a missing row", () => {
    const empty = [
      row({ phase: "install" }),
      row({ phase: "plan", state: "ok" }),
      row({ state: "failed", failure_code: "deps_failed", failure_reason: "run_failed" }),
      row({ state: "failed", failure_code: "survey_failed", failure_reason: "nope" }),
      row({ state: "failed", failure_code: "survey_failed", failure_reason: "constructor" }),
      row({ state: "failed", failure_code: "survey_failed", failure_reason: null }),
      row({ state: "ok" }),
      {},
      null,
      undefined,
    ];
    for (const r of empty) expect(surveyDetail(r)).toEqual({});
  });
});

/** A stand-in for the few DOM calls h() makes; `mk(tag)` makes an element the fake document accepts as a child. */
function withFakeDom(fn) {
  class FakeNode {}
  class FakeText extends FakeNode { constructor(t) { super(); this.text = t; } }
  class FakeEl extends FakeNode {
    constructor(tag) { super(); this.tag = tag; this.children = []; this.attrs = {}; }
    set className(v) { this.attrs.class = v; }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener() {}
    appendChild(c) { this.children.push(c); }
  }
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("document", { createElement: (t) => new FakeEl(t), createTextNode: (t) => new FakeText(t) });
  try { fn((tag) => new FakeEl(tag)); } finally { vi.unstubAllGlobals(); }
}

// D#845 ON-11b: the plan review. The draft read, the checks that say in words what the server would refuse, every refusal's sentence, and Approve's answer.
describe("the plan review (ON-11b)", () => {
  const ROW = (over = {}) => ({ row_key: "A1", title: "First", summary: "Do it", size: "S", depends_on: [], keep: true, ...over });
  const body = (over = {}) => ({ setup: { phase: "plan", state: "ok" }, draft: { id: "d1", version: 3, source: "survey", status: "draft", prd_md: "# PRD", roadmap: [ROW(), ROW({ row_key: "B2", depends_on: ["A1"], keep: false })], created_at: T }, review_mode: "standard", ...over });

  it("reads a draft into the editor's rows, and a body that does not fit is null", () => {
    const d = readDraft(body());
    expect(d).toMatchObject({ version: 3, status: "draft", phase: "plan", prd: "# PRD", mode: "standard" });
    expect(d.rows).toEqual([{ key: "A1", title: "First", summary: "Do it", size: "S", deps: "", keep: true }, { key: "B2", title: "First", summary: "Do it", size: "S", deps: "A1", keep: false }]);
    for (const bad of [null, {}, { setup: {}, draft: {} }, body({ setup: { phase: 3 } }), { ...body(), draft: { ...body().draft, version: 0 } }, { ...body(), draft: { ...body().draft, status: "discarded" } }, { ...body(), draft: { ...body().draft, roadmap: [ROW({ size: "XL" })] } },
      { ...body(), draft: { ...body().draft, roadmap: [ROW({ keep: "yes" })] } }, { ...body(), draft: { ...body().draft, roadmap: [ROW({ depends_on: [1] })] } }, { ...body(), draft: { ...body().draft, prd_md: null } }]) expect(readDraft(bad)).toBeNull();
  });

  it("reads who approved and when, and says it in the approved line; without both it keeps the plain line", () => {
    const at = "2026-11-25T14:05:00.000Z";
    const d = readDraft(body({ draft: { ...body().draft, status: "approved", approved_by: "Ada Admin", approved_at: at } }));
    expect([d.approvedBy, d.approvedAt]).toEqual(["Ada Admin", at]);
    const hhmm = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(approvedLine(d)).toBe("Approved " + hhmm + " by Ada Admin");
    for (const over of [{}, { approved_by: "Ada Admin" }, { approved_at: at }, { approved_by: "", approved_at: at }, { approved_by: 7, approved_at: at }, { approved_by: "Ada", approved_at: "not a time" }]) {
      expect(approvedLine(readDraft(body({ draft: { ...body().draft, status: "approved", ...over } }))), JSON.stringify(over)).toBe("Approved. This plan is read-only.");
    }
  });

  it("fails closed: anything but a clear standard review mode is public", () => {
    for (const mode of ["public", undefined, null, "", "Standard", 1]) expect(readDraft(body({ review_mode: mode })).mode, String(mode)).toBe("public");
    expect(readDraft(body({ review_mode: "standard" })).mode).toBe("standard");
  });

  it("a clean plan has nothing to fix; each rule says its own words", () => {
    const rows = readDraft(body()).rows;
    expect(planProblems("# PRD", rows)).toEqual({ save: [], approve: [] });
    const r = (over) => ({ key: "A1", title: "T", summary: "", size: "M", deps: "", keep: true, ...over });
    expect(planProblems("", [r()]).save).toEqual(["The PRD must be between 1 and 200,000 characters."]);
    expect(planProblems("x".repeat(200001), [r()]).save).toEqual(["The PRD must be between 1 and 200,000 characters."]);
    expect(planProblems("x".repeat(200000), [r()]).save).toEqual([]);
    expect(planProblems("x", [r({ keep: false })]).approve).toEqual(["Keep at least one row"]);
    expect(planProblems("x", []).approve).toEqual(["Keep at least one row"]);
    expect(planProblems("x", [r({ key: "a1" })]).save[0]).toMatch(/a key is capital letters/);
    expect(planProblems("x", [r(), r()]).save).toEqual(["Two rows are called A1."]);
    expect(planProblems("x", [r({ title: "" })]).save).toEqual(["A1: the title needs 1 to 120 characters."]);
    expect(planProblems("x", [r({ title: "t".repeat(121) })]).save).toEqual(["A1: the title needs 1 to 120 characters."]);
    expect(planProblems("x", [r({ summary: "s".repeat(501) })]).save).toEqual(["A1: the summary is limited to 500 characters."]);
    expect(planProblems("x", [r({ deps: "A1" })]).save).toEqual(["A1 depends on A1, which is itself."]);
    expect(planProblems("x", [r({ deps: "ZZ" })]).save).toEqual(["A1 depends on ZZ, which isn't a row in this plan."]);
    expect(planProblems("x", [r({ deps: "B2" }), r({ key: "B2", keep: false })]).approve).toEqual(["A1 is kept but depends on B2, which you dropped."]);
    expect(planProblems("x", [r({ deps: "B2" }), r({ key: "B2", keep: false })]).save).toEqual([]);
    expect(planProblems("x", [r({ deps: "A, B, C, D, E, F, G, H, I, J, K" })]).save).toContain("A1: a row depends on at most 10 others.");
    expect(planProblems("x", Array.from({ length: 201 }, (_, n) => r({ key: "K" + n }))).save).toContain("A plan holds at most 200 rows.");
  });

  it("counts characters, not UTF-16 units, like the server", () => {
    expect(planProblems("😀".repeat(200000), [{ key: "A1", title: "T", summary: "", size: "M", deps: "", keep: true }]).save).toEqual([]);
    expect(planProblems("😀".repeat(200001), [{ key: "A1", title: "😀".repeat(120), summary: "", size: "M", deps: "", keep: true }]).save).toEqual(["The PRD must be between 1 and 200,000 characters."]);
  });

  it("the roadmap goes to the server with its keys, dependency lists and keep flags", () => {
    expect(toRoadmap([{ key: "A1", title: "T", summary: "S", size: "L", deps: "B2,  C3 D4", keep: false }])).toEqual([{ row_key: "A1", title: "T", summary: "S", size: "L", depends_on: ["B2", "C3", "D4"], keep: false }]);
  });

  it("every refusal has its own sentence, never the server's words", () => {
    const e = (code, extra = {}) => Object.assign(new Error("SERVER WORDS <b>"), { status: 409, code, ...extra });
    expect(draftRefusal(e("draft_conflict"))).toEqual({ text: "This plan changed in another window", conflict: true, reload: false });
    expect(draftRefusal(e("plan_invalid", { reason: "no_kept_rows" })).text).toBe("Keep at least one row");
    expect(draftRefusal(e("plan_invalid", { reason: "prd_length" })).text).toBe("The PRD must be between 1 and 200,000 characters.");
    expect(draftRefusal(e("plan_invalid", { reason: "dependency_dropped" })).text).toBe("A kept row depends on a row you dropped. Keep that row too, or take the dependency out.");
    expect(draftRefusal(e("plan_invalid", { reason: "constructor" })).text).toBe("The plan can't be approved as it is.");
    expect(draftRefusal(e("plan_not_reviewed", { missing: 3 })).text).toBe("Read every item before you approve. 3 items are still to mark as read.");
    expect(draftRefusal(e("plan_not_reviewed", { missing: 1 })).text).toBe("Read every item before you approve. 1 item is still to mark as read.");
    expect(draftRefusal(e("plan_not_reviewed", { missing: "x" })).text).toBe("Read every item before you approve.");
    expect(draftRefusal(e("setup_phase"))).toEqual({ text: "This setup has moved on, so the plan can't be changed here. Reloading.", conflict: false, reload: true });
    expect(draftRefusal(e("public_repo")).text).toBe("This repo is public, so the survey can't run again. Write your own plan instead.");
    expect(draftRefusal(e("repo_visibility_unknown")).text).toBe("We couldn't tell whether this repo is private, so the survey can't run. Try again in a minute, or write your own plan.");
    expect(draftRefusal(e("forbidden")).text).toBe("Only owners and admins can edit or approve the plan.");
    expect(draftRefusal(e("survey_running")).text).toBe("A survey is running now. Wait for it to finish.");
    expect(draftRefusal(e("invalid_message")).text).toMatch(/^The plan has a value that can't be kept/);
    for (const odd of [e("something_new"), e("constructor"), e("__proto__"), null, undefined, {}]) {
      const r = draftRefusal(odd);
      expect(r.text).toBe("That didn't go through. Try again.");
      expect(r.conflict || r.reload).toBe(false);
    }
    // The client's own fixed sentences (offline, timeout, a 5xx) pass through; nothing else the server wrote does.
    expect(draftRefusal({ status: 0, code: "offline", message: "You're offline. Check your connection and try again." }).text).toBe("You're offline. Check your connection and try again.");
    expect(draftRefusal({ status: 503, kind: "server_error", code: "x", message: "Something went wrong on our side. Try again in a moment." }).text).toBe("Something went wrong on our side. Try again in a moment.");
  });

  it("Approve's answer: the install started, the Engine plan's gate (with its buy button), or an install that could not be issued", () => {
    expect(approveWords({ install: { job_id: "j", attempt: 1 }, gate: null, install_error: null })).toEqual({ lines: ["Approved. The install has started."], actions: [] });
    const gated = approveWords({ install: null, gate: { code: "plan_required", message: "SERVER" }, install_error: null }, { price: 13 });
    expect(gated.lines).toEqual(["Approved. The install starts once the Engine plan covers this project.", "Pick the Engine plan to run the engine ($13.00 a month per engine)"]);
    expect(gated.actions.map((a) => a.id)).toEqual(["choose_plan"]);
    expect(approveWords({ install: null, gate: { code: "engine_quantity" }, install_error: null }).actions.map((a) => a.id)).toEqual(["add_engine"]);
    expect(approveWords({ install: null, gate: { code: "account_held" }, install_error: null }).lines[1]).toBe("This account is on hold, so an engine can't be placed right now");
    expect(approveWords({ install: null, gate: { code: "engine_plan_unavailable" }, install_error: null }).lines[1]).toBe("The Engine plan isn't available right now");
    expect(approveWords({ install: null, gate: { code: "never_heard_of_it" }, install_error: null }).lines[1]).toBe("The Engine plan isn't available right now");
    expect(approveWords({ install: null, gate: null, install_error: { code: "github_unavailable", message: "SERVER" } }).lines).toEqual(["Approved. GitHub couldn't be reached. Start the install again in a minute. Choose Start the install to try again."]);
    for (const code of ["public_repo", "repo_visibility_unknown", "setup_not_placed", "engine_release_unset", "boss_login_missing", "github_refused", "not_configured", "setup_phase", "forbidden"]) {
      const v = approveWords({ install: null, gate: null, install_error: { code, message: "SERVER <b>" } });
      expect(v.lines[0], code).not.toContain("SERVER");
      expect(v.lines[0], code).toMatch(/^Approved\. .+ Choose Start the install to try again\.$/);
    }
    expect(approveWords({ install: null, gate: null, install_error: { code: "install_error", message: "x" } }).lines[0]).toBe("Approved. The install couldn't be started now. Choose Start the install to try again.");
  });

  it("the plan step reads the setup: a survey that is running, or a plan waiting for review", () => {
    const steps = track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "active" });
    expect(at(steps, "plan", { setup: { id: "s", phase: "survey", state: "started" } }).lines).toEqual(["Reading your code and docs…"]);
    expect(at(steps, "plan", { setup: { id: "s", phase: "plan", state: "ok" } }).lines).toEqual(["Your plan is ready to review"]);
    for (const setup of [null, undefined, { id: "s", phase: "install", state: "ok" }, { id: "s", phase: "survey", state: "failed" }]) expect(at(steps, "plan", { setup }).lines, JSON.stringify(setup)).toEqual([]);
    // The older view-model field still wins when a caller supplies it.
    expect(at(steps, "plan", { setup: { id: "s", phase: "plan", state: "ok" }, plan: { stage: "not_started" } }).lines).toEqual(["The survey didn't start. Try again, or write your own plan."]);
  });

  it("the section carries the plan host only while the setup waits at the plan", () => {
    const find = (n, f, out = []) => (f(n) && out.push(n), (n.children || []).forEach((c) => find(c, f, out)), out);
    withFakeDom((mk) => {
      const host = mk("div");
      const has = (setup, state) => find(engineSection(track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: state }), { ctx: { setup, isAdmin: true }, planHost: host, canOpen: () => false, openApp() {}, runAction() {}, announce() {} }), (n) => n === host).length;
      expect(has({ id: "s", phase: "plan", state: "ok" }, "active")).toBe(1);
      expect(has({ id: "s", phase: "plan", state: "ok" }, "done")).toBe(1);
      expect(has({ id: "s", phase: "survey", state: "started" }, "active")).toBe(0);
      expect(has({ id: "s", phase: "install", state: "ok" }, "done")).toBe(0);
      expect(has(null, "active")).toBe(0);
      expect(has({ id: "s", phase: "plan", state: "ok" }, "pending")).toBe(0);
    });
  });
});

describe("twinDetail (D#845 ON-27a)", () => {
  const SHA = "a".repeat(40);
  const row = (over) => ({ state: "seeding", private_name: "widgets-private", published_private_sha: null, ...over });
  const STATES = ["creating", "not_connected", "seeding", "ready", "paused", "conflict", "refused", "failed", "removed"];

  it("says something in plain words for every state, never a state name, null or undefined", () => {
    for (const state of STATES) {
      const v = twinDetail(row({ state, published_private_sha: state === "ready" ? SHA : null }), "acme").twin;
      expect(v.state).toBe(state);
      expect(v.lines.length).toBeGreaterThan(0);
      for (const l of v.lines) expect(l).not.toMatch(/undefined|null|not_connected|creating|seeding|_/);
      expect(v.private_url).toBe("https://github.com/acme/widgets-private");
    }
  });

  it("offers the undo routes: pause or resume, Stop publishing once seeded, Cancel before, and nothing once removed", () => {
    const ids = (r) => twinDetail(r, "acme").twin.actions.map((a) => a.id);
    expect(ids(row({ state: "seeding" }))).toEqual(["pause", "cancel"]);
    expect(ids(row({ state: "not_connected" }))).toEqual(["add_to_app", "pause", "cancel"]);
    expect(ids(row({ state: "ready", published_private_sha: SHA }))).toEqual(["pause", "stop"]);
    expect(ids(row({ state: "paused", published_private_sha: SHA }))).toEqual(["resume", "stop"]);
    expect(ids(row({ state: "removed" }))).toEqual([]);
    expect(twinDetail(row({ state: "not_connected" }), "acme").twin.actions[0].label).toBe("Add widgets-private to the GitHub app");
    expect(twinDetail(row({ state: "ready", published_private_sha: SHA }), "acme").twin.actions.map((a) => a.label)).toEqual(["Pause", "Stop publishing"]);
  });

  it("a cancel before the seed, and a stopped twin, say the private repo stays on GitHub and is never deleted by us", () => {
    for (const r of [row({ state: "seeding" }), row({ state: "removed" })]) expect(twinDetail(r, "acme").twin.lines.join(" ")).toContain("Delete widgets-private on GitHub if you don't want it. We never delete a repo.");
    expect(twinDetail(row({ state: "ready", published_private_sha: SHA }), "acme").twin.lines.join(" ")).not.toContain("Delete ");
  });

  it("is empty for a missing row, an unknown state or a name that is not a repo name, and links only a well-formed owner", () => {
    for (const bad of [null, undefined, {}, row({ state: "__proto__" }), row({ state: "toString" }), row({ private_name: "../x" }), row({ private_name: 3 })]) expect(twinDetail(bad, "acme")).toEqual({});
    for (const owner of ["", undefined, "a/b", "-x", "x y"]) expect(twinDetail(row({}), owner).twin.private_url).toBe("");
  });
});

// D#845 FU-313 / FU-307: a failed install step is retried in place, and the install has its own words for a public repo.
describe("the failed install step (FU-313, FU-307)", () => {
  const failed = (code) => track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "done", install: "failed" }, { code });
  const installSetup = { id: "3c1c0b7e-5f0a-4c1e-9b1f-0a1b2c3d4e5f", phase: "install", state: "failed" };
  it("names the cause for every install code, and an owner or admin gets a Try again action", () => {
    const codes = { deps_failed: "Engine install stopped", bootstrap_failed: "Engine install stopped", job_silent: "box-1 stopped answering", job_expired: "box-1 stopped answering", engine_fetch_failed: "couldn't be fetched on box-1", push_failed: "Couldn't push", direct_raced: "The repo changed", pr_open_failed: "Couldn't open the install PR", install_head_changed: "pull request was closed" };
    for (const [code, words] of Object.entries(codes)) {
      const v = at(failed(code), "install", { setup: installSetup });
      expect(text(v), code).toContain(words);
      expect(text(v), code).not.toContain(code);
      expect(v.actions, code).toEqual([{ id: "retry_install", label: "Try again", run: true }]);
    }
  });
  it("tells a member who can retry and offers no action", () => {
    const v = at(failed("deps_failed"), "install", { setup: installSetup, isAdmin: false });
    expect(v.actions).toEqual([]);
    expect(text(v)).toContain("Ask an owner or admin to try again");
  });
  it("offers no Try again when the setup is not at the install step (the cloud would refuse it), and shows a refused retry's sentence", () => {
    expect(at(failed("deps_failed"), "install", { setup: { ...installSetup, phase: "await_merge" } }).actions).toEqual([]);
    expect(at(failed("deps_failed"), "install", {}).actions).toEqual([]);
    expect(text(at(failed("deps_failed"), "install", { setup: installSetup, installNote: "GitHub couldn't be reached. Start the install again in a minute." }))).toContain("GitHub couldn't be reached");
  });
  it("reads as running once the retry started the next attempt (state active, setup started), and says nothing of the old failure", () => {
    const steps = track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "done", install: "active" });
    const v = at(steps, "install", { setup: { ...installSetup, state: "started" } });
    expect(text(v)).toBe("The install is running on box-1.");
    expect(v.actions).toEqual([]);
    expect(text(at(steps, "install", { setup: { ...installSetup, phase: "plan", state: "ok" } }))).toBe("");
  });
  it("names the machine while the install runs, and says \"your machine\" when it has no name (never an empty clause)", () => {
    const steps = track({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "done", install: "active" });
    const setup = { ...installSetup, state: "started" };
    expect(text(at(steps, "install", { setup, name: "box-1" }))).toBe("The install is running on box-1.");
    for (const name of ["", undefined, null]) expect(text(at(steps, "install", { setup, name }))).toBe("The install is running on your machine.");
  });
  it("says a refused retry in words, never the server's own, and rereads when the setup moved on", () => {
    expect(retryRefusal({ code: "github_unavailable", message: "SERVER" })).toEqual({ text: "GitHub couldn't be reached. Start the install again in a minute.", reread: false });
    expect(retryRefusal({ code: "not_retryable", message: "SERVER" })).toEqual({ text: "The install couldn't be started again. Try again.", reread: true });
    expect(retryRefusal({ code: "forbidden" }).text).toBe("Only owners and admins can start the install again.");
    expect(retryRefusal({ code: "forbidden" }).text).not.toBe(retryRefusal({ code: "public_repo" }).text);
    expect(at(failed("job_silent"), "install", { setup: installSetup, name: "" }).lines[0]).toBe("Your machine stopped answering during the install. Try again");
    expect(at(failed("job_silent"), "install", { setup: installSetup, name: "box-1" }).lines[0]).toBe("box-1 stopped answering during the install. Try again");
    expect(retryRefusal(null)).toEqual({ text: "The install couldn't be started again. Try again.", reread: false });
  });
  it("gives the install its own words for a public repo, apart from the survey's", () => {
    const install = approveWords({ install: null, gate: null, install_error: { code: "public_repo", message: "SERVER" } }).lines[0];
    expect(install).toBe("Approved. This repo is public, so the engine installs into its private repo instead. Set that up first, then start the install again. Choose Start the install to try again.");
    expect(install).not.toContain("survey");
    expect(retryRefusal({ code: "public_repo" }).text).not.toContain("survey");
    expect(draftRefusal({ code: "public_repo" }).text).toBe("This repo is public, so the survey can't run again. Write your own plan instead.");
  });
});
