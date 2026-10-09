// apps/workspace/e2e/runner-approval.spec.ts
//
// D#6 R2b-4b: the runner approval screens on the built cloud dist, served by fixture-server.mjs. Every call the windows make is answered
// by page.route(): the runner routes (/api/runners/**) and the v1 reads the three apps use. The document carries the production CSP and
// Trusted Types directives. The logic half (one POST per click, sentences, states) is in test/runner-approval-ui.test.mjs; this file
// covers what needs the real DOM: the switch that never shows on before its question is answered, the dialog, read-only views for a
// member, the buttons that exist only where the server says so, and that no code, id, null or server text reaches the page.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { waitForDesktop } from "./helpers/boot";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const REPOS = fx("listRepos", "200-page.json");
const SETTINGS = fx("getRepoSettings", "200-ok.json");
const LIST = fx("listWorkItems", "200-page.json");
const TIMELINE = fx("getWorkItemTimeline", "200-ok.json");
const REPO_ID = REPOS.data[0].id as string;
const ITEM = LIST.data[0].id as string;

const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const SERVER_TEXT = "server text that must never be shown";
const COPY = {
  usageLimits: "Work runs within your own Claude plan's usage limits.",
  approval: "Waiting for {person} to approve (it runs on their Claude plan).",
  runner: "Runs the Claude Code you have already signed in to.",
  localOnly: "x",
  sandboxUnavailable: "x",
  approvalMine: "This run needs your approval. It runs on your Claude plan.",
  approvalButton: "Approve run",
  approvalDone: "Approved. Waiting for your runner.",
  approvalRefused: "This run can no longer be approved.",
  approvalAuto: "Approved automatically. It runs on {person}'s Claude plan.",
  planConsentText: "Let work on this runner's repos run on my Claude plan without asking each time. This includes work anyone in this account starts on those repos. You can turn this off at any time.",
  dialRunnerRuns: "Runner runs on a member's plan",
  dialRunnerRunsAsk: "Ask each run",
  dialRunnerRunsAnnounce: "Approve and tell me",
  dialRunnerRunsAct: "Approve without asking",
};
const ME = "33333333-3333-4333-8333-333333333333";
const RUN_A = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const RUN_B = "11111111-1111-4111-8111-bbbbbbbbbbbb";
const RUN_C = "11111111-1111-4111-8111-cccccccccccc";

const runner = (over: Record<string, unknown> = {}) => ({
  id: "44444444-4444-4444-8444-444444444444", credential_mode: "subscription", registered_by: { id: ME, name: "Ada Admin" }, binary_version: "1.0.0",
  last_seen_at: "2026-10-09T05:00:00.000Z", state: "online_idle", sandbox_unavailable: null, plan_consent: { granted: false, changed_at: null },
  can_change_plan_consent: true, repos: [{ id: REPO_ID, name: "acme/web" }, { id: "55555555-5555-4555-8555-555555555555", name: "acme/api" }], ...over,
});
const dial = (over: Record<string, unknown> = {}) => ({ repo_id: REPO_ID, decision_type: "runner_run_on_member_plan", disposition: "announce", source: "default", preset: null, version: null, can_change: true, ...over });
const entry = (run_id: string, over: Record<string, unknown> = {}) => ({
  run_id, work_item_id: null, role: "executor", repo_name: "acme/web", created_at: "2026-10-09T05:00:00.000Z", approvers: [{ id: ME, name: "Ada Admin" }], can_approve: true, ...over,
});
const run = (id: string, over: Record<string, unknown> = {}) => ({
  id, work_item_id: null, parent_run_id: null, role: "executor", status: "pending", usd: null, tokens_in: null, tokens_out: null,
  created_at: "2026-10-09T05:00:00.000Z", updated_at: "2026-10-09T05:00:00.000Z", approved_by: null, approval: null, ...over,
});

