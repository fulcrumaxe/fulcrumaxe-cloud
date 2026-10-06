import { createHash } from "node:crypto";
import { withTenant } from "@fx/db/src/withTenant.js";
import {
  listAccountFeatures,
  writeFeatureFlip,
  type AccountFeature,
  type FeatureSource,
  type FeatureState,
  type WriteFeatureFlipContext,
} from "@fx/db/src/exposure.js";
import { writePlatformAudit } from "@fx/db/src/platformAudit.js";
import { resolveVersion, type ExposureClass, type FeatureCatalogueEntry } from "./featureExposure.js";

/**
 * D#8 R3: resolve once, freeze onto the work item.
 *
 * `resolveExposure(accountId, catalogue, db)` is the DB-backed resolver
 * the Spec's Files list names -- deliberately a DIFFERENT function from
 * R2's `resolveVersion()` (Correction C1, PM, 2026-09-25:
 * D#8 comment 18605392).
 * `resolveVersion()` is pure, takes no DB and no account, and returns
 * `max(pinnedVersion, securityFloorVersion)`. `resolveExposure()` resolves
 * once per work item, in exactly one transaction, and CALLS
 * `resolveVersion()` for the floor on every catalogue entry it resolves --
 * it does not compute a floor a second way.
 *
 * `db` is typed via `Parameters<typeof withTenant>[0]` / the shape
 * `exposure.ts` already exports, rather than importing `pg` directly:
 * `@fx/features`'s own `package.json` is R2's frozen package scaffold
 * ("package scaffold, so no later task edits a shared package file" --
 * R2 Files list) and this task does not add `pg` as a dependency just to
 * spell out a type its only two real dependents (`withTenant`,
 * `exposure.ts`) already export the shape of.
 */
type DbPool = Parameters<typeof withTenant>[0];
type WriterPool = WriteFeatureFlipContext["pool"];

export interface ResolvedFeatureExposure {
  readonly class: ExposureClass;
  readonly state: FeatureState;
  /** `resolveVersion(entry.key, entry.addedIn, catalogue)` -- see the file header. */
  readonly version: number;
  /** Whether `state` came from an explicit `account_features` row or the class default. */
  readonly source: "account" | "default";
}

export interface ResolvedExposure {
  readonly accountId: string;
  readonly features: Readonly<Record<string, ResolvedFeatureExposure>>;
}

export interface ResolvedExposureResult {
  readonly value: ResolvedExposure;
  readonly digest: string;
}

/**
 * sha256 hex over the resolved value's canonical JSON. Deterministic for a
 * fixed `catalogue` + a fixed set of `account_features` rows: `features`
 * is always built by iterating `catalogue` in the caller's own order (see
 * `resolveExposure` below), so key order in the serialized object never
 * varies across calls with the same inputs. Same primitive `pg` already
 * uses elsewhere in this codebase for a content digest
 * (`packages/api/src/idempotency.ts`).
 */
function computeExposureDigest(value: ResolvedExposure): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/**
 * Per-entry class defaults (Policy point 1, D#8 body), applied only when
 * `account_features` carries no explicit row for that key:
 *   - `silent`     -- always "on". A silent feature has no per-account
 *                     record by definition ("on for everyone, no record"),
 *                     so an `account_features` row is never consulted for
 *                     it even if one exists.
 *   - `gated`      -- "off until an owner|admin turns it on": the explicit
 *                     row's state if one exists, else "off".
 *   - `tier_gated` -- same fail-closed default as `gated` here. D#2's
 *                     plan/entitlement table does not exist yet (Scope
 *                     fence: "no cohort machinery... If a feature is
 *                     tier-gated, that is D#2's plan table"), and R3
 *                     criterion 4 forbids reading `partners` as a
 *                     shortcut -- so there is no other legal source to
 *                     read from today. v1's catalogue is empty (R2), so no
 *                     shipped feature exercises this path yet; the next
 *                     task that ships a real `tier_gated` entry is also
 *                     the task that must give this a real entitlement
 *                     source.
 */
