// apps/workspace/e2e/seed-account-status.mjs
//
// D#37 WS-L1 (correction C19c) criterion 8: "existing e2e test accounts
// are made subscribed through the e2e seed helper... No bypass flag,
// environment switch or test-only branch goes into shipped code." This
// module is test tooling only -- apps/workspace/import/allowlist.txt
// never allowlists anything under e2e/, and build.mjs never walks this
// directory, so nothing here can reach dist/. checks.mjs's --ship
// no-bypass-flag scan (rules.mjs's SHIP_NO_LICENSE_ACTIVATION_RULES)
// greps shipped bytes for exactly the sentinel this file's own comments
// would trip if it were ever accidentally imported into the shell --
// it never is.
//
// It connects DIRECTLY to Postgres (DATABASE_URL_PLATFORM_OPS, the same
// role/pool every other platform_ops write in this app uses) and writes
// the SAME marker columns migration 0606's accounts_derive_status
// trigger already reads for every real write (a real Stripe checkout
// sets stripe_customer_id; this does the same thing directly, for a
// fixture account, instead of through billing's webhook). There is no
// new server code path -- the trigger derives `accounts.status` exactly
// as it would for a real subscription event.
//
// Two entry points:
//   seedAccountStatus({ githubUserId, status })
//     Ensures a users row + owner-of-a-fresh-account membership exists
//     for githubUserId (mirroring packages/core/src/auth/identity.ts's
//     findOrCreateUserByGithub/createAccountForNewOwner shapes closely
//     enough for a fixture -- this file does not run onAccountCreated
//     hooks), then sets that account's marker columns so `status`
//     derives to the requested value. Idempotent -- safe to call before
//     every spec run, including a re-run against an account a previous
//     run left in a different fixture status.
//
//   seedMemberOfAccount({ ownerGithubUserId, memberGithubUserId, memberEmail, memberLogin })
//     Adds a second, plain-member user to the SAME account
//     ownerGithubUserId owns, pre-seeded so that user's own first sign-in
//     through /api/auth/test/callback (packages/core/src/auth/identity.ts's
//     signUpOrSignIn: "a returning identity signs in against their first
//     existing membership instead of minting a second account") lands in
//     the shared account as a member, not as the owner of a new one.

import pg from "pg";

const { Pool } = pg;

/** @typedef {"active"|"past_due"|"paused"|"model_key_broken"|"unsubscribed"|"cancelled"} SeedStatus */

function pool(databaseUrl) {
  const connectionString = databaseUrl ?? process.env.DATABASE_URL_PLATFORM_OPS;
  if (!connectionString) {
    throw new Error(
      "seed-account-status.mjs: DATABASE_URL_PLATFORM_OPS must be set (same env the real apps/web server reads)",
    );
  }
  return new Pool({ connectionString });
}

/**
 * Finds (or creates) the users row for githubUserId, and the account it
 * owns (its FIRST membership, if any already exists -- matching
 * signUpOrSignIn's own "returning identity" rule). Returns
 * { userId, accountId, created }.
 */
