// apps/workspace/e2e/helpers/plan-mock.ts
//
// D#483 S3-L2b: one stateful stand-in for the proposal and plan routes, shared by pipeline-inbox.spec.ts and
// pipeline-plan.spec.ts. Answers follow the API's own contract fixtures (packages/api/fixtures/v1/**): the same field names,
// the same refusal codes, the same pagination cursor. The decisions change the stand-in's state the way the definers do
// (approve gives the next roadmap position and a Triaged work item; withdraw is refused after Triaged), so a spec reads
// the screen after a click and not only the request. The stand-in cannot prove the database's own rules (those are the pg
// tests of S3-L2a); it proves what the screen does with each answer.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./boot";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "api", "fixtures", "v1");
export const fx = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));

export const REPO = "66666666-6666-4666-8666-666666666666";
export const REPO_GONE = "88888888-8888-4888-8888-888888888888";
export const REPOS = {
  data: [
    { id: REPO, product: "web", gh_repo_id: 1, install_state: "installed", app_kind: "team", full_name: "acme/widgets" },
    { id: REPO_GONE, product: "web", gh_repo_id: 2, install_state: "not_installed", app_kind: null, full_name: "acme/retired" },
  ],
  next_cursor: null,
};

export type Proposal = Record<string, unknown> & { id: string; state: string; owner_process: string; repo_id: string };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SECTION_OF: Record<string, string> = { verified: "new", partly_verified: "new", pending: "being_checked", refuted: "couldnt_confirm", check_failed: "couldnt_confirm", not_checked: "not_checked" };
export function proposal(n: number, over: Record<string, unknown> = {}): Proposal {
  const row = {
    id: uuid(n),
    repo_id: REPO,
    dedupe_key: `gh:issue:${n}`,
    sources: ["github_issue"],
    gh_number: n,
    discussion_number: null,
    task_key: null,
    milestone_key: null,
    milestone_title: null,
    title: `Issue number ${n}`,
    summary: null,
    category_hint: null,
    estimate_usd: null,
    provenance: "internal",
    owner_process: "product",
    state: "new",
    decided_at: null,
    reject_note: null,
    roadmap_position: null,
    work_item_id: null,
    work_item_stage: null,
    created_at: `2026-10-16T06:${String(60 - n).padStart(2, "0")}:00.000Z`,
    updated_at: "2026-10-16T06:00:00.000Z",
    // D#483 S4-h: what the verifier saw. The section is what the server derives (S4-i): only a new, product-owned proposal has one.
    verification: "verified",
    verified_at: "2026-10-16T06:30:00.000Z",
    verified_sha: "0123456789abcdef0123456789abcdef01234567",
    verify_attempts: 0,
    verify_attempts_max: 3,
    verify_retry: false,
    claim_counts: { supported: 0, refuted: 0, unverifiable: 0, pending: 0 },
    evidence_count: 0,
    auto_started: false,
    ...over,
  } as Record<string, unknown>;
  // The real column rule (0839 proposals_verification_stamped): a proposal is stamped exactly when it is no longer pending, so a pending row has no check time or sha.
  if (row.verification === "pending") {
    if (!("verified_at" in over)) row.verified_at = null;
    if (!("verified_sha" in over)) row.verified_sha = null;
  }
  if (row.verification === "pending" ? row.verified_at !== null : row.verified_at === null) throw new Error("plan-mock: verified_at is null exactly when verification is pending");
  if (!("inbox_section" in over)) row.inbox_section = row.state === "new" && row.owner_process === "product" ? SECTION_OF[row.verification as string] : null;
  return row as Proposal;
}

export interface Reply { status: number; json?: unknown; headers?: Record<string, string>; abort?: boolean }
export const refusal = (status: number, code: string, headers?: Record<string, string>): Reply => ({
  status,
  headers,
  json: { error: { code, message: "server text that must never be shown", request_id: "req_1" } },
});

