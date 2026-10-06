import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedTenant, ctxFor, type Tenant } from "./helpers/kit.js";
import { snapshotStore, raceOnCountersLock } from "./helpers/snapshot.js";
import { createDiscussion } from "../src/discussions.js";

/** D#71 DS-2d (C8) criteria 8 and 9 for createDiscussion's sourceEventId. */
describe("createDiscussion sourceEventId [pg]", () => {
  const db = pgHarness();
  const sys = (t: Tenant) => ctxFor(db.appUserPool, t.system);
  const base = { title: "first title", kind: "feature", body: "first body" } as const;

  it("(i) the same key twice returns the same discussion, and the second carries replayed:true", async () => {
    const t = await seedTenant(db.admin);
    const a = await createDiscussion(sys(t), { ...base, sourceEventId: "evt-1" });
    const b = await createDiscussion(sys(t), { ...base, sourceEventId: "evt-1" });
    expect(a.replayed).toBeUndefined();
    expect(b).toMatchObject({ id: a.id, number: a.number, rootWorkItemId: a.rootWorkItemId, replayed: true });
  });

  it("(ii)(iii) crash replay with a different title and body returns the original, and exactly one of everything exists", async () => {
    const t = await seedTenant(db.admin);
    const before = await snapshotStore(db.admin, t.accountId);
    const first = await createDiscussion(sys(t), { ...base, sourceEventId: "evt-crash" });
    void first; // the process "dies" before using the return value
    const replay = await createDiscussion(sys(t), {
      title: "a different title",
      kind: "bug",
      body: "a different body",
      visibility: "public",
      sourceEventId: "evt-crash",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.title).toBe("first title");
    expect(replay.kind).toBe("feature");
    expect(replay.visibility).toBe("private");

    const { rows } = await db.admin.query(`SELECT title, source_event_id FROM discussions WHERE id = $1`, [replay.id]);
    expect(rows[0]).toEqual({ title: "first title", source_event_id: "evt-crash" });
    const { rows: rev } = await db.admin.query(`SELECT body FROM discussion_revisions WHERE discussion_id = $1`, [
      replay.id,
    ]);
    expect(rev).toEqual([{ body: "first body" }]);

    const after = await snapshotStore(db.admin, t.accountId);
    expect(after.discussions).toBe(before.discussions + 1);
    expect(after.workItems).toBe(before.workItems + 1);
    expect(after.revisions).toBe(before.revisions + 1);
    expect(after.events).toBe(before.events + 1);
    expect(Number(after.nextNumber)).toBe(Number(before.nextNumber ?? 1) + 1);
    expect(Number(after.bytesUsed)).toBe(Number(before.bytesUsed ?? 0) + Buffer.byteLength("first body", "utf8"));
  });

  it("(iv) concurrent calls with the same key share one id and burn no number or work item", async () => {
    const t = await seedTenant(db.admin);
    await createDiscussion(sys(t), base); // gives the account a committed counters row (number 1)
    const before = await snapshotStore(db.admin, t.accountId);
    // Every caller reads "no discussion yet" before any of them can allocate a number.
    const results = await raceOnCountersLock(db.adminPool, t.accountId, 3, () =>
      Array.from({ length: 3 }, (_, i) =>
        createDiscussion(sys(t), { ...base, title: `t${i}`, body: `b${i}`, sourceEventId: "evt-race" }),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.replayed).length).toBe(2);
    const after = await snapshotStore(db.admin, t.accountId);
    expect(after).toMatchObject({
      discussions: before.discussions + 1,
      workItems: before.workItems + 1,
      revisions: before.revisions + 1,
      events: before.events + 1,
    });
    // next_number advanced by exactly one, so the next creation has no gap.
    expect(Number(after.nextNumber)).toBe(Number(before.nextNumber) + 1);
    expect(Number(after.bytesUsed) - Number(before.bytesUsed)).toBe(Buffer.byteLength("b0", "utf8"));
    const next = await createDiscussion(sys(t), base);
    expect(next.number).toBe(results[0]!.number + 1);
  });

  it("(v) the same key in another tenant creates that tenant's own discussion", async () => {
    const a = await seedTenant(db.admin);
    const b = await seedTenant(db.admin);
    const da = await createDiscussion(sys(a), { ...base, sourceEventId: "evt-shared" });
    const dbb = await createDiscussion(sys(b), { ...base, sourceEventId: "evt-shared" });
    expect(dbb.replayed).toBeUndefined();
    expect(dbb.id).not.toBe(da.id);
  });

  it("(vi) calls without sourceEventId create a new discussion every time", async () => {
    const t = await seedTenant(db.admin);
    const x = await createDiscussion(sys(t), base);
    const y = await createDiscussion(sys(t), base);
    expect(y.id).not.toBe(x.id);
    expect(y.number).toBe(x.number + 1);
    const { rows } = await db.admin.query(`SELECT source_event_id FROM discussions WHERE id = $1`, [x.id]);
    expect(rows[0].source_event_id).toBeNull();
  });

  it("(9) a session owner, member and token passing sourceEventId get ForbiddenError, and nothing is written", async () => {
    const t = await seedTenant(db.admin);
    const before = await snapshotStore(db.admin, t.accountId);
    for (const principal of [t.owner, t.admin, t.member, t.tokenWrite]) {
      await expect(
        createDiscussion(ctxFor(db.appUserPool, principal), { ...base, sourceEventId: "evt-squat" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await snapshotStore(db.admin, t.accountId)).toEqual(before);
  });

  it("(9) a squatting attempt by a member does not stop the system using the key later", async () => {
    const t = await seedTenant(db.admin);
    await expect(
      createDiscussion(ctxFor(db.appUserPool, t.member), { ...base, sourceEventId: "evt-later" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const ok = await createDiscussion(sys(t), { ...base, sourceEventId: "evt-later" });
    expect(ok.replayed).toBeUndefined();
  });

  it("(9) an empty, 201-character or non-string key is invalid_input", async () => {
    const t = await seedTenant(db.admin);
    const before = await snapshotStore(db.admin, t.accountId);
    for (const bad of ["", "x".repeat(201), 5, null, {}]) {
      await expect(createDiscussion(sys(t), { ...base, sourceEventId: bad as never })).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    expect(await snapshotStore(db.admin, t.accountId)).toEqual(before);
    const ok = await createDiscussion(sys(t), { ...base, sourceEventId: "y".repeat(200) });
    expect(ok.replayed).toBeUndefined();
  });
  it("(9b) a key that is not well-formed Unicode or contains NUL is invalid_input, and lone surrogates do not collide", async () => {
    const t = await seedTenant(db.admin);
    const before = await snapshotStore(db.admin, t.accountId);
    for (const bad of ["sur\uD800", "sur\uDC00", "nul\u0000key", "\u0000"]) {
      await expect(createDiscussion(sys(t), { ...base, sourceEventId: bad })).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    expect(await snapshotStore(db.admin, t.accountId)).toEqual(before);
    const a = await createDiscussion(sys(t), { ...base, sourceEventId: "sur" });
    const b = await createDiscussion(sys(t), { ...base, sourceEventId: "sur\u00e9" });
    expect(a.id).not.toBe(b.id);
  });
});
