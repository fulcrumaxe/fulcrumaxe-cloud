-- D#31 API-3b: API tokens and the token principal.
--
-- Numbered 0616 per the Team Lead's brief: 0614 reserved for D#2 H13c,
-- 0615 claimed by the in-flight D#71 DS-1 (PR #148). Re-checked against
-- origin/main and every open PR's migrations before this PR was opened
-- (D#94 R1) -- 0616 was free.
--
-- Rate limits and criterion 5's creator-demotion/removal cascade are
-- follow-up PRs, split out to keep this one under the 2,000-line policy
-- -- flagged in the PR body. The rate-limit table is not created here.
--
-- Three SECURITY DEFINER functions (same shape as has_open_invitation /
-- account_is_active / audit_write, 0001/0008/0011/0612):
--   resolve_api_token(hash)        pre-tenant-context lookup by hash;
--                                   also resolves the creator's LIVE role
--                                   and excludes a closed account.
--   touch_api_token_last_used(id)  criterion 10's throttled write.
--   audit_write_api_tokens(...)    token lifecycle audit rows. NOT
--                                   audit_write(): that stamps a bare
--                                   member id, never `token:<id>`/
--                                   `session:<id>` (criterion 10).

CREATE TABLE api_tokens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Plain FK (users is global, not tenant-scoped -- same as account_members.user_id).
  created_by     uuid NOT NULL REFERENCES users (id),
  token_hash     text NOT NULL,
  -- display_hint (criterion 2): fxat_... + last 4 chars, computed once
  -- at mint time -- the plaintext is never available again.
  display_hint   text NOT NULL,
  -- Mintable scopes: read, runs:cancel, audit:read. text[] rather than
  -- a join table -- at most 3 legal values, at most 3 per token.
  scopes         text[] NOT NULL CHECK (
                   scopes <@ ARRAY['read', 'runs:cancel', 'audit:read']::text[]
                   AND cardinality(scopes) > 0
                 ),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  -- 'user_requested', and (a follow-up PR) 'creator_demoted' /
  -- 'creator_removed'. No CHECK on the vocabulary: diagnostic only.
  revoked_reason text,
  last_used_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token_hash)
);

CREATE INDEX idx_api_tokens_account_id ON api_tokens (account_id);
-- revoke-mine's own lookup ("every token created_by this user"), and the
-- future creator-cascade follow-up's.
CREATE INDEX idx_api_tokens_created_by ON api_tokens (account_id, created_by);

ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tokens FORCE ROW LEVEL SECURITY;

-- "owner/admin see every token and a member only their own" (Files
-- section): the standard tenant_isolation + account_is_active conjunct,
-- plus an EXISTS join on account_members for the caller's role (same
-- shape as member_visible on users, 0001_core.sql). Also admits a TOKEN
-- reading its own row (id = app.token_id) so DELETE's self-revoke
-- (criterion 9) has SELECT visibility for its UPDATE ... RETURNING.
CREATE POLICY tenant_isolation_select ON api_tokens
  FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (
      created_by = NULLIF(current_setting('app.user_id', true), '')::uuid
      OR id = NULLIF(current_setting('app.token_id', true), '')::uuid
      OR EXISTS (
        SELECT 1 FROM account_members m
        WHERE m.account_id = api_tokens.account_id
          AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
          AND m.role IN ('owner', 'admin')
      )
    )
  );

-- Minting: only for the caller's own tenant, attributed to themselves,
-- and only when app.user_id names a real member (D#2607's X-user-id
-- amendment: a policy must never trust app.user_id alone -- see
-- packages/db/test/partners-isolation.test.ts). Role/scope rules are
-- application-layer (packages/core/src/tokens/service.ts).
CREATE POLICY tenant_isolation_insert ON api_tokens
  FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = api_tokens.account_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

-- Revocation (session self-revoke, revoke-mine, a token revoking itself,
-- or an owner/admin revoking any token) plus the throttled last_used_at
-- touch. Same visibility shape as SELECT, restated because Postgres RLS
-- needs a separate policy per command.
CREATE POLICY tenant_isolation_update ON api_tokens
  FOR UPDATE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (
      created_by = NULLIF(current_setting('app.user_id', true), '')::uuid
      OR id = NULLIF(current_setting('app.token_id', true), '')::uuid
      OR EXISTS (
        SELECT 1 FROM account_members m
        WHERE m.account_id = api_tokens.account_id
          AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
          AND m.role IN ('owner', 'admin')
      )
    )
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

