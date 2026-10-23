// apps/workspace/test/runners-fleet.test.mjs
//
// D#605 FL-9: the Runners app's logic (runners-fleet.js), against a fake call(). The real page, with the real DOM, axe and focus, is driven on the
// built output in e2e/runners.spec.ts. What is pinned here: the words of every state, the account line never above its limit, no null or undefined in
// any text, one request per click (even on a double click), the sentences chosen by status (never the server's text), and that a made secret lives
// only until the sheet closes.
import { describe, expect, it, vi } from "vitest";
import { launchRunId } from "../apps/runs/runs-storage.js";
import {
  ACTION_SENTENCES, ADD_REPO_SENTENCES, ADD_SENTENCES, ONLY_ADMINS, STATE_WORDS, accountText, actionUrl, capacityText, commandsFor, controlList, createAdder, createFleet, factsText, loadRepoChoices, parseLabels,
  provText, readFleet, readRunner, runnerLimitText, stateParts, versionText,
} from "../apps/runners/runners-fleet.js";

const ME = "33333333-3333-4333-8333-333333333333";
const R1 = "44444444-4444-4444-8444-444444444444";
const REPO = "99999999-9999-4999-8999-999999999999";
const SERVER_TEXT = "server text that must never be shown";
const fail = (status, code) => Object.assign(new Error(SERVER_TEXT), { status, code });
const flush = () => new Promise((r) => setTimeout(r, 0));
const ok = { allowed: true, reason: null };
const ALL_OK = { pause: ok, drain: ok, resume: { allowed: false, reason: "Not paused." }, rename: ok, remove: ok };

const wire = (over = {}) => ({
  id: R1, credential_mode: "api_key", registered_by: { id: ME, name: "Ada Admin" }, binary_version: "0.9.1", last_seen_at: "2026-10-15T11:59:00.000Z", state: "online_idle", state_note: null, revoked_reason: null,
  sandbox_unavailable: null, plan_consent: { granted: false, changed_at: null }, can_change_plan_consent: false, repos: [{ id: REPO, name: "acme/web" }],
  running: { light: 0, heavy: 0 }, capacity: { light: { limit: 8, in_use: 1 }, heavy: { limit: 4, in_use: 0 }, total_limit: 8, limited_by: null }, load_label: null, provisioning: null,
  name: "Desktop", has_name: true, labels: ["gpu"], facts: { os: "macos", arch: "arm64", engine: "os_sandbox" }, current_runs: [], paused: false, draining: false, controls: ALL_OK, register_again: null, ...over,
});
const body = (runners, over = {}) => ({ runners, viewer: { role: "admin" }, account: { limit: 16, capacity: 16, running: 2, runner_count: runners.length, runner_limit: 5 }, ...over });

/** A call() that answers by "METHOD path"; a function value is called each time, an Error is thrown. */
function fakeCall(routes) {
  const log = [];
  const call = vi.fn(async (method, path, b) => {
    log.push([method, path, b]);
    const r = routes[method + " " + path];
    if (r === undefined) throw fail(404, "not_found");
    const v = typeof r === "function" ? r(b) : r;
    if (v instanceof Error) throw v;
    return v;
  });
  return { call, log };
}

describe("reading a runner", () => {
  it("keeps a name, and words a runner nobody named from the cloud's placeholder; no text is ever null or undefined", () => {
    const named = readRunner(wire());
    expect(named).toMatchObject({ name: "Desktop", hasName: true, person: "Ada Admin", labels: ["gpu"] });
    const bare = readRunner(wire({ name: "Unnamed runner (Ada Admin)", has_name: false, labels: [], facts: null, binary_version: null, last_seen_at: null, capacity: null }));
    expect(bare.name).toBe("Unnamed runner (Ada Admin)");
    const lonely = readRunner(wire({ name: null, registered_by: { id: ME, name: null } }));
    expect(lonely.name).toBe("Unnamed runner (A team member)");
    for (const r of [named, bare, lonely]) {
      const every = [r.name, r.person, versionText(r), capacityText(r), factsText(r), provText(r), stateParts(r).words, ...r.labels, ...r.repos].join("|");
      expect(every).not.toMatch(/null|undefined|NaN/);
    }
  });

  it("drops a runner it cannot use, and the whole read when the account line is missing", () => {
    expect(readRunner(null)).toBeNull();
    expect(readRunner({ id: R1 })).toBeNull();
    expect(readFleet(null)).toBeNull();
    expect(readFleet({ runners: [wire()] })).toBeNull();
    expect(readFleet(body([wire(), { id: "x" }])).runners).toHaveLength(1);
  });
});

