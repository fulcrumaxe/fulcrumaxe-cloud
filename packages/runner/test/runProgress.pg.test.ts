import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import type { ToolUse } from "@fx/runtime/src/toolActivity.js";
import { RUN_PROGRESS_LIMITS, RunProgressRecorder, activityFor, type ProgressClock } from "../src/runProgress.js";
import { insertAgentRun } from "../src/runStatusWriter.js";
import type { NormalizedEvent } from "../src/types.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount } from "./helpers/seed.js";

/** A clock the test moves by hand; timers fire only when asked. */
function manualClock(): ProgressClock & { t: number; fire(): void; armed(): number } {
  const timers = new Map<number, () => void>();
  let next = 1;
  const clock = {
    t: 1_000_000,
    now: () => clock.t,
    set: (fn: () => void) => {
      timers.set(next, fn);
      return next++;
    },
    clear: (id: unknown) => void timers.delete(id as number),
    fire: () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    armed: () => timers.size,
  };
  return clock;
}

const ev = (toolUses?: ToolUse[], toolResults?: NormalizedEvent["toolResults"]): NormalizedEvent => ({
  runId: "r",
  role: "preview",
  seq: 1,
  type: toolResults ? "user" : "assistant",
  ts: new Date().toISOString(),
  ...(toolUses && { toolUses }),
  ...(toolResults && { toolResults }),
});
const read = (path: string, id = `id-${path}`): ToolUse => ({ id, tool: "read", path });