interface Mock {
  runners: unknown[];
  approvals: unknown[];
  dial: ReturnType<typeof dial>;
  runs: unknown[];
  isAdmin: boolean;
  approveStatus: number;
  consentPosts: { path: string; body: unknown }[];
  dialPuts: unknown[];
  approvePosts: string[];
  requests: string[];
}
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const err = (code: string) => ({ error: { code, message: SERVER_TEXT, request_id: "req_1" } });

async function setup(page: Page, tweak: Partial<Mock> = {}) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective}`)));
  const mock: Mock = { runners: [], approvals: [], dial: dial(), runs: [], isAdmin: true, approveStatus: 200, consentPosts: [], dialPuts: [], approvePosts: [], requests: [], ...tweak };
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: mock.isAdmin } });
  });
  await page.route("**/api/v1/events", () => new Promise<void>(() => {}));
  await page.route((u) => u.pathname.startsWith("/api/runners") || (u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events"), async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    mock.requests.push(`${req.method()} ${p}`);
    if ((req.headers()["accept"] ?? "").includes("text/event-stream")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: idle\ndata: {}\n\n" });
    // The runner routes
    if (p === "/api/runners") return json(route, 200, { runners: mock.runners, copy: COPY });
    if (p === "/api/runners/approvals") return json(route, 200, { approvals: mock.approvals });
    if (/^\/api\/runners\/runs\/[^/]+\/approve$/.test(p)) {
      mock.approvePosts.push(p.split("/")[4]!);
      if (mock.approveStatus !== 200) return json(route, mock.approveStatus, err(mock.approveStatus === 403 ? "forbidden" : "approved_by_other"));
      mock.approvals = mock.approvals.filter((a) => (a as { run_id: string }).run_id !== p.split("/")[4]);
      return json(route, 200, { changed: true });
    }
    if (/^\/api\/runners\/[^/]+\/plan-consent$/.test(p)) {
      const body = JSON.parse(req.postData() ?? "{}");
      mock.consentPosts.push({ path: p, body });
      mock.runners = mock.runners.map((r) => ({ ...(r as object), plan_consent: { granted: body.granted, changed_at: "2026-10-09T05:30:00.000Z" } }));
      return json(route, 200, { plan_consent: { granted: body.granted, changed_at: "2026-10-09T05:30:00.000Z" }, changed: true });
    }
    if (/\/plan-approval-dial$/.test(p)) {
      if (req.method() === "PUT") {
        const body = JSON.parse(req.postData() ?? "{}");
        mock.dialPuts.push(body);
        mock.dial = dial({ disposition: body.disposition, source: "override", can_change: mock.dial.can_change });
      }
      return json(route, 200, mock.dial);
    }
    // The v1 reads
    if (p === "/api/v1/repos") return json(route, 200, REPOS);
    if (p.endsWith("/settings")) return json(route, 200, SETTINGS);
    if (p === "/api/v1/work-items") return json(route, 200, { data: [{ ...LIST.data[0], stage: "in_progress" }], next_cursor: null });
    if (p.endsWith("/timeline")) return json(route, 200, TIMELINE);
    if (p === "/api/v1/runs") return json(route, 200, { data: u.searchParams.get("work_item_id") ? mock.runs.filter((r) => (r as { work_item_id: string | null }).work_item_id === ITEM) : mock.runs, next_cursor: null });
    if (p.endsWith("/events")) return json(route, 200, { data: [], next_cursor: "0" });
    if (p.endsWith("/insight")) return json(route, 404, err("not_found"));
    if (p.startsWith("/api/v1/runs/")) {
      const found = mock.runs.find((r) => (r as { id: string }).id === p.split("/").pop());
      return found ? json(route, 200, found) : json(route, 404, err("not_found"));
    }
    return json(route, 404, err("not_found"));
  });
  await page.goto("/");
  await waitForDesktop(page);
  return { mock, errors };
}

const open = async (page: Page, id: string) => {
  await page.locator(`.dock-icon[data-app-id="${id}"]`).click();
  const win = page.locator(`#windows-container .fulc-window[data-app-id="${id}"]`);
  await expect(win).toBeVisible();
  await expect(win).not.toHaveClass(/opening/);
  return win;
};
const press = async (loc: ReturnType<Page["locator"]>) => {
  if (test.info().project.name === "phone") await loc.tap();
  else await loc.click();
};
async function clean(page: Page, errors: string[]) {
  expect(errors).toEqual([]);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/\bnull\b|undefined|NaN|ApiError/);
  expect(text).not.toContain(SERVER_TEXT);
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); // no id stands in for a name
  expect(text).not.toMatch(/claude[\s_\-. ]*code/i);
}

