import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { isRunnerMode, effectiveModeSql } from "@fx/runner";
import { BUILD_SLOT_STAGES, ONE_BUILD_PER_REPO_UNTIL_D598, START_BUILDS_PER_ACCOUNT, START_BUILDS_PER_REPO, listSlotWaiters, resolveBuildLimits } from "../advance/buildSlots.js";
import { estimateItem, type EstimateBasis } from "../estimate/estimateItem.js";
import { runPlanFor } from "../estimate/runPlan.js";
import { SLOT_HOLD_SAMPLE, SLOT_HOLD_STAGES, slotHoldMinutes } from "../estimate/slotHold.js";

/**
 * D#483 S5-c2: what raising (or lowering) a person's build-concurrency number would do, shown before it is accepted.
 *
 * Every price comes from S5-p (`estimateItem`, `slotHoldMinutes`); nothing here computes a price of its own. The arithmetic is the PM's
 * (comment 18966288, section 3), written once, as a pure function (`assemblePreview`) so a test can hold it to hand-computed figures:
 *
 *   items            hosted items holding a slot + hosted items waiting for one (account scope); every item of the repo (repo scope)
 *   L_eff(L)         account: min(L, sum over repos with items of min(repoLimit_r, n_r)); repo: min(clamped L, n)
 *                    While the one-per-repo clamp holds this can never pass the number of repos with work, and the preview says so.
 *   clear_minutes(L) ceil(items / L_eff(L)) x slot-hold minutes, or 0 when nothing is waiting or holding
 *   S-bar            mean slot-phase price of the waiting items that have an estimate; else the mean ACTUAL slot-phase spend of the account's
 *                    last 50 items that left a slot; else there is no source and the spend fields are absent (D#483 C3: no seed price of a
 *                    small item stands in, so the "We can't price this yet" sentence is reachable)
 *   extra per hour   (L_eff(new) - L_eff(old)) x S-bar / (slot-hold hours); per day = 24 x that
 *   queue total      sum of the slot-phase prices of the held and waiting items
 *
 * THIS MODULE READS THE SLOT CODE AND THE ESTIMATE; NEITHER READS IT. `estimate/` imports nothing from `advance/buildSlots.ts`, and
 * `buildSlots.ts` imports nothing from the plan-data package, so no plan tier can set a limit through here (S5c1-6, S5p-5).
 */

export type ConcurrencyScope = { kind: "account" } | { kind: "repo"; repoId: string };

export type PreviewKind = "raise" | "lower" | "same";
export type PreviewBasis = EstimateBasis;

export interface PreviewNote {
  /** Stable, for a client to branch on. */
  code: "nothing_waiting" | "same_total" | "unpriced_items" | "cannot_price" | "one_build_per_repo_until_d598" | "limited_by_repos";
  /** The sentence the person reads. */
  text: string;
}

export interface ConcurrencyPreview {
  scope: "account" | "repo";
  repo_id: string | null;
  kind: PreviewKind;
  from: number;
  to: number;
  /** Items holding a slot or waiting for one, in this scope. */
  items: number;
  /** Waiting items with no estimate (`basis: "none"`); they count in `items` and are left out of the price. */
  unpriced_items: number;
  /** What the value really allows now, after the per-repo clamp and the number of repos with work. */
  effective_limit_old: number;
  effective_limit_new: number;
  clear_minutes_old: number;
  clear_minutes_new: number;
  /** Absent when `basis` is `none`: there is nothing to price from. Negative for a lowering. */
  extra_per_hour_cents?: number;
  extra_per_day_cents?: number;
  queue_total_cents?: number;
  basis: PreviewBasis;
  notes: PreviewNote[];
  /** sha256 over the canonical JSON of the fields named in `hashedFields`. */
  preview_hash: string;
}

export interface PreviewItem {
  repoId: string;
  waiting: boolean;
  /** The S5-p slot-phase price. 0 and `priced: false` for an item with no estimate. */
  slotPhaseUsd: number;
  priced: boolean;
}

