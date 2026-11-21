// apps/workspace/test/team-runners.test.mjs
//
// Which runner the Team app's watch switch means (team-runners.js), the runner list read, and the connecting state (team-model.js), against a fake client.
// The page itself, on the built output at desktop, tablet and phone widths, is e2e/team-runners.spec.ts.
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { readFleet } from "../apps/runners/runners-fleet.js";
import { REPOS_URL, RUNNERS_URL, SETTINGS_URL, createTeamApi, panelUrl, commandsUrl, dialsUrl } from "../apps/team/team-model.js";
import { WORDS, createTeam, describe as describeState, readSettings } from "../apps/team/team-model.js";
import { RUNNER_WORDS, commandFor, runnerView } from "../apps/team/team-runners.js";
import { HOSTILE, REPO_A, REPO_B, RUNNER_A, RUNNER_B, makeFixtures } from "./fixtures/team/fixtures.mjs";

const NOW = Date.parse("2026-11-16T15:00:00.000Z");
const F = makeFixtures(NOW);
const flush = () => new Promise((r) => setTimeout(r, 0));
const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

const paired = (over = {}) => F.settings({ repos: [F.settingsRepo({ bridged_runner_id: RUNNER_A, ...over })] });
const view = (o) => runnerView({ nowMs: NOW, pickId: "", repoName: "", settings: readSettings(paired()), fleet: null, ...o });
const fleetOf = (...runners) => readFleet(F.fleet(runners));
const live = (o = {}) => view({ fleet: fleetOf(F.runner(o)) });
const two = () => F.settings({ repos: [F.settingsRepo({ bridged_runner_id: RUNNER_A }), F.settingsRepo({ repo_id: REPO_B, full_name: "acme-labs/site", bridged_runner_id: RUNNER_B })] });
const twoRunners = () => fleetOf(F.runner(), F.runner({ id: RUNNER_B, name: "Build box", state: "offline" }));

describe("connect panel: copy words, and a runner without a name", () => {
  it("the copy words are plain and never claim a state", () => {
    expect([RUNNER_WORDS.copy, RUNNER_WORDS.copied]).toEqual(["Copy command", "Copied"]);
    expect(RUNNER_WORDS.copyFailed).toMatch(/copy it by hand/);
    expect(RUNNER_WORDS.copyLabel).toBeUndefined(); // the visible text is the name (WCAG 2.5.3)
  });
  it("a runner with no name is marked, in its row and as the picked runner; a named one is not", () => {
    const un = view({ fleet: fleetOf(F.runner({ has_name: false, name: null })) });
    expect(un.unnamed).toBe(true);
    expect(un.connect.rows[0].unnamed).toBe(true);
    expect(un.connect.rows[0].name).toMatch(/^Unnamed runner/);
    const named = live();
    expect([named.unnamed, named.connect.rows[0].unnamed]).toEqual([false, false]);
    expect(view({ fleet: null }).unnamed).toBe(false); // nothing is claimed before the list arrives
  });
  it("the rename hint points at the Machines app, not at a flag that may not exist", () => {
    expect(RUNNER_WORDS.unnamed).toMatch(/Machines/);
    expect(RUNNER_WORDS.rename).toBe("Name it in Machines");
  });
});

