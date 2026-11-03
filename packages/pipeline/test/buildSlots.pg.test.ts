import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { createPool } from "@fx/db/src/pool.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount } from "./build/helpers/seed.js";
import { startBuildForItem } from "../src/advance/buildTesting.js";
import { BUILD_SLOT_STAGES, readBuildWaitReason, takeBuildSlot } from "../src/advance/buildSlots.js";
import type { AdvanceRunPorts, AdvanceRunRequest } from "../src/advance/runPorts.js";

/**
 * D#483 S5-c1 [pg]: build slots from the person's concurrency setting, over real rows. Items are inserted at the stage under test; the claim
 * moves them with the same `recordStage` the driver uses.
 */
const h = pgHarness();
const PG_INSUFFICIENT_PRIVILEGE = "42501";

async function account(plan = "starter"): Promise<string> {
  const id = randomUUID();
  await seedAccount(h.admin, id);
  await h.admin.query("UPDATE accounts SET plan = $2 WHERE id = $1", [id, plan]);
  return id;
}

async function repo(accountId: string, mode = "sandbox"): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', $4, 'acme', $5)`, [id, accountId, Math.floor(Math.random() * 1_000_000_000), mode, `w${id.slice(0, 8)}`]);
  return id;
}

/** The repository is paired with a public one: its merges take the direct gate (C32). */
const pair = (repoId: string, accountId: string) =>
  h.admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, $3, $4)", [repoId, accountId, `acme-pub/p${repoId.slice(0, 8)}`, [".autonomous-team/**"]]);

async function user(): Promise<string> {
  const id = randomUUID();
  await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
  return id;
}

async function member(accountId: string, role: "owner" | "admin" | "member"): Promise<string> {
  const id = await user();
  await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, id, role]);
  return id;
}

interface ItemOpts {
  stage?: string;
  priority?: number;
  queueRank?: number | null;
  ghNumber?: number;
  /** A waiting item: the worker's `build_waiting` fact, this many seconds old (true: just now). */
  waiting?: boolean | number;
  withSpec?: boolean;
}
async function item(accountId: string, repoId: string, o: ItemOpts = {}): Promise<string> {
  const id = randomUUID();
  await h.admin.query(
    `INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number, stage, priority, queue_rank)
     VALUES ($1, $2, $3, 'feature', 'running', 'internal', $4, $5, $6, $7)`,
    [id, accountId, repoId, o.ghNumber ?? Math.floor(Math.random() * 100_000) + 1, o.stage ?? "spec_ready", o.priority ?? 2, o.queueRank ?? null],
  );
  if (o.waiting) {
    await h.admin.query(
      `INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'build_waiting', 'waiting_for_build_slot_repo', $3)`,
      [accountId, id, randomUUID()],
    );
    // The table stamps created_at with its own clock on insert; the test ages the fact afterwards as the owner.
    if (typeof o.waiting === "number") await h.admin.query("UPDATE work_item_driver_events SET created_at = now() - make_interval(secs => $2::int) WHERE work_item_id = $1 AND kind = 'build_waiting'", [id, o.waiting]);
  }
  if (o.withSpec) {
    await h.admin.query(
      `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind)
       VALUES ($1, $2, 1, 'Do the thing.', encode(sha256(convert_to('Do the thing.', 'UTF8')), 'hex'), 'system')`,
      [accountId, id],
    );
  }
  return id;
}

const setStage = async (id: string, stage: string): Promise<void> => void (await h.admin.query("UPDATE work_items SET stage = $2 WHERE id = $1", [id, stage]));
const stageOf = async (id: string): Promise<string> => (await h.admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [id])).rows[0]!.stage;

async function setting(accountId: string, repoId: string | null, maxBuilds: number, version = 1): Promise<void> {
  const u = await user();
  await h.admin.query("INSERT INTO build_concurrency_settings (account_id, repo_id, max_builds, version, changed_by) VALUES ($1, $2, $3, $4, $5)", [accountId, repoId, maxBuilds, version, u]);
}

