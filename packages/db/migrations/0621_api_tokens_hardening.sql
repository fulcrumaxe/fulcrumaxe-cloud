-- D#31 API-3f: API token hardening.
--
-- Follow-up to API-3b (#152), stacked on it -- merges after #152.
-- Renumbered from 0617 to 0621: main gained 0618 (#148) and 0619 (#154)
-- while this PR was open, so the merge-monotonic migration-order check
-- requires this file to sort after main's current highest. 0620 is
-- reserved for the in-flight API-3d; 0621 is free as of this renumber.
--
-- Carries the security review's S1/S2/S3/S4/S7 database-hardening
-- findings from #152's fix round, split out because they did not fit
-- under the 2,000-line policy alongside the C13b tripwire/S5/S6 fixes
-- that had to land in #152 itself. S4 was promoted to a MUST by the
-- Team Lead for this PR.
--
-- S4 (MUST): app_user's UPDATE grant on api_tokens is narrowed from the
-- whole row to exactly the two columns the application ever writes
-- (revoked_at, revoked_reason) -- same rule as D#71 C3 criterion 14. A
-- trigger additionally makes revoked_at set-once: once non-null, no
-- UPDATE (from any role bound by RLS, i.e. app_user) can clear it back
-- to NULL, or change it to a different timestamp, or change
-- revoked_reason. Fix round 1 (PR #155 review, M2): the original trigger
-- only rejected non-null -> NULL, so a revoked token's own row (RLS
-- deliberately admits a token acting on itself) could still rewrite
-- revoked_at to a different value or rewrite revoked_reason after the
-- fact. Also rejects revoked_reason being set while revoked_at stays
-- NULL, so a reason can never exist without a revocation.
--
-- S1/S2: tenant_isolation_select/_update's token-principal branch used
-- to fall through the SAME owner/admin/created_by disjuncts a session
-- principal gets, so the handler's own `tokenId !== targetId` check was
-- the only thing standing between a token and a sibling token's row.
-- When app.token_id is set, both policies now admit ONLY
-- `id = app.token_id`, and only when that row's created_by matches
-- current_member_user_id() -- i.e. app.user_id must independently
-- resolve to a LIVE member of app.account_id, not merely be trusted
-- as-is. This closes S1 (RLS itself now blocks a token touching a
-- sibling row, independent of the handler) and S2 (app.token_id is
-- verified against a real row and a verified live creator, not trusted
-- alone) in one policy change, per the security review's own note that
-- S2 "can be subsumed by S1's design."
--
-- S3: audit_write_api_tokens's token branch used to stamp
-- `actor = 'token:' || app.token_id` with no check that app.token_id was
-- even a uuid, let alone a real token of the calling account created by
-- the live caller. It now casts app.token_id to uuid (raising, not
-- silently truncating, on a malformed value) and requires a matching
-- api_tokens row in the SAME account with created_by = the verified live
-- member -- the identical binding S1/S2 now enforce at the RLS layer,
-- applied here too since this function is SECURITY DEFINER and RLS does
-- not apply to it. Fix round 1 (PR #155 review, M3): the caller-supplied
-- `payload->>'token_id'` (the OBJECT the audit row describes, distinct
-- from app.token_id, the ACTOR) went into audit_log completely
-- unverified -- a tenant-A actor could name a tenant-B token as the
-- payload's token_id. When present, it is now cast to uuid (raising on a
-- malformed value) and required to resolve to an api_tokens row of the
-- SAME account, or the call raises and writes no row.
--
-- S7: touch_api_token_last_used had no tenant check at all -- any
-- resolved token could touch any OTHER token's last_used_at by id alone.
-- Its one call site (packages/api/src/tokens/resolve.ts) runs BEFORE any
-- tenant context is established (same pre-auth shape as
-- resolve_api_token itself) -- no app.account_id GUC is set yet at that
-- point, so scoping this by reading that GUC would make the touch a
-- silent permanent no-op for every real caller instead of a security
-- fix. Fix round 1 (PR #155 review, M4/R2): the review's own reproduction
-- showed the original two-argument form (p_token_id, p_account_id) still
-- trusted whatever account id it was handed -- the one real caller
-- happens to pass the right value, but the DEFINER's own guarantee is
-- what matters for a function granted to app_user at large. Re-keyed on
-- the token hash instead (C14b criterion 4's other option): only a
-- holder of the secret that hashes to a stored token_hash can touch that
-- row, with no second, independently-forgeable identifier in the mix.
-- Old overloads (the 1-arg uuid form from 0616, and this fix round's own
-- earlier 2-arg uuid,uuid form) are both dropped, not left callable.
--
-- Per-file bracket (D#81/#92, docs/ops/hosted-postgres.md): CREATE OR
-- REPLACE FUNCTION on an existing platform_ops-owned function (here,
-- audit_write_api_tokens) needs INHERIT (has_privs_of_role), not CREATE
-- on schema public. Statement form copied verbatim from
-- 0612_audit_write_hardening.sql, the migration that established this
-- exact bracket. Fix round 1 (PR #155 review, M1/S-c): this file ALSO
-- creates two BRAND NEW functions (forbid_api_token_unrevoke and the
-- hash-keyed touch_api_token_last_used) and transfers their ownership to
-- platform_ops -- the INHERIT bracket alone does not cover that; the
-- previous header comment's claim that "no ownership transfer happens in
-- this file" was wrong. A second, nested bracket -- copied verbatim from
-- 0616_api_tokens.sql, the migration that established THAT pattern for
-- brand-new platform_ops-owned functions -- now wraps exactly the
-- new-function span, matching what test-neon-shape.sh's non-superuser
-- fx_migrator role actually needs to run this file end to end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

-- S1/S2: token principal sees/touches ONLY its own row, verified against
-- a live member. Session principal branch (app.token_id unset) is
-- unchanged from #152.
-- Inlined as a direct account_members EXISTS check, deliberately NOT a
-- call to 0005's current_member_user_id(): ALTER POLICY's USING clause is
-- parsed and its identifiers resolved immediately (unlike a plpgsql
-- function body, which is opaque text until first invocation), and
-- test/migrate-0005-upgrade.test.ts (D#64 criterion 13) applies every
-- migration file EXCEPT 0005 to prove a database that historically never
-- received 0005 can still safely pick it up later -- a hard DDL-time
-- dependency on a 0005-defined function inside a POLICY would break that
-- guarantee for every migration after this one. The EXISTS below is
-- exactly what current_member_user_id() computes.
ALTER POLICY tenant_isolation_select ON api_tokens
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (
      CASE WHEN NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
        id = NULLIF(current_setting('app.token_id', true), '')::uuid
        AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND EXISTS (
          SELECT 1 FROM account_members m
          WHERE m.account_id = api_tokens.account_id
            AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        )
      ELSE
        created_by = NULLIF(current_setting('app.user_id', true), '')::uuid
        OR EXISTS (
          SELECT 1 FROM account_members m
          WHERE m.account_id = api_tokens.account_id
            AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
            AND m.role IN ('owner', 'admin')
        )
      END
    )
  );

ALTER POLICY tenant_isolation_update ON api_tokens
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (
      CASE WHEN NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
        id = NULLIF(current_setting('app.token_id', true), '')::uuid
        AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND EXISTS (
          SELECT 1 FROM account_members m
          WHERE m.account_id = api_tokens.account_id
            AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        )
      ELSE
        created_by = NULLIF(current_setting('app.user_id', true), '')::uuid
        OR EXISTS (
          SELECT 1 FROM account_members m
          WHERE m.account_id = api_tokens.account_id
            AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
            AND m.role IN ('owner', 'admin')
        )
      END
    )
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- S4: narrow app_user's UPDATE grant from the whole row to exactly the
-- two columns the application writes. scopes, expires_at, token_hash,
-- created_by and account_id are no longer app_user-writable at all --
-- not by RLS content, by the grant system itself, so no future RLS
-- change can accidentally reopen them.
REVOKE UPDATE ON api_tokens FROM app_user;
GRANT UPDATE (revoked_at, revoked_reason) ON api_tokens TO app_user;

-- M1/S-c: brand-new functions from here through the matching REVOKE
-- below need platform_ops to hold CREATE on schema public at the moment
-- each ALTER FUNCTION ... OWNER TO runs -- not guaranteed on an
-- already-migrated database. Bracket copied verbatim from
-- 0616_api_tokens.sql.
GRANT CREATE ON SCHEMA public TO platform_ops;

-- S4/M2: revoked_at is set-once, and revoked_reason is frozen alongside
-- it. A trigger (not a CHECK -- Postgres CHECK constraints cannot
-- reference OLD) rejects any UPDATE that would, once revoked_at is
-- non-null: clear it back to NULL (un-revoke), change it to a DIFFERENT
-- non-null value (backdating/forward-dating the revocation), or change
-- revoked_reason at all. Belt and suspenders alongside the column-scoped
-- grant above, since the grant alone would still let app_user set
-- revoked_at/revoked_reason to any value on an unrevoked OR
-- already-revoked row (the grant doesn't know the row's prior value).
-- Also rejects revoked_reason being set while revoked_at is NULL, so a
-- reason can never exist without an accompanying revocation -- the first
-- revocation itself still works because it sets both columns in the
-- SAME UPDATE, so NEW.revoked_at is non-null by the time this check runs.
CREATE FUNCTION forbid_api_token_unrevoke() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
      RAISE EXCEPTION 'api_tokens.revoked_at is set-once and cannot be cleared or changed'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason THEN
      RAISE EXCEPTION 'api_tokens.revoked_reason is frozen once revoked_at is set'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.revoked_at IS NULL AND NEW.revoked_reason IS NOT NULL THEN
    RAISE EXCEPTION 'api_tokens.revoked_reason cannot be set without revoked_at'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
ALTER FUNCTION forbid_api_token_unrevoke() OWNER TO platform_ops;

CREATE TRIGGER trg_forbid_api_token_unrevoke
  BEFORE UPDATE ON api_tokens
  FOR EACH ROW
  EXECUTE FUNCTION forbid_api_token_unrevoke();

-- S3/M3: verify app.token_id (the ACTOR) against a real row of the
-- calling account, created by the verified live member, before trusting
-- it as the actor. A malformed app.token_id (not a uuid) now raises
-- rather than being concatenated into the actor string as free text.
-- Separately, when the payload names a token_id (the OBJECT the audit
-- row describes -- both real call sites, packages/core/src/tokens/
-- service.ts's insertApiToken and auditRevocations, put one there), that
-- id is verified to resolve to an api_tokens row of the SAME account, so
-- a tenant-A actor cannot write an audit row that names a tenant-B token
-- as the thing acted on.
CREATE OR REPLACE FUNCTION audit_write_api_tokens(p_action text, p_payload jsonb DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct      uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  tok       text := NULLIF(current_setting('app.token_id', true), '');
  tok_id    uuid;
  payload_token_id uuid;
  usr       uuid := current_member_user_id();
  who       text;
  ts        timestamptz := clock_timestamp();
  stamped   jsonb := p_payload;
  new_id    uuid;
BEGIN
  IF acct IS NULL THEN
    RAISE EXCEPTION 'audit_write_api_tokens: no app.account_id set'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'audit_write_api_tokens: account % is closed', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF tok IS NOT NULL THEN
    BEGIN
      tok_id := tok::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'audit_write_api_tokens: app.token_id is not a valid uuid'
        USING ERRCODE = 'insufficient_privilege';
    END;
    IF NOT EXISTS (
      SELECT 1 FROM api_tokens t
      WHERE t.id = tok_id AND t.account_id = acct AND t.created_by = usr
    ) THEN
      RAISE EXCEPTION 'audit_write_api_tokens: app.token_id does not resolve to a token of account % created by the live caller', acct
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    who := 'token:' || tok_id::text;
  ELSIF usr IS NOT NULL THEN
    who := 'session:' || usr::text;
  ELSE
    RAISE EXCEPTION 'audit_write_api_tokens: caller is neither a verified member nor a resolved token of account %', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_action IS NULL OR NOT (p_action = ANY (ARRAY[
    'api_token.created',
    'api_token.revoked'
  ])) THEN
    RAISE EXCEPTION 'audit_write_api_tokens: action % is not on the allowlist', p_action
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write_api_tokens: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND (
    pg_column_compression(p_payload) IS NOT NULL OR pg_column_size(p_payload) > 65536
  ) THEN
    RAISE EXCEPTION 'audit_write_api_tokens: payload exceeds 65536 bytes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND p_payload ? 'token_id' THEN
    BEGIN
      payload_token_id := (p_payload->>'token_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'audit_write_api_tokens: payload.token_id is not a valid uuid'
        USING ERRCODE = 'insufficient_privilege';
    END;
    IF NOT EXISTS (
      SELECT 1 FROM api_tokens t WHERE t.id = payload_token_id AND t.account_id = acct
    ) THEN
      RAISE EXCEPTION 'audit_write_api_tokens: payload.token_id does not name a token of account %', acct
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF stamped ? 'actor' THEN
    stamped := stamped || jsonb_build_object('actor', to_jsonb(who));
  END IF;
  IF stamped ? 'account_id' THEN
    stamped := stamped || jsonb_build_object('account_id', to_jsonb(acct::text));
  END IF;
  IF stamped ? 'created_at' THEN
    stamped := stamped || jsonb_build_object('created_at', to_jsonb(ts));
  END IF;

  INSERT INTO audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, who, p_action, stamped, ts)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;
REVOKE ALL ON FUNCTION audit_write_api_tokens(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write_api_tokens(text, jsonb) TO app_user;

-- S7/M4: scope the throttled touch to the exact token the caller proved
-- it holds, by re-keying on the token hash instead of trusting a second,
-- caller-supplied identifier (the account id). The 0616 1-arg uuid
-- overload is dropped, not left callable alongside the new one.
DROP FUNCTION touch_api_token_last_used(uuid);

CREATE FUNCTION touch_api_token_last_used(p_token_hash text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE api_tokens
  SET last_used_at = now()
  WHERE token_hash = p_token_hash
    AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds');
$$;
REVOKE ALL ON FUNCTION touch_api_token_last_used(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION touch_api_token_last_used(text) TO app_user;
ALTER FUNCTION touch_api_token_last_used(text) OWNER TO platform_ops;

-- Close the new-function window opened above.
REVOKE CREATE ON SCHEMA public FROM platform_ops;

-- Close the window opened at the top of the file, matching 0612's own
-- downgrade shape.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