describe("the account line (R-605-2)", () => {
  it("reads 16 of account limit 16 when live capacity is 20, and never 20", () => {
    const f = readFleet(body([wire()], { account: { limit: 16, capacity: 20, running: 3, runner_count: 3, runner_limit: 5 } }));
    expect(accountText(f.account)).toBe("Capacity 16 of account limit 16 · 3 running");
    expect(accountText(readFleet(body([wire()], { account: { limit: 16, capacity: 16, running: 0, runner_count: 1, runner_limit: 5 } })).account)).toBe("Capacity 16 of account limit 16 · 0 running");
  });
  it("says the limit is unavailable, rather than showing zero or null, while the plan data cannot say", () => {
    const text = accountText(readFleet(body([wire()], { account: { limit: null, capacity: 8, running: 1, runner_count: 1, runner_limit: null } })).account);
    expect(text).toBe("Capacity 8 · 1 running · account limit unavailable");
  });
  it("says to remove a runner once the plan's count is reached or passed", () => {
    const at = (count, most) => runnerLimitText(readFleet(body([wire()], { account: { limit: 4, capacity: 4, running: 0, runner_count: count, runner_limit: most } })).account);
    expect(at(4, 5)).toBe("");
    expect(at(5, 5)).toMatch(/all 5 runners your plan allows/);
    expect(at(6, 5)).toBe("Over your plan's runner limit: remove one to add another");
    expect(at(3, null)).toBe("");
  });
});

describe("states", () => {
  const parts = (over) => stateParts(readRunner(wire(over)));
  it("words every state, each with a mark and words so none is shown by colour alone", () => {
    expect(parts({ state: "online_idle" })).toEqual({ mark: "●", words: "Online" });
    expect(parts({ state: "busy", load_label: "Busy · 2 of 4" }).words).toBe("Busy · 2 of 4");
    expect(parts({ state: "paused", state_note: "Resumes within 5 min" }).words).toBe("Paused · Resumes within 5 min");
    expect(parts({ state: "draining", state_note: "Resumes within 5 min" }).words).toBe("Finishing current work");
    expect(parts({ state: "offline" }).words).toBe("Offline");
    expect(parts({ state: "outdated" }).words).toBe("Needs an update");
    expect(parts({ state: "revoked", state_note: "Revoked: registrant left", revoked_reason: "registrant_left" }).words).toBe("Revoked: registrant left");
    expect(parts({ state: "revoked", state_note: null }).words).toBe("Revoked");
    for (const state of Object.keys(STATE_WORDS)) expect(parts({ state }).mark).not.toBe("");
  });
  it("says Update needed beside the version of an outdated runner only", () => {
    expect(versionText(readRunner(wire({ state: "outdated" })))).toBe("0.9.1 · Update needed");
    expect(versionText(readRunner(wire()))).toBe("0.9.1");
    expect(versionText(readRunner(wire({ binary_version: null })))).toBe("Version unknown");
  });
  it("words capacity per class, and facts and the minter of a token-made runner", () => {
    expect(capacityText(readRunner(wire()))).toBe("Light 1 of 8 · Heavy 0 of 4");
    expect(capacityText(readRunner(wire({ capacity: null })))).toBe("Capacity unknown");
    expect(factsText(readRunner(wire()))).toBe("macos · arm64 · os_sandbox");
    expect(provText(readRunner(wire({ provisioning: { minted_by: { id: ME, name: "Ada Admin" }, first_ip: "203.0.113.9" } })))).toBe("Made from a token by Ada Admin · first seen at 203.0.113.9");
    expect(provText(readRunner(wire({ provisioning: { minted_by: { id: ME, name: "Ada Admin" }, first_ip: null } })))).toBe("Made from a token by Ada Admin");
  });
});

