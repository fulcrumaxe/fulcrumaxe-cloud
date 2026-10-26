import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { getDialSettingAt } from "@fx/db/src/decisions.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import {
  DECISION_SNAPSHOT_KIND,
  DecisionSnapshotInvalidError,
  buildDecisionSnapshot,
  dispositionForDial,
  readDecisionSnapshot,
  readSnapshotDials,
  writeDecisionSnapshot,
} from "../src/decisionSnapshot.js";
import { getCatalogueEntry } from "@fx/decisions";

/** [pg] D#7 DP4b-1 criterion 3: the snapshot row on real Postgres, written on the caller's client and read back through the same schema. */
describe("decision snapshot [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let t: SeedRefs;
  let other: SeedRefs;

  /** A fresh run of `t` (a snapshot is one per run). */
  async function newRun(ref: SeedRefs = t): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', 'running')`, [id, ref.accountId, ref.workItemId]);
    return id;
  }
  const rows = async (runId: string) => (await admin.query(`SELECT kind, payload, seq FROM run_events WHERE run_id = $1 AND kind = $2 ORDER BY seq`, [runId, DECISION_SNAPSHOT_KIND])).rows;
  const SNAPSHOT = buildDecisionSnapshot({ role: "executor", dials: new Map() });

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    t = await seedAccount(admin, randomUUID());
    other = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  it("writes one decision.snapshot row and reads it back, payload for payload", async () => {
    const runId = await newRun();
    await withTenant(appPool, t.accountId, (c) => writeDecisionSnapshot(c, runId, SNAPSHOT));
    const stored = await rows(runId);
    expect(stored).toHaveLength(1);
    expect(stored[0].payload).toEqual(SNAPSHOT);
    expect(await withTenant(appPool, t.accountId, (c) => readDecisionSnapshot(c, runId))).toEqual(SNAPSHOT);
  });

  it("a run with no snapshot reads as null (the caller refuses every request as missing), and another tenant's run reads as null too", async () => {
    const runId = await newRun();
    expect(await withTenant(appPool, t.accountId, (c) => readDecisionSnapshot(c, runId))).toBeNull();
    const foreign = await newRun(other);
    await withTenant(appPool, other.accountId, (c) => writeDecisionSnapshot(c, foreign, SNAPSHOT));
    expect(await withTenant(appPool, t.accountId, (c) => readDecisionSnapshot(c, foreign))).toBeNull();
  });

  it("refuses a stored payload that fails its own schema, and a run with two snapshot rows, and never returns either", async () => {
    const bad = await newRun();
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, $3, $4::jsonb)`, [t.accountId, bad, DECISION_SNAPSHOT_KIND, JSON.stringify({ catalogue_version: 3, entries: [{ key: "d1", decision_type: "test_strategy_choice", disposition: "act", dial_version: 0, class: "human_over_the_loop" }] })]);
    await expect(withTenant(appPool, t.accountId, (c) => readDecisionSnapshot(c, bad))).rejects.toBeInstanceOf(DecisionSnapshotInvalidError);

    const twice = await newRun();
    await withTenant(appPool, t.accountId, (c) => writeDecisionSnapshot(c, twice, SNAPSHOT));
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 99, $3, $4::jsonb)`, [t.accountId, twice, DECISION_SNAPSHOT_KIND, JSON.stringify(SNAPSHOT)]);
    await expect(withTenant(appPool, t.accountId, (c) => readDecisionSnapshot(c, twice))).rejects.toBeInstanceOf(DecisionSnapshotInvalidError);
  });

  it("refuses to write an invalid snapshot, or one with no session tenant, before anything is stored", async () => {
    const runId = await newRun();
    await expect(withTenant(appPool, t.accountId, (c) => writeDecisionSnapshot(c, runId, { catalogue_version: 3, entries: [{ key: "x", decision_type: "a", disposition: "act", dial_version: 0 }] }))).rejects.toBeInstanceOf(DecisionSnapshotInvalidError);
    const bare = await appPool.connect();
    try {
      await expect(writeDecisionSnapshot(bare, runId, SNAPSHOT)).rejects.toThrow("decision_snapshot_no_tenant");
    } finally {
      bare.release();
    }
    expect(await rows(runId)).toEqual([]);
  });

  it("commits or rolls back with the transaction it is written in: a failure after the write leaves no row", async () => {
    const runId = await newRun();
    await expect(
      withTenant(appPool, t.accountId, async (c) => {
        await writeDecisionSnapshot(c, runId, SNAPSHOT);
        throw new Error("the rest of the create transaction failed");
      }),
    ).rejects.toThrow("the rest of the create transaction failed");
    expect(await rows(runId)).toEqual([]);
  });

  it("an empty snapshot is written like any other (a role with no declarations still has one, so its requests are refused as unmapped, not as missing)", async () => {
    const runId = await newRun();
    const empty = buildDecisionSnapshot({ role: "code-reviewer", dials: new Map() });
    await withTenant(appPool, t.accountId, (c) => writeDecisionSnapshot(c, runId, empty));
    expect(await withTenant(appPool, t.accountId, (c) => readDecisionSnapshot(c, runId))).toEqual(empty);
  });

  it("builds from the dial rows in force and the tamper check can recompute from the version it stored: version 0, then rows 1 to 3", async () => {
    const TYPE = "test_strategy_choice";
    const entry = getCatalogueEntry(TYPE)!;
    const dialRepo = t.repoId;
    const snapshotNow = async (): Promise<ReturnType<typeof buildDecisionSnapshot>> =>
      withTenant(appPool, t.accountId, async (c) => buildDecisionSnapshot({ role: "x", declared: [TYPE], dials: await readSnapshotDials(c, dialRepo, [TYPE, "not_in_the_catalogue"]) }));
    const write = (version: number, disposition: string, preset: string | null): Promise<unknown> =>
      admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [t.accountId, dialRepo, TYPE, disposition, preset, version, t.userId]);

    // No row: the Balanced preset's value (owner ruling 2026-10-25), not the catalogue default, which is unchanged and is "ask".
    expect(entry.defaultDisposition).toBe("ask");
    expect((await snapshotNow()).entries[0]).toMatchObject({ dial_version: 0, disposition: "announce" });
    await write(1, "ask", "cautious");
    await write(2, "announce", null);
    const frozen = await snapshotNow();
    expect(frozen.entries[0]).toMatchObject({ dial_version: 2, disposition: "announce" });
    // A dial change after the snapshot does not change it (frozen at spawn) ...
    await write(3, "act", "autonomous");
    expect(frozen.entries[0]).toMatchObject({ dial_version: 2, disposition: "announce" });
    // ... and the version it recorded still resolves, so a tamper check recomputes the same disposition from the row at that version.
    await withTenant(appPool, t.accountId, async (c) => {
      const row = await getDialSettingAt(c, dialRepo, TYPE, frozen.entries[0]!.dial_version);
      expect(row).not.toBeNull();
      expect(dispositionForDial(entry, { version: row!.version, disposition: row!.disposition, preset: row!.preset })).toBe(frozen.entries[0]!.disposition);
    });
    expect((await snapshotNow()).entries[0]).toMatchObject({ dial_version: 3 });
  });
});
