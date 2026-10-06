import type { Pool } from "pg";

/**
 * A minimal fake `platform_ops` Pool for route tests that exercise
 * sign-up/sign-in (identity.ts) without a real Postgres connection.
 * Matches on the SQL text identity.ts actually issues -- narrow on
 * purpose, so a route test using this stays honest about which queries
 * it expects rather than accepting anything.
 */
export function fakePlatformOpsPool(seed: {
  existingUser?: {
    id: string;
    email: string;
    name: string | null;
    sessionEpoch?: number;
    githubLogin?: string | null;
  } | null;
  memberships?: { accountId: string; role: "owner" | "admin" | "member" }[];
  /**
   * D#37 WS-L1: seeds `SELECT role FROM account_members ...` (billing's
   * `authorizeAccountRead`, via `@fx/core`'s `getMemberRole`) and
   * `SELECT status FROM accounts ...` (billing's `readAccountStatus`),
   * BOTH of which run against `platform_ops` per billing's own `BillingCtx`
   * doc comment (its unconditional `account_members` grant is what makes
   * that pool correct for the membership check too, not just the status
   * read) -- keyed by accountId, since a session test seeds exactly one
   * account. Defaults to a member role of "owner" (matching this file's
   * own `existingUser`/`memberships` default shape) and status "active",
   * so a session test that doesn't care about workspace_access still
   * gets `workspace_access: "open"` without having to seed this.
   */
  accountStatus?: { accountId: string; status: string; role?: "owner" | "admin" | "member" } | null;
} = {}): Pool & { domainEvents: { accountId: string; type: string; subjectId: string }[] } {
  let userRow = seed.existingUser
    ? {
        ...seed.existingUser,
        sessionEpoch: seed.existingUser.sessionEpoch ?? 0,
        githubLogin: seed.existingUser.githubLogin ?? null,
      }
    : null;
  const memberships = seed.memberships ?? [];
  // Security fix round item 1 (CWE-613, correction C15a): every session
  // id (`sid`) revokeSession has recorded, across every user, mapped to
  // its own `expires_at` -- matches migrations/0609_revoked_sessions.sql's
  // `revoked_sessions` table closely enough for a route/unit test (a real
  // Postgres round trip is identity.test.ts's job, not this fake's).
  // Fix round 1 (E1): a Map, not a Set, so the fake DELETE query below can
  // purge entries whose `expires_at` has passed, the same way
  // revokeSession's real query does.
  const revokedSessions = new Map<string, Date>();

  const domainEvents: { accountId: string; type: string; subjectId: string }[] = [];

  const client = {
    async query(sql: string, params: unknown[] = []) {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      // D#37 WS-L1: withTenant's own set_config bracket (@fx/core's
      // getMemberRole, called by billing's authorizeAccountRead against
      // THIS pool -- see the accountStatus seed field's own comment).
      // Same generic no-op fakeAppUserPool already gives this statement.
      if (sql.startsWith("SELECT set_config(")) {
        return { rows: [] };
      }
      // D#37 WS-L1: billing's authorizeAccountRead (via @fx/core's
      // getMemberRole) run against platform_ops. Answers with the
      // seeded accountStatus.role when the accountId matches, else
      // defaults to "owner" -- every existing session-route test is an
      // authenticated member of the account its own token names, and
      // none of them seed accountStatus, so this default keeps them all
      // passing unchanged.
      if (/^SELECT role FROM account_members WHERE account_id = \$1 AND user_id = \$2$/.test(sql)) {
        const accountId = params[0] as string;
        const role =
          seed.accountStatus && seed.accountStatus.accountId === accountId
            ? (seed.accountStatus.role ?? "owner")
            : "owner";
        return { rows: [{ role }] };
      }
      // D#37 WS-L1: billing's readAccountStatusInTx, reached through
      // readAccountStatus (session-routes.ts's workspaceAccessForSession).
      // Defaults to "active" (workspace_access: "open") for the same
      // reason the membership default above does -- most existing tests
      // never seed accountStatus and never meant to test the gate.
      if (/^SELECT status FROM accounts WHERE id = \$1 AND deleted_at IS NULL$/.test(sql)) {
        const accountId = params[0] as string;
        const status =
          seed.accountStatus && seed.accountStatus.accountId === accountId ? seed.accountStatus.status : "active";
        return { rows: [{ status }] };
      }
      if (/SELECT id, email, name, session_epoch FROM users WHERE github_user_id/.test(sql)) {
        return {
          rows: userRow
            ? [{ id: userRow.id, email: userRow.email, name: userRow.name, session_epoch: userRow.sessionEpoch }]
            : [],
        };
      }
      if (/UPDATE users SET github_login = \$1 WHERE id = \$2/.test(sql)) {
        if (userRow && userRow.id === params[1]) {
          userRow.githubLogin = params[0] as string | null;
        }
        return { rows: [] };
      }
      if (/INSERT INTO users \(id, github_user_id, email, name, github_login\)/.test(sql)) {
        userRow = {
          id: params[0] as string,
          email: params[2] as string,
          name: params[3] as string | null,
          sessionEpoch: 0,
          githubLogin: params[4] as string | null,
        };
        return { rows: [] };
      }
      if (/SELECT account_id AS "accountId", role FROM account_members WHERE user_id/.test(sql)) {
        return { rows: memberships };
      }
      if (/INSERT INTO accounts/.test(sql)) {
        return { rows: [] };
      }
      if (/INSERT INTO account_members/.test(sql)) {
        memberships.push({ accountId: params[0] as string, role: "owner" });
        return { rows: [] };
      }
      if (/SELECT email, github_login FROM users WHERE id/.test(sql)) {
        return {
          rows: userRow && userRow.id === params[0] ? [{ email: userRow.email, github_login: userRow.githubLogin }] : [],
        };
      }
      if (/^SELECT github_login FROM users WHERE id = \$1$/.test(sql)) {
        return { rows: userRow && userRow.id === params[0] ? [{ github_login: userRow.githubLogin }] : [] };
      }
      if (/SELECT email FROM users WHERE id/.test(sql)) {
        return { rows: userRow ? [{ email: userRow.email }] : [] };
      }
      if (/UPDATE users SET session_epoch = session_epoch \+ 1 WHERE id/.test(sql)) {
        if (!userRow || userRow.id !== params[0]) {
          return { rows: [] };
        }
        userRow.sessionEpoch += 1;
        return { rows: [{ session_epoch: userRow.sessionEpoch }] };
      }
      if (/SELECT session_epoch, EXISTS \(SELECT 1 FROM revoked_sessions WHERE session_id = \$2\) AS revoked FROM users WHERE id/.test(sql)) {
        if (!userRow || userRow.id !== params[0]) return { rows: [] };
        const sessionId = params[1] as string;
        return { rows: [{ session_epoch: userRow.sessionEpoch, revoked: revokedSessions.has(sessionId) }] };
      }
      if (/INSERT INTO revoked_sessions \(session_id, user_id, expires_at\)/.test(sql)) {
        revokedSessions.set(params[0] as string, params[2] as Date);
        return { rows: [] };
      }
      // Fix round 1 (E1, CWE-770/400): the same purge revokeSession issues,
      // in the same fake "transaction", right after the insert above.
      if (/^DELETE FROM revoked_sessions WHERE expires_at < now\(\)$/.test(sql)) {
        const now = new Date();
        for (const [sessionId, expiresAt] of revokedSessions) {
          if (expiresAt < now) revokedSessions.delete(sessionId);
        }
        return { rows: [] };
      }
      // Not issued by any production code path (getSessionEpochAndRevocation
      // above is the only real caller, and it always carries the EXISTS
      // clause) -- kept only because signout/handler.test.ts's own
      // "{"everywhere": true} ... bumps the epoch" test queries this fake
      // pool directly, the plain way, to assert on the post-bump value.
      if (/^SELECT session_epoch FROM users WHERE id = \$1$/.test(sql)) {
        return { rows: userRow && userRow.id === params[0] ? [{ session_epoch: userRow.sessionEpoch }] : [] };
      }
      // Not issued by any production code path either -- same shape as
      // the SELECT above, kept only so a regression test can assert on
      // the exact `expires_at` a revoke wrote, the way
      // packages/core/test/pg/identity.test.ts does against real
      // Postgres.
      if (/^SELECT expires_at FROM revoked_sessions WHERE session_id = \$1$/.test(sql)) {
        const sessionId = params[0] as string;
        const expiresAt = revokedSessions.get(sessionId);
        return { rows: expiresAt ? [{ expires_at: expiresAt }] : [] };
      }
      // API-5c: bumpSessionEpoch's session.revoked outbox rows, one per membership; recorded for the sign-out test.
      if (/^INSERT INTO domain_events \(account_id, type, subject_id, payload\)\s+SELECT account_id, 'session.revoked'/.test(sql)) {
        for (const m of memberships) domainEvents.push({ accountId: m.accountId, type: "session.revoked", subjectId: params[0] as string });
        return { rows: [] };
      }
      throw new Error(`fakePlatformOpsPool: unexpected query: ${sql}`);
    },
    release() {
      // no-op
    },
  };

  return { connect: async () => client, domainEvents } as unknown as Pool & { domainEvents: typeof domainEvents };
}