describe("controls", () => {
  it("offers Pause and Finish current work on a running runner, and Resume once it is held", () => {
    expect(controlList(readRunner(wire())).map((c) => c.action)).toEqual(["pause", "drain", "rename", "remove"]);
    expect(controlList(readRunner(wire({ paused: true }))).map((c) => c.action)).toEqual(["resume", "rename", "remove"]);
    expect(controlList(readRunner(wire({ draining: true }))).map((c) => c.action)).toEqual(["resume", "rename", "remove"]);
  });
  it("carries the reason of each control the caller may not use", () => {
    const why = "Only the person who registered this runner, or an owner or admin, can do this.";
    const no = { allowed: false, reason: why };
    const list = controlList(readRunner(wire({ controls: { pause: no, drain: no, resume: no, rename: no, remove: no } })));
    expect(list.every((c) => c.allowed === false && c.reason === why)).toBe(true);
  });
  it("offers none on a removed runner, which has controls null", () => {
    expect(controlList(readRunner(wire({ state: "revoked", controls: null })))).toEqual([]);
  });
  it("keeps the register-again data only where the cloud sent it", () => {
    expect(readRunner(wire()).again).toBeNull();
    const again = readRunner(wire({ state: "revoked", controls: null, register_again: { name: "Old laptop", labels: ["gpu"], repo_ids: [REPO] } })).again;
    expect(again).toEqual({ name: "Old laptop", labels: ["gpu"], repoIds: [REPO] });
  });
});

describe("the fleet controller", () => {
  it("reads once, and shows the error state only while it has nothing to show", async () => {
    const seen = [];
    const { call } = fakeCall({ "GET /api/runners": body([wire()]) });
    const fleet = createFleet({ call, onChange: () => seen.push(fleet.state.status) });
    expect(fleet.state.status).toBe("loading");
    await fleet.load();
    expect(fleet.state.status).toBe("ready");
    expect(fleet.state.fleet.runners).toHaveLength(1);
    const bad = fakeCall({ "GET /api/runners": fail(500, "x") });
    const f2 = createFleet({ call: bad.call });
    await f2.load();
    expect(f2.state.status).toBe("error");
  });

  it("sends one request for a double click on Pause, then reads again so the row reads Paused", async () => {
    let paused = false;
    const { call, log } = fakeCall({
      "GET /api/runners": () => body([wire(paused ? { state: "paused", state_note: "Resumes within 5 min", paused: true } : {})]),
      ["POST " + actionUrl(R1, "pause")]: () => ((paused = true), { runner_id: R1, paused: true }),
    });
    const fleet = createFleet({ call });
    await fleet.load();
    const first = fleet.act(R1, "pause");
    const second = fleet.act(R1, "pause"); // the double click
    expect(fleet.isPending(R1)).toBe(true);
    expect(await second).toBe("");
    expect(await first).toBe("");
    expect(log.filter(([m]) => m === "POST")).toEqual([["POST", actionUrl(R1, "pause"), {}]]);
    expect(stateParts(fleet.state.fleet.runners[0]).words).toBe("Paused · Resumes within 5 min");
    expect(fleet.isPending(R1)).toBe(false);
  });

  it("answers a refusal with the sentence of its status, never the server's text, and reads again", async () => {
    const { call, log } = fakeCall({ "GET /api/runners": body([wire()]), ["POST " + actionUrl(R1, "resume")]: fail(403, "forbidden"), ["POST " + actionUrl(R1, "remove")]: fail(409, "runner_revoked"), ["POST " + actionUrl(R1, "rename")]: fail(400, "invalid_message") });
    const fleet = createFleet({ call });
    await fleet.load();
    expect(await fleet.act(R1, "resume")).toBe(ACTION_SENTENCES[403]);
    expect(await fleet.act(R1, "remove")).toBe(ACTION_SENTENCES[409]);
    expect(await fleet.act(R1, "rename", { name: "" })).toBe(ACTION_SENTENCES[400]);
    expect(JSON.stringify(Object.values(ACTION_SENTENCES))).not.toContain(SERVER_TEXT);
    expect(log.filter(([m]) => m === "GET")).toHaveLength(4);
    expect(fleet.isPending(R1)).toBe(false);
  });

  it("sends the new name in the body of a rename", async () => {
    const { call, log } = fakeCall({ "GET /api/runners": body([wire()]), ["POST " + actionUrl(R1, "rename")]: {} });
    const fleet = createFleet({ call });
    await fleet.act(R1, "rename", { name: "Desk" });
    expect(log[0]).toEqual(["POST", "/api/runners/" + R1 + "/rename", { name: "Desk" }]);
  });
});

