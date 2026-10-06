// apps/workspace/e2e/roles-spend.spec.ts
//
// The Roles window's expected-spend line follows the model and the mode that
// are selected, and the figure comes from the server (the app shows its text
// and computes nothing). The mocked half lives in roles.spec.ts; it proves the
// app shows whatever the PATCH answer says. This file is the other half: the
// real apps/web on real Postgres, so the figure is the one the server worked
// out, and a server that priced every role at its default model would fail here.
//
// Opt-in, skipped unless ROLES_SPEND_LIVE_BASE_URL is set. Same environment as
// roles-limits.spec.ts's live group: FX_ENABLE_TEST_AUTH=1, a non-production
// NODE_ENV, FX_SESSION_SECRET, DATABASE_URL_APP_USER and DATABASE_URL_PLATFORM_OPS
// in this process too, and `next start -p <port>` with no `-H`, served on
// http://localhost:<port>. Then:
//   ROLES_SPEND_LIVE_BASE_URL=http://localhost:<port> \
//     pnpm --filter workspace exec playwright test e2e/roles-spend.spec.ts

import pg from "pg";
import { test, expect, type Page } from "@playwright/test";
import { seedAccountStatus } from "./seed-account-status.mjs";

const LIVE = process.env.ROLES_SPEND_LIVE_BASE_URL;
const WIN = `#windows-container .fulc-window[data-app-id="roles"]`;
const row = (page: Page, role: string) => page.locator(`${WIN} [data-role="${role}"]`);
const spend = (page: Page, role: string) => row(page, role).locator('[data-testid="roles-spend"]');
const modelSelect = (page: Page, role: string) => row(page, role).locator('[data-testid="roles-model-select"]');
const modeSelect = (page: Page, role: string) => row(page, role).locator('[data-testid="roles-mode"]');
const line = (usd: string) => `expected spend on your model bill: $${usd}/month`;

const ident = () => {
  const id = 900_000_000 + Math.floor(Math.random() * 90_000_000);
  return { id, email: `rs-${id}@example.test`, login: `rs-${id}` };
};

/** One installed repo for the account, written as app_user inside the account's own tenant scope. */
async function seedInstalledRepo(accountId: string) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP_USER });
  try {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
      const inst = await c.query(
        "INSERT INTO installations (account_id, gh_installation_id, app_kind) VALUES ($1, $2, 'team') RETURNING id",
        [accountId, Math.floor(Math.random() * 1e9)]
      );
      await c.query(
        "INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'web', 'spend-co', 'spend-repo')",
        [accountId, inst.rows[0].id, Math.floor(Math.random() * 1e9)]
      );
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  } finally {
    await pool.end();
  }
}

test.describe("Roles expected spend (live: real Postgres, next start)", () => {
  test.skip(!LIVE, "ROLES_SPEND_LIVE_BASE_URL not set -- opt-in, see this file's header comment");
  test.use({ baseURL: LIVE });

  test("choosing a model, and then a mode, changes the spend line with no reload", async ({ page }) => {
    const who = ident();
    const { accountId } = await seedAccountStatus({ githubUserId: who.id, email: who.email, login: who.login, status: "active" });
    await seedInstalledRepo(accountId);

    await page.goto(`/api/auth/test/callback?githubUserId=${who.id}&email=${who.email}&login=${who.login}`);
    await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, { timeout: 20_000 });
    await page.evaluate(() => {
      (window as unknown as { __kept: boolean }).__kept = true;
      (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("roles");
    });
    await expect(row(page, "code-reviewer")).toBeVisible();
    const kept = () => page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept === true);

    // A new repo has every role off; the code reviewer runs on every qualifying work item
    // once switched to "always" (14 runs a month on the starter plan) and follows the table's Sonnet.
    await expect(spend(page, "code-reviewer")).toHaveText(line("0.00"));
    await modeSelect(page, "code-reviewer").selectOption("always");
    await expect(spend(page, "code-reviewer")).toHaveText(line("210.00"));

    await modelSelect(page, "code-reviewer").selectOption("haiku-4.5");
    await expect(spend(page, "code-reviewer")).toHaveText(line("56.00"));
    await modelSelect(page, "code-reviewer").selectOption("opus-5");
    await expect(spend(page, "code-reviewer")).toHaveText(line("490.00"));
    await modelSelect(page, "code-reviewer").selectOption("");
    await expect(spend(page, "code-reviewer")).toHaveText(line("210.00"));

    await modeSelect(page, "code-reviewer").selectOption("off");
    await expect(spend(page, "code-reviewer")).toHaveText(line("0.00"));

    // The security reviewer follows the table at Opus and cannot go below its floor.
    await modeSelect(page, "security-reviewer").selectOption("always");
    await expect(spend(page, "security-reviewer")).toHaveText(line("490.00"));
    await modelSelect(page, "security-reviewer").selectOption("sonnet-5");
    await expect(spend(page, "security-reviewer")).toHaveText(line("210.00"));

    await expect(spend(page, "code-reviewer")).toHaveAttribute("title", /estimate based on the selected model/);
    await expect(page.locator(`${WIN} [data-testid="roles-spend"]`).first()).not.toContainText(/null|undefined|NaN/);
    expect(await kept()).toBe(true);
  });
});