function resolveFeatureState(
  entry: FeatureCatalogueEntry,
  accountRow: AccountFeature | undefined,
): { state: FeatureState; source: "account" | "default" } {
  if (entry.class === "silent") {
    return { state: "on", source: "default" };
  }
  if (accountRow) {
    return { state: accountRow.state, source: "account" };
  }
  return { state: "off", source: "default" };
}

/**
 * R3 criterion 1: exactly one database transaction per call -- a single
 * `withTenant` invocation. `withTenant` itself opens `BEGIN`, one
 * `set_config`, the work below, `COMMIT`, then one combined
 * `RESET app.account_id; RESET app.user_id; RESET app.token_id` query --
 * 4-6 round-trips, but ONE transaction. resolve.test.ts asserts this by
 * counting `pool.connect()` calls around a stub pool (`withTenant` checks
 * out exactly one connection per invocation).
 *
 * R3 criterion 3: no memory cache -- TTL or otherwise -- sits in front of
 * this read. Every call re-reads `account_features` fresh, inside its one
 * transaction. "Cached" in the Spec's own language names the FROZEN value
 * this function's result is meant to be written onto a work item for that
 * run's lifetime (via `freezeOnto`, below) -- not a cache inside this
 * function. The Failure conditions section names the alternative this
 * avoids directly: "Exposure read on a hot path, or served from a TTL
 * cache that can return a stale opt-out."
 *
 * R3 criterion 4: never reads `partners`. The only table this function
 * touches is `account_features`, via `listAccountFeatures`, scoped by
 * `withTenant`'s RLS setting the same way every other tenant read in this
 * codebase is. A partner-cohort default is denormalised into
 * `account_features` at WRITE time by whatever later task builds that --
 * not this function's job (see `resolveFeatureState` above).
 */
export async function resolveExposure(
  accountId: string,
  catalogue: readonly FeatureCatalogueEntry[],
  db: DbPool,
): Promise<ResolvedExposureResult> {
  const value = await withTenant(db, accountId, async (client) => {
    const accountFeatures = await listAccountFeatures(client);
    const byKey = new Map(accountFeatures.map((row) => [row.featureKey, row]));

    const features: Record<string, ResolvedFeatureExposure> = {};
    for (const entry of catalogue) {
      const version = resolveVersion(entry.key, entry.addedIn, catalogue);
      const { state, source } = resolveFeatureState(entry, byKey.get(entry.key));
      features[entry.key] = { class: entry.class, state, version, source };
    }

    return Object.freeze({ accountId, features: Object.freeze(features) });
  });

  return Object.freeze({ value, digest: computeExposureDigest(value) });
}

/**
 * R3 criterion 2: freezes `resolved` onto `record`'s two exposure columns.
 * Field names are snake_case, matching `agent_runs.resolved_exposure` /
 * `agent_runs.exposure_digest` directly (migrations/0611_exposure_audit.sql,
 * R1 criterion 7) -- the shape D#2 amendment 18488789 (H04/H09) names as
 * what the run-creation task (H09b2) must write non-null onto every new
 * `agent_runs` row, once that task exists to call this. This task's own
 * "Honest scope limit" is that no such call site exists yet in this repo
 * (a grep for `agent_runs` outside tests, D#8 R3's own text) -- `freezeOnto`
 * is exercised here only against a plain object standing in for that
 * future row.
 *
 * `resolveExposure`'s result is already a fresh, `Object.freeze`d
 * snapshot built from the query rows at call time, never a shared or
 * mutable reference back to `account_features` -- so a later write to
 * `account_features` cannot reach a record this function has already
 * frozen. resolve.test.ts's non-vacuity proof mutates the STUB's backing
 * rows after freezing and asserts the frozen record is unaffected, the
 * same shape D#5 E9.6 uses for `.fulcrumaxe/env.yaml`.
 */
export interface FrozenExposureFields {
  readonly resolved_exposure: ResolvedExposure;
  readonly exposure_digest: string;
}

export function freezeOnto<T extends Record<string, unknown>>(
  record: T,
  resolved: ResolvedExposureResult,
): T & FrozenExposureFields {
  return {
    ...record,
    resolved_exposure: resolved.value,
    exposure_digest: resolved.digest,
  };
}

