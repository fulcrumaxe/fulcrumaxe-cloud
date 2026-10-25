import type { Pool, PoolClient } from "pg";
import { PLANE_MERGE_CAPABILITY, PLANE_MERGE_LEASE_SECONDS, PLANE_MERGE_MAX_ATTEMPTS, PLANE_MERGE_ORDER_DEADLINE_MINUTES } from "@fulcrumaxe/runner-protocol";
import { pairingDigest } from "@fx/core/src/repos/planePushRecord.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { requireUuid } from "./runActions.js";

/**
 * D#6 PUBLIC-MERGE PR2a: the order store behind the local runner's merge of a paired item's public pull request (table `plane_merge_orders`, 0910).
 *
 *   placeOrder      the gate cleared an item: record ONE open order for the heads it cleared, from the item's own `plane_pushes` row; supersede an older one.
 *   claimNext       a runner takes the oldest order it may take (eligibility is computed here, at claim time, never stored), leased for ten minutes.
 *   grantReadToken  marks the read credential of this (order, lease generation) as issued; a second ask for the same pair gets nothing.
 *   fence           the lease fence of an order: the runner, the generation, the lease and the deadline. Asking does not extend the lease.
 *   authorize       the go decision's grant: claimed -> authorized, writing the single issue time of the write credential. Once per order.
 *   finish          the one way an order ends (a runner within its lease, or the cloud), along a fixed table of moves.
 *   reapLeases / expireDue / lapsedAuthorized   what time does to an order.
 *
 * AUTHORITY WARNING, as for the other runner facades: `accountId` and `runnerId` MUST be the ones a verified runner request carries. Nothing a runner
 * sent decides the repository, the pull request or a sha: they are the order's, copied from our own `plane_pushes` row. This module mints nothing and
 * calls no GitHub; the credential kind is the minting layer's business (`token_purpose` is only a label), and a missing or failed mint is settled by
 * `finish`. The pool is any login with the app role's grants on the tables read here.
 */

export const PLANE_MERGE_STATES = ["pending", "claimed", "authorized", "merged", "blocked", "head_moved", "superseded", "failed", "expired"] as const;
export type PlaneMergeState = (typeof PLANE_MERGE_STATES)[number];
export const PLANE_MERGE_OPEN_STATES: readonly PlaneMergeState[] = ["pending", "claimed", "authorized"];
const isOpen = (s: PlaneMergeState): boolean => PLANE_MERGE_OPEN_STATES.includes(s);

/** Codes the store itself writes. Gate reasons and the runner's abort codes are written by the caller through `finish`. */
export const PLANE_MERGE_CODES = { superseded: "superseded_by_new_order", timeout: "runner_merge_timeout", failed: "runner_merge_failed", pairingChanged: "pairing_changed", headMoved: "public_head_moved", merged: "merged" } as const;

export interface PlaneMergeOrder {
  id: string;
  accountId: string;
  workItemId: string;
  planePushId: string;
  repoId: string;
  codeRepo: string;
  prNumber: number;
  expectedPublicHead: string;
  reviewedHead: string;
  pairingDigest: string;
  state: PlaneMergeState;
  runnerId: string | null;
  leaseGeneration: number;
  leaseExpiresAt: Date | null;
  attempts: number;
  readTokenGeneration: number | null;
  writeTokenIssuedAt: Date | null;
  tokenPurpose: string;
  outcomeCode: string | null;
  deadlineAt: Date;
  finishedAt: Date | null;
}

/** What the claim reply needs beyond the order: all from our rows. */
export interface PlaneMergeClaimFacts {
  publicBranch: string;
  privateOwner: string;
  privateName: string;
  overlayGlobs: string[];
}

export type FenceReason = "unknown" | "stale_generation" | "lease_expired" | "order_terminal" | "order_expired";
export type PlaneMergeFence = { kind: "ok"; order: PlaneMergeOrder } | { kind: "fenced"; reason: FenceReason };