/** Where S-bar came from: the waiting items' estimates (`seed` when any of them is priced from plan data, not the account's own runs) or finished items' real spend. */
export interface PriceSource {
  usd: number;
  basis: "history" | "seed";
}

export interface PreviewInputs {
  scope: ConcurrencyScope;
  from: number;
  to: number;
  items: readonly PreviewItem[];
  /** Each repo's clamped limit (`resolveBuildLimits(...).repoLimit`), for the repos named by `items`. */
  repoLimits: ReadonlyMap<string, number>;
  holdMinutes: number;
  holdBasis: "history" | "seed";
  /** Null when no source exists at all. Not read when no item is waiting or holding. */
  sBar: PriceSource | null;
}

const MIN_HOLD_MINUTES = 1;
const cents = (usd: number): number => Math.round(usd * 100);
const finite = (n: number): number => (Number.isFinite(n) ? n : 0);

/** Sorted-key JSON, so the same facts always give the same bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The facts the accept binds: what the person saw. An absent figure is hashed as null. */
export function previewHash(p: Pick<ConcurrencyPreview, "scope" | "repo_id" | "from" | "to" | "clear_minutes_old" | "clear_minutes_new" | "unpriced_items" | "basis"> & { extra_per_hour_cents?: number; extra_per_day_cents?: number; queue_total_cents?: number }): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        scope: p.scope,
        repo_id: p.repo_id,
        from: p.from,
        to: p.to,
        clear_minutes_old: p.clear_minutes_old,
        clear_minutes_new: p.clear_minutes_new,
        extra_per_hour_cents: p.extra_per_hour_cents ?? null,
        extra_per_day_cents: p.extra_per_day_cents ?? null,
        queue_total_cents: p.queue_total_cents ?? null,
        unpriced_items: p.unpriced_items,
        basis: p.basis,
      }),
    )
    .digest("hex");
}

