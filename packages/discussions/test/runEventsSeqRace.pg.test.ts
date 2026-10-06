import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedMember, seedUser, seedAgentRun } from "./helpers/seed.js";
import { createDiscussion } from "../src/discussions.js";
import { postComment } from "../src/comments.js";
import { MAX_COMMENTS_PER_RUN } from "../src/limits.js";
import { recordAgentOutput } from "../../runner/src/runStatusWriter.js";

/** D#2 H14c-3-2c (R-A): the quota event and an agent.output write for one run share a seq counter and must not collide. [pg] */
describe("run_events seq: discussion_quota_exceeded racing agent.output [pg]", () => {
  const db = pgHarness();

  it("never hits UNIQUE (run_id, seq) and leaves gap-free seqs, looped", async () => {
    const accountId = randomUUID();
    const ownerId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedUser(db.admin, ownerId);
    await seedMember(db.admin, accountId, ownerId, "owner");
    const owner = { kind: "session" as const, accountId, userId: ownerId, role: "owner" as const };
    const discussion = await createDiscussion({ pool: db.appUserPool, principal: owner }, { title: "d", kind: "feature", body: "b" });
    const runId = randomUUID();
    await seedAgentRun(db.admin, accountId, runId, { workItemId: discussion.rootWorkItemId, role: "executor" });
    const run = { kind: "run" as const, accountId, runId };
    for (let i = 0; i < MAX_COMMENTS_PER_RUN; i++) await postComment({ pool: db.appUserPool, principal: run }, { discussionId: discussion.id, body: `c${i}` });

    const rounds = 30;
    for (let i = 0; i < rounds; i++) {
      const results = await Promise.allSettled([
        postComment({ pool: db.appUserPool, principal: run }, { discussionId: discussion.id, body: "over" }),
        recordAgentOutput(db.appUserPool, { accountId, runId, payload: { text: `a${i}` } }),
        recordAgentOutput(db.appUserPool, { accountId, runId, payload: { text: `b${i}` } }),
      ]);
      expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "quota_exceeded" } });
      expect(results.slice(1).map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    }

    const { rows } = await db.admin.query(`SELECT seq::int AS seq, kind FROM run_events WHERE run_id = $1 ORDER BY seq`, [runId]);
    const seqs = rows.map((r: { seq: number }) => r.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => seqs[0]! + i)); // unique and gap-free
    expect(rows.filter((r: { kind: string }) => r.kind === "discussion_quota_exceeded")).toHaveLength(rounds);
    expect(rows.filter((r: { kind: string }) => r.kind === "agent.output")).toHaveLength(rounds * 2);
  });
});