describe("Add a runner", () => {
  const TOKEN = ["fxrp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"].join("_"); // gitleaks:allow
  const CODE = ["fxrr", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2H1g0"].join("_"); // gitleaks:allow
  const routes = (over = {}) => ({
    "GET /api/runners/provisioning-tokens": { tokens: [{ id: "t1", name: "VPS", labels: [], credential_mode: "api_key", allowed_repo_ids: [REPO], minted_by: { id: ME, name: "Ada Admin" }, created_at: "2026-10-15T11:00:00.000Z", expires_at: "2026-10-15T12:30:00.000Z" }], limit: 5 },
    "POST /api/runners/provisioning-tokens": { id: "t2", token: TOKEN, expires_at: "2026-10-15T13:00:00.000Z", name: "VPS 2" },
    "POST /api/runners/registration-codes": { code: CODE, expires_at: "2026-10-15T12:10:00.000Z" },
    ...over,
  });

  it("makes a token with the form's values, shows the secret once with a --code-stdin command, and drops it when the sheet closes", async () => {
    const { call, log } = fakeCall(routes());
    const a = createAdder({ call, origin: "https://cloud.example" });
    a.open();
    await flush();
    expect(a.tokens.list).toEqual([{ id: "t1", name: "VPS", by: "Ada Admin", mode: "api_key", expires: "2026-10-15T12:30:00.000Z" }]);
    a.edit({ path: "token", name: "VPS 2", labels: "gpu, big-box", repoIds: [REPO], ttl: 21600 });
    await a.submit();
    expect(log.find(([m, p]) => m === "POST" && p === "/api/runners/provisioning-tokens")[2]).toEqual({ credential_mode: "api_key", allowed_repo_ids: [REPO], labels: ["gpu", "big-box"], ttl_seconds: 21600, name: "VPS 2" });
    expect(a.state.phase).toBe("made");
    expect(a.state.made.secret).toBe(TOKEN);
    expect(a.state.made.register).toBe(" printf '%s' '" + TOKEN + "' | fx-runner register --code-stdin --credential-mode api_key --cloud-url 'https://cloud.example' --name 'VPS 2'");
    a.close();
    expect(a.state).toBeNull();
    a.open();
    await flush();
    expect(JSON.stringify([a.state, a.tokens])).not.toContain(TOKEN);
    expect(a.tokens.list[0].name).toBe("VPS");
  });

  it("takes a code from the code path, with no name, labels or lifetime in the request", async () => {
    const { call, log } = fakeCall(routes());
    const a = createAdder({ call, origin: "https://cloud.example" });
    a.open();
    a.edit({ repoIds: [REPO], mode: "subscription", name: "ignored", labels: "ignored" });
    await a.submit();
    expect(log.find(([m, p]) => m === "POST" && p.endsWith("registration-codes"))[2]).toEqual({ credential_mode: "subscription", allowed_repo_ids: [REPO] });
    expect(a.state.made.secret).toBe(CODE);
    expect(a.state.made.register).toContain("--code-stdin");
    expect(a.state.made.register).not.toMatch(/--code [^-]/);
  });

  it("sends one request for a double press of Make", async () => {
    const { call, log } = fakeCall(routes());
    const a = createAdder({ call, origin: "https://cloud.example" });
    a.open();
    a.edit({ path: "token", repoIds: [REPO] });
    await Promise.all([a.submit(), a.submit()]);
    expect(log.filter(([m, p]) => m === "POST" && p.endsWith("provisioning-tokens"))).toHaveLength(1);
  });

  it("refuses before sending: no repo, or a label that is not one", async () => {
    const { call, log } = fakeCall(routes());
    const a = createAdder({ call, origin: "https://cloud.example" });
    a.open();
    await a.submit();
    expect(a.state.error).toBe("Pick at least one repo for it to work on.");
    a.edit({ path: "token", repoIds: [REPO], labels: "GPU!" });
    await a.submit();
    expect(a.state.error).toMatch(/^Labels are lowercase/);
    expect(log.filter(([m]) => m === "POST")).toEqual([]);
    expect(parseLabels("gpu, macos gpu")).toEqual(["gpu", "macos"]);
    expect(parseLabels(Array.from({ length: 17 }, (_, i) => "l" + i).join(","))).toBeNull();
    expect(parseLabels("")).toEqual([]);
  });

  it("answers a refusal with a sentence of its status, keeps the form, and never shows the server's text", async () => {
    for (const [status, code] of [[403, "forbidden"], [409, "token_limit"], [400, "unknown_repo"], [500, "x"]]) {
      const { call } = fakeCall(routes({ "POST /api/runners/provisioning-tokens": fail(status, code) }));
      const a = createAdder({ call, origin: "https://cloud.example" });
      a.open();
      a.edit({ path: "token", repoIds: [REPO] });
      await a.submit();
      expect(a.state.phase).toBe("form");
      expect(a.state.error).toBe((ADD_SENTENCES[status] || ADD_SENTENCES.other).replace("{limit}", "5"));
      expect(a.state.error).not.toContain(SERVER_TEXT);
    }
    expect(ADD_SENTENCES[403]).toBe(ONLY_ADMINS);
  });

  it("a repo that isn't private is refused with its own sentence (409 public_repo / repo_visibility_unknown), for a code and a token", async () => {
    for (const [path, url] of [["code", "/api/runners/registration-codes"], ["token", "/api/runners/provisioning-tokens"]]) {
      for (const code of ["public_repo", "repo_visibility_unknown"]) {
        const { call } = fakeCall(routes({ ["POST " + url]: fail(409, code) }));
        const a = createAdder({ call, origin: "https://cloud.example" });
        a.open();
        a.edit({ path, repoIds: [REPO] });
        await a.submit();
        expect(a.state.phase).toBe("form");
        expect(a.state.error).toBe(ADD_REPO_SENTENCES[code]);
        expect(a.state.made).toBeNull();
      }
    }
    expect(ADD_REPO_SENTENCES.public_repo).toMatch(/public repository can't run on a runner/);
  });

  it("names the token limit the list returned in the 409 sentence, not a fixed number", async () => {
    const { call } = fakeCall(routes({ "GET /api/runners/provisioning-tokens": { tokens: [], limit: 3 }, "POST /api/runners/provisioning-tokens": fail(409, "token_limit") }));
    const a = createAdder({ call, origin: "https://cloud.example" });
    a.open();
    await flush();
    a.edit({ path: "token", repoIds: [REPO] });
    await a.submit();
    expect(a.state.error).toBe("You already have 3 unused tokens. Revoke one first.");
    expect(a.state.error).not.toContain("{limit}");
  });

  it("drops the reply of a make that was still in flight when the sheet closed: no secret in the state afterwards, for a reply or a refusal", async () => {
    for (const settle of ["resolve", "reject"]) {
      let release;
      const gate = new Promise((r) => (release = r));
      const base = fakeCall(routes());
      const call = vi.fn(async (method, path, b, s) => {
        if (method === "POST" && path.endsWith("provisioning-tokens")) {
          await gate;
          if (settle === "reject") throw fail(500, "x");
        }
        return base.call(method, path, b, s);
      });
      const seen = [];
      const a = createAdder({ call, origin: "https://cloud.example", onChange: () => seen.push(JSON.stringify([a.state, a.tokens])) });
      a.open();
      await flush();
      a.edit({ path: "token", repoIds: [REPO] });
      const pending = a.submit();
      expect(a.state.phase).toBe("sending");
      a.close();
      release();
      await pending;
      await flush();
      expect(a.state).toBeNull();
      expect(JSON.stringify([a.state, a.tokens])).not.toContain(TOKEN);
      expect(seen.join("")).not.toContain(TOKEN); // never reached a repaint either
      // A sheet opened afterwards is a fresh form, not the old one.
      a.open();
      expect(a.state).toMatchObject({ phase: "form", made: null });
    }
  });

  it("starts the form from a runner whose registrant left: its name, labels and repos, on the token path", () => {
    const a = createAdder({ call: fakeCall(routes()).call, origin: "https://cloud.example" });
    a.open({ name: "Old laptop", labels: ["gpu"], repoIds: [REPO] });
    expect(a.state).toMatchObject({ path: "token", name: "Old laptop", labels: "gpu", repoIds: [REPO], phase: "form", made: null });
  });

  it("revokes an unused token and reads the list again; a failure says so and keeps the list", async () => {
    let revoked = false;
    const { call, log } = fakeCall(routes({ "DELETE /api/runners/provisioning-tokens/t1": () => ((revoked = true), { id: "t1", revoked: true }), "GET /api/runners/provisioning-tokens": () => ({ tokens: revoked ? [] : [{ id: "t1", name: "VPS", minted_by: { id: ME, name: "Ada" }, credential_mode: "api_key", expires_at: "2026-10-15T12:30:00.000Z" }], limit: 5 }) }));
    const a = createAdder({ call, origin: "https://cloud.example" });
    a.open();
    await flush();
    expect(a.tokens.list).toHaveLength(1);
    expect(await a.revoke("t1")).toBe("");
    expect(a.tokens.list).toEqual([]);
    expect(log.some(([m, p]) => m === "DELETE" && p.endsWith("/t1"))).toBe(true);
    const broken = fakeCall(routes({ "DELETE /api/runners/provisioning-tokens/t1": fail(500, "x") }));
    const b = createAdder({ call: broken.call, origin: "https://cloud.example" });
    b.open();
    await flush();
    expect(await b.revoke("t1")).toBe("That token couldn't be revoked. Try again.");
    expect(b.tokens.list).toHaveLength(1);
  });
});

describe("commands and repo choices", () => {
  it("quotes a name with a quote in it, and never puts the secret in an argument of fx-runner", () => {
    const c = commandsFor({ secret: "fxrp_x", origin: "https://c.example", mode: "api_key", name: "Ada's box" });
    expect(c.register).toBe(" printf '%s' 'fxrp_x' | fx-runner register --code-stdin --credential-mode api_key --cloud-url 'https://c.example' --name 'Ada'\\''s box'");
    expect(c.register.split("|")[1]).not.toContain("fxrp_x");
    // A quote in the secret or the origin cannot end its word: each is closed, escaped and reopened.
    const odd = commandsFor({ secret: "ab'cd", origin: "https://c.example/'x", mode: "api_key", name: "" });
    expect(odd.register).toBe(" printf '%s' 'ab'\\''cd' | fx-runner register --code-stdin --credential-mode api_key --cloud-url 'https://c.example/'\\''x'");
    expect(commandsFor({ secret: "fxrr_y", origin: "https://c.example", mode: "subscription", name: "" }).register).not.toContain("--name");
  });
  it("lists installed repos by name, following the cursor, and never by id", async () => {
    const pages = {
      "/api/v1/repos": { data: [{ id: "a", install_state: "installed", full_name: "acme/web", product: "x" }, { id: "b", install_state: "not_installed", full_name: "acme/skip", product: "y" }], next_cursor: "c1" },
      "/api/v1/repos?cursor=c1": { data: [{ id: "c", install_state: "installed", full_name: null, product: "Docs" }], next_cursor: null },
    };
    const call = vi.fn(async (_m, path) => pages[path]);
    expect(await loadRepoChoices(call)).toEqual([{ id: "c", name: "Docs" }, { id: "a", name: "acme/web" }].sort((x, y) => x.name.localeCompare(y.name)));
  });
});

describe("the Runs app's launch argument (what the fleet's run links send)", () => {
  const RUN = "88888888-8888-4888-8888-888888888881";
  it("names the run for a UUID, in lower case", () => {
    expect(launchRunId({ runId: RUN })).toBe(RUN);
    expect(launchRunId({ runId: RUN.toUpperCase() })).toBe(RUN);
  });
  it("ignores a bad id, and an argument of the wrong shape", () => {
    for (const bad of [{ runId: "not-a-uuid" }, { runId: RUN + "x" }, { runId: "../../etc" }, { runId: 5 }, { runId: null }, { other: RUN }, "str", 7, [RUN], []]) expect(launchRunId(bad)).toBe("");
  });
  it("opens nothing when there is no argument", () => {
    expect(launchRunId(undefined)).toBe("");
    expect(launchRunId(null)).toBe("");
  });
});