export interface PlanMock {
  requests: string[];
  posts: { method: string; path: string; key: string | undefined; type: string | undefined; body: string | null }[];
  repos: unknown;
  proposals: Proposal[];
  pageSize: number;
  listFails: boolean;
  /** The next answers to a decision, consumed one per POST (then the stand-in's own logic answers). */
  decide: Reply[];
  /** What approve answers when it succeeds. */
  started: { started: boolean; not_started_reason: string | null };
  plan: Record<string, unknown> | null; // null answers like a repo that was never imported
  planFails: boolean;
  tasks: Record<string, unknown[]>; // milestone key -> tasks
  taskPage: number;
  importReply: Reply[];
  removeReply: Reply[];
  /** Runs when the import POST succeeds, to change what the next plan read answers. */
  onImport: (() => void) | null;
  /** Answers to GET /repos: when true the list fails with a 500. */
  reposFail: boolean;
  /** D#483 S4-h: what the detail route answers for a proposal id: its claims and evidence, or a Reply for a refusal. An id not here answers 404. */
  details: Record<string, { claims: unknown[]; evidence: unknown[] } | Reply>;
  /**
   * D#483 S5-e1: what the estimate route answers, by proposal id; null (the default) leaves the route unanswered (404), as before it existed.
   * `meta` is the set-level figures. An id missing from `estimates` is answered 404 like an unknown proposal.
   */
  estimates: Record<string, { basis: "history" | "seed" | "none"; total_usd: number | null }> | null;
  estimateMeta: { margin_pct: number | null; remaining_budget_usd: number; first_run_usd: number };
  /** D#483 S5-b1a-2: what the weekly auto-start route answers; null (the default) leaves it unanswered (404), as before the Inbox read it. */
  autostart: Record<string, unknown> | null;
  /** Requests held open until released (see holdRequest). Each holds the first request that matches, once. */
  holds: { re: RegExp; used: boolean; release: () => void; gate: Promise<void> }[];
}

/**
 * Holds the first request whose "METHOD /path?query" matches `re` until the returned function is called. The request is counted
 * in `requests` the moment it arrives, so a spec can wait for it, act while it is out, and then let it answer.
 */
export function holdRequest(m: PlanMock, re: RegExp): () => void {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  m.holds.push({ re, used: false, release, gate });
  return release;
}

export function neverImported() {
  return { latest_import: null, imported_from: null, milestones: [], totals: { tasks: 0, done: 0, remaining: 0 }, tasks: [], next_cursor: null, tasks_truncated: false };
}
export const importedPlan = () => fx("getRepoPlan", "200-imported.json");