describe("the watch switch names its runner", () => {
  it("names the runner in the label, never 'this machine'", () => {
    const v = live();
    expect(v.label).toBe("Watch the engine team on Workshop laptop");
    expect(strings(v).join(" ")).not.toMatch(/this machine/);
  });
  it("online: says online with its last seen time", () => expect(live().status).toEqual({ kind: "online", text: "Online · last seen 2 min ago" }));
  it("offline: says offline with its last seen time", () => {
    const v = live({ state: "offline", last_seen_at: new Date(NOW - 3 * 3600e3).toISOString() });
    expect(v.status).toEqual({ kind: "offline", text: "Offline · last seen 3 h ago" });
  });
  it("a runner never seen says so", () => expect(live({ state: "offline", last_seen_at: null }).status.text).toBe("Offline · never seen"));
  it("bridge not set up on any runner: the one command, the repo filled in, nothing to edit", () => {
    const v = view({ settings: readSettings(paired({ bridged_runner_id: null })), fleet: fleetOf(F.runner()) });
    expect(v.status.kind).toBe("unset");
    expect(v.command).toBe("fx-runner engine-bridge enable --repo acme-labs/widgets");
    expect(v.label).toBe(RUNNER_WORDS.watchAny);
  });
  it("no runner registered: says so and shows no command to run yet", () => {
    const v = view({ fleet: fleetOf() });
    expect(v.connect.empty).toBe(true);
    expect(v.status.text).toBe(RUNNER_WORDS.noRunners);
    expect(v.command).toBe("");
  });
  it("a runner list that could not be read says so and keeps the label", () => {
    const v = view({ fleet: null });
    expect(v.status.kind).toBe("unknown");
    expect(v.connect.failed).toBe(true);
    expect(v.label).toBe(RUNNER_WORDS.watchAny);
  });
  it("several bridged runners offer a choice, and the choice names the label", () => {
    const v = view({ settings: readSettings(two()), fleet: twoRunners() });
    expect(v.choices.map((c) => c.name)).toEqual(["Workshop laptop", "Build box"]);
    expect(view({ settings: readSettings(two()), fleet: twoRunners(), pickId: RUNNER_B }).label).toBe("Watch the engine team on Build box");
    expect(view({ settings: readSettings(two()), fleet: twoRunners(), pickId: "not-a-runner" }).label).toBe("Watch the engine team on Workshop laptop");
  });
  it("one bridged runner offers no choice", () => expect(live().choices).toEqual([]));
  it("a hostile runner name stays plain text in the label", () => expect(live({ name: HOSTILE }).label).toBe("Watch the engine team on " + HOSTILE));
});

