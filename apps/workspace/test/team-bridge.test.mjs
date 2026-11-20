// apps/workspace/test/team-bridge.test.mjs
//
// One-click Connect in the Team app (team-bridge.js, and its place in team-model.js), against a fake client: what each state says and offers, that a folder is only
// ever text, who sees a path, what a press sends, and the order of events from press to answer. The page itself, at desktop, tablet and phone widths, is e2e/team.spec.ts.
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { BRIDGE_WORDS, bridgeFailureWords, bridgeView, commandFor, createBridge, folderLabels, readBridge } from "../apps/team/team-runners.js";
import { createTeam, createTeamApi, describe as describeState, readSettings } from "../apps/team/team-model.js";
import { REPO_A, makeFixtures } from "./fixtures/team/fixtures.mjs";

const NOW = Date.parse("2026-11-16T15:00:00.000Z");
const F = makeFixtures(NOW);
const flush = () => new Promise((r) => setTimeout(r, 0));
const R1 = "9d2c7b1e-5f3a-4e8b-8a6d-1c2b3a4d5e66";
const R2 = "9d2c7b1e-5f3a-4e8b-8a6d-1c2b3a4d5e77";
const runner = (over = {}) => ({ id: R1, name: "Studio laptop", has_name: true, online: true, protocol_ok: true, last_seen_at: new Date(NOW - 60_000).toISOString(), ...over });
const cmd = (over = {}) => ({ id: "c0000000-0000-4000-8000-000000000001", kind: "bridge_enable", runner_id: R1, runner_name: "Studio laptop", state: "pending", result: null, refusal: null, root_tail: null, candidates: [], issued_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 600_000).toISOString(), acked_at: null, ...over });
const raw = (over = {}) => ({ phase: "idle", plan: "send", runners: [runner()], connected: null, command: null, ...over });
const bridge = (data, over = {}) => ({ repoId: REPO_A, data: readBridge(data), failed: false, busy: false, notice: "", runnerPick: "", rootPick: "", ...over });
const view = (data, over = {}, o = {}) => bridgeView(bridge(data, over), { repoName: "acme-labs/widgets", canEdit: true, nowMs: NOW, ...o });
const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

describe("what the cloud said is read strictly", () => {
  it("accepts the shape the route sends and refuses anything else", () => {
    expect(readBridge(raw())).not.toBeNull();
    for (const bad of [null, [], {}, raw({ phase: "teleporting" }), raw({ plan: "maybe" }), raw({ runners: "x" }), raw({ runners: [{ id: 1 }] }), raw({ command: { id: 1 } }), raw({ command: cmd({ kind: "start_day" }) }), raw({ connected: { runner_name: 4 } })]) expect(readBridge(bad)).toBeNull();
  });
  it("keeps a folder only when it is a plain absolute path, and at most ten", () => {
    const paths = ["/work/a/site", "relative", "/work/b\nc/site", "/work/e‮f/site", ...Array.from({ length: 12 }, (_, i) => `/w/${i}/site`)];
    const got = readBridge(raw({ phase: "ambiguous", command: cmd({ state: "refused", candidates: paths }) }));
    expect(got.command.candidates).toHaveLength(10);
    expect(got.command.candidates[0]).toBe("/work/a/site");
    expect(got.command.candidates).not.toContain("relative");
    expect(got.command.candidates.some((p) => /[\n‮]/.test(p))).toBe(false);
  });
  it("tells folders that end alike apart by their parent, and shows two parts otherwise", () => {
    expect(folderLabels(["/home/me/code/acme/site", "/home/me/other/site"])).toEqual(["acme/site", "other/site"]);
    expect(folderLabels(["/a/work/site", "/b/work/site"])).toEqual(["…/a/work/site", "…/b/work/site"]);
  });
});

