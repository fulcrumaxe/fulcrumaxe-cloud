// apps/workspace/test/runners-server-actions.test.mjs
//
// D#845 MC-10b2: the Servers tab's actions and states, against a fake call(): the elapsed-time states, the buttons each state offers, every refusal as a fixed sentence,
// the server actions (reboot, keep, delete with and without projects, delete an orphan), the Claude sign-in keyed by the runner's id, and move. The server bodies are the
// contract fixtures (packages/api/fixtures/v1/**). The DOM is in e2e/runners.spec.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLAUDE_AUTH_URL_PATTERN } from "../../../packages/runner-protocol/src/machineCommands.ts";
import {
  CODE_REFUSED, LINK_EXPIRED, ONLY_ADMINS_ACT, SIGNIN_FAILED, SLOW_WORDS, STUCK_MINS, CLAUDE_AUTH_URL, actionSentence, createSignIn, deleteSentence, isStuck, moveProject, moveTargets,
  orphanSentence, readLogin, readServers, serverAct, serverActions, serverLines,
} from "../apps/runners/runners-fleet.js";

const fixture = (op, name) => JSON.parse(readFileSync(new URL(`../../../packages/api/fixtures/v1/${op}/${name}`, import.meta.url), "utf8"));
const LIST = fixture("listHetznerServers", "200-list.json");
const RUNNER = "3c9a1f52-6d84-4e07-b2a1-8f5d0c7e9a13";
const REPO = "9e4b7d21-0a63-4c58-8d17-2b6f3a9c5e80";
const NOW = Date.parse("2026-11-24T10:00:00.000Z");
const minsAgo = (n) => new Date(NOW - n * 60000).toISOString();
const fail = (status, code, extra = {}) => Object.assign(new Error("server text that must never be shown"), { status, code, retryAfter: 0, ...extra });
const one = (patch) => readServers({ servers: [{ ...LIST.servers[1], ...patch }] })[0];
const LINK = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference";

describe("what a server row reads", () => {
  it("takes the runner, the times, the kept flag and the placed projects from the cloud's read, with no null on the screen", () => {
    const [creating, ready] = readServers(LIST);
    expect(creating).toMatchObject({ state: "installing", runnerId: "", statusAt: "2026-11-23T10:21:00.000Z", lastSeen: "", kept: false, claudeIn: "", placed: [], placedKnown: true, cost: "€5.1051 a month" });
    expect(ready).toMatchObject({ state: "ready", runnerId: RUNNER, lastSeen: "2026-11-24T09:59:30.000Z", claudeIn: "yes", placed: [{ id: REPO, name: "acme/widgets" }], cost: "" });
    expect(JSON.stringify([creating, ready])).not.toMatch(/null|undefined|NaN/);
  });
  it("treats a member's view (no placed_projects key) as unknown, drops a bad id, and names a project with no name", () => {
    const member = { ...LIST.servers[1] };
    delete member.placed_projects;
    expect(readServers({ servers: [member] })[0]).toMatchObject({ placed: [], placedKnown: false });
    const odd = one({ runner_id: "not-a-uuid", placed_projects: [{ repo_id: "x", name: "bad id" }, { repo_id: REPO, name: "  " }, null], price: { currency: "EUR<script>", monthly_gross: "1", ipv4_monthly_gross: "1" } });
    expect(odd).toMatchObject({ runnerId: "", placed: [{ id: REPO, name: "Unnamed project" }], cost: "" });
  });
});

