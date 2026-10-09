-- D#6 R2b-5a (correction C32 section 5): what a run on a person's own machine would have cost at API prices, kept apart from every money table.
--
-- A runner run is never billed per token (C12 A7 keeps agent_runs.usd NULL for it), so the Runs views showed an empty model-usage line. The
-- owner wants the figure shown anyway, as information: "what this would have cost on the API". It is NEVER spend. So it lives in a table of
-- its own, which no metering, billing, budget, cap or refusal query reads (every one of them reads ledger, spend_reservations or agent_runs.usd,
-- none of which this file touches). A new column on agent_runs or a new ledger source would have put it one careless SUM away from a bill.
--
-- 1. runner_run_usage, one row per runner run: the tokens the runner reported (input, output, cache read, cache write), the model the run
--    was dispatched on, the credential mode of the runner at the time (subscription or api_key, read from the runner's own registration at
--    ingest and stamped once: the bill those tokens fell on is the one at run time), and api_equivalent_usd with the version of the price
--    table that produced it. api_equivalent_usd is NULL for a model with no price row. Row security is tenant-scoped like run_events
--    (app_user reads its own account's rows and can write nothing); the only writer is the pair of definers below.
--    The row goes with its run (ON DELETE CASCADE), so removing a run removes its usage in the same transaction.
--
-- 2. runner_usage_add(account, run, runner, input, output, cache_read, cache_write) adds token counts to the run's row (creating it on the
--    first call) and answers the totals and the model. It trusts nothing it is passed: the account must be the session's tenant, and the
--    run must be a runner run of that account that belongs to that runner. The model and the credential mode are read here, never passed.
--
-- 3. runner_usage_price(account, run, usd, price_table_version) records the cloud's own recomputation of the figure. The caller computes it
--    with packages/spend from the totals the first function answered; nothing the runner sent as a dollar amount reaches either function.
--
-- Both functions are owned by a role of their own, runner_usage_definer (NOLOGIN, no members outside this file's bracket, a member of
-- nothing), with column grants only on what the bodies read and write and row policies for this role only. EXECUTE goes to agent_run_writer,
-- the login the worker's events ingest runs on. platform_ops gains nothing and a platform_ops session is refused.
--
-- Numbered by the Team Lead (0768). It merges after 0767, in number order.
-- Refusals use fixed SQLSTATEs and messages, never an argument value: 42501 not permitted, 22023 invalid argument.

DO $$
DECLARE
  n text := 'runner_usage_definer';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role % still has a privileged attribute', n;
  END IF;
END
$$;

CREATE TABLE runner_run_usage (
  account_id          uuid NOT NULL,
  run_id              uuid NOT NULL,
  runner_id           uuid NOT NULL,
  credential_mode     text NOT NULL CHECK (credential_mode IN ('subscription', 'api_key')),
  model               text CHECK (model IS NULL OR length(model) BETWEEN 1 AND 128),
  input_tokens        bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens       bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens   bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens  bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  api_equivalent_usd  numeric(12, 4) CHECK (api_equivalent_usd IS NULL OR api_equivalent_usd >= 0),
  price_table_version text CHECK (price_table_version IS NULL OR length(price_table_version) BETWEEN 1 AND 64),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, run_id),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE,
  CHECK ((api_equivalent_usd IS NULL) = (price_table_version IS NULL))
);
CREATE INDEX runner_run_usage_period ON runner_run_usage (account_id, recorded_at);

ALTER TABLE runner_run_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_run_usage FORCE ROW LEVEL SECURITY;

-- Readers: the account's own members, through the API. They can write nothing.
GRANT SELECT ON runner_run_usage TO app_user;
CREATE POLICY tenant_isolation ON runner_run_usage FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

-- The definer role: what the two bodies read and write, column by column.
GRANT SELECT (id, account_id, runtime, runner_id, model) ON agent_runs TO runner_usage_definer;
GRANT SELECT (id, account_id, credential_mode) ON runners TO runner_usage_definer;
GRANT SELECT, INSERT, UPDATE ON runner_run_usage TO runner_usage_definer;
GRANT USAGE ON SCHEMA public TO runner_usage_definer;

CREATE POLICY runner_usage_definer_select ON agent_runs FOR SELECT TO runner_usage_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_usage_definer_select ON runners FOR SELECT TO runner_usage_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_usage_definer_select ON runner_run_usage FOR SELECT TO runner_usage_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_usage_definer_insert ON runner_run_usage FOR INSERT TO runner_usage_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_usage_definer_update ON runner_run_usage FOR UPDATE TO runner_usage_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

