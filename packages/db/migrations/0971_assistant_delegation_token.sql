-- D#597 CC-4: the assistant's delegation token and the device link that hands it to a runner.
--
-- A delegation token is an ordinary api_tokens row with three more columns: `delegated`, the repo it is bound to and the client id
-- that asked for it. The CHECK fixes what such a row may be: only the scopes read and corrections:write, and at most one hour of
-- life (expires_at is measured from created_at). Existing rows are untouched (delegated = false, both columns NULL). Expiry,
-- revocation and "the creator is still a member" are the checks every token already has, so the token dies with its person.
--
-- resolve_api_token gains the three columns, which changes its return type: it is dropped and created again with the same owner and
-- grants. The device codes are in assistant_link_codes. The table has no app_user grant at all: the web tier reaches it only through
-- the four functions below, because the link is started and polled by a runner that has no credential yet. The code the runner
-- holds is stored as its SHA-256; the short code the person types is stored as shown.
--
-- Redeeming is one function holding the row's lock: it marks the code redeemed and inserts the token in the same statement run, so
-- two polls at once give one token and one `redeemed`.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

ALTER TABLE api_tokens
  ADD COLUMN delegated boolean NOT NULL DEFAULT false,
  ADD COLUMN repo_id   uuid REFERENCES repos (id) ON DELETE CASCADE,
  ADD COLUMN client_id text;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_delegation_shape CHECK (
  (NOT delegated AND repo_id IS NULL AND client_id IS NULL)
  OR (delegated AND repo_id IS NOT NULL AND client_id ~ '^[A-Za-z0-9._-]{1,48}$'
      AND scopes <@ ARRAY['read', 'corrections:write']::text[]
      AND expires_at <= created_at + interval '1 hour')
);
CREATE INDEX idx_api_tokens_repo_id ON api_tokens (repo_id) WHERE repo_id IS NOT NULL;

GRANT CREATE ON SCHEMA public TO platform_ops;

