// D#3 K07b-2: the Site review app against inline mocks of the site-version routes.

import { test, expect, type Page, type Route } from "@playwright/test";

const ID = "11111111-1111-4111-8111-111111111111";
const CLAIM = "22222222-2222-4222-8222-222222222222";
const A = "https://a.example/docs";
const B = "https://b.example/";
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="site-review"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const isApproved = (versions: Record<string, unknown[]>, id: string) =>
  Object.values(versions).some((rows) => rows.some((r) => (r as { version_id: string; review_state: string }).version_id === id && (r as { review_state: string }).review_state !== "pending"));
const REVIEW = () => ({
  version_id: ID,
  approved: false,
  report: {
    version: 1,
    versionId: ID,
    counts: { verified: 3, unverified: 1, total: 4 },
    // Stored gates blockers do not disable Approve (the server re-runs them).
    blockers: [{ source: "gates", reason: "gates-not-run", detail: "no result" }],
    evidence: [{ claimId: CLAIM, path: "LICENSE", sha: "abc", text: "traced to commit abc on 2026-01-02" }],
    ok: false,
  },
  pending_links: [A, B],
  claims: [{ claim_id: CLAIM, claim_key: "license", locale: "en", kind: "legal", text: "MIT licensed", attested: false }],
});

interface Seen { failGets?: boolean; gets: number; getIds: string[]; lists: string[]; posts: { kind: string; body: Record<string, unknown> }[]; appErrors: string[] }

interface Lists {
  /** Rows of GET /api/v1/sites. The default is an account with no sites. */
  sites?: { id: string; domain: string | null; repo_full_name: string | null }[];
  /** Rows of GET /api/v1/sites/{id}/versions, by site id. */
  versions?: Record<string, unknown[]>;
  /** Answer GET /api/v1/sites with this status (and a Retry-After of 7) instead of the rows. */
  listStatus?: number;
  /** Version ids whose review read is a 404. */
  missing?: string[];
}

async function boot(
  page: Page,
  o: Lists & { admin?: boolean; launchArg?: unknown; noOpen?: boolean; review?: () => unknown; post?: (route: Route, kind: string, seen: Seen) => Promise<void> | void } = {}
) {
  const seen: Seen = { gets: 0, getIds: [], lists: [], posts: [], appErrors: [] };
  const state = { review: (o.review ?? REVIEW)() as ReturnType<typeof REVIEW> };
  page.on("pageerror", (e) => seen.appErrors.push(e.message));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: !!o.admin } });
  });
  await page.route((u) => u.pathname === "/api/v1/sites" || /^\/api\/v1\/sites\/[^/]+\/versions$/.test(u.pathname), async (route) => {
    const path = new URL(route.request().url()).pathname;
    seen.lists.push(path);
    if (path === "/api/v1/sites") {
      if (o.listStatus) return route.fulfill({ status: o.listStatus, headers: { "retry-after": "7" }, contentType: "application/json", body: JSON.stringify({ error: { code: "x", message: "RAW SERVER TEXT" } }) });
      return json(route, 200, { data: o.sites ?? [], next_cursor: null });
    }
    const siteId = path.split("/")[4]!;
    return json(route, 200, { data: o.versions?.[siteId] ?? [], next_cursor: null });
  });
  await page.route("**/api/v1/site-versions/**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      seen.gets++;
      const id = new URL(req.url()).pathname.split("/")[4]!;
      seen.getIds.push(id);
      if (o.missing?.includes(id)) return json(route, 404, { error: { code: "not_found", message: "site version not found" } });
      if (seen.failGets) return json(route, 500, { error: { code: "boom", message: "internal" } });
      return json(route, 200, { ...state.review, version_id: id, approved: state.review.approved || (o.versions ? isApproved(o.versions, id) : false) });
    }
    const kind = new URL(req.url()).pathname.split("/").pop()!;
    seen.posts.push({ kind, body: req.postDataJSON() });
    if (o.post) return o.post(route, kind, seen);
    return json(route, 200, kind === "approve" ? { approved_at: "2026-01-01T00:00:00Z", approved_links: [] } : { created: true, carried: [] });
  });
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  const signedIn = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/cloud/auth/me");
  await page.goto("/");
  await signedIn;
  await expect
    .poll(
      async () => {
        await page.clock.runFor(5_000);
        return page.evaluate(() => (window as unknown as { currentStep?: string }).currentStep);
      },
      { timeout: 30_000 }
    )
    .toBe("DESKTOP");
  if (o.noOpen) return { seen, state };
  await page.evaluate(
    (arg) => (window as unknown as { FULCWM: { open: (id: string, arg?: unknown) => void } }).FULCWM.open("site-review", arg),
    o.launchArg
  );
  await expect(page.locator(WIN)).toBeVisible();
  return { seen, state };
}