describe("each state, its words and its next step", () => {
  it("idle with one online runner: a Connect button, no runner picker", () => {
    const v = view(raw());
    expect(v).toMatchObject({ kind: "idle", canConnect: true, choices: [] });
  });
  it("idle with several online runners: a picker by name, the first picked", () => {
    const v = view(raw({ plan: "choose", runners: [runner(), runner({ id: R2, name: "Desk machine" })] }));
    expect(v.kind).toBe("idle");
    expect(v.choices.map((c) => c.name)).toEqual(["Studio laptop", "Desk machine"]);
    expect(v.picked).toBe(R1);
    expect(view(raw({ plan: "choose", runners: [runner(), runner({ id: R2, name: "Desk machine" })] }), { runnerPick: R2 }).picked).toBe(R2);
  });
  it("connecting: the sentence, a spinner state and Cancel; after 60 s with no answer, 'Still waiting', with Try again", () => {
    const v = view(raw({ phase: "connecting", command: cmd() }));
    expect(v).toMatchObject({ kind: "connecting", text: "Asking Studio laptop to connect...", cancelId: cmd().id });
    const slow = view(raw({ phase: "connecting", command: cmd({ issued_at: new Date(NOW - 61_000).toISOString() }) }));
    expect(slow).toMatchObject({ kind: "slow", text: "Still waiting for Studio laptop. Is it running?", retry: true });
    expect(view(raw({ phase: "connecting", command: cmd({ issued_at: new Date(NOW - 59_000).toISOString() }) })).kind).toBe("connecting");
  });
  it("connected: the folder's last two parts, the runner, Disconnect, and the way to undo a wrong pick", () => {
    const v = view(raw({ phase: "connected", connected: { runner_id: R1, runner_name: "Studio laptop", root_tail: "acme/widgets", root: "/home/me/code/acme/widgets" } }));
    expect(v).toMatchObject({ kind: "connected", text: "Connected to acme/widgets on Studio laptop", canDisconnect: true });
    expect(v.tip).toMatch(/Disconnect, then Connect again/);
  });
  it("disconnecting: asks while the runner is online, and says it will when it is back when it is not", () => {
    const connected = { runner_id: R1, runner_name: "Studio laptop", root_tail: "acme/widgets", root: null };
    expect(view(raw({ phase: "disconnecting", connected, command: cmd({ kind: "bridge_disable" }) })).text).toBe("Asking Studio laptop to disconnect...");
    const away = view(raw({ phase: "disconnecting", runners: [runner({ online: false })], connected, command: cmd({ kind: "bridge_disable" }) }));
    expect(away.text).toBe("Will disconnect when Studio laptop is back online");
    expect(away.kind).toBe("disconnecting");
    expect(away.cancelId).not.toBe("");
  });
  it("a disconnect that ran out unanswered says it did not reach the runner, with Disconnect still offered, and offers nothing to a member", () => {
    const data = raw({ phase: "disconnect_failed", connected: { runner_id: R1, runner_name: "Studio laptop", root_tail: "acme/widgets", root: null }, command: cmd({ kind: "bridge_disable", state: "expired" }) });
    const v = view(data);
    expect(v).toMatchObject({ kind: "disconnect_failed", text: "Disconnect did not reach Studio laptop; try again", canDisconnect: true });
    expect(v.text).not.toMatch(/Connected to|Will disconnect/);
    expect(view(data, {}, { canEdit: false }).canDisconnect).toBe(false);
    expect(readBridge(data).phase).toBe("disconnect_failed");
  });
  it("not found: the runner's words, the fallback command with the repo filled in, a place to give the folder, and the folders it skipped to pick from", () => {
    const v = view(raw({ phase: "not_found", command: cmd({ state: "refused", result: "not_found", refusal: "checkout_not_found", skipped: ["/work/shared/widgets"] }) }));
    expect(v).toMatchObject({ kind: "not_found", text: "Studio laptop looked on this computer and found no copy of acme-labs/widgets", folderBox: true, canPick: false, retry: true });
    expect(v.command).toBe("fx-runner engine-bridge enable --repo acme-labs/widgets");
    expect(v.skipped).toMatch(/skipped/);
    expect(v.rows.map((r) => r.label)).toEqual(["shared/widgets"]);
    expect(v.commandFor("/work/it's here")).toBe("fx-runner engine-bridge enable --repo acme-labs/widgets --repo-root '/work/it'\\''s here'");
    expect(v.commandFor("relative")).toBe("fx-runner engine-bridge enable --repo acme-labs/widgets");
  });
  it("ON-BR-4: a not_found from a capped search says the search was cut short, and keeps the command and the folder box; one that finished does not; a value that is not true is read as false", () => {
    const capped = view(raw({ phase: "not_found", command: cmd({ state: "refused", result: "not_found", refusal: "checkout_not_found", incomplete: true }) }));
    expect(capped).toMatchObject({ kind: "not_found", cutShort: true, folderBox: true, canPick: false, retry: true });
    expect(capped.text).toBe("Studio laptop looked on this computer and found no copy of acme-labs/widgets, but its search was cut short, so a copy may be somewhere it did not reach. Type the folder below to get a command you can run yourself.");
    expect(capped.command).toBe("fx-runner engine-bridge enable --repo acme-labs/widgets");
    expect(capped.commandFor("/work/widgets")).toBe("fx-runner engine-bridge enable --repo acme-labs/widgets --repo-root /work/widgets");
    expect(view(raw({ phase: "not_found", command: cmd({ state: "refused", result: "not_found", incomplete: true }) }), {}, { canEdit: false }).text).toBe("Studio laptop looked on this computer and found no copy of acme-labs/widgets, but its search was cut short, so a copy may be somewhere it did not reach. An owner or an admin can give the folder.");
    const member = view(raw({ phase: "not_found", command: cmd({ state: "refused", result: "not_found", incomplete: true }) }), {}, { canEdit: false });
    expect(member.text).not.toMatch(/Type the folder/);
    expect(member).toMatchObject({ cutShort: true, folderBox: false });
    for (const value of [false, undefined, "true", 1, null]) {
      const v = view(raw({ phase: "not_found", command: cmd({ state: "refused", result: "not_found", incomplete: value }) }));
      expect(v.cutShort).toBe(false);
      expect(v.text).not.toMatch(/cut short/);
    }
    expect(BRIDGE_WORDS.giveFolder).toBe("Or type the folder, to get a command you can run yourself");
  });
  it("ambiguous: a list of the folders and a button that sends the pick; the pick shows as chosen", () => {
    const data = raw({ phase: "ambiguous", command: cmd({ state: "refused", result: "ambiguous", refusal: "checkout_ambiguous", candidates: ["/home/me/a/widgets", "/home/me/b/widgets"] }) });
    const v = view(data, { rootPick: "/home/me/b/widgets" });
    expect(v).toMatchObject({ kind: "ambiguous", canPick: true });
    expect(v.rows).toEqual([{ path: "/home/me/a/widgets", label: "a/widgets", picked: false }, { path: "/home/me/b/widgets", label: "b/widgets", picked: true }]);
  });
  it("incomplete: names the one copy it found, and offers it for a one-click confirm", () => {
    const v = view(raw({ phase: "incomplete", command: cmd({ state: "refused", result: "refused", refusal: "checkout_incomplete", candidates: ["/home/me/code/acme/widgets"] }) }));
    expect(v.kind).toBe("incomplete");
    expect(v.text).toMatch(/stopped early after finding one copy, and there may be another it did not reach: acme\/widgets\. If it is the right one, confirm it:/);
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].picked).toBe(true); // the single folder is already chosen: confirming is one press
  });
  it("a member sees a sentence saying an owner or admin can pick, and no empty list, for ambiguous and incomplete", () => {
    for (const [phase, refusal, candidates] of [["ambiguous", "checkout_ambiguous", ["/home/me/a/w", "/home/me/b/w"]], ["incomplete", "checkout_incomplete", ["/home/me/a/w"]]]) {
      const v = view(raw({ phase, command: cmd({ state: "refused", result: phase === "ambiguous" ? "ambiguous" : "refused", refusal, candidates: [] }) }), {}, { canEdit: false });
      expect(v.text, phase).toMatch(/An owner or an admin can pick which copy to use\./);
      expect(v.rows, phase).toEqual([]);
      expect(v.canPick, phase).toBe(false);
      void candidates;
    }
  });
  it("Cancel stays for a command's whole life: the slow state carries it too", () => {
    const slow = view(raw({ phase: "connecting", command: cmd({ issued_at: new Date(NOW - 300_000).toISOString() }) }));
    expect(slow).toMatchObject({ kind: "slow", cancelId: cmd().id, retry: true });
    expect(view(raw({ phase: "connecting", command: cmd({ issued_at: new Date(NOW - 300_000).toISOString() }) }), {}, { canEdit: false }).cancelId).toBe("");
  });
  it("a disconnect the runner refused says so with the reason, and Disconnect is offered again", () => {
    const v = view(raw({ phase: "disconnect_refused", connected: { runner_id: R1, runner_name: "Studio laptop", root_tail: "acme/widgets", root: null }, command: cmd({ kind: "bridge_disable", state: "refused", refusal: "settings_damaged" }) }));
    expect(v).toMatchObject({ kind: "disconnect_refused", canDisconnect: true });
    expect(v.text).toMatch(/^Disconnect refused: .*bridge settings file is damaged/);
    expect(view(raw({ phase: "refused", command: cmd({ state: "refused", result: "refused", refusal: "checkout_unsafe" }) })).text).toMatch(/chmod go-w/);
  });
  it("refused: the reason in plain words, never the code alone, and the code on its own for Copy details", () => {
    const v = view(raw({ phase: "refused", command: cmd({ state: "refused", result: "refused", refusal: "state_dir_missing" }) }));
    expect(v).toMatchObject({ kind: "refused", code: "state_dir_missing" });
    expect(v.text).toMatch(/state folder .* does not exist/);
    expect(v.text).not.toContain("state_dir_missing");
    // A code this screen has no sentence for still says something plain.
    expect(view(raw({ phase: "refused", command: cmd({ state: "refused", result: "refused", refusal: "something_new" }) })).text).toBe(BRIDGE_WORDS.failed);
  });
  it("every closed refusal the cloud can send has a sentence of its own", () => {
    const codes = ["checkout_layout_unexpected", "checkout_incomplete", "checkout_mismatch", "repo_root_invalid", "repo_not_paired", "engine_version_unusable", "state_dir_missing", "state_dir_unreadable", "state_dir_shared", "state_dir_reserved", "state_dir_unchecked", "too_many_repos", "settings_damaged", "bridge_failed"];
    for (const code of codes) {
      const text = view(raw({ phase: "refused", command: cmd({ state: "refused", result: "refused", refusal: code }) })).text;
      expect(text, code).not.toBe(BRIDGE_WORDS.failed);
      expect(text, code).not.toContain(code);
      expect(text.length, code).toBeGreaterThan(20);
    }
  });
  it("no runner, none online, and an old runner: the fallback command, the words for each, and nothing that sends", () => {
    const none = view(raw({ plan: "no_runner", runners: [] }));
    const offline = view(raw({ plan: "offline", runners: [runner({ online: false })] }));
    const old = view(raw({ plan: "old", runners: [runner({ protocol_ok: false })] }));
    for (const v of [none, offline, old]) {
      expect(v.kind).toBe("fallback");
      expect(v.command).toBe("fx-runner engine-bridge enable --repo acme-labs/widgets");
      expect(v.canConnect).toBeUndefined();
    }
    expect(old.text).toMatch(/Your runner is out of date: run fx-runner update/);
    expect(offline.text).not.toMatch(/out of date/);
  });
  it("an unreadable answer says so and offers nothing", () => {
    const v = bridgeView({ ...bridge(raw()), data: null, failed: true }, { repoName: "acme-labs/widgets", canEdit: true, nowMs: NOW });
    expect(v).toMatchObject({ kind: "unknown", text: BRIDGE_WORDS.readFailed });
  });
});