/**
 * R3 criterion 5: the flip-authority table. Decided here, in application
 * code, because `exposure_writer` itself carries no per-tenant scoping at
 * all -- see migrations/0611_exposure_audit.sql's file header:
 * "`exposure_writer_full_access` ... FOR ALL USING (true) ... the
 * customer/platform/partner authority check is the application layer's
 * job (D#8 R3), not this policy's." Three rows:
 *
 *   - `platform_ops`: always allowed, on any account. Never queries
 *     `account_members` at all -- platform staff act by virtue of the
 *     `platform_ops` trust boundary itself, the same one
 *     `platformAudit.ts`'s read helper already trusts by construction.
 *   - customer `owner`/`admin`: allowed on THEIR OWN account, checked
 *     against `account_members` with the same `withTenant`/RLS scoping
 *     every other tenant read in this codebase uses.
 *   - everyone else, including a partner admin: refused. A partner admin
 *     holds no `account_members` row for a CUSTOMER's account at all, so
 *     the exact same query that authorises a real owner/admin finds
 *     nothing for them -- no partner-specific branch is needed. (Defense
 *     in depth, already proven independently at the schema level:
 *     `partner_user` holds no grant of any kind on `account_features`,
 *     per `packages/db/test/exposure.test.ts`'s existing grant-matrix
 *     test -- this module's own authority check is the FIRST line, not
 *     the only one.)
 */
export class FlipAuthorizationError extends Error {}

export type FlipActorRole = "customer_owner_admin" | "platform_ops";

export interface FlipActor {
  readonly userId: string;
  readonly isPlatformOps: boolean;
}

async function authorizeFlip(db: DbPool, accountId: string, actor: FlipActor): Promise<FlipActorRole> {
  if (actor.isPlatformOps) {
    return "platform_ops";
  }
  const isOwnerOrAdmin = await withTenant(db, accountId, async (client) => {
    const { rows } = await client.query(
      `SELECT 1 FROM account_members WHERE account_id = $1 AND user_id = $2 AND role IN ('owner', 'admin')`,
      [accountId, actor.userId],
    );
    return rows.length > 0;
  });
  if (!isOwnerOrAdmin) {
    throw new FlipAuthorizationError(
      `actor ${actor.userId} holds no owner/admin privilege on account ${accountId}`,
    );
  }
  return "customer_owner_admin";
}

export interface FlipFeatureContext {
  /** `app_user`-connected pool, used only for the authority check above. */
  readonly db: DbPool;
  /** `exposure_writer`-connected pool or client -- see exposure.ts's `WriteFeatureFlipContext`. */
  readonly writerPool: WriterPool;
  readonly actor: FlipActor;
}

export interface FlipFeatureInput {
  readonly accountId: string;
  readonly featureKey: string;
  readonly state: FeatureState;
}

/**
 * Orchestrates the authority check above with the actual write.
 * `authorizeFlip` always runs FIRST -- `writeFeatureFlip` (`exposure_writer`)
 * is never reached for a refused actor, which is resolve.test.ts's
 * non-vacuity proof for the partner-admin row: the writer stub's call
 * count stays at 0.
 *
 * A `platform_ops` flip additionally writes a `platform_audit` row
 * (Policy point 9: "Every use writes platform_audit" -- the audit trail
 * for any platform-initiated change). A customer's own flip does not:
 * `account_features.decided_by_user_id` already records the actor for
 * that case.
 */
export async function flipFeature(ctx: FlipFeatureContext, input: FlipFeatureInput): Promise<AccountFeature> {
  const role = await authorizeFlip(ctx.db, input.accountId, ctx.actor);
  const source: FeatureSource = role === "platform_ops" ? "platform" : "customer";

  const result = await writeFeatureFlip(
    { pool: ctx.writerPool, principal: ctx.actor.userId },
    { accountId: input.accountId, featureKey: input.featureKey, state: input.state, source },
  );

  if (role === "platform_ops") {
    await writePlatformAudit(
      { pool: ctx.writerPool, principal: ctx.actor.userId },
      {
        accountId: input.accountId,
        action: "feature_flip",
        newValue: { featureKey: input.featureKey, state: input.state },
      },
    );
  }

  return result;
}
