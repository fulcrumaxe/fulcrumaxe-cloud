-- D#76: audit_log becomes append-only and unforgeable from app_user.
--
-- 1. THE HOLE (CWE-345, OWASP A08). 0001_core.sql granted app_user
--    SELECT, INSERT on audit_log, and tenant_isolation's WITH CHECK only
--    verified account_id + account_is_active -- actor, action, payload and
--    created_at were all caller-chosen. That has bitten twice live: the
--    #54 security review (finding 4) let a member insert a
--    decision_dial_changed row naming the owner as actor, with made-up
--    previous/new values; the #53 security re-review let a member insert
--    a fake invoice.paid row that took a past_due account back to active,
--    bypassing payment. #53 stopped reading audit_log for that decision,
--    but the root cause -- app_user can write ANY column of audit_log --
--    stayed open until this migration.
-- 2. WRITERS ON MAIN, as of this PR's base (main after #75, #55 and #53):
--      - packages/db/src/decisions.ts's writeDialSetting(), as app_user,
--        action 'decision_dial_changed'.
--      - packages/model-connection/src/connect.ts, as app_user, actions
--        'model_connection.connect' and 'model_connection.replace'.
--      - packages/model-connection/src/remove.ts, as app_user, action
--        'model_connection.remove'.
--      - partner_suspend_account() (0200_partners.sql), a SECURITY DEFINER
--        function owned by platform_ops with its own SQL-verified actor --
--        see decision (d) below.
--      - packages/billing/src/idempotency.ts (#53), as platform_ops (via
--        withPlatformOps -- never app_user), both reads and writes
--        audit_log directly as its Stripe-webhook dedupe ledger. It is
--        the ONE file on audit-log-guard.test.ts's ALLOWLIST, and is NOT
--        converted to audit_write()/audit_write_system() in this PR --
--        D#69 owns moving that ledger to its own platform_ops-only table
--        instead. platform_ops keeps its own audit_log INSERT grant
--        regardless (0200_partners.sql), so nothing here needs to change
--        for it to keep working.
-- 3. audit_log IS EVIDENCE, NEVER STATE: no code path may read audit_log
--    to decide behaviour. audit-log-guard.test.ts enforces this with a
--    static scan of packages/*/src and apps/*, failing the build on any
--    production FROM/JOIN/INTO/UPDATE of audit_log outside its allowlist.
-- 4. DECISIONS:
--    (b) The action vocabulary is an allowlist, a literal array inside
--        audit_write. A later migration adding an action re-CREATEs the
--        function with a longer array -- explicit, testable and small,
--        with only four app_user actions today.
--    (c) A payload `actor` key cannot be forged: if the caller's payload
--        carries a top-level `actor` key, audit_write/audit_write_system
--        overwrite it with the stamped actor before insert.
--    (d) partner_suspend_account() is NOT converted -- it keeps its
--        direct, platform_ops-owned SECURITY DEFINER INSERT. Its actor is
--        already verified in SQL (a real owner/admin partner_members row,
--        checked before anything is written), and platform_ops keeps its
--        audit_log INSERT grant regardless (0200_partners.sql) because
--        platform_ops is already full authority.
--    (e) The two existing tests that pinned this bug --
--        ledger-audit-log-privileges.test.ts's raw app_user INSERT, and
--        partners-isolation.test.ts's item-2 audit_log probe -- are
--        inverted/retargeted in this PR, and only those two. Every other
--        existing test passes unchanged.
-- 5. This migration also carries PR #75's own follow-up 1 (CWE-426): it
--    pins account_members_keep_an_owner()'s search_path, the one
--    SECURITY-relevant trigger function 0005 left unpinned (it is
--    deliberately INVOKER rights, so it never had SECURITY DEFINER's own
--    forced search_path in the first place).

-- ---------------------------------------------------------------------
-- 1. app_user loses INSERT on audit_log outright. It keeps SELECT under
--    the existing tenant_isolation policy; it never had UPDATE or DELETE.
REVOKE INSERT ON audit_log FROM app_user;

-- ---------------------------------------------------------------------
-- 2. audit_write(action, payload): the ONLY way app_user can produce an
--    audit_log row from here on. SECURITY DEFINER, owned by platform_ops
--    (which already holds INSERT + platform_ops_insert_access on
--    audit_log from 0200_partners.sql -- no new grant needed there), with
--    a pinned search_path so it never trusts the caller's.
--
--    who := current_member_user_id() (0005) is itself SECURITY DEFINER
--    and reads the session GUCs app.account_id/app.user_id directly --
--    those are session state, not role state, so it still sees the
--    CALLER's identity even though audit_write itself runs as
--    platform_ops.
--
-- D#81 fix round (security review, per-file bracket rule --
-- docs/ops/hosted-postgres.md): both `ALTER FUNCTION ... OWNER TO
-- platform_ops` statements below (audit_write, audit_write_system) need
-- platform_ops to hold CREATE on schema public at the moment each runs --
-- not guaranteed on an already-migrated database, where filename order is
-- not applied order. Self-bracketed: grant here, both transfers below,
-- revoke once done.
GRANT CREATE ON SCHEMA public TO platform_ops;

CREATE FUNCTION audit_write(p_action text, p_payload jsonb DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct            uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  who             uuid := current_member_user_id();
  stamped_payload jsonb := p_payload;
  new_id          uuid;
BEGIN
  IF acct IS NULL THEN
    RAISE EXCEPTION 'audit_write: no app.account_id set'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF who IS NULL THEN
    RAISE EXCEPTION 'audit_write: caller is not a verified member of account %', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'audit_write: account % is not active', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Decision (b): an explicit allowlist, one entry per app_user writer
  -- present at this PR's base (see analysis item 2 above).
  IF NOT (p_action = ANY (ARRAY[
    'decision_dial_changed',
    'model_connection.connect',
    'model_connection.replace',
    'model_connection.remove'
  ])) THEN
    RAISE EXCEPTION 'audit_write: action % is not on the allowlist', p_action
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Decision (c): a caller-supplied `actor` key inside the payload is
  -- overwritten with the stamped actor, never trusted.
  IF stamped_payload ? 'actor' THEN
    stamped_payload := stamped_payload || jsonb_build_object('actor', to_jsonb(who::text));
  END IF;

  INSERT INTO audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, who::text, p_action, stamped_payload, now())
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;
REVOKE ALL ON FUNCTION audit_write(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO app_user;
ALTER FUNCTION audit_write(text, jsonb) OWNER TO platform_ops;

-- ---------------------------------------------------------------------
-- 3. audit_write_system(account_id, source, action, payload): the
--    platform_ops/system/webhook entry point the original report asked
--    for. Nothing in THIS PR calls it yet -- it exists so a future
--    webhook handler has a definer function to call instead of writing
--    audit_log directly, the same principle as audit_write above.
CREATE FUNCTION audit_write_system(
  p_account_id uuid,
  p_source     text,
  p_action     text,
  p_payload    jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  stamped_payload jsonb := p_payload;
  new_id          uuid;
BEGIN
  IF p_source !~ '^[a-z][a-z0-9_]{0,31}$' THEN
    RAISE EXCEPTION 'audit_write_system: source % is not a lowercase identifier', p_source
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write_system: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF stamped_payload ? 'actor' THEN
    stamped_payload := stamped_payload || jsonb_build_object('actor', to_jsonb('system:' || p_source));
  END IF;

  INSERT INTO audit_log (account_id, actor, action, payload, created_at)
  VALUES (p_account_id, 'system:' || p_source, p_action, stamped_payload, now())
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;
REVOKE ALL ON FUNCTION audit_write_system(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write_system(uuid, text, text, jsonb) TO platform_ops;
ALTER FUNCTION audit_write_system(uuid, text, text, jsonb) OWNER TO platform_ops;

-- D#81 fix round: close the window this file opened above -- see
-- 0200_partners.sql's own revoke (right after ITS last OWNER TO
-- statement) for the full reasoning.
REVOKE CREATE ON SCHEMA public FROM platform_ops;

-- ---------------------------------------------------------------------
-- 4. PR #75 follow-up 1 (CWE-426): account_members_keep_an_owner() is
--    deliberately INVOKER rights (0005's own header explains why -- it
--    needs current_user to be the ACTUAL executing role), so it never
--    got SECURITY DEFINER's forced search_path. Pinning it here closes
--    the same class of caller-controlled-search_path hole the other
--    definer functions were already immune to.
--
--    Wrapped in a DO block that tolerates the function not existing yet
--    (SQLSTATE 42883/undefined_function): the runner (packages/db/src/
--    migrate.ts) applies files in filename order, so on every REAL
--    install or upgrade 0005 has always already created this function
--    by the time 0008 runs. The only tree shape where that's not true
--    is a test that constructs its OWN partial migration set with 0005
--    filtered out (migrate-0005-upgrade.test.ts, D#64 criterion 13) --
--    there the trigger itself doesn't exist yet either, so there is
--    nothing to pin, and this becomes a harmless no-op rather than an
--    unrelated failure in a test this migration has no business
--    breaking.
DO $$
BEGIN
  ALTER FUNCTION account_members_keep_an_owner() SET search_path = pg_catalog, public, pg_temp;
EXCEPTION WHEN undefined_function THEN
  NULL;
END
$$;
