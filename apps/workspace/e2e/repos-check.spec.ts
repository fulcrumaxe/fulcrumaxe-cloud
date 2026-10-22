// apps/workspace/e2e/repos-check.spec.ts
//
// D#6 R-CHK-3c: the Repos app's check command form on the built cloud dist, at the desktop, tablet and phone projects. The sandbox-allowances
// route is a strict stand-in for runner-cloud's sandboxAllowances.ts: it takes exactly { set, confirm_repo? }, reads `set` with the same bounds,
// asks for the repo's full name when the set has entries or a check (400 confirmation_mismatch), refuses a repo off the runner (409
// not_runner_local), replaces the WHOLE set (so a body without `check` removes it), and answers the view with `changed`. Members get no
// suggested_check, as in the real GET. What it cannot reproduce: the floor on entries and the database (the pg tests cover those).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { bootToDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const REPOS = readFixture("listRepos", "200-page.json");
const SETTINGS = readFixture("getRepoSettings", "200-ok.json");
const WEB = REPOS.data[0].id as string;
const NAME = "acme/widgets";
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const APP = `#windows-container .fulc-window[data-app-id="repos"]`;
const tid = (page: Page, id: string) => page.locator(`${APP} [data-testid="${id}"]`);

type Check = { argv: string[]; dev_shell: boolean; timeout_s: number };
const A = { kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "install packages" };
const CHECK: Check = { argv: ["bash", "scripts/check.sh"], dev_shell: true, timeout_s: 5400 };
const approvedAt = "2026-10-09T00:00:00.000Z";

interface World { check: Check | null; entries: unknown[]; timeout: number | null; version: number; setAside: boolean; mode: string; canChange: boolean; suggested: unknown }
const world = (over: Partial<World> = {}): World => ({ check: null, entries: [], timeout: null, version: 0, setAside: false, mode: "runner_local", canChange: true, suggested: { status: "none" }, ...over });
const viewOf = (w: World) => ({
  repo_id: WEB, execution_mode: w.mode, in_use: !w.setAside && w.mode === "runner_local" && (w.entries.length > 0 || w.check !== null), set_aside: w.setAside, can_change: w.canChange,
  approved: w.version === 0 ? null : { version: w.version, entries: w.entries, command_timeout_s: w.timeout, check: w.check, set_sha256: "ab".repeat(32), approved_at: approvedAt },
  limits: { max_entries: 64, max_command_timeout_s: 1800, max_check_timeout_s: 10800 },
  suggested_check: w.canChange ? w.suggested : null,
});
const ARG = /^[\x20-\x7e]{1,256}$/;
const validCheck = (c: unknown): c is Check => {
  const o = c as Check;
  return !!o && typeof o === "object" && Object.keys(o).sort().join() === "argv,dev_shell,timeout_s" && Array.isArray(o.argv) && o.argv.length >= 1 && o.argv.length <= 16 && o.argv.every((a) => typeof a === "string" && ARG.test(a)) &&
    typeof o.dev_shell === "boolean" && Number.isInteger(o.timeout_s) && o.timeout_s >= 60 && o.timeout_s <= 10800;
};