/** Pure: the whole preview from counts and prices. */
export function assemblePreview(i: PreviewInputs): ConcurrencyPreview {
  const scope = i.scope.kind;
  const repoId = i.scope.kind === "repo" ? i.scope.repoId : null;
  const perRepo = new Map<string, number>();
  for (const item of i.items) perRepo.set(item.repoId, (perRepo.get(item.repoId) ?? 0) + 1);
  const total = i.items.length;

  const effective = (limit: number): number => {
    if (total === 0) return 0;
    if (i.scope.kind === "repo") return Math.min(Math.min(limit, ONE_BUILD_PER_REPO_UNTIL_D598), total);
    let reach = 0;
    for (const [repo, n] of perRepo) reach += Math.min(i.repoLimits.get(repo) ?? ONE_BUILD_PER_REPO_UNTIL_D598, n);
    return Math.min(limit, reach);
  };
  const hold = Math.max(finite(i.holdMinutes), MIN_HOLD_MINUTES);
  const clear = (leff: number): number => (total === 0 || leff <= 0 ? 0 : Math.round(Math.ceil(total / leff) * hold));

  const leffOld = effective(i.from);
  const leffNew = effective(i.to);
  const unpriced = i.items.filter((x) => x.waiting && !x.priced).length;
  const kind: PreviewKind = i.to > i.from ? "raise" : i.to < i.from ? "lower" : "same";

  let basis: PreviewBasis;
  let extraHour: number | undefined;
  let extraDay: number | undefined;
  let queueTotal: number | undefined;
  if (total === 0) {
    // Nothing to price: the figures are zero by the formula whatever S-bar is.
    basis = i.holdBasis;
    extraHour = 0;
    extraDay = 0;
    queueTotal = 0;
  } else if (i.sBar === null) {
    basis = "none";
  } else {
    basis = i.sBar.basis === "history" && i.holdBasis === "history" ? "history" : "seed";
    const perHourUsd = ((leffNew - leffOld) * finite(i.sBar.usd)) / (hold / 60);
    extraHour = cents(perHourUsd);
    extraDay = cents(24 * perHourUsd);
    queueTotal = cents(i.items.reduce((sum, x) => sum + (x.priced ? finite(x.slotPhaseUsd) : 0), 0));
  }

  const notes: PreviewNote[] = [];
  if (total === 0) notes.push({ code: "nothing_waiting", text: "Nothing is waiting for a build slot." });
  if (unpriced > 0) notes.push({ code: "unpriced_items", text: `${unpriced} waiting ${unpriced === 1 ? "item" : "items"} can't be priced yet.` });
  if (total > 0 && basis === "none") notes.push({ code: "cannot_price", text: "We can't price this yet: nothing waiting has an estimate and this account has no finished builds." });
  if (queueTotal !== undefined && total > 0 && kind === "raise") notes.push({ code: "same_total", text: "The same work costs the same in total. A higher limit spends it sooner." });
  if (i.scope.kind === "repo" && i.to > ONE_BUILD_PER_REPO_UNTIL_D598) {
    notes.push({ code: "one_build_per_repo_until_d598", text: "This applies once parallel builds on one repo are supported." });
  }
  if (i.scope.kind === "account" && total > 0 && leffNew < i.to) {
    const repos = perRepo.size;
    const clamped = [...perRepo.keys()].every((r) => (i.repoLimits.get(r) ?? ONE_BUILD_PER_REPO_UNTIL_D598) <= ONE_BUILD_PER_REPO_UNTIL_D598);
    const atOnce = `${leffNew} ${leffNew === 1 ? "build runs" : "builds run"} at once`;
    notes.push({
      code: "limited_by_repos",
      text: clamped
        ? `Only ${repos} ${repos === 1 ? "repo has" : "repos have"} work, and each repo builds one item at a time for now, so at most ${atOnce}.`
        : `With the work there is, at most ${atOnce}.`,
    });
  }

  const hashed = {
    scope,
    repo_id: repoId,
    from: i.from,
    to: i.to,
    clear_minutes_old: clear(leffOld),
    clear_minutes_new: clear(leffNew),
    ...(extraHour !== undefined && { extra_per_hour_cents: extraHour }),
    ...(extraDay !== undefined && { extra_per_day_cents: extraDay }),
    ...(queueTotal !== undefined && { queue_total_cents: queueTotal }),
    unpriced_items: unpriced,
    basis,
  };
  return { ...hashed, kind, items: total, effective_limit_old: leffOld, effective_limit_new: leffNew, notes, preview_hash: previewHash(hashed) };
}

// ---- the reads ----------------------------------------------------------------------------------------------------------------

/** The current value of one scope: its highest version, else the starting value. */
export async function currentConcurrency(client: PoolClient, accountId: string, repoId: string | null): Promise<{ value: number; version: number | null }> {
  const { rows } = await client.query<{ max_builds: number; version: number }>(
    `SELECT max_builds, version FROM build_concurrency_settings WHERE account_id = $1 AND repo_id IS NOT DISTINCT FROM $2::uuid ORDER BY version DESC LIMIT 1`,
    [accountId, repoId],
  );
  const row = rows[0];
  if (row === undefined) return { value: repoId === null ? START_BUILDS_PER_ACCOUNT : START_BUILDS_PER_REPO, version: null };
  return { value: Number(row.max_builds), version: Number(row.version) };
}

interface ItemFact {
  id: string;
  repo_id: string;
  kind: string | null;
  title: string | null;
  waiting: boolean;
}

/** The slot-phase roles, from the run plan itself (executor and the review roles, debater and security reviewer included). */
function slotPhaseRoles(): string[] {
  const plan = runPlanFor({ category: "critical", debaterEnabled: true });
  if (!plan.ok) throw new Error("concurrency preview: the run plan has no critical tier");
  return [...new Set(plan.runs.filter((r) => r.slotPhase).map((r) => r.role))];
}

