-- D#31 API-4b: what 0627_webhooks.sql's own header reserved for this task
-- without altering that file -- "later task adds its own migration
-- instead of editing an already-merged one" (the API-3d/API-3e/API-3f
-- precedent on 0616_api_tokens.sql).
--
-- Numbered 0628: main is at 0627 (0627_webhooks.sql, API-4a) with no other
-- open PR claiming 0628 at the time this was written. Re-checked against
-- origin/main and every open PR's migrations immediately before this PR
-- was pushed.
--
-- Three additions, all owned by API-4b:
--   1. Secret-rotation overlap columns on webhook_endpoints (criterion 3:
--      "after rotate-secret, the header carries two v1, signatures for
--      24h, then only the new one").
--   2. audit_write_webhook_endpoints(action, payload): the sibling of
--      audit_write_api_tokens (0616) for webhook-endpoint lifecycle
--      events, called from packages/api/src/routes/webhook-endpoints.ts.
--      audit-log-guard.test.ts forbids a raw `audit_log` reference under
--      packages/*/src/**, so every app_user-side audit write for this
--      resource goes through this function instead.
--   3. redeliver_webhook_delivery(delivery_id): criterion "POST
--      .../deliveries/{delivery_id}/redeliver" resets one delivery back
--      to `pending` so the next sweep tick claims it. webhook_deliveries
--      is read-only from app_user's own grant (0627's own comment: "every
--      write ... is a platform_ops/sweep concern") -- this is the one
--      SECURITY DEFINER seam that lets an owner/admin's redeliver request
--      cross that boundary, scoped to their own account only.

ALTER TABLE webhook_endpoints
  ADD COLUMN previous_secret_ciphertext bytea,
  ADD COLUMN previous_secret_nonce      bytea,
  ADD COLUMN previous_secret_wrapped_dek bytea,
  ADD COLUMN previous_secret_kek_version integer,
  -- NULL means "no rotation overlap in effect". Set by rotate-secret to
  -- now() + 24h; sign.ts/dispatcher.ts stop including the previous
  -- secret's signature once this has passed (criterion 3).
  ADD COLUMN previous_secret_expires_at timestamptz;

-- D#81 Neon-shape: `ALTER FUNCTION ... OWNER TO platform_ops` (both
-- functions below) requires platform_ops to itself hold CREATE on the
-- schema the function lives in -- Postgres refuses to hand ownership to
-- a role that couldn't have created the object itself, and the
-- Neon-shaped migration role (fx_migrator) is never a superuser, so this
-- isn't optional here the way it would be under a superuser connection.
-- 0616_api_tokens.sql and 0606/0008/0005/0622/0621/0200/0624 all bracket
-- their own OWNER-transferring functions the same way: grant right
-- before, revoke right after -- platform_ops must not retain CREATE on
-- public once this migration finishes (test-neon-shape.sh's own
-- end-state check asserts exactly that).
GRANT CREATE ON SCHEMA public TO platform_ops;

-- ---------------------------------------------------------------------
-- audit_write_webhook_endpoints: a sibling of audit_write_api_tokens
-- (0616_api_tokens.sql), not a call to it -- same reasoning as that
-- file's own header (audit_write() itself requires 'active' via H05's
-- reserve-path semantics; webhook-endpoint management has no such
-- requirement of its own, but IS always session-only in v1 (C1's route
-- table), so this never needs the token:<id> branch api_tokens' sibling
-- has -- included anyway, at zero cost, so a future token-mutation path
-- never needs a second copy of this function).
CREATE FUNCTION audit_write_webhook_endpoints(p_action text, p_payload jsonb DEFAULT NULL)
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
    RAISE EXCEPTION 'audit_write_webhook_endpoints: no app.account_id set'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'audit_write_webhook_endpoints: account % is closed', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF tok IS NOT NULL THEN
    who := 'token:' || tok;
  ELSIF usr IS NOT NULL THEN
    who := 'session:' || usr::text;
  ELSE
    RAISE EXCEPTION 'audit_write_webhook_endpoints: caller is neither a verified member nor a resolved token of account %', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_action IS NULL OR NOT (p_action = ANY (ARRAY[
    'webhook_endpoint.created',
    'webhook_endpoint.updated',
    'webhook_endpoint.deleted',
    'webhook_endpoint.secret_rotated',
    'webhook_endpoint.test_sent',
    'webhook_delivery.redelivered'
  ])) THEN
    RAISE EXCEPTION 'audit_write_webhook_endpoints: action % is not on the allowlist', p_action
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write_webhook_endpoints: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Same 64 KiB / no-TOASTed-argument floor as audit_write (D#97).
  IF p_payload IS NOT NULL AND (
    pg_column_compression(p_payload) IS NOT NULL OR pg_column_size(p_payload) > 65536
  ) THEN
    RAISE EXCEPTION 'audit_write_webhook_endpoints: payload exceeds 65536 bytes'
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
REVOKE ALL ON FUNCTION audit_write_webhook_endpoints(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write_webhook_endpoints(text, jsonb) TO app_user;
ALTER FUNCTION audit_write_webhook_endpoints(text, jsonb) OWNER TO platform_ops;

-- ---------------------------------------------------------------------
-- redeliver_webhook_delivery: resets one delivery of the CALLER's own
-- account back to 'pending' with next_attempt_at = now(), so the next
-- sweep tick (within a minute -- the same "within one sweep" latency
-- criterion 11 already accepts for markBroken) claims and resends it.
-- Requires the caller to be a verified owner/admin member of the
-- delivery's own account -- returns false (never raises) for "not found",
-- "wrong account" or "insufficient role" alike, so the route maps every
-- one of those to the same 404 (CWE-639: no account-existence oracle).
CREATE FUNCTION redeliver_webhook_delivery(p_delivery_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct     uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  role     text := current_member_role();
  endpoint uuid;
  rows_hit integer;
BEGIN
  IF acct IS NULL OR role IS NULL OR role NOT IN ('owner', 'admin') THEN
    RETURN false;
  END IF;
  IF NOT account_is_active(acct) THEN
    RETURN false;
  END IF;

  UPDATE webhook_deliveries
     SET status = 'pending',
         next_attempt_at = clock_timestamp(),
         claimed_at = NULL,
         dead_at = NULL
   WHERE id = p_delivery_id
     AND account_id = acct
   RETURNING endpoint_id INTO endpoint;
  GET DIAGNOSTICS rows_hit = ROW_COUNT;

  IF rows_hit = 0 THEN
    RETURN false;
  END IF;

  PERFORM audit_write_webhook_endpoints(
    'webhook_delivery.redelivered',
    jsonb_build_object('delivery_id', p_delivery_id, 'endpoint_id', endpoint)
  );

  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION redeliver_webhook_delivery(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redeliver_webhook_delivery(uuid) TO app_user;
ALTER FUNCTION redeliver_webhook_delivery(uuid) OWNER TO platform_ops;

-- Matches this file's own opening GRANT: platform_ops's CREATE on public
-- was only ever needed for the two ALTER ... OWNER TO statements above.
REVOKE CREATE ON SCHEMA public FROM platform_ops;