/** What the driver does: take the slot, and in the same transaction move the item to in_progress. */
const claim = (accountId: string, id: string) =>
  takeBuildSlot(h.runWriterPool, accountId, id, (client: PoolClient) => recordStage(client, { workItemId: id, toStage: "in_progress", at: new Date(), source: "control_plane", sourceRef: `slot-test:${randomUUID()}` }));

const heldCount = async (accountId: string): Promise<number> => Number((await h.admin.query<{ n: string }>("SELECT count(*) AS n FROM work_items WHERE account_id = $1 AND stage = ANY($2::text[])", [accountId, [...BUILD_SLOT_STAGES]])).rows[0]!.n);

describe("S5c1-1: parallel claims never pass a limit", () => {
  it("eight claims at once on eight repositories take exactly the account value (the starting 4)", async () => {
    const a = await account();
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await item(a, await repo(a)));
    const results = await Promise.all(ids.map((id) => claim(a, id)));
    expect(results.filter((r) => r.granted)).toHaveLength(4);
    for (const r of results) if (!r.granted) expect(r.reason).toBe("waiting_for_build_slot_account");
    expect(await heldCount(a)).toBe(4);
  });

  it("S5j-1: eight claims at once on one repository with the starting value of 2 take exactly two, and the other six wait with the repository reason", async () => {
    const a = await account();
    const r = await repo(a);
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await item(a, r));
    const results = await Promise.all(ids.map((id) => claim(a, id)));
    expect(results.filter((x) => x.granted)).toHaveLength(2);
    for (const x of results) if (!x.granted) expect(x.reason).toBe("waiting_for_build_slot_repo");
    expect(await heldCount(a)).toBe(2);
  });

  it("eight claims at once on one repository take exactly the repository value, whatever the account value is above it", async () => {
    const a = await account();
    const r = await repo(a);
    await setting(a, r, 3);
    await setting(a, null, 8);
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await item(a, r));
    const results = await Promise.all(ids.map((id) => claim(a, id)));
    expect(results.filter((x) => x.granted)).toHaveLength(3);
    expect(await heldCount(a)).toBe(3);
  });

  it("S5j-1: two claims race for a repository's last slot while one item already holds the other: exactly one wins, and the loser waits with the repository reason", async () => {
    for (let round = 0; round < 5; round++) {
      const a = await account();
      const r = await repo(a);
      expect((await claim(a, await item(a, r))).granted).toBe(true);
      const [x, y] = [await item(a, r), await item(a, r)];
      const [rx, ry] = await Promise.all([claim(a, x), claim(a, y)]);
      expect([rx.granted, ry.granted].sort()).toEqual([false, true]);
      const lost = rx.granted ? ry : rx;
      expect(lost).toEqual({ granted: false, reason: "waiting_for_build_slot_repo" });
      expect(await heldCount(a)).toBe(2);
    }
  });

  it("eight claims on eight repositories with an account value of 8 all start", async () => {
    const a = await account();
    await setting(a, null, 8);
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await item(a, await repo(a)));
    expect((await Promise.all(ids.map((id) => claim(a, id)))).every((x) => x.granted)).toBe(true);
    expect(await heldCount(a)).toBe(8);
  });

  it("a claim for another account's lock does not wait on this account's (the lock is per account)", async () => {
    const a = await account();
    const b = await account();
    const [ra, rb] = [await repo(a), await repo(b)];
    const [ia, ib] = [await item(a, ra), await item(b, rb)];
    const out = await Promise.all([claim(a, ia), claim(b, ib)]);
    expect(out.every((x) => x.granted)).toBe(true);
  });
});