describe("the elapsed-time states", () => {
  it("says 'Taking longer than usual' once a step has run 5, 10, 25 and 35 minutes for creating, booting, installing and registering", () => {
    expect(STUCK_MINS).toEqual({ creating: 5, booting: 10, installing: 25, registering: 35 });
    for (const [state, limit] of Object.entries(STUCK_MINS)) {
      const at = (m) => one({ status: state, status_at: minsAgo(m) });
      expect(isStuck(at(limit - 1), NOW), state + " before").toBe(false);
      expect(isStuck(at(limit), NOW), state + " at").toBe(true);
      expect(serverLines(at(limit - 1), false, NOW)).toEqual(["This step started " + (limit - 1) + " min ago"]);
      expect(serverLines(at(limit), false, NOW)).toEqual(["This step started " + limit + " min ago", SLOW_WORDS]);
    }
    expect(isStuck(one({ status: "ready", status_at: minsAgo(500) }), NOW)).toBe(false);
    expect(isStuck(one({ status: "installing", status_at: "not a time" }), NOW)).toBe(false);
    expect(serverLines(one({ status: "creating", status_at: "" }), false, NOW)).toEqual([]);
  });
  it("says when a ready server was last seen, only once its runner is not live, and never 'null'", () => {
    expect(serverLines(one({ last_seen_at: minsAgo(7) }), true, NOW)).toEqual(["Last seen 7 min ago"]);
    expect(serverLines(one({ last_seen_at: null }), true, NOW)).toEqual(["Not heard from yet"]);
    expect(serverLines(one({ last_seen_at: minsAgo(7) }), false, NOW)).toEqual([]);
  });
  it("says an orphan was kept, from `kept`", () => {
    expect(serverLines(one({ status: "orphaned", kept: true }), false, NOW)).toEqual(["You chose to keep it. We leave it alone."]);
    expect(serverLines(one({ status: "orphaned", kept: false }), false, NOW)).toEqual([]);
  });
});

describe("the buttons each state offers", () => {
  const ids = (patch, o = {}) => serverActions(one(patch), { stuck: false, isAdmin: true, ...o }).map((a) => a.id);
  it("offers each state its own buttons", () => {
    expect(ids({ status: "ready" })).toEqual(["reboot", "delete"]);
    expect(ids({ status: "needs_claude_login" })).toEqual(["reboot", "delete"]);
    expect(ids({ status: "failed" })).toEqual(["delete"]);
    expect(ids({ status: "orphaned", kept: false })).toEqual(["keep", "delete-orphan"]);
    expect(ids({ status: "orphaned", kept: true })).toEqual(["delete-orphan"]);
    expect(ids({ status: "installing" }, { stuck: true })).toEqual(["retry"]);
    expect(ids({ status: "installing" })).toEqual([]);
    expect(ids({ status: "deleting" })).toEqual([]);
    expect(serverActions(one({ status: "ready" }), { stuck: false, isAdmin: true }).map((a) => a.label)).toEqual(["Reboot", "Delete server"]);
  });
  it("disables every button for anyone but an owner or admin, with a reason", () => {
    for (const status of ["ready", "failed", "orphaned"]) {
      const acts = serverActions(one({ status }), { stuck: false, isAdmin: false });
      expect(acts.length).toBeGreaterThan(0);
      for (const a of acts) expect(a.why).toBe(ONLY_ADMINS_ACT);
    }
    for (const a of serverActions(one({ status: "ready" }), { stuck: false, isAdmin: true })) expect(a.why).toBe("");
  });
});

