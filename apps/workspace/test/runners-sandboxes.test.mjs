// apps/workspace/test/runners-sandboxes.test.mjs
//
// D#587 B-7b-ii: the sandbox part of the Runners app (runners-fleet.js), against a fake call(). The DOM, focus, axe and the in-page confirmations are in
// e2e/runners.spec.ts. Pinned here: the words of every inventory status and command state (including "unanswered" and a refusal's reason), the quota lines, the
// buttons offered and why one is off, one request per click, the sentences chosen by status and code (never the server's text), and no null or undefined in any text.
import { describe, expect, it, vi } from "vitest";
import {
  SANDBOX_ACTION, SANDBOX_COMMAND_STATE_WORDS, SANDBOX_NOT_ADMIN, SANDBOX_STATUS_WORDS, actionUrl, bytesText, createFleet, readFleet, readRunner, sandboxCommandText, sandboxCommandWaiting, sandboxConfirm, sandboxControls, sandboxLine,
  sandboxQuotaLines, sandboxSentence, sandboxStatusText, spanText,
} from "../apps/runners/runners-fleet.js";

const ME = "33333333-3333-4333-8333-333333333333";
const R1 = "44444444-4444-4444-8444-444444444444";
const SERVER_TEXT = "server text that must never be shown";
const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const fail = (status, code) => Object.assign(new Error(SERVER_TEXT), { status, code });
const ok = { allowed: true, reason: null };
const flush = () => new Promise((r) => setTimeout(r, 0));

const box = (name, over = {}) => ({ name, state: "stopped", created_at: "2026-11-16T12:00:00.000Z", last_used_at: null, disk_bytes: 1500000000, snapshot_count: 2, snapshot_newest_secs: 7200, ...over });
const sandboxes = (over = {}) => ({
  status: "current", seen_at: "2026-11-18T11:55:00.000Z", can_command: true, limits: { vms: 4, vcpus: 16, memory_mb: 32768, templates: ["base-a"] },
  sandboxes: [box("web-1", { state: "running", last_used_at: "2026-11-18T11:00:00.000Z" }), box("web-2")], commands: [], ...over,
});
const wire = (over = {}) => ({
  id: R1, credential_mode: "api_key", registered_by: { id: ME, name: "Ada Admin" }, binary_version: "0.9.1", last_seen_at: "2026-11-18T11:59:00.000Z", state: "online_idle", state_note: null, revoked_reason: null,
  repos: [], capacity: null, load_label: null, provisioning: null, name: "Desktop", has_name: true, labels: [], facts: null, current_runs: [], paused: false, draining: false, controls: { pause: ok, drain: ok, rename: ok, remove: ok },
  register_again: null, sandboxes: sandboxes(), ...over,
});
const sb = (over) => readRunner(wire({ sandboxes: sandboxes(over) })).sandboxes;
const body = (runners) => ({ runners, viewer: { role: "admin" }, account: { limit: 16, capacity: 16, running: 0, runner_count: runners.length, runner_limit: 5 } });

describe("reading the sandbox part of a runner", () => {
  it("is null when the cloud sent none or a status this build does not know, and never has a null text", () => {
    expect(readRunner(wire({ sandboxes: undefined })).sandboxes).toBeNull();
    expect(readRunner(wire({ sandboxes: null })).sandboxes).toBeNull();
    expect(readRunner(wire({ sandboxes: { ...sandboxes(), status: "weird" } })).sandboxes).toBeNull();
    const s = sb({ sandboxes: [box("a", { state: undefined, created_at: null, disk_bytes: null, snapshot_count: null })], commands: [{ id: "c1", kind: "reap_sandboxes", name: null, state: "applied", refusal: null, issued_at: null }, { id: "c2", kind: "stop_sandbox", name: "a", state: "no-such-state" }] });
    expect(s.commands).toHaveLength(1); // the command in a state this build does not know is dropped, not shown as a code
    expect(JSON.stringify(sandboxLine(s.boxes[0], NOW))).not.toMatch(/null|undefined|NaN/);
    expect(JSON.stringify(sandboxCommandText(s.commands[0]))).not.toMatch(/null|undefined/);
  });
});

describe("how current the list is", () => {
  it("says how old the report is, and why it is out of date for each stale status", () => {
    expect(sandboxStatusText(sb(), NOW)).toBe("Reported 5 min ago");
    expect(sandboxStatusText(sb({ status: "stale_older" }), NOW)).toBe("Reported 5 min ago · " + SANDBOX_STATUS_WORDS.stale_older);
    expect(sandboxStatusText(sb({ status: "stale_engine" }), NOW)).toContain("gone back to the standard sandbox");
    expect(sandboxStatusText(sb({ status: "removed" }), NOW)).toContain("Runner removed");
    expect(sandboxStatusText(sb({ status: "never", seen_at: null }), NOW)).toBe("This runner hasn't reported any sandboxes.");
  });
});

