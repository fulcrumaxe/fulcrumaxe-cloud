/**
 * Thrown when a session asks for a row that exists but belongs to a
 * different account, or doesn't exist at all. Route handlers must map
 * this to HTTP 404, never 403 -- a 403 confirms the row exists, which is
 * exactly the existence-leak CWE-639 test (H06 pass/fail item 3) checks
 * for. RLS already makes "belongs to another account" and "doesn't
 * exist" indistinguishable at the SQL level (a filtered-out row and a
 * missing row both come back as zero rows), so this one error type is
 * the correct, and only honest, thing to throw for both.
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Thrown when an authenticated, tenant-scoped caller is missing the role
 * required for the action (sec-criteria A7: role authorization is the
 * application's job). Route handlers must map this to HTTP 403 -- unlike
 * NotFoundError, the resource's existence is not in question here, only
 * the caller's permission to act on it.
 *
 * D#64: for account_members and invitations, the database now enforces
 * the same role rules as a floor (migrations/0005_account_members_role_gate.sql)
 * -- a raw SQL statement that bypasses this application layer entirely is
 * refused by RLS instead. This error type is still how the application
 * layer itself reports the same class of refusal to a route handler.
 */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Criterion 6: "Minting a token needs an active account." Thrown by tokens/service.ts's insertApiToken; mapError maps this to HTTP 409 account_not_active (H05's own DenyReason code, reused). */
export class AccountNotActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountNotActiveError';
  }
}