export interface PlaceOrderInput {
  accountId: string;
  workItemId: string;
  /** The public head the gate cleared and the private head the reviewers cleared. Compared with the push record; never trusted. */
  expectedPublicHead: string;
  reviewedHead: string;
}
export type PlaceOrderResult =
  | { kind: "placed"; order: PlaneMergeOrder; superseded: string[] }
  /** An open order for exactly these heads and this pairing exists; nothing changed. */
  | { kind: "unchanged"; order: PlaneMergeOrder }
  | { kind: "not_paired" }
  /** The push record is not an open, platform-managed public pull request. */
  | { kind: "push_not_open" }
  /** The push record's heads are not the heads the caller named. */
  | { kind: "push_changed" };

export type ClaimResult = { kind: "claimed"; order: PlaneMergeOrder; facts: PlaneMergeClaimFacts } | { kind: "none" };

export interface RunnerLease {
  accountId: string;
  runnerId: string;
  orderId: string;
  leaseGeneration: number;
}

export type AuthorizeResult = { kind: "authorized"; order: PlaneMergeOrder } | { kind: "already_issued" } | { kind: "fenced"; reason: FenceReason };
export type GrantReadResult = { kind: "granted"; order: PlaneMergeOrder } | { kind: "already_issued" } | { kind: "fenced"; reason: FenceReason };

export type FinishActor = { by: "runner"; runnerId: string; leaseGeneration: number } | { by: "cloud" };
export interface FinishInput {
  accountId: string;
  orderId: string;
  to: Exclude<PlaneMergeState, "pending" | "claimed" | "authorized">;
  code: string;
  actor: FinishActor;
}
export type FinishResult = { kind: "finished"; order: PlaneMergeOrder } | { kind: "fenced"; reason: FenceReason } | { kind: "not_allowed"; from: PlaneMergeState } | { kind: "not_found" };

/** Which ends an order may reach from where it is, and whether a runner may be the one to end it. The trigger in 0910 holds the same table. */
const ENDS: Record<"pending" | "claimed" | "authorized", { cloud: readonly PlaneMergeState[]; runner: readonly PlaneMergeState[] }> = {
  pending: { cloud: ["blocked", "superseded", "expired"], runner: [] },
  claimed: { cloud: ["blocked", "head_moved", "superseded", "failed", "expired"], runner: ["blocked", "head_moved", "superseded", "failed"] },
  authorized: { cloud: ["merged", "head_moved", "superseded", "failed", "expired"], runner: ["merged", "head_moved", "failed"] },
};

const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const COLUMNS = `o.id, o.account_id, o.work_item_id, o.plane_push_id, o.repo_id, o.code_repo, o.pr_number, o.expected_public_head, o.reviewed_head, o.pairing_digest, o.state,
  o.runner_id, o.lease_generation, o.lease_expires_at, o.attempts, o.read_token_generation, o.write_token_issued_at, o.token_purpose, o.outcome_code, o.deadline_at, o.finished_at`;

interface Row {
  id: string;
  account_id: string;
  work_item_id: string;
  plane_push_id: string;
  repo_id: string;
  code_repo: string;
  pr_number: number;
  expected_public_head: string;
  reviewed_head: string;
  pairing_digest: string;
  state: PlaneMergeState;
  runner_id: string | null;
  lease_generation: number;
  lease_expires_at: Date | null;
  attempts: number;
  read_token_generation: number | null;
  write_token_issued_at: Date | null;
  token_purpose: string;
  outcome_code: string | null;
  deadline_at: Date;
  finished_at: Date | null;
}

const toOrder = (r: Row): PlaneMergeOrder => ({
  id: r.id,
  accountId: r.account_id,
  workItemId: r.work_item_id,
  planePushId: r.plane_push_id,
  repoId: r.repo_id,
  codeRepo: r.code_repo,
  prNumber: r.pr_number,
  expectedPublicHead: r.expected_public_head,
  reviewedHead: r.reviewed_head,
  pairingDigest: r.pairing_digest,
  state: r.state,
  runnerId: r.runner_id,
  leaseGeneration: r.lease_generation,
  leaseExpiresAt: r.lease_expires_at,
  attempts: r.attempts,
  readTokenGeneration: r.read_token_generation,
  writeTokenIssuedAt: r.write_token_issued_at,
  tokenPurpose: r.token_purpose,
  outcomeCode: r.outcome_code,
  deadlineAt: r.deadline_at,
  finishedAt: r.finished_at,
});

