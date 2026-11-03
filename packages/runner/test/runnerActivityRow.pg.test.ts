import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { activityRowProblem, type LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import { projectRunnerProgress } from "../src/runnerProgress.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount } from "./helpers/seed.js";

/**
 * [pg] D#597 CC-6a-2: the writer half of "the run stream delivers a runner run's agent.activity row". packages/api/test/runEvents.runnerActivity.pg.test.ts
 * inserts rows of exactly this shape and reads them over the real stream (the api package may not import a runner writer). Both tests check
 * their rows with `activityRowProblem` from the protocol package, so the shape cannot drift on one side only.
 */
describe("projectRunnerProgress writes the agent.activity rows the run stream delivers [pg]", () => {
  const db = pgHarness();
  const toolUse = (seq: number, ms: number, activity: Record<string, string>): LocalOnlyEvent =>
    ({ seq, ts: new Date(Date.UTC(2026, 10, 3, 12, 0, 0) + ms).toISOString(), type: "tool_use", tool_name: "Read", activity }) as LocalOnlyEvent;

  async function project(stored: LocalOnlyEvent[]): Promise<{ kind: string; payload: unknown }[]> {
    const accountId = randomUUID();
    const runId = randomUUID();
    await seedAccount(db.admin, accountId);
    await db.admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'build', 'runner', 'running')`, [runId, accountId]);
    await db.admin.query("BEGIN");
    try {
      await projectRunnerProgress(db.admin, { accountId, runId, stored });
      await db.admin.query("COMMIT");
    } catch (err) {
      await db.admin.query("ROLLBACK");
      throw err;
    }
    const rows = (await db.admin.query(`SELECT kind, payload FROM run_events WHERE run_id = $1 ORDER BY seq`, [runId])).rows;
    for (const row of rows) expect(activityRowProblem(row), JSON.stringify(row)).toBeNull(); // the shared shape the api stream test also holds its row to
    return rows;
  }

  it("a tool_use with an activity field is one agent.activity row whose payload is that activity; a second one 1 s later is a second row", async () => {
    expect(await project([toolUse(1, 0, { tool: "read", path: "src/theme.ts" }), toolUse(2, 1000, { tool: "test", command: "pnpm test" })])).toEqual([
      { kind: "agent.activity", payload: { tool: "read", path: "src/theme.ts" } },
      { kind: "agent.activity", payload: { tool: "test", command: "pnpm test" } },
    ]);
  });

  it("an older runner's tool_use (no activity field) is a kind-and-path row", async () => {
    const rows = await project([{ seq: 1, ts: "2026-11-03T12:00:00.000Z", type: "tool_use", tool_name: "Read", file_path: "src/a.ts" } as LocalOnlyEvent]);
    expect(rows).toEqual([{ kind: "agent.activity", payload: { tool: "read", path: "src/a.ts" } }]);
  });
});