// ── Repos: the Runners section and the runner-run setting ─────────────────────────────────────────────
test.describe("D#6 R2b-4b: Repos app, runners", () => {
  const APP = `#windows-container .fulc-window[data-app-id="repos"]`;
  const t = (page: Page, id: string) => page.locator(`${APP} [data-testid="${id}"]`);
  const dlg = (page: Page) => page.locator('dialog[data-testid="repos-consent-dialog"]');

  test("no runner: the section says so and offers nothing to change", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page, "repos");
    await expect(t(page, "repos-runners-empty")).toContainText("No runners yet");
    await expect(t(page, "repos-consent-switch")).toHaveCount(0);
    expect(mock.consentPosts).toEqual([]);
    await clean(page, errors);
  });

  test("the plan holder's switch: shown off, the dialog carries the consent text and the repos, nothing is sent until Turn on, then one POST and a who-and-when line", async ({ page }) => {
    const { mock, errors } = await setup(page, { runners: [runner()] });
    await open(page, "repos");
    const sw = t(page, "repos-consent-switch");
    await expect(sw).not.toBeChecked();
    await expect(t(page, "repos-consent-state")).toHaveText("Ada Admin approves each run");
    await expect(t(page, "repos-runner-repos")).toHaveText("Repos: acme/web, acme/api");
    await press(sw);
    await expect(dlg(page)).toBeVisible();
    await expect(dlg(page)).toContainText(COPY.planConsentText);
    await expect(dlg(page)).toContainText("acme/web, acme/api");
    await expect(sw).not.toBeChecked(); // still the saved value while the question is open
    expect(mock.consentPosts).toEqual([]);
    await press(dlg(page).locator('[data-testid="repos-consent-cancel"]'));
    await expect(dlg(page)).toHaveCount(0);
    await expect(sw).not.toBeChecked();
    expect(mock.consentPosts).toEqual([]);
    await press(sw);
    const turnOn = dlg(page).locator('[data-testid="repos-consent-confirm"]');
    await turnOn.dblclick(); // a double press is one request
    await expect(dlg(page)).toHaveCount(0);
    expect(mock.consentPosts).toHaveLength(1);
    expect(mock.consentPosts[0]!.body).toEqual({ granted: true });
    await expect(sw).toBeChecked();
    await expect(t(page, "repos-consent-state")).toHaveText("Ada Admin lets work run on their plan without asking");
    await expect(t(page, "repos-consent-when")).toContainText("Turned on by Ada Admin");
    await clean(page, errors);
  });

  test("turning it off asks first and sends granted false", async ({ page }) => {
    const { mock, errors } = await setup(page, { runners: [runner({ plan_consent: { granted: true, changed_at: "2026-10-09T05:00:00.000Z" } })] });
    await open(page, "repos");
    const sw = t(page, "repos-consent-switch");
    await expect(sw).toBeChecked();
    await press(sw);
    await expect(dlg(page)).toContainText("Ask before each run again?");
    expect(mock.consentPosts).toEqual([]);
    await press(dlg(page).locator('[data-testid="repos-consent-confirm"]'));
    await expect(dlg(page)).toHaveCount(0);
    expect(mock.consentPosts.map((c) => c.body)).toEqual([{ granted: false }]);
    await expect(sw).not.toBeChecked();
    await expect(t(page, "repos-consent-when")).toContainText("Turned off by Ada Admin");
    await clean(page, errors);
  });

  test("somebody else's runner is read-only in both states, with who and when, and an API key runner has no consent line", async ({ page }) => {
    const other = { registered_by: { id: "66666666-6666-4666-8666-666666666666", name: "Bo Builder" }, can_change_plan_consent: false };
    const { mock, errors } = await setup(page, {
      runners: [
        runner({ ...other, id: "77777777-7777-4777-8777-777777777771", plan_consent: { granted: true, changed_at: "2026-10-09T05:00:00.000Z" } }),
        runner({ ...other, id: "77777777-7777-4777-8777-777777777772" }),
        runner({ ...other, id: "77777777-7777-4777-8777-777777777773", credential_mode: "api_key" }),
      ],
    });
    await open(page, "repos");
    await expect(t(page, "repos-runner")).toHaveCount(3);
    await expect(t(page, "repos-consent-switch")).toHaveCount(0);
    await expect(t(page, "repos-consent-state")).toHaveText(["Bo Builder lets work run on their plan without asking", "Bo Builder approves each run"]);
    await expect(t(page, "repos-consent-when")).toContainText("Turned on by Bo Builder");
    expect(mock.consentPosts).toEqual([]);
    await clean(page, errors);
  });

  test("a runner that is not covering this repo lists only its own repos", async ({ page }) => {
    const { errors } = await setup(page, { runners: [runner({ repos: [{ id: "55555555-5555-4555-8555-555555555555", name: "acme/api" }] })] });
    await open(page, "repos");
    await expect(t(page, "repos-runner-repos")).toHaveText("Repos: acme/api");
    await clean(page, errors);
  });

  test("the setting, as an owner or admin: the value in force and its source, and one PUT per change", async ({ page }) => {
    const { mock, errors } = await setup(page, { runners: [runner()] });
    await open(page, "repos");
    await press(t(page, "repos-open").first());
    await expect(t(page, "repos-dial")).toContainText(COPY.dialRunnerRuns);
    await expect(t(page, "repos-dial-announce")).toBeChecked();
    await expect(t(page, "repos-dial-source")).toHaveText("This is the default. Nobody has set it for this repo.");
    await expect(t(page, "repos-dial-ask")).toBeEnabled();
    await press(t(page, "repos-dial-ask"));
    await expect(t(page, "repos-dial-ask")).toBeChecked();
    await expect(t(page, "repos-dial-source")).toHaveText("Set for this repo.");
    await press(t(page, "repos-dial-act"));
    await expect(t(page, "repos-dial-act")).toBeChecked();
    expect(mock.dialPuts).toEqual([{ disposition: "ask" }, { disposition: "act" }]);
    await clean(page, errors);
  });

  test("the setting, as a member: shown and not changeable, and a preset adopted earlier is named", async ({ page }) => {
    const { mock, errors } = await setup(page, { runners: [runner({ can_change_plan_consent: false })], dial: dial({ disposition: "ask", source: "preset", preset: "cautious", version: 2, can_change: false }) });
    await open(page, "repos");
    await press(t(page, "repos-open").first());
    await expect(t(page, "repos-dial-ask")).toBeChecked();
    await expect(t(page, "repos-dial-ask")).toBeDisabled();
    await expect(t(page, "repos-dial-act")).toBeDisabled();
    await expect(t(page, "repos-dial-source")).toHaveText("Set by the Cautious preset.");
    await expect(t(page, "repos-dial-admin-only")).toHaveText("Only owners and admins can change this.");
    expect(mock.dialPuts).toEqual([]);
    await clean(page, errors);
  });
});

