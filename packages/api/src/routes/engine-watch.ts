import { z } from "zod";
import type { PoolClient } from "pg";
import { WAKE_STAMP_MAX_DB_AGE_S, heardAgeWithSeen, readRepoWakeSeen } from "@fx/core/src/engine/panels.js";
import { markRunnerWork } from "@fx/core/src/pendingWork.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { findEngineTarget } from "@fx/db/src/engineCommands.js";
import { ensureWatchCommand, releaseWatchLease, takeWatchLease, type WatchCommandOutcome } from "@fx/db/src/engineWatch.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { watchLimitsFor } from "@fx/spend";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";

/**
 * D#845 ON-24b: the watch route. A person who opens a repo's engine in the Team app asks here for a live view: the route takes a lease for (account, repo, user, browser) under the
 * plan's caps, and issues the signed `watch` command that makes the runner upload detail when none is due already. It changes when data is uploaded, never what: the reader's own
 * role is what the panels need (any member), and the command goes to the runner of the repo's own engine session, never to anything the request names. A lease is renewed by the
 * event stream opened with `?watch=<lease_id>` (inside its 60 s re-check) and removed when that stream closes; the route's DELETE is the explicit end (a person leaving the repo while
 * the account stream stays open).
 */
const idParams = z.object({ id: z.string() });
const UUID = z.string().uuid();
const startBody = z
  .object({
    /** One id per browser (not per tab): the lease is keyed by it, so reopening or retrying from the same browser renews instead of taking a second slot. */
    browser_id: UUID,
    /** True when the person did something on the view since the last call: it starts a view and restarts the idle clock. A periodic refresh sends false, and never starts one (409 `watch_ended`). */
    active: z.boolean(),
    /** "Load older": an ingest seq of the repo's detail session, asked for in a `watch` with a `before` cursor. */
    before: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
const releaseQuery = z.object({ browser_id: UUID });
const startResponse = z.object({
  lease_id: z.string(),
  expires_at: z.string(),
  session_ends_at: z.string(),
  limits: z.object({ per_repo: z.number().int(), per_account: z.number().int() }),
  /** What the route did about the runner: sent a command, found one already covering the watch, was too soon after the last, or the runner is too old to take one. */
  command: z.enum(["issued", "held", "throttled", "runner_too_old"]),
  machine: z.enum(["online", "offline"]),
  last_seen: z.string().nullable(),
  detail_as_of: z.string().nullable(),
});
const releaseResponse = z.object({ released: z.boolean() });

/** The runner of the repo's newest engine session whatever its age, for a machine that is offline: the command waits in the queue for it. Never a revoked runner or one not paired with the repo. */
async function lastKnownRunner(client: Pick<PoolClient, "query">, accountId: string, repoId: string): Promise<string | null> {
  const { rows } = await client.query<{ runner_id: string }>(
    `SELECT s.runner_id
       FROM engine_sessions s
       JOIN runners rn ON rn.id = s.runner_id AND rn.account_id = s.account_id AND rn.revoked_at IS NULL AND $2::uuid = ANY (rn.allowed_repo_ids)
       JOIN repos r ON r.id = s.repo_id AND r.account_id = s.account_id AND r.execution_mode = 'runner_local'
      WHERE s.account_id = $1 AND s.repo_id = $2
      ORDER BY GREATEST(s.last_event_at, s.last_heartbeat_at) DESC
      LIMIT 1`,
    [accountId, repoId],
  );
  return rows[0]?.runner_id ?? null;
}

/** Whether the machine has been heard from lately, and when, from the database's word and the wake route's newer `seen` stamp (a quiet runner speaks every 5 minutes, its daemon checks every 20 s). */
async function readLiveness(client: Pick<PoolClient, "query">, accountId: string, repoId: string) {
  const { rows } = await client.query<{ heard: number | null; detail_as_of: Date | null }>(
    `SELECT EXTRACT(EPOCH FROM (now() - max(last_heard_at)))::float8 AS heard,
            max(GREATEST(last_event_at, last_heartbeat_at)) FILTER (WHERE session_kind = 'detail') AS detail_as_of
       FROM engine_sessions WHERE account_id = $1 AND repo_id = $2`,
    [accountId, repoId],
  );
  const now = new Date();
  const dbAge = rows[0]?.heard == null ? null : Math.max(0, Math.round(rows[0].heard));
  const seen = (await readRepoWakeSeen(client, accountId, [repoId], now)).get(repoId) ?? null;
  const age = heardAgeWithSeen(dbAge, seen, now);
  return {
    machine: age !== null && age <= WAKE_STAMP_MAX_DB_AGE_S ? ("online" as const) : ("offline" as const),
    last_seen: age === null ? null : new Date(now.getTime() - age * 1000).toISOString(),
    detail_as_of: rows[0]?.detail_as_of?.toISOString() ?? null,
  };
}

export const engineWatchRoutes: RouteEntry[] = [
  {
    method: "POST",
    path: "/api/v1/engine/repos/{id}/watch",
    operationId: "watchEngineRepo",
    summary: "Open or renew a live view of a repo's engine",
    description:
      "Any member, session only (a token is 403 `session_required`). The repo must be enabled for the engine bridge and the account's watch setting on (else 404). Takes a lease keyed by this browser, or renews it: " +
      "a start is idempotent, so repeated calls hold one slot and one `watch` command. A new key counts against the plan's caps on concurrent watchers per repo and per account (429 `watch_limit`, with `data` " +
      "`{cap, limit, in_use}`); the view ends at the plan's session maximum or after its idle limit with no `active: true` call, and a call with `active: false` never starts one (409 `watch_ended`). The lease lives 90 s past its last renewal: open `/api/v1/events?watch=<lease_id>` " +
      "and it is renewed by the stream and removed the moment the stream closes. When the machine is offline the `watch` command waits for it and `machine` says `offline`. Answers 409 `engine_not_connected` " +
      "for a repo whose engine was never connected, and 400 `invalid_request` for a `before` ahead of what the repo holds. At most one `watch` command is issued per repo in 30 s.",
    // principals omitted -> session-only.
    minRole: "member",
    idempotency: "never",
    rateClass: "write",
    extraResponses: {
      "400": "A `before` cursor ahead of the repo's detail sessions.",
      "404": "No such repo in this account, or it is not enabled for the engine bridge, or the account's watch setting is off.",
      "409": "`engine_not_connected`, or `watch_ended` (a refresh of a view that has ended).",
      "429": "`watch_limit`: the plan's cap on concurrent watchers is reached.",
      "503": "`plan_data_unavailable`: the plan has no watch limits.",
    },
    paramsSchema: idParams,
    bodySchema: startBody,
    responseSchema: startResponse,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId } = ctx.principal;
      const body = input.body as z.infer<typeof startBody>;
      const done = await withTenant(ctx.pool, accountId, userId, async (client) => {
        const target = await findEngineTarget(client, accountId, repoId, "watch");
        if (target.status === "no_repo" || target.status === "watch_off" || target.status === "repo_not_enabled" || target.status === "operate_off") throw new ApiError(404, "not_found", "no such repo");
        const runnerId = target.status === "ok" ? target.runnerId : await lastKnownRunner(client, accountId, repoId);
        if (runnerId === null) throw new ApiError(409, "engine_not_connected", "no engine is connected for this repo");
        const plan = (await client.query<{ plan: string }>("SELECT plan FROM accounts WHERE id = $1", [accountId])).rows[0]?.plan;
        const limits = watchLimitsFor(plan ?? "");
        const lease = await takeWatchLease(client, { accountId, repoId, userId, browserId: body.browser_id, limits, active: body.active });
        if (lease.status === "ended") return { kind: "ended" as const };
        if (lease.status === "limit") return { kind: "limit" as const, limit: lease };
        const command: WatchCommandOutcome = await ensureWatchCommand(client, { accountId, repoId, runnerId, userId, ...(body.before === undefined ? {} : { before: body.before }) });
        if (command === "before_ahead") throw new ApiError(400, "invalid_request", "before is ahead of what the repo holds");
        return { kind: "ok" as const, lease, limits, command, live: await readLiveness(client, accountId, repoId) };
      });
      if (done.kind === "ended") throw new ApiError(409, "watch_ended", "the live view has ended; start it again");
      if (done.kind === "limit") {
        throw new ApiError(429, "watch_limit", "too many people are watching this engine", undefined, { cap: done.limit.cap, limit: done.limit.limit, in_use: done.limit.inUse });
      }
      // After the commit: the runner's pull reads the committed row. A lost hint is covered by the runner's own slow check.
      if (done.command === "issued") void markRunnerWork(accountId);
      return {
        lease_id: done.lease.leaseId,
        expires_at: done.lease.expiresAt.toISOString(),
        session_ends_at: done.lease.sessionEndsAt.toISOString(),
        limits: { per_repo: done.limits.perRepo, per_account: done.limits.perAccount },
        command: done.command,
        ...done.live,
      };
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/engine/repos/{id}/watch",
    operationId: "stopWatchingEngineRepo",
    summary: "End this browser's live view of a repo's engine",
    description:
      "Any member, session only. Removes the lease this browser holds on the repo, so its slot is free at once; calling it with no lease is not an error (`released` is false); a repo that is not in this account is 404. " +
      "A person only ever ends their own lease: the browser id names a lease of the caller, never another user's.",
    minRole: "member",
    idempotency: "never",
    rateClass: "write",
    extraResponses: { "404": "No such repo in this account." },
    paramsSchema: idParams,
    querySchema: releaseQuery,
    responseSchema: releaseResponse,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId } = ctx.principal;
      const query = input.query as z.infer<typeof releaseQuery>;
      const released = await withTenant(ctx.pool, accountId, userId, async (client) => {
        // The repo is resolved in the caller's account first, so a repo of another account answers like an unknown one.
        const repo = await client.query("SELECT 1 FROM repos WHERE id = $1 AND account_id = $2", [repoId, accountId]);
        if (repo.rowCount === 0) throw new ApiError(404, "not_found", "no such repo");
        return releaseWatchLease(client, { accountId, repoId, userId, browserId: query.browser_id });
      });
      return { released };
    },
  },
];