export function newMock(): PlanMock {
  return {
    requests: [],
    posts: [],
    repos: REPOS,
    proposals: [],
    pageSize: 50,
    listFails: false,
    decide: [],
    started: { started: true, not_started_reason: null },
    plan: neverImported(),
    planFails: false,
    tasks: {},
    taskPage: 2,
    importReply: [],
    removeReply: [],
    onImport: null,
    reposFail: false,
    details: {},
    estimates: null,
    estimateMeta: { margin_pct: 20, remaining_budget_usd: 437, first_run_usd: 10 },
    autostart: null,
    holds: [],
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (s: string | undefined) => !!s && UUID_RE.test(s);

export async function installMock(page: Page, m: PlanMock) {
  // A request the page already abandoned (a held one, answered late) can no longer be fulfilled; that is not an error here.
  const send = async (route: Route, r: Reply) => {
    try {
      if (r.abort) await route.abort("failed");
      else await route.fulfill({ status: r.status, headers: r.headers, contentType: "application/json", body: JSON.stringify(r.json ?? {}) });
    } catch {
      /* the request was aborted by the page */
    }
  };
  await page.route((u) => u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const q = url.searchParams;
    const line = `${req.method()} ${p}${url.search}`;
    m.requests.push(line);
    const hold = m.holds.find((x) => !x.used && x.re.test(line));
    if (hold) {
      hold.used = true;
      await hold.gate;
    }
    if (req.method() === "GET") {
      if (p === "/api/v1/work-items") return send(route, { status: 200, json: { data: [], next_cursor: null } });
      if (p === "/api/v1/account/autostart-envelope" && m.autostart) return send(route, { status: 200, json: m.autostart });
      if (p === "/api/v1/repos") return m.reposFail ? send(route, refusal(500, "internal_error")) : send(route, { status: 200, json: m.repos });
      if (p === "/api/v1/proposals") {
        if (m.listFails) return send(route, refusal(500, "internal_error"));
        let rows = m.proposals.filter((x) => x.repo_id === q.get("repo_id"));
        if (q.get("state")) rows = rows.filter((x) => x.state === q.get("state"));
        if (q.get("owner")) rows = rows.filter((x) => x.owner_process === q.get("owner"));
        if (q.get("section")) rows = rows.filter((x) => x.inbox_section === q.get("section"));
        rows = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        const from = q.get("cursor") ? Number(q.get("cursor")) : 0;
        const page_ = rows.slice(from, from + m.pageSize);
        const next = from + m.pageSize < rows.length ? String(from + m.pageSize) : null;
        return send(route, { status: 200, json: { proposals: page_, next_cursor: next } });
      }
      const one = /^\/api\/v1\/proposals\/([^/]+)$/.exec(p);
      if (one) {
        const row = m.proposals.find((x) => x.id === one[1]);
        const d = m.details[one[1]!];
        if (!row || !d) return send(route, refusal(404, "not_found"));
        if ("status" in d) return send(route, d);
        return send(route, { status: 200, json: { proposal: { ...row, claims: d.claims, evidence: d.evidence } } });
      }
      const plan = /^\/api\/v1\/repos\/([^/]+)\/plan$/.exec(p);
      if (plan) {
        if (m.planFails) return send(route, refusal(500, "internal_error"));
        if (!m.plan) return send(route, refusal(404, "not_found"));
        const ms = q.get("milestone");
        if (ms) {
          const all = m.tasks[ms] ?? [];
          const from = q.get("cursor") ? Number(q.get("cursor")) : 0;
          const next = from + m.taskPage < all.length ? String(from + m.taskPage) : null;
          return send(route, { status: 200, json: { ...m.plan, tasks: all.slice(from, from + m.taskPage), next_cursor: next } });
        }
        return send(route, { status: 200, json: m.plan });
      }
      const est = /^\/api\/v1\/repos\/([^/]+)\/proposals\/estimate$/.exec(p);
      if (est && m.estimates) {
        const ids = (q.get("ids") ?? "").split(",");
        if (!ids.every((id) => m.estimates![id])) return send(route, refusal(404, "not_found"));
        const proposals = ids.map((id) => ({ proposal_id: id, basis: m.estimates![id].basis, reason: m.estimates![id].basis === "none" ? "no_category" : null, total_usd: m.estimates![id].total_usd, slot_phase_usd: null, estimated: false }));
        return send(route, { status: 200, json: { repo_id: est[1], proposals, total_usd: null, prefill_usd: null, capped: false, needs_amount: proposals.some((x) => x.basis === "none"), ...m.estimateMeta } });
      }
      return send(route, refusal(404, "not_found"));
    }
    m.posts.push({ method: req.method(), path: p, key: req.headers()["idempotency-key"], type: req.headers()["content-type"], body: req.postData() });
    if (/\/plan-imports$/.test(p)) {
      const r = m.importReply.shift() ?? { status: 202, json: fx("startPlanImport", "202-started.json") };
      if (r.status === 202 && m.onImport) m.onImport();
      return send(route, r);
    }
    if (req.method() === "DELETE") {
      const r = m.removeReply.shift() ?? { status: 200, json: fx("removeRepoPlan", "200-removed.json") };
      if (r.status === 200) m.plan = neverImported();
      return send(route, r);
    }
    const mm = /^\/api\/v1\/proposals\/([^/]+)\/(approve|reject|restore|withdraw-approval)$/.exec(p);
    if (!mm) return send(route, refusal(404, "not_found"));
    const forced = m.decide.shift();
    if (forced) return send(route, forced);
    const row = m.proposals.find((x) => x.id === mm[1]);
    if (!row) return send(route, refusal(404, "not_found"));
    const approvedCount = m.proposals.filter((x) => x.state === "approved").length;
    const body = req.postData() ? JSON.parse(req.postData()!) : {};
    if (mm[2] === "approve") {
      if (row.state !== "new") return send(route, refusal(409, "not_new"));
      Object.assign(row, { state: "approved", decided_at: "2026-10-16T07:00:00.000Z", roadmap_position: approvedCount + 1, work_item_id: uuid(900 + approvedCount), work_item_stage: "triaged" });
      return send(route, { status: 200, json: { proposal: row, work_item_id: row.work_item_id, ...m.started } });
    }
    if (mm[2] === "reject") {
      if (row.state !== "new") return send(route, refusal(409, "not_new"));
      Object.assign(row, { state: "rejected", decided_at: "2026-10-16T07:00:00.000Z", reject_note: body.note ?? null });
    } else if (mm[2] === "restore") {
      if (row.state !== "rejected") return send(route, refusal(409, "not_rejected"));
      Object.assign(row, { state: "new", decided_at: null, reject_note: null });
    } else {
      if (row.state !== "approved") return send(route, refusal(409, "not_approved"));
      if (row.work_item_stage !== "triaged") return send(route, refusal(409, "work_started"));
      Object.assign(row, { state: "new", decided_at: null, roadmap_position: null, work_item_id: null, work_item_stage: null });
    }
    return send(route, { status: 200, json: { proposal: row } });
  });
  await page.route("**/api/v1/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body: "event: idle\ndata: {}\n\n" }));
}

export const WIN = `#windows-container .fulc-window[data-app-id="pipeline"]`;
export const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);

export async function setup(page: Page, m: PlanMock) {
  const errors: string[] = [];
  page.on("console", (c) => {
    if (c.type() === "error" && !c.text().startsWith("Failed to load resource")) errors.push(c.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await installMock(page, m);
  await bootToDesktop(page);
  await page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).default.start());
  return { errors };
}

export async function press(page: Page, locator: ReturnType<Page["locator"]>) {
  if (test.info().project.name === "phone") await locator.tap();
  else await locator.click();
}

export async function openPipeline(page: Page) {
  await page.evaluate(() => (window as unknown as { FULCWM: Record<string, (id: string) => void> }).FULCWM.open("pipeline"));
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
  await expect(tid(page, "pl-tabs")).toBeVisible();
}

/** Opens a tab and picks a repository by its owner/name. */
export async function goTab(page: Page, tab: "board" | "inbox" | "plan", repo: string | null = "acme/widgets") {
  await press(page, tid(page, `pl-tab-${tab}`));
  if (repo && tab !== "board") await page.locator(`${WIN} [data-testid="pl-repo-picker"]`).selectOption({ label: repo });
}

export const PLACEHOLDER = /\b(null|undefined|nan)\b/i;
/** The words "null", "undefined" and "NaN" never appear in the window, and neither does an empty text node. */
export async function expectNoPlaceholders(page: Page) {
  const found = await page.evaluate((sel) => {
    const root = document.querySelector(sel)!;
    const words = (root as HTMLElement).innerText;
    const empty: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n.textContent ?? "") === "") empty.push((n.parentElement?.className as string) || n.parentElement?.tagName || "?");
    return { words, empty };
  }, WIN);
  expect(found.words).not.toMatch(PLACEHOLDER);
  expect(found.empty).toEqual([]);
}
