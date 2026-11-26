// apps/workspace/e2e/onboarding-picker.spec.ts
//
// D#845 ON-7b: the project step's picker and confirm, on the built cloud dist behind fixture-server.mjs. Every API answer here is a page.route() mock shaped like the real route's
// (the picker, runners, machines, engine settings, place, create-intent); no request leaves the page for GitHub. Desktop, tablet and phone all run every test.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";
import { engineTrack, withEngine } from "./helpers/onboarding-body";

const DIR = dirname(fileURLToPath(import.meta.url));
const fx = (...p: string[]) => JSON.parse(readFileSync(join(DIR, "..", "..", "..", "packages", "api", "fixtures", "v1", ...p), "utf8"));
const PLANS = JSON.parse(readFileSync(join(DIR, "plans-fixture.json"), "utf8"));
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const PLACEHOLDER = /\b(null|undefined|nan)\b/i;
const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";
const R3 = "33333333-3333-4333-8333-333333333333";
const R4 = "44444444-4444-4444-8444-444444444444";
const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const M2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PUBLIC = "Anyone can open issues on a public repo, and the engine reads them. The engine starts work only from collaborators' items.";

type Json = Record<string, unknown>;
const err = (status: number, code: string) => ({ status, json: { error: { code, message: "SERVER WORDS", request_id: "r" } } });
interface Mock {
  admin: boolean; picker: Json | { status: number; json: unknown }; settings: Json | null; machines: Json[]; runners: Json[]; place: { status: number; json: unknown };
  intent: { status: number; json: unknown }; places: { path: string; body: unknown }[]; intents: unknown[]; requests: string[]; settingsReads: number;
  /** Answers handed out one per place call before `place` is used. */
  placeSeq: { status: number; json: unknown }[];
}
const REPOS = [
  { id: R1, name: "acme/api", visibility: "private", active_preset: "balanced" },
  { id: R2, name: "acme/site", visibility: "public", active_preset: null },
  { id: R3, name: "acme/mystery", visibility: "unknown", active_preset: "cautious" },
];
const RUNNER = (id: string, name: string, over: Json = {}) => ({ id, name, state: "online_idle", last_seen_at: new Date().toISOString(), facts: { engine: "microvm" }, linked_at: "2026-11-20T10:00:00.000Z", linked_from_ip: "203.0.113.9", repos: [], ...over });
const mock = (o: Partial<Mock> = {}): Mock => ({
  admin: true,
  picker: { repos: REPOS, owners: [{ gh_id: 77, login: "acme-org" }] },
  settings: { watch_enabled: true, operate_enabled: false, can_edit: true, repos: [] },
  runners: [RUNNER(M1, "build-box-1")], machines: [{ id: M1, name: "build-box-1", tier: "microvm", live: true, running: null }],
  place: { status: 201, json: { setup_id: R4, repo_id: R1, runner_id: M1, kind: "existing", phase: "survey", operate_enabled: false } },
  intent: { status: 200, json: { authorize_url: "https://github.com/login/oauth/authorize?state=x" } },
  places: [], intents: [], requests: [], settingsReads: 0, placeSeq: [], ...o,
});

