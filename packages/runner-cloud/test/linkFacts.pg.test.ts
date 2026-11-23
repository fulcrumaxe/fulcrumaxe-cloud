import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { listRunners, type RunnerRow } from "../src/index.js";
import { harness, respond, type Harness } from "./helpers.js";

/** [pg] D#845 ON-7a2: `linked_at` and `linked_from_ip` on GET /api/runners, from runner_link_facts (owner or admin only). */
type Row = RunnerRow & { linked_at: string | null; linked_from_ip: string | null };

describe("the link line on the fleet read [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  async function linked(f: F2Fixture, ip: string | null, at = "2026-11-20T10:30:00.000Z"): Promise<string> {
    const id = await insertRunner(h.admin, f.accountId, f.o1);
    await h.admin.query("INSERT INTO runner_link_facts (runner_id, account_id, linked_at, linked_from_ip) VALUES ($1, $2, $3, $4)", [id, f.accountId, at, ip]);
    return id;
  }
  const list = async (f: F2Fixture, userId: string, over: Parameters<Harness["deps"]>[0] = {}): Promise<Row[]> => {
    const res = await respond(() => listRunners(h.deps(over), { accountId: f.accountId, userId }));
    expect(res.status).toBe(200);
    return (res.body as { runners: Row[] }).runners;
  };

  it("an owner and an admin see when and from where; a member sees null for both, and nothing about the address is anywhere in their body", async () => {
    const f = await fresh();
    const id = await linked(f, "203.0.113.77");
    for (const who of [f.o1, f.a1]) expect((await list(f, who)).find((r) => r.id === id)).toMatchObject({ linked_at: "2026-11-20T10:30:00.000Z", linked_from_ip: "203.0.113.77" });
    const asMember = await list(f, f.m1);
    expect(asMember.find((r) => r.id === id)).toMatchObject({ linked_at: null, linked_from_ip: null });
    expect(JSON.stringify(asMember)).not.toContain("203.0.113.77");
  });

  it("a machine linked without a usable address has a date and a null address; a machine with no link fact has neither; there is no country field", async () => {
    const f = await fresh();
    const noIp = await linked(f, null);
    const plain = await insertRunner(h.admin, f.accountId, f.o1);
    const rows = await list(f, f.o1);
    expect(rows.find((r) => r.id === noIp)).toMatchObject({ linked_at: "2026-11-20T10:30:00.000Z", linked_from_ip: null });
    expect(rows.find((r) => r.id === plain)).toMatchObject({ linked_at: null, linked_from_ip: null });
    expect(Object.keys(rows[0]!).filter((k) => /country|geo|^city$|region/i.test(k))).toEqual([]);
  });

  it("tenant: another account's link facts never show, through row security and through a connection that bypasses it", async () => {
    const f = await fresh();
    const other = await fresh();
    const mine = await linked(f, "198.51.100.5");
    const theirs = await linked(other, "192.0.2.99");
    for (const over of [{}, { appUserPool: h.adminPool }]) {
      const rows = await list(f, f.o1, over);
      expect(rows.map((r) => r.id)).not.toContain(theirs);
      expect(rows.find((r) => r.id === mine)?.linked_from_ip).toBe("198.51.100.5");
      expect(JSON.stringify(rows)).not.toContain("192.0.2.99");
    }
    // The other account's owner sees only theirs.
    expect((await list(other, other.o1)).find((r) => r.id === theirs)?.linked_from_ip).toBe("192.0.2.99");
  });

  it("a member's list never even reads the table (no role means no read)", async () => {
    const f = await fresh();
    await linked(f, "203.0.113.9");
    // Through the connection that bypasses row security the role check alone must keep the address from a member.
    const rows = await list(f, f.m1, { appUserPool: h.adminPool });
    expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
  });
});
