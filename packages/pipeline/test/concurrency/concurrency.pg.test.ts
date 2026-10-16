import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { estimateItem } from "../../src/estimate/estimateItem.js";
import { computeConcurrencyPreview, finishedSlotPhaseSpend } from "../../src/concurrency/preview.js";
import { PreviewRequiredError, PreviewStaleError, SettingBusyError, changeConcurrency, readAccountConcurrency, readRepoConcurrency } from "../../src/concurrency/setting.js";
import { SLOT_HOLD_SAMPLE, SLOT_HOLD_STAGES, slotHoldMinutes } from "../../src/estimate/slotHold.js";
import { BUILD_SLOT_STAGES } from "../../src/advance/buildSlots.js";
import { seedAccount } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#483 S5-c2 [pg]: the preview over real rows and the write transaction, through the app_user pool so RLS decides what is visible.
 * Items are inserted at the stage under test; the prices come from S5-p's own `estimateItem`, called here the way a reader would.
 */
const h = pgHarness();

async function account(): Promise<{ id: string; owner: string }> {
  const id = randomUUID();
  await seedAccount(h.admin, id);
  const owner = await member(id, "owner");
  return { id, owner };
}
async function member(accountId: string, role: "owner" | "admin" | "member"): Promise<string> {
  const id = randomUUID();
  await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
  await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, id, role]);
  return id;
}
async function repo(accountId: string, mode = "sandbox"): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', $4, 'acme', $5)`, [id, accountId, Math.floor(Math.random() * 1_000_000_000), mode, `c${id.slice(0, 8)}`]);
  return id;
}
/** A work item at a stage. `waiting` adds the worker's fresh `build_waiting` fact, which is how an item counts as waiting for a slot. */
async function item(accountId: string, repoId: string, o: { stage?: string; kind?: string; waiting?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await h.admin.query(
    `INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number, stage) VALUES ($1, $2, $3, $4, 'running', 'internal', $5, $6)`,
    [id, accountId, repoId, o.kind ?? "small", Math.floor(Math.random() * 1_000_000) + 1, o.stage ?? (o.waiting ? "spec_ready" : "in_progress")],
  );
  if (o.waiting) {
    await h.admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'build_waiting', 'waiting_for_build_slot_repo', $3)`, [accountId, id, randomUUID()]);
  }
  return id;
}
async function setting(accountId: string, repoId: string | null, maxBuilds: number, version = 1): Promise<void> {
  const u = await member(accountId, "admin");
  await h.admin.query("INSERT INTO build_concurrency_settings (account_id, repo_id, max_builds, version, changed_by) VALUES ($1, $2, $3, $4, $5)", [accountId, repoId, maxBuilds, version, u]);
}

const preview = (accountId: string, scope: { kind: "account" } | { kind: "repo"; repoId: string }, to: number) =>
  withTenant(h.pureAppUserPool, accountId, (client) => computeConcurrencyPreview(client, accountId, scope, to));
const smallPrice = (accountId: string, repoId: string) => withTenant(h.pureAppUserPool, accountId, (client) => estimateItem(client, { accountId, repoId, category: "small" }));
const versions = async (accountId: string, repoId: string | null) =>
  (await h.admin.query<{ max_builds: number; version: number; changed_by: string; preview: Record<string, unknown> }>(
    "SELECT max_builds, version, changed_by, preview FROM build_concurrency_settings WHERE account_id = $1 AND repo_id IS NOT DISTINCT FROM $2::uuid ORDER BY version",
    [accountId, repoId],
  )).rows;
const audits = async (accountId: string) =>
  (await h.admin.query<{ actor: string; payload: Record<string, unknown> }>("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'build_concurrency.changed' ORDER BY created_at, id", [accountId])).rows;
const receipts = async (accountId: string) => Number((await h.admin.query<{ n: string }>("SELECT count(*) AS n FROM decision_receipts WHERE account_id = $1", [accountId])).rows[0]!.n);

/** Four hosted repos with one waiting small item each, and the account value set to 2: the clamp lets 4 run at once, so a raise to 10 is worth two more. */
async function fourWaiting(): Promise<{ id: string; owner: string; repos: string[] }> {
  const a = await account();
  const repos: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await repo(a.id);
    repos.push(r);
    await item(a.id, r, { waiting: true });
  }
  await setting(a.id, null, 2);
  return { ...a, repos };
}

describe("S5c2-1: the preview is S5-p's arithmetic over the fixture, and changes no setting row", () => {
  it("prices a raise from 2 to 10 over four repos with one waiting small item each", async () => {
    const a = await fourWaiting();
    const e = (await smallPrice(a.id, a.repos[0]!)).slot_phase_usd;
    expect(e).toBeGreaterThan(0);
    const before = await versions(a.id, null);

    const p = await preview(a.id, { kind: "account" }, 10);
    // L_eff(2) = 2, L_eff(10) = 4 (one build per repo, four repos with work); the slot-hold is the seed, 60 minutes
    const perHour = (2 * e) / (60 / 60);
    expect(p).toMatchObject({ scope: "account", repo_id: null, kind: "raise", from: 2, to: 10, items: 4, unpriced_items: 0, effective_limit_old: 2, effective_limit_new: 4, clear_minutes_old: 120, clear_minutes_new: 60, basis: "seed" });
    expect(p.extra_per_hour_cents).toBe(Math.round(perHour * 100));
    expect(p.extra_per_day_cents).toBe(Math.round(24 * perHour * 100));
    expect(p.queue_total_cents).toBe(Math.round((e + e + e + e) * 100));
    expect(p.notes.map((n) => n.code)).toEqual(["same_total", "limited_by_repos"]);
    expect(await versions(a.id, null)).toEqual(before);
    expect(await audits(a.id)).toEqual([]);
  });

  it("counts a held item as well as the waiting ones, and counts hosted items only for the account", async () => {
    const a = await account();
    const r1 = await repo(a.id);
    const r2 = await repo(a.id);
    const runner = await repo(a.id, "runner_local");
    await item(a.id, r1); // holds a slot
    await item(a.id, r2, { waiting: true });
    await item(a.id, runner, { waiting: true });
    await item(a.id, runner); // holds a slot on the runner
    expect((await preview(a.id, { kind: "account" }, 8)).items).toBe(2);
    // the repo scope counts everything on that repo, runner or not
    expect((await preview(a.id, { kind: "repo", repoId: runner }, 3)).items).toBe(2);
  });

  it("a stale 'build_waiting' fact does not count as waiting, and a slot stage in another account never counts", async () => {
    const a = await account();
    const other = await account();
    const r = await repo(a.id);
    const old = await item(a.id, r, { waiting: true });
    await h.admin.query("UPDATE work_item_driver_events SET created_at = now() - interval '1 hour' WHERE work_item_id = $1", [old]);
    await item(other.id, await repo(other.id));
    expect((await preview(a.id, { kind: "account" }, 6)).items).toBe(0);
  });

  it("an item paused for a spending limit is not waiting for a slot, as in the slot code", async () => {
    const a = await account();
    const r = await repo(a.id);
    const paused = await item(a.id, r, { waiting: true });
    await h.admin.query("UPDATE work_item_driver_events SET code = 'account_budget_reached' WHERE work_item_id = $1", [paused]);
    await item(a.id, await repo(a.id), { waiting: true });
    expect((await preview(a.id, { kind: "account" }, 6)).items).toBe(1);
  });

  it("with nothing waiting or holding, the sentence is 'Nothing is waiting' and the figures are zero", async () => {
    const a = await account();
    await repo(a.id);
    const p = await preview(a.id, { kind: "account" }, 9);
    expect(p).toMatchObject({ items: 0, clear_minutes_old: 0, clear_minutes_new: 0, extra_per_hour_cents: 0, queue_total_cents: 0 });
    expect(p.notes[0]).toEqual({ code: "nothing_waiting", text: "Nothing is waiting for a build slot." });
  });

  it("repo scope shows no speed-up and no extra spend while the one-per-repo rule holds", async () => {
    const a = await account();
    const r = await repo(a.id);
    await item(a.id, r);
    await item(a.id, r, { waiting: true });
    await item(a.id, r, { waiting: true });
    const p = await preview(a.id, { kind: "repo", repoId: r }, 5);
    expect(p).toMatchObject({ scope: "repo", repo_id: r, from: 2, to: 5, items: 3, effective_limit_old: 1, effective_limit_new: 1, extra_per_hour_cents: 0, extra_per_day_cents: 0 });
    expect(p.clear_minutes_old).toBe(p.clear_minutes_new);
    expect(p.notes.find((n) => n.code === "one_build_per_repo_until_d598")?.text).toBe("This applies once parallel builds on one repo are supported.");
  });
});

describe("S5c2-1: where the price per item comes from", () => {
  it("waiting items with no estimate (a question) are counted, not priced, and the price falls to finished builds' real spend", async () => {
    const a = await fourWaiting();
    // make every waiting item a question: no estimate
    await h.admin.query("UPDATE work_items SET kind = 'question' WHERE account_id = $1", [a.id]);
    // ten finished items: executor $1.00 + code-reviewer $0.50 are slot-phase, the project manager's $9 is not
    const base = Date.now() - 24 * 3_600_000;
    for (let i = 0; i < 10; i++) {
      const w = await item(a.id, a.repos[0]!, { stage: "merged" });
      const entered = new Date(base + i * 60_000);
      await h.admin.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'spec_ready', 'in_progress', $3, 'control_plane', 'a'), ($1, $2, 'in_progress', 'merged', $4, 'control_plane', 'b')`, [a.id, w, entered, new Date(entered.getTime() + 600_000)]);
      for (const [role, usd] of [["executor", 1], ["code-reviewer", 0.5], ["project-manager", 9]] as const) {
        const run = randomUUID();
        await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, $4, 'production', 'succeeded')`, [run, a.id, w, role]);
        await h.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id) VALUES ($1, 'model', 'customer_gateway', $2, $3)`, [a.id, usd, run]);
      }
    }
    const finished = await withTenant(h.pureAppUserPool, a.id, (client) => finishedSlotPhaseSpend(client, a.id));
    expect(finished).toHaveLength(10);
    expect(finished.every((x) => Math.abs(x - 1.5) < 1e-9)).toBe(true);

    const p = await preview(a.id, { kind: "account" }, 10);
    // 4 waiting questions, none priced; the held items are gone from the picture (merged), so items = 4
    expect(p.items).toBe(4);
    expect(p.unpriced_items).toBe(4);
    // slot-hold: ten items held 10 minutes, so history; S-bar $1.50 from real spend, so the basis is history
    const hold = await withTenant(h.pureAppUserPool, a.id, (client) => slotHoldMinutes(client, a.id));
    expect(hold).toEqual({ minutes: 10, basis: "history" });
    expect(p.basis).toBe("history");
    // (4 - 2) x 1.50 / (10/60 h) = $18 an hour
    expect(p.extra_per_hour_cents).toBe(1800);
    expect(p.extra_per_day_cents).toBe(43200);
    expect(p.queue_total_cents).toBe(0);
    expect(p.notes.find((n) => n.code === "unpriced_items")?.text).toBe("4 waiting items can't be priced yet.");
  });

  it("S5c2-8: with no waiting estimate and no finished build, it says it can't price this yet and carries no figure of any kind", async () => {
    const a = await fourWaiting();
    await h.admin.query("UPDATE work_items SET kind = 'question' WHERE account_id = $1", [a.id]);
    const p = await preview(a.id, { kind: "account" }, 10);
    expect(p.unpriced_items).toBe(4);
    expect(p.basis).toBe("none");
    // absent, not zero, null or a stand-in: not even a key (C3 of D#483)
    for (const key of ["extra_per_hour_cents", "extra_per_day_cents", "queue_total_cents"]) expect(Object.keys(p), key).not.toContain(key);
    expect(JSON.stringify(p.notes)).not.toMatch(/null|undefined|\$0/);
    expect(p.notes.find((n) => n.code === "cannot_price")?.text).toBe("We can't price this yet: nothing waiting has an estimate and this account has no finished builds.");
  });

  it("S5c2-9: the same account with one finished build that has recorded slot-phase spend prices from that spend, and the sentence is gone", async () => {
    const a = await fourWaiting();
    await h.admin.query("UPDATE work_items SET kind = 'question' WHERE account_id = $1", [a.id]);
    const w = await item(a.id, a.repos[0]!, { stage: "merged" });
    const entered = new Date(Date.now() - 3_600_000);
    await h.admin.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'spec_ready', 'in_progress', $3, 'control_plane', 'a'), ($1, $2, 'in_progress', 'merged', $4, 'control_plane', 'b')`, [a.id, w, entered, new Date(entered.getTime() + 600_000)]);
    const run = randomUUID();
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded')`, [run, a.id, w]);
    await h.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id) VALUES ($1, 'model', 'customer_gateway', 2, $2)`, [a.id, run]);
    const p = await preview(a.id, { kind: "account" }, 10);
    // one finished build is too few for a measured slot-hold, so the hold is the seed (60 minutes); the price still comes from the real spend
    expect(p.basis).toBe("seed");
    expect(p.extra_per_hour_cents).toBe(400); // (4 - 2) x $2.00 / 1 h
    expect(p.notes.map((n) => n.code)).not.toContain("cannot_price");
  });

  it("S5c2-10: a waiting item with an estimate and no finished builds prices from the estimate, and the sentence is gone", async () => {
    const a = await fourWaiting();
    const e = (await smallPrice(a.id, a.repos[0]!)).slot_phase_usd;
    const p = await preview(a.id, { kind: "account" }, 10);
    expect(p.basis).toBe("seed");
    expect(p.extra_per_hour_cents).toBe(Math.round(2 * e * 100));
    expect(p.notes.map((n) => n.code)).not.toContain("cannot_price");
  });

  it("another account's finished builds never set this account's price (RLS)", async () => {
    const a = await account();
    const other = await account();
    const r = await repo(other.id);
    const w = await item(other.id, r, { stage: "merged" });
    const run = randomUUID();
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded')`, [run, other.id, w]);
    await h.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id) VALUES ($1, 'model', 'customer_gateway', 5, $2)`, [other.id, run]);
    expect(await withTenant(h.pureAppUserPool, a.id, (client) => finishedSlotPhaseSpend(client, a.id))).toEqual([]);
  });

  it("the finished-item set is the one slotHoldMinutes uses (same stages, same sample size)", () => {
    expect([...SLOT_HOLD_STAGES]).toEqual([...BUILD_SLOT_STAGES]);
    expect(SLOT_HOLD_SAMPLE).toBe(50);
  });
});

describe("S5c2-2: the write is one version row and one audit row, bound to the preview the person saw", () => {
  it("a raise with the matching hash writes exactly one version whose preview is the server's own, one audit row, and no receipt", async () => {
    const a = await fourWaiting();
    const shown = await preview(a.id, { kind: "account" }, 10);
    const out = await changeConcurrency(h.pureAppUserPool, { accountId: a.id, userId: a.owner, scope: { kind: "account" }, maxBuilds: 10, accept: true, previewHash: shown.preview_hash });
    expect(out).toMatchObject({ written: true, kind: "raise", version: 2 });

    const rows = await versions(a.id, null);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ max_builds: 10, version: 2, changed_by: a.owner });
    expect(rows[1]!.preview).toEqual({ ...shown, kind: "raise", from: 2, to: 10, preview_hash: shown.preview_hash });
    expect(await audits(a.id)).toEqual([{ actor: a.owner, payload: { scope: "account", repo_id: null, from: 2, to: 10, preview_hash: shown.preview_hash } }]);
    expect(await receipts(a.id)).toBe(0);
    expect(await withTenant(h.pureAppUserPool, a.id, (c) => readAccountConcurrency(c, a.id))).toEqual({ value: 10, start_value: 4, history_count: 2 });
  });

  it("a raise with no accept, or with accept but no hash, answers preview_required with a fresh preview and writes nothing", async () => {
    const a = await fourWaiting();
    for (const extra of [{}, { accept: false, previewHash: "x" }, { accept: true }, { accept: true, previewHash: "" }]) {
      const err = await changeConcurrency(h.pureAppUserPool, { accountId: a.id, userId: a.owner, scope: { kind: "account" }, maxBuilds: 10, ...extra }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PreviewRequiredError);
      expect((err as PreviewRequiredError).preview).toMatchObject({ from: 2, to: 10, kind: "raise" });
    }
    expect(await versions(a.id, null)).toHaveLength(1);
    expect(await audits(a.id)).toEqual([]);
  });

  it("a wrong hash answers preview_stale with the fresh preview, and the row counts are unchanged", async () => {
    const a = await fourWaiting();
    const err = await changeConcurrency(h.pureAppUserPool, { accountId: a.id, userId: a.owner, scope: { kind: "account" }, maxBuilds: 10, accept: true, previewHash: "0".repeat(64) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreviewStaleError);
    expect((err as PreviewStaleError).preview.preview_hash).toBe((await preview(a.id, { kind: "account" }, 10)).preview_hash);
    expect(await versions(a.id, null)).toHaveLength(1);
    expect(await audits(a.id)).toEqual([]);
    expect(await receipts(a.id)).toBe(0);
  });

  it("a hash taken before another item started waiting is stale: the fixture changed between the preview and the accept", async () => {
    const a = await fourWaiting();
    const shown = await preview(a.id, { kind: "account" }, 10);
    await item(a.id, a.repos[0]!, { waiting: true });
    const err = await changeConcurrency(h.pureAppUserPool, { accountId: a.id, userId: a.owner, scope: { kind: "account" }, maxBuilds: 10, accept: true, previewHash: shown.preview_hash }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreviewStaleError);
    expect(await versions(a.id, null)).toHaveLength(1);
  });

  it("the preview is recomputed INSIDE the transaction, after the account lock: a change made while the write waits for the lock makes it stale", async () => {
    const a = await fourWaiting();
    const shown = await preview(a.id, { kind: "account" }, 10);
    // another connection holds the account's slot lock, as a slot claim does while it starts a run
    await h.admin.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`fx:build_slots:${a.id}`]);
    let released = false;
    try {
      const pending = changeConcurrency(h.pureAppUserPool, { accountId: a.id, userId: a.owner, scope: { kind: "account" }, maxBuilds: 10, accept: true, previewHash: shown.preview_hash }).catch((e: unknown) => e);
      await new Promise((r) => setTimeout(r, 150));
      // while it waits, a fifth item starts waiting; then the lock is released
      await item(a.id, a.repos[1]!, { waiting: true });
      await h.admin.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`fx:build_slots:${a.id}`]);
      released = true;
      expect(await pending).toBeInstanceOf(PreviewStaleError);
    } finally {
      if (!released) await h.admin.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`fx:build_slots:${a.id}`]);
    }
    expect(await versions(a.id, null)).toHaveLength(1);
    expect(await audits(a.id)).toEqual([]);
  });

  it("a lock that stays held for the whole patience window answers busy, and nothing is written", async () => {
    const a = await fourWaiting();
    const shown = await preview(a.id, { kind: "account" }, 10);
    await h.admin.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`fx:build_slots:${a.id}`]);
    try {
      const err = await changeConcurrency(h.pureAppUserPool, { accountId: a.id, userId: a.owner, scope: { kind: "account" }, maxBuilds: 10, accept: true, previewHash: shown.preview_hash, patienceMs: 120 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SettingBusyError);
    } finally {
      await h.admin.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`fx:build_slots:${a.id}`]);
    }
    expect(await versions(a.id, null)).toHaveLength(1);
  });

  it("two accepts of the same raise at once write one version and one audit row", async () => {
    const a = await fourWaiting();
    const shown = await preview(a.id, { kind: "account" }, 10);
    const go = () => changeConcurrency(h.pureAppUserPool, { accountId: a.id, userId: a.owner, scope: { kind: "account" }, maxBuilds: 10, accept: true, previewHash: shown.preview_hash });
    const results = await Promise.all([go(), go()]);
    expect(results.filter((r) => r.written)).toHaveLength(1);
    expect(results.filter((r) => !r.written)[0]).toMatchObject({ kind: "same" });
    expect(await versions(a.id, null)).toHaveLength(2);
    expect(await audits(a.id)).toHaveLength(1);
  });

  it("a lowering needs no preview, stores {kind: lower, from, to}, and an equal value writes nothing", async () => {
    const a = await fourWaiting();
    const out = await changeConcurrency(h.pureAppUserPool, { accountId: a.id, userId: a.owner, scope: { kind: "account" }, maxBuilds: 1 });
    expect(out).toMatchObject({ written: true, kind: "lower", version: 2, preview: null });
    expect((await versions(a.id, null))[1]!.preview).toEqual({ kind: "lower", from: 2, to: 1 });
    expect(await audits(a.id)).toEqual([{ actor: a.owner, payload: { scope: "account", repo_id: null, from: 2, to: 1, preview_hash: null } }]);

    const same = await changeConcurrency(h.pureAppUserPool, { accountId: a.id, userId: a.owner, scope: { kind: "account" }, maxBuilds: 1 });
    expect(same).toMatchObject({ written: false, kind: "same", version: 2 });
    expect(await versions(a.id, null)).toHaveLength(2);
    expect(await audits(a.id)).toHaveLength(1);
  });

  it("the undo path: raising then lowering back is two versions and two audit rows, history kept", async () => {
    const a = await fourWaiting();
    const shown = await preview(a.id, { kind: "account" }, 10);
    await changeConcurrency(h.pureAppUserPool, { accountId: a.id, userId: a.owner, scope: { kind: "account" }, maxBuilds: 10, accept: true, previewHash: shown.preview_hash });
    await changeConcurrency(h.pureAppUserPool, { accountId: a.id, userId: a.owner, scope: { kind: "account" }, maxBuilds: 2 });
    expect((await versions(a.id, null)).map((v) => [v.version, v.max_builds])).toEqual([[1, 2], [2, 10], [3, 2]]);
    expect((await audits(a.id)).map((r) => [r.payload.from, r.payload.to])).toEqual([[2, 10], [10, 2]]);
    expect((await withTenant(h.pureAppUserPool, a.id, (c) => readAccountConcurrency(c, a.id))).value).toBe(2);
  });

  it("a plain member cannot write a version (the table's own policy), and nothing is audited", async () => {
    const a = await fourWaiting();
    const plain = await member(a.id, "member");
    const err = await changeConcurrency(h.pureAppUserPool, { accountId: a.id, userId: plain, scope: { kind: "account" }, maxBuilds: 1 }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("42501");
    expect(await versions(a.id, null)).toHaveLength(1);
    expect(await audits(a.id)).toEqual([]);
  });

  it("any number up to the integer maximum is accepted as input", async () => {
    const a = await account();
    await repo(a.id);
    const p = await preview(a.id, { kind: "account" }, 2_147_483_647);
    const out = await changeConcurrency(h.pureAppUserPool, { accountId: a.id, userId: a.owner, scope: { kind: "account" }, maxBuilds: 2_147_483_647, accept: true, previewHash: p.preview_hash });
    expect(out.written).toBe(true);
    expect((await versions(a.id, null))[0]!.max_builds).toBe(2_147_483_647);
  });

  it("a repo raise is previewed, accepted and recorded for that repo alone; the slot code still applies one build", async () => {
    const a = await account();
    const r = await repo(a.id);
    const other = await repo(a.id);
    await item(a.id, r, { waiting: true });
    const shown = await preview(a.id, { kind: "repo", repoId: r }, 5);
    const out = await changeConcurrency(h.pureAppUserPool, { accountId: a.id, userId: a.owner, scope: { kind: "repo", repoId: r }, maxBuilds: 5, accept: true, previewHash: shown.preview_hash });
    expect(out).toMatchObject({ written: true, version: 1 });
    expect(await versions(a.id, r)).toHaveLength(1);
    expect(await versions(a.id, other)).toHaveLength(0);
    expect(await versions(a.id, null)).toHaveLength(0);
    expect(await audits(a.id)).toEqual([{ actor: a.owner, payload: { scope: "repo", repo_id: r, from: 2, to: 5, preview_hash: shown.preview_hash } }]);
    expect(await withTenant(h.pureAppUserPool, a.id, (c) => readRepoConcurrency(c, a.id, r))).toEqual({ value: 5, start_value: 2, applied_limit: 1, clamp_reason: "one_build_per_repo_until_d598" });
    expect(await withTenant(h.pureAppUserPool, a.id, (c) => readRepoConcurrency(c, a.id, other))).toEqual({ value: 2, start_value: 2, applied_limit: 1, clamp_reason: "one_build_per_repo_until_d598" });
  });

  it("the account and a repo hold separate version counters", async () => {
    const a = await account();
    const r = await repo(a.id);
    await changeConcurrency(h.pureAppUserPool, { accountId: a.id, userId: a.owner, scope: { kind: "account" }, maxBuilds: 3 });
    const out = await changeConcurrency(h.pureAppUserPool, { accountId: a.id, userId: a.owner, scope: { kind: "repo", repoId: r }, maxBuilds: 1 });
    expect(out.version).toBe(1);
    expect((await versions(a.id, null))[0]!.version).toBe(1);
  });
});

describe("S5c2: another account's settings and items are invisible", () => {
  it("a preview and a read see only the caller's account", async () => {
    const a = await account();
    const b = await account();
    await setting(b.id, null, 99);
    for (let i = 0; i < 3; i++) await item(b.id, await repo(b.id), { waiting: true });
    expect(await withTenant(h.pureAppUserPool, a.id, (c) => readAccountConcurrency(c, a.id))).toEqual({ value: 4, start_value: 4, history_count: 0 });
    expect((await preview(a.id, { kind: "account" }, 8)).items).toBe(0);
  });
});