describe("S5c1-2: the starting values, and the person's value on every plan", () => {
  it("with no setting rows: a second item on a repository builds, a third waits, and a fifth hosted item on the account waits", async () => {
    const a = await account();
    const r1 = await repo(a);
    const first = await item(a, r1);
    expect((await claim(a, first)).granted).toBe(true);
    const second = await item(a, r1);
    expect(await readBuildWaitReason(h.runWriterPool, a, second)).toBeNull();
    expect((await claim(a, second)).granted).toBe(true);
    expect(await readBuildWaitReason(h.runWriterPool, a, await item(a, r1))).toBe("waiting_for_build_slot_repo");
    const others: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = await item(a, await repo(a));
      others.push(id);
      expect((await claim(a, id)).granted).toBe(true);
    }
    const fifth = await item(a, await repo(a));
    expect(await readBuildWaitReason(h.runWriterPool, a, fifth)).toBe("waiting_for_build_slot_account");
  });

  it.each(["starter", "team", "pro", "business", "enterprise", "free"])("with an account row of 10 the account limit is 10 on the %s plan", async (plan) => {
    const a = await account(plan);
    await setting(a, null, 10);
    for (let i = 0; i < 10; i++) {
      const id = await item(a, await repo(a));
      expect((await claim(a, id)).granted).toBe(true);
    }
    const eleventh = await item(a, await repo(a));
    expect(await readBuildWaitReason(h.runWriterPool, a, eleventh)).toBe("waiting_for_build_slot_account");
  });

  it("the highest version of a setting is the current one: a lowered value applies", async () => {
    const a = await account();
    await setting(a, null, 10, 1);
    await setting(a, null, 1, 2);
    expect((await claim(a, await item(a, await repo(a)))).granted).toBe(true);
    expect(await readBuildWaitReason(h.runWriterPool, a, await item(a, await repo(a)))).toBe("waiting_for_build_slot_account");
  });
});

