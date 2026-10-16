import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { ONE_BUILD_PER_REPO_UNTIL_D598, START_BUILDS_PER_ACCOUNT, START_BUILDS_PER_REPO, resolveBuildLimits } from "../advance/buildSlots.js";
import { computeConcurrencyPreview, currentConcurrency, type ConcurrencyPreview, type ConcurrencyScope } from "./preview.js";

/**
 * D#483 S5-c2: the person's build-concurrency number, read and written.
 *
 * A write is one transaction under the same per-account advisory lock that S5-c1's slot claim takes, so no build starts between the
 * preview the person accepted being re-checked and the new number being stored:
 *   1. a LOWERING or an EQUAL value needs no preview and no accept (an equal value writes nothing);
 *   2. a RAISE needs `accept: true` and the `preview_hash` the person saw. Without them it answers `PreviewRequiredError` carrying a fresh
 *      preview. With a hash that no longer matches the server's recomputation inside this transaction, it answers `PreviewStaleError`
 *      carrying the fresh preview, and writes nothing. The hash needs no server secret: the stored preview is exactly what was shown.
 *   3. the next `build_concurrency_settings` version is inserted (version = max + 1; a unique-index race answers `SettingChangedError`),
 *      its `changed_by` bound to the session's user and to an owner or admin by the table's own policy, and ONE audit row is written
 *      through `audit_write` in the same transaction. There is no decision receipt: a person setting their own number is not a decision the
 *      system takes under a dial. The version row, with its stored preview, plus the audit row is the receipt.
 *
 * Undo: there is no delete. A change is undone by writing the earlier value, which is a new version and an audit row of its own.
 */

export class PreviewRequiredError extends Error {
  constructor(readonly preview: ConcurrencyPreview) {
    super("raising the limit needs the cost preview accepted");
    this.name = "PreviewRequiredError";
  }
}
export class PreviewStaleError extends Error {
  constructor(readonly preview: ConcurrencyPreview) {
    super("what the preview showed has changed");
    this.name = "PreviewStaleError";
  }
}
/** Another change took the same version first. */
export class SettingChangedError extends Error {
  constructor() {
    super("the setting changed while you saved");
    this.name = "SettingChangedError";
  }
}
/** The account lock stayed busy for the whole patience window: builds are starting. Nothing was written. */
export class SettingBusyError extends Error {
  constructor() {
    super("builds are starting; try again in a moment");
    this.name = "SettingBusyError";
  }
}

export interface AccountConcurrency {
  value: number;
  start_value: number;
  history_count: number;
}
export interface RepoConcurrency {
  value: number;
  start_value: number;
  /** What the slot code applies now: the value, clamped. */
  applied_limit: number;
  clamp_reason: "one_build_per_repo_until_d598" | null;
}

export async function readAccountConcurrency(client: PoolClient, accountId: string): Promise<AccountConcurrency> {
  const { value } = await currentConcurrency(client, accountId, null);
  const { rows } = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM build_concurrency_settings WHERE account_id = $1 AND repo_id IS NULL", [accountId]);
  return { value, start_value: START_BUILDS_PER_ACCOUNT, history_count: Number(rows[0]!.n) };
}

export async function readRepoConcurrency(client: PoolClient, accountId: string, repoId: string): Promise<RepoConcurrency> {
  const { value } = await currentConcurrency(client, accountId, repoId);
  const limits = resolveBuildLimits({ accountValue: null, repoValue: value });
  return { value, start_value: START_BUILDS_PER_REPO, applied_limit: limits.repoLimit, clamp_reason: value > ONE_BUILD_PER_REPO_UNTIL_D598 ? "one_build_per_repo_until_d598" : null };
}

/** The same lock S5-c1's `takeBuildSlot` takes. */
const lockKey = (accountId: string): string => `fx:build_slots:${accountId}`;
/** How long a write keeps trying for the account's lock (a slot claim holds it for the seconds a run start takes). */
export const SETTING_LOCK_PATIENCE_MS = 10_000;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ConcurrencyChange {
  accountId: string;
  userId: string;
  scope: ConcurrencyScope;
  maxBuilds: number;
  accept?: boolean | undefined;
  previewHash?: string | undefined;
  /** How long to keep trying for the account lock; defaults to `SETTING_LOCK_PATIENCE_MS`. For tests. */
  patienceMs?: number | undefined;
}

export type ConcurrencyChangeResult = { written: boolean; kind: "raise" | "lower" | "same"; version: number | null; preview: ConcurrencyPreview | null };

/**
 * Applies a change. The caller has already checked that the session is an owner or admin; the table's policy checks it again.
 * Throws PreviewRequiredError, PreviewStaleError, SettingChangedError or SettingBusyError, each with nothing written.
 */
export async function changeConcurrency(pool: Pool, change: ConcurrencyChange): Promise<ConcurrencyChangeResult> {
  const { accountId, userId, scope, maxBuilds } = change;
  const repoId = scope.kind === "repo" ? scope.repoId : null;
  const deadline = Date.now() + (change.patienceMs ?? SETTING_LOCK_PATIENCE_MS);
  for (let attempt = 0; ; attempt++) {
    // The lock is TRIED, never waited on while holding a connection (see takeBuildSlot): a slot claim needs a second connection to start a run.
    const outcome = await withTenant(pool, accountId, userId, async (client): Promise<ConcurrencyChangeResult | null> => {
      const got = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [lockKey(accountId)]);
      if (!got.rows[0]!.ok) return null;

      const current = await currentConcurrency(client, accountId, repoId);
      if (maxBuilds === current.value) return { written: false, kind: "same", version: current.version, preview: null };

      let stored: Record<string, unknown>;
      let previewHash: string | null = null;
      let shown: ConcurrencyPreview | null = null;
      if (maxBuilds > current.value) {
        const fresh = await computeConcurrencyPreview(client, accountId, scope, maxBuilds);
        if (change.accept !== true || typeof change.previewHash !== "string" || change.previewHash.length === 0) throw new PreviewRequiredError(fresh);
        if (change.previewHash !== fresh.preview_hash) throw new PreviewStaleError(fresh);
        shown = fresh;
        previewHash = fresh.preview_hash;
        stored = { ...fresh, kind: "raise", from: current.value, to: maxBuilds, preview_hash: fresh.preview_hash };
      } else {
        stored = { kind: "lower", from: current.value, to: maxBuilds };
      }

      const version = (current.version ?? 0) + 1;
      try {
        await client.query(
          "INSERT INTO build_concurrency_settings (account_id, repo_id, max_builds, version, changed_by, preview) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
          [accountId, repoId, maxBuilds, version, userId, JSON.stringify(stored)],
        );
      } catch (error) {
        if ((error as { code?: string } | null)?.code === "23505") throw new SettingChangedError();
        throw error;
      }
      await client.query("SELECT audit_write('build_concurrency.changed', $1::jsonb)", [
        JSON.stringify({ scope: scope.kind, repo_id: repoId, from: current.value, to: maxBuilds, preview_hash: previewHash }),
      ]);
      return { written: true, kind: maxBuilds > current.value ? "raise" : "lower", version, preview: shown };
    });
    if (outcome !== null) return outcome;
    if (Date.now() >= deadline) throw new SettingBusyError();
    await pause(Math.min(25 * (attempt + 1), 500) + Math.floor(Math.random() * 25));
  }
}