// ── Runs: the open run ───────────────────────────────────────────────────────────────────────────────
test.describe("D#6 R2b-4b: Runs app, approval", () => {
  const APP = `#windows-container .fulc-window[data-app-id="runs"]`;
  const t = (page: Page, id: string) => page.locator(`${APP} [data-testid="${id}"]`);
  const openRun = async (page: Page) => {
    await open(page, "runs");
    await expect(t(page, "runs-row")).toHaveCount(1);
    await press(t(page, "runs-row").first());
    await expect(t(page, "runs-head")).toBeVisible();
  };

  test("a run with no work item that this person may approve: the line, one Approve run button, one POST, then the done sentence", async ({ page }) => {
    const { mock, errors } = await setup(page, { runs: [run(RUN_A)], approvals: [entry(RUN_A)] });
    await openRun(page);
    await expect(t(page, "runs-approval-line")).toHaveText(COPY.approvalMine);
    const btn = t(page, "runs-approve");
    await expect(btn).toHaveText("Approve run");
    await expect(btn).toHaveAttribute("aria-label", "Approve run: fulcrumaxe executor");
    await btn.dblclick();
    await expect(t(page, "runs-approval-note")).toHaveText(COPY.approvalDone);
    expect(mock.approvePosts).toEqual([RUN_A]);
    await expect(t(page, "runs-approve")).toHaveCount(0);
    await clean(page, errors);
  });

  test("a 409 shows the refusal sentence, not the server's, and the button goes with the entry", async ({ page }) => {
    const { mock, errors } = await setup(page, { runs: [run(RUN_A)], approvals: [entry(RUN_A)], approveStatus: 409 });
    await openRun(page);
    mock.approvals = [];
    await press(t(page, "runs-approve"));
    await expect(t(page, "runs-approval-note")).toHaveText(COPY.approvalRefused);
    await expect(t(page, "runs-approve")).toHaveCount(0);
    await clean(page, errors);
  });

  test("a run that belongs to a work item says it is waiting but has no button here", async ({ page }) => {
    const { mock, errors } = await setup(page, { runs: [run(RUN_A, { work_item_id: ITEM })], approvals: [entry(RUN_A, { work_item_id: ITEM })] });
    await openRun(page);
    await expect(t(page, "runs-approval-line")).toHaveText(COPY.approvalMine);
    await expect(t(page, "runs-approve")).toHaveCount(0);
    expect(mock.approvePosts).toEqual([]);
    await clean(page, errors);
  });

  test("somebody else's wait names them and shows no button", async ({ page }) => {
    const { errors } = await setup(page, { runs: [run(RUN_A)], approvals: [entry(RUN_A, { can_approve: false, approvers: [{ id: "66666666-6666-4666-8666-666666666666", name: "Bo Builder" }] })] });
    await openRun(page);
    await expect(t(page, "runs-approval-line")).toHaveText("Waiting for Bo Builder to approve (it runs on their Claude plan).");
    await expect(t(page, "runs-approve")).toHaveCount(0);
    await clean(page, errors);
  });

  test("a pending run no runner covers (not in the approvals) shows no approval block", async ({ page }) => {
    const { errors } = await setup(page, { runs: [run(RUN_A)], approvals: [entry(RUN_B)] });
    await openRun(page);
    await expect(t(page, "runs-approval")).toHaveCount(0);
    await clean(page, errors);
  });

  test("a run the claim approved by itself says whose plan it used", async ({ page }) => {
    const { errors } = await setup(page, { runs: [run(RUN_C, { status: "running", approval: "auto", approved_by: { id: ME, name: "Ada Admin" } })] });
    await openRun(page);
    await expect(t(page, "runs-approval-line")).toHaveText("Approved automatically. It runs on Ada Admin's Claude plan.");
    await expect(t(page, "runs-approve")).toHaveCount(0);
    await clean(page, errors);
  });
});