describe("S5c1-3 and S5j-1: the repository value is the limit, and the higher-priority waiter takes the slot", () => {
  it("S5j-1: with the value at 2 two items build and a third waits with the repository reason; the reason is derived and disappears when one of the two merges", async () => {
    const a = await account();
    const r = await repo(a);
    await setting(a, r, 2);
    const first = await item(a, r);
    const second = await item(a, r);
    expect((await claim(a, first)).granted).toBe(true);
    expect((await claim(a, second)).granted).toBe(true);
    const third = await item(a, r);
    expect(await readBuildWaitReason(h.runWriterPool, a, third)).toBe("waiting_for_build_slot_repo");
    const denied = await claim(a, third);
    expect(denied).toEqual({ granted: false, reason: "waiting_for_build_slot_repo" });
    expect(await stageOf(third)).toBe("spec_ready");
    // The first goes through its stages: it still holds its slot until it merges.
    for (const stage of ["pr_opened", "changes_requested", "review_passed"]) {
      await setStage(first, stage);
      expect(await readBuildWaitReason(h.runWriterPool, a, third)).toBe("waiting_for_build_slot_repo");
    }
    await setStage(first, "merged");
    expect(await readBuildWaitReason(h.runWriterPool, a, third)).toBeNull();
  });

  it("a value above 2 applies as set: five items build on a repository whose value is 5 and a sixth waits", async () => {
    const a = await account();
    const r = await repo(a);
    await setting(a, r, 5);
    await setting(a, null, 8);
    for (let i = 0; i < 5; i++) expect((await claim(a, await item(a, r))).granted).toBe(true);
    expect(await readBuildWaitReason(h.runWriterPool, a, await item(a, r))).toBe("waiting_for_build_slot_repo");
  });

  it("with the repository value set to one the second item waits with the repository reason", async () => {
    const a = await account();
    const r = await repo(a);
    await setting(a, r, 1);
    await claim(a, await item(a, r));
    expect(await readBuildWaitReason(h.runWriterPool, a, await item(a, r))).toBe("waiting_for_build_slot_repo");
  });

  it("lowering the value from 2 to 1 while two items hold slots: both keep their slots, nothing is moved, and the next claim waits until both are gone (the limit is read at each claim, never stamped on an item)", async () => {
    const a = await account();
    const r = await repo(a);
    await setting(a, r, 2, 1);
    const [first, second] = [await item(a, r), await item(a, r)];
    expect((await claim(a, first)).granted).toBe(true);
    expect((await claim(a, second)).granted).toBe(true);
    await setting(a, r, 1, 2);
    expect([await stageOf(first), await stageOf(second)]).toEqual(["in_progress", "in_progress"]);
    expect(await heldCount(a)).toBe(2);
    const third = await item(a, r);
    expect(await claim(a, third)).toEqual({ granted: false, reason: "waiting_for_build_slot_repo" });
    await setStage(first, "merged");
    expect(await readBuildWaitReason(h.runWriterPool, a, third)).toBe("waiting_for_build_slot_repo");
    await setStage(second, "closed_unmerged");
    expect((await claim(a, third)).granted).toBe(true);
    // Raising it again makes room at once.
    await setting(a, r, 2, 3);
    expect((await claim(a, await item(a, r))).granted).toBe(true);
  });

  it("when a holder merges, the waiter with the better queue order takes the slot and the other keeps waiting", async () => {
    const a = await account();
    const r = await repo(a);
    await setting(a, r, 2);
    const holders = [await item(a, r), await item(a, r)];
    for (const holder of holders) expect((await claim(a, holder)).granted).toBe(true);
    const normal = await item(a, r, { priority: 2, waiting: true });
    const urgent = await item(a, r, { priority: 0, waiting: true });
    await setStage(holders[0]!, "merged");
    // The normal one asks first and gives way: the urgent one is waiting.
    expect(await claim(a, normal)).toEqual({ granted: false, reason: "waiting_for_build_slot_repo" });
    expect((await claim(a, urgent)).granted).toBe(true);
    expect(await stageOf(urgent)).toBe("in_progress");
    expect(await stageOf(normal)).toBe("spec_ready");
  });

  it("an item that is not waiting (never approved) does not hold the slot back from a worse-ordered one", async () => {
    const a = await account();
    const r = await repo(a);
    await item(a, r, { priority: 0 });
    expect((await claim(a, await item(a, r, { priority: 2 }))).granted).toBe(true);
  });

  it("a failed build (Needs a person, no waiting fact) does not hold a free slot back from a worse-ordered item", async () => {
    const a = await account();
    const r = await repo(a);
    await item(a, r, { priority: 0, stage: "needs_human", withSpec: true });
    expect(await heldCount(a)).toBe(0);
    expect((await claim(a, await item(a, r, { priority: 2 }))).granted).toBe(true);
  });

  it("a workflow that died at Spec ready stops blocking once its last poll is older than the window; a live waiter still holds its place", async () => {
    const a = await account();
    const r = await repo(a);
    await item(a, r, { priority: 0, waiting: 170 });
    expect(await readBuildWaitReason(h.runWriterPool, a, await item(a, r, { priority: 2 }))).toBe("waiting_for_build_slot_repo");
    const b = await account();
    const rb = await repo(b);
    await item(b, rb, { priority: 0, waiting: 190 });
    expect(await readBuildWaitReason(h.runWriterPool, b, await item(b, rb, { priority: 2 }))).toBeNull();
    const c = await account();
    const rc = await repo(c);
    await item(c, rc, { priority: 0, waiting: 5 });
    expect((await claim(c, await item(c, rc, { priority: 2 }))).granted).toBe(false);
  });

  it("a better waiter held by its own repository does not hold up the account's free slot", async () => {
    const a = await account();
    const busy = await repo(a);
    await setting(a, busy, 1);
    await claim(a, await item(a, busy));
    await item(a, busy, { priority: 0, waiting: true });
    const other = await repo(a);
    expect((await claim(a, await item(a, other, { priority: 2 }))).granted).toBe(true);
  });
});

