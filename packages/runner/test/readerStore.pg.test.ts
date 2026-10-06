import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { AGENT_OUTPUT_LIMITS } from "../src/agentOutput.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { commit, insertReader, releaseLease, renewLease, takeLease, type ReaderCommit } from "../src/readerStore.js";
import { insertAgentRun } from "../src/runStatusWriter.js";
import { seedAccount } from "./helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";

/** D#2 RLR-1: the run-log reader's epoch lease and its single compare-and-swap save. [pg]: real Postgres. */
describe("run-log reader store [pg]", () => {
  const db = pgHarness();

  async function newReader(): Promise<{ accountId: string; runId: string }> {
    const accountId = randomUUID();
    await seedAccount(db.admin, accountId);
    const { id: runId } = await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId, role: "executor", runtime: "production" });
    expect(await insertReader(db.runWriterPool, { accountId, runId, cmdId: "cmd-1" })).toBe(true);
    return { accountId, runId };
  }
  const row = async (runId: string) =>
    (await db.admin.query(`SELECT epoch, next_seq, byte_offset, state, side_effects, read_failures, lease_until > clock_timestamp() AS held FROM run_log_readers WHERE run_id = $1`, [runId])).rows[0] as {
      epoch: string; next_seq: string; byte_offset: string; state: unknown; side_effects: unknown; read_failures: number; held: boolean;
    };
  const expire = (runId: string) => db.admin.query(`UPDATE run_log_readers SET lease_until = clock_timestamp() - interval '1 second' WHERE run_id = $1`, [runId]);
  const outputs = async (runId: string) =>
    (await db.admin.query(`SELECT source_line, payload FROM run_events WHERE run_id = $1 AND kind = 'agent.output' ORDER BY source_line`, [runId])).rows as Array<{ source_line: string; payload: { text: string } }>;
  const save = (accountId: string, runId: string, epoch: number, over: Partial<ReaderCommit> = {}) =>
    commit(db.runWriterPool, { accountId, runId, epoch, nextSeq: 4, byteOffset: 300, state: { meter: 7 }, sideEffects: { warned: true }, readFailures: 0, ...over });

  it("a new row is at epoch 0 with a free lease, and the record path follows the run id", async () => {
    const { runId } = await newReader();
    expect(await row(runId)).toMatchObject({ epoch: "0", next_seq: "1", byte_offset: "0", state: {}, held: false });
    const { rows } = await db.admin.query(`SELECT record_path FROM run_log_readers WHERE run_id = $1`, [runId]);
    expect(rows[0].record_path).toBe(`/fx/run/${runId}.rec`);
  });

  it("inserting a second reader for the same run changes nothing", async () => {
    const { accountId, runId } = await newReader();
    expect(await insertReader(db.runWriterPool, { accountId, runId, cmdId: "cmd-2" })).toBe(false);
    expect((await db.admin.query(`SELECT cmd_id FROM run_log_readers WHERE run_id = $1`, [runId])).rows[0].cmd_id).toBe("cmd-1");
  });

  it("a lease race: of two takers exactly one wins, every time", async () => {
    for (let i = 0; i < 15; i++) {
      const { accountId, runId } = await newReader();
      const got = await Promise.all([takeLease(db.runWriterPool, { accountId, runId }), takeLease(db.runWriterPool, { accountId, runId })]);
      expect(got.filter((c) => c !== null)).toHaveLength(1);
      expect(got.find((c) => c !== null)).toMatchObject({ epoch: 1, cmdId: "cmd-1", nextSeq: 1, byteOffset: 0 });
      expect(await row(runId)).toMatchObject({ epoch: "1", held: true });
    }
  });

  it("a held lease refuses a third taker without raising the epoch", async () => {
    const { accountId, runId } = await newReader();
    expect(await takeLease(db.runWriterPool, { accountId, runId })).not.toBeNull();
    expect(await takeLease(db.runWriterPool, { accountId, runId })).toBeNull();
    expect((await row(runId)).epoch).toBe("1");
  });

  it("an expired lease is taken over with the epoch bumped, and resumes from the last commit", async () => {
    const { accountId, runId } = await newReader();
    const first = (await takeLease(db.runWriterPool, { accountId, runId }))!;
    expect(await save(accountId, runId, first.epoch)).toEqual({ held: true });
    await expire(runId);
    const second = (await takeLease(db.runWriterPool, { accountId, runId }))!;
    expect(second).toMatchObject({ epoch: first.epoch + 1, nextSeq: 4, byteOffset: 300, state: { meter: 7 }, sideEffects: { warned: true } });
  });

  it("a stale epoch is refused: the zombie moves no cursor, no state and writes no row", async () => {
    const { accountId, runId } = await newReader();
    const zombie = (await takeLease(db.runWriterPool, { accountId, runId }))!;
    await expire(runId);
    const taker = (await takeLease(db.runWriterPool, { accountId, runId }))!;
    const before = await row(runId);
    const rows = [{ sourceLine: 1, payload: { text: "from the zombie" } }];
    expect(await save(accountId, runId, zombie.epoch, { nextSeq: 99, byteOffset: 9999, state: { zombie: true }, rows })).toEqual({ held: false });
    expect(await row(runId)).toEqual(before);
    expect(await outputs(runId)).toEqual([]);
    expect(await renewLease(db.runWriterPool, { accountId, runId, epoch: zombie.epoch })).toBe(false);
    expect(await save(accountId, runId, taker.epoch)).toEqual({ held: true });
  });

  it("the right epoch with an expired lease is refused too: the lease must be held", async () => {
    const { accountId, runId } = await newReader();
    const mine = (await takeLease(db.runWriterPool, { accountId, runId }))!;
    await expire(runId);
    expect(await save(accountId, runId, mine.epoch, { rows: [{ sourceLine: 1, payload: { text: "late" } }] })).toEqual({ held: false });
    expect(await renewLease(db.runWriterPool, { accountId, runId, epoch: mine.epoch })).toBe(false);
    expect((await row(runId)).next_seq).toBe("1");
    expect(await outputs(runId)).toEqual([]);
  });

  it("a commit saves cursor, state, flags and rows together and renews the lease", async () => {
    const { accountId, runId } = await newReader();
    const mine = (await takeLease(db.runWriterPool, { accountId, runId }))!;
    await db.admin.query(`UPDATE run_log_readers SET lease_until = clock_timestamp() + interval '2 seconds' WHERE run_id = $1`, [runId]);
    const rows = [{ sourceLine: 1, payload: { text: "one" } }, { sourceLine: 2, payload: { text: "two" } }];
    expect(await save(accountId, runId, mine.epoch, { readFailures: 2, rows })).toEqual({ held: true });
    expect(await row(runId)).toMatchObject({ next_seq: "4", byte_offset: "300", state: { meter: 7 }, side_effects: { warned: true }, read_failures: 2, held: true });
    const left = (await db.admin.query(`SELECT extract(epoch FROM lease_until - clock_timestamp()) AS s FROM run_log_readers WHERE run_id = $1`, [runId])).rows[0].s;
    expect(Number(left)).toBeGreaterThan(50);
    expect((await outputs(runId)).map((r) => [r.source_line, r.payload.text])).toEqual([["1", "one"], ["2", "two"]]);
  });

  it("CAS atomicity: a row that fails mid-batch rolls back the cursor, the state and the earlier rows", async () => {
    const { accountId, runId } = await newReader();
    const mine = (await takeLease(db.runWriterPool, { accountId, runId }))!;
    const before = await row(runId);
    const poisoned = { sourceLine: 2, payload: { text: 10n as unknown as string } };
    await expect(save(accountId, runId, mine.epoch, { rows: [{ sourceLine: 1, payload: { text: "ok" } }, poisoned] })).rejects.toThrow();
    expect(await row(runId)).toEqual(before);
    expect(await outputs(runId)).toEqual([]);
    // An oversize state is refused by the table itself, with the same all-or-nothing result.
    await expect(save(accountId, runId, mine.epoch, { state: { big: "x".repeat(262144) }, rows: [{ sourceLine: 1, payload: { text: "ok" } }] })).rejects.toMatchObject({ code: "23514" });
    expect(await row(runId)).toEqual(before);
    expect(await outputs(runId)).toEqual([]);
  });

  it("a replayed line writes no second row: the source-line key drops it", async () => {
    const { accountId, runId } = await newReader();
    const mine = (await takeLease(db.runWriterPool, { accountId, runId }))!;
    await save(accountId, runId, mine.epoch, { rows: [{ sourceLine: 1, payload: { text: "first" } }, { sourceLine: 2, payload: { text: "second" } }] });
    await save(accountId, runId, mine.epoch, { rows: [{ sourceLine: 2, payload: { text: "again" } }, { sourceLine: 3, payload: { text: "third" } }] });
    expect((await outputs(runId)).map((r) => [r.source_line, r.payload.text])).toEqual([["1", "first"], ["2", "second"], ["3", "third"]]);
  });

  it("the cursor never moves backwards, even at the same epoch; an equal cursor is fine", async () => {
    const { accountId, runId } = await newReader();
    const mine = (await takeLease(db.runWriterPool, { accountId, runId }))!;
    expect(await save(accountId, runId, mine.epoch, { nextSeq: 10, byteOffset: 500 })).toEqual({ held: true });
    expect(await save(accountId, runId, mine.epoch, { nextSeq: 4, byteOffset: 600, state: { back: true } })).toEqual({ held: false });
    expect(await save(accountId, runId, mine.epoch, { nextSeq: 11, byteOffset: 300, state: { back: true } })).toEqual({ held: false });
    expect(await row(runId)).toMatchObject({ next_seq: "10", byte_offset: "500", state: { meter: 7 } });
    expect(await save(accountId, runId, mine.epoch, { nextSeq: 10, byteOffset: 500 })).toEqual({ held: true });
  });

  it("side-effect flags merge: a flag that was true cannot be cleared, new flags are added, unnamed ones stay", async () => {
    const { accountId, runId } = await newReader();
    const mine = (await takeLease(db.runWriterPool, { accountId, runId }))!;
    await save(accountId, runId, mine.epoch, { sideEffects: { warned: true, killed: false, note: "a" } });
    await save(accountId, runId, mine.epoch, { sideEffects: { warned: false, killed: true, extra: true, note: "b" } });
    await save(accountId, runId, mine.epoch, { sideEffects: {} });
    expect((await row(runId)).side_effects).toEqual({ warned: true, killed: true, extra: true, note: "b" });
  });

  it("the lease is judged at the statement's own time, not the transaction's start: a save inside a long transaction after expiry is refused", async () => {
    const { accountId, runId } = await newReader();
    const mine = (await takeLease(db.runWriterPool, { accountId, runId }))!;
    await db.admin.query(`UPDATE run_log_readers SET lease_until = clock_timestamp() + interval '0.5 seconds' WHERE run_id = $1`, [runId]);
    // Every UPDATE on the reader table waits 1.2 s first, inside the same transaction that began before the expiry.
    const slowPool = {
      connect: async () => {
        const c = await db.runWriterPool.connect();
        const q = c.query.bind(c) as (...a: unknown[]) => Promise<unknown>;
        (c as unknown as { query: unknown }).query = async (sql: unknown, ...a: unknown[]) => {
          if (typeof sql === "string" && sql.includes("UPDATE run_log_readers")) await q("SELECT pg_sleep(1.2)");
          return q(sql, ...a);
        };
        return c;
      },
    } as unknown as Pool;
    expect(await commit(slowPool, { accountId, runId, epoch: mine.epoch, nextSeq: 9, byteOffset: 9, state: {}, sideEffects: {}, readFailures: 0 })).toEqual({ held: false });
    expect((await row(runId)).next_seq).toBe("1");
  });

  it("a row payload over the live writer's size cap is refused before anything is written", async () => {
    const { accountId, runId } = await newReader();
    const mine = (await takeLease(db.runWriterPool, { accountId, runId }))!;
    const before = await row(runId);
    const big = { text: "x".repeat(AGENT_OUTPUT_LIMITS.maxPayloadJsonBytes) };
    await expect(save(accountId, runId, mine.epoch, { rows: [{ sourceLine: 1, payload: { text: "ok" } }, { sourceLine: 2, payload: big }] })).rejects.toThrow(/size cap/);
    expect(await row(runId)).toEqual(before);
    expect(await outputs(runId)).toEqual([]);
  });

  it("redaction at source: a line-keyed agent.output row with secret-shaped values is stored redacted", async () => {
    const secrets = [
      "vck_deadbeefCAFEBABE1234567890",
      "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
      "sk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      "whsec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh",
      "fxat_" + "a".repeat(49),
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ];
    const { accountId, runId } = await newReader();
    const mine = (await takeLease(db.runWriterPool, { accountId, runId }))!;
    await save(accountId, runId, mine.epoch, { rows: [{ sourceLine: 1, payload: { text: `leaked: ${secrets.join(" ")}` } }] });
    const stored = (await outputs(runId))[0]!.payload.text;
    for (const s of secrets) expect(stored).not.toContain(s);
    expect(stored).toContain("[redacted]");
  });

  it("release frees the lease for the next taker at once, only for the current epoch", async () => {
    const { accountId, runId } = await newReader();
    const first = (await takeLease(db.runWriterPool, { accountId, runId }))!;
    expect(await releaseLease(db.runWriterPool, { accountId, runId, epoch: first.epoch + 1 })).toBe(false);
    expect((await row(runId)).held).toBe(true);
    expect(await releaseLease(db.runWriterPool, { accountId, runId, epoch: first.epoch })).toBe(true);
    expect(await takeLease(db.runWriterPool, { accountId, runId })).toMatchObject({ epoch: first.epoch + 1 });
  });

  it("tenant isolation: another account's context can take, renew, commit, release and read nothing of this run", async () => {
    const mineRun = await newReader();
    const other = await newReader();
    const held = (await takeLease(db.runWriterPool, mineRun))!;
    expect(await takeLease(db.runWriterPool, { accountId: other.accountId, runId: mineRun.runId })).toBeNull();
    await expire(mineRun.runId);
    expect(await takeLease(db.runWriterPool, { accountId: other.accountId, runId: mineRun.runId })).toBeNull();
    expect(await renewLease(db.runWriterPool, { accountId: other.accountId, runId: mineRun.runId, epoch: held.epoch })).toBe(false);
    expect(await commit(db.runWriterPool, { accountId: other.accountId, runId: mineRun.runId, epoch: held.epoch, nextSeq: 50, byteOffset: 1, state: {}, sideEffects: {}, readFailures: 0 })).toEqual({ held: false });
    expect(await releaseLease(db.runWriterPool, { accountId: other.accountId, runId: mineRun.runId, epoch: held.epoch })).toBe(false);
    expect((await row(mineRun.runId)).next_seq).toBe("1");
    const seen = await withTenant(db.runWriterPool, other.accountId, async (c) => (await c.query(`SELECT run_id FROM run_log_readers`)).rows.map((r) => r.run_id));
    expect(seen).toEqual([other.runId]);
    await expect(
      withTenant(db.runWriterPool, other.accountId, (c) =>
        c.query(`INSERT INTO run_log_readers (run_id, account_id, cmd_id, record_path) VALUES ($1::uuid, $2, 'x', '/fx/run/' || $1::text || '.rec')`, [mineRun.runId, mineRun.accountId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