async function setup(page: Page, m: Mock) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) m.requests.push(`${r.method()} ${u.pathname}`); });
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), workspace_access: "no_subscription", is_admin: m.admin } });
  });
  const body = withEngine(fx("getOnboarding", "200-new.json"), engineTrack({ machine: "done", claude: "done", github_app: "done", project: "active" }, { tier: "microvm" }));
  await page.route((u) => u.pathname === "/api/v1/onboarding", (route) => route.fulfill({ json: body }));
  await page.route("**/api/plans", (route) => route.fulfill({ json: { ...PLANS, plans: PLANS.plans, viewer: { is_owner: true, partner_billed: false } } }));
  await page.route((u) => u.pathname === "/api/runners", (route) => route.fulfill({ json: { runners: m.runners } }));
  await page.route((u) => u.pathname === "/api/machines", (route) => route.fulfill({ json: { machines: m.machines } }));
  await page.route((u) => u.pathname === "/api/v1/engine/settings", (route) => { m.settingsReads++; return route.fulfill(m.settings ? { json: m.settings } : err(500, "boom")); });
  await page.route((u) => u.pathname === "/api/runners/repos/picker", (route) => route.fulfill("status" in m.picker ? { status: (m.picker as { status: number }).status, json: (m.picker as { json: unknown }).json } : { json: m.picker }));
  await page.route((u) => /^\/api\/runners\/repos\/[^/]+\/place$/.test(u.pathname), (route) => {
    m.places.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return route.fulfill(m.placeSeq.shift() ?? m.place);
  });
  await page.route((u) => u.pathname === "/api/v1/repos/create-intent", (route) => { m.intents.push(route.request().postDataJSON()); return route.fulfill(m.intent); });
  await page.route((u) => u.pathname === "/api/v1/github/install-url", (route) => route.fulfill({ json: { url: "https://github.com/apps/fulcrumaxe-team/installations/new?state=s" } }));
  await page.route("https://github.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>github</title>" }));
  return problems;
}
const ob = (page: Page) => page.locator('.fulc-window[data-app-id="onboarding"]');
const tid = (page: Page, id: string) => ob(page).locator(`[data-testid="ob-pick-${id}"]`);
const picker = (page: Page) => ob(page).locator('[data-testid="ob-picker"]');
const boot = async (page: Page, m: Mock, url = "/") => { const problems = await setup(page, m); await bootToDesktop(page, { url }); return problems; };
const noOverflow = async (page: Page) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await ob(page).locator('[data-testid="ob-app"]').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
};
const clean = async (page: Page) => expect(await picker(page).innerText()).not.toMatch(PLACEHOLDER);
const pickRepo = (page: Page, id: string) => ob(page).locator(`[data-testid="ob-pick-repo"][data-repo="${id}"]`).click();