async function setup(page: Page, w: World, runners: unknown[] = [], runnersGate: Promise<void> = Promise.resolve()) {
  const appErrors: string[] = [];
  const puts: unknown[] = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && appErrors.push(m.text()));
  page.on("pageerror", (e) => appErrors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective}`)));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: true } });
  });
  await page.route("**/api/v1/repos**", (route) => json(route, 200, new URL(route.request().url()).pathname.endsWith("/settings") ? SETTINGS : REPOS));
  await page.route("**/api/runners", async (route) => { await runnersGate; await json(route, 200, { runners, copy: {} }); });
  await page.route("**/api/runners/repos/*/sandbox-allowances", async (route) => {
    const req = route.request();
    if (req.method() === "GET") return json(route, 200, viewOf(w));
    const body = JSON.parse(req.postData() ?? "null");
    puts.push(body);
    const bad = () => json(route, 400, { error: { code: "invalid_message", message: "the request does not match what this route takes" } });
    if (!w.canChange) return json(route, 403, { error: { code: "forbidden", message: "only an owner or admin can change this" } });
    if (!body || typeof body !== "object" || !["set", "confirm_repo,set"].includes(Object.keys(body).sort().join())) return bad();
    const set = body.set;
    if (!set || typeof set !== "object" || !Object.keys(set).every((k) => ["entries", "command_timeout_s", "check"].includes(k)) || !Array.isArray(set.entries)) return bad();
    if (set.check !== undefined && set.check !== null && !validCheck(set.check)) return json(route, 400, { error: { code: "sandbox_allowance_refused", message: "refused" }, reason: "invalid_shape", index: null });
    if (set.entries.length > 0 && set.command_timeout_s === undefined) return json(route, 400, { error: { code: "sandbox_allowance_refused", message: "refused" }, reason: "entries_without_timeout", index: null });
    if (set.entries.length > 0 || set.check) {
      if (body.confirm_repo !== NAME) return json(route, 400, { error: { code: "confirmation_mismatch", message: "type the repository's full name to confirm" } });
      if (w.mode !== "runner_local") return json(route, 409, { error: { code: "not_runner_local", message: "allowances are for repositories on a runner" } });
    }
    const next = JSON.stringify([set.entries, set.command_timeout_s ?? null, set.check ?? null]);
    const changed = w.setAside || next !== JSON.stringify([w.entries, w.timeout, w.check]);
    if (changed) Object.assign(w, { entries: set.entries, timeout: set.command_timeout_s ?? null, check: set.check ?? null, version: w.version + 1, setAside: false });
    return json(route, 200, { ...viewOf(w), changed });
  });
  await bootToDesktop(page);
  await page.locator('.dock-icon[data-app-id="repos"]').click();
  await expect(page.locator(APP)).toBeVisible();
  await tid(page, "repos-open").first().click();
  await expect(tid(page, "repos-check")).toBeVisible();
  return { puts, appErrors };
}

const axe = async (page: Page) => {
  const res = await new AxeBuilder({ page }).include(`${APP} [data-testid="repos-allow"]`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
};

test.describe("D#6 R-CHK-3c: check command form (mocked API)", () => {
  test("none: says nothing is approved, offers Add a check, and a new check needs every field and the typed name", async ({ page }) => {
    const { puts, appErrors } = await setup(page, world());
    await expect(tid(page, "repos-check-none")).toHaveText("No check is approved. A runner won't run a check after the agent.");
    await axe(page);
    await tid(page, "repos-check-add").click();
    await expect(tid(page, "repos-check-approve")).toBeDisabled();
    await tid(page, "repos-check-input").first().fill("bash");
    await tid(page, "repos-check-name").fill(NAME);
    await expect(tid(page, "repos-check-approve")).toBeEnabled();
    await tid(page, "repos-check-timeout").fill("59");
    await expect(tid(page, "repos-check-problem")).toHaveText("The time limit must be 60 to 10800 seconds.");
    await expect(tid(page, "repos-check-approve")).toBeDisabled();
    await tid(page, "repos-check-timeout").fill("600");
    await tid(page, "repos-check-approve").click();
    await expect(tid(page, "repos-check-done")).toHaveText("Approved. It applies from the next job.");
    expect(puts).toEqual([{ set: { entries: [], check: { argv: ["bash"], dev_shell: true, timeout_s: 600 } }, confirm_repo: NAME }]);
    await expect(tid(page, "repos-check-approved").locator("li")).toHaveCount(1);
    expect(appErrors).toEqual([]);
  });

  test("suggested: names its source, shows nothing to approve until reviewed, shows every argument with spaces marked, and approves only after the name", async ({ page }) => {
    const sug = { argv: [" bash", "scripts/check.sh ", "   "], dev_shell: false, timeout_s: 3600 };
    const w = world({ suggested: { status: "ok", check: sug } });
    const { puts, appErrors } = await setup(page, w);
    await expect(tid(page, "repos-check-source")).toContainText("default branch tip, which an agent can edit");
    await expect(tid(page, "repos-check-approve")).toHaveCount(0);
    await axe(page);
    await tid(page, "repos-check-review-btn").click();
    await expect(tid(page, "repos-check-source")).toBeVisible();
    await expect(tid(page, "repos-check-draft").locator("[data-testid=repos-check-arg]")).toHaveText(['"␣bash"', '"scripts/check.sh␣"', '"␣␣␣"']);
    await expect(tid(page, "repos-check-approve")).toBeDisabled();
    await axe(page);
    await tid(page, "repos-check-name").fill(NAME);
    await tid(page, "repos-check-approve").click();
    await expect(tid(page, "repos-check-done")).toBeVisible();
    expect(puts).toEqual([{ set: { entries: [], check: sug }, confirm_repo: NAME }]);
    expect(appErrors).toEqual([]);
  });

  test("an unreadable suggestion says so in the app's own words", async ({ page }) => {
    await setup(page, world({ suggested: { status: "unreadable", message: "SERVER TEXT" } }));
    await expect(tid(page, "repos-check-note")).toHaveText("The check in .fulcrumaxe/runner-sandbox.json could not be read.");
    await expect(page.locator(APP)).not.toContainText("SERVER TEXT");
  });

  test("approved: shows the check; an edit sends the whole set with the entries kept; a wrong name never leaves the page as a send", async ({ page }) => {
    const w = world({ check: CHECK, entries: [A], timeout: 600, version: 2 });
    const { puts, appErrors } = await setup(page, w);
    await expect(tid(page, "repos-check-state")).toHaveText("Approved. A runner runs it after the agent finishes.");
    await expect(tid(page, "repos-check-approved").locator("li")).toHaveCount(2);
    await axe(page);
    await tid(page, "repos-check-edit").click();
    await tid(page, "repos-check-timeout").fill("7200");
    await tid(page, "repos-check-name").fill("acme/widget");
    await expect(tid(page, "repos-check-approve")).toBeDisabled();
    await tid(page, "repos-check-name").fill(NAME);
    await tid(page, "repos-check-approve").click();
    await expect(tid(page, "repos-check-done")).toBeVisible();
    expect(puts).toEqual([{ set: { entries: [A], command_timeout_s: 600, check: { ...CHECK, timeout_s: 7200 } }, confirm_repo: NAME }]);
    expect(w.check?.timeout_s).toBe(7200);
    expect(appErrors).toEqual([]);
  });

  test("remove asks first; Keep it sends nothing; Remove the check sends the set without it", async ({ page }) => {
    const w = world({ check: CHECK, entries: [A], timeout: 600, version: 2 });
    const { puts } = await setup(page, w);
    await tid(page, "repos-check-remove").click();
    await expect(tid(page, "repos-check-remove-ask")).toBeVisible();
    await axe(page);
    await tid(page, "repos-check-remove-no").click();
    expect(puts).toEqual([]);
    await tid(page, "repos-check-remove").click();
    await tid(page, "repos-check-remove-yes").click();
    await expect(tid(page, "repos-check-done")).toHaveText("The check is removed. It applies from the next job.");
    expect(puts).toEqual([{ set: { entries: [A], command_timeout_s: 600 }, confirm_repo: NAME }]);
    await expect(tid(page, "repos-check-none")).toBeVisible();
  });

  test("set aside: the check reads as not in force, and approving the same check again is allowed", async ({ page }) => {
    const w = world({ check: CHECK, version: 1, setAside: true, mode: "runner_local" });
    const { puts } = await setup(page, w);
    await expect(tid(page, "repos-check-state")).toHaveText("The approved check is set aside because this repo left the runner. Approve it again before it applies.");
    await tid(page, "repos-check-edit").click();
    await tid(page, "repos-check-name").fill(NAME);
    await expect(tid(page, "repos-check-approve")).toBeEnabled();
    await tid(page, "repos-check-approve").click();
    await expect(tid(page, "repos-check-done")).toBeVisible();
    expect(puts).toHaveLength(1);
    await expect(tid(page, "repos-check-state")).toHaveText("Approved. A runner runs it after the agent finishes.");
  });

  test("runner too old: an approved check with every covering runner outdated says to update the runner", async ({ page }) => {
    const runner = { id: "run-1", credential_mode: "subscription", state: "outdated", registered_by: { id: "u1", name: "Sam" }, repos: [{ id: WEB, name: NAME }] };
    await setup(page, world({ check: CHECK, version: 1 }), [runner]);
    await expect(tid(page, "repos-check-runner-old")).toHaveText("Update your runner to run this repository's check.");
    await axe(page);
  });

  test("argument remove buttons are named by their number", async ({ page }) => {
    await setup(page, world({ check: CHECK, version: 1 }));
    await tid(page, "repos-check-edit").click();
    await expect(tid(page, "repos-check-drop-arg")).toHaveCount(2);
    await expect(tid(page, "repos-check-drop-arg").nth(0)).toHaveAttribute("aria-label", "Remove argument 1");
    await expect(tid(page, "repos-check-drop-arg").nth(1)).toHaveAttribute("aria-label", "Remove argument 2");
  });

  test("runners data arriving mid-draft repaints without dropping focus, the caret or what was typed", async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const runner = { id: "run-1", credential_mode: "subscription", state: "outdated", registered_by: { id: "u1", name: "Sam" }, repos: [{ id: WEB, name: NAME }] };
    await setup(page, world({ check: CHECK, version: 1 }), [runner], gate);
    await tid(page, "repos-check-edit").click();
    const second = tid(page, "repos-check-input").nth(1);
    await second.click();
    await second.fill("scripts/other.sh");
    await expect(second).toBeFocused();
    release();
    await expect(tid(page, "repos-check-runner-old")).toBeVisible(); // the repaint happened
    const again = tid(page, "repos-check-input").nth(1);
    await expect(again).toBeFocused();
    await expect(again).toHaveValue("scripts/other.sh");
    await page.keyboard.type("x");
    await expect(again).toHaveValue("scripts/other.shx");
  });

  test("a member sees the approved check read-only: no buttons, no suggestion", async ({ page }) => {
    await setup(page, world({ check: CHECK, version: 1, canChange: false }));
    await expect(tid(page, "repos-check-approved").locator("li")).toHaveCount(2);
    await expect(tid(page, "repos-check-admin-only")).toHaveText("Only owners and admins can change this.");
    for (const id of ["repos-check-edit", "repos-check-remove", "repos-check-add", "repos-check-review-btn"]) await expect(tid(page, id)).toHaveCount(0);
    await axe(page);
  });

  test("a repo off the runner cannot approve a check, and says why", async ({ page }) => {
    await setup(page, world({ mode: "cloud" }));
    await tid(page, "repos-check-add").click();
    await tid(page, "repos-check-input").first().fill("bash");
    await tid(page, "repos-check-name").fill(NAME);
    await expect(tid(page, "repos-check-not-runner")).toHaveText("This repo doesn't run on a runner, so a check can't be approved.");
    await expect(tid(page, "repos-check-approve")).toBeDisabled();
  });

  test("uploading a file over an approved check says it removes the check and needs the name; the PUT drops it", async ({ page }) => {
    const w = world({ check: CHECK, entries: [A], timeout: 600, version: 2 });
    const { puts, appErrors } = await setup(page, w);
    await tid(page, "repos-allow-file").setInputFiles({ name: "runner-sandbox.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ entries: [A], command_timeout_s: 600, check: CHECK })) });
    await expect(tid(page, "repos-allow-drops-check")).toContainText("Approving it removes the approved check");
    await expect(tid(page, "repos-allow-approve")).toBeDisabled();
    await axe(page);
    await tid(page, "repos-allow-name").fill(NAME);
    await tid(page, "repos-allow-approve").click();
    await expect(tid(page, "repos-allow-done")).toBeVisible();
    expect(puts).toEqual([{ set: { entries: [A], command_timeout_s: 600 }, confirm_repo: NAME }]);
    await expect(tid(page, "repos-check-none")).toBeVisible();
    expect(appErrors).toEqual([]);
  });
});
