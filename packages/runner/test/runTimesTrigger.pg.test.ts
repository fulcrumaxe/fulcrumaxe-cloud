import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { RUN_STATUS_TRANSITIONS, type RunStatus } from "../src/statusTransitions.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * D#45 S1 criterion 7 (C3): `agent_runs.started_at`/`ended_at`, stamped only
 * by the `agent_runs_stamp_times` trigger (migrations/0610). Lives here, not
 * in packages/db, so db takes no devDependency on @fx/runner for the real
 * `RUN_STATUS_TRANSITIONS` import -- that edge would close a core -> db ->
 * runner -> core cycle. Updates are raw SQL, not writeRunStatus, which would
 * refuse several of these statuses before the trigger fires.
 */
describe("agent_runs run start/end stamps [pg] (D#45 S1 criterion 7)", () => {
  const db = pgHarness();
  let accountId: string;
  let repoId: string;
  let workItemId: string;

  beforeAll(async () => {
    accountId = randomUUID();
    repoId = randomUUID();
    workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId);
  });

  async function insertRun(
    status: string,
    overrides: { started_at?: Date | null; ended_at?: Date | null } = {},
  ): Promise<string> {
    const id = randomUUID();
    const startedAt = overrides.started_at ?? null;
    const endedAt = overrides.ended_at ?? null;
    await db.admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, started_at, ended_at)
       VALUES ($1, $2, $3, 'executor', 'local', $4, $5, $6)`,
      [id, accountId, workItemId, status, startedAt, endedAt],
    );
    return id;
  }

  async function readTimes(id: string): Promise<{ started_at: Date | null; ended_at: Date | null }> {
    const { rows } = await db.admin.query<{ started_at: Date | null; ended_at: Date | null }>(
      "SELECT started_at, ended_at FROM agent_runs WHERE id = $1",
      [id],
    );
    return rows[0]!;
  }

  describe("(a) INSERT with status = pending", () => {
    it("client-supplied started_at/ended_at (both 2000-01-01) are stored as NULL", async () => {
      const id = await insertRun("pending", {
        started_at: new Date("2000-01-01"),
        ended_at: new Date("2000-01-01"),
      });
      const times = await readTimes(id);
      expect(times.started_at).toBeNull();
      expect(times.ended_at).toBeNull();
    });
  });

  describe("(b) UPDATE from pending to running", () => {
    it("sets started_at within 5s of now; any later UPDATE, including one that sets started_at explicitly, leaves it unchanged", async () => {
      const id = await insertRun("pending");
      await db.admin.query(`UPDATE agent_runs SET status = 'running' WHERE id = $1`, [id]);
      const afterFirst = await readTimes(id);
      expect(afterFirst.started_at).not.toBeNull();
      expect(Math.abs(afterFirst.started_at!.getTime() - Date.now())).toBeLessThan(5000);

      await db.admin.query(`UPDATE agent_runs SET status = 'running', started_at = $2 WHERE id = $1`, [
        id,
        new Date("2000-01-01"),
      ]);
      const afterSecond = await readTimes(id);
      expect(afterSecond.started_at!.getTime()).toBe(afterFirst.started_at!.getTime());
    });
  });

  describe("(c) ended_at is non-NULL iff RUN_STATUS_TRANSITIONS[s] is empty, for every key s", () => {
    const statuses = Object.keys(RUN_STATUS_TRANSITIONS) as RunStatus[];

    it.each(statuses)("a run inserted as running, updated to %s", async (s) => {
      const id = await insertRun("running");
      await db.admin.query(`UPDATE agent_runs SET status = $2 WHERE id = $1`, [id, s]);
      const times = await readTimes(id);
      const isTerminal = RUN_STATUS_TRANSITIONS[s].length === 0;
      if (isTerminal) {
        expect(times.ended_at).not.toBeNull();
        expect(Math.abs(times.ended_at!.getTime() - Date.now())).toBeLessThan(5000);
      } else {
        expect(times.ended_at).toBeNull();
      }
    });

    it("exercises at least one terminal and one non-terminal key (guards against a vacuous parametrised run)", () => {
      expect(statuses.some((s) => RUN_STATUS_TRANSITIONS[s].length === 0)).toBe(true);
      expect(statuses.some((s) => RUN_STATUS_TRANSITIONS[s].length > 0)).toBe(true);
    });

    it("once set, ended_at never changes on a further UPDATE", async () => {
      const id = await insertRun("running");
      await db.admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE id = $1`, [id]);
      const first = await readTimes(id);
      expect(first.ended_at).not.toBeNull();

      await db.admin.query(`UPDATE agent_runs SET ended_at = $2 WHERE id = $1`, [id, new Date("2000-01-01")]);
      const second = await readTimes(id);
      expect(second.ended_at!.getTime()).toBe(first.ended_at!.getTime());
    });
  });

  describe("(d) INSERT directly with status = refused_spend", () => {
    it("stores ended_at within 5s of now, and started_at NULL", async () => {
      const id = await insertRun("refused_spend");
      const times = await readTimes(id);
      expect(times.started_at).toBeNull();
      expect(times.ended_at).not.toBeNull();
      expect(Math.abs(times.ended_at!.getTime() - Date.now())).toBeLessThan(5000);
    });
  });
});
