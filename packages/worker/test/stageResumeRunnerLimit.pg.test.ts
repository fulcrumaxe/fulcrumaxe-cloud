import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { PARKED_STAGE_REGISTRY, RUNNER_DAILY_LIMIT_PAUSE, runnerLimitHasReset } from "@fx/pipeline";
import { RUNNER_DAILY_LIMIT_WAIT, createStageResume } from "../src/stageResume.js";
import type { AdvanceStartArgs } from "../src/advance.js";

/**
 * [pg] A review parked for the runner's daily run limit, over real rows and the REAL review registry entry. The cross-tenant list and the tenant-scoped checks are the
 * real ones. The seat is a trap: the sweep resumes this wait by the clock alone, so reading the spend headroom (which needs the seat) fails the test.
 */
describe("the parked-stage sweep for a review waiting on the runner's daily limit [pg]", { timeout: 90_000 }, () => {
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

  const entry = PARKED_STAGE_REGISTRY.review!;
  const HEAD = "a".repeat(40);
  // The sweep's clock: 12:00 UTC on a fixed day. The day's start is 00:00 UTC; the fact is on either side of it.
  const NOON = Date.UTC(2026, 9, 31, 12, 0, 0);
  const DAY_START = Date.UTC(2026, 9, 31, 0, 0, 0);
  const clock = { t: NOON };
  const started: AdvanceStartArgs[] = [];
  const sweeper = () =>
    createStageResume(writerPool, {
      // The sweep lists every tenant's parked items, so a run beside other pg files meets items that are not ours: those get no seat (skipped). Ours must never ask.
      resolveRunSeat: (async (r: { workItemId?: string }) => {
        if (r.workItemId !== undefined && ours.has(r.workItemId)) throw new Error("the spend headroom must not be read for the runner's daily limit");
        return { ok: false, reason: "not_ours" } as never;
      }) as never,
      startAdvance: async (args) => void started.push(args),
      now: () => clock.t,
      log: () => undefined,
    });
  const ours = new Set<string>();
  const mine = (w: string) => started.filter((s) => s.workItemId === w);

  let n = 52000;
  async function parked(waitedAt: number): Promise<{ a: SeedRefs; w: string; approval: string }> {
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
    await wait(a.accountId, w, 0, waitedAt);
    return { a, w, approval };
  }
  /** The fact the workflow writes when a reviewer is refused for the limit (`wait:` key, the head and pull request), at a chosen time. */
  async function wait(accountId: string, w: string, attempt: number, at: number): Promise<void> {
    await admin.query(
      "INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, head_sha, pr_number, round, dedupe_key, created_at) VALUES ($1, $2, 'stage_waiting', 'review', $3, $4, $5, 7, 0, $6, $7)",
      [accountId, w, RUNNER_DAILY_LIMIT_PAUSE, attempt, HEAD, `wait:review:${HEAD}:0:${attempt}`, new Date(at)],
    );
    // The store stamps created_at with its own clock on insert; the test moves it, as the other sweep tests do.
    await admin.query("UPDATE work_item_driver_events SET created_at = $3 WHERE work_item_id = $1 AND dedupe_key = $2", [w, `wait:review:${HEAD}:0:${attempt}`, new Date(at)]);
  }
  async function event(accountId: string, w: string, kind: string, code: string | null = null): Promise<void> {
    const key = randomUUID();
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, head_sha, dedupe_key) VALUES ($1, $2, $3, $4, $5, $6)", [accountId, w, kind, code, HEAD, key]);
    await admin.query("UPDATE work_item_driver_events SET created_at = $3 WHERE work_item_id = $1 AND dedupe_key = $2", [w, key, new Date(clock.t - 1000)]);
  }
  const factCount = async (w: string) => Number((await admin.query("SELECT count(*) AS n FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'stage_waiting'", [w])).rows[0].n);

  it("the worker's constant is the pipeline's, and the registry parks the review stage on it", () => {
    expect(RUNNER_DAILY_LIMIT_WAIT).toBe(RUNNER_DAILY_LIMIT_PAUSE);
    expect(entry.pauses).toContain(RUNNER_DAILY_LIMIT_PAUSE);
  });

  it("before the reset the sweep starts nothing and reads no headroom; it only keeps the wait fresh", async () => {
    const p = await parked(DAY_START + 3600_000); // waited at 01:00 today: the reset is tomorrow 00:00
    const before = await factCount(p.w);
    clock.t = NOON;
    const out = await sweeper().sweepParkedStages([entry]);
    expect(mine(p.w)).toEqual([]);
    expect(out.refreshed).toBeGreaterThanOrEqual(1);
    expect(await factCount(p.w)).toBeGreaterThan(before);
    expect(runnerLimitHasReset(new Date(DAY_START + 3600_000), new Date(NOON))).toBe(false);
  });

  it("after the reset it resumes once, with no person; a replayed tick starts nothing more; progress ends the claim", async () => {
    const p = await parked(DAY_START - 3600_000); // waited at 23:00 yesterday: reset was 00:00 today
    clock.t = NOON;
    const first = await sweeper().sweepParkedStages([entry]);
    expect(first.resumed).toBe(1);
    expect(mine(p.w)).toHaveLength(1);
    expect(mine(p.w)[0]).toMatchObject({ accountId: p.a.accountId, workItemId: p.w, actionId: p.approval, specVersion: 1 });
    // The same tick again (a replay, or a second pass in the same bucket): the claim is keyed, nothing more starts.
    await sweeper().sweepParkedStages([entry]);
    expect(mine(p.w)).toHaveLength(1);
    // The reviewers started: the claim is over, a later pass leaves the item alone.
    await event(p.a.accountId, p.w, "review_started");
    clock.t = NOON + 20 * 60_000;
    await admin.query("UPDATE work_item_driver_events SET created_at = created_at - interval '1 hour' WHERE work_item_id = $1 AND kind = 'stage_waiting'", [p.w]);
    await sweeper().sweepParkedStages([entry]);
    expect(mine(p.w)).toHaveLength(1);
  });

  it("refused again after the reset: the workflow's new wait pauses it again until the next reset", async () => {
    const p = await parked(DAY_START - 3600_000);
    // The resumed workflow was refused again at 12:05 today and recorded a new wait (attempt 1).
    await wait(p.a.accountId, p.w, 1, NOON + 5 * 60_000);
    clock.t = NOON + 30 * 60_000;
    await admin.query("UPDATE work_item_driver_events SET created_at = created_at - interval '20 minutes' WHERE work_item_id = $1 AND attempt = 1", [p.w]);
    const out = await sweeper().sweepParkedStages([entry]);
    expect(out.resumed).toBe(0);
    expect(mine(p.w)).toEqual([]);
  });

  // The reset is measured from the wait the WORKFLOW wrote (`wait:` key). A sweep fact of the same code written today (a refresh or a claim, `sweep:`/`resume:` keys) must not
  // move it, or every claim would push the next resume a day out.
  it("a sweep's own fact of the same code, written today, does not delay the resume: the reset is read from the workflow's wait", async () => {
    const p = await parked(DAY_START - 3600_000); // the workflow's wait: 23:00 yesterday
    const key = `resume:${p.approval}:0:1`;
    await admin.query(
      "INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, head_sha, pr_number, round, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'review', $3, 0, $4, 7, 0, $5)",
      [p.a.accountId, p.w, RUNNER_DAILY_LIMIT_PAUSE, HEAD, key],
    );
    await admin.query("UPDATE work_item_driver_events SET created_at = $3 WHERE work_item_id = $1 AND dedupe_key = $2", [p.w, key, new Date(NOON)]); // 12:00 today
    clock.t = NOON + 20 * 60_000;
    const out = await sweeper().sweepParkedStages([entry]);
    expect(out.resumed).toBe(1);
    expect(mine(p.w)).toHaveLength(1);
  });

  // A claim whose workflow died without writing anything is claimed again by a LATER pass (the claim key carries the pass), once the claim is older than the orphan age.
  it("a claim that came to nothing is claimed again on a later pass: the claim key carries the pass number", async () => {
    const p = await parked(DAY_START - 3600_000);
    clock.t = NOON;
    expect((await sweeper().sweepParkedStages([entry])).resumed).toBe(1);
    // The same pass again: the keyed claim holds, nothing more starts.
    expect((await sweeper().sweepParkedStages([entry])).resumed).toBe(0);
    expect(mine(p.w)).toHaveLength(1);
    // The claim ages past the orphan age (ten minutes) and the next pass (fifteen minutes later) looks again.
    await admin.query("UPDATE work_item_driver_events SET created_at = created_at - interval '20 minutes' WHERE work_item_id = $1 AND dedupe_key LIKE 'resume:%'", [p.w]);
    clock.t = NOON + 15 * 60_000;
    expect((await sweeper().sweepParkedStages([entry])).resumed).toBe(1);
    expect(mine(p.w)).toHaveLength(2);
  });

  it("a stop recorded after the wait (any other refusal) ends the parking: the sweep never resumes it", async () => {
    const p = await parked(DAY_START - 3600_000);
    await event(p.a.accountId, p.w, "stopped", "not_started_public_repo");
    clock.t = NOON;
    await sweeper().sweepParkedStages([entry]);
    expect(mine(p.w)).toEqual([]);
  });
});