async function openId(page: Page, id = ID) {
  await tid(page, "sr-id").fill(id);
  await tid(page, "sr-open").click();
}

test("an admin reads the report, attests, ticks links and terms, and approves only the ticked links", async ({ page }) => {
  const { seen, state } = await boot(page, { admin: true });
  await openId(page);
  await expect(tid(page, "sr-counts")).toContainText("verified: 3");
  await expect(tid(page, "sr-evidence")).toHaveText("traced to commit abc on 2026-01-02");
  await expect(tid(page, "sr-claims")).toContainText("MIT licensed");
  // Links start unticked and Approve is off.
  await expect(tid(page, `sr-link-${A}`)).not.toBeChecked();
  await expect(tid(page, `sr-link-${B}`)).not.toBeChecked();
  await expect(tid(page, "sr-approve")).toBeDisabled();
  expect(seen.gets).toBe(1);
  // The attest click is one POST, then the report is read again.
  state.review.claims[0].attested = true;
  await tid(page, `sr-attest-${CLAIM}`).click();
  await expect(tid(page, `sr-attest-${CLAIM}`)).toHaveCount(0);
  expect(seen.posts).toEqual([{ kind: "attest", body: { claim_id: CLAIM } }]);
  expect(seen.gets).toBe(2);
  await expect(tid(page, "sr-terms")).toBeVisible();
  await expect(page.locator(`${WIN} label:has([data-testid="sr-terms"])`)).toContainText("I am the publisher of this site");
  await tid(page, "sr-terms").check();
  await tid(page, `sr-link-${A}`).check();
  await expect(tid(page, "sr-approve")).toBeDisabled();
  await tid(page, `sr-link-${B}`).check();
  await expect(tid(page, "sr-approve")).toBeEnabled();
  state.review.approved = true;
  await tid(page, "sr-approve").click();
  await expect(tid(page, "sr-status")).toHaveText("Approved. Publishing is a separate step.");
  expect(seen.posts[1]).toEqual({ kind: "approve", body: { terms_accepted: true, approved_links: [A, B] } });
  await expect(tid(page, "sr-heading")).toHaveText("Approved");
  await expect(tid(page, "sr-approve")).toHaveCount(0);
  await expect(page.locator(WIN)).not.toContainText(/guaranteed|warranty/i);
  expect(seen.appErrors).toEqual([]);
});