/** Items holding a slot or waiting for one in this scope. Account scope counts hosted items only; repo scope counts the repo's items, hosted or runner. */
async function loadItems(client: PoolClient, accountId: string, scope: ConcurrencyScope): Promise<ItemFact[]> {
  const repoFilter = scope.kind === "repo" ? scope.repoId : null;
  const held = (
    await client.query<{ id: string; repo_id: string; kind: string | null; title: string | null; mode: string }>(
      `SELECT w.id, w.repo_id, w.kind, w.title, ${effectiveModeSql("w", "r")} AS mode
         FROM work_items w JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
        WHERE w.account_id = $1 AND w.stage = ANY($2::text[]) AND ($3::uuid IS NULL OR w.repo_id = $3::uuid)`,
      [accountId, [...BUILD_SLOT_STAGES], repoFilter],
    )
  ).rows;
  // The waiters are S5-c1's own derivation (a fresh `build_waiting` fact), never a copy of it. The nil uuid excludes no item; only the slot-wait reasons count, as in `decideBuildSlot` (an item paused for a spending limit holds nothing back).
  const waiting = (
    await listSlotWaiters(client, accountId, "00000000-0000-0000-0000-000000000000", "build")
  ).filter((w) => repoFilter === null || w.repo_id === repoFilter);
  const details = waiting.length
    ? (await client.query<{ id: string; kind: string | null; title: string | null }>("SELECT id, kind, title FROM work_items WHERE account_id = $1 AND id = ANY($2::uuid[])", [accountId, waiting.map((w) => w.id)])).rows
    : [];
  const byId = new Map(details.map((d) => [d.id, d]));
  const hostedOnly = scope.kind === "account";
  const facts: ItemFact[] = [];
  for (const h of held) if (!hostedOnly || !isRunnerMode(h.mode)) facts.push({ id: h.id, repo_id: h.repo_id, kind: h.kind, title: h.title, waiting: false });
  for (const w of waiting) {
    if (hostedOnly && isRunnerMode(w.mode)) continue;
    const d = byId.get(w.id);
    facts.push({ id: w.id, repo_id: w.repo_id, kind: d?.kind ?? null, title: d?.title ?? null, waiting: true });
  }
  return facts;
}

/** Each named repo's clamped limit under its own current value. */
async function loadRepoLimits(client: PoolClient, accountId: string, repoIds: readonly string[]): Promise<Map<string, number>> {
  const limits = new Map<string, number>();
  if (repoIds.length === 0) return limits;
  const { rows } = await client.query<{ repo_id: string; max_builds: number }>(
    `SELECT DISTINCT ON (repo_id) repo_id, max_builds FROM build_concurrency_settings WHERE account_id = $1 AND repo_id = ANY($2::uuid[]) ORDER BY repo_id, version DESC`,
    [accountId, [...repoIds]],
  );
  const values = new Map(rows.map((r) => [r.repo_id, Number(r.max_builds)]));
  for (const id of repoIds) limits.set(id, resolveBuildLimits({ accountValue: null, repoValue: values.get(id) ?? null }).repoLimit);
  return limits;
}

/**
 * The actual slot-phase spend (model and compute ledger rows of the executor and review runs) of the account's last `SLOT_HOLD_SAMPLE` items that
 * left a slot, as S5-p's `slotHoldMinutes` picks them. Items with no such ledger row (a runner subscription run books none) are left out, so
 * they cannot pull the mean down to zero. The left-slot definition is repeated from slotHold.ts on purpose (that module is S5-p's; a test holds
 * the two sets equal).
 */