describe("C34: a runner_local repository builds one item at a time until its runner can attest order, whatever value is stored; hosted and paired repositories get their value", () => {
  const cases: Array<[string, (a: string) => Promise<string>]> = [
    ["runner_local", (a) => repo(a, "runner_local")],
  ];
  it.each(cases)("%s: with no setting the applied limit is 1, so a second item waits with the repository reason", async (_n, make) => {
    const a = await account();
    const r = await make(a);
    expect((await claim(a, await item(a, r))).granted).toBe(true);
    expect(await claim(a, await item(a, r))).toEqual({ granted: false, reason: "waiting_for_build_slot_repo" });
    expect(await heldCount(a)).toBe(1);
  });

  it.each(cases)("%s: with a stored value of 5 the applied limit is still 1, and the stored value is untouched", async (_n, make) => {
    const a = await account();
    const r = await make(a);
    await setting(a, r, 5);
    await setting(a, null, 8);
    expect((await claim(a, await item(a, r))).granted).toBe(true);
    expect(await readBuildWaitReason(h.runWriterPool, a, await item(a, r))).toBe("waiting_for_build_slot_repo");
    const stored = await h.admin.query<{ max_builds: number }>("SELECT max_builds FROM build_concurrency_settings WHERE account_id = $1 AND repo_id = $2", [a, r]);
    expect(stored.rows.map((x) => x.max_builds)).toEqual([5]);
  });

  it.each(cases)("%s: eight racing claims give exactly one winner", async (_n, make) => {
    const a = await account();
    const r = await make(a);
    await setting(a, r, 5);
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await item(a, r));
    const results = await Promise.all(ids.map((id) => claim(a, id)));
    expect(results.filter((x) => x.granted)).toHaveLength(1);
    expect(await heldCount(a)).toBe(1);
  });

  it("a paired hosted repository gets its stored value: two items build, a third waits; with no value, the starting 2", async () => {
    const a = await account();
    const r = await repo(a);
    await pair(r, a);
    expect((await claim(a, await item(a, r))).granted).toBe(true);
    expect((await claim(a, await item(a, r))).granted).toBe(true);
    expect(await claim(a, await item(a, r))).toEqual({ granted: false, reason: "waiting_for_build_slot_repo" });
    const b = await account();
    const rb = await repo(b);
    await pair(rb, b);
    await setting(b, rb, 3);
    for (let i = 0; i < 3; i++) expect((await claim(b, await item(b, rb))).granted).toBe(true);
    expect(await readBuildWaitReason(h.runWriterPool, b, await item(b, rb))).toBe("waiting_for_build_slot_repo");
  });

  it("a runner_local item placed on a hosted queue repository is a clamped item: it takes one slot and its sibling waits", async () => {
    const a = await account();
    const r = await repo(a);
    const [x, y] = [await item(a, r), await item(a, r)];
    await h.admin.query("UPDATE work_items SET placement = 'runner' WHERE id = ANY($1::uuid[])", [[x, y]]);
    expect((await claim(a, x)).granted).toBe(true);
    expect((await claim(a, y)).granted).toBe(false);
  });

  it("a better waiter on a direct-merge repository that holds one slot does not hold up the account's free slot (its own limit is 1)", async () => {
    const a = await account();
    const direct = await repo(a, "runner_local");
    await claim(a, await item(a, direct));
    await item(a, direct, { priority: 0, waiting: true });
    const queued = await repo(a);
    expect((await claim(a, await item(a, queued, { priority: 2 }))).granted).toBe(true);
  });

  it("a hosted, unpaired queue repository still gets the starting 2", async () => {
    const a = await account();
    const r = await repo(a);
    expect((await claim(a, await item(a, r))).granted).toBe(true);
    expect((await claim(a, await item(a, r))).granted).toBe(true);
    expect(await heldCount(a)).toBe(2);
  });
});