describe("who sees what", () => {
  const connected = raw({ phase: "connected", connected: { runner_id: R1, runner_name: "Studio laptop", root_tail: "acme/widgets", root: null } });
  it("a member sees the last two parts and no button, and the command has no path in it", () => {
    const v = view(connected, {}, { canEdit: false });
    expect(v).toMatchObject({ kind: "connected", canDisconnect: false, command: "fx-runner engine-bridge enable --repo acme-labs/widgets" });
    expect(JSON.stringify(v)).not.toContain("/home");
    const idle = view(raw(), {}, { canEdit: false });
    expect(idle.canConnect).toBe(false);
    expect(view(raw({ phase: "ambiguous", command: cmd({ state: "refused", result: "ambiguous", candidates: [] }) }), {}, { canEdit: false }).canPick).toBe(false);
  });
  it("an owner's command carries the folder the runner reported, quoted for a shell; four awkward names round-trip through a real shell", () => {
    const names = ["/work/plain/site", "/work/with space/site", "/work/it's/site", "/work/$HOME/`x`/site"];
    for (const root of names) {
      const v = view(raw({ phase: "connected", connected: { runner_id: R1, runner_name: "Studio laptop", root_tail: "x/site", root } }));
      expect(v.command).toBe(commandFor("acme-labs/widgets", root));
      const out = execFileSync("sh", ["-c", `set -- ${v.command.replace(/^fx-runner engine-bridge enable --repo acme-labs\/widgets --repo-root /, "")}; printf '%s' "$1"`], { encoding: "utf8" });
      expect(out).toBe(root);
    }
  });
});