/** D#2 PREVIEW-RUNNER-EVENTS: the stage and activity writer against real Postgres (storage, tenancy, caps). [pg] */
describe("run progress recorder [pg]", { timeout: 60_000 }, () => {
  const db = pgHarness();

  async function seedRun(): Promise<{ accountId: string; runId: string }> {
    const accountId = randomUUID();
    await seedAccount(db.admin, accountId);
    const { id } = await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId, role: "executor", runtime: "production" });
    return { accountId, runId: id };
  }
  const rows = async (runId: string, kind?: string) =>
    (await db.admin.query(`SELECT account_id, seq, kind, payload FROM run_events WHERE run_id = $1 AND kind LIKE $2 ORDER BY seq`, [runId, kind ?? "%"])).rows as Array<{
      account_id: string;
      seq: string;
      kind: string;
      payload: Record<string, unknown>;
    }>;
  /** Events accepted one second apart, so the rate limit never folds them. */
  const feed = async (rec: RunProgressRecorder, clock: ReturnType<typeof manualClock>, events: NormalizedEvent[]) => {
    for (const e of events) {
      rec.observe(e);
      clock.t += 1000;
    }
  };

  it("stores an activity row with only the kind and the safe path or term, under the run's own account", async () => {
    const { accountId, runId } = await seedRun();
    const clock = manualClock();
    const rec = new RunProgressRecorder(db.runWriterPool, accountId, runId, clock);
    await feed(rec, clock, [
      ev([read("src/server.ts")]),
      ev([{ id: "s", tool: "search", pattern: "createServer" }]),
      ev([{ id: "l", tool: "list", path: "src" }]),
      ev([{ id: "t", tool: "test" }]),
      ev([{ id: "c", tool: "command" }]),
    ]);
    await rec.finish();
    const stored = await rows(runId, "agent.activity");
    expect(stored.map((r) => r.payload)).toEqual([
      { tool: "read", path: "src/server.ts" },
      { tool: "search", pattern: "createServer" },
      { tool: "list", path: "src" },
      { tool: "test" },
      { tool: "command" },
    ]);
    expect(new Set(stored.map((r) => r.account_id))).toEqual(new Set([accountId]));
    // Another account sees none of it through RLS.
    const other = randomUUID();
    await seedAccount(db.admin, other);
    const seen = await withTenant(db.pureAppUserPool, other, (c) => c.query(`SELECT 1 FROM run_events WHERE run_id = $1`, [runId]));
    expect(seen.rows).toHaveLength(0);
  });

  it("marks each stage once per run, even across a second recorder for the same run", async () => {
    const { accountId, runId } = await seedRun();
    const a = new RunProgressRecorder(db.runWriterPool, accountId, runId, manualClock());
    a.stage("sandbox_ready");
    a.stage("sandbox_ready");
    a.observe(ev([{ id: "w", writes: true }]));
    a.observe({ ...ev(), writesResult: true }); // the result envelope opening: the same stage, still once
    a.observe(ev([{ id: "w2", writes: true }]));
    await a.finish();
    // A resumed run lands on another instance: its recorder seeds from what is stored.
    const b = new RunProgressRecorder(db.runWriterPool, accountId, runId, manualClock());
    b.stage("sandbox_ready");
    b.stage("cloned");
    await b.finish();
    expect((await rows(runId, "run.stage")).map((r) => r.payload)).toEqual([{ stage: "sandbox_ready" }, { stage: "writing_result" }, { stage: "cloned" }]);
  });

  it("marks cloned only when the clone command's own result comes back without an error", async () => {
    const { accountId, runId } = await seedRun();
    const rec = new RunProgressRecorder(db.runWriterPool, accountId, runId, manualClock());
    rec.observe(ev([{ id: "clone-1", tool: "command", clone: true }]));
    rec.observe(ev(undefined, [{ id: "other", ok: true }])); // not the clone's result
    rec.observe(ev(undefined, [{ id: "clone-1", ok: false }])); // the clone failed
    rec.observe(ev(undefined, [{ id: "clone-1", ok: true }])); // already settled as failed: a replay does not count
    await rec.finish();
    expect(await rows(runId, "run.stage")).toHaveLength(0);
    const ok = new RunProgressRecorder(db.runWriterPool, accountId, runId, manualClock());
    ok.observe(ev([{ id: "clone-2", tool: "command", clone: true }]));
    ok.observe(ev(undefined, [{ id: "clone-2", ok: true }]));
    await ok.finish();
    expect((await rows(runId, "run.stage")).map((r) => r.payload)).toEqual([{ stage: "cloned" }]);
  });

  it("caps activity at 200 rows per run, then leaves one capped row saying how many were folded away", async () => {
    const { accountId, runId } = await seedRun();
    const clock = manualClock();
    const rec = new RunProgressRecorder(db.runWriterPool, accountId, runId, clock);
    const total = RUN_PROGRESS_LIMITS.maxActivityRows + 7;
    for (let i = 0; i < total; i++) {
      rec.observe(ev([read(`src/f${i}.ts`)]));
      clock.t += 1000;
      // Let the writes land so the bounded queue never takes part in this test.
      if (i % 10 === 9) await rec.idle();
    }
    await rec.finish();
    expect(await rows(runId, "agent.activity")).toHaveLength(RUN_PROGRESS_LIMITS.maxActivityRows);
    expect((await rows(runId, "agent.activity.capped")).map((r) => r.payload)).toEqual([{ dropped: 7 }]);
    // A resumed recorder starts from the stored 200: nothing more is written, and its own capped row says so.
    const again = new RunProgressRecorder(db.runWriterPool, accountId, runId, clock);
    again.observe(ev([read("src/late.ts")]));
    await again.finish();
    expect(await rows(runId, "agent.activity")).toHaveLength(RUN_PROGRESS_LIMITS.maxActivityRows);
  });

  it("rate-limits: a burst inside the gap becomes its first event now and its newest event later, the rest coalesced", async () => {
    const { accountId, runId } = await seedRun();
    const clock = manualClock();
    const rec = new RunProgressRecorder(db.runWriterPool, accountId, runId, clock);
    for (let i = 0; i < 20; i++) rec.observe(ev([read(`src/b${i}.ts`)])); // all at the same instant
    expect(clock.armed()).toBe(1); // one flush timer, not twenty
    clock.t += RUN_PROGRESS_LIMITS.minActivityGapMs;
    clock.fire();
    await rec.finish();
    expect((await rows(runId, "agent.activity")).map((r) => r.payload.path)).toEqual(["src/b0.ts", "src/b19.ts"]);
    expect(rec.coalesced).toBe(18);
    expect(clock.armed()).toBe(0);
  });

  it("finish writes the newest waiting event without waiting for the timer, and ignores events after it", async () => {
    const { accountId, runId } = await seedRun();
    const clock = manualClock();
    const rec = new RunProgressRecorder(db.runWriterPool, accountId, runId, clock);
    rec.observe(ev([read("src/one.ts")]));
    rec.observe(ev([read("src/two.ts")]));
    await rec.finish();
    rec.observe(ev([read("src/three.ts")]));
    rec.stage("cloned");
    await rec.finish();
    expect((await rows(runId, "agent.activity")).map((r) => r.payload.path)).toEqual(["src/one.ts", "src/two.ts"]);
    expect(await rows(runId, "run.stage")).toHaveLength(0);
  });

  it("stores nothing unsafe: tokens, outside paths, traversal and URLs are dropped before the database", async () => {
    const { accountId, runId } = await seedRun();
    const clock = manualClock();
    const rec = new RunProgressRecorder(db.runWriterPool, accountId, runId, clock);
    const hostile: ToolUse[] = [
      read("src/ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ts"),
      read("/etc/passwd"),
      read("../../etc/shadow"),
      read("https://evil.test/x"),
      read(".env"),
      { id: "x", tool: "list", path: "/root" },
      { id: "y", tool: "search", pattern: "sk-ant-oat01-AAAAAAAAAAAAAAAA" },
      { id: "z", tool: "search", pattern: "see https://evil.test/p" },
      { id: "q", tool: "bogus" as unknown as "read" },
    ];
    await feed(rec, clock, hostile.map((h) => ev([h])));
    await rec.finish();
    const stored = await rows(runId, "agent.activity");
    // The two searches survive as bare searches (no term); everything else has no row at all.
    expect(stored.map((r) => r.payload)).toEqual([{ tool: "search" }, { tool: "search" }]);
    const dump = JSON.stringify(await rows(runId));
    for (const leak of ["ghp_", "passwd", "shadow", "evil.test", ".env", "sk-ant", "/root"]) expect(dump, leak).not.toContain(leak);
  });

  it("a failing write is counted and never thrown, and the stream is never made to wait", async () => {
    const { accountId, runId } = await seedRun();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The wrong account for this run: the composite foreign key refuses the row.
    const stranger = randomUUID();
    await seedAccount(db.admin, stranger);
    const rec = new RunProgressRecorder(db.runWriterPool, stranger, runId, manualClock());
    expect(rec.observe(ev([read("src/a.ts")]))).toBeUndefined(); // synchronous: nothing to await
    rec.stage("cloned");
    await expect(rec.finish()).resolves.toBeUndefined();
    expect(rec.failedWrites).toBeGreaterThan(0);
    expect(await rows(runId, "agent.activity")).toHaveLength(0);
    warn.mockRestore();
    void accountId;
  });

  it("a full write queue drops further events and counts them instead of growing", async () => {
    const { accountId, runId } = await seedRun();
    const clock = manualClock();
    const rec = new RunProgressRecorder(db.runWriterPool, accountId, runId, clock);
    // 100 distinct instants with no await in between: the writes pile up behind the first.
    for (let i = 0; i < 100; i++) {
      rec.observe(ev([read(`src/q${i}.ts`)]));
      clock.t += 1000;
    }
    expect(rec.droppedFull).toBe(100 - RUN_PROGRESS_LIMITS.maxQueued);
    await rec.finish();
    expect((await rows(runId, "agent.activity")).length).toBeLessThanOrEqual(RUN_PROGRESS_LIMITS.maxQueued);
    // The folded ones are said so, not silently lost.
    expect((await rows(runId, "agent.activity.capped"))[0]?.payload.dropped).toBe(rec.overCap);
  });

  // SECURITY (D#483 P4): a command's first line is stored only when it is clean; anything else keeps the kind alone.
  it("stores a clean command's first line and never stores a token, a credentialed URL or an env secret", async () => {
    const { accountId, runId } = await seedRun();
    const clock = manualClock();
    const rec = new RunProgressRecorder(db.runWriterPool, accountId, runId, clock);
    const SECRET_LINES = [
      "curl -H 'Authorization: Bearer sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA' https://api.example.test",
      "echo ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "git push https://x-access-token:abc123SECRET@github.com/o/r.git",
      ["ANTHROPIC_API_KEY=", "abcd1234efgh5678 node run.js"].join(""),
      "node run.js --password hunter2SECRET",
      "echo already [redacted] upstream",
    ];
    await feed(rec, clock, [
      ev([{ id: "ok1", tool: "command", command: "git status --short" }]),
      ev([{ id: "ok2", tool: "test", command: "pnpm vitest run packages/api" }]),
      // Even if a value that is not clean reaches the recorder (any other source), it is dropped here.
      ...SECRET_LINES.map((command, i) => ev([{ id: `bad${i}`, tool: "command", command }])),
      ev([{ id: "ctl", tool: "command", command: "ls\u0007 -la" }]),
      ev([{ id: "long", tool: "command", command: "x".repeat(201) }]),
    ]);
    await rec.finish();
    const stored = (await rows(runId, "agent.activity")).map((r) => r.payload);
    expect(stored).toEqual([
      { tool: "command", command: "git status --short" },
      { tool: "test", command: "pnpm vitest run packages/api" },
      ...SECRET_LINES.map(() => ({ tool: "command" })),
      { tool: "command" },
      { tool: "command" },
    ]);
    // Nothing secret is anywhere in the run's stored events.
    const wire = JSON.stringify(await rows(runId));
    for (const raw of ["sk-ant", "ghp_", "abc123SECRET", "abcd1234", "hunter2SECRET", "x-access-token", "Bearer"]) expect(wire, raw).not.toContain(raw);
  });
});