describe("S5c1-4: a runner repository is not held by the account value", () => {
  it("with the account at its value of 1 and a busy hosted repository, a runner_local repository's item still takes a slot (the account value does not bind it) but only one: its runner cannot attest order yet, so the applied limit is 1 (C34)", async () => {
    const a = await account();
    await setting(a, null, 1);
    expect((await claim(a, await item(a, await repo(a)))).granted).toBe(true);
    const hostedNext = await item(a, await repo(a));
    expect(await readBuildWaitReason(h.runWriterPool, a, hostedNext)).toBe("waiting_for_build_slot_account");
    const runnerRepo = await repo(a, "runner_local");
    expect((await claim(a, await item(a, runnerRepo))).granted).toBe(true);
    expect(await readBuildWaitReason(h.runWriterPool, a, await item(a, runnerRepo))).toBe("waiting_for_build_slot_repo");
  });

  it("a runner_verified repository is not a direct-merge repository: it takes up to its own value (2), and a third waits", async () => {
    const a = await account();
    const verified = await repo(a, "runner_verified");
    expect((await claim(a, await item(a, verified))).granted).toBe(true);
    expect((await claim(a, await item(a, verified))).granted).toBe(true);
    expect(await readBuildWaitReason(h.runWriterPool, a, await item(a, verified))).toBe("waiting_for_build_slot_repo");
  });

  it("runner items do not count toward the account value", async () => {
    const a = await account();
    await setting(a, null, 1);
    await claim(a, await item(a, await repo(a, "runner_verified")));
    await claim(a, await item(a, await repo(a, "runner_local")));
    expect((await claim(a, await item(a, await repo(a)))).granted).toBe(true);
  });

  it("an item placed on the runner is counted as a runner item whatever its repository's mode", async () => {
    const a = await account();
    await setting(a, null, 1);
    const placed = await item(a, await repo(a));
    await h.admin.query("UPDATE work_items SET placement = 'runner' WHERE id = $1", [placed]);
    expect((await claim(a, placed)).granted).toBe(true);
    expect((await claim(a, await item(a, await repo(a)))).granted).toBe(true);
  });
});

