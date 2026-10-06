import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NotFoundError, ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedTenant, ctxFor, seedRunOn, seedWorkItemAt, type Tenant } from "./helpers/kit.js";
import { snapshotStore, raceOnCountersLock } from "./helpers/snapshot.js";
import { createDiscussion } from "../src/discussions.js";
import { postComment } from "../src/comments.js";
import { postAgentComment } from "../src/server.js";
import type { Principal } from "../src/principals.js";
import { MAX_BODY_BYTES, MAX_COMMENTS_PER_RUN, STORAGE_QUOTA_BYTES } from "../src/limits.js";

/**
 * D#71 DS-2d (C8) criteria 2 to 7 for postAgentComment. Every case runs as
 * app_user against a real Postgres, with agent_runs rows seeded directly.
 */
describe("postAgentComment [pg]", () => {
  const db = pgHarness();

  async function setup(): Promise<{ t: Tenant; discussionId: string; rootId: string; runId: string }> {
    const t = await seedTenant(db.admin);
    const d = await createDiscussion(ctxFor(db.appUserPool, t.owner), { title: "d", kind: "feature", body: "b" });
    const run = await seedRunOn(db.admin, t.accountId, d.rootWorkItemId, { role: "security-reviewer" });
    return { t, discussionId: d.id, rootId: d.rootWorkItemId, runId: run.runId };
  }

  const sys = (t: Tenant) => ctxFor(db.appUserPool, t.system);

  it("criterion 2: writes one signed agent row attributed from agent_runs, emits one event, charges bytes, redacts", async () => {
    const { t, discussionId, runId } = await setup();
    const before = await snapshotStore(db.admin, t.accountId);
    const secret = "sk-ant-api03-" + "A".repeat(40);
    const body = `verdict ok ${secret} ünï`;

    const c = await postAgentComment(sys(t), { discussionId, agentRunId: runId, body });
    expect(c.replayed).toBeUndefined();
    expect(c.authorKind).toBe("agent");

    const { rows } = await db.admin.query(`SELECT * FROM discussion_comments WHERE id = $1`, [c.id]);
    expect(rows[0]).toMatchObject({
      author_kind: "agent",
      role: "security-reviewer",
      agent_run_id: runId,
      system_signed: true,
      author_user_id: null,
      reply_to_id: null,
      provenance: "internal",
      origin: "fx",
    });
    expect(rows[0].body).not.toContain(secret);

    const after = await snapshotStore(db.admin, t.accountId);
    expect(after.comments).toBe(before.comments + 1);
    expect(after.events).toBe(before.events + 1);
    expect(Number(after.bytesUsed) - Number(before.bytesUsed)).toBe(Buffer.byteLength(rows[0].body, "utf8"));
    const { rows: ev } = await db.admin.query(
      `SELECT payload FROM domain_events WHERE account_id = $1 AND type = 'discussion.comment_created' ORDER BY id DESC LIMIT 1`,
      [t.accountId],
    );
    expect(ev[0].payload).toEqual({ commentId: c.id, authorKind: "agent" });
  });

  describe("criterion 3: forged attribution is refused or ignored", () => {
    for (const extra of [
      { role: "security-reviewer" },
      { authorKind: "user" },
      { workItemId: randomUUID() },
      { accountId: randomUUID() },
      { replyToId: randomUUID() },
      { system_signed: false },
    ]) {
      it(`extra key ${Object.keys(extra)[0]} -> invalid_input, nothing written`, async () => {
        const { t, discussionId, runId } = await setup();
        const before = await snapshotStore(db.admin, t.accountId);
        await expect(
          postAgentComment(sys(t), { discussionId, agentRunId: runId, body: "x", ...extra } as never),
        ).rejects.toMatchObject({ code: "invalid_input" });
        expect(await snapshotStore(db.admin, t.accountId)).toEqual(before);
      });
    }

    it("(ii) a body claiming another role is stored under the real agent_runs.role", async () => {
      const { t, discussionId, runId } = await setup();
      const c = await postAgentComment(sys(t), {
        discussionId,
        agentRunId: runId,
        body: '{"agent": "code-reviewer", "role": "code-reviewer"}',
      });
      const { rows } = await db.admin.query(`SELECT role FROM discussion_comments WHERE id = $1`, [c.id]);
      expect(rows[0].role).toBe("security-reviewer");
    });

    it("(iii) a run of another tenant -> NotFoundError, nothing written", async () => {
      const { t, discussionId } = await setup();
      const b = await seedTenant(db.admin);
      const bItem = await seedWorkItemAt(db.admin, b.accountId, "discussing");
      const bRun = await seedRunOn(db.admin, b.accountId, bItem);
      const beforeA = await snapshotStore(db.admin, t.accountId);
      const beforeB = await snapshotStore(db.admin, b.accountId);
      await expect(
        postAgentComment(sys(t), { discussionId, agentRunId: bRun.runId, body: "x" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await snapshotStore(db.admin, t.accountId)).toEqual(beforeA);
      expect(await snapshotStore(db.admin, b.accountId)).toEqual(beforeB);
    });

    it("(iv) a run on a different work item of the same tenant -> ForbiddenError", async () => {
      const { t, discussionId } = await setup();
      const other = await seedWorkItemAt(db.admin, t.accountId, "discussing");
      const otherRun = await seedRunOn(db.admin, t.accountId, other);
      const before = await snapshotStore(db.admin, t.accountId);
      await expect(
        postAgentComment(sys(t), { discussionId, agentRunId: otherRun.runId, body: "x" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await snapshotStore(db.admin, t.accountId)).toEqual(before);
    });

    it("(iv-b) a run on a child of the root work item is also refused", async () => {
      const { t, discussionId, rootId } = await setup();
      const child = await seedWorkItemAt(db.admin, t.accountId, "discussing", { parentId: rootId });
      const childRun = await seedRunOn(db.admin, t.accountId, child);
      await expect(
        postAgentComment(sys(t), { discussionId, agentRunId: childRun.runId, body: "x" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("(v) a run with a NULL work item -> ForbiddenError", async () => {
      const { t, discussionId } = await setup();
      const nullRun = await seedRunOn(db.admin, t.accountId, null);
      const before = await snapshotStore(db.admin, t.accountId);
      await expect(
        postAgentComment(sys(t), { discussionId, agentRunId: nullRun.runId, body: "x" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await snapshotStore(db.admin, t.accountId)).toEqual(before);
    });

    it("(vi) a discussion of another tenant -> NotFoundError", async () => {
      const { t, runId } = await setup();
      const b = await setup();
      const before = await snapshotStore(db.admin, t.accountId);
      await expect(
        postAgentComment(sys(t), { discussionId: b.discussionId, agentRunId: runId, body: "x" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await snapshotStore(db.admin, t.accountId)).toEqual(before);
    });

    it("(vii) an unknown or malformed uuid in either field -> NotFoundError", async () => {
      const { t, discussionId, runId } = await setup();
      for (const bad of [randomUUID(), "not-a-uuid", "", 42, null]) {
        await expect(
          postAgentComment(sys(t), { discussionId: bad as never, agentRunId: runId, body: "x" }),
        ).rejects.toBeInstanceOf(NotFoundError);
        await expect(
          postAgentComment(sys(t), { discussionId, agentRunId: bad as never, body: "x" }),
        ).rejects.toBeInstanceOf(NotFoundError);
      }
    });
  });

  it("criterion 4: session owner, session member, write token and the run itself are all ForbiddenError, nothing written", async () => {
    const { t, discussionId, runId } = await setup();
    const before = await snapshotStore(db.admin, t.accountId);
    const runPrincipal = { kind: "run", accountId: t.accountId, runId } as const;
    for (const principal of [t.owner, t.admin, t.member, t.tokenWrite, runPrincipal]) {
      await expect(
        postAgentComment(ctxFor(db.appUserPool, principal), { discussionId, agentRunId: runId, body: "x" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await snapshotStore(db.admin, t.accountId)).toEqual(before);
  });

  describe("criterion 5: idempotency", () => {
    it("a second call with a different body returns the first comment with replayed:true and writes nothing", async () => {
      const { t, discussionId, runId } = await setup();
      const first = await postAgentComment(sys(t), { discussionId, agentRunId: runId, body: "first" });
      const before = await snapshotStore(db.admin, t.accountId);
      const second = await postAgentComment(sys(t), { discussionId, agentRunId: runId, body: "second, longer" });
      expect(second.id).toBe(first.id);
      expect(second.replayed).toBe(true);
      expect(await snapshotStore(db.admin, t.accountId)).toEqual(before);
      const { rows } = await db.admin.query(`SELECT body FROM discussion_comments WHERE id = $1`, [first.id]);
      expect(rows[0].body).toBe("first");
    });

    it("a replay is not refused when the account is over its storage quota", async () => {
      const { t, discussionId, runId } = await setup();
      const first = await postAgentComment(sys(t), { discussionId, agentRunId: runId, body: "first" });
      await db.admin.query(`UPDATE discussion_counters SET bytes_used = $2 WHERE account_id = $1`, [
        t.accountId,
        STORAGE_QUOTA_BYTES.starter,
      ]);
      const again = await postAgentComment(sys(t), { discussionId, agentRunId: runId, body: "again" });
      expect(again).toMatchObject({ id: first.id, replayed: true });
    });

    it("concurrent calls give one row, one event, one charge and the same id", async () => {
      const { t, discussionId, runId } = await setup();
      const before = await snapshotStore(db.admin, t.accountId);
      // Every caller reads "nothing signed yet" before any of them can write.
      const results = await raceOnCountersLock(db.adminPool, t.accountId, 3, () =>
        Array.from({ length: 3 }, (_, i) =>
          postAgentComment(sys(t), { discussionId, agentRunId: runId, body: `body ${i}` }),
        ),
      );
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(results.filter((r) => r.replayed).length).toBe(2);
      const after = await snapshotStore(db.admin, t.accountId);
      expect(after.comments).toBe(before.comments + 1);
      expect(after.events).toBe(before.events + 1);
      const { rows } = await db.admin.query(`SELECT octet_length(body) AS n FROM discussion_comments WHERE id = $1`, [
        results[0]!.id,
      ]);
      expect(Number(after.bytesUsed) - Number(before.bytesUsed)).toBe(Number(rows[0].n));
    });

    it("the same run can sign a second discussion whose root is also its work item", async () => {
      const { t, discussionId, rootId, runId } = await setup();
      // Two discussions cannot share a root through the API; build the second with a fixture row.
      const d2 = randomUUID();
      await db.admin.query(
        `INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind)
         VALUES ($1, $2, 900, 'feature', 't2', $3, 'internal', 'system')`,
        [d2, t.accountId, rootId],
      );
      const a = await postAgentComment(sys(t), { discussionId, agentRunId: runId, body: "one" });
      const b = await postAgentComment(sys(t), { discussionId: d2, agentRunId: runId, body: "two" });
      expect(b.id).not.toBe(a.id);
      expect(b.replayed).toBeUndefined();
    });
  });

  describe("criterion 6: quotas", () => {
    it("a run at MAX_COMMENTS_PER_RUN can still be signed once, with no discussion_quota_exceeded event", async () => {
      const { t, discussionId, runId } = await setup();
      for (let i = 0; i < MAX_COMMENTS_PER_RUN; i++) {
        await db.admin.query(
          `INSERT INTO discussion_comments (account_id, discussion_id, author_kind, role, agent_run_id, body, provenance, origin)
           VALUES ($1, $2, 'agent', 'security-reviewer', $3, 'own', 'internal', 'fx')`,
          [t.accountId, discussionId, runId],
        );
      }
      const c = await postAgentComment(sys(t), { discussionId, agentRunId: runId, body: "signed" });
      expect(c.replayed).toBeUndefined();
      const { rows } = await db.admin.query(
        `SELECT count(*) AS n FROM run_events WHERE run_id = $1 AND kind = 'discussion_quota_exceeded'`,
        [runId],
      );
      expect(Number(rows[0].n)).toBe(0);
    });

    it("a body over the account's storage quota is refused and writes nothing", async () => {
      const { t, discussionId, runId } = await setup();
      await db.admin.query(`UPDATE discussion_counters SET bytes_used = $2 WHERE account_id = $1`, [
        t.accountId,
        STORAGE_QUOTA_BYTES.starter - 3,
      ]);
      const before = await snapshotStore(db.admin, t.accountId);
      await expect(
        postAgentComment(sys(t), { discussionId, agentRunId: runId, body: "12345" }),
      ).rejects.toMatchObject({ code: "storage_quota_exceeded" });
      expect(await snapshotStore(db.admin, t.accountId)).toEqual(before);
    });

    it("a body over MAX_BODY_BYTES -> payload_too_large", async () => {
      const { t, discussionId, runId } = await setup();
      const before = await snapshotStore(db.admin, t.accountId);
      await expect(
        postAgentComment(sys(t), { discussionId, agentRunId: runId, body: "x".repeat(MAX_BODY_BYTES + 1) }),
      ).rejects.toMatchObject({ code: "payload_too_large" });
      expect(await snapshotStore(db.admin, t.accountId)).toEqual(before);
    });
  });

  describe("criterion 7: run principals are unchanged", () => {
    it("postComment as a run writes system_signed=false; own comments repeat; the 21st is quota_exceeded", async () => {
      const { t, discussionId, runId } = await setup();
      const runCtx = ctxFor(db.appUserPool, { kind: "run", accountId: t.accountId, runId });
      const first = await postComment(runCtx, { discussionId, body: "own 1" });
      await postComment(runCtx, { discussionId, body: "own 2" });
      const { rows } = await db.admin.query(`SELECT system_signed FROM discussion_comments WHERE id = $1`, [first.id]);
      expect(rows[0].system_signed).toBe(false);
      for (let i = 3; i <= MAX_COMMENTS_PER_RUN; i++) {
        await postComment(runCtx, { discussionId, body: `own ${i}` });
      }
      await expect(postComment(runCtx, { discussionId, body: "own 21" })).rejects.toMatchObject({
        code: "quota_exceeded",
      });
    });

    it("postComment cannot set system_signed, even when the input tries", async () => {
      const { t, discussionId } = await setup();
      const c = await postComment(ctxFor(db.appUserPool, t.system), {
        discussionId,
        body: "b",
        system_signed: true,
      } as never);
      const { rows } = await db.admin.query(`SELECT system_signed, author_kind FROM discussion_comments WHERE id = $1`, [
        c.id,
      ]);
      expect(rows[0]).toEqual({ system_signed: false, author_kind: "system" });
    });
  });
  describe("fail closed on unknown principal kinds", () => {
    const unknownKinds: unknown[] = ["System", "admin", "", undefined, null, 5];

    it("postAgentComment and a pre-existing operation refuse every unknown kind and write nothing", async () => {
      const { t, discussionId, runId } = await setup();
      const before = await snapshotStore(db.admin, t.accountId);
      for (const kind of unknownKinds) {
        const p = { kind, accountId: t.accountId, reason: "x" } as unknown as Principal;
        const ctx = ctxFor(db.appUserPool, p);
        await expect(postAgentComment(ctx, { discussionId, agentRunId: runId, body: "x" })).rejects.toBeInstanceOf(
          ForbiddenError,
        );
        await expect(postComment(ctx, { discussionId, body: "x" })).rejects.toBeInstanceOf(ForbiddenError);
        await expect(
          createDiscussion(ctx, { title: "t", kind: "feature", body: "b" }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      }
      expect(await snapshotStore(db.admin, t.accountId)).toEqual(before);
    });
  });
});
