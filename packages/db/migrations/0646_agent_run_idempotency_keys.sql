-- D#2 H14c-4 (correction C41 section 4): one idempotency key, one agent run.
--
-- The real PanelRunner must hand back the same run for the same key, and
-- must never start a second run for it, even when five callers race. That
-- is enforced here, in the database, not in process memory: this table's
-- primary key (account_id, idempotency_key) lets exactly one caller's
-- transaction commit a claim. The runner inserts the claim in the SAME
-- transaction that creates the agent_runs row (insertAgentRun in
-- packages/runner), so a claim can never exist without its run, and the
-- loser of a race rolls its run row back before any reservation or sandbox
-- exists.
--
-- Numbering: 0646. origin/main ended at 0645_role_settings_model_floor.sql
-- when this was renumbered from 0644.
--
-- Tenant binding. The key is scoped by account_id in the primary key, every
-- lookup names the account, and RLS pins rows to app.account_id. The run
-- reference is the composite FOREIGN KEY (account_id, run_id) REFERENCES
-- agent_runs (account_id, id), like every other table that points at
-- agent_runs, so a claim can only name a run of its own account. A plain
-- REFERENCES agent_runs (id) would not: Postgres checks foreign keys with
-- RLS off, so account A could claim account B's run.
--
-- The error codes do not say whether a run id exists in another tenant.
-- Every uniqueness rule here is per account ((account_id, idempotency_key)
-- and (account_id, run_id)), so a claim naming another tenant's run can
-- never collide with that tenant's claim (no 23505): it passes the unique
-- checks and reaches the foreign key, which looks up (its own account, that
-- run) and fails with 23503, the same code as for a run id that exists
-- nowhere. A single-column UNIQUE (run_id) would have answered 23505 for a
-- run that another tenant had already claimed.
--
-- request_hash fingerprints what the key names (role, work item, discussion,
-- round). A replay whose fingerprint differs is refused by the runner rather
-- than handed a run made for something else.
--
-- Who may write. app_user gets SELECT and INSERT only: a claim is immutable
-- and can only be removed by agent_run_release_idempotency_key below. The
-- release is a SECURITY DEFINER function executable only by agent_run_writer
-- (0642's role), following the same pattern as agent_run_create /
-- agent_run_set_status: owned by platform_ops, search_path pinned, EXECUTE
-- revoked from PUBLIC, tenant context checked. It deletes a claim ONLY when
-- the run is terminal AND never held status 'running' (no run.status_changed
-- event with to = 'running'), i.e. no sandbox was ever started for it. A run
-- that started and later failed, timed out or was cancelled keeps its key,
-- so a replay follows it instead of starting and paying for a second one.
-- That check lives here, in the database, not only in the runner.
--
-- platform_ops needs table privileges to run the function body. Both
-- policies below also require session_user to differ from platform_ops, so
-- a direct platform_ops login (the internet-facing handlers, see 0642)
-- sees and deletes nothing: only a session whose login is someone else, as
-- inside the definer for the runner's login, gets through. session_user
-- cannot be changed without superuser.

CREATE TABLE agent_run_idempotency_keys (
  account_id      uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  idempotency_key text        NOT NULL
    CONSTRAINT agent_run_idempotency_keys_key_check CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  run_id          uuid        NOT NULL,
  request_hash    text        NOT NULL
    CONSTRAINT agent_run_idempotency_keys_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, idempotency_key),
  UNIQUE (account_id, run_id),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE
);

ALTER TABLE agent_run_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_run_idempotency_keys TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

REVOKE ALL ON agent_run_idempotency_keys FROM app_user;
GRANT SELECT, INSERT ON agent_run_idempotency_keys TO app_user;

-- ---------------------------------------------------------------------
-- The release definer's owner (platform_ops): the narrowest privileges the
-- function body needs, and only for sessions that are not platform_ops
-- logins (see the header).
-- ---------------------------------------------------------------------
GRANT SELECT (account_id, idempotency_key, run_id) ON agent_run_idempotency_keys TO platform_ops;
GRANT DELETE ON agent_run_idempotency_keys TO platform_ops;
GRANT SELECT (account_id, run_id, kind, payload) ON run_events TO platform_ops;

CREATE POLICY platform_ops_claim_release ON agent_run_idempotency_keys
  FOR ALL TO platform_ops
  USING (
    session_user <> 'platform_ops'
    AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  );
CREATE POLICY platform_ops_claim_release_probe ON run_events
  FOR SELECT TO platform_ops
  USING (
    session_user <> 'platform_ops'
    AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  );

-- Releases the claim on (p_account_id, p_key) and returns true, or returns
-- false and changes nothing: no such claim, the run is not terminal, the
-- run succeeded, or the run ever held status 'running'.
CREATE FUNCTION agent_run_release_idempotency_key(p_account_id uuid, p_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_account_id IS NULL
     OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'agent_run_release_idempotency_key: account % is not the caller''s tenant context', p_account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM public.agent_run_idempotency_keys k
   WHERE k.account_id = p_account_id
     AND k.idempotency_key = p_key
     AND EXISTS (
       SELECT 1 FROM public.agent_runs r
        WHERE r.account_id = k.account_id AND r.id = k.run_id
          AND r.status IN ('refused_spend', 'failed', 'timed_out', 'cancelled')
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.run_events e
        WHERE e.account_id = k.account_id AND e.run_id = k.run_id
          AND e.kind = 'run.status_changed'
          AND e.payload ->> 'to' = 'running'
     );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION agent_run_release_idempotency_key(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_run_release_idempotency_key(uuid, text) TO agent_run_writer;

-- Ownership: platform_ops (test-neon-shape criterion 8). CREATE on schema
-- public is needed at the instant of the ALTER ... OWNER TO for a non-
-- superuser migration role, and closed again immediately (same bracket as
-- 0642).
GRANT CREATE ON SCHEMA public TO platform_ops;
ALTER FUNCTION agent_run_release_idempotency_key(uuid, text) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;