async function ensureOwnerAccount(client, { githubUserId, email, login, name = null }) {
  const existingUser = await client.query(
    "SELECT id FROM users WHERE github_user_id = $1",
    [githubUserId],
  );
  let userId = existingUser.rows[0]?.id;
  if (!userId) {
    const inserted = await client.query(
      `INSERT INTO users (github_user_id, email, name, github_login)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET github_user_id = EXCLUDED.github_user_id
       RETURNING id`,
      [githubUserId, email, name, login],
    );
    userId = inserted.rows[0].id;
  } else {
    await client.query("UPDATE users SET github_login = $1 WHERE id = $2", [login, userId]);
  }

  const existingMembership = await client.query(
    "SELECT account_id FROM account_members WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1",
    [userId],
  );
  let accountId = existingMembership.rows[0]?.account_id;
  if (!accountId) {
    const inserted = await client.query(
      `INSERT INTO accounts (plan) VALUES ('starter') RETURNING id`,
    );
    accountId = inserted.rows[0].id;
    await client.query(
      `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [accountId, userId],
    );
  }
  return { userId, accountId };
}

/**
 * Sets the marker columns that make `accounts.status` derive to `status`
 * (migration 0606's compute_account_status/accounts_derive_status).
 * Clears every marker first, so re-running this against an account a
 * PRIOR run left in a different fixture status always starts clean.
 */
async function applyStatusMarkers(client, accountId, status) {
  const stripeCustomerId = status === "unsubscribed" ? null : `cus_e2e_${accountId}`;
  const now = () => new Date();
  const pastDueSince =
    status === "past_due" ? now() : status === "cancelled" ? new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) : null;
  const ownerPausedAt = status === "paused" ? now() : null;
  const keyBrokenAt = status === "model_key_broken" ? now() : null;

  await client.query(
    `UPDATE accounts
        SET stripe_customer_id = $2,
            past_due_since = $3,
            owner_paused_at = $4,
            partner_suspended_at = NULL,
            platform_hold_at = NULL,
            platform_hold_reason = NULL,
            key_broken_at = $5,
            updated_at = now()
      WHERE id = $1`,
    [accountId, stripeCustomerId, pastDueSince, ownerPausedAt, keyBrokenAt],
  );
}

/**
 * @param {{ githubUserId: number, email?: string, login?: string, status: SeedStatus, databaseUrl?: string }} opts
 * @returns {Promise<{ userId: string, accountId: string }>}
 */
export async function seedAccountStatus({ githubUserId, email, login, status, databaseUrl }) {
  const p = pool(databaseUrl);
  try {
    const client = await p.connect();
    try {
      await client.query("BEGIN");
      const { userId, accountId } = await ensureOwnerAccount(client, {
        githubUserId,
        email: email ?? `e2e-${githubUserId}@example.test`,
        login: login ?? `e2e-user-${githubUserId}`,
      });
      await applyStatusMarkers(client, accountId, status);
      await client.query("COMMIT");
      return { userId, accountId };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await p.end();
  }
}

/**
 * @param {{ ownerGithubUserId: number, memberGithubUserId: number, memberEmail?: string, memberLogin?: string, databaseUrl?: string }} opts
 */
export async function seedMemberOfAccount({
  ownerGithubUserId,
  memberGithubUserId,
  memberEmail,
  memberLogin,
  databaseUrl,
}) {
  const p = pool(databaseUrl);
  try {
    const client = await p.connect();
    try {
      await client.query("BEGIN");
      const ownerRow = await client.query("SELECT id FROM users WHERE github_user_id = $1", [ownerGithubUserId]);
      const ownerUserId = ownerRow.rows[0]?.id;
      if (!ownerUserId) {
        throw new Error(
          `seedMemberOfAccount: no owner user for githubUserId=${ownerGithubUserId} -- call seedAccountStatus for the owner first`,
        );
      }
      const membershipRow = await client.query(
        "SELECT account_id FROM account_members WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1",
        [ownerUserId],
      );
      const accountId = membershipRow.rows[0]?.account_id;
      if (!accountId) {
        throw new Error(`seedMemberOfAccount: owner user ${ownerUserId} has no account membership`);
      }

      const existingMemberUser = await client.query("SELECT id FROM users WHERE github_user_id = $1", [
        memberGithubUserId,
      ]);
      let memberUserId = existingMemberUser.rows[0]?.id;
      const email = memberEmail ?? `e2e-${memberGithubUserId}@example.test`;
      const login = memberLogin ?? `e2e-user-${memberGithubUserId}`;
      if (!memberUserId) {
        const inserted = await client.query(
          `INSERT INTO users (github_user_id, email, name, github_login)
           VALUES ($1, $2, NULL, $3)
           ON CONFLICT (email) DO UPDATE SET github_user_id = EXCLUDED.github_user_id
           RETURNING id`,
          [memberGithubUserId, email, login],
        );
        memberUserId = inserted.rows[0].id;
      } else {
        await client.query("UPDATE users SET github_login = $1 WHERE id = $2", [login, memberUserId]);
      }

      await client.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT (account_id, user_id) DO NOTHING`,
        [accountId, memberUserId],
      );
      await client.query("COMMIT");
      return { userId: memberUserId, accountId };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await p.end();
  }
}