describe("S5c1-5: the settings table is append-only and tenant-isolated", () => {
  const asUser = <T>(accountId: string, userId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(h.pureAppUserPool, accountId, userId, fn);

  it("app_user can insert its own account's row as itself and read it back, but UPDATE and DELETE fail on privileges", async () => {
    const a = await account();
    const u = await member(a, "admin");
    await asUser(a, u, (c) => c.query("INSERT INTO build_concurrency_settings (account_id, repo_id, max_builds, version, changed_by, preview) VALUES ($1, NULL, 10, 1, $2, $3::jsonb)", [a, u, JSON.stringify({ perDay: 12 })]));
    const rows = await asUser(a, u, (c) => c.query("SELECT max_builds, preview FROM build_concurrency_settings"));
    expect(rows.rows).toEqual([{ max_builds: 10, preview: { perDay: 12 } }]);
    await expect(asUser(a, u, (c) => c.query("UPDATE build_concurrency_settings SET max_builds = 99"))).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });
    await expect(asUser(a, u, (c) => c.query("DELETE FROM build_concurrency_settings"))).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });
  });

  it("a row cannot be written for another account, attributed to another person, or by a session with no user", async () => {
    const a = await account();
    const b = await account();
    const [ua, ub] = [await member(a, "owner"), await member(a, "admin")];
    await expect(asUser(a, ua, (c) => c.query("INSERT INTO build_concurrency_settings (account_id, max_builds, version, changed_by) VALUES ($1, 3, 1, $2)", [b, ua]))).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });
    await expect(asUser(a, ua, (c) => c.query("INSERT INTO build_concurrency_settings (account_id, max_builds, version, changed_by) VALUES ($1, 3, 1, $2)", [a, ub]))).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });
    await expect(withTenant(h.pureAppUserPool, a, (c) => c.query("INSERT INTO build_concurrency_settings (account_id, max_builds, version, changed_by) VALUES ($1, 3, 1, $2)", [a, ua]))).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });
  });

  it("a plain member cannot write a setting, and a former admin (membership gone) cannot either", async () => {
    const a = await account();
    const plain = await member(a, "member");
    await expect(asUser(a, plain, (c) => c.query("INSERT INTO build_concurrency_settings (account_id, max_builds, version, changed_by) VALUES ($1, 3, 1, $2)", [a, plain]))).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });
    const gone = await member(a, "admin");
    await h.admin.query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2", [a, gone]);
    await expect(asUser(a, gone, (c) => c.query("INSERT INTO build_concurrency_settings (account_id, max_builds, version, changed_by) VALUES ($1, 3, 1, $2)", [a, gone]))).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });
  });

  it("one tenant never reads another's rows", async () => {
    const a = await account();
    const b = await account();
    await setting(a, null, 7);
    const u = await user();
    expect((await asUser(b, u, (c) => c.query("SELECT 1 FROM build_concurrency_settings"))).rowCount).toBe(0);
  });

  it("a value below one, a repeated version, a non-object preview and a repository of another account are refused", async () => {
    const a = await account();
    const b = await account();
    const r = await repo(a);
    const rb = await repo(b);
    await expect(setting(a, null, 0)).rejects.toMatchObject({ code: "23514" });
    await setting(a, null, 3, 1);
    await expect(setting(a, null, 4, 1)).rejects.toMatchObject({ code: "23505" });
    await setting(a, r, 2, 1);
    await expect(setting(a, r, 3, 1)).rejects.toMatchObject({ code: "23505" });
    await expect(setting(a, rb, 2, 1)).rejects.toMatchObject({ code: "23503" });
    const u = await user();
    await expect(h.admin.query("INSERT INTO build_concurrency_settings (account_id, max_builds, version, changed_by, preview) VALUES ($1, 2, 9, $2, '[]'::jsonb)", [a, u])).rejects.toMatchObject({ code: "23514" });
  });

  it("created_at is the database's clock whatever the insert says", async () => {
    const a = await account();
    const u = await user();
    await h.admin.query("INSERT INTO build_concurrency_settings (account_id, max_builds, version, changed_by, created_at) VALUES ($1, 2, 1, $2, now() + interval '1 year')", [a, u]);
    const { rows } = await h.admin.query<{ future: boolean }>("SELECT created_at > now() + interval '1 day' AS future FROM build_concurrency_settings WHERE account_id = $1", [a]);
    expect(rows[0]!.future).toBe(false);
  });
});

