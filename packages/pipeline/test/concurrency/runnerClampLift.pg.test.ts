import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { takeBuildSlot } from "../../src/advance/buildSlots.js";
import { computeConcurrencyPreview } from "../../src/concurrency/preview.js";
import { readRepoConcurrency } from "../../src/concurrency/setting.js";
import { seedAccount } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#483 S5-j2 wiring [pg]: the repository's build limit lifts for a `runner_local` repository only when it is paired AND a live runner of the account
 * that covers it lists `ordered_facts_v1`. The claim, the setting read and the preview must say the same thing, so each case asks all three.
 */
const h = pgHarness();
const CAPABLE = ["plane_merge_v1", "ordered_facts_v1"];
const NOTE = "runner_order_unattested";

async function account(): Promise<string> {
  const id = randomUUID();
  await seedAccount(h.admin, id);
  return id;
}
async function repo(accountId: string, mode: string, paired: boolean): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', $4, 'acme', $5)`, [id, accountId, Math.floor(Math.random() * 1_000_000_000), mode, `c${id.slice(0, 8)}`]);
  if (paired) await h.admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, $3, $4)", [id, accountId, `acme-pub/p${id.slice(0, 8)}`, [".autonomous-team/**"]]);
  return id;
}
async function item(accountId: string, repoId: string, stage = "spec_ready"): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number, stage) VALUES ($1, $2, $3, 'small', 'running', 'internal', $4, $5)`, [id, accountId, repoId, Math.floor(Math.random() * 1_000_000) + 1, stage]);
  return id;
}
async function runner(accountId: string, repoIds: string[], o: { caps?: string[]; revoked?: boolean; paused?: boolean; draining?: boolean } = {}): Promise<string> {
  const user = randomUUID();
  await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [user, `${user}@example.test`]);
  const id = await insertRunner(h.admin, accountId, user);
  await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], revoked_at = $3 WHERE id = $1", [id, repoIds, o.revoked ? new Date() : null]);
  await h.admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[])", [id, accountId, o.caps ?? CAPABLE]);
  if (o.paused || o.draining) await h.admin.query("INSERT INTO runner_settings (runner_id, account_id, paused_at, draining) VALUES ($1, $2, $3, $4)", [id, accountId, o.paused ? new Date() : null, o.draining === true]);
  return id;
}

const claim = (accountId: string, id: string) =>
  takeBuildSlot(h.runWriterPool, accountId, id, (client: PoolClient) => recordStage(client, { workItemId: id, toStage: "in_progress", at: new Date(), source: "control_plane", sourceRef: `lift-test:${randomUUID()}` }));
const read = (a: string, r: string) => withTenant(h.pureAppUserPool, a, (c) => readRepoConcurrency(c, a, r));
const preview = (a: string, r: string) => withTenant(h.pureAppUserPool, a, (c) => computeConcurrencyPreview(c, a, { kind: "repo", repoId: r }, 5));
const stageOf = async (id: string): Promise<string> => (await h.admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [id])).rows[0]!.stage;

/** What the claim, the setting read and the preview each say about one repository, in one place. */
async function said(a: string, r: string): Promise<{ claimed: number; applied: number; reason: string | null; note: boolean; previewLimit: number }> {
  // Three items waiting, so a limit of 2 or more shows as 2 or more in the preview, and the claim count is read off the real slots.
  const waiting: string[] = [];
  for (let i = 0; i < 3; i++) waiting.push(await item(a, r));
  let claimed = 0;
  for (const id of waiting) if ((await claim(a, id)).granted) claimed++;
  const setting = await read(a, r);
  const p = await preview(a, r);
  return { claimed, applied: setting.applied_limit, reason: setting.clamp_reason, note: p.notes.some((n) => n.code === NOTE), previewLimit: p.effective_limit_old };
}
const ONE = { claimed: 1, applied: 1, reason: NOTE, note: true, previewLimit: 1 };
const LIFTED = { claimed: 2, applied: 2, reason: null, note: false, previewLimit: 2 };