describe("a folder is text, never a link, and no state shows undefined", () => {
  it("a hostile folder name is data: it appears escaped as text and the view holds no markup", () => {
    const evil = '/work/<img src=x onerror=alert(1)>/site';
    const v = view(raw({ phase: "ambiguous", command: cmd({ state: "refused", result: "ambiguous", candidates: [evil, "/work/ok/site"] }) }));
    expect(v.rows[0].label).toBe("<img src=x onerror=alert(1)>/site");
    expect(v.rows[0].path).toBe(evil);
  });
  it("no state, for owner or member, holds undefined, null, [object Object], an empty list sentence, or a path of more than two parts", () => {
    const states = [
      raw(), raw({ phase: "connecting", command: cmd() }), raw({ phase: "connecting", command: cmd({ issued_at: new Date(NOW - 99_000).toISOString() }) }),
      raw({ phase: "connected", connected: { runner_id: R1, runner_name: "Studio laptop", root_tail: "acme/widgets", root: "/home/me/code/acme/widgets" } }),
      raw({ phase: "disconnecting", connected: { runner_id: R1, runner_name: "Studio laptop", root_tail: null, root: null }, command: cmd({ kind: "bridge_disable" }) }),
      raw({ phase: "not_found", command: cmd({ state: "refused", result: "not_found" }) }),
      raw({ phase: "not_found", command: cmd({ state: "refused", result: "not_found", incomplete: true }) }),
      raw({ phase: "ambiguous", command: cmd({ state: "refused", result: "ambiguous", candidates: ["/home/me/a/w", "/home/me/b/w"] }) }),
      raw({ phase: "incomplete", command: cmd({ state: "refused", refusal: "checkout_incomplete", candidates: ["/home/me/a/w"] }) }),
      raw({ phase: "refused", command: cmd({ state: "refused", refusal: "bridge_failed" }) }),
      raw({ phase: "expired", command: cmd({ state: "expired" }) }), raw({ phase: "not_confirmed", command: cmd({ state: "not_confirmed" }) }),
      raw({ plan: "no_runner", runners: [] }), raw({ plan: "offline", runners: [runner({ online: false })] }), raw({ plan: "old", runners: [runner({ protocol_ok: false })] }),
    ];
    for (const data of states) {
      for (const canEdit of [true, false]) {
        const v = view(data, {}, { canEdit });
        const text = [v.text, v.tip, v.skipped, v.notice].filter(Boolean).join(" ");
        expect(text).not.toMatch(/undefined|null|\[object|NaN/);
        for (const s of strings({ text: v.text, tip: v.tip })) expect(s.split("/").filter(Boolean).length).toBeLessThanOrEqual(3);
        if (!canEdit) expect(JSON.stringify(v)).not.toMatch(/\/home\//);
      }
    }
  });
});

describe("the controller", () => {
  const settings = () => readSettings(F.settings());
  function rig(answers) {
    let current = answers.shift();
    const client = {
      bridge: vi.fn(async () => current),
      connectBridge: vi.fn(async () => { current = answers.shift() ?? current; return { command_id: "x" }; }),
      disconnectBridge: vi.fn(async () => { current = answers.shift() ?? current; return {}; }),
      cancel: vi.fn(async () => { current = answers.shift() ?? current; return {}; }),
    };
    let st = { settings: settings(), bridge: { repoId: REPO_A, data: null, failed: false, busy: false, notice: "", runnerPick: "", rootPick: "" } };
    const set = (p) => { st = { ...st, ...p }; };
    const ctl = createBridge({ client, signal: undefined, get: () => st, set, aborted: () => false });
    return { client, ctl, st: () => st };
  }
  it("reads, then a press sends one POST (no body when there is nothing to choose) and reads again", async () => {
    const { client, ctl, st } = rig([raw(), raw({ phase: "connecting", command: cmd() })]);
    await ctl.show(REPO_A);
    expect(st().bridge.data.phase).toBe("idle");
    await ctl.connect();
    expect(client.connectBridge).toHaveBeenCalledWith(REPO_A, {}, undefined);
    expect(st().bridge.data.phase).toBe("connecting");
    expect(ctl.waiting()).toBe(true);
    expect(st().bridge.busy).toBe(false);
  });
  it("sends the chosen runner and the picked folder, and clears the pick", async () => {
    const { client, ctl, st } = rig([raw({ plan: "choose", runners: [runner(), runner({ id: R2, name: "Desk machine" })] }), raw({ phase: "connecting", command: cmd() })]);
    await ctl.show(REPO_A);
    ctl.pickRunner(R2);
    ctl.pickRoot("/home/me/b/widgets");
    await ctl.connect();
    expect(client.connectBridge).toHaveBeenCalledWith(REPO_A, { runner_id: R2, repo_root: "/home/me/b/widgets" }, undefined);
    expect(st().bridge.rootPick).toBe("");
  });
  it("a folder is sent to the runner that offered it, not to the one the picker shows; a single offered folder needs no pick", async () => {
    const offered = raw({ plan: "choose", runners: [runner(), runner({ id: R2, name: "Desk machine" })], phase: "ambiguous", command: cmd({ runner_id: R2, runner_name: "Desk machine", state: "refused", result: "ambiguous", candidates: ["/home/me/a/w", "/home/me/b/w"] }) });
    const one = rig([offered, raw({ phase: "connecting", command: cmd() })]);
    await one.ctl.show(REPO_A);
    one.ctl.pickRunner(R1);
    one.ctl.pickRoot("/home/me/b/w");
    await one.ctl.connect();
    expect(one.client.connectBridge).toHaveBeenCalledWith(REPO_A, { runner_id: R2, repo_root: "/home/me/b/w" }, undefined);
    const single = rig([raw({ plan: "choose", runners: [runner(), runner({ id: R2, name: "Desk machine" })], phase: "incomplete", command: cmd({ runner_id: R2, state: "refused", result: "refused", refusal: "checkout_incomplete", candidates: ["/home/me/a/w"] }) }), raw()]);
    await single.ctl.show(REPO_A);
    await single.ctl.connect();
    expect(single.client.connectBridge).toHaveBeenCalledWith(REPO_A, { runner_id: R2, repo_root: "/home/me/a/w" }, undefined);
  });
  it("with several runners and no pick it sends the first online one, never nothing", async () => {
    const { client, ctl } = rig([raw({ plan: "choose", runners: [runner({ online: false }), runner({ id: R2, name: "Desk machine" })] }), raw()]);
    await ctl.show(REPO_A);
    await ctl.connect();
    expect(client.connectBridge.mock.calls[0][1]).toEqual({ runner_id: R2 });
  });
  it("sends once for a double press, disconnects, and cancels by the command's id", async () => {
    const { client, ctl } = rig([raw({ phase: "connected", connected: { runner_id: R1, runner_name: "Studio laptop", root_tail: "a/b", root: null } }), raw({ phase: "disconnecting", command: cmd({ kind: "bridge_disable" }) }), raw()]);
    await ctl.show(REPO_A);
    await Promise.all([ctl.disconnect(), ctl.disconnect()]);
    expect(client.disconnectBridge).toHaveBeenCalledTimes(1);
    await ctl.cancel("c1");
    expect(client.cancel).toHaveBeenCalledWith("c1", undefined);
  });
  it("a refused press says why in the person's words, then shows what is true now", async () => {
    const answers = [raw(), raw({ phase: "connecting", command: cmd() })];
    const { client, ctl, st } = rig(answers);
    await ctl.show(REPO_A);
    client.connectBridge.mockRejectedValueOnce(Object.assign(new Error("x"), { status: 409, code: "bridge_pending" }));
    await ctl.connect();
    expect(st().bridge.notice).toBe(BRIDGE_WORDS.pending);
    client.connectBridge.mockRejectedValueOnce(Object.assign(new Error("x"), { status: 400, code: "root_not_offered" }));
    await ctl.connect();
    expect(st().bridge.notice).toBe(BRIDGE_WORDS.offered);
    expect(bridgeFailureWords({ status: 403 })).toBe(BRIDGE_WORDS.readOnly);
    expect(bridgeFailureWords({ status: 404 })).toBe(BRIDGE_WORDS.gone);
    expect(bridgeFailureWords({ status: 500 })).toBe(BRIDGE_WORDS.failed);
    expect(bridgeFailureWords({ status: 409, code: "already_delivered" })).toBe(BRIDGE_WORDS.alreadyHas);
    expect(bridgeFailureWords({ status: 429, retryAfter: 90, headers: { "retry-after": "90" } })).toMatch(/\S/);
  });
  it("an answer that cannot be read leaves the panel saying so, and a later good one clears it", async () => {
    const { client, ctl, st } = rig([{ nonsense: true }]);
    await ctl.show(REPO_A);
    expect(st().bridge).toMatchObject({ data: null, failed: true });
    client.bridge.mockResolvedValueOnce(raw());
    await ctl.show(REPO_A);
    expect(st().bridge).toMatchObject({ failed: false });
  });
});

describe("the page state", () => {
  it("opening Settings reads where Connect stands; the sheet carries the panel and the folder reaches the runner list's command for an owner only", async () => {
    const client = {
      ...createTeamApi(async () => ({})),
      settings: async () => F.settings({ repos: [F.settingsRepo({ bridged_runner_id: R1 })] }),
      repos: async () => ({ items: [F.repo()] }),
      runners: async () => F.fleet([F.runner()]),
      panel: async () => F.envelope([]),
      commands: async () => ({ commands: [] }),
      dials: async () => F.dials(),
      bridge: vi.fn(async () => raw({ phase: "connected", connected: { runner_id: R1, runner_name: "Studio laptop", root_tail: "acme/widgets", root: "/home/me/code/acme/widgets" } })),
    };
    const team = createTeam({ client, now: () => NOW, setRepeat: () => 0, clearRepeat: () => {} });
    await team.load();
    team.toggleSheet();
    await flush(); await flush(); await flush();
    expect(client.bridge).toHaveBeenCalledWith(F.settingsRepo().repo_id, undefined);
    const d = describeState(team.state, NOW);
    expect(d.bridge.kind).toBe("connected");
    expect(d.sheet.runner.connect.command).toBe("fx-runner engine-bridge enable --repo acme-labs/widgets --repo-root /home/me/code/acme/widgets");
    // Closed, there is no panel.
    team.toggleSheet();
    expect(describeState(team.state, NOW).bridge).toBeNull();
  });
});