export interface RunnerPlaneMergeStore {
  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
  claimNext(input: { accountId: string; runnerId: string }): Promise<ClaimResult>;
  grantReadToken(input: RunnerLease): Promise<GrantReadResult>;
  fence(input: RunnerLease): Promise<PlaneMergeFence>;
  authorize(input: RunnerLease): Promise<AuthorizeResult>;
  finish(input: FinishInput): Promise<FinishResult>;
  /** Claimed orders whose lease ran out go back to pending, or to failed on the third. Returns how many of each. */
  reapLeases(accountId: string): Promise<{ requeued: number; failed: number }>;
  /** Open orders past their deadline become expired (`runner_merge_timeout`); with `orderId`, only that one. Returns the orders that expired. */
  expireDue(input: { accountId: string; orderId?: string }): Promise<PlaneMergeOrder[]>;
  /** Authorized orders whose lease ran out without a report. They are never re-authorized; the caller reads GitHub, then calls `finish`. */
  lapsedAuthorized(accountId: string): Promise<PlaneMergeOrder[]>;
  /** The newest order of an item, whatever its state; null when none. */
  latestForItem(input: { accountId: string; workItemId: string }): Promise<PlaneMergeOrder | null>;
}

export interface RunnerPlaneMergeDeps {
  now?: () => number;
}

