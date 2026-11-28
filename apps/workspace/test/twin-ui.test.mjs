// D#845 ON-27e: the private twin's screens. The pure words and view-model (apps/_lib/dom.js), the picker's choice card and create steps with the plan choice (mountTwinOffer, in apps/onboarding/onboarding-engine.js), and the Repos twin card with
// its Private paths editor and sheets (createTwinCard, in apps/repos/repos-runners.js). The server is a strict fake call(); the drawn trees are the shared h() built against a small stand-in for the DOM calls it makes (no jsdom here), and
// every click is made with a real handler call, so what a button passes is checked. The same screens on the built page, with real clicks, are in e2e/onboarding-twin.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADOPT_COPY, TWIN_COST, TWIN_NOT_PRIVATE, adoptWords, droppedPaths, narrowWarning, parsePathLines, pathLines, readTwin, twinCanAdopt, twinChoice, twinDetail, twinRefusal, twinRows,
} from "../apps/_lib/dom.js";
import { mountTwinOffer, mountTwinPlanChoice } from "../apps/onboarding/onboarding-engine.js";
import { MEMBER_TEXT, REMOVE_EVERYTHING, TWIN_ENDS_LINE, TWIN_SHEETS, createRemoveFlow, createTwinCard, createTwinController, endsTwinAfter } from "../apps/repos/repos-runners.js";

const PUB = "11111111-1111-4111-8111-111111111111";
const PRIV = "22222222-2222-4222-8222-222222222222";
const TWIN = "33333333-3333-4333-8333-333333333333";
const SETUP = "44444444-4444-4444-8444-444444444444";
const SHA = "a".repeat(40);
const fail = (status, code) => Object.assign(new Error("server text that must never be shown"), { status, code });
const flush = () => new Promise((r) => setTimeout(r, 0));
const item = (over = {}) => ({ id: TWIN, public_repo_id: PUB, private_repo_id: PRIV, private_name: "site-private", state: "ready", overlay_globs: [], published_private_sha: SHA, synced_public_sha: null, publish_pr: null, sync_pr: null, failure_code: null, merged_count: null, new_changes_count: null, note: null, created_at: "x", updated_at: "x", ...over });
const PATHS = (over = {}) => ({ overlay_globs: ["internal/**", "notes/**"], binary_globs: [], install_paths: ["tools/x.sh"], fixed_roots: [".env"], identifier_rules_path: ".autonomous-team/ids.txt", plan_data_rules_path: null, revision: "r1", ...over });

/** A server answering by "METHOD path"; a function value is called each time, an Error is thrown. Every call is logged with its arguments. */
function fakeCall(routes) {
  const log = [];
  const call = vi.fn(async (method, path, body) => {
    log.push([method, path, body]);
    const r = routes[method + " " + path];
    if (r === undefined) throw fail(404, "not_found");
    const v = typeof r === "function" ? r(body) : r;
    if (v instanceof Error) throw v;
    return v;
  });
  call.log = log;
  return call;
}

// ── a stand-in for the DOM calls h() and these views make ──────────────────
class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.kids = []; this.on = {}; this.className = ""; this.value = ""; this.disabled = false; this.focused = 0; this.open = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { this.on[t] = f; }
  appendChild(c) { this.kids.push(c); return c; }
  replaceChildren(...c) { if (active && this.contains(active) && active !== this) active = null; this.kids = c.map((x) => (x instanceof FakeNode ? x : { text: String(x) })); } // like the browser: anything that is not a node is printed as text
  contains(n) { return n === this || this.kids.some((k) => k instanceof FakeEl && k.contains(n)); }
  focus() { this.focused++; setActive(this); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { this.removed = true; if (active && this.contains(active)) active = null; const i = bodyEl.kids.indexOf(this); if (i >= 0) bodyEl.kids.splice(i, 1); }
  querySelector(sel) { const id = /data-testid="([^"]+)"/.exec(sel)[1]; return findAll(this, (e) => e.getAttribute("data-testid") === id)[0] || null; }
  get textContent() { return this.kids.map((k) => (k instanceof FakeEl ? k.textContent : k.text)).join(""); }
}
const findAll = (el, test, out = []) => (test(el) && out.push(el), el.kids.forEach((k) => k instanceof FakeEl && findAll(k, test, out)), out);
const byId = (root, id) => findAll(root, (e) => e.getAttribute("data-testid") === id)[0];
const allById = (root, id) => findAll(root, (e) => e.getAttribute("data-testid") === id);
const text = (root) => root.textContent;
/** A real click: the handler is called with a sentinel event, and the page's handler must not pass it on. */
const click = (el) => { expect(el, "button is on screen").toBeTruthy(); el.on.click("EVENT"); };
const bodyEl = new FakeEl("body");
let assigned;
const setActive = (e) => { active = e; };
let active = null; // document.activeElement: a focused node that is removed or replaced drops focus to the body, like a browser
const focusDoc = { body: bodyEl, get activeElement() { return active || bodyEl; } };
beforeEach(() => {
  assigned = [];
  bodyEl.kids = [];
  active = null;
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("document", { createElement: (t) => new FakeEl(t), createTextNode: (t) => ({ text: t }), body: bodyEl, get activeElement() { return active || bodyEl; } });
  vi.stubGlobal("window", { location: { assign: (u) => assigned.push(u) } });
});
afterEach(() => vi.unstubAllGlobals());

