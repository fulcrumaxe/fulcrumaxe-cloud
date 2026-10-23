import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { requestChanges } from "@fx/core/src/work-items/operatorMoves.js";
import { createAdvanceModule, type AdvanceReviewDeps, type AdvanceStepWho } from "../src/advance.js";
import type { SeatResult } from "../src/seat.js";

/**
 * [pg] The seam a person's Request changes travels before the driver acts on it, with nothing injected between the layers: the real press (@fx/core's
 * write, under the item's row lock), the pipeline's `loadReviewContext`, the web app's PRODUCTION review deps (`createReviewDeps().load` in
 * apps/web/lib/advanceReview.ts), this package's `advanceLoadReview` and the workflow step's `reviewLoadBody` (apps/web/lib/advanceReviewSteps.ts).
 * If any layer rebuilds the context and drops the flag, the driver reviews the unchanged head instead of starting the person's fix round.
 *
 * The test lives here, not in apps/web, because only this package may build the advance facade from its own modules (CARRY-8: nothing outside it
 * imports the worker's internals). The two web-app modules are loaded by file URL at run time: this package's compiler settings do not cover the
 * web app's sources, so their shapes are stated below as the few members used.
 */
const WEB_LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "web", "lib");
type ReviewLoaded = { ok: true; personRequestPending: boolean } | { ok: false; reason: string };
interface WebReviewModules {
  createReviewDeps: () => AdvanceReviewDeps;
  reviewLoadBody: (worker: unknown, who: AdvanceStepWho, pinned: number | null) => Promise<ReviewLoaded>;
}
async function webModules(): Promise<WebReviewModules> {
  const deps = (await import(pathToFileURL(path.join(WEB_LIB, "advanceReview.ts")).href)) as Pick<WebReviewModules, "createReviewDeps">;
  const steps = (await import(pathToFileURL(path.join(WEB_LIB, "advanceReviewSteps.ts")).href)) as Pick<WebReviewModules, "reviewLoadBody">;
  return { createReviewDeps: deps.createReviewDeps, reviewLoadBody: steps.reviewLoadBody };
}

describe("Request changes reaches the review load through every layer [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  it("the flag is false before the press, true after it, and false once the fix run has taken the note", async () => {
    const web = await webModules();
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    await admin.query("UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId]);
    const w = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'review_passed', 77)", [w, a.accountId, a.repoId]);
    const d = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, 4401, 'feature', 't', $3, 'internal', 'user')", [d, a.accountId, w]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [d, w]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, w]);

    // The facade as production builds it, with the web app's production review deps. Nothing here starts a run.
    const worker = createAdvanceModule(writerPool, {
      starter: null,
      resolveRunSeat: vi.fn(async (): Promise<SeatResult> => ({ ok: false, reason: "not_used" }) as never),
      startAdvance: null,
      triage: null,
      review: web.createReviewDeps(),
    });
    const who = { accountId: a.accountId, userId: a.userId, workItemId: w, haltEpoch: 0 };
    const pending = async () => {
      const out = await web.reviewLoadBody(worker, who, null);
      if (!out.ok) throw new Error(`load refused: ${out.reason}`);
      return out.personRequestPending;
    };

    expect(await pending()).toBe(false);
    const { correctionId } = await requestChanges({ pool: appPool, principal: { accountId: a.accountId, userId: a.userId, role: "owner" } }, w, "Fix the word recieve.");
    expect(await pending()).toBe(true);
    // The fix run stamps the note applied: the request is spent, and the next load reviews as usual.
    await admin.query("UPDATE work_item_corrections SET status = 'applied', applied_at = now() WHERE id = $1", [correctionId]);
    expect(await pending()).toBe(false);
  });
});
