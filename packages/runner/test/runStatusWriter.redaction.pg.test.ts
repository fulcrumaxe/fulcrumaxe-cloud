import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { insertAgentRun, writeRunStatus } from "../src/runStatusWriter.js";
import { listRunEvents } from "@fx/core/src/events/read.js";
import { seedAccount, seedMember, seedRepo } from "./helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * D#2 H11 criterion 2 (redaction at source, corrected by D#31 comment
 * 18494573 C5): "events are redacted before insert into run_events for
 * injected fake secrets ... A test inserts events containing each and
 * asserts the stored payload and the stream both lack them." This is
 * that test, end to end against real Postgres: `writeRunStatus` (the
 * only `run_events` writer, per `runStatusWriter.ts`'s own header) is
 * the insert path, and `listRunEvents` (`@fx/core/src/events/read.ts`,
 * this same correction's "one service both the SSE replay and the JSON
 * page mode use") is "the stream".
 */
describe("runStatusWriter -> run_events redaction at source [pg]", () => {
  const db = pgHarness();

  const FAKE_SECRETS = [
    "vck_deadbeefCAFEBABE1234567890",
    "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    "sk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "whsec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh",
    "fxat_" + "a".repeat(49),
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ];

  it("a failureReason containing every fake secret shape is redacted in both the stored row and listRunEvents' output", async () => {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId, { role: "owner" });
    await seedRepo(db.admin, accountId, repoId);

    const { id: runId } = await insertAgentRun(db.runWriterPool, {
      id: randomUUID(),
      accountId,
      role: "executor",
      runtime: "production",
    });
    await writeRunStatus(db.runWriterPool, { accountId, runId, from: "pending", to: "running" });

    const failureReason = `leaked: ${FAKE_SECRETS.join(" ")}`;
    await writeRunStatus(db.runWriterPool, {
      accountId,
      runId,
      from: "running",
      to: "failed",
      failureReason,
    });

    // The stored payload (queried directly, bypassing the service layer).
    const stored = await db.admin.query<{ payload: { failureReason?: string } }>(
      `SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'failed'`,
      [runId],
    );
    expect(stored.rows).toHaveLength(1);
    const storedReason = stored.rows[0]!.payload.failureReason ?? "";
    for (const secret of FAKE_SECRETS) {
      expect(storedReason).not.toContain(secret);
    }
    expect(storedReason).toContain("[redacted]");

    // "The stream": listRunEvents, the one service both the SSE replay
    // and the JSON page mode use (D#31 comment 18494573 C5).
    const page = await listRunEvents({ pool: db.runWriterPool, principal: { accountId, userId } }, runId, {
      limit: 50,
    });
    const failedEvent = page.data.find((e) => e.kind === "run.status_changed" && (e.payload as { to?: string }).to === "failed");
    expect(failedEvent).toBeDefined();
    const streamedReason = (failedEvent!.payload as { failureReason?: string }).failureReason ?? "";
    for (const secret of FAKE_SECRETS) {
      expect(streamedReason).not.toContain(secret);
    }
    expect(streamedReason).toContain("[redacted]");
  });
});