test("a 409 shows a fixed sentence, never the server's text, and reads the report again", async ({ page }) => {
  const { seen, state } = await boot(page, {
    admin: true,
    review: () => ({ ...REVIEW(), claims: [{ ...REVIEW().claims[0], attested: true }] }),
    post: (route) => json(route, 409, { error: { code: "unapproved_link", message: "RAW SERVER TEXT /etc/passwd" } }),
  });
  await openId(page);
  await tid(page, "sr-terms").check();
  await tid(page, `sr-link-${A}`).check();
  await tid(page, `sr-link-${B}`).check();
  // The server has moved on: a third link appeared since the report was read.
  state.review.pending_links = [A, B, "https://c.example/"];
  const before = seen.gets;
  await tid(page, "sr-approve").click();
  await expect(tid(page, "sr-status")).toHaveText("Some outbound links still need your approval.");
  await expect(page.locator(WIN)).not.toContainText("RAW SERVER TEXT");
  expect(seen.gets).toBe(before + 1);
  await expect(tid(page, "sr-links").locator("input")).toHaveCount(3);
  await expect(tid(page, "sr-link-https://c.example/")).not.toBeChecked();
  await expect(tid(page, "sr-approve")).toBeDisabled();
});

for (const [code, sentence] of [
  ["check_failed", "The site didn't pass every check, so it can't be approved yet."],
  ["browser_driver_missing", "Approval can't finish until the browser checks can run in production."],
] as const) {
  test(`a ${code} refusal shows its own fixed sentence and never disables Approve`, async ({ page }) => {
    await boot(page, {
      admin: true,
      review: () => ({ ...REVIEW(), claims: [{ ...REVIEW().claims[0], attested: true }] }),
      post: (route) => json(route, 409, { error: { code, message: "RAW SERVER TEXT" } }),
    });
    await openId(page);
    await tid(page, "sr-terms").check();
    await tid(page, `sr-link-${A}`).check();
    await tid(page, `sr-link-${B}`).check();
    await tid(page, "sr-approve").click();
    await expect(tid(page, "sr-status")).toHaveText(sentence);
    await expect(page.locator(WIN)).not.toContainText("RAW SERVER TEXT");
    await expect(tid(page, "sr-approve")).toBeEnabled();
  });
}

test("a member reads the report but gets no attest, link, terms or approve control", async ({ page }) => {
  const { seen } = await boot(page, { admin: false });
  await openId(page);
  await expect(tid(page, "sr-counts")).toContainText("verified: 3");
  await expect(tid(page, "sr-readonly")).toBeVisible();
  await expect(page.locator(`${WIN} input[type=checkbox], ${WIN} [data-testid^="sr-attest"], ${WIN} [data-testid="sr-carry"]`)).toHaveCount(0);
  await expect(tid(page, "sr-approve")).toHaveCount(0);
  await expect(page.locator(`${WIN} [data-testid="sr-links"] .sr-link`)).toHaveCount(2);
  expect(seen.posts).toEqual([]);
});

test("a 403 on a write shows the owners-and-admins sentence", async ({ page }) => {
  await boot(page, { admin: true, post: (route) => json(route, 403, { error: { code: "forbidden", message: "insufficient account role" } }) });
  await openId(page);
  await tid(page, `sr-attest-${CLAIM}`).click();
  await expect(tid(page, "sr-status")).toHaveText("Only owners and admins can do that.");
});

test("a bad id is refused without a request; the last id is remembered", async ({ page }) => {
  const { seen } = await boot(page, { admin: true });
  await openId(page, "not-a-uuid");
  await expect(tid(page, "sr-status")).toHaveText("Enter a site version id (a UUID).");
  expect(seen.gets).toBe(0);
  await openId(page);
  await expect(tid(page, "sr-counts")).toBeVisible();
  await page.evaluate(() => (window as unknown as { FULCWM: { close: (id: string) => void } }).FULCWM.close("site-review"));
  await page.clock.runFor(1000);
  await expect(page.locator(WIN)).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("site-review"));
  await expect(tid(page, "sr-id")).toHaveValue(ID);
  await expect(tid(page, "sr-counts")).toBeVisible();
});

// The shell starts the live client from a boot mark the fake clock swallows, so the test starts it itself.
const startLive = (page: Page) =>
  page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).default.start());