describe("S5-j2 wiring: the clamp lifts for a paired runner_local repository with a capable runner", () => {
  it("paired and capable: two builds start, the setting reads 2 with no clamp reason, and the preview has no clamp note", async () => {
    const a = await account();
    const r = await repo(a, "runner_local", true);
    await runner(a, [r]);
    expect(await said(a, r)).toEqual(LIFTED);
  });

  it("paired, runner not capable: stays at one in all three", async () => {
    const a = await account();
    const r = await repo(a, "runner_local", true);
    await runner(a, [r], { caps: ["plane_merge_v1"] });
    expect(await said(a, r)).toEqual(ONE);
  });

  it("unpaired and capable: stays at one in all three (the gate's conservative stop holds there until the check-order rows land)", async () => {
    const a = await account();
    const r = await repo(a, "runner_local", false);
    await runner(a, [r]);
    expect(await said(a, r)).toEqual(ONE);
  });

  it("no runner at all, a revoked runner, and a runner whose scope does not cover the repository: stays at one", async () => {
    const a = await account();
    const none = await repo(a, "runner_local", true);
    expect(await said(a, none)).toEqual(ONE);
    const revoked = await repo(a, "runner_local", true);
    await runner(a, [revoked], { revoked: true });
    expect(await said(a, revoked)).toEqual(ONE);
    const elsewhere = await repo(a, "runner_local", true);
    await runner(a, [await repo(a, "runner_local", true)]);
    expect(await said(a, elsewhere)).toEqual(ONE);
  });

  it("a capable runner that is only paused or draining does not lift the limit (the limit reads trust; the merge gate does not need to)", async () => {
    const a = await account();
    const paused = await repo(a, "runner_local", true);
    await runner(a, [paused], { paused: true });
    expect(await said(a, paused)).toEqual(ONE);
    const draining = await repo(a, "runner_local", true);
    await runner(a, [draining], { draining: true });
    expect(await said(a, draining)).toEqual(ONE);
    const both = await repo(a, "runner_local", true);
    await runner(a, [both], { paused: true });
    await runner(a, [both]);
    expect(await said(a, both)).toEqual(LIFTED);
  });

  it("a capability lost later brings the clamp back for new claims; the builds already running finish untouched", async () => {
    const a = await account();
    const r = await repo(a, "runner_local", true);
    const rn = await runner(a, [r]);
    const [x, y, z] = [await item(a, r), await item(a, r), await item(a, r)];
    expect((await claim(a, x)).granted).toBe(true);
    expect((await claim(a, y)).granted).toBe(true);
    await h.admin.query("UPDATE runner_capabilities SET capabilities = '{plane_merge_v1}' WHERE runner_id = $1", [rn]);
    expect(await claim(a, z)).toEqual({ granted: false, reason: "waiting_for_build_slot_repo" });
    expect([await stageOf(x), await stageOf(y)]).toEqual(["in_progress", "in_progress"]);
    expect(await read(a, r)).toMatchObject({ applied_limit: 1, clamp_reason: NOTE });
    expect((await preview(a, r)).notes.some((n) => n.code === NOTE)).toBe(true);
  });

  it("other repositories are unchanged: a runner_verified repository and a hosted repository keep their value, and an unpaired hosted repository with a runner-placed item stays clamped", async () => {
    const a = await account();
    const verified = await repo(a, "runner_verified", true);
    await runner(a, [verified]);
    expect(await said(a, verified)).toEqual(LIFTED);
    const hosted = await repo(a, "sandbox", false);
    expect(await said(a, hosted)).toEqual(LIFTED);
    const placed = await repo(a, "sandbox", false);
    await runner(a, [placed]);
    const [p1, p2] = [await item(a, placed), await item(a, placed)];
    await h.admin.query("UPDATE work_items SET placement = 'runner' WHERE id = ANY($1::uuid[])", [[p1, p2]]);
    expect((await claim(a, p1)).granted).toBe(true);
    expect((await claim(a, p2)).granted).toBe(false);
  });

  it("a runner-placed item on a paired hosted repository with a capable runner is lifted the same way (the rule is per repository, not per mode)", async () => {
    const a = await account();
    const r = await repo(a, "sandbox", true);
    await runner(a, [r]);
    const [p1, p2, p3] = [await item(a, r), await item(a, r), await item(a, r)];
    await h.admin.query("UPDATE work_items SET placement = 'runner' WHERE id = ANY($1::uuid[])", [[p1, p2, p3]]);
    expect((await claim(a, p1)).granted).toBe(true);
    expect((await claim(a, p2)).granted).toBe(true);
    expect((await claim(a, p3)).granted).toBe(false);
  });
});