describe("the sentences", () => {
  it("words every refusal by closed code or status, never the server's text, never a code", () => {
    const codes = ["server_not_rebootable", "server_gone", "not_an_orphan", "credential_invalid", "hetzner_unauthorized", "hetzner_forbidden", "hetzner_locked", "credential_changed", "server_creating", "projects_placed", "project_removal_unavailable",
      "leases_not_failed", "not_connected", "not_configured", "machine_kek_unset", "not_managed_server", "not_supported", "runner_revoked", "no_login_waiting", "invalid_message", "project_not_placed", "machine_not_eligible", "machine_single_project", "placement_busy"];
    for (const code of codes) {
      const said = actionSentence(fail(409, code));
      expect(said, code).toMatch(/^[A-Z]/);
      expect(said, code).not.toMatch(/_/);
      expect(said, code).not.toContain("server text");
    }
    expect(actionSentence(fail(403, "forbidden"))).toBe(ONLY_ADMINS_ACT);
    expect(actionSentence(fail(404, "not_found"))).toBe("That isn't on your account any more. Refresh the list");
    expect(actionSentence(fail(409, "hetzner_rate_limit_exceeded"))).toBe("Hetzner didn't answer. Try again in a minute");
    expect(actionSentence(fail(429, "rate_limited", { retryAfter: 8 }))).toBe("That was too fast. Try again in 8 seconds.");
    expect(actionSentence(fail(500, "server_error"))).toBe("That didn't work. Try again.");
    expect(actionSentence(fail(409, "constructor"))).toBe("That didn't work. Try again.");
    expect(actionSentence(undefined)).toBe("That didn't work. Try again.");
  });
  it("says what a delete does and what it costs, and costs nothing it was never priced", () => {
    expect(deleteSentence("€5.10 a month")).toBe("This deletes the server and its firewall at Hetzner, and everything on its disk. It can't be undone. It stops costing €5.10 a month.");
    expect(deleteSentence("")).toBe("This deletes the server and its firewall at Hetzner, and everything on its disk. It can't be undone.");
    expect(orphanSentence("")).toContain("and its firewall at Hetzner");
  });
});

describe("the server actions", () => {
  const recorder = (answer) => {
    const calls = [];
    return { calls, call: async (method, url, body) => (calls.push([method, url, body]), answer instanceof Error ? Promise.reject(answer) : answer) };
  };
  const ID = "7a2c9e10-4b85-4f3d-9c60-1e8d5b3a7c24";
  it("sends reboot, keep and delete-orphan as POSTs and delete as a DELETE, with remove_projects only when asked", async () => {
    const r = recorder({});
    expect(await serverAct("reboot", ID, { call: r.call })).toBe("");
    expect(await serverAct("keep", ID, { call: r.call })).toBe("");
    expect(await serverAct("delete-orphan", ID, { call: r.call })).toBe("");
    expect(await serverAct("delete", ID, { call: r.call })).toBe("");
    expect(await serverAct("delete", ID, { call: r.call, removeProjects: true })).toBe("");
    expect(r.calls).toEqual([
      ["POST", "/api/v1/machine-servers/" + ID + "/reboot", undefined], ["POST", "/api/v1/machine-servers/" + ID + "/keep", undefined], ["POST", "/api/v1/machine-servers/" + ID + "/delete-orphan", undefined],
      ["DELETE", "/api/v1/machine-servers/" + ID, undefined], ["DELETE", "/api/v1/machine-servers/" + ID + "?remove_projects=true", undefined],
    ]);
  });
  it("encodes the id, words a refusal, and says nothing for a page that went away", async () => {
    const r = recorder({});
    await serverAct("reboot", "a/b?c", { call: r.call });
    expect(r.calls[0][1]).toBe("/api/v1/machine-servers/a%2Fb%3Fc/reboot");
    expect(await serverAct("delete", ID, { call: recorder(fail(409, "projects_placed")).call })).toContain("Projects are placed on this server");
    expect(await serverAct("reboot", ID, { call: recorder(Object.assign(new Error("x"), { name: "AbortError" })).call })).toBe("");
  });
  it("moves a project with exactly { to_runner_id }, and offers only an online machine that has room", async () => {
    const r = recorder({});
    expect(await moveProject(REPO, RUNNER, { call: r.call })).toBe("");
    expect(r.calls).toEqual([["POST", "/api/runners/repos/" + REPO + "/move", { to_runner_id: RUNNER }]]);
    expect(await moveProject(REPO, RUNNER, { call: recorder(fail(409, "machine_single_project")).call })).toBe("That machine uses Standard isolation and already hosts a project");
    const m = (id, live, tier, running) => ({ id, name: id, live, tier, running });
    expect(moveTargets([m("a", true, "microvm", "p"), m("b", false, "microvm", null), m("c", true, "standard", "p"), m("d", true, "standard", null), m("self", true, "microvm", null)], "self").map((x) => x.id)).toEqual(["a", "d"]);
  });
});

