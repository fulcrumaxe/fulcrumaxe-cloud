-- D#97 (D#76 correction C3): audit_write/audit_write_system hardening
-- follow-ups from PR #91's security review
-- (https://github.com/fulcrumaxe/cloud/pull/91#issuecomment-5733870280),
-- per the per-file privilege bracket D#81/#92 established in
-- docs/ops/hosted-postgres.md.
--
-- Both functions are replaced via CREATE OR REPLACE, same signatures,
-- owner (platform_ops), SECURITY DEFINER and pinned search_path as
-- 0011_audit_write_role_settings_actions.sql (audit_write) and
-- 0008_audit_log_append_only.sql (audit_write_system). audit_write's
-- action allowlist is carried forward verbatim from 0011 -- no action
-- added or removed.
--
-- Should-fix 2 (CWE-345): `now()` is the start time of the ENCLOSING
-- TRANSACTION, not the moment the INSERT actually runs -- a caller that
-- holds a transaction open across a slow client-side gap gets a
-- created_at stamped well before the row is actually written.
-- `clock_timestamp()` is the real wall-clock time the statement runs, and
-- is used here for both the `created_at` column and (when present) the
-- payload's own `created_at` key.
--
-- Note (a)/(existing) (CWE-345): the payload's `actor` key was already
-- overwritten with the stamped actor (0008/D#76 decision c). `account_id`
-- and `created_at`, when present as top-level payload keys, are now
-- overwritten the same way -- cheap, and the same forgery class D#76
-- already closed for `actor`. Every OTHER payload key, including nested
-- ones, is stored exactly as sent; this migration does not attempt to
-- sanitize the whole payload.
--
-- Note (b) (CWE-20): `p_source`/`p_action` (audit_write_system) and
-- `p_action` (audit_write) fail closed on NULL. Previously a NULL
-- `p_source` passed the `!~` regex check silently (NULL !~ pattern is
-- NULL, not TRUE, so the RAISE never fired), landing `actor =
-- 'system:' || NULL = NULL`. A NULL `p_action` passed the same way
-- through `NOT (p_action = ANY(...))`, landing a NULL action in
-- audit_log. Both now raise 22023 explicitly on IS NULL, checked before
-- the existing pattern/allowlist test.
--
-- Note (c) (CWE-770): a `pg_column_size(p_payload)` cap of 65536 bytes
-- (64 KiB), raising 22023, bounds how large a single audit_log payload
-- can be. This is a size check on the (unstamped) caller-supplied
-- payload's serialized JSONB size -- the stamped key overwrites above
-- can only shrink or leave payload size unchanged, never grow it past
-- what the caller already sent, so checking before the overwrite and
-- checking after are equivalent here.
--
-- D#97 fix round 1 (CWE-770): `pg_column_size` alone measures the
-- on-disk STORED size of the datum, not its real (detoasted) size. A
-- jsonb value that arrives already TOAST-compressed -- read out of a
-- table column, rather than passed as an ordinary bind parameter --
-- passes this check at its COMPRESSED size, so a multi-megabyte payload
-- that happens to compress well can sail past the 64 KiB cap entirely
-- (reproduced live: a 5,000,009-byte payload compressing to 57,257
-- bytes was accepted). The fix adds `pg_column_compression(p_payload)
-- IS NOT NULL` as an unconditional, size-independent rejection: ANY
-- compressed argument is refused, not just an over-cap one. A normal
-- caller always passes a literal bind parameter, which Postgres never
-- compresses on the way in (compression is a storage-time decision made
-- when a value is written to a table's own TOASTed column) -- so this
-- has no effect on legitimate traffic, only on a payload that arrived
-- via a table read. `pg_column_size` is kept for the ordinary,
-- uncompressed case (including multibyte text and nested objects/
-- arrays, which it already measured correctly before this fix and
-- still does -- this change only ADDS a condition, it does not touch
-- how the existing size check works).
--
-- A concatenated or interpolated payload key name cannot be forged this
-- way (JSONB keys are always literal strings at the SQL level, not
-- computed), so there is no analogous "can't be caught statically" caveat
-- here -- that caveat belongs to audit-log-guard.test.ts's static source
-- scan instead (see that file for the identifier-scan rewrite this
-- Discussion also asks for).
--
-- Per-file bracket (D#81/#92, docs/ops/hosted-postgres.md): on a database
-- migrated past 0200_partners.sql, the migration role's platform_ops
-- membership is already back to INHERIT FALSE by the time this file runs
-- -- CREATE OR REPLACE FUNCTION on an existing platform_ops-owned
-- function needs INHERIT (has_privs_of_role), not CREATE on the schema
-- (no ownership transfer happens here; both functions already belong to
-- platform_ops). Statement form copied verbatim from
-- 0011_audit_write_role_settings_actions.sql, the migration that
-- established this exact bracket for a CREATE OR REPLACE on audit_write
-- itself. This file never switches the session's active role, and never
-- grants platform_ops CREATE on schema public.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION audit_write(p_action text, p_payload jsonb DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct            uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  who             uuid := current_member_user_id();
  ts              timestamptz := clock_timestamp();
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

  -- Same allowlist as 0011, carried forward verbatim. NULL now fails
  -- closed explicitly (note (b) above) instead of relying on
  -- `NOT (p_action = ANY(...))` evaluating to NULL (falsy for IF) on a
  -- NULL p_action.
  IF p_action IS NULL OR NOT (p_action = ANY (ARRAY[
    'decision_dial_changed',
    'model_connection.connect',
    'model_connection.replace',
    'model_connection.remove',
    'role_settings.mode_changed',
    'role_settings.guard_changed'
  ])) THEN
    RAISE EXCEPTION 'audit_write: action % is not on the allowlist', p_action
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Note (c) above: bounds a single payload's serialized size, and
  -- (D#97 fix round 1) fails closed on any TOAST-compressed argument
  -- regardless of its compressed size.
  IF p_payload IS NOT NULL AND (
    pg_column_compression(p_payload) IS NOT NULL OR pg_column_size(p_payload) > 65536
  ) THEN
    RAISE EXCEPTION 'audit_write: payload exceeds 65536 bytes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Decision (c)/note (a): a caller-supplied `actor`, `account_id` or
  -- `created_at` key inside the payload is overwritten with the stamped
  -- value, never trusted. Every other key (including nested ones) is
  -- stored exactly as sent.
  IF stamped_payload ? 'actor' THEN
    stamped_payload := stamped_payload || jsonb_build_object('actor', to_jsonb(who::text));
  END IF;
  IF stamped_payload ? 'account_id' THEN
    stamped_payload := stamped_payload || jsonb_build_object('account_id', to_jsonb(acct::text));
  END IF;
  IF stamped_payload ? 'created_at' THEN
    stamped_payload := stamped_payload || jsonb_build_object('created_at', to_jsonb(ts));
  END IF;

  INSERT INTO audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, who::text, p_action, stamped_payload, ts)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- Decision 4: CREATE OR REPLACE preserves the existing owner and grants
-- on an unchanged signature -- no owner-reassigning ALTER FUNCTION is
-- needed or wanted. These are re-run anyway because they are idempotent,
-- matching 0011's own pattern.
REVOKE ALL ON FUNCTION audit_write(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO app_user;

CREATE OR REPLACE FUNCTION audit_write_system(
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
  ts              timestamptz := clock_timestamp();
  stamped_payload jsonb := p_payload;
  new_id          uuid;
BEGIN
  -- Note (b) above: NULL now fails closed explicitly instead of passing
  -- silently through `p_source !~ pattern` (NULL for a NULL p_source,
  -- which IF treats as false) and landing actor = 'system:' || NULL = NULL.
  IF p_source IS NULL OR p_source !~ '^[a-z][a-z0-9_]{0,31}$' THEN
    RAISE EXCEPTION 'audit_write_system: source % is not a lowercase identifier', p_source
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_action IS NULL OR p_action = '' THEN
    RAISE EXCEPTION 'audit_write_system: action must not be blank'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write_system: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Note (c) above: same 64 KiB cap as audit_write, including the
  -- D#97 fix round 1 compressed-argument check.
  IF p_payload IS NOT NULL AND (
    pg_column_compression(p_payload) IS NOT NULL OR pg_column_size(p_payload) > 65536
  ) THEN
    RAISE EXCEPTION 'audit_write_system: payload exceeds 65536 bytes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF stamped_payload ? 'actor' THEN
    stamped_payload := stamped_payload || jsonb_build_object('actor', to_jsonb('system:' || p_source));
  END IF;
  IF stamped_payload ? 'account_id' THEN
    stamped_payload := stamped_payload || jsonb_build_object('account_id', to_jsonb(p_account_id::text));
  END IF;
  IF stamped_payload ? 'created_at' THEN
    stamped_payload := stamped_payload || jsonb_build_object('created_at', to_jsonb(ts));
  END IF;

  INSERT INTO audit_log (account_id, actor, action, payload, created_at)
  VALUES (p_account_id, 'system:' || p_source, p_action, stamped_payload, ts)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION audit_write_system(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write_system(uuid, text, text, jsonb) TO platform_ops;

-- Close the window opened above, matching 0011's own downgrade shape.
-- SET stays TRUE (still needed elsewhere in the chain / by later
-- migrations with the same bracket).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