CREATE FUNCTION runner_usage_add(
  p_account uuid, p_run uuid, p_runner uuid,
  p_input bigint, p_output bigint, p_cache_read bigint, p_cache_write bigint
)
RETURNS TABLE (model text, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_model text;
  v_mode  text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_usage_add: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Each count is at most 1e12 (a run does not reach a thousandth of that), so a sum cannot overflow a bigint in any realistic life of a run.
  IF p_account IS NULL OR p_run IS NULL OR p_runner IS NULL
     OR p_input IS NULL OR p_output IS NULL OR p_cache_read IS NULL OR p_cache_write IS NULL
     OR p_input < 0 OR p_output < 0 OR p_cache_read < 0 OR p_cache_write < 0
     OR p_input > 1000000000000 OR p_output > 1000000000000 OR p_cache_read > 1000000000000 OR p_cache_write > 1000000000000 THEN
    RAISE EXCEPTION 'runner_usage_add: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_account IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid THEN
    RAISE EXCEPTION 'runner_usage_add: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT r.model INTO v_model FROM public.agent_runs r
   WHERE r.id = p_run AND r.account_id = p_account AND r.runtime = 'runner' AND r.runner_id = p_runner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_usage_add: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT n.credential_mode INTO v_mode FROM public.runners n WHERE n.id = p_runner AND n.account_id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_usage_add: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  INSERT INTO public.runner_run_usage AS u (account_id, run_id, runner_id, credential_mode, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
  VALUES (p_account, p_run, p_runner, v_mode, v_model, p_input, p_output, p_cache_read, p_cache_write)
  ON CONFLICT (account_id, run_id) DO UPDATE
    SET input_tokens = u.input_tokens + EXCLUDED.input_tokens,
        output_tokens = u.output_tokens + EXCLUDED.output_tokens,
        cache_read_tokens = u.cache_read_tokens + EXCLUDED.cache_read_tokens,
        cache_write_tokens = u.cache_write_tokens + EXCLUDED.cache_write_tokens
  RETURNING u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens;
END;
$$;

CREATE FUNCTION runner_usage_price(p_account uuid, p_run uuid, p_usd numeric, p_version text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_usage_price: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account IS NULL OR p_run IS NULL OR p_usd IS NULL OR p_version IS NULL
     OR p_usd < 0 OR length(p_version) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'runner_usage_price: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_account IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid THEN
    RAISE EXCEPTION 'runner_usage_price: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A total at or past 1e8 dollars (also NaN and Infinity, which compare above every number) does not fit numeric(12, 4). A runner can reach it
  -- with a few maximum-size usage events, and raising here would roll the whole ingest batch back, run_ended included, on every retry. So the
  -- figure is left empty (the tokens stay) and the call succeeds.
  IF p_usd >= 100000000 THEN
    UPDATE public.runner_run_usage u SET api_equivalent_usd = NULL, price_table_version = NULL
     WHERE u.account_id = p_account AND u.run_id = p_run;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'runner_usage_price: not permitted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN;
  END IF;
  UPDATE public.runner_run_usage u SET api_equivalent_usd = p_usd, price_table_version = p_version
   WHERE u.account_id = p_account AND u.run_id = p_run;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_usage_price: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- The migration role holds the new role (with ADMIN from creating it) only to hand the functions over, and the role has CREATE on public
-- only for that transfer; both are reset at the end. platform_ops is not involved at all.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_usage_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_usage_definer; cannot ALTER FUNCTION ... OWNER TO runner_usage_definer';
    END IF;
    GRANT runner_usage_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_usage_definer;

REVOKE ALL ON FUNCTION runner_usage_add(uuid, uuid, uuid, bigint, bigint, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_usage_price(uuid, uuid, numeric, text) FROM PUBLIC;
ALTER FUNCTION runner_usage_add(uuid, uuid, uuid, bigint, bigint, bigint, bigint) OWNER TO runner_usage_definer;
ALTER FUNCTION runner_usage_price(uuid, uuid, numeric, text) OWNER TO runner_usage_definer;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION runner_usage_add(uuid, uuid, uuid, bigint, bigint, bigint, bigint) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION runner_usage_price(uuid, uuid, numeric, text) TO agent_run_writer;

REVOKE CREATE ON SCHEMA public FROM runner_usage_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_usage_definer FROM CURRENT_USER;
  END IF;
END
$$;