describe("quota, ages and disk", () => {
  it("counts the running sandboxes against the limit and names a limit the runner did not report", () => {
    expect(sandboxQuotaLines(sb())).toEqual(["Running: 1 of 4 allowed", "Disk in use: 3 GB", "vCPU limit: 16 · Memory limit: 32 GB"]);
    expect(sandboxQuotaLines(sb({ limits: { vms: null, vcpus: null, memory_mb: null, templates: [] } }))).toEqual(["Running: 1 (limit not reported)", "Disk in use: 3 GB", "vCPU limit: not reported · Memory limit: not reported"]);
  });
  it("words each sandbox with its state, ages and disk; a field the runner left out reads as not reported or never", () => {
    expect(sandboxLine(sb().boxes[0], NOW)).toEqual({ name: "web-1", state: "Running", ages: "Created 2 days ago · Last used 1 h ago", disk: "1.5 GB · 2 snapshots, newest 2 h old" });
    expect(sandboxLine(sb().boxes[1], NOW)).toMatchObject({ state: "Stopped", ages: "Created 2 days ago · Never used" });
    expect(sandboxLine(sb({ sandboxes: [box("x", { created_at: null, snapshot_count: 0, snapshot_newest_secs: null })] }).boxes[0], NOW)).toMatchObject({ ages: "Created: not reported · Never used", disk: "1.5 GB · No snapshots" });
  });
  it("sizes in decimal units and spans in the largest whole unit", () => {
    expect([0, 999, 1000, 1500, 123456789, 5e9, 2.5e12].map(bytesText)).toEqual(["0 B", "999 B", "1 KB", "1.5 KB", "123 MB", "5 GB", "2.5 TB"]);
    expect([5, 120, 7200, 100000, 400000].map(spanText)).toEqual(["5 s", "2 min", "2 h", "27 h", "4 days"]);
  });
});

describe("the buttons", () => {
  it("offers Stop on a running sandbox and Delete on any, and Reap while one is stopped", () => {
    const s = sb();
    expect(sandboxControls(s, true, s.boxes[0])).toEqual([{ action: "stop_sandbox", label: "Stop", allowed: true, reason: "" }, { action: "delete_sandbox", label: "Delete", allowed: true, reason: "" }]);
    expect(sandboxControls(s, true, s.boxes[1])[0]).toEqual({ action: "stop_sandbox", label: "Stop", allowed: false, reason: "Not running." });
    expect(sandboxControls(s, true)).toEqual({ action: "reap_sandboxes", label: "Reap stopped sandboxes", allowed: true, reason: "" });
    expect(sandboxControls(sb({ sandboxes: [box("r", { state: "running" })] }), true)).toMatchObject({ allowed: false, reason: "No sandbox is stopped." });
  });
  it("turns every button off, with its reason, for a member, a runner that cannot be commanded, and a list that is out of date", () => {
    const s = sb();
    for (const c of [...sandboxControls(s, false, s.boxes[0]), sandboxControls(s, false)]) expect(c).toMatchObject({ allowed: false, reason: SANDBOX_NOT_ADMIN });
    const stale = sb({ status: "stale_engine", can_command: false });
    for (const c of [...sandboxControls(stale, true, stale.boxes[0]), sandboxControls(stale, true)]) expect(c).toMatchObject({ allowed: false, reason: SANDBOX_STATUS_WORDS.stale_engine });
    expect(sandboxControls(sb({ can_command: false }), true)).toMatchObject({ allowed: false, reason: "This runner doesn't take sandbox commands." });
  });
  it("asks before a delete and a reap, naming what goes", () => {
    expect(sandboxConfirm("delete_sandbox", "web-2")).toMatchObject({ title: "Delete web-2?", button: "Delete sandbox" });
    expect(sandboxConfirm("reap_sandboxes")).toMatchObject({ title: "Reap stopped sandboxes?", button: "Reap sandboxes" });
  });
});