/** The build step over real rows: a start that finds no slot has run nothing. */
class Ports implements AdvanceRunPorts {
  readonly requests: AdvanceRunRequest[] = [];
  readonly cancelled: string[] = [];
  constructor(private readonly accountId: string, private readonly workItemId: string) {}
  async startRun(req: AdvanceRunRequest) {
    this.requests.push(req);
    const id = randomUUID();
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'running')`, [id, this.accountId, this.workItemId]);
    return { ok: true as const, runId: id };
  }
  async outcome() {
    return { status: "running", done: false, envelope: null };
  }
  async cancel(runId: string) {
    this.cancelled.push(runId);
  }
}

describe("startBuildForItem takes a slot", () => {
  it("S5j-1: the first two items on a repository start; the third is refused with the wait reason, starts no run and stays at Spec ready; it starts once one of the two has merged", async () => {
    const a = await account();
    const r = await repo(a);
    const first = await item(a, r, { withSpec: true });
    const second = await item(a, r, { withSpec: true });
    const third = await item(a, r, { withSpec: true });
    const [p1, p2, p3] = [new Ports(a, first), new Ports(a, second), new Ports(a, third)];
    expect(await startBuildForItem(h.runWriterPool, a, first, randomUUID(), p1)).toMatchObject({ status: "started" });
    expect(await startBuildForItem(h.runWriterPool, a, second, randomUUID(), p2)).toMatchObject({ status: "started" });
    expect([await stageOf(first), await stageOf(second)]).toEqual(["in_progress", "in_progress"]);

    expect(await startBuildForItem(h.runWriterPool, a, third, randomUUID(), p3)).toEqual({ status: "refused", reason: "waiting_for_build_slot_repo" });
    expect(p3.requests).toEqual([]);
    expect(await stageOf(third)).toBe("spec_ready");
    expect((await h.admin.query("SELECT 1 FROM agent_runs WHERE work_item_id = $1", [third])).rowCount).toBe(0);

    await setStage(first, "merged");
    expect(await startBuildForItem(h.runWriterPool, a, third, randomUUID(), p3)).toMatchObject({ status: "started" });
    expect(await stageOf(third)).toBe("in_progress");
  });

  it("a replay of an item already at in_progress needs no slot, even when it is the only one over the limit", async () => {
    const a = await account();
    const r = await repo(a);
    const only = await item(a, r, { withSpec: true });
    const approval = randomUUID();
    const ports = new Ports(a, only);
    // A replay finds the same keyed run in a real world; here a second call at in_progress must not be refused for a slot.
    expect(await startBuildForItem(h.runWriterPool, a, only, approval, ports)).toMatchObject({ status: "started" });
    expect(await startBuildForItem(h.runWriterPool, a, only, approval, ports)).toMatchObject({ status: "started" });
  });

  it("S5j-1: three starts at once on one repository: two runs, one refusal", async () => {
    const a = await account();
    const r = await repo(a);
    const ids = [await item(a, r, { withSpec: true }), await item(a, r, { withSpec: true }), await item(a, r, { withSpec: true })];
    const ports = ids.map((id) => new Ports(a, id));
    const out = await Promise.all(ids.map((id, i) => startBuildForItem(h.runWriterPool, a, id, randomUUID(), ports[i]!)));
    expect(out.filter((x) => x.status === "started")).toHaveLength(2);
    expect(out.filter((x) => x.status === "refused")).toEqual([{ status: "refused", reason: "waiting_for_build_slot_repo" }]);
    expect(ports.reduce((n, p) => n + p.requests.length, 0)).toBe(2);
  });

  it("a Build again for an item at Needs a person takes a slot too", async () => {
    const a = await account();
    const r = await repo(a);
    await claim(a, await item(a, r));
    await claim(a, await item(a, r));
    const again = await item(a, r, { stage: "needs_human", withSpec: true });
    const ports = new Ports(a, again);
    expect(await startBuildForItem(h.runWriterPool, a, again, randomUUID(), ports)).toEqual({ status: "refused", reason: "waiting_for_build_slot_repo" });
    expect(ports.requests).toEqual([]);
  });
});

describe("the account lock cannot starve the connection pool", () => {
  it("ten starts at once on a pool of two connections all finish (the holder needs a second connection for the run start)", async () => {
    const a = await account();
    const tight = createPool(process.env.PIPELINE_DATABASE_URL_RUN_WRITER!, { max: 2 });
    try {
      await setting(a, null, 10);
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) ids.push(await item(a, await repo(a)));
      const results = await Promise.all(
        ids.map((id) =>
          takeBuildSlot(tight, a, id, async (client) => {
            // The run start: a second connection from the same pool, while this one holds the lock.
            await withTenant(tight, a, (c) => c.query("SELECT pg_sleep(0.05)"));
            await recordStage(client, { workItemId: id, toStage: "in_progress", at: new Date(), source: "control_plane", sourceRef: `tight:${randomUUID()}` });
          }),
        ),
      );
      expect(results.every((r) => r.granted)).toBe(true);
      expect(await heldCount(a)).toBe(10);
    } finally {
      await tight.end();
    }
  }, 60_000);
});