DROP FUNCTION resolve_api_token(text);
CREATE FUNCTION resolve_api_token(p_hash text)
RETURNS TABLE (
  id           uuid,
  account_id   uuid,
  created_by   uuid,
  scopes       text[],
  expires_at   timestamptz,
  revoked_at   timestamptz,
  token_hash   text,
  creator_role text,
  delegated    boolean,
  repo_id      uuid,
  client_id    text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.account_id, t.created_by, t.scopes, t.expires_at, t.revoked_at, t.token_hash,
         m.role AS creator_role, t.delegated, t.repo_id, t.client_id
  FROM api_tokens t
  JOIN accounts a ON a.id = t.account_id AND a.deleted_at IS NULL
  LEFT JOIN account_members m ON m.account_id = t.account_id AND m.user_id = t.created_by
  WHERE t.token_hash = p_hash;
$$;
REVOKE ALL ON FUNCTION resolve_api_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_token(text) TO app_user;
ALTER FUNCTION resolve_api_token(text) OWNER TO platform_ops;

CREATE TABLE assistant_link_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_hash  text NOT NULL UNIQUE CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  user_code    text NOT NULL UNIQUE CHECK (user_code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  client_id    text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9._-]{1,48}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  account_id   uuid REFERENCES accounts (id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users (id) ON DELETE CASCADE,
  repo_id      uuid REFERENCES repos (id) ON DELETE CASCADE,
  approved_at  timestamptz,
  redeemed_at  timestamptz,
  CHECK ((approved_at IS NULL) = (account_id IS NULL AND user_id IS NULL AND repo_id IS NULL)),
  CHECK (redeemed_at IS NULL OR approved_at IS NOT NULL)
);
ALTER TABLE assistant_link_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_link_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_ops_full_access ON assistant_link_codes TO platform_ops USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON assistant_link_codes TO platform_ops;

-- Start: a runner with no credential asks for a code. Rows past a day old are dropped here, so the table does not grow.
CREATE FUNCTION assistant_link_start(p_device_hash text, p_user_code text, p_client_id text)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_expires timestamptz;
BEGIN
  DELETE FROM public.assistant_link_codes WHERE expires_at < now() - interval '1 day';
  INSERT INTO public.assistant_link_codes (device_hash, user_code, client_id)
  VALUES (p_device_hash, p_user_code, p_client_id)
  RETURNING expires_at INTO v_expires;
  RETURN v_expires;
END;
$$;

-- Approve: the signed-in person (taken from app.account_id and app.user_id, never an argument) binds a live code to one of their
-- account's repos. NULL when the code is unknown, past its 10 minutes or already approved; otherwise the client id it was asked by.
CREATE FUNCTION assistant_link_approve(p_user_code text, p_repo_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct     uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr      uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_client text;
BEGIN
  IF acct IS NULL OR usr IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr)
     OR NOT EXISTS (SELECT 1 FROM public.repos r WHERE r.id = p_repo_id AND r.account_id = acct)
     OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'assistant_link_approve: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.assistant_link_codes
     SET account_id = acct, user_id = usr, repo_id = p_repo_id, approved_at = now()
   WHERE user_code = p_user_code AND approved_at IS NULL AND expires_at > now()
   RETURNING client_id INTO v_client;
  RETURN v_client;
END;
$$;

-- Redeem: the runner's poll. outcome is unknown, redeemed, expired, pending or issued; the token columns are set only on issued.
-- An approved code whose person has left, or whose account or repo is gone, reads as expired. The member row is locked FOR SHARE
-- so a removal in flight either finishes first (expired) or waits for this insert and then revokes the new token.
CREATE FUNCTION assistant_link_redeem(p_device_hash text, p_token_hash text, p_display_hint text)
RETURNS TABLE (outcome text, token_id uuid, token_account_id uuid, token_expires_at timestamptz, token_repo_id uuid, token_client_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c     public.assistant_link_codes;
  v_id  uuid;
  v_exp timestamptz := now() + interval '1 hour';
BEGIN
  SELECT * INTO c FROM public.assistant_link_codes WHERE device_hash = p_device_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unknown'::text, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  IF c.redeemed_at IS NOT NULL THEN
    RETURN QUERY SELECT 'redeemed'::text, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  IF c.expires_at <= now() OR (c.approved_at IS NOT NULL AND (
       NOT public.account_is_active(c.account_id)
       OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = c.account_id AND m.user_id = c.user_id FOR SHARE)
       OR NOT EXISTS (SELECT 1 FROM public.repos r WHERE r.id = c.repo_id AND r.account_id = c.account_id))) THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  IF c.approved_at IS NULL THEN
    RETURN QUERY SELECT 'pending'::text, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  UPDATE public.assistant_link_codes SET redeemed_at = now() WHERE id = c.id;
  INSERT INTO public.api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at, name, delegated, repo_id, client_id)
  VALUES (c.account_id, c.user_id, p_token_hash, p_display_hint, ARRAY['read', 'corrections:write'], v_exp,
          'assistant ' || c.client_id, true, c.repo_id, c.client_id)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (c.account_id, 'session:' || c.user_id::text, 'api_token.created', jsonb_build_object(
    'token_id', v_id, 'scopes', ARRAY['read', 'corrections:write'], 'expires_at', v_exp, 'delegated', true), clock_timestamp());
  RETURN QUERY SELECT 'issued'::text, v_id, c.account_id, v_exp, c.repo_id, c.client_id;
END;
$$;

REVOKE ALL ON FUNCTION assistant_link_start(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant_link_approve(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant_link_redeem(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant_link_start(text, text, text) TO app_user;
GRANT EXECUTE ON FUNCTION assistant_link_approve(text, uuid) TO app_user;
GRANT EXECUTE ON FUNCTION assistant_link_redeem(text, text, text) TO app_user;
ALTER FUNCTION assistant_link_start(text, text, text) OWNER TO platform_ops;
ALTER FUNCTION assistant_link_approve(text, uuid) OWNER TO platform_ops;
ALTER FUNCTION assistant_link_redeem(text, text, text) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
