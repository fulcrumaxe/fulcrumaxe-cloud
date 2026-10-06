-- D#6 R2b (required item 6 of the R2a review follow-ups, CWE-367): runner_register locks the minter's membership row.
--
-- 0712's runner_register checked "the code's minter is still an owner or admin" with a plain EXISTS. That read does not
-- block a demotion that is already under way, so this interleaving was possible:
--
--   register:  reads the minter as admin ................................................ (EXISTS passes)
--   demotion:  UPDATE account_members SET role = 'member'; its trigger revokes the minter's runners (none yet)
--   register:  INSERT INTO runners ...; COMMIT .......................... (a live runner whose registrant is a member)
--
-- Now the function takes `FOR SHARE` on the minter's account_members row. A demotion (an UPDATE of that row) must wait
-- for the registration to commit, and then its trigger revokes the runner this call just inserted. A demotion that got
-- there first holds the row until it commits, and the registration then reads the new role and refuses. Either order
-- ends with no live runner whose registrant has lost the role.
--
-- Lock order. Register already takes the account's advisory lock and the code row; the member lock comes last, and a
-- demotion takes the member row first and the runners' rows after. The two never wait on each other in a cycle: register
-- holds no runners row that the demotion trigger needs (the one it inserts is invisible to the trigger until commit).
--
-- The body is 0712's, verbatim apart from the lock; CREATE OR REPLACE keeps the owner and the grants.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION runner_register(p_code_sha256 text, p_public_key_jwk jsonb, p_isolation text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_jkt  text;
  v_code public.runner_registration_codes;
  v_plan text;
  v_id   uuid;
BEGIN
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'runner_register: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_code_sha256 IS NULL OR p_code_sha256 !~ '^[0-9a-f]{64}$'
     OR (p_isolation IS NOT NULL AND p_isolation NOT IN ('microvm', 'vm_container', 'container', 'host_sandbox')) THEN
    RAISE EXCEPTION 'runner_register: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_jkt := public.runner_key_thumbprint(p_public_key_jwk);

  -- One registration at a time per account, so the count below cannot be raced past the limit.
  PERFORM pg_advisory_xact_lock(hashtextextended('runner_register:' || acct::text, 0));

  -- The code must be this account's, unused and unexpired. Every way of failing gives the same answer, so a caller
  -- learns nothing about which check it was.
  SELECT * INTO v_code FROM public.runner_registration_codes c
   WHERE c.account_id = acct AND c.code_sha256 = p_code_sha256
   FOR UPDATE;
  IF NOT FOUND OR v_code.used_at IS NOT NULL OR v_code.expires_at <= now() THEN
    RAISE EXCEPTION 'runner_register: the code is not valid' USING ERRCODE = 'no_data_found';
  END IF;

  -- Its minter must still be an owner or admin, and stay one until this transaction ends: the row is locked FOR SHARE,
  -- so a demotion or removal waits for this registration and then revokes the runner it creates (see the header).
  PERFORM 1 FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = v_code.registered_by AND m.role IN ('owner', 'admin')
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_register: the code is not valid' USING ERRCODE = 'no_data_found';
  END IF;

  -- TEMPORARY SEAM (D#6 R2b criterion 12 and C9 section 3): the plan is compared as the string 'runner' and the
  -- limit is 2 active runners. R2b replaces this with the plan data (maxRunners). No plan value is written here.
  SELECT a.plan INTO v_plan FROM public.accounts a WHERE a.id = acct;
  IF v_plan = 'runner'
     AND (SELECT count(*) FROM public.runners r WHERE r.account_id = acct AND r.revoked_at IS NULL) >= 2 THEN
    RAISE EXCEPTION 'runner_register: runner limit reached' USING ERRCODE = 'configuration_limit_exceeded';
  END IF;

  UPDATE public.runner_registration_codes SET used_at = now() WHERE id = v_code.id;

  BEGIN
    INSERT INTO public.runners (account_id, registered_by, public_key_jwk, jkt, credential_mode, isolation, allowed_repo_ids)
    VALUES (acct, v_code.registered_by,
            jsonb_build_object('kty', 'OKP', 'crv', 'Ed25519', 'x', p_public_key_jwk ->> 'x'),
            v_jkt, v_code.credential_mode, p_isolation, v_code.allowed_repo_ids)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'runner_register: that key is already registered' USING ERRCODE = 'unique_violation';
  END;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, 'runner:' || v_id::text, 'runner.registered', jsonb_build_object(
    'runner_id', v_id, 'registered_by', v_code.registered_by, 'credential_mode', v_code.credential_mode,
    'isolation', p_isolation, 'jkt', v_jkt), clock_timestamp());
  RETURN v_id;
END;
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
