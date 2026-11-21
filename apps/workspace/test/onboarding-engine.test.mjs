// apps/workspace/test/onboarding-engine.test.mjs
//
// D#845 ON-6: the engine track's copy (apps/onboarding/onboarding-engine.js) and the parsing of both tracks (core/onboarding-mode.js).
// Every row of the track's state table has a fixture and an assertion on its copy. The drawn screen (the track choice, Copy buttons, phone and
// tablet layout) is in e2e/onboarding.spec.ts.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseSteps, parseTracks, shownTracks } from "../shell/core/onboarding-mode.js";
import {
  ASK_OWNER, LABELS, NO_KVM, OPERATE_OFF, STATE_WORDS, TIME_TO_LIVE,
  cleanOrigin, copyText, describeStep, enginePrice, fixFor, machineChoiceLine, machineCommands, machineContext, prerequisites, visibilityLabel,
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