export function createRunnerPlaneMergeStore(pool: Pool, deps: RunnerPlaneMergeDeps = {}): RunnerPlaneMergeStore {
  const now = deps.now ?? Date.now;
  const clock = () => new Date(now());

  const lockOrder = async (client: PoolClient, accountId: string, orderId: string): Promise<PlaneMergeOrder | null> => {
    const { rows } = await client.query<Row>(`SELECT ${COLUMNS} FROM plane_merge_orders o WHERE o.account_id = $1 AND o.id = $2 FOR UPDATE`, [accountId, orderId]);
    return rows[0] ? toOrder(rows[0]) : null;
  };

  /** The fence on a locked order. Does not write, so it never extends a lease. */
  const check = (order: PlaneMergeOrder | null, lease: { runnerId: string; leaseGeneration: number }, at: Date): PlaneMergeFence => {
    if (!order || order.runnerId !== lease.runnerId) return { kind: "fenced", reason: "unknown" };
    if (order.leaseGeneration !== lease.leaseGeneration) return { kind: "fenced", reason: "stale_generation" };
    if (order.state !== "claimed" && order.state !== "authorized") return { kind: "fenced", reason: "order_terminal" };
    if (order.deadlineAt.getTime() <= at.getTime()) return { kind: "fenced", reason: "order_expired" };
    if (order.leaseExpiresAt === null || order.leaseExpiresAt.getTime() <= at.getTime()) return { kind: "fenced", reason: "lease_expired" };
    return { kind: "ok", order };
  };

  const reap = async (client: PoolClient, accountId: string, at: Date) => {
    const failed = await client.query(
      `UPDATE plane_merge_orders SET state = 'failed', outcome_code = $3, finished_at = $2
        WHERE account_id = $1 AND state = 'claimed' AND lease_expires_at <= $2 AND attempts >= $4`,
      [accountId, at, PLANE_MERGE_CODES.failed, PLANE_MERGE_MAX_ATTEMPTS],
    );
    const requeued = await client.query(
      `UPDATE plane_merge_orders SET state = 'pending', runner_id = NULL, lease_expires_at = NULL
        WHERE account_id = $1 AND state = 'claimed' AND lease_expires_at <= $2 AND attempts < $3`,
      [accountId, at, PLANE_MERGE_MAX_ATTEMPTS],
    );
    return { requeued: requeued.rowCount ?? 0, failed: failed.rowCount ?? 0 };
  };

  const end = async (client: PoolClient, orderId: string, accountId: string, to: PlaneMergeState, code: string, at: Date): Promise<PlaneMergeOrder> => {
    const { rows } = await client.query<Row>(
      `UPDATE plane_merge_orders o SET state = $3, outcome_code = $4, finished_at = $5 WHERE o.account_id = $1 AND o.id = $2 RETURNING ${COLUMNS}`,
      [accountId, orderId, to, code, at],
    );
    return toOrder(rows[0]!);
  };

  return {
    placeOrder: async (input) => {
      requireUuid(input.accountId);
      requireUuid(input.workItemId);
      return withTenant(pool, input.accountId, async (client): Promise<PlaceOrderResult> => {
        const at = clock();
        // The push record, locked: the same row serialises every order placement of the item.
        const { rows } = await client.query<{ id: string; repo_id: string; code_repo: string; pairing_digest: string; pr_number: number | null; head_sha: string | null; source_head: string | null; state: string; managed: boolean }>(
          `SELECT id, repo_id, code_repo, pairing_digest, pr_number, head_sha, source_head, state, managed_by_person_at IS NOT NULL AS managed
             FROM plane_pushes WHERE account_id = $1 AND work_item_id = $2 FOR UPDATE`,
          [input.accountId, input.workItemId],
        );
        const push = rows[0];
        if (!push) return { kind: "not_paired" };
        if (push.state !== "pr_opened" || push.pr_number === null || push.managed) return { kind: "push_not_open" };
        if (push.head_sha !== input.expectedPublicHead || push.source_head !== input.reviewedHead) return { kind: "push_changed" };

        const { rows: open } = await client.query<Row>(`SELECT ${COLUMNS} FROM plane_merge_orders o WHERE o.account_id = $1 AND o.work_item_id = $2 AND o.state IN ('pending', 'claimed', 'authorized') FOR UPDATE`, [input.accountId, input.workItemId]);
        const current = open[0] ? toOrder(open[0]) : null;
        if (current && current.expectedPublicHead === push.head_sha && current.reviewedHead === push.source_head && current.pairingDigest === push.pairing_digest && current.deadlineAt.getTime() > at.getTime()) return { kind: "unchanged", order: current };
        const superseded: string[] = [];
        if (current) {
          await end(client, current.id, input.accountId, "superseded", PLANE_MERGE_CODES.superseded, at);
          superseded.push(current.id);
        }
        const { rows: made } = await client.query<Row>(
          `INSERT INTO plane_merge_orders AS o (account_id, work_item_id, plane_push_id, repo_id, code_repo, pr_number, expected_public_head, reviewed_head, pairing_digest, deadline_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${COLUMNS}`,
          [input.accountId, input.workItemId, push.id, push.repo_id, push.code_repo, push.pr_number, push.head_sha, push.source_head, push.pairing_digest, new Date(at.getTime() + PLANE_MERGE_ORDER_DEADLINE_MINUTES * 60_000)],
        );
        return { kind: "placed", order: toOrder(made[0]!), superseded };
      });
    },

    claimNext: async (input) => {
      requireUuid(input.accountId);
      requireUuid(input.runnerId);
      return withTenant(pool, input.accountId, async (client): Promise<ClaimResult> => {
        const at = clock();
        await reap(client, input.accountId, at);
        // Eligibility, computed now from the runner's own rows: registered by an owner or admin who still is one (the trust its reviews have), not revoked,
        // the order's repository in its scope, not paused or draining, and its latest hello listed the capability.
        const { rows } = await client.query<Row & { branch: string; push_state: string; push_head: string | null; push_source: string | null; push_managed: boolean; gh_owner: string | null; gh_name: string | null; code_repo_live: string | null; overlay_globs: string[] | null; id_rules: string | null; plan_rules: string | null }>(
          `SELECT ${COLUMNS}, p.branch, p.state AS push_state, p.head_sha AS push_head, p.source_head AS push_source, p.managed_by_person_at IS NOT NULL AS push_managed,
                  rp.gh_owner, rp.gh_name, pr.code_repo AS code_repo_live, pr.overlay_globs, pr.identifier_rules_path AS id_rules, pr.plan_data_rules_path AS plan_rules
             FROM plane_merge_orders o
             JOIN runners rn ON rn.account_id = o.account_id AND rn.id = $2 AND rn.revoked_at IS NULL
             JOIN account_members am ON am.account_id = rn.account_id AND am.user_id = rn.registered_by AND am.role IN ('owner', 'admin')
             JOIN runner_capabilities cap ON cap.account_id = rn.account_id AND cap.runner_id = rn.id AND $5::text = ANY(cap.capabilities)
             LEFT JOIN runner_settings s ON s.account_id = rn.account_id AND s.runner_id = rn.id
             JOIN plane_pushes p ON p.account_id = o.account_id AND p.id = o.plane_push_id
             JOIN repos rp ON rp.account_id = o.account_id AND rp.id = o.repo_id
             LEFT JOIN repo_pairing pr ON pr.account_id = o.account_id AND pr.repo_id = o.repo_id
            WHERE o.account_id = $1 AND o.state = 'pending' AND o.attempts < $3 AND o.deadline_at > $4
              AND o.repo_id = ANY(rn.allowed_repo_ids)
              AND (s.runner_id IS NULL OR (s.paused_at IS NULL AND s.draining = false))
            ORDER BY o.created_at, o.id
            LIMIT 5
            FOR UPDATE OF o SKIP LOCKED`,
          [input.accountId, input.runnerId, PLANE_MERGE_MAX_ATTEMPTS, at, PLANE_MERGE_CAPABILITY],
        );
        for (const r of rows) {
          // The order still describes what the item and its pairing are now; if not it is finished here and the next one is tried.
          const live = r.state === "pending" && r.push_state === "pr_opened" && !r.push_managed && r.push_head === r.expected_public_head && r.push_source === r.reviewed_head;
          if (!live) {
            await end(client, r.id, input.accountId, "superseded", PLANE_MERGE_CODES.headMoved, at);
            continue;
          }
          const digest = r.code_repo_live === null || r.overlay_globs === null ? null : pairingDigest({ codeRepo: r.code_repo_live, overlayGlobs: r.overlay_globs, identifierRulesPath: r.id_rules, planDataRulesPath: r.plan_rules });
          if (digest !== r.pairing_digest || r.gh_owner === null || r.gh_name === null) {
            await end(client, r.id, input.accountId, "blocked", PLANE_MERGE_CODES.pairingChanged, at);
            continue;
          }
          const { rows: leased } = await client.query<Row>(
            `UPDATE plane_merge_orders o SET state = 'claimed', runner_id = $3, lease_generation = o.lease_generation + 1, attempts = o.attempts + 1, lease_expires_at = $4
              WHERE o.account_id = $1 AND o.id = $2 AND o.state = 'pending' RETURNING ${COLUMNS}`,
            [input.accountId, r.id, input.runnerId, new Date(at.getTime() + PLANE_MERGE_LEASE_SECONDS * 1000)],
          );
          return { kind: "claimed", order: toOrder(leased[0]!), facts: { publicBranch: r.branch, privateOwner: r.gh_owner, privateName: r.gh_name, overlayGlobs: r.overlay_globs! } };
        }
        return { kind: "none" };
      });
    },

    fence: async (lease) => {
      requireUuid(lease.orderId);
      return withTenant(pool, lease.accountId, async (client) => check(await lockOrder(client, lease.accountId, lease.orderId), lease, clock()));
    },

    grantReadToken: async (lease) => {
      requireUuid(lease.orderId);
      return withTenant(pool, lease.accountId, async (client): Promise<GrantReadResult> => {
        const fenced = check(await lockOrder(client, lease.accountId, lease.orderId), lease, clock());
        if (fenced.kind !== "ok") return fenced;
        // The read credential is for the claim phase; once the order is authorized the content check is over.
        if (fenced.order.state !== "claimed") return { kind: "already_issued" };
        const { rows } = await client.query<Row>(
          `UPDATE plane_merge_orders o SET read_token_generation = o.lease_generation
            WHERE o.account_id = $1 AND o.id = $2 AND o.state = 'claimed' AND o.read_token_generation IS DISTINCT FROM o.lease_generation RETURNING ${COLUMNS}`,
          [lease.accountId, lease.orderId],
        );
        return rows[0] ? { kind: "granted", order: toOrder(rows[0]) } : { kind: "already_issued" };
      });
    },

    authorize: async (lease) => {
      requireUuid(lease.orderId);
      return withTenant(pool, lease.accountId, async (client): Promise<AuthorizeResult> => {
        const at = clock();
        const fenced = check(await lockOrder(client, lease.accountId, lease.orderId), lease, at);
        if (fenced.kind !== "ok") return fenced;
        if (fenced.order.state !== "claimed" || fenced.order.writeTokenIssuedAt !== null) return { kind: "already_issued" };
        const { rows } = await client.query<Row>(
          `UPDATE plane_merge_orders o SET state = 'authorized', write_token_issued_at = $3
            WHERE o.account_id = $1 AND o.id = $2 AND o.state = 'claimed' AND o.write_token_issued_at IS NULL RETURNING ${COLUMNS}`,
          [lease.accountId, lease.orderId, at],
        );
        return rows[0] ? { kind: "authorized", order: toOrder(rows[0]) } : { kind: "already_issued" };
      });
    },

    finish: async (input) => {
      requireUuid(input.orderId);
      if (!CODE.test(input.code)) throw new Error("finish: bad code");
      return withTenant(pool, input.accountId, async (client): Promise<FinishResult> => {
        const at = clock();
        const order = await lockOrder(client, input.accountId, input.orderId);
        if (!order) return { kind: "not_found" };
        if (input.actor.by === "runner") {
          const fenced = check(order, { runnerId: input.actor.runnerId, leaseGeneration: input.actor.leaseGeneration }, at);
          if (fenced.kind !== "ok") return fenced;
        }
        if (!isOpen(order.state)) return { kind: "not_allowed", from: order.state };
        const allowed = ENDS[order.state as keyof typeof ENDS][input.actor.by];
        if (!allowed.includes(input.to)) return { kind: "not_allowed", from: order.state };
        return { kind: "finished", order: await end(client, order.id, input.accountId, input.to, input.code, at) };
      });
    },

    reapLeases: async (accountId) => withTenant(pool, accountId, (client) => reap(client, accountId, clock())),

    expireDue: async (input) =>
      withTenant(pool, input.accountId, async (client) => {
        const { rows } = await client.query<Row>(
          `UPDATE plane_merge_orders o SET state = 'expired', outcome_code = $3, finished_at = $2
            WHERE o.account_id = $1 AND o.state IN ('pending', 'claimed', 'authorized') AND o.deadline_at <= $2 AND ($4::uuid IS NULL OR o.id = $4::uuid) RETURNING ${COLUMNS}`,
          [input.accountId, clock(), PLANE_MERGE_CODES.timeout, input.orderId ?? null],
        );
        return rows.map(toOrder);
      }),

    lapsedAuthorized: async (accountId) =>
      withTenant(pool, accountId, async (client) => {
        const { rows } = await client.query<Row>(`SELECT ${COLUMNS} FROM plane_merge_orders o WHERE o.account_id = $1 AND o.state = 'authorized' AND o.lease_expires_at <= $2 ORDER BY o.created_at`, [accountId, clock()]);
        return rows.map(toOrder);
      }),

    latestForItem: async (input) =>
      withTenant(pool, input.accountId, async (client) => {
        const { rows } = await client.query<Row>(`SELECT ${COLUMNS} FROM plane_merge_orders o WHERE o.account_id = $1 AND o.work_item_id = $2 ORDER BY o.created_at DESC, o.id DESC LIMIT 1`, [input.accountId, input.workItemId]);
        return rows[0] ? toOrder(rows[0]) : null;
      }),
  };
}
