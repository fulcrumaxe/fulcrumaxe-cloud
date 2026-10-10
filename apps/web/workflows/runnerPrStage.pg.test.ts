import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AdvanceItem, AdvanceStartArgs, Worker } from "@fx/worker";
import type { AppCredentialsSource, GithubPullRequestPayload, InstallationHttpRequest } from "@fx/github";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { runMigrations } from "@fx/db/src/migrate.js";
import { provisionEphemeralPostgres, type EphemeralPostgres } from "@fx/db/test/support/ephemeral-pg.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { pullRequestBody } from "@fx/runner-cloud";

/**
 * [pg] D#6 C42-5, acceptance 10: a runner run's pull request moves its item through the REAL webhook HTTP handler (signature check, header
 * routing, tenant resolution, stage write) in the same handling, and the build workflow's grace loop and `findBuiltPr` lookup then do nothing:
 * zero sleeps, zero GitHub reads, zero lookups recorded. With the webhook dropped, the same run still reaches `pr_opened` through `findBuiltPr`.
 */
const world = vi.hoisted(() => ({ sleeps: 0 }));
vi.mock("workflow", () => ({
  sleep: vi.fn(async () => {
    world.sleeps += 1;
  }),
}));
vi.mock("workflow/api", () => ({ resumeHook: vi.fn(), start: vi.fn() }));

import { githubWebhookHandler } from "../app/api/github/webhook/handler";
import { setWorkerWiringForTests } from "../lib/worker";
import { setIssueReaderForTests } from "../lib/github/issueRead";
import { setInstallationHttpForTests } from "../lib/github/installationHttp";
import { workItemAdvanceWorkflow } from "./workItemAdvance";

const FIXTURE = new URL("../../../packages/github/test/fixtures/pull_request.opened.json", import.meta.url);
const SECRET = "test-github-webhook-secret";
const TEAM_APP_ID = "111";
const ISSUE = 595;
const RUN_B = "run-b";
const REPO_FX = "33333333-3333-4333-8333-333333333333";

/** The same HMAC the webhook route tests sign with (handler.test.ts): sha256 over the exact raw body. */
const sign = (body: string): string => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
const credentials: AppCredentialsSource = (kind) => {
  if (kind !== "team") throw new Error("not_configured");
  return { appId: TEAM_APP_ID, privateKeyPem: "unused", webhookSecret: SECRET };
};