describe("the twin's words and view-model", () => {
  it("the choice card is the Spec's copy, with the owner and name filled in; the twin is marked recommended", () => {
    const c = twinChoice("acme", "site");
    expect(c.make).toBe("Make a private twin (recommended)");
    expect(c.makeText).toBe("We'll create acme/site-private, copy your code into it, and run the engine there. Plans, Discussions and work stay private. Merged work comes back to acme/site as a pull request you merge.");
    expect(c.stay).toBe("Stay public-only");
    expect(c.stayText).toBe("The engine surveys this public repo and drafts a plan you review item by item. It can't run here yet.");
    expect(TWIN_COST).toBe("CI on the private repo uses your GitHub Actions minutes (GitHub Free includes 2,000 a month). Public repos run Actions free.");
    expect([ADOPT_COPY.use, ADOPT_COPY.again]).toEqual(["Use my approved plan", "Survey again"]);
  });

  it("the three track rows follow the state: created, copying, ready; none for a removed twin; a failed copy is failed", () => {
    const at = (state) => twinRows(state).map((r) => r.state);
    expect(twinRows("seeding").map((r) => r.label)).toEqual(["Private twin created", "Copying your code…", "Ready"]);
    expect(at("creating")).toEqual(["active", "pending", "pending"]);
    expect(at("not_connected")).toEqual(["done", "active", "pending"]);
    expect(at("seeding")).toEqual(["done", "active", "pending"]);
    expect(at("failed")).toEqual(["done", "failed", "pending"]);
    for (const s of ["ready", "paused", "conflict", "refused"]) expect(at(s)).toEqual(["done", "done", "done"]);
    expect(twinRows("removed")).toEqual([]);
    expect(twinRows("__proto__")).toEqual([]);
  });

  it("an open publish or sync pull request is a line in the Spec's words; a number that is not one is no line", () => {
    const lines = (over, pub) => twinDetail(item(over), "acme", pub).twin.lines;
    expect(lines({ publish_pr: 7 })).toContain("Publish PR #7 is open: merge it on GitHub");
    expect(lines({ sync_pr: 9 }, "acme/site")).toContain("acme/site has new changes: bringing them in (PR #9 on the private repo)");
    for (const bad of [0, -1, 1.5, "7", null]) expect(lines({ publish_pr: bad, sync_pr: bad }).join(" ")).not.toMatch(/PR #/);
    expect(twinDetail(item({ state: "removed", publish_pr: 7 }), "acme").twin.lines.join(" ")).not.toMatch(/PR #/);
  });

  it("readTwin keeps an item only when it fits, and lowercases its ids", () => {
    expect(readTwin({ twin: item({ id: TWIN.toUpperCase() }) })).toMatchObject({ id: TWIN, public_repo_id: PUB, private_repo_id: PRIV, state: "ready" });
    for (const bad of [null, {}, { twin: null }, { twin: item({ id: "x" }) }, { twin: item({ state: "toString" }) }, { twin: item({ private_name: "../x" }) }, { twin: item({ public_repo_id: 3 }) }]) expect(readTwin(bad)).toBeNull();
    expect(readTwin({ twin: item({ private_repo_id: "nope" }) }).private_repo_id).toBeNull();
  });

  it("a plan may be carried only into a ready or paused twin, and every other state is refused by the page too", () => {
    for (const s of ["ready", "paused"]) expect(twinCanAdopt({ state: s })).toBe(true);
    for (const s of ["creating", "not_connected", "seeding", "conflict", "refused", "failed", "removed"]) expect(twinCanAdopt({ state: s })).toBe(false);
    expect(twinCanAdopt(null)).toBe(false);
  });

  it("every refusal is a fixed sentence by its closed code; the server's own words never show", () => {
    for (const code of ["twin_exists", "pairing_exists", "install_first", "twin_repo_not_public", "rate_limited", "validation_failed", "twin_state", "twin_not_ready", "twin_paths_changed"]) {
      expect(twinRefusal(fail(409, code))).not.toMatch(/server text|undefined|null|_/);
    }
    expect(twinRefusal(fail(403, "forbidden"))).toBe("Only an owner or admin can change this.");
    expect(twinRefusal(fail(500, "boom"))).toBe("That didn't go through. Try again.");
    expect(twinRefusal(fail(409, "__proto__"))).toBe("That didn't go through. Try again.");
    expect(adoptWords({ adopted: true })).toMatch(/carried over/);
    expect(adoptWords({ adopted: false, reason: "no_draft" })).toMatch(/no plan to carry over/);
    expect(adoptWords({ adopted: false, reason: "bad_state" })).toMatch(/already started/);
  });

  it("the path lists round-trip, and narrowing is what a new list no longer holds", () => {
    expect(parsePathLines(" a/** \n\n b.txt \n")).toEqual(["a/**", "b.txt"]);
    expect(pathLines(["a", "b"])).toBe("a\nb");
    expect(pathLines(null)).toBe("");
    expect(droppedPaths(["a", "b", "c"], ["b", "x"])).toEqual(["a", "c"]);
    expect(droppedPaths([], ["x"])).toEqual([]);
    expect(narrowWarning(["a"])).toContain("Removing 1 path ");
    expect(narrowWarning(["a", "b"])).toContain("Removing 2 paths ");
  });
});

describe("the picker's twin card (mountTwinOffer)", () => {
  const SITE = { id: PUB, name: "acme/site", visibility: "public" };
  const PRIVATE = { id: PRIV, name: "acme/site-private", visibility: "private" };
  const mount = (repo, routes, over = {}) => {
    const host = new FakeEl("div");
    const call = fakeCall(routes);
    const env = { repo, call, announce: vi.fn(), redraw: vi.fn(), pick: vi.fn(), install: vi.fn(), ...over };
    return { host, call, env, offer: mountTwinOffer(host, env) };
  };

  it("with twins off (503), or the read failing, draws nothing: no card, no placeholder text", async () => {
    for (const e of [fail(503, "not_configured"), fail(500, "boom"), fail(404, "not_found")]) {
      const { host } = mount(SITE, { [`GET /api/v1/repos/${PUB}/twin`]: e });
      await flush();
      expect(host.kids).toEqual([]);
    }
    const { host } = mount(SITE, { [`GET /api/v1/repos/${PUB}/twin`]: { not_a_twin: true } });
    await flush();
    expect(host.kids).toEqual([]);
  });

  it("a public repo with no twin gets the choice card in the Spec's words; Stay public-only takes it away without a request", async () => {
    const { host, call } = mount(SITE, { [`GET /api/v1/repos/${PUB}/twin`]: { twin: null } });
    await flush();
    const c = twinChoice("acme", "site");
    expect(text(byId(host, "ob-twin-make"))).toBe(c.make);
    expect(text(byId(host, "ob-twin-make-text"))).toBe(c.makeText);
    expect(text(byId(host, "ob-twin-stay"))).toBe(c.stay);
    expect(text(byId(host, "ob-twin-stay-text"))).toBe(c.stayText);
    expect(text(byId(host, "ob-twin-cost"))).toBe(TWIN_COST);
    click(byId(host, "ob-twin-stay"));
    expect(host.kids).toEqual([]);
    expect(call.log.map((l) => l[0])).toEqual(["GET"]);
  });

  it("a private repo that is not half of a twin gets no card", async () => {
    const { host } = mount(PRIVATE, { [`GET /api/v1/repos/${PRIV}/twin`]: { twin: null } });
    await flush();
    expect(host.kids).toEqual([]);
  });

  it("Make a private twin asks for the name (default <name>-private), then sends it once and goes to GitHub's own page", async () => {
    const { host, call } = mount(SITE, {
      [`GET /api/v1/repos/${PUB}/twin`]: { twin: null },
      [`POST /api/v1/repos/${PUB}/twin`]: { authorize_url: "https://github.com/login/oauth/authorize?state=s" },
    });
    await flush();
    click(byId(host, "ob-twin-make"));
    expect(byId(host, "ob-twin-name").value).toBe("site-private");
    byId(host, "ob-twin-name").on.input({ target: { value: " widgets-private " } });
    click(byId(host, "ob-twin-continue"));
    await flush();
    expect(call.log.filter((l) => l[0] === "POST")).toEqual([["POST", `/api/v1/repos/${PUB}/twin`, { name: "widgets-private" }]]);
    expect(assigned).toEqual(["https://github.com/login/oauth/authorize?state=s"]);
  });

  it("a name that is not a repo name is refused on the page, and an address that is not GitHub's is never followed", async () => {
    const { host, call } = mount(SITE, {
      [`GET /api/v1/repos/${PUB}/twin`]: { twin: null },
      [`POST /api/v1/repos/${PUB}/twin`]: { authorize_url: "https://evil.example/x" },
    });
    await flush();
    click(byId(host, "ob-twin-make"));
    byId(host, "ob-twin-name").on.input({ target: { value: "bad name!" } });
    click(byId(host, "ob-twin-continue"));
    await flush();
    expect(text(byId(host, "ob-twin-error"))).toBe(twinRefusal({ code: "validation_failed" }));
    expect(call.log.filter((l) => l[0] === "POST")).toEqual([]);
    byId(host, "ob-twin-name").on.input({ target: { value: "ok-name" } });
    click(byId(host, "ob-twin-continue"));
    await flush();
    expect(assigned).toEqual([]);
    expect(text(byId(host, "ob-twin-error"))).toBe("That didn't go through. Try again.");
  });

  it("a refused create says why in fixed words, and an existing twin shows its card instead", async () => {
    let twin = null;
    const { host } = mount(SITE, {
      [`GET /api/v1/repos/${PUB}/twin`]: () => ({ twin }),
      [`POST /api/v1/repos/${PUB}/twin`]: () => { twin = item({ state: "seeding", published_private_sha: null }); return Promise.reject(fail(409, "twin_exists")); },
    });
    await flush();
    click(byId(host, "ob-twin-make"));
    click(byId(host, "ob-twin-continue"));
    await flush();
    expect(text(byId(host, "ob-twin-line"))).toContain("Copying your code");
    expect(text(host)).toContain("This repo has a private twin: site-private");
  });

  it("a public repo with a live twin sends the person to the twin: the twin's lines, 'Set up the private twin', and the public repo cannot be placed", async () => {
    const { host, offer, env } = mount(SITE, { [`GET /api/v1/repos/${PUB}/twin`]: { twin: item({ state: "seeding", published_private_sha: null }) } });
    await flush();
    expect(offer.holdsPlace()).toBe(true);
    expect(text(byId(host, "ob-twin-line"))).toBe("Copying your code into the private repo…");
    click(byId(host, "ob-twin-setup"));
    expect(env.pick).toHaveBeenCalledTimes(1);
    expect(env.pick.mock.calls[0]).toEqual([PRIV]);
  });

  it("the private twin repo shows the three rows and the state's sentence; a twin waiting on the App offers 'Add <name> to the GitHub app'", async () => {
    const { host, offer, env } = mount(PRIVATE, { [`GET /api/v1/repos/${PRIV}/twin`]: { twin: item({ state: "not_connected", published_private_sha: null }) } });
    await flush();
    expect(offer.holdsPlace()).toBe(false);
    expect(allById(host, "ob-twin-row").map((r) => [text(r), r.getAttribute("data-state")])).toEqual([
      ["Private twin createdDone", "done"], ["Copying your code…Up next", "active"], ["ReadyWaiting", "pending"],
    ]);
    expect(text(byId(host, "ob-twin-add-to-app"))).toBe("Add site-private to the GitHub app");
    click(byId(host, "ob-twin-add-to-app"));
    expect(env.install).toHaveBeenCalledTimes(1);
    expect(env.install.mock.calls[0]).toEqual([]);
  });

  describe("Use my approved plan", () => {
    const placedWith = async (state, adopt) => {
      const m = mount(PRIVATE, { [`GET /api/v1/repos/${PRIV}/twin`]: { twin: item({ state }) }, [`POST /api/v1/twins/${TWIN}/adopt-plan`]: adopt });
      await flush();
      m.offer.placed(SETUP);
      await flush();
      return m;
    };

    it("is offered with Survey again once the setup is placed and the twin is ready or paused; the call carries the setup and shows the answer in words", async () => {
      for (const state of ["ready", "paused"]) {
        const { host, call } = await placedWith(state, { adopted: true, draft_id: "d", reason: null });
        expect(text(byId(host, "ob-twin-adopt"))).toBe("Use my approved plan");
        expect(text(byId(host, "ob-twin-again"))).toBe("Survey again");
        click(byId(host, "ob-twin-adopt"));
        await flush();
        expect(call.log.filter((l) => l[0] === "POST")).toEqual([["POST", `/api/v1/twins/${TWIN}/adopt-plan`, { setup_id: SETUP }]]);
        expect(text(byId(host, "ob-twin-adopted"))).toMatch(/carried over/);
        expect(byId(host, "ob-twin-adopt")).toBeUndefined();
      }
    });

    it("is not offered in any other state, so the page never asks the server for what it will refuse", async () => {
      for (const state of ["creating", "not_connected", "seeding", "conflict", "refused", "failed"]) {
        const { host, call } = await placedWith(state, { adopted: true });
        expect(byId(host, "ob-twin-adopt"), state).toBeUndefined();
        expect(call.log.filter((l) => l[0] === "POST")).toEqual([]);
      }
    });

    it("Survey again sends nothing and takes the choice away", async () => {
      const { host, call } = await placedWith("ready", { adopted: true });
      click(byId(host, "ob-twin-again"));
      expect(byId(host, "ob-twin-adopt")).toBeUndefined();
      expect(call.log.filter((l) => l[0] === "POST")).toEqual([]);
    });

    it("a server refusal (the route's own 409 when the twin moved on) is a fixed sentence, and the twin is read again", async () => {
      const { host, call } = await placedWith("ready", fail(409, "twin_not_ready"));
      click(byId(host, "ob-twin-adopt"));
      await flush();
      expect(text(byId(host, "ob-twin-error"))).toBe(twinRefusal({ code: "twin_not_ready" }));
      expect(call.log.filter((l) => l[0] === "GET").length).toBe(3);
    });

    it("no plan on the public repo, or a survey already started, is said in words", async () => {
      for (const [reason, re] of [["no_draft", /no plan to carry over/], ["bad_state", /already started/]]) {
        const { host } = await placedWith("ready", { adopted: false, draft_id: null, reason });
        click(byId(host, "ob-twin-adopt"));
        await flush();
        expect(text(byId(host, "ob-twin-adopted"))).toMatch(re);
      }
    });
  });
});

describe("the Repos twin controller", () => {
  const make = (routes, over = {}) => {
    const call = fakeCall({ [`GET /api/v1/repos/${PRIV}/twin`]: { twin: item() }, [`GET /api/v1/twins/${TWIN}/paths`]: PATHS(), ...routes });
    return { call, ctl: createTwinController({ call, repoId: PRIV, ...over }) };
  };

  it("twins off (503) or none leaves the card off, and no paths are read", async () => {
    for (const e of [fail(503, "not_configured"), { twin: null }]) {
      const { ctl, call } = make({ [`GET /api/v1/repos/${PRIV}/twin`]: e });
      await ctl.load();
      expect(ctl.state.phase).toBe("off");
      expect(call.log.some((l) => l[1].includes("/paths"))).toBe(false);
    }
  });

  it("an owner or admin reads the private paths; a member reads none and makes no request for them", async () => {
    const admin = make({});
    await admin.ctl.load();
    expect(admin.ctl.state).toMatchObject({ phase: "ready", pathsState: "ok", paths: { overlay: ["internal/**", "notes/**"], install: ["tools/x.sh"], revision: "r1", identifier: ".autonomous-team/ids.txt" } });
    const member = make({}, { canChange: () => false });
    await member.ctl.load();
    expect(member.ctl.state.pathsState).toBe("member");
    expect(member.call.log.some((l) => l[1].includes("/paths"))).toBe(false);
    const denied = make({ [`GET /api/v1/twins/${TWIN}/paths`]: fail(403, "forbidden") });
    await denied.ctl.load();
    expect(denied.ctl.state.pathsState).toBe("member");
  });

  it("pause and resume are POSTs and the answer is the twin as it is; Stop publishing and Cancel are the one DELETE and end the card", async () => {
    const { ctl, call } = make({ [`POST /api/v1/twins/${TWIN}/pause`]: item({ state: "paused" }), [`POST /api/v1/twins/${TWIN}/resume`]: item(), [`DELETE /api/v1/twins/${TWIN}`]: item({ state: "removed" }) });
    await ctl.load();
    expect(await ctl.act("pause")).toBe(true);
    expect(ctl.state.row.state).toBe("paused");
    expect(await ctl.act("resume")).toBe(true);
    expect(ctl.state.row.state).toBe("ready");
    expect(await ctl.act("cancel")).toBe(true);
    expect(ctl.state).toMatchObject({ phase: "off", row: null });
    expect(call.log.filter((l) => l[0] !== "GET").map((l) => l[0] + " " + l[1])).toEqual([`POST /api/v1/twins/${TWIN}/pause`, `POST /api/v1/twins/${TWIN}/resume`, `DELETE /api/v1/twins/${TWIN}`]);
  });

  it("a state the twin has moved on from is a fixed sentence and a re-read, never the server's words", async () => {
    let state = "ready";
    const { ctl } = make({ [`GET /api/v1/repos/${PRIV}/twin`]: () => ({ twin: item({ state }) }), [`POST /api/v1/twins/${TWIN}/pause`]: () => { state = "conflict"; return Promise.reject(fail(409, "twin_state")); } });
    await ctl.load();
    expect(await ctl.act("pause")).toBe(false);
    expect(ctl.state.error).toBe(twinRefusal({ code: "twin_state" }));
    expect(ctl.state.row.state).toBe("conflict");
  });

  it("narrowing the private set asks first and sends nothing; the same save again sends it with the revision it read", async () => {
    const { ctl, call } = make({ [`PUT /api/v1/twins/${TWIN}/paths`]: PATHS({ revision: "r2", overlay_globs: ["notes/**"] }) });
    await ctl.load();
    expect(await ctl.savePaths("notes/**", "")).toBe(false);
    expect(ctl.state.warn).toBe(narrowWarning(["internal/**"]));
    expect(call.log.some((l) => l[0] === "PUT")).toBe(false);
    expect(await ctl.savePaths("notes/**", "")).toBe(true);
    expect(call.log.filter((l) => l[0] === "PUT")).toEqual([["PUT", `/api/v1/twins/${TWIN}/paths`, { revision: "r1", overlay_globs: ["notes/**"], binary_globs: [] }]]);
    expect(ctl.state).toMatchObject({ warn: "", notice: "Saved." });
  });

  it("widening the set sends at once with no warning; a changed warning (another narrowing) asks again", async () => {
    const { ctl, call } = make({ [`PUT /api/v1/twins/${TWIN}/paths`]: PATHS() });
    await ctl.load();
    expect(await ctl.savePaths("internal/**\nnotes/**\nextra/**", "assets/*.png")).toBe(true);
    expect(call.log.filter((l) => l[0] === "PUT")[0][2]).toEqual({ revision: "r1", overlay_globs: ["internal/**", "notes/**", "extra/**"], binary_globs: ["assets/*.png"] });
    expect(await ctl.savePaths("notes/**", "")).toBe(false);
    expect(await ctl.savePaths("", "")).toBe(false); // two removed now: the warning is another one
    expect(call.log.filter((l) => l[0] === "PUT").length).toBe(1);
  });

  it("a stale revision re-reads the paths and says so; an unallowed path is a fixed sentence", async () => {
    let n = 0;
    const { ctl } = make({ [`GET /api/v1/twins/${TWIN}/paths`]: () => PATHS({ revision: "r" + ++n }), [`PUT /api/v1/twins/${TWIN}/paths`]: fail(409, "twin_paths_changed") });
    await ctl.load();
    expect(await ctl.savePaths("internal/**\nnotes/**\nz", "")).toBe(false);
    expect(ctl.state.error).toBe(twinRefusal({ code: "twin_paths_changed" }));
    expect(ctl.state.paths.revision).toBe("r2");
    const bad = make({ [`PUT /api/v1/twins/${TWIN}/paths`]: fail(422, "invalid_role_settings_input") });
    await bad.ctl.load();
    await bad.ctl.savePaths("internal/**\nnotes/**\n/abs", "");
    expect(bad.ctl.state.error).toBe("One of those paths isn't allowed, or a rule file would no longer be private.");
  });
});

describe("the Repos twin card", () => {
  const REPOS = [{ id: PUB, full_name: "acme/site" }, { id: PRIV, full_name: "acme/site-private" }];
  const mount = async (routes, over = {}) => {
    const call = fakeCall({ [`GET /api/v1/repos/${PRIV}/twin`]: { twin: item() }, [`GET /api/v1/twins/${TWIN}/paths`]: PATHS(), ...routes });
    const env = { repoId: PRIV, call, getRepo: (id) => REPOS.find((r) => r.id === id), canChange: () => true, removeRepo: vi.fn(), onChanged: vi.fn(), announce: vi.fn(), focusFallback: vi.fn(), doc: focusDoc, ...over };
    const card = createTwinCard(env);
    await card.load();
    return { card, call, env, el: card.el };
  };

  it("is empty with twins off or no twin", async () => {
    for (const e of [fail(503, "not_configured"), { twin: null }]) expect((await mount({ [`GET /api/v1/repos/${PRIV}/twin`]: e })).el.kids).toEqual([]);
  });

  it("names the public repo it publishes to, says the cost and shows an open publish pull request", async () => {
    const { el } = await mount({ [`GET /api/v1/repos/${PRIV}/twin`]: { twin: item({ publish_pr: 7, sync_pr: 9 }) } });
    expect(text(byId(el, "repos-twin-publishes"))).toBe("Publishes to acme/site");
    expect(allById(el, "repos-twin-line").map(text)).toEqual(expect.arrayContaining(["Publish PR #7 is open: merge it on GitHub", "acme/site has new changes: bringing them in (PR #9 on the private repo)"]));
    expect(text(byId(el, "repos-twin-cost"))).toBe(TWIN_COST);
    expect(text(el)).not.toMatch(/\b(null|undefined|NaN)\b/);
  });

  it("the public repo's own card says where the work runs, with no editor and no removal", async () => {
    const { el } = await mount({ [`GET /api/v1/repos/${PUB}/twin`]: { twin: item() } }, { repoId: PUB });
    expect(text(byId(el, "repos-twin-runs-in"))).toContain("site-private");
    expect(byId(el, "repos-twin-overlay")).toBeUndefined();
    expect(byId(el, "repos-twin-remove")).toBeUndefined();
  });

  it("a member reads the card without the Private paths editor, and the buttons are not drawn", async () => {
    const { el, call } = await mount({}, { canChange: () => false });
    expect(text(byId(el, "repos-twin-paths-member"))).toBe(MEMBER_TEXT);
    expect(byId(el, "repos-twin-overlay")).toBeUndefined();
    expect(byId(el, "repos-twin-pause")).toBeUndefined();
    expect(call.log.some((l) => l[1].includes("/paths"))).toBe(false);
  });

  it("Pause opens a sheet that says what stays on GitHub; nothing is sent until its button, which sends one POST and announces it", async () => {
    const { el, call, env } = await mount({ [`POST /api/v1/twins/${TWIN}/pause`]: item({ state: "paused" }) });
    click(byId(el, "repos-twin-pause"));
    expect(call.log.some((l) => l[0] === "POST")).toBe(false);
    const sheet = byId(bodyEl, "repos-twin-sheet");
    expect(sheet.open).toBe(true);
    expect(text(sheet)).toContain(TWIN_SHEETS.pause.lines[1]);
    expect(text(sheet)).toContain("Everything already on GitHub stays");
    click(byId(bodyEl, "repos-twin-sheet-confirm"));
    await flush();
    expect(call.log.filter((l) => l[0] === "POST").map((l) => l[1])).toEqual([`/api/v1/twins/${TWIN}/pause`]);
    expect(sheet.removed).toBe(true);
    expect(env.announce).toHaveBeenCalledWith("Paused.");
    expect(text(byId(el, "repos-twin-line"))).toContain("Paused.");
    expect(byId(el, "repos-twin-resume")).toBeTruthy();
    expect(document.activeElement).toBe(byId(el, "repos-twin-resume")); // the Pause button is gone: focus is on Resume, not the body
  });

  it("Resume puts focus back on Pause, and a press while a request is in flight is ignored (aria-disabled, never native disabled)", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { el, call } = await mount({
      [`GET /api/v1/repos/${PRIV}/twin`]: { twin: item({ state: "paused" }) },
      [`POST /api/v1/twins/${TWIN}/resume`]: () => gate.then(() => item()),
    });
    click(byId(el, "repos-twin-resume"));
    expect(byId(el, "repos-twin-resume").getAttribute("aria-disabled")).toBe("true");
    expect(byId(el, "repos-twin-resume").disabled).toBe(false);
    expect(byId(el, "repos-twin-overlay").getAttribute("aria-disabled")).toBe("true");
    expect(byId(el, "repos-twin-overlay").disabled).toBe(false);
    expect(document.activeElement).toBe(byId(el, "repos-twin-resume"));
    byId(el, "repos-twin-resume").on.click("EVENT");
    byId(el, "repos-twin-paths-save").on.click("EVENT");
    release();
    await flush();
    expect(call.log.filter((l) => l[0] === "POST").length).toBe(1);
    expect(call.log.some((l) => l[0] === "PUT")).toBe(false);
    expect(document.activeElement).toBe(byId(el, "repos-twin-pause"));
    expect(byId(el, "repos-twin-pause").getAttribute("aria-disabled")).toBe("false");
  });

  it("Cancel on the sheet sends nothing; Stop publishing says the private repo stays on GitHub and sends one DELETE", async () => {
    const { el, call, env } = await mount({ [`DELETE /api/v1/twins/${TWIN}`]: item({ state: "removed" }) });
    click(byId(el, "repos-twin-stop"));
    expect(text(byId(bodyEl, "repos-twin-sheet"))).toContain("The private repo stays on GitHub");
    click(byId(bodyEl, "repos-twin-sheet-cancel"));
    expect(call.log.some((l) => l[0] === "DELETE")).toBe(false);
    expect(document.activeElement).toBe(byId(el, "repos-twin-stop")); // the card was rebuilt, and focus is on the new button that opened the sheet
    click(byId(el, "repos-twin-stop"));
    click(byId(bodyEl, "repos-twin-sheet-confirm"));
    await flush();
    expect(call.log.filter((l) => l[0] === "DELETE").length).toBe(1);
    expect(el.kids).toEqual([]);
    expect(env.focusFallback).toHaveBeenCalled(); // the card is gone: focus goes to the page's heading, not the body
  });

  it("Escape on the sheet, and a refused Pause, leave focus on the opener", async () => {
    const { el, env } = await mount({ [`POST /api/v1/twins/${TWIN}/pause`]: fail(409, "twin_state"), [`GET /api/v1/repos/${PRIV}/twin`]: { twin: item() } });
    click(byId(el, "repos-twin-pause"));
    byId(bodyEl, "repos-twin-sheet").on.cancel({ preventDefault() {} });
    expect(document.activeElement).toBe(byId(el, "repos-twin-pause"));
    click(byId(el, "repos-twin-pause"));
    click(byId(bodyEl, "repos-twin-sheet-confirm"));
    await flush();
    expect(document.activeElement).toBe(byId(el, "repos-twin-pause"));
    expect(env.focusFallback).not.toHaveBeenCalled();
  });

  it("focus the person has moved on to is left alone", async () => {
    const other = new FakeEl("input");
    const { el } = await mount({ [`POST /api/v1/twins/${TWIN}/pause`]: item({ state: "paused" }) });
    click(byId(el, "repos-twin-pause"));
    click(byId(bodyEl, "repos-twin-sheet-confirm"));
    other.focus();
    await flush();
    expect(document.activeElement).toBe(other);
  });

  it("a long install list shows its first 50 paths and says how many more, not thousands of items", async () => {
    const install = Array.from({ length: 5000 }, (_, i) => "tools/f" + i + ".sh");
    const { el } = await mount({ [`GET /api/v1/twins/${TWIN}/paths`]: PATHS({ install_paths: install }) });
    const items = findAll(byId(el, "repos-twin-fixed"), (e) => e.tag === "li");
    expect(items.length).toBeLessThan(60);
    expect(text(byId(el, "repos-twin-fixed-more"))).toBe("and " + (5000 - 50) + " more");
    expect(text(byId(el, "repos-twin-fixed")).includes("tools/f49.sh")).toBe(true);
    expect(text(byId(el, "repos-twin-fixed")).includes("tools/f50.sh")).toBe(false);
    expect(text(el)).toContain("Always private (" + (1 + 1 + 5000) + ")");
  });

  it("Remove everything opens the repo's own removal sheet for the private repo, and the twin ends after that removal was sent, once", async () => {
    const { el, card, env, call } = await mount({ [`DELETE /api/v1/twins/${TWIN}`]: item({ state: "removed" }) });
    expect(text(byId(el, "repos-twin-remove"))).toBe(REMOVE_EVERYTHING);
    click(byId(el, "repos-twin-remove"));
    expect(env.removeRepo).toHaveBeenCalledTimes(1);
    expect(env.removeRepo.mock.calls[0][0]).toBe(REPOS[1]);
    await card.stopAfterRemoval();
    await card.stopAfterRemoval();
    expect(call.log.filter((l) => l[0] === "DELETE").length).toBe(1);
    expect(env.onChanged).toHaveBeenCalled();
  });

  it("the Private paths editor shows the person's lists and the read-only ones; narrowing warns on the first Save and sends on the second", async () => {
    const { el, call } = await mount({ [`PUT /api/v1/twins/${TWIN}/paths`]: PATHS({ revision: "r2", overlay_globs: ["notes/**"] }) });
    expect(byId(el, "repos-twin-overlay").value).toBe("internal/**\nnotes/**");
    const fixed = text(byId(el, "repos-twin-fixed"));
    for (const p of [".env", "tools/x.sh", ".autonomous-team/ids.txt"]) expect(fixed).toContain(p);
    byId(el, "repos-twin-overlay").value = "notes/**";
    click(byId(el, "repos-twin-paths-save"));
    await flush();
    expect(text(byId(el, "repos-twin-paths-warn"))).toContain("Removing 1 path");
    expect(call.log.some((l) => l[0] === "PUT")).toBe(false);
    expect(byId(el, "repos-twin-overlay").value).toBe("notes/**"); // what was typed is still there after the warning
    click(byId(el, "repos-twin-paths-save"));
    await flush();
    expect(call.log.filter((l) => l[0] === "PUT")[0][2]).toEqual({ revision: "r1", overlay_globs: ["notes/**"], binary_globs: [] });
  });

  it("editing the list takes the stale warning and its 'Save and publish those files' label away at once, leaving the box being typed in", async () => {
    const { el } = await mount({});
    const box = byId(el, "repos-twin-overlay");
    box.value = "notes/**";
    click(byId(el, "repos-twin-paths-save"));
    await flush();
    expect(byId(el, "repos-twin-paths-warn")).toBeTruthy();
    expect(text(byId(el, "repos-twin-paths-save"))).toBe("Save and publish those files");
    const typing = byId(el, "repos-twin-overlay");
    typing.value = "internal/**\nnotes/**";
    typing.on.input();
    expect(byId(el, "repos-twin-paths-warn")).toBeUndefined();
    expect(text(byId(el, "repos-twin-paths-save"))).toBe("Save");
    expect(byId(el, "repos-twin-overlay")).toBe(typing);
  });

  it("a re-read of the repo list never paints over text the person is typing", async () => {
    const { el, card } = await mount({});
    byId(el, "repos-twin-overlay").value = "typed/**";
    const box = byId(el, "repos-twin-overlay");
    card.repaint();
    expect(byId(el, "repos-twin-overlay")).toBe(box);
    box.value = "internal/**\nnotes/**";
    card.repaint();
    expect(byId(el, "repos-twin-overlay")).not.toBe(box);
  });
});

// ── Ruling 111 / 119.6 / 119.7, FU-319, FU-319b and FU-297: Merge, Check again, the counts, the refused twin and the note, and the plan choice after a reload ──
describe("the twin's counts, refusal and note (words)", () => {
  const lines = (over, pub = "acme/site") => twinDetail(item(over), "acme", pub).twin.lines;
  const ids = (over) => twinDetail(item(over), "acme", "acme/site").twin.actions.map((a) => a.id);

  it("the counts are merged_count and new_changes_count, singular at one, and null says 'not checked yet' instead of showing zero", () => {
    expect(lines({ merged_count: 3, new_changes_count: 2 })).toEqual(expect.arrayContaining(["Waiting to publish: 3 merged changes", "acme/site has 2 new changes"]));
    expect(lines({ merged_count: 1, new_changes_count: 1 })).toEqual(expect.arrayContaining(["Waiting to publish: 1 merged change", "acme/site has 1 new change"]));
    expect(lines({ merged_count: 0, new_changes_count: 0 })).toEqual(expect.arrayContaining(["Waiting to publish: 0 merged changes", "acme/site has 0 new changes"]));
    expect(lines({})).toEqual(expect.arrayContaining(["Waiting to publish: not checked yet", "New changes on acme/site: not checked yet"]));
    for (const bad of [-1, 1.5, "3", NaN]) expect(lines({ merged_count: bad, new_changes_count: bad }).join("|")).toMatch(/not checked yet.*not checked yet/);
    expect(lines({ merged_count: 3 }).join("|")).not.toMatch(/\b(null|undefined|NaN)\b/);
  });

  it("an open sync pull request carries the count in its sentence; an open publish pull request replaces the waiting line", () => {
    expect(lines({ sync_pr: 9, new_changes_count: 2 })).toContain("acme/site has 2 new changes: bringing them in (PR #9 on the private repo)");
    expect(lines({ publish_pr: 7, merged_count: 3 })).toContain("Publish PR #7 is open: merge it on GitHub");
    expect(lines({ publish_pr: 7, merged_count: 3 }).join("|")).not.toContain("Waiting to publish");
  });

  it("only a twin that has been copied and is not stopped has counts, and readTwin keeps them only when they are counts", () => {
    for (const state of ["creating", "not_connected", "seeding", "failed", "refused", "removed"]) expect(lines({ state, merged_count: 3 }).join("|"), state).not.toMatch(/Waiting to publish|new change/);
    expect(readTwin({ twin: item({ merged_count: 3, new_changes_count: 0 }) })).toMatchObject({ merged_count: 3, new_changes_count: 0 });
    expect(readTwin({ twin: item({ merged_count: -2, new_changes_count: "x" }) })).toMatchObject({ merged_count: null, new_changes_count: null });
  });

  it("Merge is offered with an open publish pull request in a ready, paused or conflicting twin; the sync pull request has none; Check again is for ready and conflict only", () => {
    for (const state of ["ready", "paused", "conflict"]) expect(ids({ state, publish_pr: 7 }), state).toContain("merge");
    expect(twinDetail(item({ publish_pr: 7 }), "acme").twin.actions.find((a) => a.id === "merge").label).toBe("Merge publish PR #7");
    expect(ids({ publish_pr: null })).not.toContain("merge");
    expect(ids({ sync_pr: 9, publish_pr: null })).not.toContain("merge");
    for (const state of ["creating", "not_connected", "seeding", "refused", "failed", "removed"]) expect(ids({ state, publish_pr: 7 }), state).not.toContain("merge");
    for (const state of ["ready", "conflict"]) expect(ids({ state }), state).toContain("check");
    for (const state of ["paused", "creating", "not_connected", "seeding", "refused", "failed", "removed"]) expect(ids({ state }), state).not.toContain("check");
  });

  it("a twin refused because its private repo is public says how to come back (private again, then Pause and Resume); another refusal keeps its own sentence", () => {
    expect(TWIN_NOT_PRIVATE).toMatch(/private again/);
    expect(TWIN_NOT_PRIVATE).toMatch(/Pause and Resume/);
    expect(lines({ state: "refused", failure_code: "twin_not_private" })[0]).toBe(TWIN_NOT_PRIVATE);
    expect(lines({ state: "refused", failure_code: null })[0]).toMatch(/held back/);
    expect(lines({ state: "ready", failure_code: "twin_not_private" })[0]).not.toBe(TWIN_NOT_PRIVATE);
    expect(readTwin({ twin: item({ state: "refused", failure_code: "twin_not_private" }) }).failure_code).toBe("twin_not_private");
    expect(readTwin({ twin: item({ state: "failed", failure_code: "something_internal" }) }).failure_code).toBeNull();
    expect(twinRefusal(fail(409, "twin_not_private"))).toBe(TWIN_NOT_PRIVATE);
  });

  it("a public repo that turned private adds one note line and keeps the twin working; no other note word shows", () => {
    expect(lines({ note: "public_repo_private" }).filter((l) => /public repo is private now/.test(l))).toHaveLength(1);
    expect(lines({ note: null }).join("|")).not.toMatch(/is private now/);
    expect(readTwin({ twin: item({ note: "public_repo_private" }) }).note).toBe("public_repo_private");
    expect(readTwin({ twin: item({ note: "anything else" }) }).note).toBeNull();
    expect(lines({ state: "removed", note: "public_repo_private" }).join("|")).not.toMatch(/is private now/);
  });

  it("the merge refusals are fixed sentences by code, each its own", () => {
    for (const code of ["twin_no_pr", "twin_pr_changed", "twin_pr_blocked"]) expect(twinRefusal(fail(409, code)), code).not.toMatch(/server text|undefined|null|_/);
    expect(twinRefusal(fail(409, "twin_no_pr"))).toMatch(/isn't open any more/);
    expect(twinRefusal(fail(409, "twin_pr_changed"))).toMatch(/closed or changed on GitHub/);
    expect(twinRefusal(fail(409, "twin_pr_blocked"))).toMatch(/GitHub will not merge this yet/);
  });
});

describe("Merge and Check again on the Repos twin card", () => {
  const REPOS = [{ id: PUB, full_name: "acme/site" }, { id: PRIV, full_name: "acme/site-private" }];
  const mount = async (twin, routes, over = {}) => {
    const cur = { row: twin };
    const call = fakeCall({ [`GET /api/v1/repos/${PRIV}/twin`]: () => ({ twin: cur.row }), [`GET /api/v1/twins/${TWIN}/paths`]: PATHS(), ...routes });
    const env = { repoId: PRIV, call, getRepo: (id) => REPOS.find((r) => r.id === id), canChange: () => true, removeRepo: vi.fn(), onChanged: vi.fn(), announce: vi.fn(), focusFallback: vi.fn(), doc: focusDoc, ...over };
    const card = createTwinCard(env);
    await card.load();
    return { card, call, env, el: card.el, cur };
  };
  const posts = (call) => call.log.filter((l) => l[0] !== "GET");
  const twinReads = (call) => call.log.filter((l) => l[0] === "GET" && l[1].endsWith("/twin")).length;

  it("Merge is on the publish line only: one POST with pr 'publish', then the twin is read again and the line follows", async () => {
    const { el, call, env, cur } = await mount(item({ publish_pr: 7, merged_count: 3 }), { [`POST /api/v1/twins/${TWIN}/merge`]: { merged: true, already: false, pr: 7 } });
    expect(text(byId(el, "repos-twin-merge"))).toBe("Merge publish PR #7");
    expect(allById(el, "repos-twin-merge")).toHaveLength(1);
    cur.row = item({ publish_pr: null, merged_count: 0 });
    click(byId(el, "repos-twin-merge"));
    await flush();
    expect(posts(call)).toEqual([["POST", `/api/v1/twins/${TWIN}/merge`, { pr: "publish" }]]);
    expect(env.announce).toHaveBeenCalledWith("Merged.");
    expect(env.onChanged).toHaveBeenCalledTimes(1);
    expect(byId(el, "repos-twin-merge")).toBeUndefined();
    expect(allById(el, "repos-twin-line").map(text)).toContain("Waiting to publish: 0 merged changes");
  });

  it("there is no Merge for an open sync pull request alone (the engine merges that one), and a member sees neither button", async () => {
    const sync = await mount(item({ sync_pr: 9, new_changes_count: 1 }), {});
    expect(byId(sync.el, "repos-twin-merge")).toBeUndefined();
    expect(allById(sync.el, "repos-twin-line").map(text)).toContain("acme/site has 1 new change: bringing them in (PR #9 on the private repo)");
    const member = await mount(item({ publish_pr: 7 }), {}, { canChange: () => false });
    expect(byId(member.el, "repos-twin-merge")).toBeUndefined();
    expect(byId(member.el, "repos-twin-check")).toBeUndefined();
  });

  it("each 409 of the merge route is its own fixed sentence, shown on the card, with the twin read again", async () => {
    for (const code of ["twin_pr_changed", "twin_pr_blocked", "twin_no_pr"]) {
      const m = await mount(item({ publish_pr: 7 }), { [`POST /api/v1/twins/${TWIN}/merge`]: fail(409, code) });
      const reads = twinReads(m.call);
      click(byId(m.el, "repos-twin-merge"));
      await flush();
      expect(text(byId(m.el, "repos-twin-error")), code).toBe(twinRefusal({ code }));
      expect(twinReads(m.call), code).toBe(reads + 1);
      expect(m.env.announce).not.toHaveBeenCalledWith("Merged.");
      expect(m.env.onChanged).not.toHaveBeenCalled();
    }
  });

  it("Check again is one POST with no body, answers with the twin as it reads now, and says the counts follow", async () => {
    const m = await mount(item({ merged_count: null }), { [`POST /api/v1/twins/${TWIN}/check`]: item({ merged_count: 2, new_changes_count: 0 }) });
    expect(allById(m.el, "repos-twin-line").map(text)).toContain("Waiting to publish: not checked yet");
    click(byId(m.el, "repos-twin-check"));
    await flush();
    expect(posts(m.call)).toEqual([["POST", `/api/v1/twins/${TWIN}/check`, undefined]]);
    expect(m.env.announce).toHaveBeenCalledWith("Checking again. The counts follow within a minute or two.");
    expect(allById(m.el, "repos-twin-line").map(text)).toContain("Waiting to publish: 2 merged changes");
  });

  it("Check again is drawn for a ready or conflicting twin only, and a twin that moved on is a sentence and a re-read", async () => {
    for (const state of ["paused", "refused", "failed"]) expect(byId((await mount(item({ state }), {})).el, "repos-twin-check"), state).toBeUndefined();
    expect(byId((await mount(item({ state: "conflict" }), {})).el, "repos-twin-check")).toBeTruthy();
    const m = await mount(item(), { [`POST /api/v1/twins/${TWIN}/check`]: fail(409, "twin_state") });
    m.cur.row = item({ state: "refused" });
    click(byId(m.el, "repos-twin-check"));
    await flush();
    expect(text(byId(m.el, "repos-twin-error"))).toBe(twinRefusal({ code: "twin_state" }));
    expect(byId(m.el, "repos-twin-check")).toBeUndefined();
  });

  it("a refused twin shows the way back, and Pause is there to start it", async () => {
    const m = await mount(item({ state: "refused", failure_code: "twin_not_private" }), {});
    expect(text(allById(m.el, "repos-twin-line")[0])).toBe(TWIN_NOT_PRIVATE);
    expect(byId(m.el, "repos-twin-pause")).toBeTruthy();
    expect(byId(m.el, "repos-twin-merge")).toBeUndefined();
  });

  it("the public repo's note is one line of the card", async () => {
    const m = await mount(item({ note: "public_repo_private" }), {});
    expect(allById(m.el, "repos-twin-line").map(text).filter((t) => /public repo is private now/.test(t))).toHaveLength(1);
  });
});

describe("the twin's plan choice survives a reload (FU-297)", () => {
  const SETUP_ROW = { id: SETUP, repo_id: PRIV };
  const mountChoice = async (state) => {
    const host = new FakeEl("div");
    const call = fakeCall({ [`GET /api/v1/repos/${PRIV}/twin`]: { twin: item({ state }) }, [`POST /api/v1/twins/${TWIN}/adopt-plan`]: { adopted: true, draft_id: "d", reason: null } });
    mountTwinPlanChoice(host, { setup: SETUP_ROW, call, announce: vi.fn() });
    await flush();
    return { host, call };
  };

  it("with no placing click at all, the setup's own repository is read and its plan choice is drawn; the call carries the setup's id", async () => {
    const { host, call } = await mountChoice("ready");
    expect(call.log[0]).toEqual(["GET", `/api/v1/repos/${PRIV}/twin`, undefined]);
    expect(text(byId(host, "ob-twin-adopt"))).toBe("Use my approved plan");
    click(byId(host, "ob-twin-adopt"));
    await flush();
    expect(call.log.filter((l) => l[0] === "POST")).toEqual([["POST", `/api/v1/twins/${TWIN}/adopt-plan`, { setup_id: SETUP }]]);
  });

  it("a repo with no twin (or twins off) draws nothing, and a twin that is not ready offers no plan", async () => {
    for (const answer of [{ twin: null }, fail(503, "not_configured")]) {
      const host = new FakeEl("div");
      mountTwinPlanChoice(host, { setup: SETUP_ROW, call: fakeCall({ [`GET /api/v1/repos/${PRIV}/twin`]: answer }), announce: vi.fn() });
      await flush();
      expect(host.kids).toEqual([]);
    }
    expect(byId((await mountChoice("seeding")).host, "ob-twin-adopt")).toBeUndefined();
  });
});

// ── Ruling 124 (ON-27f): "Issues on the public repo" and Bring into private repo ──
describe("the twin card's public issues and Bring into private repo", () => {
  const REPOS = [{ id: PUB, full_name: "acme/site" }, { id: PRIV, full_name: "acme/site-private" }];
  const ISSUES = (over = {}) => ({ issues: [{ number: 12, title: "<b>Crash</b> on start", author: "stranger", brought_issue: null }, { number: 9, title: "Old one", author: "ann", brought_issue: 4 }], can_bring: true, ...over });
  const url = `/api/v1/twins/${TWIN}/issues`;
  const mount = async (routes, over = {}, row = item()) => {
    const call = fakeCall({ [`GET /api/v1/repos/${PRIV}/twin`]: () => ({ twin: row }), [`GET /api/v1/twins/${TWIN}/paths`]: PATHS(), [`GET ${url}`]: ISSUES(), ...routes });
    const env = { repoId: PRIV, call, getRepo: (id) => REPOS.find((r) => r.id === id), canChange: () => true, removeRepo: vi.fn(), onChanged: vi.fn(), announce: vi.fn(), focusFallback: vi.fn(), doc: focusDoc, ...over };
    const card = createTwinCard(env);
    await card.load();
    return { card, call, env, el: card.el };
  };
  const posts = (call) => call.log.filter((l) => l[0] === "POST");

  it("lists the open issues as text (a title is never markup); the button shows only with can_bring, and a brought one says 'Brought as #N'", async () => {
    const { el } = await mount({});
    expect(allById(el, "repos-twin-issue").map(text)).toEqual(["#12 <b>Crash</b> on start · strangerBring into private repo", "#9 Old one · annBrought as #4"]);
    expect(text(byId(el, "repos-twin-bring-12"))).toBe("Bring into private repo");
    expect(byId(el, "repos-twin-bring-9")).toBeUndefined();
    const member = await mount({ [`GET ${url}`]: ISSUES({ can_bring: false }) });
    expect(allById(member.el, "repos-twin-issue")).toHaveLength(2);
    expect(allById(member.el, "repos-twin-bring-12")).toHaveLength(0);
    const noAdmin = await mount({}, { canChange: () => false });
    expect(byId(noAdmin.el, "repos-twin-bring-12")).toBeUndefined();
  });

  it("one click is one POST for that issue; the answer is 'Brought as #N', announced, and the button is gone", async () => {
    const { el, call, env } = await mount({ [`POST ${url}/12/bring`]: { private_issue: 31, already: false } });
    click(byId(el, "repos-twin-bring-12"));
    await flush();
    expect(posts(call)).toEqual([["POST", `${url}/12/bring`, undefined]]);
    expect(text(byId(el, "repos-twin-brought-12"))).toBe("Brought as #31");
    expect(byId(el, "repos-twin-bring-12")).toBeUndefined();
    expect(env.announce).toHaveBeenCalledWith("Brought as #31.");
  });

  it("a second answer for an issue already brought says the same number; no list for a twin that is not live, none when the route is off", async () => {
    const { el } = await mount({ [`POST ${url}/12/bring`]: { private_issue: 4, already: true } });
    click(byId(el, "repos-twin-bring-12"));
    await flush();
    expect(text(byId(el, "repos-twin-brought-12"))).toBe("Brought as #4");
    for (const row of [item({ state: "refused" }), item({ state: "seeding" })]) {
      const m = await mount({}, {}, row);
      expect(byId(m.el, "repos-twin-issues"), row.state).toBeUndefined();
      expect(m.call.log.some((l) => l[1].endsWith("/issues")), row.state).toBe(false);
    }
    const off = await mount({ [`GET ${url}`]: fail(503, "not_configured") });
    expect(byId(off.el, "repos-twin-issues")).toBeUndefined();
    expect(byId(off.el, "repos-twin-issues-error")).toBeUndefined();
  });

  it("each refusal is its own fixed sentence and the list is read again where the issue changed", async () => {
    for (const [status, code, re] of [[409, "issue_not_open", /closed or is a pull request/], [409, "issue_bring_in_progress", /being brought in right now/], [409, "twin_not_private", /private again/], [503, "github_unavailable", /couldn't be reached/], [409, "twin_state", /state changed/]]) {
      const m = await mount({ [`POST ${url}/12/bring`]: fail(status, code) });
      const reads = m.call.log.filter((l) => l[1] === url).length;
      click(byId(m.el, "repos-twin-bring-12"));
      await flush();
      expect(text(byId(m.el, "repos-twin-error")), code).toMatch(re);
      expect(text(m.el), code).not.toContain("server text");
      if (code === "issue_not_open" || code === "twin_state") expect(m.call.log.filter((l) => l[1] === url).length, code).toBe(reads + 1);
      expect(byId(m.el, "repos-twin-bring-12"), code).toBeTruthy();
      expect(m.env.announce).not.toHaveBeenCalled();
    }
  });

  it("an unreadable list is a sentence with Try again, which reads it again", async () => {
    let fails = true;
    const m = await mount({ [`GET ${url}`]: () => (fails ? fail(503, "github_unavailable") : ISSUES()) });
    expect(text(byId(m.el, "repos-twin-issues-error"))).toMatch(/couldn't be read/);
    fails = false;
    click(byId(m.el, "repos-twin-issues-retry"));
    await flush();
    expect(allById(m.el, "repos-twin-issue")).toHaveLength(2);
  });

  it("malformed items are dropped, and no list at all reads 'No open issues.'", async () => {
    const m = await mount({ [`GET ${url}`]: { issues: [{ number: 0, title: "x", author: "a", brought_issue: null }, { number: 3, title: 7, author: "a", brought_issue: null }, null], can_bring: true } });
    expect(allById(m.el, "repos-twin-issue")).toHaveLength(0);
    expect(text(byId(m.el, "repos-twin-issues-none"))).toBe("No open issues.");
    expect(text(m.el)).not.toMatch(/\b(null|undefined|NaN)\b/);
  });
});

// ── review fixes: a removal ends the twin only when the sheet confirmed it and it came from "Remove everything" ──
describe("when a removal ends the private twin too", () => {
  const REMOVE = `/api/runners/repos/${PRIV}/remove`;
  const flowWith = (routes) => {
    const seen = [];
    const call = fakeCall({ [`GET /api/v1/machine-servers?repo_id=${PRIV}`]: { servers: [] }, ...routes });
    const flow = createRemoveFlow({ call, onDone: (ok, d) => seen.push({ ok, ends: endsTwinAfter(ok, d) }) });
    return { flow, seen, call };
  };
  const repo = { id: PRIV, full_name: "acme/site-private" };

  it("a confirmed removal from Remove everything ends the twin, and the sheet says so before it is confirmed", async () => {
    const { flow, seen } = flowWith({ [`POST ${REMOVE}`]: { machine_parts: "none", already_removed: false } });
    flow.begin(repo, { twin: true });
    expect(flow.state.endsTwin).toBe(true);
    await flow.confirm();
    expect(seen).toEqual([{ ok: true, ends: true }]);
    expect(TWIN_ENDS_LINE).toMatch(/private repo stays on GitHub/);
  });

  it("the plain Remove from fulcrumaxe button never ends the twin, even when the removal is confirmed", async () => {
    const { flow, seen } = flowWith({ [`POST ${REMOVE}`]: { machine_parts: "none", already_removed: false } });
    flow.begin(repo);
    await flow.confirm();
    expect(seen).toEqual([{ ok: true, ends: false }]);
  });

  it("an unreadable answer and a 404 never end the twin, whatever opened the sheet", async () => {
    const odd = flowWith({ [`POST ${REMOVE}`]: { surprise: true } });
    odd.flow.begin(repo, { twin: true });
    await odd.flow.confirm();
    expect(odd.seen).toEqual([{ ok: false, ends: false }]);
    expect(odd.flow.state.phase).toBe("error");
    const gone = flowWith({ [`POST ${REMOVE}`]: fail(404, "not_found") });
    gone.flow.begin(repo, { twin: true });
    await gone.flow.confirm();
    expect(gone.seen).toEqual([{ ok: false, ends: false }]);
    const refused = flowWith({ [`POST ${REMOVE}`]: fail(500, "boom") });
    refused.flow.begin(repo, { twin: true });
    await refused.flow.confirm();
    expect(refused.seen).toEqual([]); // a refusal reports nothing done
    expect(endsTwinAfter(undefined, { endsTwin: true })).toBe(false);
    expect(endsTwinAfter(true, null)).toBe(false);
  });
});

describe("hardening from review", () => {
  it("the issues list is cut at 50 on the client", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ number: i + 1, title: "t" + i, author: "a", brought_issue: null }));
    const call = fakeCall({ [`GET /api/v1/repos/${PRIV}/twin`]: { twin: item() }, [`GET /api/v1/twins/${TWIN}/paths`]: PATHS(), [`GET /api/v1/twins/${TWIN}/issues`]: { issues: many, can_bring: true } });
    const ctl = createTwinController({ call, repoId: PRIV });
    await ctl.load();
    await ctl.loadIssues();
    expect(ctl.state.issues.list).toHaveLength(50);
  });

  it("the offer's error is an alert, and the already-exists answers are announced", async () => {
    const host = new FakeEl("div");
    const env = { repo: { id: PUB, name: "acme/site", visibility: "public" }, announce: vi.fn(), redraw: vi.fn(), call: fakeCall({ [`GET /api/v1/repos/${PUB}/twin`]: { twin: null }, [`POST /api/v1/repos/${PUB}/twin`]: fail(409, "twin_exists") }) };
    mountTwinOffer(host, env);
    await flush();
    click(byId(host, "ob-twin-make"));
    click(byId(host, "ob-twin-continue"));
    await flush();
    expect(env.announce).toHaveBeenCalledWith(twinRefusal({ code: "twin_exists" }));
    const bad = new FakeEl("div");
    mountTwinOffer(bad, { ...env, announce: vi.fn(), call: fakeCall({ [`GET /api/v1/repos/${PUB}/twin`]: { twin: null }, [`POST /api/v1/repos/${PUB}/twin`]: fail(500, "boom") }) });
    await flush();
    click(byId(bad, "ob-twin-make"));
    click(byId(bad, "ob-twin-continue"));
    await flush();
    expect(byId(bad, "ob-twin-error").getAttribute("role")).toBe("alert");
  });
});