test.describe("the project picker and confirm (D#845 ON-7b)", () => {
  test("lists every repo with Public, Private or Couldn't check, and a create button; nothing is sent until Confirm", async ({ page }) => {
    const m = mock();
    const problems = await boot(page, m);
    const repos = ob(page).locator('[data-testid="ob-pick-repo"]');
    await expect(repos).toHaveCount(3);
    await expect(repos).toHaveText(["acme/api · Private", "acme/site · Public", "acme/mystery · Couldn't check"]);
    await expect(tid(page, "create")).toBeVisible();
    await noOverflow(page);
    await clean(page);
    expect(m.places).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("an empty list and a failed read each say so, and the failed read has Try again", async ({ page }) => {
    const m = mock({ picker: { repos: [], owners: [] } });
    await boot(page, m);
    await expect(tid(page, "empty")).toHaveText("You have no repos yet. Create a new project.");
    const bad = mock({ picker: { status: 500, json: { error: { code: "boom", message: "x", request_id: "r" } } } });
    const page2 = await page.context().newPage();
    await boot(page2, bad);
    await expect(tid(page2, "load-failed")).toHaveText("Your repos couldn't be loaded.");
    await expect(tid(page2, "retry")).toBeVisible();
  });

  test("a private repo's confirm shows its preset, the machine with its link line, and places with exactly the chosen machine", async ({ page }) => {
    const m = mock();
    await boot(page, m);
    await pickRepo(page, R1);
    await expect(tid(page, "dials")).toHaveText("Dials: Balanced");
    await expect(tid(page, "linked")).toHaveText("Linked 2026-11-20 from 203.0.113.9");
    await expect(tid(page, "public")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/country/i);
    await noOverflow(page);
    await clean(page);
    await tid(page, "confirm").click();
    await expect(tid(page, "placed")).toContainText("Placed acme/api");
    expect(m.places).toEqual([{ path: `/api/runners/repos/${R1}/place`, body: { kind: "existing", runner_id: M1 } }]);
  });

  test("a public repo shows the public copy; Custom shows for a hand-moved dial; an unreadable one is still choosable", async ({ page }) => {
    const m = mock();
    await boot(page, m);
    await pickRepo(page, R2);
    await expect(tid(page, "public")).toHaveText(PUBLIC);
    await expect(tid(page, "dials")).toHaveText("Dials: Custom");
    await tid(page, "change").click();
    await pickRepo(page, R3);
    await expect(tid(page, "vis-line")).toHaveText("Couldn't check");
    await expect(tid(page, "dials")).toHaveText("Dials: Cautious");
  });

  test("operate consent: off with other ticked repos names them, ticking sends the exact list, and leaving it unticked sends nothing", async ({ page }) => {
    const settings = { watch_enabled: true, operate_enabled: false, can_edit: true, repos: [
      { repo_id: R1, full_name: "acme/api", enabled: true }, { repo_id: R3, full_name: "acme/mystery", enabled: true }, { repo_id: R2, full_name: "acme/site", enabled: false }] };
    const m = mock({ settings });
    await boot(page, m);
    await pickRepo(page, R1);
    await expect(tid(page, "operate")).toContainText("Turn on operate for this account. This also operates 1 other repo: acme/mystery");
    await tid(page, "confirm").click();
    await expect(tid(page, "placed")).toBeVisible();
    expect(m.places[0].body).toEqual({ kind: "existing", runner_id: M1 });
    // A second run on a fresh page, ticked.
    const m2 = mock({ settings });
    const page2 = await page.context().newPage();
    await boot(page2, m2);
    await pickRepo(page2, R1);
    await ob(page2).locator('[data-testid="ob-pick-operate"] input[type="checkbox"]').check();
    await tid(page2, "confirm").click();
    await expect(tid(page2, "placed")).toBeVisible();
    expect(m2.places[0].body).toEqual({ kind: "existing", runner_id: M1, turn_on_operate: true, operate_others: [R3] });
  });

  test("operate already on says so with no box; a public repo's box is off with the pending sentence", async ({ page }) => {
    const m = mock({ settings: { watch_enabled: true, operate_enabled: true, can_edit: true, repos: [] } });
    await boot(page, m);
    await pickRepo(page, R1);
    await expect(tid(page, "operate-on")).toContainText("already on");
    await expect(ob(page).locator('[data-testid="ob-pick-operate"] input')).toHaveCount(0);
    const off = mock();
    const page2 = await page.context().newPage();
    await boot(page2, off);
    await pickRepo(page2, R2);
    await expect(ob(page2).locator('[data-testid="ob-pick-operate"] input[type="checkbox"]')).toBeDisabled();
    await expect(tid(page2, "operate")).toContainText("Operate isn't available for public repos yet.");
  });

  test("a machine that cannot take the project is greyed with its reason, and with none eligible Confirm is off and Add a machine shows", async ({ page }) => {
    const m = mock({
      runners: [RUNNER(M1, "std-box", { facts: { engine: "os_sandbox" } }), RUNNER(M2, "sleepy", { state: "offline", linked_at: null, linked_from_ip: null })],
      machines: [{ id: M1, tier: "standard", live: true, running: { repo_id: R4, name: "acme/other" } }, { id: M2, tier: "microvm", live: false, running: null }],
    });
    await boot(page, m);
    await pickRepo(page, R1);
    await expect(ob(page).locator('[data-testid="ob-pick-machine"]').first()).toContainText("Standard isolation hosts one project");
    await expect(ob(page).locator('[data-testid="ob-pick-machine"]').nth(1)).toContainText("Offline");
    await expect(tid(page, "no-eligible")).toHaveText("Every machine is full or offline");
    await expect(tid(page, "confirm")).toBeDisabled();
    expect(m.places).toEqual([]);
  });

  const REFUSALS: Array<[number, string, RegExp]> = [
    [403, "forbidden", /Only an owner or admin can place a project\./],
    [404, "not_found", /That repo wasn't found/],
    [400, "invalid_message", /That request wasn't accepted/],
    [409, "setup_exists", /This repo is already being set up\./],
    [409, "account_not_active", /This account isn't active/],
    [409, "repo_visibility_unknown", /GitHub didn't say whether acme\/api is public or private\. Try again in a minute\./],
    [409, "project_already_placed", /already placed on a machine/],
    [409, "machine_single_project", /Standard isolation hosts one project/],
    [409, "machine_not_eligible", /That machine can't take a project right now/],
    [409, "no_eligible_machine", /Every machine is full or offline/],
    [409, "operate_consent_stale", /have changed/],
    [409, "operate_public_pending", /Operate isn't available for public repos yet/],
    [409, "placement_busy", /busy with another change/],
  ];
  for (const [status, code, text] of REFUSALS) {
    test(`a ${status} ${code} shows its own sentence, never the server's words, and leaves the confirm open to try again`, async ({ page }) => {
      const m = mock({ place: err(status, code) });
      await boot(page, m);
      await pickRepo(page, R1);
      await tid(page, "confirm").click();
      await expect(tid(page, "error")).toContainText(text);
      await expect(tid(page, "error")).not.toContainText("SERVER WORDS");
      await expect(tid(page, "placed")).toHaveCount(0);
      await expect(tid(page, "confirm")).toBeVisible();
      if (code === "setup_exists") await expect(tid(page, "see-setup")).toBeVisible();
      await clean(page);
      await noOverflow(page);
    });
  }

  const REASONS: Array<[string, RegExp]> = [
    ["not_live", /That machine is offline/],
    ["paused", /That machine is paused/],
    ["draining", /finishing its work and takes nothing new/],
    ["claude_not_ready", /Claude isn't signed in on that machine/],
    ["low_memory", /less than 4 GB of free memory/],
    ["low_disk", /less than 10 GB of free disk/],
    ["server_deleting", /That server is being deleted/],
  ];
  for (const [reason, text] of REASONS) {
    test(`a machine_not_eligible refusal for ${reason} says why, in the app's own words, and leaves the confirm open`, async ({ page }) => {
      const m = mock({ place: { status: 409, json: { error: { code: "machine_not_eligible", message: "SERVER WORDS", request_id: "r" }, reason } } });
      await boot(page, m);
      await pickRepo(page, R1);
      await tid(page, "confirm").click();
      await expect(tid(page, "error")).toContainText(text);
      await expect(tid(page, "error")).not.toContainText("SERVER WORDS");
      await expect(tid(page, "confirm")).toBeVisible();
      expect(m.places).toHaveLength(1);
      await clean(page);
    });
  }

  const UNKNOWN_LOAD = { status: 409, json: { error: { code: "machine_not_eligible", message: "SERVER WORDS", request_id: "r" }, reason: "load_unknown" } };

  test("a machine whose load is not known yet shows 'Checking the machine…', asks again by itself, and places once the machine has reported", async ({ page }) => {
    const m = mock({ placeSeq: [UNKNOWN_LOAD, UNKNOWN_LOAD] });
    await boot(page, m);
    await page.clock.install();
    await pickRepo(page, R1);
    await tid(page, "confirm").click();
    await expect(tid(page, "note")).toHaveText("Checking the machine…");
    await expect(tid(page, "confirm")).toHaveText("Checking the machine…");
    await expect(tid(page, "error")).toHaveCount(0);
    expect(m.places).toHaveLength(1);
    await page.clock.runFor(8100);
    await expect.poll(() => m.places.length).toBe(2);
    await page.clock.runFor(8100);
    await expect(tid(page, "placed")).toBeVisible();
    expect(m.places).toHaveLength(3);
    expect(m.places.every((p) => JSON.stringify(p.body) === JSON.stringify(m.places[0]!.body))).toBe(true);
    await clean(page);
  });

  test("a machine that never reports its load stops being asked after a few tries and then says so", async ({ page }) => {
    const m = mock({ place: UNKNOWN_LOAD });
    await boot(page, m);
    await page.clock.install();
    await pickRepo(page, R1);
    await tid(page, "confirm").click();
    for (let i = 0; i < 4; i++) {
      await expect.poll(() => m.places.length).toBe(i + 1);
      await page.clock.runFor(8100);
    }
    await expect(tid(page, "error")).toContainText("hasn't reported its free memory and disk yet");
    await expect(tid(page, "note")).toHaveCount(0);
    await expect(tid(page, "confirm")).toBeEnabled();
    expect(m.places).toHaveLength(5);
  });

  test("the machine list is read again when a repo is picked, so a machine that connected after the panel opened is not shown as Offline", async ({ page }) => {
    const m = mock({ runners: [RUNNER(M1, "build-box-1", { state: "offline" })], machines: [{ id: M1, name: "build-box-1", tier: "microvm", live: false, running: null }] });
    await boot(page, m);
    // The machine connects while the panel is open.
    m.runners = [RUNNER(M1, "build-box-1")];
    m.machines = [{ id: M1, name: "build-box-1", tier: "microvm", live: true, running: null }];
    await pickRepo(page, R1);
    const card = ob(page).locator('[data-testid="ob-pick-machine"]').first();
    await expect(card).not.toContainText("Offline");
    await expect(card.locator("input")).toBeEnabled();
    await expect(card.locator("input")).toBeChecked();
    await expect(tid(page, "confirm")).toBeEnabled();
    await expect(tid(page, "no-eligible")).toHaveCount(0);
    await noOverflow(page);
  });

  test("create new with one owner: the owner is preselected and create-intent is sent with it, then the browser goes to GitHub", async ({ page }) => {
    const m = mock();
    await boot(page, m);
    await tid(page, "create").click();
    await expect(tid(page, "owner")).toHaveText("Owner: acme-org");
    await tid(page, "name").fill("fresh-repo");
    await tid(page, "continue").click();
    await page.waitForURL("https://github.com/**");
    expect(m.intents).toEqual([{ owner_gh_id: 77, name: "fresh-repo", visibility: "private" }]);
  });

  test("create new with several owners asks which; with none it says to install the GitHub app and links to the install; with the read failed it offers Try again", async ({ page }) => {
    const many = mock({ picker: { repos: REPOS, owners: [{ gh_id: 5, login: "alpha" }, { gh_id: 6, login: "beta" }] } });
    await boot(page, many);
    await tid(page, "create").click();
    await tid(page, "name").fill("x1");
    await tid(page, "continue").click();
    await expect(tid(page, "error")).toHaveText("Choose who will own the repo.");
    expect(many.intents).toEqual([]);
    await tid(page, "owner").selectOption("6");
    await tid(page, "vis").selectOption("public");
    await tid(page, "continue").click();
    await page.waitForURL("https://github.com/**");
    expect(many.intents).toEqual([{ owner_gh_id: 6, name: "x1", visibility: "public" }]);

    const none = mock({ picker: { repos: [], owners: [] } });
    const p2 = await page.context().newPage();
    await boot(p2, none);
    await tid(p2, "create").click();
    await expect(tid(p2, "no-owner")).toHaveText("Install the GitHub app first");
    await tid(p2, "install").click();
    await p2.waitForURL("https://github.com/apps/**");

    const unknown = mock({ picker: { repos: [], owners: [], owners_unknown: true } });
    const p3 = await page.context().newPage();
    await boot(p3, unknown);
    await tid(p3, "create").click();
    await expect(tid(p3, "owners-unknown")).toHaveText("Couldn't load your GitHub accounts");
    await expect(tid(p3, "retry-owners")).toBeVisible();
  });

  test("a refused create-intent says why in its own words", async ({ page }) => {
    const m = mock({ intent: err(409, "install_first") });
    await boot(page, m);
    await tid(page, "create").click();
    await tid(page, "name").fill("fresh-repo");
    await tid(page, "continue").click();
    await expect(tid(page, "error")).toHaveText("Install the GitHub app first");
    await expect(tid(page, "continue")).toBeEnabled();
  });

  test("coming back from GitHub with ?create=ok&repo=<id> of a listed repo selects it as new: Balanced (the starting setting), kind new, and the address is cleaned", async ({ page }) => {
    const m = mock();
    await boot(page, m, `/?create=ok&repo=${R1}`);
    await expect(tid(page, "dials")).toHaveText("Dials: Balanced (the starting setting)");
    await expect(tid(page, "vis-line")).toContainText("new repo");
    expect(new URL(page.url()).search).toBe("");
    await tid(page, "confirm").click();
    await expect(tid(page, "placed")).toBeVisible();
    expect(m.places[0].body).toEqual({ kind: "new", runner_id: M1 });
  });

  test("a returned id that the picker does not list is never sent as new: the list shows with a note", async ({ page }) => {
    const m = mock();
    await boot(page, m, `/?create=ok&repo=${R4}`);
    await expect(tid(page, "note")).toContainText("isn't in your list yet");
    await expect(ob(page).locator('[data-testid="ob-pick-repo"]')).toHaveCount(3);
    expect(m.places).toEqual([]);
  });

  test("a create that GitHub refused comes back with its sentence and no repo is selected", async ({ page }) => {
    const m = mock();
    await boot(page, m, "/?create=name_taken");
    await expect(tid(page, "note")).toHaveText("A repo with that name already exists there. Pick another name.");
    await expect(tid(page, "confirm")).toHaveCount(0);
  });

  test("a member sees who to ask and no picker; nothing about repos is read", async ({ page }) => {
    const m = mock({ admin: false });
    await boot(page, m);
    await expect(ob(page).locator('[data-testid="ob-engine-project"]')).toContainText("Ask an owner or admin to pick the project");
    await expect(picker(page)).toHaveCount(0);
    expect(m.requests.filter((r) => r.includes("/repos/picker"))).toEqual([]);
  });

  test("the way back: Change repo and Back return to the list without sending anything", async ({ page }) => {
    const m = mock();
    await boot(page, m);
    await pickRepo(page, R1);
    await tid(page, "change").click();
    await expect(ob(page).locator('[data-testid="ob-pick-repo"]')).toHaveCount(3);
    await tid(page, "create").click();
    await tid(page, "back").click();
    await expect(ob(page).locator('[data-testid="ob-pick-repo"]')).toHaveCount(3);
    expect(m.places).toEqual([]);
    expect(m.intents).toEqual([]);
  });
});