test("a live refresh leaves focus on the control that had it", async ({ page }) => {
  const { seen } = await boot(page, { admin: true, review: () => ({ ...REVIEW(), claims: [{ ...REVIEW().claims[0], attested: true }] }) });
  await openId(page);
  await startLive(page);
  await tid(page, `sr-link-${A}`).check();
  await tid(page, "sr-terms").focus();
  await page.clock.runFor(11_000);
  const before = seen.gets;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => seen.gets).toBeGreaterThan(before);
  await expect(tid(page, "sr-terms")).toBeFocused();
  await expect(tid(page, `sr-link-${A}`)).toBeChecked();
});

test("when the re-read after a write fails, the write's sentence stays on screen", async ({ page }) => {
  await boot(page, {
    admin: true,
    post: (route, _kind, seen) => {
      seen.failGets = true;
      return json(route, 200, { created: true, carried: [] });
    },
  });
  await openId(page);
  await tid(page, `sr-attest-${CLAIM}`).click();
  await expect(tid(page, "sr-status")).toHaveText("Attestation saved. The review isn't available right now.");
});

test("a launch argument with a valid versionId opens that version's report without typing", async ({ page }) => {
  const { seen } = await boot(page, { admin: true, launchArg: { versionId: ID } });
  await expect(tid(page, "sr-counts")).toContainText("verified: 3");
  await expect(tid(page, "sr-id")).toHaveValue(ID);
  expect(seen.gets).toBe(1);
});

for (const [name, arg] of [
  ["a versionId that is not a UUID", { versionId: "not-a-uuid" }],
  ["a versionId that is not a string", { versionId: 5 }],
  ["an argument over the size cap", { versionId: ID, pad: "x".repeat(2000) }],
  ["an argument that is not a plain object", [ID]],
] as const) {
  test(`a launch argument with ${name} is ignored: nothing loads and the app stays usable`, async ({ page }) => {
    const { seen } = await boot(page, { admin: true, launchArg: arg });
    await expect(tid(page, "sr-id")).toHaveValue("");
    await expect(tid(page, "sr-status")).toHaveText(""); // ignored silently, not shown as a typing error
    expect(seen.gets).toBe(0);
    expect(seen.appErrors).toEqual([]);
    await openId(page);
    await expect(tid(page, "sr-counts")).toContainText("verified: 3");
  });
}

test("a launch argument that is a throwing Proxy is dropped and the app still opens", async ({ page }) => {
  const { seen } = await boot(page, { admin: true, noOpen: true });
  await page.evaluate(() => {
    const trap = () => { throw new Error("trap"); };
    const arg = new Proxy({}, { getPrototypeOf: trap, ownKeys: trap, get: trap, has: trap });
    (window as unknown as { FULCWM: { open: (id: string, arg?: unknown) => void } }).FULCWM.open("site-review", arg);
  });
  await expect(page.locator(WIN)).toBeVisible();
  await expect(tid(page, "sr-id")).toHaveValue("");
  expect(seen.gets).toBe(0);
  expect(seen.appErrors).toEqual([]);
});

// ── the picker ───────────────────────────────────────────────────────────────
const S1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const S2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const V1_APPROVED = "a0000001-0000-4000-8000-000000000001";
const V1_PENDING = "a0000002-0000-4000-8000-000000000002";
const V2_NEW_PENDING = "b0000001-0000-4000-8000-000000000003";
const V2_OLD = "b0000002-0000-4000-8000-000000000004";
const ver = (id: string, created_at: string, review_state: string, pending_links = 0, pending_claims = 0) => ({ version_id: id, created_at, review_state, pending_links, pending_claims });
const TWO_SITES: Lists = {
  sites: [
    { id: S2, domain: "second.example", repo_full_name: "acme/second" },
    { id: S1, domain: null, repo_full_name: "acme/first" },
  ],
  versions: {
    [S1]: [ver(V1_APPROVED, "2026-09-21T10:00:00.000Z", "approved"), ver(V1_PENDING, "2026-09-19T10:00:00.000Z", "pending", 1, 0)],
    [S2]: [ver(V2_NEW_PENDING, "2026-09-20T10:00:00.000Z", "pending", 2, 1), ver(V2_OLD, "2026-09-18T10:00:00.000Z", "approved")],
  },
};
const noJunk = async (page: Page) => {
  const text = await page.locator(WIN).innerText();
  expect(text).not.toMatch(/\b(undefined|null|NaN)\b/);
};