export async function finishedSlotPhaseSpend(client: PoolClient, accountId: string): Promise<number[]> {
  const { rows } = await client.query<{ usd: string }>(
    `WITH entered AS (
       SELECT work_item_id, min(at) AS entered_at FROM work_item_transitions WHERE account_id = $1 AND to_stage = 'in_progress' GROUP BY work_item_id
     ), left_slot AS (
       SELECT t.work_item_id, min(t.at) AS left_at
         FROM work_item_transitions t JOIN entered e ON e.work_item_id = t.work_item_id
        WHERE t.account_id = $1 AND t.from_stage = ANY($2::text[]) AND NOT (t.to_stage = ANY($2::text[])) AND t.at >= e.entered_at
        GROUP BY t.work_item_id
     ), recent AS (
       SELECT l.work_item_id FROM entered e JOIN left_slot l ON l.work_item_id = e.work_item_id ORDER BY l.left_at DESC LIMIT $3
     )
     SELECT sum(g.usd)::text AS usd
       FROM recent rc
       JOIN agent_runs r ON r.account_id = $1 AND r.work_item_id = rc.work_item_id AND r.role = ANY($4::text[])
       JOIN ledger g ON g.account_id = $1 AND g.run_id = r.id
      GROUP BY rc.work_item_id`,
    [accountId, [...SLOT_HOLD_STAGES], SLOT_HOLD_SAMPLE, slotPhaseRoles()],
  );
  return rows.map((r) => Number(r.usd)).filter((n) => Number.isFinite(n) && n >= 0);
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * The preview for moving a scope's number to `to`, from the database as it stands in this transaction. Must run inside a `withTenant`
 * transaction for `accountId`. The write path calls it again under the account lock and compares hashes.
 */
export async function computeConcurrencyPreview(client: PoolClient, accountId: string, scope: ConcurrencyScope, to: number): Promise<ConcurrencyPreview> {
  const repoId = scope.kind === "repo" ? scope.repoId : null;
  const { value: from } = await currentConcurrency(client, accountId, repoId);
  const facts = await loadItems(client, accountId, scope);
  const hold = await slotHoldMinutes(client, accountId);

  // One estimate per (repo, kind, title): items of one kind in one repo price alike, and the title only moves a feature's panel seats.
  const cache = new Map<string, Awaited<ReturnType<typeof estimateItem>>>();
  const estimateFor = async (f: ItemFact) => {
    const key = `${f.repo_id}|${f.kind ?? ""}|${f.kind === "feature" || f.kind === "critical" ? (f.title ?? "") : ""}`;
    let e = cache.get(key);
    if (e === undefined) {
      e = await estimateItem(client, { accountId, repoId: f.repo_id, category: f.kind, ...(f.title !== null && { title: f.title }) });
      cache.set(key, e);
    }
    return e;
  };
  const items: PreviewItem[] = [];
  const waitingPriced: { usd: number; basis: EstimateBasis }[] = [];
  for (const f of facts) {
    const e = await estimateFor(f);
    const priced = e.basis !== "none";
    items.push({ repoId: f.repo_id, waiting: f.waiting, slotPhaseUsd: priced ? e.slot_phase_usd : 0, priced });
    if (f.waiting && priced) waitingPriced.push({ usd: e.slot_phase_usd, basis: e.basis });
  }

  let sBar: PriceSource | null = null;
  if (facts.length > 0) {
    if (waitingPriced.length > 0) {
      sBar = { usd: mean(waitingPriced.map((w) => w.usd)), basis: waitingPriced.every((w) => w.basis === "history") ? "history" : "seed" };
    } else {
      // C3 (comment 18967977): no third step. With no waiting estimate and no finished build there is nothing to price from, so `sBar`
      // stays null, the preview carries no figure, and its note says so. A stand-in price would be a guess shown as a fact.
      const finished = await finishedSlotPhaseSpend(client, accountId);
      if (finished.length > 0) sBar = { usd: mean(finished), basis: "history" };
    }
  }

  const repoLimits = await loadRepoLimits(client, accountId, [...new Set(facts.map((f) => f.repo_id))]);
  return assemblePreview({ scope, from, to, items, repoLimits, holdMinutes: hold.minutes, holdBasis: hold.basis, sBar });
}
