-- D#2605 H05: security review needs-fix round 3, widened in round 5.
--
-- Three fixes, none of which touch a table-wide GRANT:
--
-- 1. model_connections: app_user's GRANT is table-wide on both INSERT and
--    UPDATE (every column, per migrations/0001_core.sql), and RLS only
--    constrains account_id -- it says nothing about status/
--    last_validated_at/last_error_code. A tenant could therefore INSERT a
--    row with status = 'ok' directly, self-attesting a key as validated
--    without ever going through real provider validation -- and
--    reserve()'s own preview-purpose gate (packages/spend/src/reserve.ts)
--    trusts exactly that column: `SELECT 1 FROM model_connections WHERE
--    account_id = $1 AND status = 'ok'`. A column-level GRANT INSERT
--    carve-out (granting INSERT on everything except status/
--    last_validated_at/last_error_code) was considered and rejected: it
--    is one more grant to keep in sync with the column list by hand, and
--    unlike a trigger it is silently defeated the moment a future
--    migration widens the grant back to table-wide for an unrelated
--    reason. A BEFORE INSERT OR UPDATE trigger enforces the same rule at
--    the row level regardless of what the INSERT/UPDATE grants allow, and
--    fails loudly (an actual error) rather than silently discarding the
--    tenant's values, so misuse is visible immediately rather than masked.
--
--    Round-4 security review, finding 1 (error): the round-3 version of
--    this trigger was BEFORE INSERT only. app_user also holds a
--    table-wide UPDATE on this table (0001_core.sql), so the same
--    self-attestation was reachable two other ways: an INSERT immediately
--    followed by `UPDATE model_connections SET status = 'ok', ...`, and a
--    single `INSERT ... ON CONFLICT (id) DO UPDATE SET status = 'ok'`.
--    Both landed a tenant-controlled row with status = 'ok' past the same
--    reserve() gate the INSERT-only version closed. The round-3 header
--    deferred UPDATE to H21 ("Widening this trigger to UPDATE belongs to
--    that task, not this one"), citing the round-7/round-8 grants-audit
--    comment in 0001_core.sql. The Team Lead decision on the round-4
--    finding is to fix it here instead: this migration is what introduces
--    the trust reserve() places in this column, so leaving UPDATE open
--    would ship that trust with a known hole in the same PR. The
--    0001_core.sql grants-audit comment (line ~163) still stands for the
--    grant itself -- app_user keeps table-wide UPDATE/DELETE, H21 still
--    owns confirming or tightening those grants for its own revalidation
--    flow -- only the trigger's scope changed, not the GRANT.
--
--    The guard is now BEFORE INSERT OR UPDATE. On INSERT, a guarded
--    caller may not set status away from its 'unvalidated' default, or
--    set last_validated_at/last_error_code at all. On UPDATE, a guarded
--    caller may not change status, last_validated_at or last_error_code
--    from their prior values -- every other column (including
--    key_ciphertext/key_nonce/wrapped_dek/kek_version/key_fingerprint,
--    which a tenant legitimately rotates) is untouched by this trigger.
--    A real validation result has to land somewhere, so a narrow,
--    column-level UPDATE grant on just those three columns goes to
--    platform_ops (the existing privileged role from 0001_core.sql,
--    already used for every other platform-only write in this schema),
--    together with the RLS SELECT/UPDATE policies platform_ops needs to
--    reach the row at all (FORCE ROW LEVEL SECURITY means no policy, no
--    access, regardless of GRANT). H21's revalidation flow builds on this
--    same platform_ops path rather than on a tenant-writable column.
--
--    Round-4 security review, finding 2 (warning): the round-3 guard
--    scoped itself with `CURRENT_USER = 'app_user'`, an allow-list of
--    exactly one role name. A login role that merely inherits app_user's
--    grants without literally being named app_user -- e.g. `CREATE ROLE
--    tenant_svc LOGIN IN ROLE app_user`, a realistic shape for a
--    per-service or per-environment credential -- has CURRENT_USER =
--    'tenant_svc' and sailed straight through the guard while still
--    carrying every one of app_user's table grants and still being bound
--    by the `TO app_user` RLS policy. The fix is deny-by-default:
--    `IF NOT pg_has_role(current_user, 'platform_ops', 'USAGE')` guards
--    the write for every role except one that is actually usably a member
--    of platform_ops, rather than allow-listing app_user by name. This is
--    the same form PR #13's reviewer verified for an equivalent guard, so
--    both PRs use identical logic. `pg_has_role(..., 'USAGE')` checks
--    real, inheritable membership (or the role itself), not merely
--    CURRENT_USER text equality, and Postgres superusers automatically
--    satisfy any `pg_has_role` check regardless of explicit membership,
--    which is why this repo's own admin/migration connections (superuser)
--    are unaffected by this guard without needing their own carve-out.
--
-- 2. `usd`-denominated columns admit NaN and Infinity. Postgres's numeric
--    type has three IEEE-754-style special values (NaN always, 'Infinity'
--    and '-Infinity' since PG14) that are exempt from ordinary comparison
--    semantics: NaN sorts ABOVE every finite value (so `usd >= 0` is TRUE
--    for NaN) and `NaN = NaN` evaluates TRUE (so the previously-suggested
--    `AND usd = usd` does NOT reject it -- NaN passes that test too).
--    `usd::text !~ '[A-Za-z]'` rejects all three special values directly
--    by their literal spelling ('NaN', 'Infinity', '-Infinity' are the
--    only text forms numeric's output ever contains a letter in --
--    ordinary numeric output is only digits, an optional leading '-', and
--    an optional '.', never scientific notation) without needing an
--    arbitrary magnitude cap that could someday reject a legitimate
--    large-but-finite value. Round-4 security review verified this form
--    directly against Postgres 18.6 (numeric_out never emits scientific
--    notation, lc_numeric/extra_float_digits don't change it, and NaN/
--    Infinity/-Infinity are the only letter-bearing outputs) and asked
--    that it be kept as-is.
--
--    Applied to both ledger.usd (the literal column the finding named)
--    and spend_reservations.usd_reserved: reserve() (packages/spend/src/
--    reserve.ts) writes a caller-supplied JS number straight into
--    usd_reserved as a query parameter, and node-postgres serializes a JS
--    NaN as the literal text 'NaN' -- so the same injection is reachable
--    through reserve()'s estimateModelUsd/estimateComputeUsd, one layer
--    up from the ledger write settle() does. A NaN in usd_reserved would
--    also poison every SUM(usd_reserved) aggregate reserve()'s own cap
--    checks depend on (monthToDateUsd, workItemCommittedUsd in
--    reserve.ts), corrupting every subsequent cap decision for that
--    account+budget. Leaving usd_reserved unprotected would leave an
--    equivalent hole one call site earlier than the one named, so both
--    get the same constraint.
--
-- 3. spend_reservations.purpose: H05 pass/fail 5's preview exception
--    (reserve.ts) decides its accounts.status gate from `purpose`, but no
--    prior round of this migration ever persisted it -- it was read from
--    ReserveParams and then simply forgotten past the function's return.
--    Persisting it is a prerequisite for making it immutable at all (a
--    field that was never a column cannot appear on any trigger's
--    immutability list), so this migration adds the column, backs it with
--    the same NOT NULL DEFAULT 'model'-style default 0002 used for
--    `budget` (existing test fixtures that INSERT into spend_reservations
--    without knowing about `purpose` keep working unchanged), and folds
--    it into a new BEFORE UPDATE immutability trigger alongside every
--    other column a tenant UPDATE must never be able to move: id, run_id,
--    usd_reserved, budget, purpose and created_at. Only `state`
--    (governed by 0002's own transition trigger) and `updated_at` may
--    change after insert. settle()/release() (packages/spend/src/
--    settle.ts) only ever `UPDATE spend_reservations SET state = ...`,
--    so neither is affected by this trigger.
--
--    Round-4 security review, informational note: `id` was not on the
--    immutable list. Nothing in this schema has a foreign key onto
--    spend_reservations.id today, and settle()/release() key on
--    (account_id, run_id, budget) rather than id, so a tenant moving it
--    had no reachable impact when this was written -- but a mutable
--    primary key is a footgun for whatever the next caller keys on, and
--    the fix costs nothing (no application code sets id after insert
--    either way), so it is added here rather than left as a known gap.
--
--    account_id is deliberately NOT on this trigger's list:
--    0001_core.sql's own RLS `WITH CHECK` on spend_reservations already
--    requires account_id to equal the session's current tenant on every
--    UPDATE, which already makes a cross-tenant re-parent impossible for
--    app_user (the only role with any grant on this table) -- proved by
--    packages/db/test/rls-isolation.test.ts's existing "UPDATE ...
--    re-parenting a tenant A row to account_id = tenant B is rejected"
--    case. A BEFORE ROW trigger runs before WITH CHECK is evaluated, so
--    adding account_id here too would only change THAT test's expected
--    SQLSTATE (from RLS's 42501 to this trigger's 23514) without closing
--    any gap RLS was not already closing.

CREATE FUNCTION model_connections_guard_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Deny by default (round-4 finding 2): guard everyone except a role
  -- that is actually, usably a member of platform_ops, checked by real
  -- membership rather than by CURRENT_USER text equality to one
  -- allow-listed name. A superuser (this repo's admin/migration
  -- connections) satisfies pg_has_role() for any role unconditionally,
  -- so this needs no separate carve-out for them.
  IF pg_has_role(current_user, 'platform_ops', 'USAGE') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'unvalidated'
       OR NEW.last_validated_at IS NOT NULL
       OR NEW.last_error_code IS NOT NULL
    THEN
      RAISE EXCEPTION
        'model_connections: only platform_ops may set status/last_validated_at/last_error_code -- new connections always start unvalidated'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Round-4 finding 1: guards the UPDATE path too, including the
    -- ON CONFLICT (...) DO UPDATE upsert form, which fires this same
    -- BEFORE UPDATE trigger for the row it ends up writing.
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.last_validated_at IS DISTINCT FROM OLD.last_validated_at
       OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code
    THEN
      RAISE EXCEPTION
        'model_connections: only platform_ops may change status/last_validated_at/last_error_code -- a tenant cannot self-attest a key as validated'
        USING ERRCODE = 'check_violation';
    END IF;

    -- Round-5 finding 2 (warning, fix now): the check above only rejects
    -- an EXPLICIT change to status/last_validated_at/last_error_code --
    -- it does nothing when a non-platform_ops caller instead rotates the
    -- key material or provider while leaving those three columns as
    -- submitted (typically still 'ok'). Without this, a validated row
    -- keeps attesting a key that was never validated, which
    -- reserve()'s own preview-purpose gate (packages/spend/src/
    -- reserve.ts) trusts directly: `SELECT 1 FROM model_connections
    -- WHERE account_id = $1 AND status = 'ok'`. Force the reset in the
    -- same BEFORE UPDATE trigger rather than relying on a caller to
    -- remember it: any key-material or provider change from a
    -- non-platform_ops caller always drops the row back to unvalidated
    -- and clears last_validated_at/last_error_code, regardless of what
    -- status the caller submitted.
    IF NEW.key_ciphertext IS DISTINCT FROM OLD.key_ciphertext
       OR NEW.key_nonce IS DISTINCT FROM OLD.key_nonce
       OR NEW.wrapped_dek IS DISTINCT FROM OLD.wrapped_dek
       OR NEW.kek_version IS DISTINCT FROM OLD.kek_version
       OR NEW.key_fingerprint IS DISTINCT FROM OLD.key_fingerprint
       OR NEW.provider IS DISTINCT FROM OLD.provider
    THEN
      NEW.status := 'unvalidated';
      NEW.last_validated_at := NULL;
      NEW.last_error_code := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER model_connections_guard_write
  BEFORE INSERT OR UPDATE ON model_connections
  FOR EACH ROW
  EXECUTE FUNCTION model_connections_guard_write();

-- The privileged validation path (round-4 finding 1, narrowed further by
-- round-5 finding 1): platform_ops needs to reach the row (FORCE ROW
-- LEVEL SECURITY denies all access with no matching policy, independent
-- of any GRANT) and needs write access to exactly the three
-- validation-result columns, nothing else -- it must never gain the
-- ability to touch key material, provider, or account_id through this
-- path. Two policies rather than one FOR ALL: an UPDATE policy alone is
-- not sufficient for platform_ops to locate the target row (UPDATE
-- requires the same row to also be visible under a SELECT policy), and a
-- SELECT grant is required for the same reason at the GRANT level below.
--
-- The SELECT policy's USING (true) is intentionally row-wide: validation
-- is platform-wide, so platform_ops must be able to locate ANY tenant's
-- row, not just one account_id. That row-wide visibility is safe only
-- because the SELECT GRANT below is column-scoped -- RLS controls which
-- ROWS a role can see, not which COLUMNS, so it is the GRANT, not the
-- policy, that keeps key material out of reach. Round-5 security review
-- (finding 1, error) caught an earlier version of this migration granting
-- SELECT on the whole table: with FORCE ROW LEVEL SECURITY and a
-- USING (true) read policy, that gave platform_ops (and any role merely
-- IN ROLE platform_ops) direct SELECT access to key_ciphertext,
-- key_nonce, wrapped_dek, kek_version and key_fingerprint for every
-- tenant -- access it never had before this migration and never needed:
-- the validation UPDATE below only reads/writes id, account_id, provider,
-- status, last_validated_at and last_error_code (via its WHERE clause and
-- RETURNING), never the key columns. The grant is scoped to exactly those
-- six columns; SELECT of any key-material column, or of `*`, now fails
-- with 42501 (insufficient_privilege) -- see the round-5 fix regression
-- tests in packages/spend/test/security-fixes.test.ts.
CREATE POLICY platform_ops_validation_read ON model_connections
  FOR SELECT TO platform_ops
  USING (true);

CREATE POLICY platform_ops_validation_write ON model_connections
  FOR UPDATE TO platform_ops
  USING (true)
  WITH CHECK (true);

GRANT SELECT (id, account_id, provider, status, last_validated_at, last_error_code)
  ON model_connections TO platform_ops;
GRANT UPDATE (status, last_validated_at, last_error_code) ON model_connections TO platform_ops;

ALTER TABLE ledger
  ADD CONSTRAINT ledger_usd_finite_check
    CHECK (usd >= 0 AND usd::text !~ '[A-Za-z]');

ALTER TABLE spend_reservations
  ADD CONSTRAINT spend_reservations_usd_reserved_finite_check
    CHECK (usd_reserved >= 0 AND usd_reserved::text !~ '[A-Za-z]');

ALTER TABLE spend_reservations
  ADD COLUMN purpose text NOT NULL DEFAULT 'run'
    CHECK (purpose IN ('run', 'preview'));

CREATE FUNCTION spend_reservations_check_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- account_id is deliberately not checked here -- RLS's own WITH CHECK
  -- already makes a cross-tenant re-parent impossible; see this
  -- migration's file header for why duplicating that here would be
  -- actively wrong, not just redundant.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.usd_reserved IS DISTINCT FROM OLD.usd_reserved
     OR NEW.budget IS DISTINCT FROM OLD.budget
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'spend_reservations: id/run_id/usd_reserved/budget/purpose/created_at are immutable after insert'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Fires for every UPDATE, for every role -- same rationale as 0002's
-- spend_reservations_state_transition: app_user already has an ordinary
-- UPDATE grant on this table (H02), so nothing but a trigger stops a
-- direct SQL UPDATE from moving a column no application code path ever
-- touches.
CREATE TRIGGER spend_reservations_immutable_columns
  BEFORE UPDATE ON spend_reservations
  FOR EACH ROW
  EXECUTE FUNCTION spend_reservations_check_immutable();