test("the picker lists sites and versions with their states and opens the newest version awaiting approval", async ({ page }) => {
  const { seen } = await boot(page, { admin: true, ...TWO_SITES });
  await expect(tid(page, "sr-counts")).toContainText("verified: 3");
  // Newest pending across both sites is the second site's newer version; the approved one on the first site is newer still but done.
  expect(seen.getIds).toEqual([V2_NEW_PENDING]);
  await expect(tid(page, "sr-site")).toHaveValue(S2);
  await expect(tid(page, "sr-version")).toHaveValue(V2_NEW_PENDING);
  await expect(tid(page, "sr-site").locator("option")).toHaveText(["second.example (acme/second)", "acme/first"]);
  await expect(tid(page, "sr-version").locator("option")).toHaveText([
    "2026-09-20 10:00 UTC - Awaiting approval - 2 links and 1 claim to review",
    "2026-09-18 10:00 UTC - Approved",
  ]);
  // Nothing in the window looks like a web address field.
  await expect(page.locator(`${WIN} input[type=url]`)).toHaveCount(0);
  await expect(page.locator(`${WIN} input[placeholder]`)).toHaveCount(0);
  await noJunk(page);
  // The picker never makes the window scroll sideways, on any screen size.
  const overflow = await page.locator(`${WIN} .sr-app`).evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Another site: its own newest pending version opens.
  await tid(page, "sr-site").selectOption(S1);
  await expect(tid(page, "sr-version")).toHaveValue(V1_PENDING);
  await expect.poll(() => seen.getIds[seen.getIds.length - 1]).toBe(V1_PENDING);
});

test("an approved version is shown as approved with no actions, for an admin", async ({ page }) => {
  await boot(page, { admin: true, ...TWO_SITES });
  await expect(tid(page, "sr-counts")).toBeVisible();
  await tid(page, "sr-site").selectOption(S1);
  await tid(page, "sr-version").selectOption(V1_APPROVED);
  await expect(tid(page, "sr-heading")).toHaveText("Approved");
  await expect(page.locator(`${WIN} input[type=checkbox], ${WIN} [data-testid^="sr-attest"], ${WIN} [data-testid="sr-carry"], ${WIN} [data-testid="sr-approve"]`)).toHaveCount(0);
});

test("the last choice is remembered over the default", async ({ page }) => {
  await boot(page, { admin: true, ...TWO_SITES });
  await expect(tid(page, "sr-version")).toHaveValue(V2_NEW_PENDING);
  await tid(page, "sr-version").selectOption(V2_OLD);
  await expect(tid(page, "sr-heading")).toHaveText("Approved");
  await page.evaluate(() => (window as unknown as { FULCWM: { close: (id: string) => void } }).FULCWM.close("site-review"));
  await page.clock.runFor(1000);
  await expect(page.locator(WIN)).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("site-review"));
  await expect(tid(page, "sr-version")).toHaveValue(V2_OLD);
  await expect(tid(page, "sr-site")).toHaveValue(S2);
});

test("no sites yet: a plain explanation, no start action, and the fallback is open", async ({ page }) => {
  const { seen } = await boot(page, { admin: true });
  await expect(tid(page, "sr-empty")).toHaveText("No sites yet. A site appears here once the site kit has built one for you.");
  await expect(tid(page, "sr-site")).toHaveCount(0);
  await expect(page.locator(`${WIN} a`)).toHaveCount(0);
  await expect(tid(page, "sr-id")).toBeVisible();
  expect(seen.gets).toBe(0);
  await noJunk(page);
});

