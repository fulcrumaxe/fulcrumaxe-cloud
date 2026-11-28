// apps/workspace/e2e/onboarding-twin.spec.ts
//
// D#845 ON-27e: the private twin's screens on the built cloud dist, with real clicks: the picker's choice card and create steps (Onboarding), the twin's rows and the plan choice, and the Repos twin card with its
// Private paths editor and the Pause and Stop publishing sheets. Every API answer is a page.route() mock shaped like the real route's; no request leaves the page for GitHub. With twins off (the routes answer 503)
// no card shows anywhere. The state-by-state logic is in test/twin-ui.test.mjs.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";
import { engineTrack, withEngine } from "./helpers/onboarding-body";

const DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const PLANS = JSON.parse(readFileSync(join(DIR, "plans-fixture.json"), "utf8"));
const PLACEHOLDER = /\b(null|undefined|nan)\b/i;
const PUB = "22222222-2222-4222-8222-222222222222";
const PRIV = "11111111-1111-4111-8111-111111111111";
const TWIN = "33333333-3333-4333-8333-333333333333";
const SETUP = "44444444-4444-4444-8444-444444444444";
const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MAKE_TEXT = "We'll create acme/site-private, copy your code into it, and run the engine there. Plans, Discussions and work stay private. Merged work comes back to acme/site as a pull request you merge.";
const STAY_TEXT = "The engine surveys this public repo and drafts a plan you review item by item. It can't run here yet.";
const COST = "CI on the private repo uses your GitHub Actions minutes (GitHub Free includes 2,000 a month). Public repos run Actions free.";

type Json = Record<string, unknown>;
const twin = (over: Json = {}) => ({ id: TWIN, public_repo_id: PUB, private_repo_id: PRIV, private_name: "site-private", state: "ready", overlay_globs: [], published_private_sha: "a".repeat(40), synced_public_sha: null, publish_pr: null, sync_pr: null, failure_code: null, merged_count: null, new_changes_count: null, note: null, created_at: "2026-11-26T00:00:00.000000Z", updated_at: "2026-11-26T00:00:00.000000Z", ...over });
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const off = (route: Route) => json(route, { error: { code: "not_configured", message: "SERVER WORDS", request_id: "r" } }, 503);

async function admin(page: Page) {
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), workspace_access: "no_subscription", is_admin: true } });
  });
}