describe("activityFor", () => {
  it("is the last gate: only the five kinds, a path that passes the read side's own check, a term likewise", () => {
    expect(activityFor({ id: "a", tool: "read", path: "src/a.ts" })).toEqual({ tool: "read", path: "src/a.ts" });
    expect(activityFor({ id: "a", tool: "read" })).toBeNull();
    expect(activityFor({ id: "a", tool: "list" })).toEqual({ tool: "list" });
    expect(activityFor({ id: "a", tool: "read", path: "../x" })).toBeNull();
    expect(activityFor({ id: "a", writes: true })).toBeNull();
    expect(activityFor({ id: "a", tool: "search", pattern: "a*b" })).toEqual({ tool: "search" });
    expect(activityFor({ id: "a", tool: "command", path: "/etc/passwd", pattern: "x" })).toEqual({ tool: "command" });
  });

  it("keeps a clean command line and drops any that redaction would change", () => {
    expect(activityFor({ id: "a", tool: "command", command: "ls -la" })).toEqual({ tool: "command", command: "ls -la" });
    expect(activityFor({ id: "a", tool: "test", command: "pnpm test" })).toEqual({ tool: "test", command: "pnpm test" });
    expect(activityFor({ id: "a", tool: "command", command: "echo sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA" })).toEqual({ tool: "command" });
    expect(activityFor({ id: "a", tool: "command", command: "curl https://u:p@example.test" })).toEqual({ tool: "command" });
    expect(activityFor({ id: "a", tool: "command", command: "" })).toEqual({ tool: "command" });
    // A command never rides on a read, list or search.
    expect(activityFor({ id: "a", tool: "read", path: "src/a.ts", command: "ls" })).toEqual({ tool: "read", path: "src/a.ts" });
  });
});
