-- D#6 R5a-2c (corrections C27 section 3, C28 section 3): the enforced daily limit on what the gh-proxy streams to runners. 0765 counts full
-- clones (three a day). That count is a soft signal: a hostile client can fetch a full pack without sending a request that looks like a
-- clone. Bytes are what cost money, so the limit that is ENFORCED is bytes: per repository, per UTC day, on the response of every
-- git-upload-pack request, whatever the request claims to be.
--
-- runner_git_upload_pack_bytes holds one row per (repository, UTC day). runner_git_bytes_account(repo, bytes) is the only way to touch it:
--   bytes = 0   asks: has this repository already spent today's allowance? Nothing is written.
--   bytes > 0   adds bytes that were actually streamed to a runner (the proxy calls this at every 32 MiB checkpoint while a response
--               streams, and for the remainder when it ends, whether it finished or was cut off), then answers the same question.
-- The answer is true once the day's total is at or over the allowance. The proxy ends a response at the first checkpoint that answers
-- true and refuses the NEXT upload-pack request with 429, so the accepted overrun is the number of responses in flight at once times one
-- checkpoint (32 MiB); a response killed at the function's maximum duration loses at most the bytes since its last checkpoint. The allowance is the constant v_budget inside the function,
-- never an argument (0622's lesson: the caller must not choose a window or a limit). A TS constant is pinned to it by a test; changing the
-- figure is a one-line migration. 2 GiB per repository per UTC day is the default until the owner rules (C21's open runner-plan figures).
-- The same call deletes that repository's rows older than two days; deleting the repository cascades.
--
-- The function is owned by its own role, runner_git_bytes_definer: NOLOGIN, no members outside this file's bracket, a member of nothing,
-- column SELECT on repos (id, account_id) and SELECT/INSERT/UPDATE/DELETE on the new table only (the shape of 0765's runner_git_definer).
-- EXECUTE goes to run_binding_resolver only, so the proxy login gains it through its existing membership; with 0765's function that makes
-- exactly three functions. platform_ops gains nothing, and a platform_ops session is refused.
--
-- Numbered by the Team Lead (0766). It merges after 0765 (R5a-2a), in number order.
-- Refusals use fixed SQLSTATEs and messages, never an argument value: 42501 not permitted, 22023 invalid argument.

DO $$
DECLARE
  n text := 'runner_git_bytes_definer';
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

CREATE TABLE runner_git_upload_pack_bytes (
  account_id  uuid NOT NULL,
  repo_id     uuid NOT NULL,
  utc_day     date NOT NULL,
  bytes       bigint NOT NULL CHECK (bytes >= 0),
  PRIMARY KEY (repo_id, utc_day),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);
ALTER TABLE runner_git_upload_pack_bytes ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_git_upload_pack_bytes FORCE ROW LEVEL SECURITY;

GRANT SELECT (id, account_id) ON repos TO runner_git_bytes_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON runner_git_upload_pack_bytes TO runner_git_bytes_definer;
GRANT USAGE ON SCHEMA public TO runner_git_bytes_definer;

-- Row policies for this role only. The proxy sets no tenant context; what the function returns is one boolean, fixed by its text.
CREATE POLICY runner_git_bytes_definer_select ON repos FOR SELECT TO runner_git_bytes_definer USING (true);
CREATE POLICY runner_git_bytes_definer_select ON runner_git_upload_pack_bytes FOR SELECT TO runner_git_bytes_definer USING (true);
CREATE POLICY runner_git_bytes_definer_insert ON runner_git_upload_pack_bytes FOR INSERT TO runner_git_bytes_definer WITH CHECK (true);
CREATE POLICY runner_git_bytes_definer_update ON runner_git_upload_pack_bytes FOR UPDATE TO runner_git_bytes_definer USING (true) WITH CHECK (true);
CREATE POLICY runner_git_bytes_definer_delete ON runner_git_upload_pack_bytes FOR DELETE TO runner_git_bytes_definer USING (true);

CREATE FUNCTION runner_git_bytes_account(p_repo_id uuid, p_bytes bigint)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  -- 2 GiB of git-upload-pack response bytes per repository per UTC day. The owner's figure to set (C21); see the header.
  v_budget  CONSTANT bigint := 2147483648;
  v_day     date := (now() AT TIME ZONE 'UTC')::date;
  v_account uuid;
  v_total   bigint;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_git_bytes_account: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- At most 1 TiB per call: more than a response can be, and far from the bigint ceiling.
  IF p_repo_id IS NULL OR p_bytes IS NULL OR p_bytes < 0 OR p_bytes > 1099511627776 THEN
    RAISE EXCEPTION 'runner_git_bytes_account: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT r.account_id INTO v_account FROM public.repos r WHERE r.id = p_repo_id;
  -- A repository that does not exist has no allowance to spend: answered as spent, so the caller refuses.
  IF NOT FOUND THEN RETURN true; END IF;

  DELETE FROM public.runner_git_upload_pack_bytes b WHERE b.repo_id = p_repo_id AND b.utc_day < v_day - 2;
  IF p_bytes > 0 THEN
    INSERT INTO public.runner_git_upload_pack_bytes AS b (account_id, repo_id, utc_day, bytes)
    VALUES (v_account, p_repo_id, v_day, p_bytes)
    ON CONFLICT (repo_id, utc_day) DO UPDATE SET bytes = b.bytes + EXCLUDED.bytes
    RETURNING b.bytes INTO v_total;
  ELSE
    SELECT b.bytes INTO v_total FROM public.runner_git_upload_pack_bytes b WHERE b.repo_id = p_repo_id AND b.utc_day = v_day;
  END IF;
  RETURN coalesce(v_total, 0) >= v_budget;
END;
$$;

-- The migration role holds the new role (with ADMIN from creating it) only to hand the function over, and the role has CREATE on public
-- only for that transfer; both are reset at the end. platform_ops is not involved at all.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_git_bytes_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_git_bytes_definer; cannot ALTER FUNCTION ... OWNER TO runner_git_bytes_definer';
    END IF;
    GRANT runner_git_bytes_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_git_bytes_definer;

REVOKE ALL ON FUNCTION runner_git_bytes_account(uuid, bigint) FROM PUBLIC;
ALTER FUNCTION runner_git_bytes_account(uuid, bigint) OWNER TO runner_git_bytes_definer;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION runner_git_bytes_account(uuid, bigint) TO run_binding_resolver;

REVOKE CREATE ON SCHEMA public FROM runner_git_bytes_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_git_bytes_definer FROM CURRENT_USER;
  END IF;
END
$$;