describe("the connect list", () => {
  it("a revoked runner is not offered", () => expect(view({ fleet: fleetOf(F.runner({ state: "revoked" })) }).connect.rows).toEqual([]));
  it("shows each runner's state, last seen and whether the bridge is set up for this repo", () => {
    const rows = view({ fleet: twoRunners(), repoName: "acme-labs/widgets" }).connect.rows;
    expect(rows.map((r) => [r.name, r.online, r.bridge])).toEqual([["Workshop laptop", true, "Bridge has reported for acme-labs/widgets"], ["Build box", false, "No report from this runner's bridge for acme-labs/widgets yet"]]);
    expect(rows[0].seen).toBe("last seen 2 min ago");
  });
  it("the bridge shows for the repo being looked at, not for another repo's runner", () => {
    const rows = view({ settings: readSettings(two()), fleet: twoRunners(), repoName: "acme-labs/site" }).connect.rows;
    expect(rows.map((r) => r.bridged)).toEqual([false, true]);
  });
  it("an unnamed repository gives no command at all, and the page says why instead of a placeholder", () => {
    expect(commandFor("Unnamed repository (6f1c2f5e)")).toBe("");
    expect(commandFor("")).toBe("");
    expect(commandFor("acme-labs/widgets")).toBe("fx-runner engine-bridge enable --repo acme-labs/widgets");
    const v = view({ settings: readSettings(paired({ full_name: "Unnamed repository (6f1c2f5e)", bridged_runner_id: null })), fleet: fleetOf(F.runner()) });
    expect([v.command, v.connect.command]).toEqual(["", ""]);
    expect(RUNNER_WORDS.noRepoName).toMatch(/no command to show/);
  });
  // ON-BR-3 criterion 1: no <...> placeholder in any state that shows the command, and the old wording is gone (criterion 5).
  it("no state shows a placeholder, and the words never ask the person to replace anything", () => {
    const states = [
      view({ settings: readSettings(paired({ bridged_runner_id: null })), fleet: fleetOf(F.runner()) }),
      view({ settings: readSettings(paired({ bridged_runner_id: null })), fleet: fleetOf(F.runner(), F.runner({ id: RUNNER_B, name: "Build box", state: "offline" })) }),
      view({ settings: readSettings(paired({ full_name: "Unnamed repository (6f1c2f5e)", bridged_runner_id: null })), fleet: fleetOf(F.runner()) }),
      view({ settings: readSettings(paired({ bridged_runner_id: null })), fleet: fleetOf(F.runner()), root: "/srv/my engine" }),
      view({ fleet: twoRunners() }), view({ fleet: null }), view({ fleet: fleetOf() }),
    ];
    for (const v of states) expect(strings(v).join("\n")).not.toMatch(/<[^>\n]*>|placeholder|replace the/i);
    expect(strings(RUNNER_WORDS).join("\n")).not.toMatch(/<[^>\n]*>|placeholder|replace the/i);
  });
  it("the runner's discovered folder is quoted for a shell and shown only to an owner or admin", () => {
    const unset = { settings: readSettings(paired({ bridged_runner_id: null })), fleet: fleetOf(F.runner()), root: "/srv/engine" };
    expect(view(unset).command).toBe("fx-runner engine-bridge enable --repo acme-labs/widgets --repo-root /srv/engine");
    const member = readSettings(F.settings({ can_edit: false, repos: [F.settingsRepo({ bridged_runner_id: null })] }));
    expect(view({ ...unset, settings: member }).command).toBe("fx-runner engine-bridge enable --repo acme-labs/widgets");
    expect(commandFor("acme-labs/widgets", "relative/dir")).toBe("fx-runner engine-bridge enable --repo acme-labs/widgets"); // not an absolute path: left out
    expect(commandFor("acme-labs/widgets", "/a\nb")).toBe("fx-runner engine-bridge enable --repo acme-labs/widgets");
  });
  it("four awkward folder names each survive a real shell word for word", () => {
    for (const dir of ["/srv/my engine", "/srv/it's here", "/srv/a'b c'd", "/srv/$HOME/`x`;rm -rf \"q\" *"]) {
      const cmd = commandFor("acme-labs/widgets", dir);
      const out = execFileSync("sh", ["-c", "set -- " + cmd.replace("fx-runner engine-bridge enable", "") + '; printf "%s\\0" "$@"'], { env: {} }).toString().split("\0");
      expect(out.slice(0, 3)).toEqual(["--repo", "acme-labs/widgets", "--repo-root"]);
      expect(out[3]).toBe(dir);
    }
  });
  it("the first-run order reads command, then the switch, and never claims the bridge is missing", () => {
    const v = view({ settings: readSettings(paired({ bridged_runner_id: null })), fleet: fleetOf(F.runner()) });
    expect(v.status.text).toMatch(/Run this on the computer that runs your engine, then turn the switch on/);
    expect(v.connect.rows[0].bridge).toBe("No report from this runner's bridge for acme-labs/widgets yet");
    expect(strings(v).join(" ")).not.toMatch(/not set up/i);
  });
  it("the command carries the repo and no path of the server's", () => {
    expect(view({ fleet: twoRunners() }).connect.command).toContain("--repo acme-labs/widgets");
    expect(strings(view({ fleet: twoRunners() })).join(" ")).not.toMatch(/\/(home|Users|tmp|var)\//);
  });
});

describe("the settings read and the controller", () => {
  it("carries the bridged runner, and a repo without one reads empty", () => {
    expect(readSettings(paired()).repos[0].runnerId).toBe(RUNNER_A);
    expect(readSettings(F.settings()).repos[0].runnerId).toBe("");
  });

  function team(routes) {
    const log = [];
    const all = {
      ["GET " + RUNNERS_URL]: F.fleet([F.runner()]), ["GET " + SETTINGS_URL]: paired(), ["GET " + REPOS_URL]: F.list([F.repo()]),
      ["GET " + commandsUrl(REPO_A) + "?limit=50"]: F.commands([]), ["GET " + dialsUrl(REPO_A)]: F.dials(),
      ...Object.fromEntries(["agents", "lanes", "gates", "log", "plan", "stats", "usage"].map((k) => ["GET " + panelUrl(k, REPO_A), k === "plan" ? null : k === "stats" ? F.stats() : k === "usage" ? F.usage() : F.envelope([])])),
      ["PUT " + SETTINGS_URL]: { ok: true }, ...routes,
    };
    const call = vi.fn(async (m, p, b) => {
      log.push(m + " " + p);
      const r = all[m + " " + p];
      if (r === undefined) throw Object.assign(new Error("x"), { status: 404 });
      const v = typeof r === "function" ? await r(b) : r;
      if (v instanceof Error) throw v;
      return v;
    });
    const t = createTeam({ client: createTeamApi(call), setTimer: () => 0, clearTimer: () => {}, setRepeat: () => 0, clearRepeat: () => {}, now: () => NOW });
    t.view = () => describeState(t.state, NOW);
    return { t, log };
  }

  it("watch on, sheet closed: the runner list is not read", async () => {
    const { t, log } = team({});
    await t.load();
    expect(log).not.toContain("GET " + RUNNERS_URL);
  });
  it("opening the sheet reads the runners once and the label names the runner", async () => {
    const { t, log } = team({});
    await t.load();
    t.toggleSheet();
    await flush();
    expect(log.filter((p) => p === "GET " + RUNNERS_URL)).toHaveLength(1);
    expect(t.view().sheet.runner.label).toBe("Watch the engine team on Workshop laptop");
  });
  it("a failing runners read never fails the app", async () => {
    const { t } = team({ ["GET " + RUNNERS_URL]: Object.assign(new Error("x"), { status: 500 }) });
    await t.load();
    t.toggleSheet();
    await flush();
    expect(t.state.status).toBe("ready");
    expect(t.view().sheet.runner.status.kind).toBe("unknown");
  });
  it("watch on with no repository enabled: the view says so and still carries the switch state and the wording to fix it", async () => {
    const { t } = team({ ["GET " + REPOS_URL]: F.list([]) });
    await t.load();
    const v = t.view();
    expect(v.kind).toBe("norepos");
    expect(v.sheet.watch).toBe(true);
    expect(v.sheet.canEdit).toBe(true);
    expect(v.rv.label).toMatch(/^Watch the engine team on /);
    expect(WORDS.noReposOn).toMatch(/Settings/);
    expect(WORDS.openSettings).toBe("Open Settings");
  });
  it("watch off: the off screen names the runner", async () => {
    const { t } = team({ ["GET " + SETTINGS_URL]: { ...paired(), watch_enabled: false } });
    await t.load();
    expect(t.view().kind).toBe("off");
    expect(t.view().rv.label).toBe("Watch the engine team on Workshop laptop");
  });
  it("connecting: a repo its runner has never reported for says which runner it waits for, and is not live", async () => {
    const never = F.repo({ liveness: "never", runner_id: null, runner_name: null, session_id: null, last_event_at: null, last_heard_at: null });
    const { t } = team({ ["GET " + REPOS_URL]: F.list([never]) });
    await t.load();
    t.toggleSheet();
    await flush();
    const v = t.view();
    expect(v.kind).toBe("ready");
    expect(v.rv.connecting).toBe("Connecting to Workshop laptop… waiting for it to report in.");
    expect(v.chip).toBe("Never connected");
  });
  it("a live repo is not connecting", async () => {
    const { t } = team({});
    await t.load();
    expect(t.view().rv.connecting).toBe("");
  });
  it("switching on shows connecting while the save is out, not live", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { t } = team({ ["GET " + SETTINGS_URL]: { ...paired(), watch_enabled: false }, ["PUT " + SETTINGS_URL]: async () => { await gate; return { ok: true }; } });
    await t.load();
    const p = t.setWatch(true);
    await flush();
    expect(t.view().rv.connecting).toMatch(/^Connecting to Workshop laptop…/);
    release();
    await p;
  });
  it("choosing a runner moves the label", async () => {
    const { t } = team({ ["GET " + SETTINGS_URL]: two(), ["GET " + RUNNERS_URL]: twoRunners().runners && F.fleet([F.runner(), F.runner({ id: RUNNER_B, name: "Build box" })]) });
    await t.load();
    t.toggleSheet();
    await flush();
    t.pickRunner(RUNNER_B);
    expect(t.view().sheet.runner.label).toBe("Watch the engine team on Build box");
  });
});