CREATE POLICY platform_ops_full_access ON api_tokens TO platform_ops
  USING (true) WITH CHECK (true);

-- No DELETE grant to app_user: revocation is always a soft-delete (same
-- asymmetry 0609_revoked_sessions.sql documents).
GRANT SELECT, INSERT, UPDATE ON api_tokens TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_tokens TO platform_ops;

-- D#81/#92 per-file bracket (docs/ops/hosted-postgres.md, as 0606's
-- section 8/9 documents): the three `ALTER FUNCTION ... OWNER TO
-- platform_ops` below need platform_ops to hold CREATE on schema public
-- at that moment, not guaranteed on an already-migrated database.
-- Unconditional grant/revoke, bracketing all three -- these are brand
-- new functions, not the INHERIT bracket 0606/0612 use for CREATE OR
-- REPLACE on an existing platform_ops-owned function.
GRANT CREATE ON SCHEMA public TO platform_ops;

-- resolve_api_token(hash): pre-tenant-context lookup over the app_user
-- pool. Excludes a closed account's tokens -- identical to unknown/
-- expired/revoked, never a distinguishing signal. creator_role is NULL
-- when the creator is no longer a member at all.
CREATE FUNCTION resolve_api_token(p_hash text)
RETURNS TABLE (
  id           uuid,
  account_id   uuid,
  created_by   uuid,
  scopes       text[],
  expires_at   timestamptz,
  revoked_at   timestamptz,
  token_hash   text,
  creator_role text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.account_id, t.created_by, t.scopes, t.expires_at, t.revoked_at, t.token_hash,
         m.role AS creator_role
  FROM api_tokens t
  JOIN accounts a ON a.id = t.account_id AND a.deleted_at IS NULL
  LEFT JOIN account_members m ON m.account_id = t.account_id AND m.user_id = t.created_by
  WHERE t.token_hash = p_hash;
$$;
REVOKE ALL ON FUNCTION resolve_api_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_token(text) TO app_user;
ALTER FUNCTION resolve_api_token(text) OWNER TO platform_ops;

-- touch_api_token_last_used(id): criterion 10's throttle lives in the
-- WHERE clause -- a no-op update when the last touch was under 60s ago.
CREATE FUNCTION touch_api_token_last_used(p_token_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE api_tokens
  SET last_used_at = now()
  WHERE id = p_token_id
    AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds');
$$;
REVOKE ALL ON FUNCTION touch_api_token_last_used(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION touch_api_token_last_used(uuid) TO app_user;
ALTER FUNCTION touch_api_token_last_used(uuid) OWNER TO platform_ops;

-- audit_write_api_tokens(action, payload): a sibling of audit_write(),
-- not a call to it (see file header). Derives the actor from session
-- GUCs -- token:<id> when app.token_id is set, else session:<user id>
-- (criterion 10). Unlike audit_write, never requires 'active': a
-- paused account still revokes its own tokens (resolved disagreement 7).
CREATE FUNCTION audit_write_api_tokens(p_action text, p_payload jsonb DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct    uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  tok     text := NULLIF(current_setting('app.token_id', true), '');
  usr     uuid := current_member_user_id();
  who     text;
  ts      timestamptz := clock_timestamp();
  stamped jsonb := p_payload;
  new_id  uuid;
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
    who := 'token:' || tok;
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

  -- Same 64 KiB / no-TOASTed-argument floor as audit_write (D#97).
  IF p_payload IS NOT NULL AND (
    pg_column_compression(p_payload) IS NOT NULL OR pg_column_size(p_payload) > 65536
  ) THEN
    RAISE EXCEPTION 'audit_write_api_tokens: payload exceeds 65536 bytes'
      USING ERRCODE = 'invalid_parameter_value';
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
ALTER FUNCTION audit_write_api_tokens(text, jsonb) OWNER TO platform_ops;

-- Close the window opened above, right after the last OWNER TO statement.
REVOKE CREATE ON SCHEMA public FROM platform_ops;