// ── Pipeline: the Runs section and the card ─────────────────────────────────────────────────────────
test.describe("D#6 R2b-4b: Pipeline app, approval", () => {
  const APP = `#windows-container .fulc-window[data-app-id="pipeline"]`;
  const t = (page: Page, id: string) => page.locator(`${APP} [data-testid="${id}"]`);
  const openItem = async (page: Page, rows = 1) => {
    await open(page, "pipeline");
    await expect(t(page, "pl-card")).toHaveCount(1);
    await press(t(page, "pl-card").first());
    await expect(t(page, "pl-run")).toHaveCount(rows);
  };
  const mine = (id: string, over: Record<string, unknown> = {}) => run(id, { work_item_id: ITEM, ...over });

  test("a run waiting for this person: the line, the card label, one Approve run button and one POST, then the done sentence", async ({ page }) => {
    const { mock, errors } = await setup(page, { runs: [mine(RUN_A)], approvals: [entry(RUN_A, { work_item_id: ITEM })] });
    await openItem(page);
    await expect(t(page, "pl-run-approval")).toHaveText(COPY.approvalMine);
    await expect(t(page, "pl-pending")).toHaveText(COPY.approvalMine);
    const btn = t(page, "pl-approve-run");
    await expect(btn).toHaveAttribute("aria-label", "Approve run: executor");
    await expect(btn).toHaveText("Approve run");
    await btn.dblclick();
    await expect(t(page, "pl-run-approval-note")).toHaveText(COPY.approvalDone);
    expect(mock.approvePosts).toEqual([RUN_A]);
    await expect(t(page, "pl-approve-run")).toHaveCount(0);
    await expect(t(page, "pl-pending")).toHaveCount(0);
    await clean(page, errors);
  });

  test("a refusal (403) shows the sentence and the button is gone once the read no longer lists it", async ({ page }) => {
    const { mock, errors } = await setup(page, { runs: [mine(RUN_A)], approvals: [entry(RUN_A, { work_item_id: ITEM })], approveStatus: 403 });
    await openItem(page);
    mock.approvals = [];
    await press(t(page, "pl-approve-run"));
    await expect(t(page, "pl-run-approval-note")).toHaveText(COPY.approvalRefused);
    await expect(t(page, "pl-approve-run")).toHaveCount(0);
    await clean(page, errors);
  });

  test("somebody else's wait names them on the row and the card, and offers no button", async ({ page }) => {
    const { mock, errors } = await setup(page, { runs: [mine(RUN_A)], approvals: [entry(RUN_A, { work_item_id: ITEM, can_approve: false, approvers: [{ id: "66666666-6666-4666-8666-666666666666", name: "Bo Builder" }] })] });
    await openItem(page);
    const words = "Waiting for Bo Builder to approve (it runs on their Claude plan).";
    await expect(t(page, "pl-run-approval")).toHaveText(words);
    await expect(t(page, "pl-pending")).toHaveText(words);
    await expect(t(page, "pl-approve-run")).toHaveCount(0);
    expect(mock.approvePosts).toEqual([]);
    await clean(page, errors);
  });

  test("a pending run no runner covers (not in the approvals) shows nothing extra", async ({ page }) => {
    const { errors } = await setup(page, { runs: [mine(RUN_A)], approvals: [] });
    await openItem(page);
    await expect(t(page, "pl-run-approval")).toHaveCount(0);
    await expect(t(page, "pl-approve-run")).toHaveCount(0);
    await expect(t(page, "pl-pending")).toHaveCount(0);
    await clean(page, errors);
  });

  test("a run approved automatically names whose plan it used; the work item's own Approve button is untouched", async ({ page }) => {
    const { mock, errors } = await setup(page, { runs: [mine(RUN_C, { status: "succeeded", approval: "auto", approved_by: { id: ME, name: "Ada Admin" } })] });
    await openItem(page);
    await expect(t(page, "pl-run-approval")).toHaveText("Approved automatically. It runs on Ada Admin's Claude plan.");
    await expect(t(page, "pl-approve-run")).toHaveCount(0);
    expect(mock.requests).not.toContain("GET /api/runners/approvals"); // nothing is pending: the approvals are not read
    await clean(page, errors);
  });
});