test.describe("the private twin in the project picker (D#845 ON-27e)", () => {
  const ob = (page: Page) => page.locator('.fulc-window[data-app-id="onboarding"]');
  const tw = (page: Page, id: string) => ob(page).locator(`[data-testid="ob-twin-${id}"]`);
  async function boot(page: Page, twinFor: (id: string, route: Route) => Promise<void>, log: string[] = []) {
    await admin(page);
    page.on("request", (r) => { const u = new URL(r.url()); if (/\/(twins?|place)\b/.test(u.pathname) && r.method() !== "GET") log.push(`${r.method()} ${u.pathname} ${r.postData() ?? ""}`); });
    const body = withEngine(fx("getOnboarding", "200-new.json"), engineTrack({ machine: "done", claude: "done", github_app: "done", project: "active" }, { tier: "microvm" }));
    await page.route((u) => u.pathname === "/api/v1/onboarding", (route) => route.fulfill({ json: body }));
    await page.route("**/api/plans", (route) => route.fulfill({ json: { ...PLANS, viewer: { is_owner: true, partner_billed: false } } }));
    await page.route((u) => u.pathname === "/api/runners", (route) => json(route, { runners: [{ id: M1, name: "build-box-1", state: "online_idle", last_seen_at: new Date().toISOString(), facts: { engine: "microvm" }, linked_at: "2026-11-20T10:00:00.000Z" }] }));
    await page.route((u) => u.pathname === "/api/machines", (route) => json(route, { machines: [{ id: M1, name: "build-box-1", tier: "microvm", live: true, running: null }] }));
    await page.route((u) => u.pathname === "/api/v1/engine/settings", (route) => json(route, { watch_enabled: true, operate_enabled: true, can_edit: true, repos: [] }));
    await page.route((u) => u.pathname === "/api/runners/repos/picker", (route) => json(route, { repos: [
      { id: PRIV, name: "acme/site-private", visibility: "private", active_preset: null }, { id: PUB, name: "acme/site", visibility: "public", active_preset: null }], owners: [{ gh_id: 77, login: "acme" }] }));
    await page.route((u) => /^\/api\/v1\/repos\/[^/]+\/twin$/.test(u.pathname) && true, async (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[4];
      if (route.request().method() === "GET") return twinFor(id, route);
      return json(route, { authorize_url: "https://github.com/login/oauth/authorize?state=x" });
    });
    await page.route((u) => /^\/api\/runners\/repos\/[^/]+\/place$/.test(u.pathname), (route) => json(route, { setup_id: SETUP, repo_id: PRIV, runner_id: M1, kind: "existing", phase: "survey", operate_enabled: true }, 201));
    await page.route("https://github.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>github</title>" }));
    await bootToDesktop(page, { url: "/" });
  }
  const pick = (page: Page, id: string) => ob(page).locator(`[data-testid="ob-pick-repo"][data-repo="${id}"]`).click();

  test("with twins off (the twin routes answer 503) no card is drawn and the public repo confirms as before", async ({ page }) => {
    await boot(page, (_id, route) => off(route));
    await pick(page, PUB);
    await expect(ob(page).locator('[data-testid="ob-pick-public"]')).toBeVisible();
    await expect(ob(page).locator('[data-testid="ob-twin-host"]')).toBeEmpty();
    await expect(ob(page).locator('[data-testid="ob-pick-confirm"]')).toBeEnabled();
  });

  test("a public repo with no twin gets the choice card in the Spec's words; Make a private twin names it, then sends one create and goes to GitHub", async ({ page }) => {
    const log: string[] = [];
    await boot(page, (_id, route) => json(route, { twin: null }), log);
    await pick(page, PUB);
    await expect(tw(page, "make")).toHaveText("Make a private twin (recommended)");
    await expect(tw(page, "make-text")).toHaveText(MAKE_TEXT);
    await expect(tw(page, "stay")).toHaveText("Stay public-only");
    await expect(tw(page, "stay-text")).toHaveText(STAY_TEXT);
    await expect(tw(page, "cost")).toHaveText(COST);
    expect(await ob(page).locator('[data-testid="ob-picker"]').innerText()).not.toMatch(PLACEHOLDER);
    await tw(page, "make").click();
    await expect(tw(page, "name")).toHaveValue("site-private");
    expect(log.filter((l) => l.startsWith("POST"))).toEqual([]);
    const github = page.waitForRequest((r) => r.url().startsWith("https://github.com/login/oauth/authorize"));
    await tw(page, "continue").click();
    await github;
    expect(log.filter((l) => l.startsWith("POST"))).toEqual([`POST /api/v1/repos/${PUB}/twin {"name":"site-private"}`]);
  });

  test("Stay public-only takes the card away and sends nothing", async ({ page }) => {
    const log: string[] = [];
    await boot(page, (_id, route) => json(route, { twin: null }), log);
    await pick(page, PUB);
    await tw(page, "stay").click();
    await expect(ob(page).locator('[data-testid="ob-twin-host"]')).toBeEmpty();
    expect(log).toEqual([]);
  });

  test("the twin repo shows its three rows; once placed and ready, Use my approved plan sends the setup and says what it did", async ({ page }) => {
    const log: string[] = [];
    await boot(page, (_id, route) => json(route, { twin: twin({ state: "seeding", published_private_sha: null }) }), log);
    await pick(page, PRIV);
    await expect(tw(page, "row")).toHaveText(["Private twin createdDone", "Copying your code…Up next", "ReadyWaiting"]);
    await page.route((u) => /^\/api\/v1\/repos\/[^/]+\/twin$/.test(u.pathname), (route) => json(route, { twin: twin() }));
    await page.route((u) => u.pathname === `/api/v1/twins/${TWIN}/adopt-plan`, (route) => json(route, { adopted: true, draft_id: "d", reason: null }));
    await ob(page).locator('[data-testid="ob-pick-confirm"]').click();
    await expect(tw(page, "adopt")).toHaveText("Use my approved plan");
    await expect(tw(page, "again")).toHaveText("Survey again");
    await tw(page, "adopt").click();
    await expect(tw(page, "adopted")).toContainText("carried over");
    expect(log.filter((l) => l.includes("adopt-plan"))).toEqual([`POST /api/v1/twins/${TWIN}/adopt-plan {"setup_id":"${SETUP}"}`]);
  });
  test("after a reload the plan choice is still there: the setup's own repository is read from the onboarding answer, with no picker click", async ({ page }) => {
    const log: string[] = [];
    await admin(page);
    page.on("request", (r) => { const u = new URL(r.url()); if (/\/twins?\b/.test(u.pathname) && r.method() !== "GET") log.push(`${r.method()} ${u.pathname} ${r.postData() ?? ""}`); });
    const base = withEngine(fx("getOnboarding", "200-new.json"), engineTrack({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "active" }, { tier: "microvm" }));
    const body = { ...base, tracks: [base.tracks[0], { ...base.tracks[1], setup: { id: SETUP, phase: "survey", state: "started", survey_run_id: null, repo_id: PRIV } }] };
    await page.route((u) => u.pathname === "/api/v1/onboarding", (route) => route.fulfill({ json: body }));
    await page.route("**/api/plans", (route) => route.fulfill({ json: { ...PLANS, viewer: { is_owner: true, partner_billed: false } } }));
    await page.route((u) => /^\/api\/v1\/repos\/[^/]+\/twin$/.test(u.pathname), (route) => json(route, { twin: twin() }));
    await page.route((u) => u.pathname === `/api/v1/twins/${TWIN}/adopt-plan`, (route) => json(route, { adopted: true, draft_id: "d", reason: null }));
    await bootToDesktop(page, { url: "/" });
    await expect(tw(page, "adopt")).toHaveText("Use my approved plan");
    await tw(page, "adopt").click();
    await expect(tw(page, "adopted")).toContainText("carried over");
    expect(log).toEqual([`POST /api/v1/twins/${TWIN}/adopt-plan {"setup_id":"${SETUP}"}`]);
  });
});