describe("a command's state", () => {
  const cmd = (state, over = {}) => ({ id: "c1", kind: "delete_sandbox", name: "web-2", state, refusal: null, issued_at: "2026-11-18T11:59:00.000Z", ...over });
  const text = (c) => sandboxCommandText(sb({ commands: [c] }).commands[0]);
  it("words pending, delivered, applied, expired and unanswered, each apart from the others", () => {
    expect(text(cmd("pending"))).toBe("Delete sandbox web-2: Waiting for the runner");
    expect(text(cmd("delivered", { kind: "stop_sandbox" }))).toBe("Stop sandbox web-2: Sent, waiting for the runner's answer");
    expect(text(cmd("applied", { kind: "reap_sandboxes", name: null }))).toBe("Reap stopped sandboxes: Done");
    expect(text(cmd("expired"))).toBe("Delete sandbox web-2: Expired before the runner took it");
    expect(text(cmd("unanswered"))).toBe("Delete sandbox web-2: Unanswered: the runner never replied");
    expect(new Set(Object.values(SANDBOX_COMMAND_STATE_WORDS)).size).toBe(Object.keys(SANDBOX_COMMAND_STATE_WORDS).length);
  });
  it("gives a refusal its reason, and a reason this build does not know is not shown as a code", () => {
    expect(text(cmd("refused", { refusal: "in_use" }))).toBe("Delete sandbox web-2: Refused (it is in use)");
    expect(text(cmd("refused", { refusal: "name_unknown" }))).toContain("the runner has no such sandbox");
    expect(text(cmd("refused", { refusal: "mystery_code" }))).toBe("Delete sandbox web-2: Refused (no reason given)");
  });
  it("counts a command as waiting only while it is pending or sent: expired and unanswered stop the page's re-reads", () => {
    const waiting = (...states) => sandboxCommandWaiting(readRunner(wire({ sandboxes: sandboxes({ commands: states.map((s, i) => cmd(s, { id: "c" + i })) }) })));
    expect(waiting("pending")).toBe(true);
    expect(waiting("applied", "delivered")).toBe(true);
    expect(waiting("applied", "refused", "expired", "unanswered", "cancelled")).toBe(false);
    expect(sandboxCommandWaiting(readRunner(wire({ sandboxes: null })))).toBe(false);
  });
});

describe("sending a command", () => {
  const url = actionUrl(R1, SANDBOX_ACTION);
  function fleetWith(post) {
    const log = [];
    const call = vi.fn(async (method, path, b) => {
      log.push([method, path, b]);
      if (method === "GET") return body([wire()]);
      return post(b);
    });
    return { fleet: createFleet({ call, schedule: () => {} }), log };
  }
  it("posts to the sandbox-commands route with the kind and name, once for a double click, and reads again", async () => {
    const { fleet, log } = fleetWith(async () => ({ command_id: "x", state: "pending" }));
    await fleet.load();
    const body1 = { kind: "stop_sandbox", name: "web-1" };
    const [first, second] = [fleet.act(R1, SANDBOX_ACTION, body1), fleet.act(R1, SANDBOX_ACTION, body1)];
    expect(await second).toBe("");
    expect(await first).toBe("");
    expect(log.filter(([m]) => m === "POST")).toEqual([["POST", url, body1]]);
    expect(log.filter(([m]) => m === "GET")).toHaveLength(2);
  });
  it("answers each refusal with its own sentence, by status and code, and never the server's text", async () => {
    const said = async (e) => {
      const { fleet } = fleetWith(async () => { throw e; });
      await fleet.load();
      return fleet.act(R1, SANDBOX_ACTION, { kind: "reap_sandboxes" });
    };
    expect(await said(fail(403, "forbidden"))).toBe(SANDBOX_NOT_ADMIN);
    expect(await said(fail(404, "not_found"))).toBe("That runner isn't there any more.");
    expect(await said(fail(409, "runner_revoked"))).toBe("That runner was removed.");
    expect(await said(fail(409, "not_supported"))).toBe("This runner doesn't take sandbox commands.");
    expect(await said(fail(409, "other_code"))).toBe("That request couldn't be sent. Try again.");
    expect(await said(fail(429, "too_many"))).toContain("Too many sandbox requests");
    expect(await said(fail(400, "invalid_message"))).toBe("That sandbox request isn't valid.");
    expect(await said(fail(500, "x"))).toBe("That request couldn't be sent. Try again.");
    for (const e of [fail(403), fail(409, "runner_revoked"), fail(429), fail(500)]) expect(sandboxSentence(e)).not.toContain(SERVER_TEXT);
  });
  it("keeps the whole fleet read usable when a runner has no sandbox part", () => {
    const fleet = readFleet(body([wire({ sandboxes: undefined })]));
    expect(fleet.runners).toHaveLength(1);
    expect(fleet.runners[0].sandboxes).toBeNull();
    flush();
  });
});