describe("the Claude sign-in", () => {
  it("accepts the same link addresses the cloud takes from a machine, and no other", () => {
    expect(CLAUDE_AUTH_URL.source).toBe(CLAUDE_AUTH_URL_PATTERN.source);
    expect(CLAUDE_AUTH_URL.test(LINK)).toBe(true);
    for (const bad of ["javascript:alert(1)", "http://claude.com/cai/oauth/authorize?a=b", "https://evil.example/cai/oauth/authorize?a=b", "https://claude.com.evil.example/cai/oauth/authorize?a=b", "https://claude.com/other?a=b", LINK + " x", LINK + "<"]) expect(CLAUDE_AUTH_URL.test(bad), bad).toBe(false);
  });
  it("reads the newest request: live states, the link only while it waits for a code, and a failure older than the server's state is history", () => {
    const at = "2026-11-24T09:00:00.000Z";
    const r = (status, extra = {}, watched = false) => readLogin({ request: { request_id: "x", status, expires_at: "2026-11-24T09:30:00.000Z", auth_url: null, failure_code: null, ...extra } }, at, watched);
    expect(r("pending")).toMatchObject({ status: "pending", authUrl: "" });
    expect(r("awaiting_code", { auth_url: LINK })).toMatchObject({ status: "awaiting_code", authUrl: LINK });
    expect(r("awaiting_code", { auth_url: "https://evil.example/x" })).toMatchObject({ authUrl: "" });
    expect(r("code_ready", { auth_url: LINK }).authUrl).toBe("");
    expect(r("failed", { failure_code: "invalid_code" })).toMatchObject({ status: "failed", words: CODE_REFUSED });
    expect(r("failed", { failure_code: "timeout" }).words).toBe(LINK_EXPIRED);
    expect(r("expired").words).toBe(LINK_EXPIRED);
    expect(r("failed", { failure_code: "no_link" }).words).toBe(SIGNIN_FAILED);
    expect(r("done", {}, true)).toMatchObject({ status: "done" }); // watched go live to done
    expect(r("done").status).toBe("idle"); // a first read that finds done is history, however late it expires
    expect(r("failed", { failure_code: "invalid_code", expires_at: "2026-11-24T08:00:00.000Z" }).status).toBe("idle");
    expect(readLogin({ request: null }, at).status).toBe("idle");
    expect(readLogin(null, at).status).toBe("idle");
    expect(readLogin({ request: { status: "mystery" } }, at).status).toBe("idle");
  });

  const harness = (replies) => {
    const calls = [];
    let n = 0;
    const timers = [];
    const call = async (method, url, body) => {
      calls.push([method, url, body]);
      const a = replies(method, url, body, n++);
      if (a instanceof Error) throw a;
      return a;
    };
    return { calls, timers, changes: () => n, call, setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => timers.splice(0) };
  };
  const req = (status, extra = {}) => ({ request: { request_id: "r", status, expires_at: "2099-01-01T00:00:00.000Z", auth_url: null, failure_code: null, ...extra } });

  it("starts the request on the server's runner id, follows it to a link, sends the code once and keeps no copy of it", async () => {
    let state = req("pending");
    const t = harness((m) => (m === "GET" ? state : {}));
    let repaints = 0;
    const s = createSignIn({ call: t.call, onChange: () => repaints++, setTimer: t.setTimer, clearTimer: t.clearTimer });
    await s.start(RUNNER);
    expect(t.calls).toEqual([["POST", "/api/runners/" + RUNNER + "/claude-login", undefined], ["GET", "/api/runners/" + RUNNER + "/claude-login", undefined]]);
    expect(s.get(RUNNER).status).toBe("pending");
    expect(t.timers).toHaveLength(1); // a live request is read again
    state = req("awaiting_code", { auth_url: LINK });
    await t.timers[0]();
    expect(s.get(RUNNER)).toMatchObject({ status: "awaiting_code", authUrl: LINK });
    const seen = repaints;
    await s.load(RUNNER); // nothing new: nothing repaints, so a code being typed is never replaced
    expect(repaints).toBe(seen);
    state = req("code_ready");
    await s.sendCode(RUNNER, "abc-123");
    expect(t.calls.filter(([, u]) => u.endsWith("/code"))).toEqual([["POST", "/api/runners/" + RUNNER + "/claude-login/code", { code: "abc-123" }]]);
    expect(JSON.stringify(s.get(RUNNER))).not.toContain("abc-123");
    expect(s.get(RUNNER).status).toBe("code_ready");
    s.stop();
    expect(t.timers).toHaveLength(0);
  });
  it("shows a refusal as a sentence, ignores a second press while one is in flight, and starts again after a refused code", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const t = harness((m, u) => (m === "GET" ? req("failed", { failure_code: "invalid_code" }) : u.endsWith("/code") ? fail(409, "no_login_waiting") : {}));
    const s = createSignIn({ call: async (m, u, b) => (m === "POST" && u.endsWith("/claude-login") ? (await gate, t.call(m, u, b)) : t.call(m, u, b)), setTimer: t.setTimer, clearTimer: t.clearTimer });
    const first = s.start(RUNNER);
    await s.start(RUNNER); // the second press, while the first is in flight, sends nothing
    expect(t.calls).toHaveLength(0);
    release();
    await first;
    expect(s.get(RUNNER)).toMatchObject({ status: "failed", words: CODE_REFUSED });
    await s.sendCode(RUNNER, "zzz");
    expect(s.get(RUNNER).error).toBe("No sign-in is waiting for a code. Start again");
    expect(t.timers).toHaveLength(0); // nothing live, nothing read again
  });
  it("a done request found on a first read is history; one watched going done shows until the list shows it signed in, then a sign-out starts clean", async () => {
    let state = req("done");
    const t = harness((m) => (m === "GET" ? state : {}));
    const s = createSignIn({ call: t.call, setTimer: t.setTimer, clearTimer: t.clearTimer });
    await s.load(RUNNER, "2026-11-24T09:00:00.000Z"); // after a sign-out, or a reload: the old done request is still the newest
    expect(s.get(RUNNER).status).toBe("idle");
    state = req("pending");
    await s.start(RUNNER);
    expect(s.get(RUNNER).status).toBe("pending");
    state = req("done");
    await t.timers[0]();
    expect(s.get(RUNNER).status).toBe("done");
    await s.load(RUNNER);
    expect(s.get(RUNNER).status).toBe("done"); // read again while the list is slow: still shown
    s.forget(RUNNER); // the list shows it signed in
    expect(s.get(RUNNER).status).toBe("idle");
    await s.load(RUNNER, "2026-11-24T09:05:00.000Z"); // then Sign out: the same done request is the newest again
    expect(s.get(RUNNER).status).toBe("idle");
    s.stop();
  });
  it("signs out with a POST on the runner id and reports the refusal's sentence", async () => {
    const ok = harness(() => ({}));
    expect(await createSignIn({ call: ok.call }).logout(RUNNER)).toBe(true);
    expect(ok.calls).toEqual([["POST", "/api/runners/" + RUNNER + "/claude-logout", undefined]]);
    const refused = harness(() => fail(409, "not_managed_server"));
    const s = createSignIn({ call: refused.call });
    expect(await s.logout(RUNNER)).toBe(false);
    expect(s.get(RUNNER).error).toContain("We can only sign in to Claude for servers we made");
  });
});
