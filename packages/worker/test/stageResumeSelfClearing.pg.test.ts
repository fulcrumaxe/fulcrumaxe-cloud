import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { PARKED_STAGE_REGISTRY, SELF_CLEARING_MAX_PARKS, SELF_CLEARING_REVIEW_WAITS } from "@fx/pipeline";
import { SELF_CLEARING_MAX_PARKS as WORKER_MAX_PARKS, SELF_CLEARING_REVIEW_WAITS as WORKER_WAITS, createStageResume } from "../src/stageResume.js";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceStartArgs } from "../src/advance.js";

const marks = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]> }));
vi.mock("@fx/core/src/pendingWork.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fx/core/src/pendingWork.js")>()),
  markWorkPending: vi.fn(async (name: string, opts: unknown) => void marks.calls.push([name, opts])),
}));

/**
 * [pg] A review parked for a not-started refusal that clears by itself (sandbox_reaping and the four others), over real rows and the REAL review registry entry.
 * The five codes sit past the lister's eight-pause limit, so they are found only because the sweep lists a long entry in chunks. The seat is a trap: these waits are
 * restarted without reading the spend headroom.
 */
describe("the parked-stage sweep for a review waiting on a self-clearing refusal [pg]", { timeout: 90_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });
  beforeEach(() => {
    marks.calls.length = 0;
  });

  const entry = PARKED_STAGE_REGISTRY.review!;
  const HEAD = "b".repeat(40);
  const NOON = Date.UTC(2026, 10, 6, 12, 0, 0);
  const started: AdvanceStartArgs[] = [];
  const ours = new Set<string>();
  const sweeper = () =>
    createStageResume(writerPool, {
      resolveRunSeat: (async (r: { workItemId?: string }) => {
        if (r.workItemId !== undefined && ours.has(r.workItemId)) throw new Error("the spend headroom must not be read for a self-clearing refusal");
        return { ok: false, reason: "not_ours" } as never;
      }) as never,
      startAdvance: async (args) => void started.push(args),
      now: () => NOON,
      log: () => undefined,
    });
  const mine = (w: string) => started.filter((s) => s.workItemId === w);

  let n = 54000;
  async function parked(code: string, ageMinutes: number, attempt = 0): Promise<{ a: SeedRefs; w: string; approval: string }> {
    const a = await seedAccount(admin, randomUUID());
    const w = randomUUID();
    ours.add(w);
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'pr_opened', $4)", [w, a.accountId, a.repoId, n++]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, w]);
    await admin.query("UPDATE spec_versions SET created_at = now() - interval '2 days' WHERE work_item_id = $1", [w]);
    const approval = randomUUID();
    await admin.query(
      `INSERT INTO run_action_requests (id, account_id, kind, target_id, requested_by, principal_kind, request_hash, state, finished_at, outcome)
       VALUES ($1, $2, 'advance_work_item', $3, $4, 'session', $5, 'done', now() - interval '1 day', $6::jsonb)`,
      [approval, a.accountId, w, `session:${a.userId}`, "h".repeat(64), JSON.stringify({ work_item_id: w, advance: "started" })],
    );
    const key = `wait:review:${HEAD}:0:${attempt}`;
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, head_sha, pr_number, round, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'review', $3, $4, $5, 7, 0, $6)", [
      a.accountId,
      w,
      code,
      attempt,
      HEAD,
      key,
    ]);
    // The store stamps created_at with its own clock on insert; the sweep's clock is fixed, and the listing's age is the database's, so the fact is aged in the database.
    await admin.query("UPDATE work_item_driver_events SET created_at = now() - make_interval(mins => $3::int) WHERE work_item_id = $1 AND dedupe_key = $2", [w, key, ageMinutes]);
    return { a, w, approval };
  }

  it("the worker's list is the pipeline's, and the registry parks the review stage on each code", () => {
    expect([...WORKER_WAITS]).toEqual([...SELF_CLEARING_REVIEW_WAITS]);
    expect(WORKER_MAX_PARKS).toBe(SELF_CLEARING_MAX_PARKS);
    for (const c of SELF_CLEARING_REVIEW_WAITS) expect(entry.pauses).toContain(c);
    expect(entry.pauses.length).toBeGreaterThan(8);
  });

  it.each([...SELF_CLEARING_REVIEW_WAITS])("%s: a settled wait is restarted once with no person, and without reading the headroom", async (code) => {
    const p = await parked(code, 20);
    const first = await sweeper().sweepParkedStages([entry]);
    expect(first.resumed).toBeGreaterThanOrEqual(1);
    expect(mine(p.w)).toHaveLength(1);
    expect(mine(p.w)[0]).toMatchObject({ accountId: p.a.accountId, workItemId: p.w, actionId: p.approval, specVersion: 1 });
    // The same pass again: the keyed claim holds, nothing more starts.
    await sweeper().sweepParkedStages([entry]);
    expect(mine(p.w)).toHaveLength(1);
  });

  // Each restart leaves one claim (a `resume:` fact). A cause that has been restarted for four hours of passes is ended by one stop with its own words.
  async function claims(p: { a: SeedRefs; w: string }, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const key = `resume:old:${i}:${i}`;
      await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, head_sha, pr_number, round, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'review', 'worker_unavailable', 0, $3, 7, 0, $4)", [p.a.accountId, p.w, HEAD, key]);
      await admin.query("UPDATE work_item_driver_events SET created_at = now() - interval '30 minutes' WHERE work_item_id = $1 AND dedupe_key = $2", [p.w, key]);
    }
  }

  it("the sixteenth restart in a row is the last: a cause that never cleared stops the round with its own code, once, and the item is not listed again", async () => {
    const p = await parked("worker_unavailable", 40);
    await claims(p, SELF_CLEARING_MAX_PARKS);
    const out = await sweeper().sweepParkedStages([entry]);
    expect(mine(p.w)).toEqual([]);
    expect(out.skipped).toBeGreaterThanOrEqual(1);
    const stops = await admin.query("SELECT code, head_sha FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'stopped'", [p.w]);
    expect(stops.rows).toEqual([{ code: "not_started_worker_unavailable", head_sha: HEAD }]);
    await sweeper().sweepParkedStages([entry]);
    expect((await admin.query("SELECT count(*) AS n FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'stopped'", [p.w])).rows[0].n).toBe("1");
    expect(mine(p.w)).toEqual([]);
  });

  it("one restart fewer still restarts", async () => {
    const p = await parked("worker_unavailable", 40);
    await claims(p, SELF_CLEARING_MAX_PARKS - 1);
    await sweeper().sweepParkedStages([entry]);
    expect(mine(p.w)).toHaveLength(1);
  });

  it("a wait younger than the settle time is left alone: its own workflow may still be running", async () => {
    const p = await parked("sandbox_reaping", 2);
    await sweeper().sweepParkedStages([entry]);
    expect(mine(p.w)).toEqual([]);
  });

  it("a stop recorded after the wait (a person-fixable refusal on the restart) ends the parking", async () => {
    const p = await parked("repo_visibility_unknown", 20);
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, head_sha, dedupe_key) VALUES ($1, $2, 'stopped', 'not_started_public_repo', $3, $4)", [p.a.accountId, p.w, HEAD, randomUUID()]);
    await sweeper().sweepParkedStages([entry]);
    expect(mine(p.w)).toEqual([]);
  });

  it("a different code that is not in the review's list is not resumed by this sweep", async () => {
    const p = await parked("a_code_nobody_parks_on", 20);
    await sweeper().sweepParkedStages([entry]);
    expect(mine(p.w)).toEqual([]);
  });

  it("a waiting fact for a self-clearing review cause tells the sweep there is work, a pass from now; the same code at another stage does not", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'pr_opened', $4)", [w, a.accountId, a.repoId, n++]);
    const m = createAdvanceModule(writerPool, { starter: { start: async () => ({ runId: randomUUID() }) }, resolveRunSeat: vi.fn(), startAdvance: async () => undefined, triage: null, registry: {} as never } as unknown as AdvanceModuleDeps);
    const who = { accountId: a.accountId, userId: a.userId, workItemId: w, haltEpoch: 0 };
    expect(await m.advanceRecordEvent(who, { kind: "stage_waiting", stage: "review", code: "sandbox_reaping", attempt: 0, dedupeKey: "k1", headSha: HEAD })).toEqual({ recorded: true });
    expect(marks.calls.map((c) => c[0])).toEqual(["stage-resume-sweep"]);
    const since = (marks.calls[0]![1] as { since: number }).since;
    expect(since).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(since).toBeLessThan(Date.now() + 16 * 60_000);
    await m.advanceRecordEvent(who, { kind: "stage_waiting", stage: "build", code: "sandbox_reaping", attempt: 0, dedupeKey: "k2" });
    expect(marks.calls).toHaveLength(1);
  });
});
