import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RateLimitedError } from "../errors.js";
import { PgRateLimitStore, type RateLimitStore, type SessionWindowSeconds } from "./store.js";

/** One cap: at most `limit` calls inside a fixed window of `seconds`. */
export interface SessionWindow {
  limit: number;
  seconds: SessionWindowSeconds;
}

/**
 * What a route declares for signed-in (session) callers. `name` keeps the route's buckets apart
 * from every other route's (routes that reach the same outside service share one name, so
 * they share one budget). `account` is counted per account, `user` per user inside the account.
 * Windows are checked shortest first and checking stops at the first refusal, so a refused call
 * never burns the longer window's budget.
 */
export interface SessionLimit {
  name: string;
  account: readonly SessionWindow[];
  user?: readonly SessionWindow[];
}

/**
 * Every session write that has no rule of its own. A person clicking cannot reach it; a script
 * holding a session cookie can, and each call writes. Reads and streams have their own limits.
 */
export const DEFAULT_SESSION_WRITE_LIMIT: SessionLimit = {
  name: "write",
  account: [{ limit: 120, seconds: 60 }],
  user: [{ limit: 60, seconds: 60 }],
};

/** The rule a SESSION caller of a route is held to: its own, else the default for a write, else none (a plain read). */
export function sessionLimitFor(route: { method: string; sessionLimit?: SessionLimit }): SessionLimit | undefined {
  if (route.sessionLimit) return route.sessionLimit;
  return route.method === "GET" || route.method === "HEAD" ? undefined : DEFAULT_SESSION_WRITE_LIMIT;
}

export interface SessionSubject {
  accountId: string;
  userId: string;
}

/**
 * Charges the caller's account (and user) buckets for `rule`. Throws `RateLimitedError` with the
 * refusing bucket's seconds-to-reset once a bucket is over its cap. The counters are written in a
 * tenant transaction that commits before the throw, so a refused call still counts. A store
 * failure is never caught here: it propagates and the request fails (500) rather than being served
 * unlimited, the same fail-closed rule the token limits keep.
 */
export async function enforceSessionRateLimits(
  store: RateLimitStore,
  pool: Pool,
  subject: SessionSubject,
  rule: SessionLimit,
): Promise<void> {
  const refusedFor = await withTenant(pool, subject.accountId, subject.userId, async (client) => {
    const checks: Array<{ key: string; window: SessionWindow }> = [
      ...rule.account.map((window) => ({ key: `session:${subject.accountId}:${rule.name}:w${window.seconds}`, window })),
      ...(rule.user ?? []).map((window) => ({
        key: `session-user:${subject.accountId}:${subject.userId}:${rule.name}:w${window.seconds}`,
        window,
      })),
    ].sort((a, b) => a.window.seconds - b.window.seconds);
    for (const { key, window } of checks) {
      const decision = await store.checkAndIncrement(key, window.limit, client, window.seconds);
      if (!decision.allowed) return decision.retryAfterSeconds;
    }
    return null;
  });
  if (refusedFor !== null) {
    throw new RateLimitedError(refusedFor);
  }
}

const TEN_PER_MINUTE: readonly SessionWindow[] = [{ limit: 10, seconds: 60 }];

/**
 * The rules routes name for themselves. A route that calls an outside service (a model provider,
 * GitHub, Stripe, a customer's webhook URL) or starts compute gets its own; the rest take
 * `DEFAULT_SESSION_WRITE_LIMIT`.
 */
export const SESSION_LIMITS = {
  /** Saving or testing a model key calls the provider's key-check endpoint on every call: one per 10 s, 30 an hour, per account. */
  modelKeyPut: { name: "model-key-put", account: [{ limit: 1, seconds: 10 }, { limit: 30, seconds: 3600 }] },
  modelKeyTest: { name: "model-key-test", account: [{ limit: 1, seconds: 10 }, { limit: 30, seconds: 3600 }] },
  /** Building a GitHub install link, and minting a repo-create link (which also has its own hour and day count). */
  githubInstallUrl: { name: "github-install-url", account: TEN_PER_MINUTE },
  githubCreateIntent: { name: "github-create-intent", account: TEN_PER_MINUTE },
  /** Every route that makes a Stripe portal, checkout or cancel call shares one budget. */
  stripe: { name: "stripe", account: TEN_PER_MINUTE },
  /** Sends a real HTTP request to the customer's webhook URL. */
  webhookTest: { name: "webhook-test", account: TEN_PER_MINUTE },
  /** Queues a new run (compute); a run is also allowed only one retry. */
  runRetry: { name: "run-retry", account: TEN_PER_MINUTE },
  /** The GitHub App install return and the repo-create return both call GitHub on each visit. */
  githubReturn: { name: "github-return", account: TEN_PER_MINUTE },
  /** Starting a plan import reads a repository through the code host (up to 400 requests): 20 an hour per account. The database holds the per-repository 6 an hour. */
  planImport: { name: "plan-import", account: [{ limit: 20, seconds: 3600 }] },
  /** Redeeming an invitation token: a guessing path, so capped per user as well as per account. */
  invitationAccept: { name: "invitation-accept", account: TEN_PER_MINUTE, user: TEN_PER_MINUTE },
} as const satisfies Record<string, SessionLimit>;

/**
 * The limiter for a plain web route (outside the `/api/v1` dispatcher) that resolves its own session: counts against the
 * real Postgres store on `pool` (the app_user pool). Throws `RateLimitedError` when over the cap.
 */
export function pgSessionLimiter(pool: Pool, rule: SessionLimit): (subject: SessionSubject) => Promise<void> {
  return (subject) => enforceSessionRateLimits(new PgRateLimitStore(pool), pool, subject, rule);
}
