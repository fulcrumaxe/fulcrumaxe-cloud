-- D#845 MC-5: the address a provisioning token is bound to. A token that belongs to a rented server's row (managed_servers.provisioning_token_id, 1035) may be
-- redeemed only from that server's IPv4. The register route has the secret's SHA-256 and the account (runner_provisioning_token_account, 0786) but app_user cannot
-- read the hash column, so it cannot find the row itself; this one read-only definer answers the question and nothing else.
--
--   runner_provisioning_token_bound_ip(p_token_sha256)  returns (bound, ip). bound is false for a token no server row holds (a person's own token: no binding).
--                                                       bound is true with ip = the row's public_ipv4 as text, or NULL while the provider has not reported one (the
--                                                       route then refuses: an address that is not known yet matches nobody). Only the caller's own account (app.account_id).
--
-- A server row's token must have the shape MC-5 mints: a life of exactly 1800 s and no repositories (S-2). The database checks it here too, not only the code that mints
-- it: a row that holds a token of any other life or with repositories gets ip NULL, so the route refuses it whatever address it comes from.
-- One server row per token: the unique index below. With two rows naming a token the address compared would depend on row order.
--
-- It writes nothing and returns neither the hash nor any other column. The definer role gets SELECT on three columns of managed_servers, for the caller's account only.
-- Numbered 1050: re-check against main right before merging and renumber to stay above its highest.

CREATE UNIQUE INDEX managed_servers_one_per_token ON managed_servers (provisioning_token_id);

GRANT SELECT (account_id, provisioning_token_id, public_ipv4) ON managed_servers TO runner_provisioning_definer;
CREATE POLICY runner_provisioning_definer_select ON managed_servers FOR SELECT TO runner_provisioning_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'runner_provisioning_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_provisioning_definer; cannot ALTER FUNCTION ... OWNER TO runner_provisioning_definer';
    END IF;
    GRANT runner_provisioning_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_provisioning_definer;

CREATE FUNCTION runner_provisioning_token_bound_ip(p_token_sha256 text)
RETURNS TABLE (bound boolean, ip text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_provisioning_token_bound_ip: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'runner_provisioning_token_bound_ip: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT true,
           CASE WHEN t.expires_at - t.created_at = interval '1800 seconds' AND cardinality(t.allowed_repo_ids) = 0 THEN host(s.public_ipv4) END
      FROM public.runner_provisioning_tokens t
      JOIN public.managed_servers s ON s.provisioning_token_id = t.id AND s.account_id = t.account_id
     WHERE t.token_sha256 = p_token_sha256 AND t.account_id = acct;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION runner_provisioning_token_bound_ip(text) FROM PUBLIC;
ALTER FUNCTION runner_provisioning_token_bound_ip(text) OWNER TO runner_provisioning_definer;
GRANT EXECUTE ON FUNCTION runner_provisioning_token_bound_ip(text) TO app_user;
REVOKE CREATE ON SCHEMA public FROM runner_provisioning_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_provisioning_definer FROM CURRENT_USER;
  END IF;
END
$$;