test("a site with no versions says so and opens nothing", async ({ page }) => {
  const { seen } = await boot(page, { admin: true, sites: [{ id: S1, domain: "only.example", repo_full_name: null }], versions: { [S1]: [] } });
  await expect(tid(page, "sr-no-versions")).toHaveText("This site has no versions to review yet.");
  expect(seen.gets).toBe(0);
  await noJunk(page);
});

test("a failed list shows a fixed sentence with a retry, and the fallback still works", async ({ page }) => {
  const { seen } = await boot(page, { admin: true, listStatus: 500 });
  await expect(tid(page, "sr-picker-error")).toHaveText("Your sites aren't available right now.");
  await expect(page.locator(WIN)).not.toContainText("RAW SERVER TEXT");
  await expect(tid(page, "sr-picker-retry")).toBeVisible();
  const before = seen.lists.length;
  await tid(page, "sr-picker-retry").click();
  await expect.poll(() => seen.lists.length).toBeGreaterThan(before);
  await openId(page);
  await expect(tid(page, "sr-counts")).toContainText("verified: 3");
  await noJunk(page);
});

test("a rate limit on the list shows the wait from the server's number, never its text", async ({ page }) => {
  await boot(page, { admin: true, listStatus: 429 });
  await expect(tid(page, "sr-picker-error")).toHaveText("Too many tries. Try again in 7 seconds.");
  await expect(page.locator(WIN)).not.toContainText("RAW SERVER TEXT");
});

test("open by id is a labelled fallback: it names the field, takes a version id and opens that report", async ({ page }) => {
  const { seen } = await boot(page, { admin: true, ...TWO_SITES });
  await expect(tid(page, "sr-counts")).toBeVisible();
  await expect(tid(page, "sr-id")).toBeHidden();
  await tid(page, "sr-byid").locator("summary").click();
  await expect(page.locator(`${WIN} label[for="sr-version-id"]`)).toHaveText("Site version id");
  await expect(page.getByLabel("Site version id")).toBeVisible();
  await openId(page, V1_PENDING);
  await expect.poll(() => seen.getIds[seen.getIds.length - 1]).toBe(V1_PENDING);
  await expect(tid(page, "sr-version")).toHaveValue(V1_PENDING);
  await expect(tid(page, "sr-site")).toHaveValue(S1);
});

test("a version id that is not found says so, and the picker stays usable", async ({ page }) => {
  const missing = "c0000000-0000-4000-8000-00000000000c";
  await boot(page, { admin: true, ...TWO_SITES, missing: [missing] });
  await expect(tid(page, "sr-counts")).toBeVisible();
  await tid(page, "sr-byid").locator("summary").click();
  await openId(page, missing);
  await expect(tid(page, "sr-status")).toHaveText("That site version wasn't found.");
  await expect(tid(page, "sr-counts")).toHaveCount(0);
  await tid(page, "sr-version").selectOption(V2_OLD);
  await expect(tid(page, "sr-heading")).toHaveText("Approved");
  await expect(tid(page, "sr-status")).toHaveText("");
});

test("a member picks and reads, and gets the read-only message with no controls", async ({ page }) => {
  const { seen } = await boot(page, { admin: false, ...TWO_SITES });
  await expect(tid(page, "sr-counts")).toContainText("verified: 3");
  await expect(tid(page, "sr-site")).toBeVisible();
  await expect(tid(page, "sr-readonly")).toBeVisible();
  await tid(page, "sr-site").selectOption(S1);
  await expect.poll(() => seen.getIds[seen.getIds.length - 1]).toBe(V1_PENDING);
  await expect(page.locator(`${WIN} input[type=checkbox], ${WIN} [data-testid^="sr-attest"], ${WIN} [data-testid="sr-approve"]`)).toHaveCount(0);
  expect(seen.posts).toEqual([]);
});