test.describe("the Repos twin card (D#845 ON-27e)", () => {
  const REPOS = fx("listRepos", "200-page.json");
  const SETTINGS = fx("getRepoSettings", "200-ok.json");
  const APP = `#windows-container .fulc-window[data-app-id="repos"]`;
  const tid = (page: Page, id: string) => page.locator(`${APP} [data-testid="${id}"]`);
  const PATHS = { overlay_globs: ["internal/**", "notes/**"], binary_globs: [], install_paths: ["tools/x.sh"], fixed_roots: [".env"], identifier_rules_path: null, plan_data_rules_path: null, revision: "r1" };

  let issueRoutes: ((route: Route) => Promise<void> | void) | null = null; // the public issues and the bring route; with none the routes answer "not configured" and the card has no list
  test.beforeEach(() => { issueRoutes = null; });
  async function boot(page: Page, twinAnswer: (route: Route, repoId: string) => Promise<void>, repos: Json = REPOS, paths0: Json = PATHS) {
    const writes: string[] = [];
    let paths: Json = paths0; // the server keeps what a save wrote
    await admin(page);
    const first = (repos.data as Json[])[0];
    await page.route("**/api/v1/repos**", (route) => {
      const r = route.request();
      const u = new URL(r.url());
      if (/\/repos\/[^/]+\/twin$/.test(u.pathname)) return twinAnswer(route, u.pathname.split("/")[4]);
      if (r.method() !== "GET") writes.push(`${r.method()} ${u.pathname}`);
      return json(route, u.pathname.endsWith("/settings") ? SETTINGS : repos);
    });
    await page.route("**/api/v1/twins/**", (route) => {
      const r = route.request();
      const u = new URL(r.url());
      if (/\/issues(\/\d+\/bring)?$/.test(u.pathname)) return issueRoutes ? issueRoutes(route) : off(route);
      if (r.method() !== "GET") writes.push(`${r.method()} ${u.pathname} ${r.postData() ?? ""}`);
      if (u.pathname.endsWith("/paths")) {
        if (r.method() === "PUT") paths = { ...paths0, ...(JSON.parse(r.postData() ?? "{}") as Json), revision: "r2" };
        return json(route, paths);
      }
      if (u.pathname.endsWith("/pause")) return json(route, twin({ private_repo_id: first.id, state: "paused" }));
      return json(route, twin({ private_repo_id: first.id, state: "removed" }));
    });
    await bootToDesktop(page);
    await page.locator('.dock-icon[data-app-id="repos"]').click();
    await expect(page.locator(APP)).toBeVisible();
    await tid(page, "repos-open").first().click();
    return { writes, first };
  }

  test("with twins off the Repos settings show no twin card", async ({ page }) => {
    await boot(page, (route) => off(route));
    await expect(tid(page, "repos-remove-open")).toBeVisible();
    await expect(tid(page, "repos-twin")).toBeEmpty();
  });

  test("the card names the public repo, shows an open publish pull request and the cost, and Pause sends one request only after its sheet is confirmed", async ({ page }) => {
    const { writes, first } = await boot(page, (route, id) => json(route, { twin: twin({ private_repo_id: id, public_repo_id: first_pub(id), publish_pr: 7 }) }));
    await expect(tid(page, "repos-twin-publishes")).toContainText("Publishes to");
    await expect(tid(page, "repos-twin-line").filter({ hasText: "Publish PR #7 is open: merge it on GitHub" })).toBeVisible();
    await expect(tid(page, "repos-twin-cost")).toHaveText(COST);
    expect(await tid(page, "repos-twin").innerText()).not.toMatch(PLACEHOLDER);
    await tid(page, "repos-twin-pause").click();
    const sheet = page.locator('[data-testid="repos-twin-sheet"]');
    await expect(sheet).toContainText("Everything already on GitHub stays");
    expect(writes).toEqual([]);
    await sheet.locator('[data-testid="repos-twin-sheet-confirm"]').click();
    await expect(tid(page, "repos-twin-resume")).toBeVisible();
    await expect(tid(page, "repos-twin-resume")).toBeFocused(); // Pause is gone with the repaint: focus is on Resume, not the page
    expect(writes).toEqual([`POST /api/v1/twins/${TWIN}/pause `]);
    expect(first.id).toBeTruthy();
  });

  test("the Private paths editor warns before narrowing and saves on the second press; Cancel on a sheet sends nothing", async ({ page }) => {
    const { writes } = await boot(page, (route, id) => json(route, { twin: twin({ private_repo_id: id, public_repo_id: first_pub(id) }) }));
    await expect(tid(page, "repos-twin-overlay")).toHaveValue("internal/**\nnotes/**");
    await expect(tid(page, "repos-twin-fixed")).toContainText("tools/x.sh");
    await tid(page, "repos-twin-overlay").fill("notes/**");
    await tid(page, "repos-twin-paths-save").click();
    await expect(tid(page, "repos-twin-paths-warn")).toContainText("Removing 1 path");
    expect(writes).toEqual([]);
    await tid(page, "repos-twin-paths-save").click();
    await expect(tid(page, "repos-twin-overlay")).toHaveValue("notes/**");
    expect(writes).toEqual([`PUT /api/v1/twins/${TWIN}/paths {"revision":"r1","overlay_globs":["notes/**"],"binary_globs":[]}`]);
    await tid(page, "repos-twin-stop").click();
    await page.locator('[data-testid="repos-twin-sheet"] [data-testid="repos-twin-sheet-cancel"]').click();
    expect(writes.length).toBe(1);
    await expect(tid(page, "repos-twin-stop")).toBeFocused(); // the card was rebuilt: the button that opened the sheet has focus again
  });

  test("Stop publishing ends the card and leaves focus on the repo's heading, not the page", async ({ page }) => {
    const { writes } = await boot(page, (route, id) => json(route, { twin: twin({ private_repo_id: id, public_repo_id: first_pub(id) }) }));
    await tid(page, "repos-twin-stop").click();
    await page.locator('[data-testid="repos-twin-sheet"] [data-testid="repos-twin-sheet-confirm"]').click();
    await expect(tid(page, "repos-twin")).toBeEmpty();
    expect(writes).toEqual([`DELETE /api/v1/twins/${TWIN} `]);
    await expect(tid(page, "repos-detail-title")).toBeFocused();
  });

  /** The server of one twin: GET answers its row; Merge and Check again are logged and change it; anything else falls through to boot's own answers. */
  async function twinServer(page: Page, row: Json, over: { merge?: (s: Json) => [number, unknown]; check?: (s: Json) => [number, unknown] } = {}) {
    const state: Json = { ...row };
    const posts: string[] = [];
    const answer = (id: string) => twin({ ...state, private_repo_id: id, public_repo_id: first_pub(id) });
    const boots = await boot(page, (route, id) => json(route, { twin: answer(id) }));
    await page.route("**/api/v1/twins/**", (route) => {
      const r = route.request();
      const path = new URL(r.url()).pathname;
      if (r.method() !== "POST" || !/\/(merge|check)$/.test(path)) return route.fallback();
      posts.push(`${r.method()} ${path} ${r.postData() ?? ""}`);
      const [status, body] = (path.endsWith("/merge") ? over.merge : over.check)?.(state) ?? [200, null];
      return json(route, body ?? answer(boots.first.id), status);
    });
    return { state, posts, ...boots };
  }
  const blocked = (code: string): [number, unknown] => [409, { error: { code, message: "SERVER WORDS", request_id: "r" } }];

  test("Merge is on the publish line: one click sends one merge of the publish pull request, and the line follows the twin", async ({ page }) => {
    const { posts } = await twinServer(page, { publish_pr: 7, merged_count: 3, new_changes_count: 0 }, { merge: (s) => { s.publish_pr = null; s.merged_count = 0; return [200, { merged: true, already: false, pr: 7 }]; } });
    await expect(tid(page, "repos-twin-line").filter({ hasText: "Publish PR #7 is open: merge it on GitHub" })).toBeVisible();
    await expect(tid(page, "repos-twin-merge")).toHaveText("Merge publish PR #7");
    expect(posts).toEqual([]);
    await tid(page, "repos-twin-merge").click();
    await expect(tid(page, "repos-twin-line").filter({ hasText: "Waiting to publish: 0 merged changes" })).toBeVisible();
    await expect(tid(page, "repos-twin-merge")).toHaveCount(0);
    expect(posts).toEqual([`POST /api/v1/twins/${TWIN}/merge {"pr":"publish"}`]);
    expect(await tid(page, "repos-twin").innerText()).not.toMatch(PLACEHOLDER);
  });

  test("a merge GitHub will not make yet says so in the card's own words, never the server's, and the pull request stays", async ({ page }) => {
    const { posts } = await twinServer(page, { publish_pr: 7 }, { merge: () => blocked("twin_pr_blocked") });
    await tid(page, "repos-twin-merge").click();
    await expect(tid(page, "repos-twin-error")).toContainText("GitHub will not merge this yet");
    expect(await tid(page, "repos-twin").innerText()).not.toContain("SERVER WORDS");
    await expect(tid(page, "repos-twin-merge")).toBeVisible();
    expect(posts).toHaveLength(1);
  });

  test("there is no Merge on a sync pull request; the counts read the twin's merged_count and new_changes_count, and an unchecked twin says so", async ({ page }) => {
    await twinServer(page, { sync_pr: 9, merged_count: 2, new_changes_count: 4 });
    await expect(tid(page, "repos-twin-line").filter({ hasText: "Waiting to publish: 2 merged changes" })).toBeVisible();
    await expect(tid(page, "repos-twin-line").filter({ hasText: /has 4 new changes: bringing them in \(PR #9 on the private repo\)/ })).toBeVisible();
    await expect(tid(page, "repos-twin-merge")).toHaveCount(0);
  });

  test("an unchecked twin reads 'not checked yet'; Check again sends one request and the counts follow", async ({ page }) => {
    const { posts } = await twinServer(page, {}, { check: (s) => { s.merged_count = 5; s.new_changes_count = 1; return [200, null]; } });
    await expect(tid(page, "repos-twin-line").filter({ hasText: "Waiting to publish: not checked yet" })).toBeVisible();
    await expect(tid(page, "repos-twin-line").filter({ hasText: /New changes on .*: not checked yet/ })).toBeVisible();
    await tid(page, "repos-twin-check").click();
    await expect(tid(page, "repos-twin-line").filter({ hasText: "Waiting to publish: 5 merged changes" })).toBeVisible();
    await expect(tid(page, "repos-twin-check")).toBeFocused();
    expect(posts).toEqual([`POST /api/v1/twins/${TWIN}/check `]);
  });

  test("a twin refused because its private repo is public shows the way back; there is no Check again, and Pause is there", async ({ page }) => {
    await twinServer(page, { state: "refused", failure_code: "twin_not_private" });
    await expect(tid(page, "repos-twin-line").first()).toContainText("Make it private again on GitHub, then Pause and Resume here");
    await expect(tid(page, "repos-twin-check")).toHaveCount(0);
    await expect(tid(page, "repos-twin-pause")).toBeVisible();
    expect(await tid(page, "repos-twin").innerText()).not.toMatch(PLACEHOLDER);
  });

  test("a public repo that turned private is a note on the card, and the twin keeps its buttons", async ({ page }) => {
    await twinServer(page, { note: "public_repo_private" });
    await expect(tid(page, "repos-twin-line").filter({ hasText: "Your public repo is private now" })).toBeVisible();
    await expect(tid(page, "repos-twin-pause")).toBeVisible();
  });

  const ISSUES = (canBring = true) => ({ issues: [{ number: 12, title: "<b>Crash</b> on start", author: "stranger", brought_issue: null }, { number: 9, title: "Old one", author: "ann", brought_issue: 4 }], can_bring: canBring });
  const twinOnCard = (page: Page) => boot(page, (route, id) => json(route, { twin: twin({ private_repo_id: id, public_repo_id: first_pub(id) }) }));

  test("the public repo's open issues are listed as text; Bring into private repo sends one request, says 'Brought as #N', and a brought issue has no button", async ({ page }) => {
    const posts: string[] = [];
    issueRoutes = (route) => {
      const r = route.request();
      if (r.method() === "GET") return json(route, ISSUES());
      posts.push(`${r.method()} ${new URL(r.url()).pathname}`);
      return json(route, { private_issue: 31, already: false });
    };
    await twinOnCard(page);
    await expect(tid(page, "repos-twin-issue")).toHaveCount(2);
    await expect(tid(page, "repos-twin-issue").first()).toContainText("<b>Crash</b> on start"); // a title is text, never markup
    await expect(tid(page, "repos-twin-brought-9")).toHaveText("Brought as #4");
    await expect(tid(page, "repos-twin-bring-9")).toHaveCount(0);
    expect(posts).toEqual([]);
    await tid(page, "repos-twin-bring-12").click();
    await expect(tid(page, "repos-twin-brought-12")).toHaveText("Brought as #31");
    await expect(tid(page, "repos-twin-bring-12")).toHaveCount(0);
    expect(posts).toEqual([`POST /api/v1/twins/${TWIN}/issues/12/bring`]);
    expect(await tid(page, "repos-twin").innerText()).not.toMatch(PLACEHOLDER);
  });

  test("without can_bring the list shows and there is no button; an issue that closed meanwhile is a fixed sentence and the list is read again", async ({ page }) => {
    let reads = 0;
    issueRoutes = (route) => {
      if (route.request().method() === "GET") { reads++; return json(route, reads === 1 ? ISSUES(false) : { issues: [], can_bring: false }); }
      return json(route, { error: { code: "issue_not_open", message: "SERVER WORDS", request_id: "r" } }, 409);
    };
    await twinOnCard(page);
    await expect(tid(page, "repos-twin-issue")).toHaveCount(2);
    await expect(tid(page, "repos-twin-bring-12")).toHaveCount(0);
  });

  test("a closed issue answers a fixed sentence, never the server's, and the list is read again", async ({ page }) => {
    let reads = 0;
    issueRoutes = (route) => {
      if (route.request().method() === "GET") { reads++; return json(route, reads === 1 ? ISSUES() : { issues: [], can_bring: true }); }
      return json(route, { error: { code: "issue_not_open", message: "SERVER WORDS", request_id: "r" } }, 409);
    };
    await twinOnCard(page);
    await tid(page, "repos-twin-bring-12").click();
    await expect(tid(page, "repos-twin-error")).toContainText("closed or is a pull request");
    expect(await tid(page, "repos-twin").innerText()).not.toContain("SERVER WORDS");
    await expect(tid(page, "repos-twin-issues-none")).toHaveText("No open issues.");
  });

  test("on a phone a long repo name and a long path wrap inside the card, and the page never scrolls sideways", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "the phone project's narrow, full-screen window is what is measured");
    const longName = "acme/" + "verylongrepositoryname".repeat(4) + "end";
    const longPath = "tools/" + "anextremelylongfilenamewithnobreakpoints".repeat(3) + "end";
    const base = REPOS.data as Json[];
    const repos = { ...REPOS, data: [{ ...base[0], full_name: longName }, { ...base[1], id: PUB, full_name: longName + "-public" }] };
    const paths = { ...PATHS, install_paths: [longPath], overlay_globs: [longPath] };
    await boot(page, (route, id) => json(route, { twin: twin({ private_repo_id: id, public_repo_id: PUB, private_name: longName.slice(5) + "-private" }) }), repos, paths);
    await expect(tid(page, "repos-twin-publishes")).toContainText("verylongrepositoryname");
    await page.locator(`${APP} [data-testid="repos-twin-fixed"]`).evaluate((ul) => { (ul.closest("details") as HTMLDetailsElement).open = true; });
    await expect(tid(page, "repos-twin-fixed")).toContainText("anextremelylongfilename");
    const over = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="repos-twin"]') as HTMLElement;
      const wide = [card, ...Array.from(card.querySelectorAll("li, p, a, h3, label"))].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.tagName + ":" + (e.textContent ?? "").slice(0, 30));
      return { wide, page: document.documentElement.scrollWidth - window.innerWidth, spill: Math.round(card.getBoundingClientRect().right - window.innerWidth) }; // the window clips what spills, so the card itself is measured against the screen
    });
    expect(over.wide).toEqual([]);
    expect(over.page).toBeLessThanOrEqual(0);
    expect(over.spill).toBeLessThanOrEqual(0);
  });
});
/** A public repo id that is not the open one. */
const first_pub = (open: string): string => (open === PUB ? PRIV : PUB);