describe("a runner run's pull request moves its item at once [pg]", () => {
  let pg: EphemeralPostgres;
  let adminPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  let accountId: string;
  let itemId: string;
  let ghInstallation = 0;
  let seq = 0;

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: "fx_web_runner_pr_stage_test", tmpPrefix: "fx-web-pr-stage-" });
    adminPool = createPool(pg.url);
    await runMigrations(adminPool);
    appPool = createPool(pg.appUserUrl);
    opsPool = createPool(pg.platformOpsUrl);
  }, 180_000);
  afterAll(async () => {
    for (const p of [appPool, opsPool, adminPool]) await p?.end();
    pg?.cleanup();
  });

  let logs: Array<Record<string, unknown>>;
  beforeEach(async () => {
    world.sleeps = 0;
    logs = [];
    vi.spyOn(console, "info").mockImplementation((line: unknown) => void logs.push(JSON.parse(String(line))));
    // A fresh account, a fresh installation, repository 9001 and an item at In progress for issue 595: what the fixture delivery names.
    accountId = randomUUID();
    itemId = randomUUID();
    const installationId = randomUUID();
    ghInstallation = 4242 + ++seq;
    await adminPool.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [accountId, `cus_${accountId}`]);
    await adminPool.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [installationId, accountId, ghInstallation]);
    const repoId = randomUUID();
    await adminPool.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 9001, 'team')`, [repoId, accountId, installationId]);
    await adminPool.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage) VALUES ($1, $2, $3, 'feature', $4, 'internal', 'in_progress')`, [itemId, accountId, repoId, ISSUE]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setWorkerWiringForTests();
    setIssueReaderForTests();
    setInstallationHttpForTests();
  });

  const stageOf = async () => (await adminPool.query("SELECT stage FROM work_items WHERE id = $1", [itemId])).rows[0].stage as string;

  /** A correctly signed `pull_request.opened` by the platform's App, with the body `pullRequestBody` builds for the item's issue, through the real route. */
  async function deliverSigned(): Promise<{ status: number; body: unknown }> {
    const payload = JSON.parse(readFileSync(FIXTURE, "utf8")) as GithubPullRequestPayload;
    payload.pull_request.body = pullRequestBody({ runId: randomUUID(), workItemId: itemId, issueNumber: ISSUE });
    (payload as unknown as { installation: { id: number } }).installation = { id: ghInstallation };
    payload.pull_request.user = { ...payload.pull_request.user, login: "fulcrumaxe[bot]" } as never;
    const raw = JSON.stringify(payload);
    const headers = new Headers({
      "x-github-hook-installation-target-id": TEAM_APP_ID,
      "x-hub-signature-256": sign(raw),
      "x-github-event": "pull_request",
      "x-github-delivery": randomUUID(),
    });
    const req = new NextRequest("https://example.test/api/github/webhook", { method: "POST", headers, body: raw });
    const res = await githubWebhookHandler(req, { appCredentials: credentials, appUserPool: appPool, platformOpsPool: opsPool, hooks: {} });
    return { status: res.status, body: await res.json() };
  }

  const ARGS = (): AdvanceStartArgs => ({ accountId, userId: "55555555-5555-4555-8555-555555555555", workItemId: itemId, actionId: randomUUID(), haltEpoch: 0 });
  const AT_SPEC = (): AdvanceItem => ({
    stage: "spec_ready", provenance: "internal", repoId: REPO_FX, ghNumber: ISSUE, ghOwner: "acme", ghName: "widgets", hasDiscussion: true, kind: "feature", hasSpec: true, specVersion: 3,
    executorRunId: null, executionMode: "runner_local", recordedPr: null,
  });

  /** The workflow over a fake worker whose stage reads and stage move are the REAL database; `onOutcome` runs when the workflow reads the finished run. */
  function wire(onOutcome: () => Promise<void>, o: { lookupFinds: boolean }) {
    let loads = 0;
    const requests: InstallationHttpRequest[] = [];
    const worker = {
      advanceLoadItem: vi.fn(async () => {
        loads += 1;
        return loads === 1 ? AT_SPEC() : { ...AT_SPEC(), stage: await stageOf() };
      }),
      advanceBuild: vi.fn(async () => ({ status: "started", runId: RUN_B, branch: `fx/${RUN_B}-g1` })),
      advanceRunOutcome: vi.fn(async () => {
        await onOutcome();
        return { status: "succeeded", done: true, envelope: { summary: "done" } };
      }),
      advanceBuildFailed: vi.fn(async () => ({ status: "recorded", stage: "needs_human" })),
      advanceCancel: vi.fn(async () => undefined),
      advanceRecordEvent: vi.fn(async () => ({ recorded: true })),
      // With `lookupFinds`, the first review load is `findBuiltPr`'s; every other load (the review phase's) stops at once.
      advanceLoadReview: vi.fn(async () =>
        o.lookupFinds && worker.advanceLoadReview.mock.calls.length === 1
          ? { ok: true as const, ctx: { workItemId: itemId, stage: "in_progress", repoId: REPO_FX, owner: "acme", name: "widgets", issue: ISSUE, tier: "feature", specVersion: 3, debaterEnabled: false, executionMode: "sandbox", recordedPr: null } }
          : { ok: false as const, reason: "no_spec" },
      ),
      // The driver's own record of a pull request it found: the real stage write.
      advancePrFound: vi.fn(async () => {
        await withTenant(appPool, accountId, (client) => recordStage(client, { workItemId: itemId, toStage: "pr_opened", at: new Date(), source: "control_plane", sourceRef: "pr_found:41" }));
        return { status: "recorded", stage: await stageOf() };
      }),
    };
    setWorkerWiringForTests({ provider: () => ({}) as never, createWorker: async () => worker as unknown as Worker });
    setIssueReaderForTests(async () => ({ status: "found", title: "T", body: "B", login: "owner-1", state: "open", labels: [] }));
    setInstallationHttpForTests(async () => ({
      async request(req) {
        requests.push(req);
        if (req.method === "GET" && req.path === "/repos/acme/widgets/pulls") return { status: 200, body: [{ number: 41, state: "open", head: { sha: "a".repeat(40), ref: String(req.query?.head ?? "").split(":")[1], repo: { full_name: "acme/widgets" } }, base: { ref: "main" } }] };
        if (req.path === "/repos/acme/widgets/pulls/41/files") return { status: 200, body: [{ filename: "src/a.ts", status: "modified" }] };
        return { status: 404, body: { message: "Not Found" } };
      },
    }));
    return { worker, requests };
  }

  it("webhook delivered: the item leaves in_progress in that handling, and the grace loop and findBuiltPr make zero polls", async () => {
    const w = wire(async () => {
      expect(await stageOf()).toBe("in_progress");
      const res = await deliverSigned();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ handled: true, result: { applied: "transitioned", recorded: true } });
      expect(await stageOf()).toBe("pr_opened");
    }, { lookupFinds: false });
    expect(await workItemAdvanceWorkflow(ARGS())).toEqual({ status: "failed", detail: "review_no_spec" });
    // Zero polls: no sleep in the grace loop, no GitHub read, no lookup, no "found" record.
    expect(world.sleeps).toBe(0);
    expect(w.requests).toEqual([]);
    expect(w.worker.advancePrFound).not.toHaveBeenCalled();
    expect(w.worker.advanceLoadReview).toHaveBeenCalledTimes(1); // the review phase's own, not findBuiltPr's
    expect(logs.find((l) => l.event === "advance.built")).toMatchObject({ stage: "pr_opened" });
    const { rows } = await adminPool.query("SELECT source FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'pr_opened'", [itemId]);
    expect(rows).toEqual([{ source: "webhook" }]);
  });

  it("webhook dropped: the item stays in_progress through the grace loop, then findBuiltPr finds the pull request and moves it", async () => {
    const w = wire(async () => undefined, { lookupFinds: true });
    expect(await workItemAdvanceWorkflow(ARGS())).toEqual({ status: "failed", detail: "review_no_spec" });
    expect(world.sleeps).toBe(9); // the whole grace period
    expect(w.requests.some((r) => r.method === "GET" && r.path === "/repos/acme/widgets/pulls")).toBe(true);
    expect(w.worker.advancePrFound).toHaveBeenCalledWith(expect.anything(), 41);
    expect(await stageOf()).toBe("pr_opened");
    const { rows } = await adminPool.query("SELECT source FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'pr_opened'", [itemId]);
    expect(rows).toEqual([{ source: "control_plane" }]);
  });

  it("a delivery with a bad signature is refused and the item does not move", async () => {
    const raw = JSON.stringify({ action: "opened" });
    const headers = new Headers({ "x-github-hook-installation-target-id": TEAM_APP_ID, "x-hub-signature-256": "sha256=" + "0".repeat(64), "x-github-event": "pull_request", "x-github-delivery": randomUUID() });
    const res = await githubWebhookHandler(new NextRequest("https://example.test/api/github/webhook", { method: "POST", headers, body: raw }), { appCredentials: credentials, appUserPool: appPool, platformOpsPool: opsPool, hooks: {} });
    expect(res.status).toBe(401);
    expect(await stageOf()).toBe("in_progress");
  });
});
